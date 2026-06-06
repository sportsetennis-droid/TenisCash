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
async function emitNfceFromSaleHandler(req, res) {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const { saleId, paymentMethod, cardBrand, cardAuthCode, tpIntegra } = req.body || {};
    let { acquirerKey } = req.body || {};
    if (!saleId) return res.status(400).json({ error: 'saleId obrigatório' });

    // Cartão (crédito 03 / débito 04): regras de conformidade SEFAZ-PB.
    const isCardPay = paymentMethod === '03' || paymentMethod === '04';
    if (isCardPay) {
      // EXIGE o código de autorização do comprovante — sem ele a NFCe sairia com
      // placeholder '000000'. Bloqueia aqui em vez de emitir nota inválida.
      if (!cardAuthCode || String(cardAuthCode).trim() === '' || String(cardAuthCode).trim() === '000000') {
        return res.status(400).json({ error: 'Cartão exige código de autorização do comprovante (digite o Auth/NSU do recibo da maquininha)' });
      }
      // DEFAULT da adquirente = PagBank/PagSeguro (pinpad físico das lojas).
      // Sem isso cai em CNPJ zerado no detPag. CNPJ PAGSEGURO 08561701000101.
      if (!acquirerKey) acquirerKey = 'PAGSEGURO';
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        items: { include: { product: true } },
      },
    });
    if (!sale) return res.status(404).json({ error: 'Venda não encontrada' });

    // IDEMPOTÊNCIA — uma venda = no MÁXIMO um cupom. (Bug de dupla emissão pego na LOJA03 2026-06-04:
    // a mesma venda gerou #100001 e #100002.) Se já há cupom autorizado, devolve ele (não re-emite);
    // se há um 'processing' recente, outra emissão está em andamento → recusa o segundo.
    const existingDoc = await prisma.fiscalDocument.findFirst({
      where: { saleId: sale.id, docType: 'NFCE', status: { in: ['authorized', 'processing'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (existingDoc) {
      if (existingDoc.status === 'authorized') {
        return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Venda já possui cupom autorizado #' + existingDoc.number });
      }
      const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
      if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta venda já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
      // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
    }

    // Sale tem so o escalar `storeId` (nao a relacao `store`) — busca a Store separada.
    const store = sale.storeId
      ? await prisma.store.findUnique({ where: { id: sale.storeId }, include: { fiscalIssuer: true } })
      : null;

    // Resolve issuer pela loja da venda (Store → FiscalIssuer vinculado)
    let issuer = store?.fiscalIssuer;
    if (!issuer) {
      // Fallback: Baratão (matriz Meta Esportes) caso loja sem issuer vinculado
      issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: '44052617000126' } });
    }
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Loja sem emissor fiscal vinculado' });
    if (!issuer.csc) return res.status(400).json({ error: 'Emissor ' + issuer.fantasyName + ' sem CSC cadastrado — gere no portal SEFAZ-PB primeiro' });

    // PFX só é necessário se a loja NÃO usa fiscal agent (agente tem PFX local)
    let pfxPath = null, pfxSenha = null;
    const willUseAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl;
    if (!willUseAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Items
    const items = sale.items.map((si) => ({
      sku: si.product?.sku || si.productId,
      name: si.product?.name || 'Produto',
      ncm: (si.product?.ncm && /^\d{8}$/.test(si.product.ncm)) ? si.product.ncm : '64041100',
      cfop: '5102', // NFC-e ao consumidor é venda interna — força 5102 (cadastro pode ter CFOP de compra/interestadual)
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

    // Número robusto: nunca abaixo do maior doc já gravado (blinda contra unique-constraint travado por fantasma)
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfceNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Pre-cria doc em processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id,
        docType: 'NFCE',
        serie: issuer.nfceSerie || 1,
        number: nNF,
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

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    let result;
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFCe(store, {
        issuer,
        items, payment,
        nNF,
      });
    } else {
      const { emitNFCe } = await getSefazDirect();
      result = await emitNFCe({
        issuer, pfxPath, pfxSenha, items, payment,
        nNF,
      });
    }

    // Sucesso: grava a nota e avanca a numeracao. Falha SEM chave (nunca chegou na SEFAZ):
    // apaga o doc pra LIBERAR o numero pro retry (nao acumula "fantasma" que trava o unique).
    let updated = doc;
    if (result.ok) {
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'authorized',
          accessKey: result.accessKey,
          protocol: result.protocol,
          xmlContent: result.xmlSigned,
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
      await prisma.fiscalIssuer.update({
        where: { id: issuer.id },
        data: { nfceNextNumber: nNF + 1 },
      });
    } else if (result.accessKey) {
      // Rejeitada PELA SEFAZ (tem chave) — mantem como rejected pra auditoria
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'rejected',
          accessKey: result.accessKey,
          rejectReason: result.motivo || 'Rejeitada',
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — apaga pra liberar o numero pro retry
      await prisma.fiscalDocument.delete({ where: { id: doc.id } }).catch(() => {});
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
}
router.post('/emit-nfce-from-sale', emitNfceFromSaleHandler);

// ============================================================
// Emissão NFe modelo 55 (B2C/B2B com destinatário) — payload livre.
// Útil pra ecommerce Nuvemshop, vendas a clubes/escolas, B2B.
// ============================================================
router.post('/emit-nfe55', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const b = req.body || {};
    const { issuerId, items, customer, payment, natOp, saleId, nuvemshopOrderId } = b;
    if (!items?.length) return res.status(400).json({ error: 'items obrigatório' });
    if (!customer?.cpfCnpj) return res.status(400).json({ error: 'customer.cpfCnpj obrigatório pra modelo 55' });
    if (!payment) return res.status(400).json({ error: 'payment obrigatório' });

    let issuer;
    if (issuerId) {
      issuer = await prisma.fiscalIssuer.findUnique({ where: { id: issuerId } });
    } else {
      // Default: Sports & Tennis ecommerce (filial 0004-79)
      issuer = await prisma.fiscalIssuer.findFirst({
        where: { cnpj: '44052617000479', active: true },
      });
    }
    if (!issuer || !issuer.active) return res.status(400).json({ error: 'Emissor não encontrado/inativo' });

    // Resolve a Store do issuer (Store → FiscalIssuer). Se a loja tem Fiscal Agent
    // habilitado, emite via agente (Tailscale + PFX local) — igual NFC-e. Senão,
    // mantém SEFAZ-direto com PFX em disco como fallback.
    const store = await prisma.store.findFirst({ where: { fiscalIssuerId: issuer.id } });
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;

    // IDEMPOTÊNCIA — mesma venda/pedido = no MÁXIMO uma NFe 55. Se já há doc NFE
    // autorizado pra esse saleId (ou mesmo nuvemshopOrderId), devolve ele e NÃO re-emite.
    const dedupeOr = [];
    if (saleId) dedupeOr.push({ saleId });
    if (nuvemshopOrderId) dedupeOr.push({ payload: { path: ['nuvemshopOrderId'], equals: String(nuvemshopOrderId) } });
    if (dedupeOr.length) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { docType: 'NFE', status: { in: ['authorized', 'processing'] }, OR: dedupeOr },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        if (existingDoc.status === 'authorized') {
          return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Pedido já possui NFe autorizada #' + existingDoc.number });
        }
        const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
        if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta NFe já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
        // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
      }
    }

    // PFX só é necessário se a loja NÃO usa fiscal agent (agente tem PFX local)
    let pfxPath = null, pfxSenha = null;
    if (!useAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Número robusto: nunca abaixo do maior doc já gravado (blinda contra unique-constraint travado por fantasma)
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfeNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Pre-cria doc em processing
    const doc = await prisma.fiscalDocument.create({
      data: {
        issuerId: issuer.id,
        docType: 'NFE',
        serie: issuer.nfeSerie || 1,
        number: nNF,
        status: 'processing',
        totalValue: items.reduce((acc, i) => acc + (Number(i.qty) || 1) * (Number(i.unitPrice) || 0), 0),
        saleId: saleId || null,
        productIds: items.map(i => i.sku || i.id),
        emittedById: req.userId,
        recipientName: customer.name || null,
        recipientCnpjCpf: String(customer.cpfCnpj).replace(/\D/g, ''),
        recipientEmail: customer.email || null,
        paymentMethod: payment.tPag || null,
        paymentBrand: payment.tBand || null,
        paymentAcquirer: payment.acquirerKey || null,
        paymentAuthCode: payment.cAut || null,
        paymentTpIntegra: payment.tpIntegra || null,
        payload: nuvemshopOrderId ? { nuvemshopOrderId: String(nuvemshopOrderId) } : null,
      },
    });

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    let result;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFe55(store, {
        issuer, items,
        payment: { ...payment, nuvemshopOrderId },
        customer, natOp,
        nNF,
      });
    } else {
      const { emitNFe55 } = await getSefazDirect();
      result = await emitNFe55({
        issuer, pfxPath, pfxSenha, items,
        payment: { ...payment, nuvemshopOrderId },
        customer, natOp,
        nNF,
      });
    }

    // Sucesso: grava a nota e avanca a numeracao. Falha SEM chave (nunca chegou na SEFAZ):
    // apaga o doc pra LIBERAR o numero pro retry (nao acumula "fantasma" que trava o unique).
    let updated = doc;
    if (result.ok) {
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'authorized',
          accessKey: result.accessKey,
          protocol: result.protocol,
          xmlContent: result.xmlSigned,
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
      await prisma.fiscalIssuer.update({
        where: { id: issuer.id },
        data: { nfeNextNumber: nNF + 1 },
      });
    } else if (result.accessKey) {
      // Rejeitada PELA SEFAZ (tem chave) — mantem como rejected pra auditoria
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'rejected',
          accessKey: result.accessKey,
          rejectReason: result.motivo || 'Rejeitada',
          response: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) },
        },
      });
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — apaga pra liberar o numero pro retry
      await prisma.fiscalDocument.delete({ where: { id: doc.id } }).catch(() => {});
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : (result.motivo || result.error),
      error: result.ok ? null : (result.motivo || result.error),
    });
  } catch (err) {
    console.error('[fiscal/emit-nfe55]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Finalizar NFe modelo 55 que foi pré-criada como draft (vinda de webhook
// Nuvemshop). Pega o draft, monta items do Sale, customer do payload e
// emite via emitNFe55. 1-click pra operadora.
// ============================================================
router.post('/finalize-nfe-draft/:id', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: {
        issuer: true,
        sale: { include: { items: { include: { product: true } } } },
      },
    });
    if (!doc) return res.status(404).json({ error: 'FiscalDocument não encontrado' });
    if (doc.docType !== 'NFE') return res.status(400).json({ error: 'Endpoint só pra NFe modelo 55 (draft.docType=NFE)' });
    if (doc.status !== 'draft') return res.status(400).json({ error: 'Documento não está em draft (atual: ' + doc.status + ')' });
    if (!doc.sale?.items?.length) return res.status(400).json({ error: 'Draft sem itens vinculados (sale.items vazia)' });

    const issuer = doc.issuer;
    if (!issuer.active) return res.status(400).json({ error: 'Emissor inativo' });

    // Resolve a Store do issuer → roteia via Fiscal Agent (PFX local da loja) quando
    // habilitado; senão SEFAZ-direto com PFX em disco (fallback intacto).
    const store = await prisma.store.findFirst({ where: { fiscalIssuerId: issuer.id } });
    const useAgent = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;

    // IDEMPOTÊNCIA — se já existe OUTRA NFE autorizada pra essa mesma venda/pedido,
    // não finaliza o draft de novo (devolve a existente). Exclui o próprio doc.
    const dedupeOr = [];
    if (doc.saleId) dedupeOr.push({ saleId: doc.saleId });
    const orderId = doc.payload?.orderId;
    if (orderId) dedupeOr.push({ payload: { path: ['orderId'], equals: orderId } });
    if (dedupeOr.length) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { id: { not: doc.id }, docType: 'NFE', status: 'authorized', OR: dedupeOr },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        return res.json({ ok: true, alreadyEmitted: true, documentId: existingDoc.id, number: existingDoc.number, accessKey: existingDoc.accessKey, status: '100', message: 'Pedido já possui NFe autorizada #' + existingDoc.number });
      }
    }

    let pfxPath = null, pfxSenha = null;
    if (!useAgent) {
      pfxPath = pfxPathFor(issuer.cnpj);
      pfxSenha = pfxSenhaFor(issuer.cnpj);
      if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado e Store sem Fiscal Agent — configure fiscalAgentUrl+Token na loja' });
    }

    // Items vindos da Sale
    const items = doc.sale.items.map((si) => ({
      sku: si.product?.sku || si.productId,
      name: si.product?.name || 'Produto',
      ncm: si.product?.ncm || '64041100',
      cfop: si.product?.cfop || null, // emitNFe55 escolhe 5102/6102 conforme UF
      unidade: si.product?.unidade || 'UN',
      qty: si.quantity,
      unitPrice: si.unitPrice,
      ean: si.product?.ean || null,
    }));

    // Customer reconstruído do payload do webhook
    const recipientPayload = doc.payload?.recipient || {};
    const addrSrc = recipientPayload.address || {};
    if (!doc.recipientCnpjCpf) {
      return res.status(400).json({ error: 'Draft sem CPF/CNPJ do destinatário — necessário pra NFe 55' });
    }
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
        cMun: addrSrc.cityCode, // emitNFe55 cai em 2507507 (JP) se vazio
      } : null,
      indPres: 2, // operação não-presencial pela internet
    };

    // Pagamento — Nuvemshop normalmente é cartão online; pega gateway pra tPag adequado
    const payment = {
      tPag: doc.paymentMethod || '99', // 99=outros se não souber
      valor: doc.totalValue,
      modFrete: 2, // por conta do destinatário (e-commerce)
      xPed: doc.payload?.orderNumber ? String(doc.payload.orderNumber) : null,
      nuvemshopOrderId: doc.payload?.orderId || null,
    };

    // Numeração robusta: recalcula no momento de emitir (não confia no doc.number congelado no webhook,
    // que pode colidir se 2 pedidos viraram draft com o mesmo nfeNextNumber). Espelha o NFC-e.
    const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFE', serie: issuer.nfeSerie || 1 }, _max: { number: true } });
    const nNF = Math.max(issuer.nfeNextNumber || 1, (maxDoc._max.number || 0) + 1);

    // Marca processing antes de chamar SEFAZ (idempotência)
    await prisma.fiscalDocument.update({
      where: { id: doc.id },
      data: { status: 'processing' },
    });

    // Emite — via Fiscal Agent da loja (preferido) ou fallback SEFAZ direto
    let result;
    if (useAgent) {
      const agentClient = require('../services/fiscalAgentClient');
      result = await agentClient.emitNFe55(store, {
        issuer, items, customer, payment,
        nNF,
      });
    } else {
      const { emitNFe55 } = await getSefazDirect();
      result = await emitNFe55({
        issuer, pfxPath, pfxSenha, items, customer, payment,
        nNF,
      });
    }

    let updated = doc;
    if (result.ok || result.accessKey) {
      // Autorizada, ou rejeitada PELA SEFAZ (tem chave) → grava o desfecho
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          number: nNF,
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
          data: { nfeNextNumber: nNF + 1 },
        });
      }
    } else {
      // Falhou ANTES da SEFAZ (rede/agente) — volta pra draft pra permitir retry
      // (não deleta: preserva o payload do webhook Nuvemshop)
      updated = await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: { status: 'draft', rejectReason: (result.motivo || result.error || 'Falha de transmissão').slice(0, 250) },
      });
    }

    res.json({
      ok: result.ok,
      documentId: updated.id,
      accessKey: result.accessKey,
      protocol: result.protocol,
      status: result.status,
      motivo: result.motivo,
      rejectReason: result.ok ? null : (result.motivo || result.error),
      error: result.ok ? null : (result.motivo || result.error),
    });
  } catch (err) {
    console.error('[fiscal/finalize-nfe-draft]', err);
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

// Monta o nfeProc (NFe assinada + protNFe) a partir do doc autorizado, pra a DANFE
// mostrar o PROTOCOLO. O xmlContent guarda só a NFe assinada (sem protNFe); o protocolo
// real fica em doc.protocol no banco. Sem isso, a DANFE sai com "Protocolo 00000000".
function buildNfeProcForDanfe(signedXml, doc) {
  try {
    if (!signedXml || signedXml.includes('<protNFe') || signedXml.includes('<nfeProc')) return signedXml;
    if (!doc || !doc.protocol || !doc.accessKey) return signedXml;
    const nfe = signedXml.replace(/^﻿?\s*<\?xml[^>]*\?>\s*/i, '');
    const dig = (nfe.match(/<DigestValue>([^<]*)<\/DigestValue>/) || [])[1] || '';
    const tpAmb = (doc.issuer && doc.issuer.environment === 'production') ? '1' : '2';
    const dt = doc.createdAt ? new Date(doc.createdAt) : new Date();
    const dhRecbto = new Date(dt.getTime() - 3 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
    const protNFe = '<protNFe versao="4.00"><infProt><tpAmb>' + tpAmb + '</tpAmb><verAplic>SVRS</verAplic><chNFe>' + doc.accessKey + '</chNFe><dhRecbto>' + dhRecbto + '</dhRecbto><nProt>' + doc.protocol + '</nProt><digVal>' + dig + '</digVal><cStat>100</cStat><xMotivo>Autorizado o uso da NF-e</xMotivo></infProt></protNFe>';
    return '<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' + nfe + protNFe + '</nfeProc>';
  } catch (e) { return signedXml; }
}

router.get('/documents/:id/danfe', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    if (!doc.xmlContent) return res.status(400).json({ error: 'Documento sem XML armazenado' });
    if (doc.status !== 'authorized' && doc.status !== 'cancelled') {
      return res.status(400).json({ error: 'Documento não autorizado (status: ' + doc.status + ')' });
    }

    const { DANFCe, DANFe } = await getSpedPdf();
    const fn = doc.docType === 'NFCE' ? DANFCe : DANFe;
    // DANFE mostra o NOME FANTASIA (a marca, ex "Baratão dos Esportes") no cabeçalho,
    // no lugar da razão social — SÓ na impressão. O XML assinado/enviado à SEFAZ
    // mantém a razão social (xNome) intacta, como exige a lei.
    let renderXml = doc.xmlContent;
    const razao = doc.issuer?.companyName, fant = doc.issuer?.fantasyName;
    if (razao && fant && fant !== razao && renderXml.includes('<xNome>' + razao + '</xNome>')) {
      renderXml = renderXml.replace('<xNome>' + razao + '</xNome>', '<xNome>' + fant + '</xNome>');
    }
    // Envolve a NFe assinada num nfeProc com o protNFe (protocolo vem do banco) — sem isso
    // a DANFE imprime "Protocolo 000000000000000". Só afeta a impressão, não o XML da SEFAZ.
    renderXml = buildNfeProcForDanfe(renderXml, doc);
    const pdfBuffer = await fn({
      xml: renderXml,
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

// Auto-print: página HTML com PDF embed + window.print() automático.
// Configurada pra Epson TM-T20 (largura 80mm, sem margem).
// Acesso via token query param (impressora não consegue mandar header).
router.get('/documents/:id/print', async (req, res) => {
  try {
    if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    const docId = req.params.id;
    const printToken = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Imprimindo DANFE...</title>
<style>
  @page { size: 80mm auto; margin: 0; }
  @media print { body { margin: 0; padding: 0; } iframe { width: 100%; height: 100vh; border: 0; } }
  body { margin: 0; padding: 0; font-family: -apple-system, sans-serif; background: #f5f5f7; }
  .header { background: #E5571E; color: white; padding: 12px; text-align: center; font-weight: 700; }
  .info { padding: 12px; background: white; font-size: 13px; color: #1d1d1f; }
  iframe { width: 100%; height: calc(100vh - 100px); border: 0; display: block; }
  button { padding: 10px 18px; background: #E5571E; color: white; border: 0; border-radius: 6px; font-weight: 700; cursor: pointer; font-size: 14px; }
</style>
</head><body>
<div class="header">🖨️ Imprimindo na Epson TM-T20...</div>
<div class="info" id="status">Carregando DANFE...</div>
<iframe id="danfeFrame" name="danfeFrame"></iframe>
<script>
  (async () => {
    const docId = ${JSON.stringify(docId)};
    const token = ${JSON.stringify(printToken)} || localStorage.getItem('loja_token') || localStorage.getItem('tc_admin_token') || localStorage.getItem('jwt') || '';
    try {
      const r = await fetch('/api/admin/fiscal/documents/' + docId + '/danfe?token=' + encodeURIComponent(token), {
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        document.getElementById('status').innerHTML = '<span style="color:#d70015">❌ ' + (e.error || 'Erro ' + r.status) + '</span>';
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const frame = document.getElementById('danfeFrame');
      frame.src = url;
      document.getElementById('status').innerHTML = '✅ DANFE carregado. Clique <button onclick="frame.contentWindow.focus();frame.contentWindow.print()">🖨️ IMPRIMIR AGORA</button> ou aperte Ctrl+P';
      // Auto-print após carregar
      frame.onload = () => {
        setTimeout(() => {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch (e) {
            console.warn('Auto-print bloqueado:', e);
          }
        }, 500);
      };
    } catch (err) {
      document.getElementById('status').innerHTML = '<span style="color:#d70015">❌ ' + err.message + '</span>';
    }
  })();
</script>
</body></html>`;
    res.type('text/html').send(html);
  } catch (err) {
    console.error('[fiscal/print]', err);
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

    // IDEMPOTÊNCIA — mesma venda = no MÁXIMO uma NFe. Se já há doc NFE autorizado
    // pra esse saleId, devolve ele e NÃO re-emite. (Este caminho usa o provedor
    // Brasil NFe via apiToken — não passa por Fiscal Agent/PFX, então não sofre o
    // problema de path C:\Chianca no Railway.)
    if (saleId) {
      const existingDoc = await prisma.fiscalDocument.findFirst({
        where: { saleId, docType: 'NFE', status: { in: ['authorized', 'processing'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (existingDoc) {
        if (existingDoc.status === 'authorized') {
          return res.json({ ok: true, alreadyEmitted: true, document: existingDoc, message: 'Venda já possui NFe autorizada #' + existingDoc.number });
        }
        const ageMs = Date.now() - new Date(existingDoc.createdAt).getTime();
        if (ageMs < 95000) return res.status(409).json({ error: 'Emissão desta NFe já está em andamento — aguarde alguns segundos', documentId: existingDoc.id });
        // 'processing' antigo (>95s, provavelmente travado): segue e tenta de novo
      }
    }

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

// ============================================================
// Carta de Correção Eletrônica (CCe) — NFe modelo 55 apenas, até 30 dias
// após emissão, até 20 CCe por NFe.
// ============================================================
router.post('/documents/:id/correction', async (req, res) => {
  try {
    const { correction } = req.body || {};
    if (!correction || correction.length < 15) {
      return res.status(400).json({ error: 'Texto da correção deve ter 15+ caracteres (regra SEFAZ)' });
    }

    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    if (doc.docType !== 'NFE') return res.status(400).json({ error: 'CCe só pra NFe modelo 55 (NFCe não suporta)' });
    if (doc.status !== 'authorized') return res.status(400).json({ error: 'Documento precisa estar autorizado (atual: ' + doc.status + ')' });
    if (!doc.accessKey) return res.status(400).json({ error: 'Documento sem chave de acesso' });

    // Verifica idade (30 dias máx)
    const days = (Date.now() - new Date(doc.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (days > 30) return res.status(400).json({ error: 'CCe expirada — NFe tem ' + Math.floor(days) + ' dias (limite SEFAZ: 30)' });

    // Determina próximo sequencial
    const previous = Array.isArray(doc.correctionLetter) ? doc.correctionLetter : (doc.correctionLetter ? [doc.correctionLetter] : []);
    const nSeq = previous.length + 1;
    if (nSeq > 20) return res.status(400).json({ error: 'Limite de 20 CCe por NFe atingido' });

    const pfxPath = pfxPathFor(doc.issuer.cnpj);
    const pfxSenha = pfxSenhaFor(doc.issuer.cnpj);
    if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado pra esse CNPJ' });

    const { sendCorrectionLetter } = await getSefazDirect();
    const result = await sendCorrectionLetter({
      issuer: doc.issuer, pfxPath, pfxSenha,
      accessKey: doc.accessKey,
      correction,
      nSeqEvento: nSeq,
    });

    if (result.ok) {
      const newEntry = {
        sequence: nSeq,
        reason: correction,
        protocol: result.correctionProtocol,
        date: new Date().toISOString(),
        status: result.status,
        motivo: result.motivo,
      };
      const newList = [...previous, newEntry];
      await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: { correctionLetter: newList },
      });
      return res.json({ ok: true, sequence: nSeq, protocol: result.correctionProtocol, motivo: result.motivo });
    }
    res.status(400).json({
      error: result.motivo || 'Erro ao enviar CCe',
      status: result.status,
      detail: result.rawResponse?.slice(0, 1000),
    });
  } catch (err) {
    console.error('[fiscal/correction]', err);
    res.status(500).json({ error: err.message });
  }
});

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
    if (!doc.accessKey || !doc.protocol) return res.status(400).json({ error: 'Documento sem chave/protocolo — não pode cancelar' });
    if (doc.docType !== 'NFCE' && doc.docType !== 'NFE') return res.status(400).json({ error: 'Cancelamento direto SEFAZ suporta só NFCe e NFe (tipo: ' + doc.docType + ')' });

    const pfxPath = pfxPathFor(doc.issuer.cnpj);
    const pfxSenha = pfxSenhaFor(doc.issuer.cnpj);
    if (!pfxPath || !pfxSenha) return res.status(400).json({ error: 'PFX não configurado pra esse CNPJ' });

    const { cancelDocument } = await getSefazDirect();
    const result = await cancelDocument({
      issuer: doc.issuer, pfxPath, pfxSenha,
      accessKey: doc.accessKey,
      protocol: doc.protocol,
      reason,
    });

    if (result.ok) {
      await prisma.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: reason,
          cancelProtocol: result.cancelProtocol || null,
          response: { ...(doc.response || {}), cancel: { status: result.status, motivo: result.motivo, raw: result.rawResponse?.slice(0, 4000) } },
        },
      });
      return res.json({ ok: true, cancelProtocol: result.cancelProtocol, motivo: result.motivo });
    }
    res.status(400).json({
      error: result.motivo || 'Erro ao cancelar',
      status: result.status,
      detail: result.rawResponse?.slice(0, 1000),
    });
  } catch (err) {
    console.error('[fiscal/cancel]', err);
    res.status(500).json({ error: err.message });
  }
});

// DANFE legado (Brasil NFe) — removido. A rota /documents/:id/danfe está
// disponível antes do adminMiddleware acima usando node-sped-pdf local.

module.exports = router;
module.exports.emitNfceFromSaleHandler = emitNfceFromSaleHandler;
