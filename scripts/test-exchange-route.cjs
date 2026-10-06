'use strict';

// Executes the actual /troca handler with an in-memory database and fiscal agent.
// Deliberately no real Prisma client, HTTP server, certificate, or SEFAZ transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const money = value => Math.round(value * 100);

function matches(row, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return wanted.some(branch => matches(row, branch));
    const actual = row[key];
    if (wanted && typeof wanted === 'object') {
      if (wanted.path) return wanted.path.reduce((v, k) => v?.[k], actual) === wanted.equals;
      if ('in' in wanted) return wanted.in.includes(actual);
      if ('not' in wanted) return actual !== wanted.not;
      throw Error('Unimplemented query operator: ' + key);
    }
    return actual === wanted;
  });
}

function fixture(options = {}) {
  const issuer = { id: 'issuer', active: true, companyName: 'ISOLATED TEST', cnpj: '00000000000000', nfeNextNumber: 1, nfceNextNumber: 2 };
  let state = {
    stores: [{ id: 'store', code: 'TEST', fiscalIssuer: issuer, fiscalAgentEnabled: true, fiscalAgentUrl: 'http://invalid.local.test', fiscalAgentToken: 'ISOLATED-TEST-ONLY' }],
    products: [{ id: 'new-product', name: 'New shoe', sku: 'TEST-SHOE', ncm: '64041100', brand: 'Test', price: 1299, costPrice: 50 },
      { id: 'old-product', name: 'Returned shoe', sku: 'TEST-OLD', ncm: '64041100', brand: 'Test', price: 711.11 }],
    sizes: [{ id: 'new-size', productId: 'new-product', size: '41', barcode: 'TEST-BARCODE', stock: 20 },
      { id: 'old-size', productId: 'old-product', size: '38', barcode: 'TEST-OLD', stock: 20 }],
    sales: [{ id: 'original-sale', storeId: 'store', sellerId: 'seller', totalAmount: 711.11, status: 'completed', items: [
      { id: 'original-item', productId: 'old-product', productSizeId: 'old-size', productName: 'Returned shoe', size: '38', quantity: 1, unitPrice: 711.11, totalPrice: 711.11 },
    ] }],
    docs: [{ id: 'original-doc', issuerId: 'issuer', docType: 'NFCE', status: 'authorized', accessKey: 'ORIGINAL-TEST', number: 1, saleId: 'original-sale', totalValue: 711.11 }],
    moves: [], calls: [], counter: 0,
  };
  let cupomAttempts = 0;
  const db = {
    store: { findUnique: async ({ where }) => clone(state.stores.find(r => matches(r, where))) },
    product: {
      findMany: async ({ where }) => clone(state.products.filter(r => matches(r, where))),
      findUnique: async ({ where }) => { const p = state.products.find(r => matches(r, where)); return p ? clone({ ...p, sizes: state.sizes.filter(s => s.productId === p.id) }) : null; },
    },
    productSize: { findFirst: async ({ where, include }) => {
      const s = state.sizes.find(r => matches(r, where));
      return s ? clone({ ...s, ...(include?.product ? { product: state.products.find(p => p.id === s.productId) } : {}) }) : null;
    } },
    sale: {
      findUnique: async ({ where }) => clone(state.sales.find(r => matches(r, where))),
      update: async ({ where, data }) => { const row = state.sales.find(r => matches(r, where)); assert.ok(row); Object.assign(row, clone(data)); return clone(row); },
      create: async ({ data }) => {
        assert.ok(!state.sales.some(s => s.idemKey && s.idemKey === data.idemKey), 'sale idemKey unique');
        const row = { ...clone(data), id: 'sale-' + (++state.counter), items: data.items.create.map(i => ({ ...clone(i), id: 'item-' + (++state.counter) })) };
        state.sales.push(row); return clone(row);
      },
    },
    fiscalDocument: {
      findUnique: async ({ where }) => clone(state.docs.find(r => matches(r, where))),
      findMany: async ({ where }) => clone(state.docs.filter(r => matches(r, where))),
      findFirst: async ({ where }) => clone(state.docs.filter(r => matches(r, where)).at(-1)),
      aggregate: async ({ where }) => ({ _max: { number: Math.max(0, ...state.docs.filter(r => matches(r, where)).map(r => r.number)) } }),
      create: async ({ data }) => { const row = { ...clone(data), id: 'doc-' + (++state.counter) }; state.docs.push(row); return clone(row); },
      update: async ({ where, data }) => { const row = state.docs.find(r => matches(r, where)); assert.ok(row); Object.assign(row, clone(data)); return clone(row); },
      updateMany: async ({ where, data }) => { const rows = state.docs.filter(r => matches(r, where)); for (const row of rows) Object.assign(row, clone(data)); return { count: rows.length }; },
      delete: async ({ where }) => { state.docs = state.docs.filter(r => !matches(r, where)); },
    },
    fiscalIssuer: { update: async ({ data }) => { Object.assign(issuer, clone(data)); return clone(issuer); } },
    $queryRaw: async () => [],
    $transaction: async fn => { const before = clone(state); try { return await fn(db); } catch (e) { state = before; throw e; } },
  };
  const agent = {
    emitNFe55: async (store, payload) => {
      state.calls.push({ kind: 'return', storeId: store.id, payload: clone(payload) });
      if (options.throwReturn) throw Error('SIMULATED return transport exception');
      if (options.returnTimeout) return { ok: false, error: 'agent timeout' };
      return { ok: true, status: '100', accessKey: 'TEST-RETURN', protocol: 'TEST', xmlSigned: '<test/>' };
    },
    emitNFCe: async (store, payload) => {
      state.calls.push({ kind: 'sale', storeId: store.id, payload: clone(payload) });
      cupomAttempts++;
      if (options.throwCupom) throw Error('SIMULATED transport exception');
      if (options.cupomTimeout) return { ok: false, error: 'agent timeout' };
      if (options.failFirstCupom && cupomAttempts === 1) return { ok: false, status: '999', accessKey: 'TEST-REJECTED', motivo: 'SIMULATED rejection' };
      return { ok: true, status: '100', accessKey: 'TEST-CUPOM', protocol: 'TEST', xmlSigned: '<test/>' };
    },
  };
  let handler;
  const router = { use() {}, get() {}, put() {}, post(route, callback) { if (route === '/troca') handler = callback; } };
  const context = {
    console: { log() {}, warn() {}, error() {} }, module: { exports: {} }, process: { env: {} }, __dirname: path.join(root, 'src/routes'),
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === 'node:path') return path;
      if (name === '../middleware') return { prisma: db, authMiddleware() {}, adminMiddleware() {} };
      if (name === '../services/fiscalAgentClient') return agent;
      if (name === '../services/exchangePricing') return require('../src/services/exchangePricing');
      if (name === '../services/storeStockLedger') return { applyStoreStockDelta: async (_tx, movement) => { state.moves.push(clone(movement)); } };
      if (['../services/fiscalApi', '../services/cupomThermal', '../services/ncmRobot'].includes(name)) return {};
      throw Error('Blocked dependency in isolated test: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/routes/fiscal.js'), 'utf8'), context, { filename: 'fiscal.js' });
  assert.equal(typeof handler, 'function');
  const body = { storeId: 'store', originalDocId: 'original-doc', returned: [{ saleItemId: 'original-item', qty: 1 }], newItems: [{ barcode: 'TEST-BARCODE', size: '41', qty: 1 }], customerCpf: '11111111111', diffPayment: { tPag: '17' } };
  return {
    get state() { return state; }, body,
    async run(overrides = {}, user = {}) {
      let status = 200, result;
      await handler({ body: { ...clone(body), ...clone(overrides) }, userId: 'operator', userRole: 'superadmin', ...user },
        { status(code) { status = code; return this; }, json(data) { result = clone(data); return this; } });
      return { status, ...result };
    },
  };
}

let passed = 0;
function check(label, work) { return Promise.resolve().then(work).then(() => { passed++; console.log('PASS ' + label); }); }
function verifyAmounts(f, result, expected, auth = null) {
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.ok, true, JSON.stringify(result));
  const sale = f.state.sales.find(s => s.id === result.saleId), cupom = f.state.docs.find(d => d.id === result.cupom.docId);
  const payload = f.state.calls.filter(c => c.kind === 'sale').at(-1).payload;
  assert.equal(money(sale.totalAmount), money(expected)); assert.equal(money(cupom.totalValue), money(expected));
  assert.equal(sale.items.reduce((s, i) => s + money(i.totalPrice), 0), money(expected));
  assert.equal(payload.items.reduce((s, i) => s + money(i.qty * i.unitPrice), 0), money(expected));
  assert.equal(payload.payments.reduce((s, p) => s + money(p.valor), 0), money(expected));
  assert.equal(cupom.paymentAuthCode, auth);
  const catalog = f.state.products.find(p => p.id === 'new-product'); assert.equal(catalog.price, 1299);
  assert.equal(f.state.sizes.find(s => s.id === 'new-size').stock, 20, 'Purchased stock untouched');
  assert.equal(f.state.moves.filter(m => m.type === 'exchange_return').reduce((n, m) => n + m.quantity, 0), 1);
  const soldQty = sale.items.reduce((n, i) => n + i.quantity, 0);
  assert.equal(f.state.moves.filter(m => m.type === 'exchange_sale').reduce((n, m) => n + m.quantity, 0), -soldQty);
  return { sale, cupom, payload };
}

(async () => {
  for (const tPag of ['01', '17', '03', '04']) for (const blank of [undefined, '', '   ', '000000']) {
    await check('manual difference, optional empty NSU ' + tPag + '/' + JSON.stringify(blank), async () => {
      const f = fixture(), r = await f.run({ diffAmount: 100, diffPayment: { tPag, cardAuthCode: blank } });
      const { payload, cupom } = verifyAmounts(f, r, 811.11);
      assert.equal(payload.payments[1].valor, 100); assert.equal(payload.payments[1].cAut, undefined);
      assert.equal(cupom.response.troca.pricing.diff, 100); assert.equal(cupom.response.troca.pricing.overridden, true);
    });
  }
  await check('provided NSU trimmed and persisted', async () => {
    const f = fixture(), r = await f.run({ diffAmount: 100, diffPayment: { tPag: '03', cardAuthCode: '  TEST-123  ' } });
    assert.equal(verifyAmounts(f, r, 811.11, 'TEST-123').payload.payments[1].cAut, 'TEST-123');
  });
  await check('catalog suggestion unchanged when no override', async () => {
    const f = fixture(), r = await f.run(); verifyAmounts(f, r, 1299); assert.equal(r.valores.diferenca, 587.89);
  });
  await check('zero difference needs no payment or NSU', async () => {
    const f = fixture(), r = await f.run({ diffAmount: 0, diffPayment: undefined });
    assert.equal(verifyAmounts(f, r, 711.11).payload.payments.length, 1);
  });
  await check('negative difference keeps credit remainder and balanced payment', async () => {
    const f = fixture(), r = await f.run({ diffAmount: -200, diffPayment: undefined });
    verifyAmounts(f, r, 511.11); assert.equal(r.valores.vale, 200); assert.equal(r.valores.diferenca, 0);
  });
  await check('three units split into cent-exact lines without changing quantity', async () => {
      const f = fixture(), r = await f.run({ diffAmount: 100.01, newItems: [{ barcode: 'TEST-BARCODE', size: '41', qty: 3 }] });
    const { sale } = verifyAmounts(f, r, 811.12); assert.equal(sale.items.reduce((n, i) => n + i.quantity, 0), 3); assert.equal(sale.items.length, 2);
  });
  await check('retry after cupom rejection preserves agreed prices and stock exactly once', async () => {
    const f = fixture({ failFirstCupom: true }), r1 = await f.run({ diffAmount: 100 });
    assert.equal(r1.step, 'cupom'); const stockBefore = clone(f.state.moves);
    f.state.products.find(p => p.id === 'new-product').price = 1499;
    const retry = { diffAmount: 100, devolucaoDocId: r1.devolucaoDocId, saleId: r1.saleId };
    const r2 = await f.run(retry); assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.valores.novos, 811.11); assert.deepEqual(f.state.moves, stockBefore);
    assert.equal(f.state.calls.filter(c => c.kind === 'return').length, 1);
    const before = clone(f.state), r3 = await f.run(retry); assert.equal(r3.alreadyEmitted, true); assert.deepEqual(f.state, before);
  });
  await check('changed agreement and unrelated sale IDs rejected on retry before mutations', async () => {
    const f = fixture({ failFirstCupom: true }), r1 = await f.run({ diffAmount: 100 }), before = clone(f.state);
    const retry = { diffAmount: 100, devolucaoDocId: r1.devolucaoDocId, saleId: r1.saleId };
    for (const change of [{ diffAmount: 101 }, { saleId: 'original-sale' }, { newItems: [{ barcode: 'TEST-BARCODE', qty: 2 }] }, { returned: [{ saleItemId: 'original-item', qty: 2 }] }]) {
      const r = await f.run({ ...retry, ...change }); assert.equal(r.status, 409, JSON.stringify(r)); assert.deepEqual(f.state, before);
    }
  });
  await check('malformed quantities, difference and unselected return rejected before fiscal side effects', async () => {
    for (const change of [{ returned: [] }, { returned: [{ saleItemId: 'original-item', qty: 0 }] }, { returned: [{ saleItemId: 'original-item', qty: 1 }, { saleItemId: 'original-item', qty: 1 }] }, { newItems: [{ barcode: 'TEST-BARCODE', qty: 1.5 }] }, { diffAmount: '100' }, { diffAmount: -800 }]) {
      const f = fixture(), before = clone(f.state), r = await f.run(change); assert.equal(r.status, 400, JSON.stringify(r)); assert.deepEqual(f.state, before);
    }
  });
  await check('cashier cannot use another store', async () => {
    const f = fixture(), before = clone(f.state), r = await f.run({}, { userRole: 'seller', authUser: { storeId: 'other-store', storeIds: [] } });
    assert.equal(r.status, 403); assert.deepEqual(f.state, before);
  });
  await check('duplicate NSU still rejected when supplied', async () => {
    const f = fixture(); f.state.docs.push({ id: 'other-cupom', issuerId: 'issuer', docType: 'NFCE', status: 'authorized', paymentAuthCode: 'NSU-USED', number: 9 });
    const before = clone(f.state), r = await f.run({ diffAmount: 100, diffPayment: { tPag: '03', cardAuthCode: 'NSU-USED' } });
    assert.equal(r.status, 409); assert.deepEqual(f.state, before);
  });
  await check('NSU retained on rejected-cupom retry without duplicate stock', async () => {
    const f = fixture({ failFirstCupom: true }), input = { diffAmount: 100, diffPayment: { tPag: '03', cardAuthCode: 'TEST-RETRY' } };
    const r1 = await f.run(input), before = clone(f.state.moves);
    const r2 = await f.run({ ...input, devolucaoDocId: r1.devolucaoDocId, saleId: r1.saleId });
    verifyAmounts(f, r2, 811.11, 'TEST-RETRY'); assert.deepEqual(f.state.moves, before);
  });
  await check('partial return retains original net unit value and residual cent', async () => {
    const f = fixture(), item = f.state.sales[0].items[0]; Object.assign(item, { quantity: 3, unitPrice: 10 / 3, totalPrice: 10 });
    f.state.docs.push({ id: 'previous-return', issuerId: 'issuer', docType: 'NFE', status: 'authorized', response: { troca: { originalDocId: 'original-doc', returned: [{ saleItemId: 'original-item', qty: 1 }] } } });
    const r = await f.run({ diffAmount: 10 }); assert.equal(r.ok, true); assert.equal(r.valores.devolvido, 3.34); assert.equal(r.valores.novos, 13.34);
    const returned = f.state.calls.find(c => c.kind === 'return').payload.items[0]; assert.equal(money(returned.qty * returned.unitPrice), 334);
  });
  await check('internal code requires exact selected size and preserves variant', async () => {
    const f = fixture(); f.state.products[0].internalBarcode = 'INTERNAL';
    f.state.sizes.push({ id: 'new-size-42', productId: 'new-product', size: '42', barcode: 'TEST-42', stock: 20 });
    const rejected = await f.run({ newItems: [{ barcode: 'INTERNAL', qty: 1 }] }); assert.equal(rejected.status, 400); assert.equal(rejected.needsSize, true); assert.equal(f.state.calls.length, 0);
    const r = await f.run({ diffAmount: 100, newItems: [{ barcode: 'INTERNAL', size: '42', qty: 1 }] });
    assert.equal(r.ok, true); assert.equal(f.state.sales.find(s => s.id === r.saleId).items[0].productSizeId, 'new-size-42');
  });
  await check('authorized cashier store scope succeeds', async () => {
    const f = fixture(), r = await f.run({ diffAmount: 100 }, { userRole: 'seller', authUser: { storeId: 'store', storeIds: [] } });
    verifyAmounts(f, r, 811.11);
  });
  await check('original sale in another store rejected even if issuer matches', async () => {
    const f = fixture(); f.state.sales[0].storeId = 'other-store'; const before = clone(f.state), r = await f.run({ diffAmount: 100 });
    assert.equal(r.status, 403); assert.deepEqual(f.state, before);
  });
  await check('return timeout preserves processing reservation and prevents second emission', async () => {
    const f = fixture({ returnTimeout: true }), r1 = await f.run({ diffAmount: 100 });
    assert.equal(r1.pendingConfirmation, true); assert.equal(r1.step, 'devolucao');
    assert.equal(f.state.docs.find(d => d.id === r1.documentId).status, 'processing'); assert.equal(f.state.moves.length, 0);
    const before = clone(f.state), r2 = await f.run({ diffAmount: 100 });
    assert.ok(r2.status >= 400); assert.deepEqual(f.state, before);
  });
  for (const mode of ['cupomTimeout', 'throwCupom']) await check(mode + ' preserves retry IDs, pending cupom and stock exactly once', async () => {
    const f = fixture({ [mode]: true }), r1 = await f.run({ diffAmount: 100 });
    assert.equal(r1.pendingConfirmation, true, JSON.stringify(r1)); assert.equal(r1.step, 'cupom'); assert.ok(r1.saleId); assert.ok(r1.devolucaoDocId);
    assert.equal(f.state.docs.find(d => d.id === r1.documentId).status, 'processing');
    const before = clone(f.state), r2 = await f.run({ diffAmount: 100, devolucaoDocId: r1.devolucaoDocId, saleId: r1.saleId });
    assert.equal(r2.status, 409); assert.deepEqual(f.state, before);
  });
  await check('exception during return keeps pending document ID and prevents second emission', async () => {
    const f = fixture({ throwReturn: true }), r1 = await f.run({ diffAmount: 100 });
    assert.equal(r1.status, 200); assert.equal(r1.pendingConfirmation, true); assert.equal(r1.step, 'devolucao');
    assert.ok(r1.documentId); assert.equal(r1.devolucaoDocId, undefined); assert.equal(r1.saleId, undefined);
    assert.equal(f.state.docs.find(d => d.id === r1.documentId).status, 'processing'); assert.equal(f.state.moves.length, 0);
    const before = clone(f.state), r2 = await f.run({ diffAmount: 100 }); assert.ok(r2.status >= 400); assert.deepEqual(f.state, before);
  });
  await check('retry changing cash to PIX synchronizes sale, fiscal document and payment', async () => {
    const f = fixture({ failFirstCupom: true }), r1 = await f.run({ diffAmount: 100, diffPayment: { tPag: '01' } });
    assert.equal(f.state.sales.find(s => s.id === r1.saleId).paymentMethod, 'cash'); const before = clone(f.state.moves);
    const r2 = await f.run({ diffAmount: 100, diffPayment: { tPag: '17' }, devolucaoDocId: r1.devolucaoDocId, saleId: r1.saleId });
    const result = verifyAmounts(f, r2, 811.11); assert.equal(result.sale.paymentMethod, 'pix'); assert.equal(result.cupom.paymentMethod, '17');
    assert.equal(result.payload.payments[1].tPag, '17'); assert.deepEqual(f.state.moves, before);
  });
  console.log('PASS all ' + passed + ' isolated exchange route cases; no network, real database or fiscal emission');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
