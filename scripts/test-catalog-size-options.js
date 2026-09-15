const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real route with in-memory Prisma predicates; no database/network.
const source = fs.readFileSync(path.join(__dirname, '../src/routes/catalog.js'), 'utf8');
const routeStart = source.indexOf("router.get('/products',");
const routeEnd = source.indexOf("router.get('/products/:id',", routeStart);
const helpersStart = source.indexOf('async function resolveMyStoreScope(');
assert.ok(routeStart > helpersStart && routeEnd > routeStart);
const routeSource = source.slice(helpersStart, routeEnd);
const stores = [
  { id: 'local', code: 'LOJA02', name: 'Bessa', active: true },
  { id: 'remote', code: 'LOJA05', name: 'Tambau', active: true },
];
const variant = (size, bought = 10, balances = [['local', 1]]) => ({
  id: `variant-${size}`, size, stock: bought,
  storeStocks: balances.map(([storeId, stock]) => ({ storeId, stock, store: stores.find(s => s.id === storeId) })),
});
const product = (id, sizes, extra = {}) => ({
  id, sku: id, name: `Produto ${id}`, active: true, price: 100, brand: 'Marca A', category: 'roupa',
  aiContext: { classification: { type: 'Vestuário', gender: 'Feminino', modality: 'Treino', tier: 'entrada' } },
  sizes, ...extra,
});
const fixtures = () => [
  ...Array.from({ length: 27 }, (_, i) => product(`camiseta-${i}`, [variant('P')])),
  product('camiseta-grade', ['GG', 'M', 'PP', 'G', 'P'].map(s => variant(s))),
  product('camiseta-remota', [variant('XG', 2, [['remote', 2]])]),
  product('camiseta-zerada', [variant('XXG', 30, [['local', 0]])]),
  product('camiseta-negativa', [variant('XXXG', 30, [['local', -1]])]),
  product('camiseta-comprada', [variant('G4', 30, [])]),
  product('infantil', [variant('2'), variant('4'), variant('10'), variant('12')]),
  product('acessorios', [variant('Único'), variant('U'), variant('35-38'), variant('38/39')], { category: 'acessorio' }),
  product('tenis', [variant('39', 30, [['local', 0]]), variant('40', 1), variant('39.5', 1)], {
    category: 'tenis', aiContext: { classification: { type: 'Tênis', gender: 'Masculino', modality: 'Corrida', tier: 'pro' } },
  }),
  product('tenis-segunda', [variant('45', 0, [['remote', 3]])], {
    category: 'tenis', aiContext: { classification: { type: 'Outro' }, classification2: { type: 'Tênis', gender: 'Masculino', modality: 'Corrida', tier: 'pro' } },
  }),
  product('outra-marca', [variant('G2')], { brand: 'Marca B' }),
  product('inativo-real', [variant('G1')], { active: false }),
  product('inativo-sem-preco', [variant('G3')], { active: false, price: 0 }),
  product('pendencias', ['?', '', ' ', 'T-1234', 't-4567', 'A DEFINIR', 'ADEFINIR', 'SEM TAMANHO', '—', '-'].map(s => variant(s))),
];
function matches(value, predicate) {
  if (predicate === null || typeof predicate !== 'object') return value === predicate;
  const resolved = predicate.path ? predicate.path.reduce((acc, key) => acc?.[key], value) : value;
  return Object.entries(predicate).every(([key, expected]) => {
    if (key === 'AND') return expected.every(p => matches(value, p));
    if (key === 'OR') return expected.some(p => matches(value, p));
    if (key === 'some') return Array.isArray(value) && value.some(p => matches(p, expected));
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
  const prisma = {
    product: {
      async count({ where }) { return rows.filter(p => matches(p, where)).length; },
      async findMany(query) { return rows.filter(p => matches(p, query.where)).slice(query.skip, query.skip + query.take); },
    },
    productSize: { async findMany(query) {
      queries.push(query);
      assert.deepEqual(Array.from(query.distinct), ['size']);
      assert.equal(query.take, undefined, 'Facet is independent of result pagination');
      assert.equal(query.skip, undefined, 'Facet is independent of result page');
      const sizes = rows.flatMap(p => p.sizes.map(s => ({ ...s, product: p }))).filter(s => matches(s, query.where));
      return [...new Set(sizes.map(s => s.size))].map(size => ({ size }));
    } },
    store: { async findFirst({ where }) { return stores.find(s => matches(s, where)) || null; } },
    user: { async findUnique() { return { id: 'seller', role: 'seller', storeId: 'local', store: stores[0] }; } },
  };
  vm.runInNewContext(routeSource, {
    prisma, router: { get(_route, _middleware, fn) { handler = fn; } },
    optionalCatalogAuth() {}, formatProductCard: p => p, console: { error() {} },
  });
  return { queries, async request(params, role = 'seller') {
    let body, status = 200;
    const headers = {};
    await handler({ query: params, userId: role ? 'seller' : null, userRole: role }, {
      set(k, v) { headers[k] = v; return this; },
      status(v) { status = v; return this; },
      json(v) { body = v; },
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(headers['Cache-Control'], 'no-store');
    return JSON.parse(JSON.stringify(body));
  } };
}
async function main() {
  const rows = fixtures(), before = JSON.stringify(rows), api = server(rows);
  const common = { includeSizeOptions: '1', inStore: '1' };
  const first = await api.request({ ...common, pageSize: '24', size: 'P', category: 'roupa', brand: 'Marca A' });
  assert.equal(first.products.length, 24);
  assert.deepEqual(first.sizeOptions, ['PP', 'P', 'M', 'G', 'GG', 'XG', 'G1', '2', '4', '10', '12']);
  assert.equal(first.products.some(p => p.id === 'camiseta-grade'), false, 'M/G/GG options come from products after page one');
  const second = await api.request({ ...common, page: '2', limit: '1', size: 'M', category: 'roupa', brand: 'Marca A' });
  assert.deepEqual(second.sizeOptions, first.sizeOptions, 'Changing page, limit or selected size does not narrow the size facet');
  assert.equal(second.products.length, 0, 'Selected product result retains its own pagination');

  const clothing = await api.request({ ...common, q: 'camiseta', size: 'M' });
  assert.deepEqual(clothing.sizeOptions, ['PP', 'P', 'M', 'G', 'GG', 'XG']);
  assert.deepEqual(clothing.products.map(p => p.id), ['camiseta-grade'], 'Exact M must not select P, G or GG');
  const publicOptions = await api.request({ ...common, brand: 'Marca A' }, null);
  assert.ok(!publicOptions.sizeOptions.includes('G1') && !publicOptions.sizeOptions.includes('G3'), 'Anonymous users never discover inactive product sizes');
  const staffOptions = await api.request(common);
  assert.ok(staffOptions.sizeOptions.includes('G1') && !staffOptions.sizeOptions.includes('G3'), 'Staff visibility keeps real inactive stock but excludes zero-price inactive copies');
  assert.ok(staffOptions.sizeOptions.includes('G2'), 'Another brand is included when brand is not selected');
  for (const pending of ['?', '', ' ', 'T-1234', 't-4567', 'A DEFINIR', 'ADEFINIR', 'SEM TAMANHO', '—', '-']) assert.ok(!staffOptions.sizeOptions.includes(pending));
  for (const literal of ['Único', 'U', '35-38', '38/39', '39.5']) assert.ok(staffOptions.sizeOptions.includes(literal), `Preserve literal size without converting: ${literal}`);
  for (const unavailable of ['XXG', 'XXXG', 'G4', '39']) assert.ok(!staffOptions.sizeOptions.includes(unavailable), `Exclude purchased, zero or negative physical size: ${unavailable}`);

  const footwearQuery = { ...common, type: 'Tênis', gender: 'Masculino', modality: 'Corrida', tier: 'pro' };
  const footwear = await api.request(footwearQuery);
  assert.deepEqual(footwear.sizeOptions, ['39.5', '40', '45'], 'Primary and secondary classification use the same filter semantics');
  const local = await api.request({ ...footwearQuery, storeId: 'local', size: '39' });
  assert.deepEqual(local.sizeOptions, ['39.5', '40']);
  assert.deepEqual(local.products, [], '40 positive does not make 39 available');
  const remote = await api.request({ ...footwearQuery, storeCode: 'LOJA05' });
  assert.deepEqual(remote.sizeOptions, ['45']);
  const mine = await api.request({ ...footwearQuery, myStoreStock: '1' });
  assert.deepEqual(mine.sizeOptions, local.sizeOptions, 'Authenticated my-store scope applies to options');
  const scopeRemote = await api.request({ ...footwearQuery, stockScope: 'store', storeId: 'remote' });
  assert.deepEqual(scopeRemote.sizeOptions, ['45']);
  const scopeAll = await api.request({ ...footwearQuery, stockScope: 'all' });
  assert.deepEqual(scopeAll.sizeOptions, footwear.sizeOptions);

  const countBefore = api.queries.length;
  const unchanged = await api.request({ size: '39' });
  assert.equal(Object.hasOwn(unchanged, 'sizeOptions'), false, 'Legacy response shape remains unchanged without opt-in');
  assert.equal(api.queries.length, countBefore, 'No facet query without opt-in');
  assert.ok(unchanged.products.some(p => p.id === 'tenis'), 'Opt-out preserves catalog historical-size behavior');
  assert.deepEqual((await api.request({ ...common, category: 'inexistente' })).sizeOptions, []);
  assert.equal(JSON.stringify(rows), before, 'Reading size options never alters variants or balances');
  const literals = server([
    product('literal-spaced', [variant(' M ', 10, [['local', 2]])]),
    product('literal-plain', [variant('M', 10, [['local', 7]])]),
    product('literal-both', [variant(' M ', 10, [['local', 2]]), variant('M', 10, [['local', 7]])]),
  ]);
  const spaced = await literals.request({ ...common, size: ' M ', exactSize: '1' });
  assert.deepEqual(spaced.products.map(p => p.id), ['literal-spaced', 'literal-both']);
  assert.deepEqual(spaced.sizeOptions, [' M ', 'M'], 'Literal variants are not merged or renamed in the facet');
  const plainSize = await literals.request({ ...common, size: 'M', exactSize: '1' });
  assert.deepEqual(plainSize.products.map(p => p.id), ['literal-plain', 'literal-both']);
  const legacySize = await literals.request({ ...common, size: ' M ' });
  assert.deepEqual(legacySize.products.map(p => p.id), plainSize.products.map(p => p.id), 'Calls without exactSize preserve their existing trimmed search');
  console.log('PASS catalog size options: complete facet, exact variants, physical store scope, visibility, all product families, literal sizes, classification2, pending exclusion and opt-out compatibility.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
