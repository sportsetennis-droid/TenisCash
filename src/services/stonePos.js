'use strict';

// =====================================================================
// Venda ↔ maquininha Stone (Connect 2.0)
// =====================================================================
// 1) Venda no cartão/PIX numa loja com Stone ligada → cria pedido direto pra POS
//    (valor = total − TenisCash). Venda fica 'pending_payment', sem cupom ainda.
// 2) Webhook charge.paid (ou o polling do PDV) → RE-CONSULTA a Stone com a chave
//    DAQUELA loja (nunca confia no payload) → marca pago, fecha o pedido e emite a
//    NFC-e com bandeira + autorização da maquininha (tpIntegra 1). Idempotente.
// Nada aqui derruba a venda: erro da Stone volta como fiscalResult.stoneError.
// =====================================================================

const { prisma } = require('../middleware');
const { createFinSchemaReadiness } = require('./finSchema');
const stone = require('./stoneConnect');
const salePaymentPlan = require('./salePaymentPlan');

const ensureSchema = createFinSchemaReadiness(prisma);

async function loadConfig(storeId) {
  if (!storeId) return null;
  await ensureSchema();
  return prisma.stoneConfig.findUnique({ where: { storeId } });
}

// Usada pela venda: devolve a config só se a loja está pronta pra mandar pedido.
async function activeConfigFor(storeId) {
  try {
    const cfg = await loadConfig(storeId);
    return stone.isConfigured(cfg) ? cfg : null;
  } catch (e) {
    console.error('[stone] config indisponível:', e.message);
    return null;
  }
}

async function startPosPayment({ cfg, saleId, storeId, paymentMethod, totalAmount, tcUsed, installments, deviceSerial, customerName, customerCpf, customerCpfName }) {
  const type = stone.paymentTypeFor(paymentMethod);
  const serials = stone.parseSerials(cfg.deviceSerials);
  const serial = deviceSerial && serials.includes(String(deviceSerial)) ? String(deviceSerial) : serials[0];
  const amountCents = salePaymentPlan.amountDueCents({ totalAmount, tcUsed });
  const created = await stone.createPosOrder(cfg, { amountCents, saleId, type, installments, deviceSerial: serial, customerName });
  const parcelas = created.body.poi_payment_settings.payment_setup.installments || 1;
  await prisma.stonePosOrder.create({
    data: {
      saleId, storeId, orderId: created.orderId, deviceSerial: serial, paymentType: type,
      installments: parcelas, amountCents,
      customerCpf: customerCpf || null, customerName: customerCpfName || null,
    },
  });
  await prisma.sale.update({ where: { id: saleId }, data: { status: 'pending_payment' } });
  return { stonePending: true, orderId: created.orderId, amountCents, deviceSerial: serial, paymentType: type, installments: parcelas };
}

// Emite o cupom reaproveitando o handler validado do fiscal.js (req/res fake).
function emitForSale(input) {
  const { emitNfceFromSaleHandler } = require('../routes/fiscal');
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

async function afterPaidHooks(saleId, tag) {
  const storeRadio = require('./storeRadio');
  const relationshipCommission = require('./relationshipCommission');
  await storeRadio.queueSaleAnnouncement(saleId).catch((e) => console.error(`[stone ${tag}] anúncio não enfileirado:`, e.message));
  await relationshipCommission.activateJourneyAfterPayment(prisma, saleId).catch(() => {});
  await relationshipCommission.submitReservedReferralAfterPayment(prisma, saleId).catch((e) => console.error(`[stone ${tag}] indicação:`, e.message));
}

// Re-consulta a Stone e, se pago, conclui a venda e emite o cupom. Idempotente.
async function confirmAndEmit(row, tag) {
  const cfg = await loadConfig(row.storeId);
  if (!cfg || !cfg.secretKey) return { paid: false, error: 'Loja sem chave da Stone' };
  const order = await stone.getOrder(cfg, row.orderId);
  const pay = stone.readPayment(order);

  if (!pay.paid) {
    if (pay.refunded && row.status !== 'refunded') {
      await prisma.stonePosOrder.update({ where: { id: row.id }, data: { status: 'refunded' } });
      console.warn(`[stone ${tag}] pagamento ESTORNADO na maquininha`, row.saleId);
      return { paid: false, refunded: true };
    }
    return { paid: false, status: order && order.status };
  }

  const expected = row.amountCents;
  const amountMismatch = pay.paidCents != null && pay.paidCents !== expected;
  if (amountMismatch) console.warn(`[stone ${tag}] VALOR PAGO DIFERENTE DO DEVIDO`, JSON.stringify({ sale: row.saleId, paidCents: pay.paidCents, expected }));

  if (row.status !== 'paid') {
    await prisma.stonePosOrder.update({
      where: { id: row.id },
      data: {
        status: 'paid', paidCents: pay.paidCents, chargeId: pay.chargeId, nsu: pay.nsu, authCode: pay.authCode,
        brand: pay.brand, fundingSource: pay.fundingSource, paidInstallments: pay.installments,
        terminalSerial: pay.terminalSerial, paidAt: pay.paidAt ? new Date(pay.paidAt) : new Date(),
      },
    });
  }
  // Pedido pago tem que ser fechado, senão a maquininha para de receber pedido novo.
  if (order && order.closed !== true) {
    await stone.closeOrder(cfg, row.orderId, 'paid').catch((e) => console.error(`[stone ${tag}] fechar pedido:`, e.message));
  }

  const sale = await prisma.sale.findUnique({ where: { id: row.saleId } });
  if (!sale) return { paid: true, error: 'Venda não encontrada' };
  if (sale.status === 'canceled') {
    console.warn(`[stone ${tag}] PAGO NA MAQUININHA MAS A VENDA ESTÁ CANCELADA — estornar na maquininha`, row.saleId);
    return { paid: true, canceledSale: true, error: 'Venda cancelada com pagamento aprovado: estorne na maquininha.' };
  }
  if (sale.status !== 'completed') {
    await prisma.sale.update({ where: { id: sale.id }, data: { status: 'completed' } });
    await afterPaidHooks(sale.id, tag);
  }

  const existing = await prisma.fiscalDocument.findFirst({ where: { saleId: sale.id, docType: 'NFCE', status: 'authorized' } });
  if (existing) return { paid: true, alreadyEmitted: true, documentId: existing.id, number: existing.number, amountMismatch };

  const fiscalPay = stone.nfcePaymentFor(pay, row.paymentType);
  const r = await emitForSale({
    saleId: sale.id,
    ...fiscalPay,
    customerCpf: row.customerCpf || undefined,
    customerName: row.customerName || undefined,
    customerCpfName: row.customerName || undefined,
  });
  const ok = !!(r.body && r.body.ok);
  const docId = r.body && r.body.documentId;
  await prisma.stonePosOrder.update({
    where: { id: row.id },
    data: { fiscalDocumentId: ok ? docId : row.fiscalDocumentId, lastError: ok ? null : String((r.body && r.body.error) || 'Falha ao emitir cupom').slice(0, 500) },
  }).catch(() => {});
  console.log(`[stone ${tag}] emissão`, JSON.stringify({ sale: sale.id, ok, doc: docId, nsu: pay.nsu }));
  return { paid: true, emitted: ok, documentId: docId, number: r.body && r.body.number, amountMismatch, error: ok ? null : (r.body && r.body.error) };
}

async function findOrderForSale(saleId) {
  await ensureSchema();
  return prisma.stonePosOrder.findUnique({ where: { saleId: String(saleId) } });
}

// Cancela o pedido na maquininha (só se ainda não pagou).
async function cancelPosOrder(row) {
  const cfg = await loadConfig(row.storeId);
  if (!cfg || !cfg.secretKey) throw new Error('Loja sem chave da Stone');
  const pay = stone.readPayment(await stone.getOrder(cfg, row.orderId));
  if (pay.paid) return { paid: true };
  await stone.closeOrder(cfg, row.orderId, 'canceled');
  await prisma.stonePosOrder.update({ where: { id: row.id }, data: { status: 'canceled' } });
  return { canceled: true };
}

// Trava do cancelamento de venda: pedido pago bloqueia; pedido aberto é cancelado na Stone.
async function guardSaleCancel(saleId) {
  let row;
  try { row = await findOrderForSale(saleId); } catch (e) { console.error('[stone] guard:', e.message); return { ok: true }; }
  if (!row || ['canceled', 'refunded', 'failed'].includes(row.status)) return { ok: true };
  if (row.status === 'paid') return { ok: false, error: 'Esta venda foi PAGA na maquininha Stone. Estorne o pagamento na maquininha antes de cancelar a venda.' };
  try {
    const r = await cancelPosOrder(row);
    if (r.paid) return { ok: false, error: 'O cliente já pagou na maquininha Stone. Estorne o pagamento na maquininha antes de cancelar a venda.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'Não consegui cancelar o pedido na maquininha Stone (' + e.message + '). Aperte o X vermelho na maquininha e tente de novo.' };
  }
}

module.exports = { ensureSchema, loadConfig, activeConfigFor, startPosPayment, confirmAndEmit, findOrderForSale, cancelPosOrder, guardSaleCancel };
