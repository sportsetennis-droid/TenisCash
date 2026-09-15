const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/seller.js'), 'utf8');
const dayBounds = source.slice(source.indexOf('function recifeDayBounds('), source.indexOf('function recifeMonthBounds('));
const routeStart = source.indexOf("router.get('/rankings'");
const route = source.slice(routeStart, source.indexOf('\n// =====================================================================', routeStart));
const stores = ['a', 'b'].map(id => ({ id, name: 'Loja ' + id.toUpperCase(), code: id.toUpperCase() }));
const ids = ['working', 'finished', 'break', 'zero', 'transferred', 'without-clock', 'moved', 'other',
  'exit-only', 'break-only', 'old-only', 'future-only', 'next-day', 'cancel-only', 'invalid', 'tie-a', 'tie-b', 'none', 'no-store'];
const users = ids.map(id => ({ id, name: id.startsWith('tie-') ? 'Mesmo nome' : 'Vendedor ' + id,
  role: 'seller', active: true, storeId: 'a', storeIds: ['a'], store: stores[0] }));
for (const id of ['transferred', 'without-clock', 'exit-only']) Object.assign(users.find(user => user.id === id), {
  role: 'customer', active: false, storeId: 'b', storeIds: ['b'], store: stores[1],
});
const clock = (userId, type, storeId = 'a', timestamp = '2026-09-15T12:00:00Z') => ({ userId, type, storeId,
  timestamp: new Date(timestamp), store: stores.find(store => store.id === storeId) });
const points = [
  ...['working', 'finished', 'break', 'zero', 'transferred', 'moved', 'tie-a', 'tie-b'].map(id => clock(id, 'entry')),
  clock('finished', 'exit'), clock('transferred', 'exit'), clock('break', 'break_start'),
  clock('moved', 'break_start'), clock('moved', 'break_end', 'b'), clock('moved', 'exit', 'b'),
  clock('other', 'entry', 'b'), clock('exit-only', 'exit'), clock('break-only', 'break_end'),
  clock('old-only', 'entry', 'a', '2026-09-15T02:59:59Z'),
  clock('future-only', 'entry', 'a', '2026-09-15T22:00:00Z'),
  clock('next-day', 'entry', 'a', '2026-09-16T03:00:00Z'), clock('invalid', 'note'),
];
const sale = (id, sellerId, totalAmount, storeId = 'a', createdAt = '2026-09-15T15:00:00Z', status = 'completed') => ({
  id, sellerId, storeId, totalAmount, createdAt: new Date(createdAt), status, tcEarned: 1, tcUsed: 0,
  items: [{ id: id + '-item', productName: 'Camiseta teste', quantity: 1, brand: 'Sports & Tennis', category: 'roupa', totalPrice: totalAmount }],
});
const sales = [sale('s1', 'working', 100), sale('s2', 'finished', 200), sale('s3', 'break', 300),
  sale('s4', 'transferred', 400), sale('s5', 'without-clock', 500), sale('s6', 'moved', 60),
  sale('s7', 'moved', 70, 'b'), sale('s8', 'other', 800, 'b'), sale('s9', 'no-store', 40, null),
  sale('s10', 'cancel-only', 9000, 'a', '2026-09-15T15:00:00Z', 'canceled'),
  sale('s11', 'old-only', 50, 'b', '2026-09-14T15:00:00Z'),
  // Outra loja/dia afeta meta mensal, mas não vira evidência de presença hoje.
  sale('s12', 'working', 49900, 'b', '2026-09-01T15:00:00Z'),
  sale('s13', 'old-only', 80, 'b', '2026-08-15T15:00:00Z'),
  sale('s14', 'future-only', 900, 'a', '2026-09-15T22:00:00Z'),
];
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
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
async function run(query, role = 'admin', { active = true } = {}) {
  let handler, result, pdfResult;
  let clockQueries = 0, statusCode = 200;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-15T18:00:00Z'])); }
  }
  const headers = {};
  const context = {
    ...require('../src/services/rankingCommission'), ...require('../src/services/salesVisibility'), ...require('../src/services/rankingOwner'),
    Date: FixedDate, console, sellerOnly() {},
    require(moduleName) {
      assert.equal(moduleName, '../services/rankingPdf');
      return { createRankingPdf: async data => { pdfResult = data; return Buffer.from('pdf-fixture'); } };
    },
    router: { get(_url, _middleware, fn) { handler = fn; } },
    prisma: {
      config: { findUnique: async () => null },
      sale: {
        groupBy: async ({ where }) => {
          const groups = new Map();
          for (const sale of sales.filter(sale => matches(sale, where))) {
            if (!groups.has(sale.sellerId)) groups.set(sale.sellerId, {
              sellerId: sale.sellerId, _sum: { totalAmount: 0, tcEarned: 0, tcUsed: 0 }, _count: { _all: 0 },
            });
            const group = groups.get(sale.sellerId);
            for (const key of ['totalAmount', 'tcEarned', 'tcUsed']) group._sum[key] += sale[key];
            group._count._all++;
          }
          return [...groups.values()];
        },
        findMany: async ({ where }) => sales.filter(sale => matches(sale, where)),
      },
      user: {
        findUnique: async () => ({ role, active, storeId: 'a', storeIds: [] }),
        findMany: async ({ where }) => users.filter(user => matches(user, where)),
      },
      store: {
        findUnique: async ({ where }) => stores.find(store => matches(store, where)) || null,
        findMany: async ({ where }) => stores.filter(store => matches(store, where)),
      },
      clockIn: { findMany: async ({ where }) => {
        clockQueries++;
        assert.equal(where.user, undefined, 'Historical participation must not depend on current role/active/store');
        assert.equal(where.timestamp.gte.toISOString(), '2026-09-15T03:00:00.000Z');
        assert.equal(where.timestamp.lt.toISOString(), '2026-09-16T03:00:00.000Z');
        return points.filter(point => matches(point, where));
      } },
    },
  };
  vm.runInNewContext(dayBounds + route, context);
  await handler({ userId: 'viewer', query }, {
    json(value) { result = value; }, status(code) { statusCode = code; return this; },
    set(name, value) { headers[name] = value; }, send(value) { result = value; },
  });
  assert.notEqual(statusCode, 500, JSON.stringify(result));
  return { result, pdfResult, headers, clockQueries, statusCode };
}
const sellerIds = result => Array.from(result.ranking, row => row.sellerId);
const row = (result, id) => result.ranking.find(item => item.sellerId === id);
const storeIds = entry => Array.from(entry.stores, store => store.id);
(async () => {
  const { result } = await run({ period: 'today', storeId: 'a' });
  assert.deepEqual(sellerIds(result), ['without-clock', 'transferred', 'break', 'finished', 'working', 'moved',
    'tie-a', 'tie-b', 'break-only', 'exit-only', 'zero']);
  assert.equal(result.totals.sellersCount, 11);
  assert.equal(result.totals.salesAmount, 1560);
  assert.equal(result.totals.salesCount, 6);
  assert.equal(result.ranking.reduce((sum, item) => sum + item.salesAmount, 0), result.totals.salesAmount);
  assert.equal(result.totals.commissionAmount, 18.6);
  assert.equal(row(result, 'working').commissionAmount, 4, 'Monthly clothing threshold remains intact');
  assert.equal(row(result, 'without-clock').commission.baseAmount, 5);
  assert.equal(row(result, 'without-clock').commission.at50kAmount, 10);
  assert.equal(row(result, 'zero').salesAmount, 0);
  assert.equal(row(result, 'zero').position, 11);
  assert.ok(result.ranking.every(item => item.store.id === 'a'));
  assert.ok(result.ranking.every(item => JSON.stringify(storeIds(item)) === '["a"]'));
  const all = (await run({})).result;
  assert.equal(all.period, 'today');
  assert.equal(all.totals.salesAmount, 2470);
  assert.equal(all.totals.salesCount, 9);
  assert.equal(all.ranking.reduce((sum, item) => sum + item.salesAmount, 0), 2470);
  assert.equal(new Set(sellerIds(all)).size, all.ranking.length);
  assert.equal(row(all, 'moved').salesAmount, 130);
  assert.deepEqual(storeIds(row(all, 'moved')), ['a', 'b']);
  assert.deepEqual(storeIds(row(all, 'working')), ['a'], 'Old B sales do not label today as B');
  assert.deepEqual(storeIds(row(all, 'transferred')), ['a'], 'Current B assignment must not rewrite historical A');
  assert.equal(row(all, 'no-store').store, null, 'Unassigned sale must not inherit current employee store');
  assert.deepEqual(storeIds(row(all, 'no-store')), []);
  for (const id of ['old-only', 'future-only', 'next-day', 'cancel-only', 'invalid', 'none']) assert.equal(row(all, id), undefined, id);
  const other = (await run({ period: 'today', storeId: 'b' })).result;
  assert.deepEqual(sellerIds(other), ['other', 'moved']);
  assert.equal(other.totals.salesAmount, 870);
  assert.equal(row(other, 'moved').salesAmount, 70);
  assert.deepEqual(storeIds(row(other, 'moved')), ['b']);
  assert.ok(other.ranking.every(item => item.store.id === 'b'));
  // A point in B plus a sale in A qualifies for both, without moving A's value to B.
  points.push(clock('none', 'entry', 'b'));
  sales.push(sale('cross-store', 'none', 25, 'a'));
  assert.equal(row((await run({ storeId: 'a' })).result, 'none').salesAmount, 25);
  assert.equal(row((await run({ storeId: 'b' })).result, 'none').salesAmount, 0);
  assert.deepEqual(storeIds(row((await run({ storeId: 'all' })).result, 'none')), ['a', 'b']);
  points.pop(); sales.pop();
  const custom = (await run({ period: 'custom', storeId: 'a', from: '2026-09-15', to: '2026-09-15' })).result;
  assert.deepEqual(sellerIds(custom), sellerIds(result));
  assert.equal(custom.totals.salesAmount, result.totals.salesAmount);
  for (const period of ['month', 'last_month', 'yesterday']) {
    const history = await run({ period, storeId: 'all' });
    assert.equal(history.clockQueries, 0, period);
    assert.equal(row(history.result, 'zero'), undefined);
    assert.ok(row(history.result, 'old-only'), period);
    assert.ok(history.result.ranking.every(item => item.stores === undefined));
  }
  assert.equal((await run({ period: 'custom', from: '2026-09-14', to: '2026-09-14' })).clockQueries, 0);
  for (const role of ['seller', 'store', 'manager']) {
    const restricted = (await run({ storeId: 'all' }, role)).result;
    assert.equal(restricted.canViewRevenueTotals, false, role);
    for (const key of ['salesAmount', 'cashbackGiven', 'commissionAmount']) assert.equal(restricted.totals[key], null, role + '/' + key);
    assert.deepEqual(sellerIds(restricted), sellerIds(all));
  }
  for (const role of ['admin', 'superadmin']) assert.equal((await run({ storeId: 'all' }, role)).result.canViewRevenueTotals, true);
  assert.equal((await run({ storeId: 'a' }, 'seller')).result.canViewRevenueTotals, true);
  for (const format of [undefined, 'pdf']) {
    assert.equal((await run({ storeId: 'b', format }, 'seller')).statusCode, 403);
    assert.equal((await run({ storeId: 'all', format }, 'seller', { active: false })).statusCode, 403);
  }
  // All exports use the exact same participation/commission payload as JSON.
  const pdf = await run({ period: 'custom', storeId: 'a', from: '2026-09-15', to: '2026-09-15', format: 'pdf' });
  assert.equal(pdf.headers['Content-Type'], 'application/pdf');
  assert.deepEqual(sellerIds(pdf.pdfResult), sellerIds(result));
  assert.equal(pdf.pdfResult.totals.salesAmount, 1560);
  const privatePdf = await run({ storeId: 'all', format: 'pdf' }, 'seller');
  assert.equal(privatePdf.pdfResult.totals.salesAmount, null);
  const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
  const renderStart = html.indexOf('// ============== RANKING ==============');
  const renderEnd = html.indexOf('// ============== CRM ==============', renderStart);
  assert.ok(renderStart > 0 && renderEnd > renderStart);
  const elements = { rankStore: { value: 'a' }, rankPeriod: { value: 'today' }, rankingTable: {}, rankingTotals: {}, rankRefresh: {}, rankRefreshStatus: {} };
  const ui = { document: { getElementById: id => elements[id], addEventListener() {} }, api: async () => result,
    window: { addEventListener() {} }, setInterval() {}, token: 'seller-ranking-fixture',
    fmt: n => String(n), escPreco: value => String(value), avatarColor: () => '', initials: name => name, console };
  vm.createContext(ui);
  vm.runInContext(html.slice(renderStart, renderEnd), ui);
  await ui.loadRanking();
  assert.match(elements.rankingTable.innerHTML, /Classificação completa · 11 vendedores/);
  for (const id of ['finished', 'without-clock', 'transferred', 'zero']) assert.match(elements.rankingTable.innerHTML, new RegExp('Vendedor ' + id));
  assert.match(elements.rankingTable.innerHTML, /#11/);
  for (const title of [/Comissão geral<br>1%/, /Batendo 50k/, /Batendo 20k/, /Camiseta teste/, /Conferir 1 peça/]) assert.match(elements.rankingTable.innerHTML, title);
  const whatsapp = ui.rankingWhatsappText(result, 'Loja A');
  assert.match(whatsapp, /11\s*\|\s*Vendedor zero/);
  assert.match(whatsapp, /1%/);
  ui.api = async () => all;
  elements.rankStore.value = 'all';
  await ui.loadRanking();
  assert.match(elements.rankingTable.innerHTML, /Loja A \/ Loja B/);

  // Exercise the real PDF renderer and PDFKit, observing exactly the text written.
  const PDFDocument = require('pdfkit');
  const originalText = PDFDocument.prototype.text;
  const written = [];
  PDFDocument.prototype.text = function (value, ...args) {
    written.push(String(value));
    return originalText.call(this, value, ...args);
  };
  try {
    const buffer = await require('../src/services/rankingPdf').createRankingPdf(all, {
      storeName: 'Todas as lojas', generatedAt: new Date('2026-09-15T18:00:00Z'),
    });
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
    assert.ok(buffer.length > 1000);
    assert.match(written.join('\n'), /Loja A \/ Loja B/);
    for (const id of ['finished', 'without-clock', 'transferred', 'zero']) assert.ok(written.some(text => text.includes('Vendedor ' + id)), id);
  } finally {
    PDFDocument.prototype.text = originalText;
  }
  console.log('PASS: full-day participation, exits/zero sales, inactive/transferred sellers, stores, custom today, monthly invariance, privacy and shared exports');
})().catch(error => { console.error(error); process.exitCode = 1; });
