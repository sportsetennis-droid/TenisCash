// =====================================================================
// Routes: /api/pagbank — webhook PIX (PagBank) + status pro PDV
// =====================================================================
// Fora de /api/admin (PagBank chama o webhook sem auth). O mapeamento
// pra loja é pelo reference_id (=saleId) / order id. NÃO confia no
// payload: SEMPRE re-consulta a API com o token DAQUELA loja.
// =====================================================================

const express = require('express');
const { prisma } = require('../middleware');
const pagbank = require('../services/pagbank');
const relationshipCommission = require('../services/relationshipCommission');
const storeRadio = require('../services/storeRadio');

const router = express.Router();

// Emite o cupom reaproveitando o handler validado do fiscal.js (req/res fake).
function emitForSale(input) {
  const { emitNfceFromSaleHandler } = require('./fiscal');
  return new Promise((resolve) => {
    const req = { body: input, userId: null, userRole: 'store' };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ httpStatus: this.statusCode, body: o }); },
    };
    Promise.resolve(emitNfceFromSaleHandler(req, res)).catch((e) => resolve({ httpStatus: 500, body: { error: e.message } }));
  });
}

// Acha a venda + loja a partir do payload do webhook (ou de um saleId direto).
async function resolveSale({ orderId, referenceId }) {
  let sale = null;
  if (referenceId) sale = await prisma.sale.findUnique({ where: { id: String(referenceId) } }).catch(() => null);
  if (!sale && orderId) sale = await prisma.sale.findFirst({ where: { pagbankOrderId: String(orderId) } });
  if (!sale) return null;
  const store = sale.storeId ? await prisma.store.findUnique({ where: { id: sale.storeId } }) : null;
  return { sale, store, orderId: orderId || sale.pagbankOrderId };
}

// Confirma pagamento (re-consulta a API) e emite o cupom — idempotente.
async function confirmAndEmit(sale, store, orderId, tag) {
  // Venda CANCELADA não ressuscita: PIX que cair depois do cancelamento NÃO emite cupom nem volta pra 'completed'.
  if (sale.status === 'canceled') { console.warn(`[pagbank ${tag}] venda CANCELADA — ignora pagamento`, sale.id); return { paid: false, canceled: true }; }
  if (!store || !pagbank.isConfigured(store)) { console.warn(`[pagbank ${tag}] loja sem pagbank`, sale.id); return { paid: false }; }
  if (!orderId) { console.warn(`[pagbank ${tag}] sale sem orderId`, sale.id); return { paid: false }; }
  const order = await pagbank.getOrder(store, orderId);
  const pay = pagbank.readPixPayment(order);
  if (!pay.paid) { console.log(`[pagbank ${tag}] ainda nao pago`, { sale: sale.id, status: pay.status }); return { paid: false, status: pay.status }; }
  // marca a venda paga
  if (sale.status !== 'completed') await prisma.sale.update({ where: { id: sale.id }, data: { status: 'completed' } }).catch(() => {});
  await storeRadio.queueSaleAnnouncement(sale.id).catch((error) => {
    console.error(`[store-radio ${tag}] anúncio não enfileirado:`, error.message);
  });
  await relationshipCommission.activateJourneyAfterPayment(prisma, sale.id).catch(() => {});
  await relationshipCommission.submitReservedReferralAfterPayment(prisma, sale.id).catch((error) => {
    console.error(`[pagbank ${tag}] indicacao nao enviada para fiscalizacao:`, error.message);
  });
  // idempotência: cupom já autorizado → nada a fazer
  const existing = await prisma.fiscalDocument.findFirst({ where: { saleId: sale.id, docType: 'NFCE', status: 'authorized' } });
  if (existing) return { paid: true, alreadyEmitted: true, documentId: existing.id, number: existing.number, e2e: pay.e2e };
  const r = await emitForSale({ saleId: sale.id, paymentMethod: '17', acquirerKey: 'PAGSEGURO', tpIntegra: 2 });
  const docId = r.body && r.body.documentId;
  if (r.body && r.body.ok && docId && pay.e2e) {
    await prisma.fiscalDocument.update({ where: { id: docId }, data: { paymentAuthCode: pay.e2e } }).catch(() => {});
  }
  console.log(`[pagbank ${tag}] emissao`, JSON.stringify({ sale: sale.id, ok: r.body?.ok, doc: docId, e2e: pay.e2e }));
  return { paid: true, emitted: !!(r.body && r.body.ok), documentId: docId, e2e: pay.e2e, error: r.body && r.body.ok ? null : (r.body && r.body.error) };
}

// POST /api/pagbank/webhook — notificação do PagBank.
router.post('/webhook', async (req, res) => {
  // Responde 2xx rápido (senão o PagBank reenvia). Processa best-effort.
  res.json({ received: true });
  try {
    const p = req.body || {};
    const orderId = p.id || p.order_id || (p.data && p.data.id) || (p.charges && p.charges[0] && p.charges[0].order_id) || null;
    const referenceId = p.reference_id || (p.data && p.data.reference_id) || (p.charges && p.charges[0] && p.charges[0].reference_id) || null;
    if (!orderId && !referenceId) { console.warn('[pagbank webhook] sem orderId/reference', JSON.stringify(p).slice(0, 300)); return; }
    const found = await resolveSale({ orderId, referenceId });
    if (!found) { console.warn('[pagbank webhook] venda nao encontrada', { orderId, referenceId }); return; }
    await confirmAndEmit(found.sale, found.store, found.orderId, 'webhook');
  } catch (e) {
    console.error('[pagbank webhook] erro:', e.message);
  }
});

// GET /api/pagbank/pix-status/:saleId — PDV faz polling enquanto mostra o QR.
// Auto-cura: se já pagou mas o webhook não chegou, emite aqui também (idempotente).
router.get('/pix-status/:saleId', async (req, res) => {
  try {
    const sale = await prisma.sale.findUnique({ where: { id: req.params.saleId } });
    if (!sale) return res.status(404).json({ error: 'venda nao encontrada' });
    let doc = await prisma.fiscalDocument.findFirst({ where: { saleId: sale.id, docType: 'NFCE', status: 'authorized' }, orderBy: { createdAt: 'desc' } });
    let paid = sale.status === 'completed' || !!doc;
    if (!doc && sale.pagbankOrderId && sale.storeId) {
      const store = await prisma.store.findUnique({ where: { id: sale.storeId } });
      const r = await confirmAndEmit(sale, store, sale.pagbankOrderId, 'poll').catch(() => ({ paid: false }));
      paid = paid || r.paid;
      if (r.documentId) doc = await prisma.fiscalDocument.findUnique({ where: { id: r.documentId } });
    }
    res.json({
      paid,
      status: paid ? 'paid' : 'pending',
      cupom: doc ? { documentId: doc.id, number: doc.number, accessKey: doc.accessKey } : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
