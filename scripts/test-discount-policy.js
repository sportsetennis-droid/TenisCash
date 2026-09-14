const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/services/discountPolicy');
const { SaleStockError, planSaleProductSize } = require('../src/services/storeStockLedger');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sellerSource = read('src/routes/seller.js');
const fiscalSource = read('src/routes/fiscal.js');
const catalogSource = read('src/routes/adminCatalog.js');
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, startMarker);
  return source.slice(start, end);
}
const finishValidation = value => `return res.json(${value}); } catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); } });`;
const saleValidation = slice(sellerSource, "router.post('/sale'", '    // Transação atômica:')
  + finishValidation('{ totalAmount, discountApplied, originalSubtotal, saleItems: saleItemsData, tcConsumed, tcEarned }');
const sizeHelper = slice(sellerSource, 'function normalizeSellerReportedSize(', 'const commissionEvidenceUpload');
const exchangeValidation = slice(fiscalSource, "router.post('/troca'", '    // SEFAZ-PB:')
  + finishValidation('{ returnedTotal, newTotal, diff, credit, vale, newResolved }');

async function execute(source, prisma, body, extras = {}, method = 'post') {
  let handler, status = 200, result;
  vm.runInNewContext(source, {
    ...policy, ...extras, prisma, SaleStockError, planSaleProductSize,
    console: { log() {}, error() {} }, _recentSaleKeys: extras._recentSaleKeys || new Map(),
    authMiddleware() {}, sellerOnly() {}, adminOnly() {},
    parseJsonSafe: value => typeof value === 'string' ? JSON.parse(value) : value,
    router: { [method](url, ...handlers) { handler = handlers.at(-1); } },
  });
  await handler({ userId: 'owner', userRole: 'superadmin', params: { id: 'product' }, body, scope: {} }, {
    status(code) { status = code; return this; }, json(value) { result = value; return this; },
  });
  return { status, result };
}

const product = { id: 'product', name: 'Tênis normal', price: 100, promoPrice: 70, brand: 'EVERLAST',
  category: 'tenis', costPrice: 45, sizes: [{ id: 'size', size: '40', sizeConfirmedAt: new Date() }] };
const saleBody = { storeId: 'store', vendorId: 'owner', paymentMethod: 'cash',
  items: [{ productId: 'product', productSizeId: 'size', sellerSize: '40', size: '40', quantity: 2 }] };
function readonlyPrisma(overrides = {}) {
  const writes = [];
  const forbidden = name => () => { writes.push(name); throw new Error('Unexpected side effect: ' + name); };
  const prisma = {
    user: { findUnique: async ({ where }) => where.phone
      ? { id: 'customer', balance: 20 } : { id: 'owner', active: true, role: 'superadmin', storeId: 'store' }, update: forbidden('user.update') },
    store: { findUnique: async () => ({ id: 'store', active: true }) },
    product: { findMany: async () => [structuredClone(product)], create: forbidden('product.create'), update: forbidden('product.update') },
    sale: { findUnique: async () => null, create: forbidden('sale.create') },
    $transaction: forbidden('$transaction'),
    ...overrides,
  };
  return { prisma, writes };
}
async function sale(body = saleBody, products = [product]) {
  const db = readonlyPrisma({ product: { findMany: async () => structuredClone(products) } });
  const response = await execute(sizeHelper + saleValidation, db.prisma, body);
  assert.deepEqual(db.writes, []);
  return response;
}

(async () => {
  assert.equal(policy.DISCOUNTS_ENABLED, false);
  for (const value of [undefined, null, '', 0, '0', '0.00']) assert.doesNotThrow(() => policy.assertNoSaleDiscount(value));
  for (const value of [1, 0.001, -1, NaN, Infinity, 'NaN', '0bad', {}, [], true]) {
    assert.throws(() => policy.assertNoSaleDiscount(value), error => error.statusCode === 409);
    const response = await sale({ ...saleBody, discount: value });
    assert.equal(response.status, 409, 'Reject manual discount: ' + String(value));
  }
  for (const value of [0, -1, NaN, Infinity, null, undefined, '', {}, true]) {
    assert.throws(() => policy.normalSalePrice({ ...product, price: value }), error => error.statusCode === 409);
  }
  for (const value of [70, 99.99, 0, -1, 'bad', NaN, {}, '']) {
    const response = await sale({ ...saleBody, items: [{ ...saleBody.items[0], unitPrice: value }] });
    assert.equal(response.status, 409, 'Reject stale or invalid unit price: ' + String(value));
  }
  for (const requested of [undefined, null, 100, '100.00', 150]) {
    const response = await sale({ ...saleBody, items: [{ ...saleBody.items[0], unitPrice: requested }] });
    assert.equal(response.status, 200, JSON.stringify(response.result));
    assert.equal(response.result.totalAmount, 200);
    assert.equal(response.result.discountApplied, 0);
    assert.equal(response.result.saleItems[0].unitPrice, 100);
    assert.equal(response.result.saleItems[0].totalPrice, 200);
  }
  assert.equal((await sale(saleBody, [{ ...product, price: null, promoPrice: 70 }])).status, 409,
    'A promotion must not substitute an unknown normal price');
  const fractional = await sale({ ...saleBody, items: [{ ...saleBody.items[0], quantity: 3 }] }, [{ ...product, price: 0.1, promoPrice: 0.01 }]);
  assert.equal(fractional.result.totalAmount, 0.3);
  // Stored sales returned by the existing idempotency mechanism are historical;
  // do not turn a retry into a new, full-price charge.
  const historyDb = readonlyPrisma({ sale: { findUnique: async () => ({ id: 'historic-sale', totalAmount: 70, tcEarned: 70 }) } });
  const duplicate = await execute(sizeHelper + saleValidation, historyDb.prisma,
    { ...saleBody, idemKey: 'already-saved', discount: 30 },
    { _recentSaleKeys: new Map([['already-saved', { at: Date.now(), saleId: 'historic-sale' }]]) });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.result.duplicate, true);
  assert.equal(duplicate.result.totalAmount, 70);
  assert.deepEqual(historyDb.writes, []);
  // TenisCash balance redemption is intentionally unchanged until separately decided.
  const withBalance = await sale({ ...saleBody, customerPhone: 'fixture', tcUsed: 10 });
  assert.equal(withBalance.result.tcConsumed, 10);
  assert.equal(withBalance.result.tcEarned, 190);

  // Validate the actual admin creation/edit gates before any catalogue/stock write.
  const create = slice(catalogSource, "router.post('/products',", '    const sku =') + finishValidation('{ validated: true }');
  const edit = slice(catalogSource, "router.put('/products/:id',", '    const existing =') + finishValidation('{ validated: true }');
  for (const [method, route] of [['post', create], ['put', edit]]) {
    for (const payload of [{ promoPrice: 70 }, { promoPrice: 'invalid' }, { promoPrice: Infinity },
      { aiContext: { paymentOffer: { active: true, finalPrice: 70 } } },
      { aiContext: JSON.stringify({ paymentOffer: { active: true, finalPrice: 70 } }) },
      { paymentOffer: { active: true } }]) {
      const db = readonlyPrisma();
      const response = await execute(route, db.prisma, payload, {}, method);
      assert.equal(response.status, 409, method + JSON.stringify(payload));
      assert.deepEqual(db.writes, []);
    }
    for (const payload of [{}, { promoPrice: null }, { promoPrice: 0 },
      { aiContext: { classification: { keep: true }, paymentOffer: { active: false } } }]) {
      const response = await execute(route, readonlyPrisma().prisma, payload, {}, method);
      assert.equal(response.status, 200);
      assert.equal(response.result.validated, true);
    }
  }

  // An exchange credits exactly what the old sale charged, but prices only its
  // newly selected product at today's regular catalogue price.
  const originalSale = { id: 'historic', items: [{ id: 'old-item', productId: 'old-product', quantity: 2, unitPrice: 70 }] };
  const originalSnapshot = structuredClone(originalSale);
  const exchangeDb = readonlyPrisma({
    store: { findUnique: async () => ({ id: 'store', fiscalAgentEnabled: true, fiscalAgentUrl: 'not-called', fiscalIssuer: { id: 'issuer', active: true } }) },
    fiscalDocument: { findUnique: async () => ({ id: 'old-doc', docType: 'NFCE', status: 'authorized', accessKey: 'old-key', issuerId: 'issuer', saleId: 'historic' }), findMany: async () => [] },
    sale: { findUnique: async () => originalSale },
    productSize: { findFirst: async () => ({ id: 'size', size: '40', product }) },
  });
  const exchange = await execute(exchangeValidation, exchangeDb.prisma, {
    storeId: 'store', originalDocId: 'old-doc', returned: [{ saleItemId: 'old-item', qty: 2 }], newItems: [{ barcode: 'fixture', qty: 1 }],
  }, { r2: value => Math.round(Number(value) * 100) / 100 });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.result));
  assert.equal(exchange.result.returnedTotal, 140);
  assert.equal(exchange.result.newTotal, 100);
  assert.equal(exchange.result.vale, 40);
  assert.deepEqual(originalSale, originalSnapshot);
  assert.deepEqual(exchangeDb.writes, []);
  console.log('PASS: no-discount policy; actual sale/admin/exchange validation rejects stale discounts before writes, canonical prices and historical values preserved; no payment/fiscal side effect');
})().catch(error => { console.error(error); process.exitCode = 1; });
