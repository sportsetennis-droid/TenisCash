// =====================================================================
// Routes: /api/admin/fiscal — Emissão de NFe / NFCe / CTe via Brasil NFe
// =====================================================================
// Endpoints administrativos pra emitir, consultar e cancelar documentos
// fiscais. Cada documento é vinculado a um FiscalIssuer (CNPJ emissor).
// =====================================================================

const express = require('express');
const path = require('node:path');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const fiscal = require('../services/fiscalApi');

const router = express.Router();
router.use(authMiddleware);

// Dynamic import do módulo ESM fiscalSefazDirect (Node permite via import())
let _sefazDirect = null;
async function getSefazDirect() {
  if (!_sefazDirect) _sefazDirect = await import('../services/fiscalSefazDirect.mjs');
  return _sefazDirect;
}

// PFX path por CNPJ (resolve a partir do disco do servidor)
function pfxPathFor(cnpj) {
  // Convenção: o admin coloca em /c/Chianca/NFe_Emissao001/Certificado2026.pfx
  // Em produção pode-se mapear pra storage seguro via env
  if (cnpj === '44052617000126') return 'C:\\Chianca\\NFe_Emissao001\\Certificado2026.pfx';
  return process.env['PFX_PATH_' + cnpj] || null;
}
function pfxSenhaFor(cnpj) {
  if (cnpj === '44052617000126') return '123456';
  return process.env['PFX_SENHA_' + cnpj] || null;
}

// ============================================================
// Emissão NFCe a partir de uma Sale finalizada (vendedor pode usar)
// ============================================================
router.post('/emit-nfce-from-sale', async (req, res) => {
  try {
    if (!['seller', 'admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const { saleId, paymentMethod, acquirerKey, cardBrand, cardAuthCode, tpIntegra } = req.body || {};
    if (!saleId) return res.status(400).json({ error: 'saleId obrigatório' });

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: { items: { include: { product: true } }, store: true },
    });
    if (!sale) return res.status(404).json({ error: 'Venda não encontrada' });

    // Resolve issuer pela loja (ou hardcode Meta Esportes por enquanto)
    // TODO: vincular Store → FiscalIssuer
    const issuer = await prisma.fiscalIssuer.findFirst({
      where: { active: true, cnpj: '44052617000126' }, // Meta Esportes default
    });
    if (!issuer) return res.status(400).json({ error: 'Sem emissor fiscal ativo' });

    const pfxPath = pfxPathFor(issuer.cnpj);
    const pfxSenha = pfxSenhaFor(issuer.cnpj);
    if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado pra esse CNPJ' });

    // Items
    const items = sale.items.map((si) => ({
      sku: si.product?.sku || si.productId,
      name: si.product?.name || 'Produto',
      ncm: si.product?.ncm || '64041100',
      cfop: si.product?.cfop || '5102',
      unidade: si.product?.unidade || 'UN',
      qty: si.quantity,
      unitPrice: si.unitPrice,
    }));

    // Pagamento
    const tPagMap = paymentMethod || '01';
    const payment = {
      tPag: tPagMap,
      valor: sale.totalAmount,
      acquirerKey,
      tBand: cardBrand,
      cAut: cardAuthCode,
      tpIntegra: tpIntegra || 2,
    };

    // Pre-cria doc em processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id,
        docType: 'NFCE',
        serie: issuer.nfceSerie || 1,
        number: issuer.nfceNextNumber,
        status: 'processing',
        totalValue: sale.totalAmount,
        saleId: sale.id,
        productIds: items.map(i => i.sku),
        emittedById: req.userId,
        paymentMethod: tPagMap,
        paymentBrand: cardBrand || null,
        paymentAcquirer: acquirerKey || null,
        paymentAuthCode: cardAuthCode || null,
        paymentTpIntegra: tpIntegra || null,
      },
    });

    // Emite
    const { emitNFCe } = await getSefazDirect();
    const result = await emitNFCe({
      issuer, pfxPath, pfxSenha, items, payment,
      nNF: issuer.nfceNextNumber,
    });

    // Atualiza doc + numeração
    const updated = await prisma.fiscalDocument.update({
      where: { id: doc.id },
      data: {
        status: result.ok ? 'authorized' : 'rejected',
        accessKey: result.accessKey,
        protocol: result.protocol,
        rejectReason: result.ok ? null : (result.motivo || 'Erro desconhecido'),
        xmlContent: result.xmlSigned,
        response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
      },
    });
    if (result.ok) {
      await prisma.fiscalIssuer.update({
        where: { id: issuer.id },
        data: { nfceNextNumber: issuer.nfceNextNumber + 1 },
      });
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : result.motivo,
      error: result.ok ? null : result.motivo,
    });
  } catch (err) {
    console.error('[fiscal/emit-nfce-from-sale]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DANFE PDF — gera localmente a partir do XML autorizado (acessível por seller)
// ============================================================
let _spedPdf = null;
async function getSpedPdf() {
  if (!_spedPdf) _spedPdf = await import('node-sped-pdf');
  return _spedPdf;
}

router.get('/documents/:id/danfe', async (req, res) => {
  try {
    if (!['seller', 'admin', 'superadmin'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    if (!doc.xmlContent) return res.status(400).json({ error: 'Documento sem XML armazenado' });
    if (doc.status !== 'authorized') return res.status(400).json({ error: 'Documento não autorizado (status: ' + doc.status + ')' });

    const { DANFCe, DANFe } = await getSpedPdf();
    const fn = doc.docType === 'NFCE' ? DANFCe : DANFe;
    const pdfBuffer = await fn({
      xml: doc.xmlContent,
      // logo: opcional — URL da logo Sports & Tennis se quiser
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="danfe-${doc.docType}-${doc.number}.pdf"`,
      'Cache-Control': 'private, max-age=300',
    });
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('[fiscal/danfe]', err);
    res.status(500).json({ error: err.message });
  }
});

// As rotas a seguir são admin-only
router.use(adminMiddleware);

// ============================================================
// CRUD de emissores (FiscalIssuer)
// ============================================================

router.get('/issuers', async (_req, res) => {
  try {
    const issuers = await prisma.fiscalIssuer.findMany({
      orderBy: { companyName: 'asc' },
      select: {
        id: true, cnpj: true, companyName: true, fantasyName: true, ie: true, im: true,
        environment: true, crt: true, active: true,
        nfeSerie: true, nfeNextNumber: true, nfceSerie: true, nfceNextNumber: true,
        // NÃO retorna apiToken/csc por segurança
      },
    });
    res.json({ issuers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/issuers', async (req, res) => {
  try {
    const b = req.body || {};
    const cnpj = String(b.cnpj || '').replace(/\D/g, '');
    if (!/^\d{14}$/.test(cnpj)) return res.status(400).json({ error: 'CNPJ inválido (14 dígitos)' });
    const issuer = await prisma.fiscalIssuer.create({
      data: {
        cnpj,
        companyName: String(b.companyName || '').trim(),
        fantasyName: b.fantasyName || null,
        ie: b.ie || null,
        im: b.im || null,
        street: b.street || null,
        number: b.number || null,
        complement: b.complement || null,
        neighborhood: b.neighborhood || null,
        cityCode: b.cityCode || null,
        city: b.city || null,
        state: b.state || null,
        zip: b.zip || null,
        phone: b.phone || null,
        apiToken: b.apiToken || null,
        environment: b.environment === 'production' ? 'production' : 'homologation',
        csc: b.csc || null,
        cscId: b.cscId || null,
        crt: parseInt(b.crt, 10) || 1,
      },
    });
    res.json({ issuer: { ...issuer, apiToken: undefined, csc: undefined } });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'CNPJ já cadastrado' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/issuers/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    ['companyName','fantasyName','ie','im','street','number','complement','neighborhood','cityCode','city','state','zip','phone','apiToken','csc','cscId','notes'].forEach(k => {
      if (b[k] !== undefined) data[k] = b[k] ? String(b[k]) : null;
    });
    if (b.environment) data.environment = b.environment === 'production' ? 'production' : 'homologation';
    if (b.crt !== undefined) data.crt = parseInt(b.crt, 10) || 1;
    if (b.active !== undefined) data.active = !!b.active;
    const issuer = await prisma.fiscalIssuer.update({ where: { id: req.params.id }, data });
    res.json({ issuer: { ...issuer, apiToken: undefined, csc: undefined } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Listagem de documentos emitidos
// ============================================================

router.get('/documents', async (req, res) => {
  try {
    const { issuerId, docType, status, search } = req.query;
    const where = {
      ...(issuerId ? { issuerId } : {}),
      ...(docType ? { docType } : {}),
      ...(status ? { status } : {}),
      ...(search ? {
        OR: [
          { accessKey: { contains: search } },
          { recipientName: { contains: search, mode: 'insensitive' } },
          { recipientCnpjCpf: { contains: search } },
        ],
      } : {}),
    };
    const docs = await prisma.fiscalDocument.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { issuer: { select: { companyName: true, cnpj: true } } },
    });
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/documents/:id', async (req, res) => {
  try {
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Emissão NFCe (venda presencial — loja física)
// ============================================================

router.post('/nfce', async (req, res) => {
  try {
    const { issuerId, saleId, items, customer, payment, total } = req.body || {};
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatório' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items obrigatório' });

    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor inválido ou inativo' });
    if (!issuer.apiToken) return res.status(400).json({ error: 'Emissor sem token Brasil NFe — configure primeiro' });

    // Resolve produtos pra fiscal items
    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const fiscalItems = items.map(i => {
      const p = byId[i.productId] || { name: i.name, sku: i.sku };
      return fiscal.buildItemFromProduct(p, i.qty, i.unitPrice, i);
    });

    const payload = fiscal.buildNFCePayload(
      issuer,
      { customerCpf: customer?.cpf, customerName: customer?.name, total },
      fiscalItems,
      payment || { method: '01', amount: total },
    );

    // Pré-cria documento em status processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId,
        docType: 'NFCE',
        serie: issuer.nfceSerie,
        number: issuer.nfceNextNumber,
        status: 'processing',
        recipientName: customer?.name || null,
        recipientCnpjCpf: customer?.cpf || null,
        totalValue: total,
        saleId: saleId || null,
        productIds: productIds,
        emittedById: req.userId,
        payload,
      },
    });

    // Chama Brasil NFe
    const resp = await fiscal.emitNFCe(issuer, payload);

    // Atualiza com resposta
    const updateData = { response: resp.data, status: resp.ok ? 'authorized' : 'rejected' };
    if (resp.ok && resp.data) {
      updateData.externalId = resp.data.id || resp.data.uuid || null;
      updateData.accessKey = resp.data.chave || resp.data.access_key || null;
      updateData.protocol = resp.data.protocolo || null;
      updateData.danfeUrl = resp.data.danfe_url || resp.data.pdf_url || null;
      updateData.xmlContent = resp.data.xml || null;
    } else {
      updateData.rejectReason = resp.data?.message || resp.data?.error || ('HTTP ' + resp.status);
    }
    const updated = await prisma.fiscalDocument.update({ where: { id: doc.id }, data: updateData });

    // Avança numeração se autorizou
    if (resp.ok) {
      await prisma.fiscalIssuer.update({
        where: { id: issuerId },
        data: { nfceNextNumber: issuer.nfceNextNumber + 1 },
      });
    }

    res.json({ document: updated, brasilNfeResponse: resp.data });
  } catch (err) {
    console.error('[fiscal/nfce]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Emissão NFe modelo 55 (online, B2B, transferência)
// ============================================================

router.post('/nfe', async (req, res) => {
  try {
    const { issuerId, saleId, items, recipient, total, natureza } = req.body || {};
    if (!issuerId) return res.status(400).json({ error: 'issuerId obrigatório' });
    if (!recipient || !(recipient.cnpj || recipient.cpf)) return res.status(400).json({ error: 'recipient.cnpj ou recipient.cpf obrigatório' });

    const issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor inválido ou inativo' });
    if (!issuer.apiToken) return res.status(400).json({ error: 'Emissor sem token Brasil NFe' });

    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const byId = Object.fromEntries(products.map(p => [p.id, p]));
    const fiscalItems = items.map(i => {
      const p = byId[i.productId] || { name: i.name, sku: i.sku };
      return fiscal.buildItemFromProduct(p, i.qty, i.unitPrice, i);
    });

    const payload = fiscal.buildNFePayload(issuer, { total, natureza }, fiscalItems, recipient);

    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId, docType: 'NFE',
        serie: issuer.nfeSerie, number: issuer.nfeNextNumber,
        status: 'processing',
        recipientName: recipient.name || null,
        recipientCnpjCpf: recipient.cnpj || recipient.cpf || null,
        recipientEmail: recipient.email || null,
        totalValue: total,
        saleId: saleId || null,
        productIds,
        emittedById: req.userId,
        payload,
      },
    });

    const resp = await fiscal.emitNFe(issuer, payload);
    const updateData = { response: resp.data, status: resp.ok ? 'authorized' : 'rejected' };
    if (resp.ok && resp.data) {
      updateData.externalId = resp.data.id || resp.data.uuid || null;
      updateData.accessKey = resp.data.chave || resp.data.access_key || null;
      updateData.protocol = resp.data.protocolo || null;
      updateData.danfeUrl = resp.data.danfe_url || resp.data.pdf_url || null;
      updateData.xmlContent = resp.data.xml || null;
    } else {
      updateData.rejectReason = resp.data?.message || resp.data?.error || ('HTTP ' + resp.status);
    }
    const updated = await prisma.fiscalDocument.update({ where: { id: doc.id }, data: updateData });

    if (resp.ok) {
      await prisma.fiscalIssuer.update({
        where: { id: issuerId },
        data: { nfeNextNumber: issuer.nfeNextNumber + 1 },
      });
    }

    res.json({ document: updated, brasilNfeResponse: resp.data });
  } catch (err) {
    console.error('[fiscal/nfe]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Cancelamento (até 24h após emissão)
// ============================================================

router.post('/documents/:id/cancel', async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason || reason.length < 15) return res.status(400).json({ error: 'Justificativa deve ter 15+ caracteres (regra SEFAZ)' });

    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.status !== 'authorized') return res.status(400).json({ error: 'Só documentos autorizados podem ser cancelados (status atual: ' + doc.status + ')' });

    let resp;
    if (doc.docType === 'NFCE') resp = await fiscal.cancelNFCe(doc.issuer, doc.externalId, reason);
    else if (doc.docType === 'NFE') resp = await fiscal.cancelNFe(doc.issuer, doc.externalId, reason);
    else if (doc.docType === 'CTE') resp = await fiscal.cancelCTe(doc.issuer, doc.externalId, reason);
    else return res.status(400).json({ error: 'Tipo não suporta cancelamento via essa rota' });

    if (resp.ok) {
      await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelProtocol: resp.data?.protocolo || null,
        },
      });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: resp.data?.message || 'Erro ao cancelar', detail: resp.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DANFE legado (Brasil NFe) — removido. A rota /documents/:id/danfe está
// disponível antes do adminMiddleware acima usando node-sped-pdf local.

module.exports = router;
