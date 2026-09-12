const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { salesVisibility } = require('../src/services/salesVisibility');
const source = fs.readFileSync('src/routes/seller.js', 'utf8');
const routeStart = source.indexOf("router.get('/dashboard'");
const route = source.slice(routeStart, source.indexOf('\n// =====================================================================', routeStart));
const dayStart = new Date('2026-09-11T03:00:00Z');
const dayEnd = new Date('2026-09-12T03:00:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-11T18:00:00Z'])); }
}
const sales = [
  { storeId: 'a', sellerId: 'someone', status: 'completed', totalAmount: 100, createdAt: dayStart },
  { storeId: 'b', sellerId: 'other', status: 'completed', totalAmount: 200, createdAt: new Date('2026-09-12T02:59:59Z') },
  { storeId: 'a', sellerId: 'u', status: 'canceled', totalAmount: 900, createdAt: dayStart },
  { storeId: 'a', sellerId: 'u', status: 'completed', totalAmount: 800, createdAt: dayEnd },
  { storeId: 'a', sellerId: 'u', status: 'completed', totalAmount: 700, createdAt: new Date(dayStart.getTime() - 1) },
  { storeId: 'b', sellerId: 'u', status: 'completed', totalAmount: 5000, createdAt: new Date('2026-08-15T15:00:00Z') },
];
async function run(role, storeId, overrides = {}) {
  const user = { id: 'u', role, active: true, storeId: 'a', storeIds: ['a', 'b'], ...overrides };
  let handler, result, status = 200, aggregateCalls = 0;
  const prisma = {
    user: { findUnique: async () => user },
    sale: {
      groupBy: async () => [],
      aggregate: async ({ where }) => {
        aggregateCalls++;
        const rows = sales.filter(s => (!where.storeId || s.storeId === where.storeId)
          && (!where.sellerId || s.sellerId === where.sellerId) && s.status !== where.status.not
          && s.createdAt >= where.createdAt.gte && (!where.createdAt.lt || s.createdAt < where.createdAt.lt));
        return { _count: { _all: rows.length }, _sum: { totalAmount: rows.reduce((sum, s) => sum + s.totalAmount, 0), tcEarned: 0 } };
      },
    },
  };
  vm.runInNewContext(route, { prisma, salesVisibility, console, Date: FixedDate, sellerOnly() {},
    recifeDayBounds: () => ({ startUtc: dayStart, endUtc: dayEnd }),
    router: { get(_path, _middleware, fn) { handler = fn; } } });
  await handler({ userId: 'u', query: storeId === undefined ? {} : { storeId } }, {
    status(code) { status = code; return this; }, json(data) { result = data; },
  });
  return { status, result, aggregateCalls };
}
(async () => {
  for (const role of ['admin', 'superadmin']) {
    const { result } = await run(role, 'a');
    assert.equal(result.scope, 'all');
    assert.equal(result.today.salesAmount, 300);
    assert.equal(result.today.salesCount, 2);
    assert.equal(result.month.salesAmount, 1800);
    assert.equal(result.month.salesCount, 4);
    assert.equal(result.dailyStoreTotal.scope, 'all');
    assert.equal(result.dailyStoreTotal.salesAmount, 300);
    assert.equal(result.dailyStoreTotal.salesCount, 2);
  }
  for (const role of ['seller', 'store', 'manager']) {
    const { result } = await run(role, 'a');
    assert.equal(result.dailyStoreTotal.scope, 'store');
    assert.equal(result.dailyStoreTotal.salesAmount, 100);
  }
  assert.equal((await run('seller', 'b')).result.dailyStoreTotal.salesAmount, 200);
  assert.equal((await run('seller')).result.dailyStoreTotal.salesAmount, 100);
  for (const selectedStoreId of ['a', 'b']) {
    const { result } = await run('seller', selectedStoreId);
    assert.equal(result.scope, 'seller');
    assert.equal(result.today.salesAmount, 0);
    assert.equal(result.today.salesCount, 0);
    assert.equal(result.month.salesAmount, 1500);
    assert.equal(result.month.salesCount, 2);
  }
  for (const [role, storeId, overrides] of [
    ['seller', 'foreign', {}], ['seller', 'all', {}], ['store', 'b', {}],
    ['seller', 'a', { active: false }], ['seller', undefined, { storeId: null, storeIds: [] }],
  ]) {
    const response = await run(role, storeId, overrides);
    assert.equal(response.status, 403);
    assert.equal(response.aggregateCalls, 0);
  }
  console.log('PASS: daily/monthly admin totals, personal seller KPIs, assigned stores, canceled sales, day boundaries and denied access');
})().catch(error => { console.error(error); process.exitCode = 1; });
