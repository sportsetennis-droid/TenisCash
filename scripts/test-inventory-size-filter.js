const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real UI handler and catalog route with deterministic stock rows.
// No network, database, credentials, or real inventory mutations are involved.
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'src/routes/catalog.js'), 'utf8');
function section(text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Production section exists: ${from}`);
  return text.slice(start, end);
}
const uiSource = section(html, 'let invSearchTimer;', 'async function checkInventory(');
const routeSource = section(catalog, "router.get('/products',", "router.get('/products/:id',");
const scopeSource = section(catalog, 'async function resolveMyStoreScope(', 'function addStoreStockSummary(');

const size = (number, purchased, stocks = []) => ({
  size: number, stock: purchased,
  storeStocks: stocks.map(([storeId, stock]) => ({ storeId, stock })),
});
const product = (id, sizes) => ({ id, active: true, price: 100, name: `tênis ${id}`, sizes });
function fixtures() {
  return [
    product('historical', [size('45', 12, [['local', 0]])]),
    product('other-size-only', [size('45', 8, [['local', 0]]), size('46', 8, [['local', 2]])]),
    product('remote-45', [size('45', 0, [['remote', 3]])]),
    product('local-45', [size('45', 9, [['local', 1]])]),
    product('negative', [size('45', 3, [['local', -1]])]),
    product('purchased-only', [size('45', 10)]),
    product('only-46', [size('46', 2, [['local', 2]])]),
  ];
}

// Interpret the subset of Prisma predicates exercised here, including nested
// relation scopes. Separate size and stock `some` predicates would fail below.
function matches(value, predicate) {
  if (predicate === null || typeof predicate !== 'object') return value === predicate;
  return Object.entries(predicate).every(([key, expected]) => {
    if (key === 'AND') return expected.every(condition => matches(value, condition));
    if (key === 'OR') return expected.some(condition => matches(value, condition));
    if (key === 'some') return Array.isArray(value) && value.some(row => matches(row, expected));
    if (key === 'mode') return true;
    if (key === 'equals') return predicate.mode === 'insensitive'
      ? String(value || '').toLowerCase() === String(expected).toLowerCase() : value === expected;
    if (key === 'gt') return value > expected;
    if (key === 'contains') return String(value || '').toLowerCase().includes(String(expected).toLowerCase());
    if (key === 'path') return true;
    if (key === 'string_contains') {
      const nested = (predicate.path || []).reduce((acc, field) => acc?.[field], value);
      return typeof nested === 'string' && nested.includes(expected);
    }
    return matches(value?.[key], expected);
  });
}

function server(rows) {
  let handler;
  const queries = [];
  const prisma = { product: {
    async count({ where }) { return rows.filter(row => matches(row, where)).length; },
    async findMany(query) {
      queries.push(query);
      return rows.filter(row => matches(row, query.where)).slice(query.skip, query.skip + query.take);
    },
  } };
  vm.runInNewContext(scopeSource + routeSource, {
    router: { get(_path, _middleware, callback) { handler = callback; } },
    prisma, optionalCatalogAuth() {}, formatProductCard: value => value,
    console: { error(...args) { throw new Error(args.join(' ')); } },
  });
  return { queries, async request(url) {
    let body;
    const headers = {};
    const req = { query: Object.fromEntries(new URL(url, 'https://test.invalid').searchParams), userRole: 'seller' };
    const res = {
      set(key, value) { headers[key] = value; return this; },
      status(code) { assert.equal(code, 200); return this; },
      json(value) { body = value; return this; },
    };
    await handler(req, res);
    assert.equal(headers['Cache-Control'], 'no-store', 'Physical stock is never browser-cached');
    return body;
  } };
}

function ui({ api, selectedSize = '45', query = 'tênis', cards = true } = {}) {
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  let timerId = 0;
  const card = { render: p => `<article data-product="${p.id}">${p.name}</article>` };
  const context = {
    _filterSize: selectedSize, activeStore: { id: 'local' },
    window: cards ? { PCard: card } : {}, PCard: cards ? card : undefined,
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '' });
      return elements.get(id);
    } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async api(url) { requests.push(url); return api(url); },
    console: { error() {} },
  };
  context.document.getElementById('invSearchInput').value = query;
  context.document.getElementById('invResults').innerHTML = 'previous products';
  context.document.getElementById('invDetails').innerHTML = 'previous stock detail';
  vm.createContext(context);
  vm.runInContext(uiSource, context);
  return {
    context, elements, timers, requests,
    rendered: () => context.document.getElementById('invResults').innerHTML,
    async search(number = context._filterSize, text = context.document.getElementById('invSearchInput').value) {
      context._filterSize = number;
      context.document.getElementById('invSearchInput').value = text;
      await context.onInventorySearch();
    },
    runTimer() {
      assert.equal(timers.size, 1, 'Only the most recent debounce remains scheduled');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
  };
}

async function main() {
  const rows = fixtures(), backend = server(rows);
  const view = ui({ api: url => backend.request(url) });
  await view.search();
  assert.ok(!view.rendered().includes('previous products'), 'Clear results before changing size');
  assert.equal(view.elements.get('invDetails').innerHTML, '', 'Clear obsolete stock detail');
  await view.runTimer();
  const params = new URL(view.requests[0], 'https://test.invalid').searchParams;
  assert.equal(params.get('size'), '45');
  assert.equal(params.get('inStore'), '1');
  assert.equal(params.has('storeId'), false, 'Product search covers stores across the network');
  assert.ok(view.rendered().includes('remote-45') && view.rendered().includes('local-45'));
  for (const id of ['historical', 'other-size-only', 'negative', 'purchased-only', 'only-46']) {
    assert.ok(!view.rendered().includes(id), `Exclude unavailable selected size: ${id}`);
  }
  const predicate = backend.queries[0].where.AND.find(condition => condition.sizes?.some?.size === '45');
  assert.equal(predicate.sizes.some.storeStocks.some.stock.gt, 0, 'Size and positive balance share the same variant');

  // A completed sale changes physical stock, while purchased totals stay put.
  rows.find(p => p.id === 'local-45').sizes[0].storeStocks[0].stock = 0;
  await view.search('45', '');
  await view.runTimer();
  assert.ok(view.rendered().includes('remote-45'), 'Size-only searches work without text');
  assert.ok(!view.rendered().includes('local-45'), 'A newly exhausted size disappears on the next search');
  await view.search(null, '');
  await view.runTimer();
  const unfiltered = new URL(view.requests.at(-1), 'https://test.invalid').searchParams;
  assert.equal(unfiltered.has('size'), false);
  assert.equal(unfiltered.has('inStore'), false, 'No-size search preserves existing behavior');
  assert.ok(view.rendered().includes('historical'));

  const empty = ui({ api: url => backend.request(url), selectedSize: '44' });
  await empty.search(); await empty.runTimer();
  assert.match(empty.rendered(), /nenhum|nada|não encontr|sem produto/i, 'No-stock result explains the empty state');
  const fallback = ui({ api: url => backend.request(url), cards: false });
  await fallback.search(); await fallback.runTimer();
  assert.ok(fallback.rendered().includes('remote-45'), 'Fallback renderer keeps the same availability filter');
  assert.ok(!fallback.rendered().includes('historical'));

  // Pending results must not redraw the old size during the next debounce.
  const pending = [];
  const raced = ui({ api: url => new Promise(resolve => pending.push({ url, resolve })) });
  await raced.search('45');
  const oldWork = raced.runTimer();
  await raced.search('46');
  pending[0].resolve({ products: [product('stale-45', [])] });
  await oldWork;
  assert.ok(!raced.rendered().includes('stale-45'), 'Old response is ignored before the next request starts');
  const newWork = raced.runTimer();
  pending[1].resolve({ products: [product('fresh-46', [])] });
  await newWork;
  assert.ok(raced.rendered().includes('fresh-46'));

  await raced.search('45');
  const slowerWork = raced.runTimer();
  await raced.search('46');
  const fasterWork = raced.runTimer();
  pending[3].resolve({ products: [product('latest-46', [])] });
  await fasterWork;
  pending[2].resolve({ products: [product('late-45', [])] });
  await slowerWork;
  assert.ok(raced.rendered().includes('latest-46') && !raced.rendered().includes('late-45'), 'Late responses never replace newer results');

  const debounced = ui({ api: url => backend.request(url) });
  await debounced.search('45');
  await debounced.search('46');
  await debounced.runTimer();
  assert.equal(debounced.requests.length, 1);
  assert.equal(new URL(debounced.requests[0], 'https://test.invalid').searchParams.get('size'), '46');
  console.log('PASS inventory size filter: current StoreStock, exact variant, network scope, exhaustion, empty state, debounce and stale responses.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
