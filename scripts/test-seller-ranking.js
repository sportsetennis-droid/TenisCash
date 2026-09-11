const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/seller.js'), 'utf8');
const dayBounds = source.slice(source.indexOf('function recifeDayBounds('), source.indexOf('function recifeMonthBounds('));
const summarize = source.slice(source.indexOf('function summarizeToday('), source.indexOf('// =====================================================================', source.indexOf('function summarizeToday(')));
const routeStart = source.indexOf("router.get('/rankings'");
const route = source.slice(routeStart, source.indexOf('\n// =====================================================================', routeStart));
const store = { id: 'a', name: 'Loja A', code: 'A' };
const sellers = Array.from({ length: 9 }, (_, i) => ({ id: String(i), name: `Vendedor ${i}`, store }));
const sale = (id, amount) => ({ sellerId: String(id), _sum: { totalAmount: amount, tcEarned: 1 }, _count: { _all: 1 } });
const sales = [sale(0, 100), sale(1, 200), sale(5, 500), sale(6, 600), sale(7, 700)];
const points = [];
function clock(id, type, storeId = 'a') {
  points.push({ userId: String(id), type, timestamp: new Date(Date.UTC(2026, 8, 11, 12, points.length)), storeId,
    store: storeId === 'a' ? store : { id: 'b', name: 'Loja B' }, user: { storeId: 'a', storeIds: ['a', 'b'] } });
}
for (const id of [0, 1, 2, 3, 4, 5, 6, 8]) clock(id, 'entry');
clock(4, 'break_start'); clock(4, 'break_end');
clock(5, 'break_start'); clock(6, 'exit', 'b');
clock(8, 'break_start'); clock(8, 'break_end', 'b');

async function run(query, role = 'admin') {
  let handler;
  let result;
  let clockQueries = 0;
  let statusCode = 200;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-09-11T18:00:00Z'])); }
  }
  const context = {
    ...require('../src/services/rankingCommission'),
    ...require('../src/services/salesVisibility'),
    Date: FixedDate, console, sellerOnly() {},
    router: { get(_url, _middleware, fn) { handler = fn; } },
    prisma: {
      sale: { groupBy: async () => sales, findMany: async ({where}) => sales
        .filter(s => where.sellerId.in.includes(s.sellerId))
        .map(s => ({sellerId:s.sellerId, storeId:'a', totalAmount:s._sum.totalAmount,
          createdAt:'2026-09-11T15:00:00Z', items:[{productName:'Camiseta teste',quantity:1,brand:'Sports & Tennis',category:'roupa',totalPrice:s._sum.totalAmount}]})) },
      saleCommission: { groupBy: async () => [] },
      user: { findUnique: async () => ({role, active: true, storeId: 'a', storeIds: []}), findMany: async ({ where }) => sellers.filter(s => where.id.in.includes(s.id)) },
      clockIn: { findMany: async ({ where }) => {
        clockQueries++;
        assert.equal(where.user.active, true);
        assert.equal(where.user.role, 'seller');
        assert.equal(where.timestamp.gte.toISOString(), '2026-09-11T03:00:00.000Z');
        assert.equal(where.timestamp.lt.toISOString(), '2026-09-12T03:00:00.000Z');
        return points;
      } },
    },
  };
  vm.runInNewContext(dayBounds + summarize + route, context);
  await handler({ query }, { json(value) { result = value; }, status(code) { statusCode = code; return this; } });
  return { result, clockQueries, statusCode };
}

(async () => {
  const { result } = await run({ period: 'today', storeId: 'a' });
  assert.deepEqual(Array.from(result.ranking, r => r.sellerId), ['5', '1', '0', '2', '3', '4']);
  assert.equal(result.totals.sellersCount, 6);
  assert.equal(result.totals.salesAmount, 800);
  assert.equal(result.totals.commissionAmount, 8);
  assert.equal(result.ranking[0].commission.baseAmount, 5);
  assert.equal(result.ranking[0].commission.at50kAmount, 10);
  assert.equal(result.ranking[5].salesAmount, 0);
  assert.equal(result.ranking[5].position, 6);
  assert.equal((await run({storeId: 'b'}, 'seller')).statusCode, 403);
  assert.equal((await run({storeId: 'b', format: 'pdf'}, 'seller')).statusCode, 403);
  const sellerAll = (await run({storeId: 'all'}, 'seller')).result;
  assert.equal(sellerAll.canViewRevenueTotals, false);
  assert.equal(sellerAll.totals.salesAmount, null);
  assert.ok(sellerAll.ranking.length > 3);
  assert.equal((await run({storeId: 'a'}, 'seller')).result.canViewRevenueTotals, true);
  const all = (await run({})).result;
  assert.equal(all.period, 'today');
  assert.equal(all.canViewRevenueTotals, false);
  assert.equal(all.totals.salesAmount, null);
  assert.equal(all.totals.commissionAmount, null);
  assert.equal(all.ranking.find(r => r.sellerId === '8').store.id, 'b');
  const other = (await run({ period: 'today', storeId: 'b' })).result;
  assert.deepEqual(Array.from(other.ranking, r => r.sellerId), ['8']);
  const history = await run({ period: 'month' });
  assert.equal(history.clockQueries, 0);
  assert.equal(history.result.ranking.length, sales.length);

  // Exercise actual rendering: the fifth seller with zero sales must appear.
  const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
  const renderStart = html.indexOf('async function loadRanking()');
  const renderEnd = html.indexOf('\n}', renderStart) + 2;
  const elements = { rankStore: { value: 'a' }, rankPeriod: { value: 'today' }, rankingTable: {}, rankingTotals: {} };
  const ui = { document: { getElementById: id => elements[id] }, api: async () => result,
    fmt: n => String(n), escPreco: value => String(value), avatarColor: () => '', initials: name => name, console };
  vm.createContext(ui);
  vm.runInContext(html.slice(renderStart, renderEnd), ui);
  await ui.loadRanking();
  assert.match(elements.rankingTable.innerHTML, /Classificação completa · 6 vendedores/);
  assert.match(elements.rankingTable.innerHTML, /Vendedor 4/);
  assert.match(elements.rankingTable.innerHTML, /#5/);
  assert.match(elements.rankingTable.innerHTML, /Comissão geral<br>1%/);
  assert.match(elements.rankingTable.innerHTML, /Batendo 50k/);
  assert.match(elements.rankingTable.innerHTML, /Vestuário Sports &amp; Tennis<br>1%/);
  assert.match(elements.rankingTable.innerHTML, /Batendo 20k · 4%/);
  assert.match(elements.rankingTable.innerHTML, /Camiseta teste/);
  assert.match(elements.rankingTable.innerHTML, /Conferir 1 peça/);
  result.ranking = [];
  await ui.loadRanking();
  assert.match(elements.rankingTable.innerHTML, /Nenhum vendedor com ponto aberto/);
  console.log('PASS: daily ranking, zero sales, attendance, stores, historical periods and full rendering');
})().catch(error => { console.error(error); process.exitCode = 1; });
