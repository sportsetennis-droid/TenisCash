const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the actual Curadoria handlers and catalog route against deterministic
// per-variant physical balances. This never connects to or changes a database.
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'src/routes/catalog.js'), 'utf8');
function section(text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Production section exists: ${from}`);
  return text.slice(start, end);
}
const uiSource = section(html, 'let catSearchTimer;', 'function closeModal()');
const routeSource = section(catalog, "router.get('/products',", "router.get('/products/:id',");
const scopeSource = section(catalog, 'async function resolveMyStoreScope(', 'function addStoreStockSummary(');

const variant = (size, purchased, stocks = []) => ({
  id: `variant-${size}`, size, stock: purchased,
  storeStocks: stocks.map(([storeId, stock]) => ({
    storeId, stock, store: { id: storeId, code: storeId, name: `Loja ${storeId}` },
  })),
});
const product = (id, sizes) => ({
  id, active: true, price: 100, name: `tênis ${id}`, sizes,
  brand: 'Marca A', category: 'Calçados',
  aiContext: { classification: { type: 'tenis', gender: 'masculino', modality: 'casual', tier: 'entrada' } },
});
function fixtures() {
  return [
    product('historical', [variant('39', 12, [['local', 0]])]),
    product('other-size-only', [variant('39', 8, [['local', 0]]), variant('40', 8, [['local', 2]])]),
    product('remote-39', [variant('39', 0, [['remote', 3]])]),
    product('local-39', [variant('39', 9, [['local', 1]])]),
    product('negative', [variant('39', 3, [['local', -1]])]),
    product('purchased-only', [variant('39', 10)]),
    product('only-40', [variant('40', 2, [['local', 2]])]),
    product('unknown-question', [variant('?', 20, [['local', 2]])]),
    product('unknown-placeholder', [variant('T-39', 20, [['local', 2]])]),
    product('half-size', [variant('39.5', 3, [['local', 2]])]),
  ];
}

// Interpret only Prisma predicates exercised by the actual route. The nested
// relation interpretation catches a bug where size and stock use different rows.
function matches(value, predicate) {
  if (predicate === null || typeof predicate !== 'object') return value === predicate;
  const resolved = predicate.path
    ? predicate.path.reduce((acc, field) => acc?.[field], value) : value;
  return Object.entries(predicate).every(([key, expected]) => {
    if (key === 'AND') return expected.every(condition => matches(value, condition));
    if (key === 'OR') return expected.some(condition => matches(value, condition));
    if (key === 'some') return Array.isArray(value) && value.some(row => matches(row, expected));
    if (key === 'mode' || key === 'path') return true;
    if (key === 'equals') return predicate.mode === 'insensitive'
      ? String(resolved || '').toLowerCase() === String(expected).toLowerCase() : resolved === expected;
    if (key === 'gt') return resolved > expected;
    if (key === 'contains') return String(resolved || '').toLowerCase().includes(String(expected).toLowerCase());
    if (key === 'string_contains') return typeof resolved === 'string' && resolved.includes(expected);
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
    assert.equal(headers['Cache-Control'], 'no-store', 'Physical stock responses are not browser-cached');
    return body;
  } };
}

function ui({ api, selectedSize = '39', query = 'tênis', cards = true, checked = false, ps = {} } = {}) {
  const elements = new Map(), timers = new Map();
  const requests = [], cardCalls = [], sizeCalls = [], pageCalls = [], alerts = [], errors = [];
  let timerId = 0;
  const card = { render(p, opts) {
    cardCalls.push({ product: p, opts });
    return `<article data-product="${p.id}">${p.name}</article>`;
  } };
  const psbar = { getFilters() { return ps; } };
  const context = {
    _filterSize: selectedSize, _filterType: null, _filterGender: null,
    _filterCategory: null, _filterTier: null, activeStore: { id: 'local' },
    window: { PSBar: psbar, ...(cards ? { PCard: card } : {}) },
    PSBar: psbar, PCard: cards ? card : undefined,
    document: { getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        elements.set(id, { value: '', innerHTML: '', textContent: '', checked: false,
          classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        });
      }
      return elements.get(id);
    } },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async api(url) { requests.push(url); return api(url); },
    renderSizeOptions(containerId, options, selectedSize, failed = false) { sizeCalls.push({ containerId, options, selectedSize, failed }); },
    renderProductPages(containerId, page = 1, totalPages = 1) { pageCalls.push({ containerId, page, totalPages }); },
    fmt: value => Number(value).toFixed(2),
    escPreco: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    console: { error(...args) { errors.push(args); } },
    alert: message => alerts.push(message),
  };
  context.document.getElementById('catSearchInput').value = query;
  context.document.getElementById('catInStoreOnly').checked = checked;
  context.document.getElementById('catalogResults').innerHTML = 'previous products';
  vm.createContext(context);
  vm.runInContext(uiSource, context);
  return {
    context, elements, timers, requests, cardCalls, sizeCalls, pageCalls, alerts, errors, ps,
    rendered: () => context.document.getElementById('catalogResults').innerHTML,
    async search(number = context._filterSize, text = context.document.getElementById('catSearchInput').value, page = 1) {
      context._filterSize = number;
      context.document.getElementById('catSearchInput').value = text;
      await context.onCatalogSearch(page);
    },
    runTimer() {
      assert.equal(timers.size, 1, 'Only the most recent debounce remains scheduled');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
  };
}
const paramsFor = url => new URL(url, 'https://test.invalid').searchParams;
const renderedIds = view => view.cardCalls.map(call => call.product.id);

async function main() {
  const rows = fixtures(), backend = server(rows);
  const view = ui({ api: url => backend.request(url) });
  await view.search();
  assert.ok(!view.rendered().includes('previous products'), 'Changing filters clears previous results immediately');
  await view.runTimer();
  const params = paramsFor(view.requests[0]);
  assert.equal(params.get('size'), '39');
  assert.equal(params.get('exactSize'), '1');
  assert.equal(params.get('inStore'), '1', 'Size selection requires physical stock even when checkbox is unchecked');
  assert.equal(params.has('storeId'), false, 'Network Curadoria includes another store with the selected size');
  assert.deepEqual(renderedIds(view), ['remote-39', 'local-39'], 'Only the exact variant with positive physical stock is included');
  const predicate = backend.queries[0].where.AND.find(condition => condition.sizes?.some?.size === '39');
  assert.equal(predicate.sizes.some.storeStocks.some.stock.gt, 0, 'Size and positive stock belong to the same ProductSize');
  for (const { opts } of view.cardCalls) {
    assert.equal(opts.physicalStockOnly, true, 'Catalog cards use physical stock instead of purchased totals');
    assert.equal(opts.selectedSize, '39', 'Catalog card receives the exact selected size');
  }

  // Physical stock changes after a sale while historical purchases remain intact.
  rows.find(p => p.id === 'local-39').sizes[0].storeStocks[0].stock = 0;
  view.cardCalls.length = 0;
  await view.search('39', ''); await view.runTimer();
  assert.deepEqual(renderedIds(view), ['remote-39'], 'A newly depleted size disappears, including size-only searches');
  assert.equal(rows.find(p => p.id === 'local-39').sizes[0].stock, 9, 'No purchased stock was modified');

  view.cardCalls.length = 0;
  await view.search(null, ''); await view.runTimer();
  assert.equal(paramsFor(view.requests.at(-1)).has('size'), false);
  assert.equal(paramsFor(view.requests.at(-1)).has('inStore'), false, 'Unfiltered catalog keeps its original scope');
  assert.ok(renderedIds(view).includes('historical'));
  assert.ok(view.cardCalls.every(call => call.opts.physicalStockOnly && call.opts.selectedSize == null));

  view.cardCalls.length = 0;
  view.elements.get('catInStoreOnly').checked = true;
  await view.search(null, ''); await view.runTimer();
  assert.equal(paramsFor(view.requests.at(-1)).get('inStore'), '1', 'Stock checkbox works without a selected size');
  assert.ok(!renderedIds(view).includes('historical') && !renderedIds(view).includes('purchased-only'));
  assert.ok(renderedIds(view).includes('other-size-only'), 'Without a size filter, another available size is sufficient');

  const empty = ui({ api: url => backend.request(url), selectedSize: '38' });
  await empty.search(); await empty.runTimer();
  assert.match(empty.rendered(), /nenhum.*estoque.*numeraç/i, 'An unavailable size has a clear empty state');
  const fallback = ui({ api: url => backend.request(url), cards: false });
  await fallback.search(); await fallback.runTimer();
  assert.ok(fallback.rendered().includes('remote-39') && !fallback.rendered().includes('historical'), 'Fallback rendering respects physical availability');

  // Capture one coherent filter snapshot; later edits before debounce must not
  // silently mix the old query with a new tree or PSBar value.
  const snapshot = ui({ api: async () => ({ products: [] }), ps: {
    search: 'SKU & A', gender: 'feminino', modality: 'corrida', tier: 'premium', brand: 'Marca & Cia', category: 'Calçados',
  } });
  Object.assign(snapshot.context, { _filterType: 'tenis', _filterGender: 'masculino', _filterCategory: 'casual', _filterTier: 'entrada' });
  await snapshot.search('39', 'free text');
  Object.assign(snapshot.context, { _filterSize: '40', _filterType: 'chuteira', _filterGender: 'infantil' });
  Object.assign(snapshot.ps, { search: 'changed', gender: 'changed', brand: 'changed' });
  snapshot.elements.get('catInStoreOnly').checked = true;
  await snapshot.runTimer();
  const snapshotParams = Object.fromEntries(paramsFor(snapshot.requests[0]));
  assert.deepEqual(snapshotParams, { limit: '24', includeSizeOptions: '1', page: '1', q: 'SKU & A', type: 'tenis', gender: 'feminino', modality: 'corrida', tier: 'premium', size: '39', brand: 'Marca & Cia', category: 'Calçados', exactSize: '1', inStore: '1' });
  const tree = ui({ api: url => backend.request(url), ps: { brand: 'marca a' } });
  Object.assign(tree.context, { _filterType: 'tenis', _filterGender: 'masculino', _filterCategory: 'casual', _filterTier: 'entrada' });
  await tree.search(); await tree.runTimer();
  assert.deepEqual(renderedIds(tree), ['remote-39'], 'PSBar brand and tree classification are both applied by the actual backend route');

  // In-flight responses/errors cannot resurrect an earlier size, even while the
  // latest request is still waiting for its debounce.
  const pending = [];
  const raced = ui({ api: url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })) });
  await raced.search('39'); const oldWork = raced.runTimer();
  await raced.search('40');
  pending[0].resolve({ products: [product('stale-39', [])] }); await oldWork;
  assert.ok(!raced.rendered().includes('stale-39'));
  const newWork = raced.runTimer();
  pending[1].resolve({ products: [product('fresh-40', [])] }); await newWork;
  assert.ok(raced.rendered().includes('fresh-40'));
  assert.equal(raced.cardCalls.at(-1).opts.selectedSize, '40');
  await raced.search('39'); const slowWork = raced.runTimer();
  await raced.search('40'); const fastWork = raced.runTimer();
  pending[3].resolve({ products: [product('latest-40', [])] }); await fastWork;
  pending[2].resolve({ products: [product('late-39', [])] }); await slowWork;
  assert.ok(raced.rendered().includes('latest-40') && !raced.rendered().includes('late-39'));
  await raced.search('39'); const failingOldWork = raced.runTimer();
  await raced.search('40'); const succeedingNewWork = raced.runTimer();
  pending[5].resolve({ products: [product('still-latest-40', [])] }); await succeedingNewWork;
  pending[4].reject(new Error('obsolete request failed')); await failingOldWork;
  assert.ok(raced.rendered().includes('still-latest-40'), 'An old error cannot erase a newer successful search');
  assert.equal(raced.errors.length, 0, 'Obsolete request errors are ignored');
  const failure = ui({ api: async () => { throw new Error('current request failed'); } });
  await failure.search(); await failure.runTimer();
  assert.match(failure.rendered(), /não foi possível.*tente novamente/i);
  assert.equal(failure.errors.length, 1);
  assert.equal(failure.sizeCalls.at(-1).failed, true, 'A current error ends the size-option loading state');
  const debounced = ui({ api: url => backend.request(url) });
  await debounced.search('39'); await debounced.search('40'); await debounced.runTimer();
  assert.equal(debounced.requests.length, 1);
  assert.equal(paramsFor(debounced.requests[0]).get('size'), '40');

  // Details must show balances from each physical variant, never ProductSize.stock
  // (historical purchased amount), and must leave unknown labels unresolved.
  const detailProduct = product('details', [
    variant('40', 9002, [['local', 0], ['remote', -3]]),
    variant('39', 9001, [['local', 2], ['remote', 3]]),
    variant('?', 9003, [['local', 1]]),
    variant('T-39', 9004, [['remote', 4]]),
  ]);
  const detail = ui({ api: async url => { assert.equal(url, '/api/catalog/products/details'); return { product: detailProduct }; } });
  await detail.context.showProduct('details');
  const content = detail.elements.get('productModalContent').innerHTML;
  assert.match(content, /Estoque físico por tamanho/);
  assert.ok(detail.elements.get('productModal').classList.contains('show'));
  const tableRows = [...content.matchAll(/<tr>(.*?)<\/tr>/gs)].map(match => [...match[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(cell => cell[1]));
  const row39 = tableRows.find(row => row[0] === '39');
  const row40 = tableRows.find(row => row[0] === '40');
  assert.equal(row39[1], '5 un.');
  assert.match(row39[2], /Loja local \(2 un\.\)/);
  assert.match(row39[2], /Loja remote \(3 un\.\)/);
  assert.equal(row40[1], '0 un.');
  assert.match(row40[2], /Sem estoque físico/);
  assert.equal(tableRows.filter(row => row[0] === 'A definir').length, 2, 'Unknown and provisional variants remain explicitly unresolved');
  assert.ok(!/900[1-4]|T-39/.test(content), 'Neither historical totals nor a guessed placeholder size is presented as physical stock');
  assert.equal(tableRows.findIndex(row => row[0] === '39') < tableRows.findIndex(row => row[0] === '40'), true, 'Known numeric sizes are ordered naturally');
  assert.equal(detail.alerts.length, 0);
  console.log('PASS Curadoria: exact size and physical stock, network scope, depletion, card options, coherent filters, stale response/error protection and per-size product details.');
}

module.exports = { server, product, variant, ui, paramsFor, renderedIds, section };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
