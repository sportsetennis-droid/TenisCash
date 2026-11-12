'use strict';
// Stone Connect — fluxo com Postgres real (CI) e API da Stone simulada. Banco descartável apenas.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/')) throw Error('Somente banco local isolado.');
process.env.DATABASE_URL = url;

// API da Stone simulada: intercepta só https://api.pagar.me; o resto (servidor local) passa.
const realFetch = globalThis.fetch;
const stoneCalls = [];
let stoneOrders = {}; // orderId -> resposta do GET
let nextOrder = 1;
globalThis.fetch = async (u, init = {}) => {
  if (!String(u).startsWith('https://api.pagar.me')) return realFetch(u, init);
  const method = init.method || 'GET';
  stoneCalls.push({ url: String(u), method, body: init.body ? JSON.parse(init.body) : null, auth: init.headers && init.headers.Authorization });
  const reply = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  if (method === 'POST' && u.endsWith('/core/v5/orders')) {
    const id = 'or_test' + (nextOrder++);
    stoneOrders[id] = { id, status: 'pending', closed: false, charges: [] };
    return reply(200, { id, status: 'pending' });
  }
  const m = String(u).match(/\/core\/v5\/orders\/([^/?]+)(\/closed)?/);
  if (m && method === 'PATCH') { stoneOrders[m[1]].closed = true; return reply(200, { id: m[1], closed: true }); }
  if (m && method === 'GET') return stoneOrders[m[1]] ? reply(200, stoneOrders[m[1]]) : reply(404, { message: 'not found' });
  return reply(404, { message: 'rota simulada inexistente' });
};

const mw = require('../src/middleware');
const db = mw.prisma;
const stonePos = require('../src/services/stonePos');
const router = require('../src/routes/stone');

const app = express();
app.use(express.json());
app.use('/api/stone', router);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label) {
  for (let i = 0; i < 40; i++) { if (await fn()) return; await wait(100); }
  throw new Error('timeout: ' + label);
}

(async () => {
  await stonePos.ensureSchema();
  await stonePos.ensureSchema();

  const u = randomUUID();
  const admin = await db.user.create({ data: { name: 'stone-admin', role: 'admin', phone: 'stone-a-' + u, pin: 'test-only' } });
  const seller = await db.user.create({ data: { name: 'stone-seller', role: 'seller', phone: 'stone-s-' + u, pin: 'test-only' } });
  const store = await db.store.create({ data: { code: 'STN-' + u.slice(0, 8), name: 'Loja Stone Teste' } });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/stone';
  const call = async (path, { method, body, who } = {}) => {
    const r = await realFetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(who ? { Authorization: 'Bearer ' + jwt.sign({ userId: who.id }, mw.JWT_SECRET, { expiresIn: '5m' }) } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    // ---- configuração (admin) ----
    assert.equal((await call('/admin/stores', { who: seller })).status, 403);
    assert.equal((await call('/admin/stores/' + store.id, { who: admin, body: { enabled: true, secretKey: 'sk_abc' } })).status, 400, 'não liga sem serial');
    assert.equal((await call('/admin/stores/' + store.id, { who: admin, body: { secretKey: 'chave-errada' } })).status, 400, 'chave precisa começar com sk_');
    const saved = await call('/admin/stores/' + store.id, { who: admin, body: { enabled: true, secretKey: 'sk_abc123', serviceRefererName: 'partner-x', deviceSerials: '6C582505, 6N02' } });
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal(saved.data.store.ready, true);
    assert.equal(saved.data.store.keyMasked, '••••c123');
    assert.equal(saved.data.store.deviceSerials, '6C582505,6N02');
    assert.ok(!JSON.stringify(saved.data).includes('sk_abc123'), 'chave nunca volta inteira');
    const token = saved.data.store.webhookUrl.split('/webhook/')[1];
    assert.ok(token && token.length === 48);
    const listed = await call('/admin/stores', { who: admin });
    assert.ok(listed.data.stores.some((s) => s.id === store.id && s.enabled));

    // ---- venda vai pra maquininha (valor = total − TenisCash) ----
    const cfg = await stonePos.activeConfigFor(store.id);
    assert.ok(cfg, 'loja pronta');
    const sale = await db.sale.create({ data: { sellerId: seller.id, storeId: store.id, totalAmount: 150, tcUsed: 20.5, status: 'completed' } });
    const started = await stonePos.startPosPayment({ cfg, saleId: sale.id, storeId: store.id, paymentMethod: 'credit_card', totalAmount: 150, tcUsed: 20.5, installments: 2, customerCpf: '12345678909', customerCpfName: 'Cliente' });
    assert.equal(started.stonePending, true);
    assert.equal(started.amountCents, 12950);
    assert.equal(started.deviceSerial, '6C582505');
    const post = stoneCalls.find((c) => c.method === 'POST');
    assert.equal(post.body.items[0].amount, 12950);
    assert.deepEqual(post.body.poi_payment_settings.payment_setup, { type: 'credit', installments: 2, installment_type: 'merchant' });
    assert.equal(post.auth, 'Basic ' + Buffer.from('sk_abc123:').toString('base64'));
    assert.equal((await db.sale.findUnique({ where: { id: sale.id } })).status, 'pending_payment');

    // ainda não pagou
    let st = await call('/status/' + sale.id, { who: seller });
    assert.equal(st.status, 200, JSON.stringify(st));
    assert.equal(st.data.paid, false);
    assert.equal(st.data.status, 'open');
    assert.equal((await call('/status/' + sale.id)).status, 401);

    // ---- pagou na maquininha → webhook ----
    stoneOrders[started.orderId] = {
      id: started.orderId, status: 'paid', closed: false,
      charges: [{ id: 'ch_1', code: 'NSU777', status: 'paid', amount: 12950, paid_amount: 12950, paid_at: new Date().toISOString(),
        metadata: { scheme_name: 'Visa', account_funding_source: 'Credit', authorization_code: 'AUT123', installment_quantity: '2', terminal_serial_number: '6C582505' } }],
    };
    const hook = { type: 'charge.paid', data: { id: 'ch_1', order: { id: started.orderId } } };
    await call('/webhook/token-errado', { body: hook });
    await wait(300);
    assert.equal((await db.stonePosOrder.findUnique({ where: { saleId: sale.id } })).status, 'open', 'token errado não processa');

    const w = await call('/webhook/' + token, { body: hook });
    assert.equal(w.status, 200);
    await until(async () => (await db.stonePosOrder.findUnique({ where: { saleId: sale.id } })).status === 'paid', 'webhook marca pago');
    const row = await db.stonePosOrder.findUnique({ where: { saleId: sale.id } });
    assert.equal(row.nsu, 'NSU777');
    assert.equal(row.authCode, 'AUT123');
    assert.equal(row.brand, 'Visa');
    assert.equal(row.paidCents, 12950);
    assert.equal(row.paidInstallments, 2);
    await until(async () => (await db.sale.findUnique({ where: { id: sale.id } })).status === 'completed', 'venda concluída');
    assert.ok(stoneCalls.some((c) => c.method === 'PATCH' && c.url.endsWith(started.orderId + '/closed') && c.body.status === 'paid'), 'pedido pago é fechado');
    // Loja de teste sem emissor fiscal: o cupom não sai e o motivo fica gravado (não derruba nada).
    await until(async () => !!(await db.stonePosOrder.findUnique({ where: { saleId: sale.id } })).lastError, 'erro do cupom registrado');

    // venda paga não cancela pelo sistema (estorno é na maquininha)
    const g = await stonePos.guardSaleCancel(sale.id);
    assert.equal(g.ok, false);
    assert.match(g.error, /Estorne/);
    assert.equal((await call('/cancel/' + sale.id, { who: seller, body: {} })).status, 409);

    // ---- pedido aberto: cancelar retira da maquininha ----
    const sale2 = await db.sale.create({ data: { sellerId: seller.id, storeId: store.id, totalAmount: 30, status: 'completed' } });
    const s2 = await stonePos.startPosPayment({ cfg, saleId: sale2.id, storeId: store.id, paymentMethod: 'debit_card', totalAmount: 30, tcUsed: 0 });
    const c2 = await call('/cancel/' + sale2.id, { who: seller, body: {} });
    assert.equal(c2.status, 200, JSON.stringify(c2));
    assert.equal((await db.stonePosOrder.findUnique({ where: { saleId: sale2.id } })).status, 'canceled');
    assert.ok(stoneCalls.some((c) => c.method === 'PATCH' && c.url.endsWith(s2.orderId + '/closed') && c.body.status === 'canceled'));
    assert.equal((await stonePos.guardSaleCancel(sale2.id)).ok, true, 'cancelado libera cancelar a venda');

    // ---- cancelar venda com pedido aberto: o guard retira da maquininha ----
    const sale3 = await db.sale.create({ data: { sellerId: seller.id, storeId: store.id, totalAmount: 10, status: 'completed' } });
    await stonePos.startPosPayment({ cfg, saleId: sale3.id, storeId: store.id, paymentMethod: 'pix', totalAmount: 10, tcUsed: 0 });
    assert.equal((await stonePos.guardSaleCancel(sale3.id)).ok, true);
    assert.equal((await db.stonePosOrder.findUnique({ where: { saleId: sale3.id } })).status, 'canceled');

    // ---- estorno na maquininha é registrado ----
    const sale4 = await db.sale.create({ data: { sellerId: seller.id, storeId: store.id, totalAmount: 10, status: 'completed' } });
    const s4 = await stonePos.startPosPayment({ cfg, saleId: sale4.id, storeId: store.id, paymentMethod: 'credit_card', totalAmount: 10, tcUsed: 0 });
    stoneOrders[s4.orderId].charges = [{ id: 'ch_4', status: 'canceled', amount: 1000, metadata: {} }];
    const r4 = await stonePos.confirmAndEmit(await db.stonePosOrder.findUnique({ where: { saleId: sale4.id } }), 'test');
    assert.equal(r4.refunded, true);
    assert.equal((await db.stonePosOrder.findUnique({ where: { saleId: sale4.id } })).status, 'refunded');

    // loja desligada não manda pedido
    await call('/admin/stores/' + store.id, { who: admin, body: { enabled: false } });
    assert.equal(await stonePos.activeConfigFor(store.id), null);

    console.log('PASS stone HTTP: config admin, pedido com valor − TenisCash, webhook com token, re-consulta, fecha pedido, venda paga não cancela, cancelamento e estorno');
  } finally {
    await new Promise((r) => server.close(r));
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
