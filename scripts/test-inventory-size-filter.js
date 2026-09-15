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
const querySource = section(html, 'function buildFilterQuery()', 'function resetFilters(');
const treeChangeSource = section(html, 'function onInventorySearchFromTree()', 'function renderCatalog(');
const pickSource = section(html, 'function pickFilter(', 'function clearFilters(');
const navigationSource = section(html, 'function goPage(', '// Fechar modal clicando fora');
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
  }, productSize: {
    async findMany({ where }) {
      const matching = rows.flatMap(p => p.sizes.map(size => ({ ...size, product: p })))
        .filter(row => matches(row, where));
      return [...new Set(matching.map(row => row.size))].map(size => ({ size }));
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
  const sizeCalls = [];
  const pageCalls = [];
  const cardCalls = [];
  let timerId = 0;
  const card = { render(p, opts) {
    cardCalls.push({ product: p, opts });
    return `<article data-product="${p.id}">${p.name}</article>`;
  } };
  const context = {
    _filterSize: selectedSize, _filterType: null, _filterGender: null,
    _filterCategory: null, _filterTier: null, activeStore: { id: 'local' },
    window: cards ? { PCard: card } : {}, PCard: cards ? card : undefined,
    document: { querySelectorAll() { return []; }, querySelector() { return { classList: { add() {}, remove() {} } }; }, getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', options: [{}, {}], classList: { add() {}, remove() {} } });
      return elements.get(id);
    } },
    renderFilterTree(_containerId, onChange) { context[onChange](); },
    loadMessages() {},
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async api(url) { requests.push(url); return api(url); },
    renderSizeOptions(containerId, options, selectedSize, failed = false) { sizeCalls.push({ containerId, options, selectedSize, failed }); },
    renderProductPages(containerId, page = 1, totalPages = 1) { pageCalls.push({ containerId, page, totalPages }); },
    console: { error() {} },
  };
  context.document.getElementById('invSearchInput').value = query;
  context.document.getElementById('invResults').innerHTML = 'previous products';
  context.document.getElementById('invDetails').innerHTML = 'previous stock detail';
  vm.createContext(context);
  vm.runInContext(querySource + treeChangeSource + pickSource + navigationSource + uiSource, context);
  return {
    context, elements, timers, requests, sizeCalls, pageCalls, cardCalls,
    rendered: () => context.document.getElementById('invResults').innerHTML,
    async search(number = context._filterSize, text = context.document.getElementById('invSearchInput').value, page = 1) {
      context._filterSize = number;
      context.document.getElementById('invSearchInput').value = text;
      await context.onInventorySearch(page);
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
  assert.equal(params.get('exactSize'), '1');
  assert.equal(params.get('includeSizeOptions'), '1');
  assert.equal(params.has('storeId'), false, 'Product search covers stores across the network');
  assert.ok(view.rendered().includes('remote-45') && view.rendered().includes('local-45'));
  assert.deepEqual(Array.from(view.sizeCalls.at(-1).options), ['45', '46']);
  assert.ok(view.cardCalls.every(call => call.opts.physicalStockOnly && call.opts.selectedSize === '45'));
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
  const sizeCallsBeforeLate = raced.sizeCalls.length;
  const pageCallsBeforeLate = raced.pageCalls.length;
  pending[2].resolve({ products: [product('late-45', [])] });
  await slowerWork;
  assert.ok(raced.rendered().includes('latest-46') && !raced.rendered().includes('late-45'), 'Late responses never replace newer results');
  assert.equal(raced.sizeCalls.length, sizeCallsBeforeLate, 'Late responses do not replace newer size options');
  assert.equal(raced.pageCalls.length, pageCallsBeforeLate, 'Late responses do not replace pagination');

  const debounced = ui({ api: url => backend.request(url) });
  await debounced.search('45');
  await debounced.search('46');
  await debounced.runTimer();
  assert.equal(debounced.requests.length, 1);
  assert.equal(new URL(debounced.requests[0], 'https://test.invalid').searchParams.get('size'), '46');

  const apparel = Array.from({ length: 25 }, (_, index) => product(`shirt-m-${index}`, [size('M', 99, [['remote', 1]])]));
  apparel.push(product('shirt-g', [size('G', 99, [['remote', 1]])]));
  apparel.push(product('shirt-gg', [size('GG', 99, [['remote', 1]])]));
  const apparelServer = server(apparel);
  const allSizes = ui({ api: url => apparelServer.request(url), selectedSize: null, query: '' });
  await allSizes.search(); await allSizes.runTimer();
  assert.equal(allSizes.cardCalls.length, 24);
  assert.deepEqual(Array.from(allSizes.sizeCalls.at(-1).options), ['M', 'G', 'GG'], 'Inventory offers apparel sizes beyond the first results page');
  allSizes.cardCalls.length = 0;
  await allSizes.search(null, '', 2); await allSizes.runTimer();
  assert.deepEqual(allSizes.cardCalls.map(call => call.product.id), ['shirt-m-24', 'shirt-g', 'shirt-gg']);
  assert.equal(allSizes.pageCalls.at(-1).page, 2);
  allSizes.cardCalls.length = 0;
  await allSizes.search('M', ''); await allSizes.runTimer();
  assert.equal(new URL(allSizes.requests.at(-1), 'https://test.invalid').searchParams.get('page'), '1');
  assert.ok(allSizes.cardCalls.every(call => call.product.id.startsWith('shirt-m-')), 'M never matches G or GG in inventory');
  await allSizes.search('M', '', 2); allSizes.cardCalls.length = 0; await allSizes.runTimer();
  assert.deepEqual(allSizes.cardCalls.map(call => call.product.id), ['shirt-m-24'], 'The second page preserves the exact selected size');

  const shirts = [
    { ...product('shirt-m', [size('M', 20, [['local', 2]]), size(' M ', 40, [['local', 0]])]), name: 'camiseta normal' },
    { ...product('shirt-g', [size('G', 30, [['local', 1]])]), name: 'camiseta grande' },
    { ...product('shirt-spaced-m', [size('M', 20, [['local', 0]]), size(' M ', 40, [['local', 3]])]), name: 'camiseta literal' },
    { ...product('shorts-m', [size('M', 50, [['local', 4]])]), name: 'bermuda normal' },
  ];
  const shirtsServer = server(shirts);
  const typed = ui({ api: url => shirtsServer.request(url), selectedSize: null, query: 'camiseta' });
  await typed.search(); await typed.runTimer();
  typed.cardCalls.length = 0;
  typed.context.pickFilter('size', 'M', 'inventoryTree'); await typed.runTimer();
  assert.equal(typed.elements.get('invSearchInput').value, 'camiseta', 'Choosing a size does not overwrite the typed product search');
  assert.deepEqual(typed.cardCalls.map(call => call.product.id), ['shirt-m'], 'Product query and the same positive M variant remain combined');
  typed.cardCalls.length = 0;
  typed.context.goPage('messages');
  typed.context.goPage('inventory'); await typed.runTimer();
  assert.equal(typed.elements.get('invSearchInput').value, 'camiseta', 'Returning to Estoque preserves the typed search');
  assert.deepEqual(typed.cardCalls.map(call => call.product.id), ['shirt-m'], 'Returning to the screen keeps both product and size constraints');
  typed.cardCalls.length = 0;
  typed.context.pickFilter('size', ' M ', 'inventoryTree'); await typed.runTimer();
  const literalParams = new URL(typed.requests.at(-1), 'https://test.invalid').searchParams;
  assert.equal(literalParams.get('size'), ' M ');
  assert.equal(literalParams.get('exactSize'), '1');
  assert.equal(literalParams.get('q'), 'camiseta');
  assert.deepEqual(typed.cardCalls.map(call => call.product.id), ['shirt-spaced-m'], 'Spaced literal M does not borrow stock from a different M variant');
  assert.equal(typed.cardCalls[0].opts.selectedSize, ' M ', 'The card receives the same literal used by the backend');
  typed.context._filterType = 'Tênis';
  typed.context._filterGender = 'Feminino';
  typed.context.onInventorySearchFromTree(); await typed.runTimer();
  assert.equal(new URL(typed.requests.at(-1), 'https://test.invalid').searchParams.get('q'), 'tênis feminino camiseta', 'Tree terms complement rather than replace free text');
  assert.equal(typed.elements.get('invSearchInput').value, 'camiseta');
  console.log('PASS inventory size filter: current StoreStock, exact variant, network scope, exhaustion, empty state, debounce and stale responses.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
