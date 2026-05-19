// =====================================================================
// fiscalDraftJob.js — finalização automática de drafts NFe Nuvemshop
// =====================================================================
// Pega FiscalDocument em status='draft' com docType='NFE' criadas há mais
// de N minutos e tenta finalizá-las chamando emitNFe55 direto. Roda em
// setInterval no boot do servidor.
//
// Idempotente: docs em 'processing' não são pegos (algum outro processo
// pode estar emitindo). Falhas marcam status='rejected' com rejectReason.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Carrega ESM lazy
let _sefazDirect = null;
async function getSefazDirect() {
  if (!_sefazDirect) _sefazDirect = await import('./fiscalSefazDirect.mjs');
  return _sefazDirect;
}

// PFX path por CNPJ (mesma convenção da rota fiscal)
function pfxPathFor(cnpj) {
  if (cnpj === '44052617000126') return 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
  return process.env['PFX_PATH_' + cnpj] || null;
}
function pfxSenhaFor(cnpj) {
  if (cnpj === '44052617000126') return '123456';
  return process.env['PFX_SENHA_' + cnpj] || null;
}

const MIN_AGE_MINUTES = 60;       // só finaliza drafts com >1h (dá tempo de operador revisar manual)
const MAX_PER_RUN = 10;            // limite por execução pra não sobrecarregar
const INTERVAL_MS = 30 * 60 * 1000; // 30 min

let _running = false;

async function processFiscalDrafts() {
  if (_running) {
    console.log('[fiscalDraftJob] já em execução — skip');
    return;
  }
  _running = true;
  const startedAt = Date.now();
  let processed = 0, ok = 0, failed = 0;

  try {
    const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
    const drafts = await prisma.fiscalDocument.findMany({
      where: {
        status: 'draft',
        docType: 'NFE',
        createdAt: { lt: cutoff },
        recipientCnpjCpf: { not: null }, // só drafts com destinatário válido
      },
      include: {
        issuer: true,
        sale: { include: { items: { include: { product: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_PER_RUN,
    });

    if (!drafts.length) {
      console.log('[fiscalDraftJob] nenhuma draft elegível');
      return;
    }
    console.log('[fiscalDraftJob] processando', drafts.length, 'drafts NFe');

    for (const doc of drafts) {
      processed++;
      try {
        if (!doc.issuer?.active) {
          await prisma.fiscalDocument.update({
            where: { id: doc.id },
            data: { status: 'error', rejectReason: 'Issuer inativo' },
          });
          failed++; continue;
        }
        if (!doc.sale?.items?.length) {
          await prisma.fiscalDocument.update({
            where: { id: doc.id },
            data: { status: 'error', rejectReason: 'Sale sem items' },
          });
          failed++; continue;
        }

        const pfxPath = pfxPathFor(doc.issuer.cnpj);
        const pfxSenha = pfxSenhaFor(doc.issuer.cnpj);
        if (!pfxPath || !pfxSenha) {
          // Não marca error — talvez PFX será configurado depois
          console.log('[fiscalDraftJob] skip', doc.id, '— PFX não config pro CNPJ', doc.issuer.cnpj);
          continue;
        }

        const items = doc.sale.items.map((si) => ({
          sku: si.product?.sku || si.productId,
          name: si.product?.name || 'Produto',
          ncm: si.product?.ncm || '64041100',
          cfop: si.product?.cfop || null,
          unidade: si.product?.unidade || 'UN',
          qty: si.quantity,
          unitPrice: si.unitPrice,
          ean: si.product?.ean || null,
        }));

        const recipientPayload = doc.payload?.recipient || {};
        const addrSrc = recipientPayload.address || {};
        const customer = {
          cpfCnpj: doc.recipientCnpjCpf,
          name: doc.recipientName || recipientPayload.name,
          email: doc.recipientEmail || recipientPayload.email,
          addr: addrSrc.street ? {
            xLgr: addrSrc.street,
            nro: addrSrc.number || 'S/N',
            xCpl: addrSrc.complement,
            xBairro: addrSrc.neighborhood,
            xMun: addrSrc.city,
            UF: addrSrc.state,
            CEP: addrSrc.zip,
          } : null,
          indPres: 2,
        };

        const payment = {
          tPag: doc.paymentMethod || '99',
          valor: doc.totalValue,
          modFrete: 2,
          xPed: doc.payload?.orderNumber ? String(doc.payload.orderNumber) : null,
          nuvemshopOrderId: doc.payload?.orderId || null,
        };

        // Marca processing
        await prisma.fiscalDocument.update({
          where: { id: doc.id },
          data: { status: 'processing' },
        });

        const { emitNFe55 } = await getSefazDirect();
        const result = await emitNFe55({
          issuer: doc.issuer, pfxPath, pfxSenha, items, customer, payment,
          nNF: doc.number || doc.issuer.nfeNextNumber,
        });

        await prisma.fiscalDocument.update({
          where: { id: doc.id },
          data: {
            status: result.ok ? 'authorized' : 'rejected',
            accessKey: result.accessKey,
            protocol: result.protocol,
            rejectReason: result.ok ? null : (result.motivo || 'Erro desconhecido'),
            xmlContent: result.xmlSigned,
            response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000), source: 'fiscalDraftJob' },
          },
        });
        if (result.ok) {
          if ((doc.number || 0) === doc.issuer.nfeNextNumber) {
            await prisma.fiscalIssuer.update({
              where: { id: doc.issuer.id },
              data: { nfeNextNumber: doc.issuer.nfeNextNumber + 1 },
            });
          }
          ok++;
          console.log('[fiscalDraftJob] ✓', doc.id, '→', result.accessKey?.slice(-12));
        } else {
          failed++;
          console.log('[fiscalDraftJob] ✗', doc.id, result.motivo);
        }
      } catch (e) {
        failed++;
        console.error('[fiscalDraftJob] erro draft', doc.id, e.message);
        try {
          await prisma.fiscalDocument.update({
            where: { id: doc.id },
            data: { status: 'error', rejectReason: ('Erro job: ' + e.message).slice(0, 250) },
          });
        } catch {}
      }
    }
  } catch (err) {
    console.error('[fiscalDraftJob] erro geral:', err);
  } finally {
    _running = false;
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log('[fiscalDraftJob] terminou em', elapsed, 's —', processed, 'processadas |', ok, 'OK |', failed, 'falharam');
  }
}

let _interval = null;
function startFiscalDraftJob() {
  if (_interval) return;
  console.log('[fiscalDraftJob] agendado a cada', INTERVAL_MS / 60000, 'min (drafts >', MIN_AGE_MINUTES, 'min, max', MAX_PER_RUN, '/run)');
  // Primeira execução após 5 min do boot pra dar tempo do server estabilizar
  setTimeout(() => {
    processFiscalDrafts().catch(e => console.error('[fiscalDraftJob] first run:', e));
    _interval = setInterval(() => {
      processFiscalDrafts().catch(e => console.error('[fiscalDraftJob] interval:', e));
    }, INTERVAL_MS);
  }, 5 * 60 * 1000);
}

function stopFiscalDraftJob() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

module.exports = { startFiscalDraftJob, stopFiscalDraftJob, processFiscalDrafts };
