const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { salesVisibility } = require('../src/services/salesVisibility');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/seller.js'), 'utf8');
const listStart = source.indexOf("router.get('/store-sellers'");
const listEnd = source.indexOf('\n// =====================================================================', listStart);
const saleStart = source.indexOf("router.post('/sale'");
const saleEnd = source.indexOf('    // Busca produtos pra montar SaleItems', saleStart);
assert.ok(listStart >= 0 && listEnd > listStart && saleStart >= 0 && saleEnd > saleStart);
const listRoute = source.slice(listStart, listEnd);
// Execute the real authentication/assignment checks only. No products, stock,
// payments, commissions or sales are read or written by this test.
const saleValidation = source.slice(saleStart, saleEnd) + `
    return res.json({ validated: true, sellerId, activeStoreId });
  } catch (error) { return res.status(500).json({ error: error.message }); }
});`;

const stores = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, name: 'Loja ' + id, active: true }));
const users = [
  { id: 'owner', name: 'Douglas', role: 'superadmin', active: true, storeId: null, storeIds: [] },
  { id: 'inactive-owner', name: 'Dono inativo', role: 'superadmin', active: false, storeId: null, storeIds: [] },
  { id: 'seller-a', name: 'Ana', role: 'seller', active: true, storeId: 'a', storeIds: ['b'] },
  { id: 'seller-b', name: 'Bruno', role: 'seller', active: true, storeId: 'b', storeIds: [] },
  { id: 'seller-f', name: 'Felipe', role: 'seller', active: true, storeId: 'f', storeIds: [] },
  { id: 'unassigned', name: 'Sem loja', role: 'seller', active: true, storeId: null, storeIds: [] },
  { id: 'inactive-seller', name: 'Inativo', role: 'seller', active: false, storeId: 'a', storeIds: [] },
  { id: 'admin', name: 'Administrador', role: 'admin', active: true, storeId: 'a', storeIds: [] },
  { id: 'customer', name: 'Cliente', role: 'user', active: true, storeId: 'a', storeIds: [] },
  ...stores.map(store => ({ id: 'cashier-' + store.id, name: 'Caixa ' + store.id,
    role: 'store', active: true, storeId: store.id, storeIds: [] })),
];

function matches(row, where) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some(condition => matches(row, condition));
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(condition => matches(row, condition));
    if (expected !== null && typeof expected === 'object') {
      if ('has' in expected) return (row[key] || []).includes(expected.has);
      if ('in' in expected) return expected.in.includes(row[key]);
      throw new Error('Unsupported fixture query: ' + key);
    }
    return row[key] === expected;
  });
}

async function run(route, operatorId, query = {}, body = {}) {
  let handler, result, status = 200, listQueries = 0;
  const operator = users.find(user => user.id === operatorId);
  const prisma = {
    user: {
      findUnique: async ({ where }) => users.find(user => user.id === where.id) || null,
      findMany: async ({ where }) => {
        listQueries++;
        return users.filter(user => matches(user, where)).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
    store: { findUnique: async ({ where }) => stores.find(store => store.id === where.id) || null },
  };
  vm.runInNewContext(route, { prisma, salesVisibility, console, _recentSaleKeys: new Map(),
    authMiddleware() {}, sellerOnly() {},
    router: {
      get(...args) { handler = args.at(-1); },
      post(...args) { handler = args.at(-1); },
    },
  });
  await handler({ userId: operatorId, userRole: operator?.role, query, body,
    scope: { isStoreLocked: operator?.role === 'store', storeId: operator?.storeId || null } }, {
    status(code) { status = code; return this; },
    json(value) { result = value; },
  });
  return { status, result, listQueries };
}

const list = (operatorId, storeId, purpose) => run(listRoute, operatorId, { storeId, ...(purpose ? { purpose } : {}) });
const validateSale = (operatorId, vendorId, storeId) => run(saleValidation, operatorId, {}, {
  items: [{ productId: 'not-loaded', quantity: 1 }], vendorId, storeId,
});
const ids = response => Array.from(response.result.sellers, user => user.id);

(async () => {
  for (const store of stores) {
    for (const operatorId of ['owner', 'cashier-' + store.id]) {
      const response = await list(operatorId, store.id, 'sale');
      assert.equal(response.status, 200);
      const expected = users.filter(user => user.active && (user.role === 'superadmin'
        || (user.role === 'seller' && (user.storeId === store.id || user.storeIds.includes(store.id)))));
      assert.deepEqual(ids(response).sort(), expected.map(user => user.id).sort());
      const sale = await validateSale(operatorId, 'owner', store.id);
      assert.equal(sale.status, 200, JSON.stringify(sale.result));
      assert.equal(sale.result.validated, true);
      assert.equal(sale.result.sellerId, 'owner');
      assert.equal(sale.result.activeStoreId, store.id);
    }
  }
  assert.deepEqual(ids(await list('owner', 'a')).sort(), ['seller-a']);
  assert.deepEqual(ids(await list('owner', 'b')).sort(), ['seller-a', 'seller-b']);
  assert.deepEqual(ids(await list('cashier-a', 'a')).sort(), ['seller-a']);
  assert.ok(ids(await list('seller-a', 'a', 'sale')).includes('owner'));
  assert.ok(ids(await list('seller-a', 'b', 'sale')).includes('owner'));
  for (const [operatorId, storeId] of [['seller-a', 'c'], ['cashier-a', 'b'], ['inactive-owner', 'a'], ['inactive-seller', 'a'], ['customer', 'a']]) {
    const response = await list(operatorId, storeId, 'sale');
    assert.equal(response.status, 403, operatorId + '/' + storeId);
    assert.equal(response.listQueries, 0);
  }

  // The institutional account remains tied to its own store even when a caller
  // sends another store ID and selects the owner.
  const locked = await validateSale('cashier-a', 'owner', 'f');
  assert.equal(locked.status, 200);
  assert.equal(locked.result.activeStoreId, 'a');
  const additional = await validateSale('cashier-b', 'seller-a', 'b');
  assert.equal(additional.status, 200, JSON.stringify(additional.result));
  assert.equal(additional.result.activeStoreId, 'b');
  for (const vendorId of ['seller-f', 'unassigned']) {
    const response = await validateSale('cashier-a', vendorId, 'a');
    assert.equal(response.status, 403, vendorId);
    assert.notEqual(response.result.validated, true);
  }
  for (const vendorId of ['inactive-owner', 'inactive-seller', 'customer', 'unknown']) {
    const response = await validateSale('cashier-a', vendorId, 'a');
    assert.equal(response.status, 400, vendorId);
    assert.notEqual(response.result.validated, true);
  }

  const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
  const section = (startMarker, endMarker) => {
    const start = html.indexOf(startMarker);
    assert.ok(start > 0, 'Missing frontend function: ' + startMarker);
    const end = html.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, 'Missing end of frontend function: ' + endMarker);
    return html.slice(start, end);
  };
  const vendors = section('async function loadVendors()', 'function selectVendor(');
  const salesVendors = section('async function loadSalesVendors()', 'function setSalesRange(');
  const clock = section('async function loadClockin()', 'async function onClockVendorChange()');
  assert.match(vendors, /\/api\/seller\/store-sellers[^\n]+purpose=sale/);
  assert.match(salesVendors, /\/api\/seller\/store-sellers[^\n]+purpose=sale/);
  assert.match(clock, /api\('\/api\/seller\/store-sellers\?storeId='\s*\+\s*activeStore\.id\)/);
  assert.match(clock, /getElementById\('clockVendor'\)/);
  assert.doesNotMatch(clock, /purpose=sale/);
  assert.equal(users.find(user => user.id === 'owner').role, 'superadmin');
  console.log('PASS: owner selectable/sale-eligible in six stores, purpose isolation, store locks, additional assignments and rejected accounts; no sale written');
})().catch(error => { console.error(error); process.exitCode = 1; });
