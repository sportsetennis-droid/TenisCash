const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalSalePrice } = require('../src/services/discountPolicy');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/fiscal.js'), 'utf8');
const start = source.indexOf("router.post('/troca',");
const end = source.indexOf('\n// ============================================================', start);
assert.ok(start >= 0 && end > start);
const route = source.slice(start, end);
const round = value => Math.round(Number(value) * 100) / 100;

function fixture() {
  const original = { id: 'original-sale', storeId: 'store', items: [
    { id: 'returned-item', productId: 'old-product', productName: 'Produto antigo', quantity: 2, unitPrice: 70, totalPrice: 140 },
  ] };
  const originalDoc = { id: 'original-doc', issuerId: 'issuer', docType: 'NFCE', status: 'authorized', accessKey: 'original-key', saleId: original.id };
  const devDoc = { id: 'return-doc', issuerId: 'issuer', docType: 'NFE', status: 'authorized', totalValue: 140,
    response: { troca: { originalDocId: originalDoc.id, originalSaleId: original.id, returned: [{ saleItemId: 'returned-item', qty: 2 }] } } };
  const saved = { id: 'exchange-sale', storeId: 'store', status: 'completed', totalAmount: 60,
    items: [{ id: 'new-item', productId: 'product', productSizeId: 'size', productName: 'Nome histórico', brand: 'MARCA', size: '40', quantity: 1, unitPrice: 60, totalPrice: 60 }],
    stockMovements: [{ storeId: 'store', saleId: 'exchange-sale', saleItemId: 'new-item', productSizeId: 'size', type: 'exchange_sale', source: 'fiscal_exchange_api', quantity: -1,
      metadata: { originalSaleId: original.id, originalDocId: originalDoc.id } }],
  };
  return { original, originalDoc, devDoc, saved, product: { id: 'product', name: 'Nome atual', brand: 'MARCA', price: 100, promoPrice: 70, sku: 'SKU', ncm: '64041100' },
    body: { storeId: 'store', originalDocId: 'original-doc', devolucaoDocId: 'return-doc', saleId: 'exchange-sale',
      returned: [{ saleItemId: 'returned-item', qty: 2 }], newItems: [{ barcode: 'BARCODE', qty: 1 }] } };
}

async function run(f) {
  const snapshot = JSON.stringify(f);
  const effects = [];
  let handler, status = 200, response, emitted;
  const forbidden = name => async () => { effects.push(name); throw new Error('Unexpected side effect: ' + name); };
  const prisma = {
    store: { findUnique: async () => ({ id: 'store', fiscalAgentEnabled: true, fiscalAgentUrl: 'fixture-only', fiscalIssuer: { id: 'issuer', active: true } }) },
    sale: { findUnique: async ({ where }) => where.id === 'original-sale' ? f.original : f.saved,
      create: forbidden('sale.create'), update: forbidden('sale.update') },
    productSize: { findFirst: async () => ({ id: 'size', size: '40', product: f.product }) },
    product: { findUnique: async () => null },
    fiscalDocument: {
      findUnique: async ({ where }) => where.id === 'original-doc' ? f.originalDoc : f.devDoc,
      findMany: async () => [f.devDoc].filter(Boolean), findFirst: async () => null,
      aggregate: async () => ({ _max: { number: 1 } }),
      create: async ({ data }) => { effects.push({ createDocument: data }); return { id: 'retry-coupon', ...data }; },
      update: async ({ where, data }) => { effects.push({ updateDocument: data }); return { ...where, ...data }; },
    },
    fiscalIssuer: { update: async () => { effects.push('issuer.sequence'); } },
    $transaction: forbidden('sale-or-stock-transaction'),
  };
  vm.runInNewContext(route, {
    prisma, normalSalePrice, r2: round, TPAG_TO_SALEPAY: { '01': 'cash' },
    console: { log() {}, error() {} },
    applyStoreStockDelta: forbidden('stock.delta'),
    require(name) {
      assert.equal(name, '../services/fiscalAgentClient');
      return { emitNFe55: forbidden('duplicate-return'), emitNFCe: async (_store, payload) => {
        emitted = payload; effects.push('emit-coupon');
        return { ok: true, status: '100', accessKey: 'fixture-key', protocol: 'fixture-protocol' };
      } };
    },
    router: { post(_path, fn) { handler = fn; } },
  });
  await handler({ body: f.body, userId: 'operator' }, {
    status(value) { status = value; return this; }, json(value) { response = value; return this; },
  });
  assert.equal(JSON.stringify(f), snapshot, 'Historical sale, return and product records must remain unchanged');
  return { status, response, effects, emitted };
}

(async () => {
  // Actual retry route with every fiscal/DB effect mocked: stored prices win,
  // including if the current regular price is missing or has changed.
  for (const price of [100, 999, null]) {
    const f = fixture(); f.product.price = price;
    const result = await run(f);
    assert.equal(result.status, 200, JSON.stringify(result.response));
    assert.equal(result.response.ok, true);
    assert.equal(result.response.valores.novos, 60);
    assert.equal(result.response.valores.devolvido, 140);
    assert.equal(result.response.valores.vale, 80);
    assert.equal(result.emitted.items[0].unitPrice, 60);
    assert.equal(result.emitted.items[0].name, 'Nome histórico');
    assert.equal(result.emitted.payments[0].valor, 60);
    assert.equal(result.effects.find(effect => effect.createDocument).createDocument.totalValue, 60);
    assert.equal(result.effects.find(effect => effect.createDocument).createDocument.saleId, 'exchange-sale');
    assert.equal(result.effects.filter(effect => effect === 'emit-coupon').length, 1);
    assert.equal(result.effects.length, 4, 'Only mocked new coupon + issuer sequence; no sale, return or stock mutation');
  }
  const rejected = [
    ['missing sale', f => { f.saved = null; }],
    ['other store', f => { f.saved.storeId = 'other'; }],
    ['uncompleted sale', f => { f.saved.status = 'pending_payment'; }],
    ['non-exchange sale', f => { f.saved.stockMovements = []; }],
    ['wrong source document', f => { f.saved.stockMovements[0].metadata.originalDocId = 'other'; }],
    ['wrong return document', f => { f.saved.stockMovements[0].metadata.devolucaoDocId = 'other'; }],
    ['wrong original sale', f => { f.saved.stockMovements[0].metadata.originalSaleId = 'other'; }],
    ['wrong stock quantity', f => { f.saved.stockMovements[0].quantity = -2; }],
    ['missing return document', f => { f.devDoc = null; }],
    ['wrong return store', f => { f.devDoc.issuerId = 'other'; }],
    ['unauthorized return', f => { f.devDoc.status = 'rejected'; }],
    ['wrong return link', f => { f.devDoc.response.troca.originalDocId = 'other'; }],
    ['changed returned quantity', f => { f.body.returned[0].qty = 1; }],
    ['changed new quantity', f => { f.body.newItems[0].qty = 2; }],
    ['changed new product', f => { f.saved.items[0].productId = 'other'; }],
    ['changed new size', f => { f.saved.items[0].productSizeId = 'other'; f.saved.stockMovements[0].productSizeId = 'other'; }],
    ['inconsistent historical total', f => { f.saved.totalAmount = 70; }],
    ['inconsistent historical item', f => { f.saved.items[0].totalPrice = 70; }],
  ];
  for (const [label, mutate] of rejected) {
    const f = fixture(); mutate(f);
    const result = await run(f);
    assert.equal(result.status, 409, label + ': ' + JSON.stringify(result.response));
    assert.deepEqual(result.effects, [], label + ': reject before effects');
  }
  console.log('PASS: actual exchange retry preserves stored item/total prices and rejects mismatched links, products and quantities before mocked fiscal or stock effects');
})().catch(error => { console.error(error); process.exitCode = 1; });
