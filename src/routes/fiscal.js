// =====================================================================
// Routes: /api/admin/fiscal — Emissão de NFe / NFCe / CTe via Brasil NFe
// =====================================================================
// Endpoints administrativos pra emitir, consultar e cancelar documentos
// fiscais. Cada documento é vinculado a um FiscalIssuer (CNPJ emissor).
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const fiscal = require('../services/fiscalApi');

const router = express.Router();
router.use(authMiddleware);
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

// DANFE PDF (proxy autenticado)
router.get('/documents/:id/danfe', async (req, res) => {
  try {
    const doc = await prisma.fiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { issuer: true },
    });
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    if (!doc.externalId) return res.status(400).json({ error: 'Documento sem externalId — não foi emitido' });

    let resp;
    if (doc.docType === 'NFCE') resp = await fiscal.getNFCePdf(doc.issuer, doc.externalId);
    else if (doc.docType === 'NFE') resp = await fiscal.getNFePdf(doc.issuer, doc.externalId);
    else return res.status(400).json({ error: 'Tipo não tem DANFE' });

    if (resp.pdf) {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="danfe-${doc.number}.pdf"` });
      return res.send(resp.pdf);
    }
    res.status(400).json({ error: 'Sem PDF retornado', detail: resp.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
