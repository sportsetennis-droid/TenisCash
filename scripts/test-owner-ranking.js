const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getRankingOwner } = require('../src/services/rankingOwner');
const { salesVisibility } = require('../src/services/salesVisibility');
const commission = require('../src/services/rankingCommission');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/seller.js'), 'utf8');
function section(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, 'Missing source: ' + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, 'Missing source end: ' + endMarker);
  return source.slice(start, end);
}
const route = section("router.get('/rankings'", '\n// =====================================================================');
const helpers = section('function recifeDayBounds(', 'function recifeMonthBounds(')
  + section('function summarizeToday(', '// =====================================================================');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-09-13T18:00:00Z'])); }
}
const stores = Array.from({ length: 6 }, (_, i) => ({ id: 'store-' + (i + 1), name: 'Loja ' + (i + 1), code: String(i + 1) }));
const ownerMarker = { value: JSON.stringify({ userId: 'owner', evidenceId: 'audited-owner-assignment' }) };

function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some(item => matches(row, item));
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('not' in value) return row[key] !== value.not;
      if ('gte' in value || 'lt' in value || 'lte' in value) {
        const date = new Date(row[key]);
        return (!value.gte || date >= value.gte) && (!value.lt || date < value.lt) && (!value.lte || date <= value.lte);
      }
      return matches(row[key], value);
    }
    return row[key] === value;
  });
}

async function run({ query = { period: 'today', storeId: 'all' }, role = 'admin', sales = [],
  clocks = [], marker = ownerMarker, ownerChanges = {} } = {}) {
  const owner = { id: 'owner', name: 'Douglas Bernardo Azevedo', role: 'superadmin', active: true,
    storeId: stores[0].id, storeIds: [], store: stores[0], ...ownerChanges };
  const ordinary = ['working', 'on-break', 'exited', 'absent'].map(id => ({
    id, name: id, role: 'seller', active: true, storeId: stores[0].id, storeIds: [], store: stores[0],
  }));
  const users = [owner, ...ordinary,
    { id: 'printbot', name: 'PrintBot', role: 'superadmin', active: true, storeId: null, storeIds: [], store: null },
    { id: 'second-admin', name: 'Outro administrador', role: 'superadmin', active: true, storeId: null, storeIds: [], store: null },
    { id: 'viewer', role, active: true, storeId: stores[0].id, storeIds: [], store: stores[0] },
  ];
  let handler, result, status = 200, clockQueries = 0;
  const prisma = {
    config: { findUnique: async ({ where }) => { assert.equal(where.key, 'repair-owner-access-20260910'); return marker; } },
    user: {
      findUnique: async ({ where }) => users.find(user => user.id === where.id) || null,
      findMany: async ({ where }) => users.filter(user => matches(user, where)),
    },
    store: {
      findUnique: async ({ where }) => stores.find(store => store.id === where.id) || null,
      findMany: async ({ where }) => stores.filter(store => matches(store, where)),
    },
    sale: {
      groupBy: async ({ where }) => {
        const groups = new Map();
        for (const sale of sales.filter(sale => matches(sale, where))) {
          if (!groups.has(sale.sellerId)) groups.set(sale.sellerId, {
            sellerId: sale.sellerId, _sum: { totalAmount: 0, tcEarned: 0, tcUsed: 0 }, _count: { _all: 0 },
          });
          const group = groups.get(sale.sellerId);
          group._sum.totalAmount += sale.totalAmount;
          group._sum.tcEarned += sale.tcEarned || 0;
          group._count._all++;
        }
        return [...groups.values()];
      },
      findMany: async ({ where }) => sales.filter(sale => matches(sale, where)),
    },
    clockIn: { findMany: async ({ where }) => {
      clockQueries++;
      assert.equal(where.user, undefined, 'Participation is historical, not filtered by current profile');
      return clocks.map(clock => ({ ...clock, user: users.find(user => user.id === clock.userId), store: stores[0] }))
        .filter(clock => matches(clock, where)).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } },
  };
  vm.runInNewContext(helpers + route, { prisma, getRankingOwner, salesVisibility, ...commission,
    console, Date: FixedDate, sellerOnly() {}, router: { get(_path, _middleware, fn) { handler = fn; } } });
  await handler({ userId: 'viewer', userRole: role, query }, {
    json(value) { result = value; }, status(value) { status = value; return this; },
  });
  return { status, result, clockQueries };
}

function sale(id, sellerId, amount, storeId = stores[0].id, date = '2026-09-13T14:00:00Z') {
  return { id, sellerId, totalAmount: amount, storeId, createdAt: new Date(date), status: 'completed', tcEarned: 0,
    items: [{ id: id + '-item', productName: 'Tênis teste', brand: 'Outra marca', category: 'calcado', quantity: 1, totalPrice: amount }] };
}
const clock = (userId, type, hour) => ({ userId, type, storeId: stores[0].id, timestamp: new Date('2026-09-13T' + hour + ':00:00Z') });
const present = [clock('working', 'entry', '12'), clock('on-break', 'entry', '12'),
  clock('on-break', 'break_start', '14'), clock('exited', 'entry', '12'), clock('exited', 'exit', '15')];

(async () => {
  // Every supported period and all six store filters show the identified owner
  // with zero sales; no clock-in or broad superadmin enumeration is required.
  for (const period of ['today', 'yesterday', 'month', 'last_month', 'custom']) {
    for (const storeId of ['all', ...stores.map(store => store.id)]) {
      const query = { period, storeId, ...(period === 'custom' ? { from: '2026-09-01', to: '2026-09-13' } : {}) };
      const { status, result, clockQueries } = await run({ query });
      assert.equal(status, 200, JSON.stringify(result));
      assert.deepEqual(Array.from(result.ranking, row => row.sellerId), ['owner'], period + '/' + storeId);
      const row = result.ranking[0];
      assert.equal(row.salesAmount, 0);
      assert.equal(row.salesCount, 0);
      assert.equal(row.commissionAmount, 0);
      assert.equal(row.position, 1);
      assert.equal(row.store.id, storeId === 'all' ? stores[0].id : storeId);
      assert.equal(result.totals.salesAmount, 0);
      assert.equal(result.totals.salesCount, 0);
      assert.equal(clockQueries, period === 'today' ? 1 : 0);
    }
  }

  const actualSales = [sale('owner-a', 'owner', 1000), sale('owner-b', 'owner', 500, stores[1].id),
    sale('worker', 'working', 100), sale('break', 'on-break', 200), sale('left', 'exited', 300), sale('absent', 'absent', 400),
    { ...sale('canceled', 'owner', 9000), status: 'canceled' }];
  for (const period of ['today', 'month']) {
    const { result } = await run({ query: { period, storeId: 'all' }, sales: actualSales, clocks: present });
    const owners = result.ranking.filter(row => row.sellerId === 'owner');
    assert.equal(owners.length, 1);
    assert.equal(owners[0].position, 1);
    assert.equal(owners[0].salesAmount, 1500);
    assert.equal(owners[0].salesCount, 2);
    assert.equal(owners[0].commission.baseAmount, 15);
    assert.equal(owners[0].commission.at50kAmount, 30);
    assert.equal(owners[0].commissionAmount, 15);
    assert.equal(result.totals.salesAmount, 2500);
    assert.equal(result.totals.salesCount, 6);
    assert.ok(result.ranking.some(row => row.sellerId === 'working'));
    assert.ok(result.ranking.some(row => row.sellerId === 'on-break'));
    if (period === 'today') {
      assert.equal(result.ranking.some(row => row.sellerId === 'exited'), true);
      assert.equal(result.ranking.some(row => row.sellerId === 'absent'), true);
    }
    assert.equal(result.ranking.some(row => ['printbot', 'second-admin'].includes(row.sellerId)), false);
  }
  const selected = (await run({ query: { period: 'today', storeId: stores[1].id }, sales: actualSales, clocks: present })).result;
  assert.equal(selected.ranking[0].sellerId, 'owner');
  assert.equal(selected.ranking[0].salesAmount, 500);
  assert.equal(selected.ranking[0].commissionAmount, 5);
  assert.equal(selected.ranking[0].store.id, stores[1].id);
  const ownerExited = (await run({ sales: actualSales, clocks: [...present, clock('owner', 'entry', '12'), clock('owner', 'exit', '16')] })).result;
  assert.ok(ownerExited.ranking.some(row => row.sellerId === 'owner'));

  for (const role of ['seller', 'store', 'manager']) {
    const { result } = await run({ role, sales: actualSales, clocks: present });
    assert.ok(result.ranking.some(row => row.sellerId === 'owner'));
    assert.equal(result.canViewRevenueTotals, false);
    assert.equal(result.totals.salesAmount, null);
    assert.equal(result.totals.cashbackGiven, null);
    assert.equal(result.totals.commissionAmount, null);
  }
  assert.equal((await run({ role: 'seller', query: { period: 'today', storeId: stores[1].id } })).status, 403);
  assert.equal((await run({ role: 'seller', query: { period: 'today', storeId: stores[0].id } })).result.canViewRevenueTotals, true);

  for (const marker of [null, { value: '{invalid' }, { value: 'null' }, { value: '{}' },
    { value: JSON.stringify({ userId: '', evidenceId: 'audit' }) },
    { value: JSON.stringify({ userId: ' ', evidenceId: 'audit' }) },
    { value: JSON.stringify({ userId: 7, evidenceId: 'audit' }) },
    { value: JSON.stringify({ userId: 'owner' }) },
    { value: JSON.stringify({ userId: 'owner', evidenceId: '' }) },
    { value: JSON.stringify({ userId: 'owner', evidenceId: ' ' }) },
    { value: JSON.stringify({ userId: 'owner', evidenceId: 7 }) },
    { value: JSON.stringify({ userId: 'missing', evidenceId: 'audit' }) }]) {
    const { status, result } = await run({ marker });
    assert.equal(status, 200, JSON.stringify(marker));
    assert.equal(result.ranking.length, 0, JSON.stringify(marker));
  }
  for (const ownerChanges of [{ active: false }, { role: 'seller' }, { role: 'admin' }]) {
    const { result } = await run({ ownerChanges });
    assert.equal(result.ranking.length, 0);
  }
  const renamed = (await run({ ownerChanges: { name: 'Nome atualizado do titular' } })).result;
  assert.equal(renamed.ranking[0].sellerId, 'owner');
  assert.equal(renamed.ranking[0].name, 'Nome atualizado do titular');
  console.log('PASS: canonical owner in all periods/six stores, real sales and commissions, attendance isolation, privacy and invalid owner markers');
})().catch(error => { console.error(error); process.exitCode = 1; });
