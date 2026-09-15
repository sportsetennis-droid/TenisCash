const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { server, product, variant, ui, paramsFor, renderedIds, section } = require('./test-curation-size-filter');

const html = fs.readFileSync(path.join(__dirname, '..', 'public/loja.html'), 'utf8');
function sizedProduct(id, label, category = 'Vestuário') {
  const item = product(id, [variant(label, 777, [['remote', 1]])]);
  item.name = `Produto ${id}`;
  item.category = category;
  item.aiContext = {};
  return item;
}

async function main() {
  // More than a page of M apparel precedes all the other variants. Options must
  // come from the API facet across the catalog, not from the 24 rendered cards.
  const rows = Array.from({ length: 25 }, (_, index) => sizedProduct(`shirt-m-${index}`, 'M'));
  const literals = ['PP', 'P', 'G', 'GG', 'XG', '2 anos', 'Único', 'M/G', '39.5', '39,5', '35/38', ' M '];
  literals.forEach((label, index) => rows.push(sizedProduct(`literal-${index}`, label,
    ['39.5', '39,5'].includes(label) ? 'Calçados' : label === '35/38' ? 'Meias' : 'Vestuário')));
  rows.push(sizedProduct('unknown', '?'));
  rows.push(sizedProduct('placeholder', 'T-39'));
  rows.push({ ...sizedProduct('depleted-g', 'G'), sizes: [variant('G', 888, [['local', 0]])] });
  rows.push({ ...sizedProduct('purchased-XXG', 'XXG'), sizes: [variant('XXG', 999)] });
  const backend = server(rows);
  const view = ui({ api: url => backend.request(url), selectedSize: null, query: '' });
  await view.search(); await view.runTimer();
  assert.equal(paramsFor(view.requests[0]).get('includeSizeOptions'), '1');
  assert.equal(paramsFor(view.requests[0]).has('type'), false, 'Sizes are available before choosing a footwear type');
  assert.equal(view.cardCalls.length, 24);
  assert.ok(view.cardCalls.every(call => call.product.sizes[0].size === 'M'));
  const offered = Array.from(view.sizeCalls.at(-1).options);
  assert.deepEqual(new Set(offered), new Set(['M', ...literals]), 'All physical sizes outside the first page are offered, retaining literal labels');
  assert.ok(!offered.includes('?') && !offered.includes('T-39') && !offered.includes('XXG'));
  assert.equal(view.pageCalls.at(-1).totalPages, 2);
  view.cardCalls.length = 0;
  await view.search(null, '', 2); await view.runTimer();
  assert.equal(paramsFor(view.requests.at(-1)).get('page'), '2');
  assert.ok(renderedIds(view).includes('shirt-m-24') && renderedIds(view).includes('literal-10'), 'Products beyond the first page can be reached');
  assert.equal(view.pageCalls.at(-1).page, 2);

  for (const label of ['M', ...literals]) {
    view.cardCalls.length = 0;
    await view.search(label, ''); await view.runTimer();
    const params = paramsFor(view.requests.at(-1));
    assert.equal(params.get('size'), label, `Exact literal is sent without conversion: ${label}`);
    assert.equal(params.get('exactSize'), '1', 'The API is asked to preserve the exact stored label');
    assert.equal(params.get('page'), '1', 'Changing a filter returns to the first page');
    assert.equal(params.get('inStore'), '1');
    assert.ok(view.cardCalls.length > 0, `Size ${label} is reachable without a product-type selection`);
    assert.ok(view.cardCalls.every(call => call.product.sizes.some(s => s.size === label && s.storeStocks.some(ss => ss.stock > 0))), `Every result has the exact available variant: ${label}`);
    assert.ok(view.cardCalls.every(call => call.opts.selectedSize === label));
    assert.deepEqual(new Set(Array.from(view.sizeCalls.at(-1).options)), new Set(['M', ...literals]), 'Choosing a size does not hide the other available size options');
  }
  await view.search('M', ''); view.cardCalls.length = 0; await view.runTimer();
  assert.ok(renderedIds(view).every(id => id.startsWith('shirt-m-')), 'M does not match G, GG or M/G');

  view.ps.category = 'Meias';
  view.cardCalls.length = 0;
  await view.search(null, ''); await view.runTimer();
  assert.deepEqual(Array.from(view.sizeCalls.at(-1).options), ['35/38'], 'Category filtering limits the actual size options to its own products');
  assert.deepEqual(renderedIds(view), ['literal-10']);
  view.ps.category = 'Calçados';
  await view.search('39.5', ''); await view.runTimer();
  assert.deepEqual(new Set(Array.from(view.sizeCalls.at(-1).options)), new Set(['39.5', '39,5']), 'Fractional labels remain distinct as stored; there is no guessed conversion');

  // Stale responses may contain a valid-looking but obsolete facet; neither the
  // product list nor the size selector may move back to the previous search.
  const pending = [];
  const race = ui({ selectedSize: 'M', query: '', api: url => new Promise(resolve => pending.push({ url, resolve })) });
  await race.search('M'); const oldWork = race.runTimer();
  await race.search('G'); const newWork = race.runTimer();
  pending[1].resolve({ products: [sizedProduct('latest-g', 'G')], sizeOptions: ['G', 'GG'] });
  await newWork;
  const optionCalls = race.sizeCalls.length;
  const pageCalls = race.pageCalls.length;
  pending[0].resolve({ products: [sizedProduct('stale-m', 'M')], sizeOptions: ['M', 'P'] });
  await oldWork;
  assert.equal(race.sizeCalls.length, optionCalls, 'An obsolete API response does not redraw size options');
  assert.equal(race.pageCalls.length, pageCalls, 'An obsolete API response does not redraw pagination');
  assert.deepEqual(Array.from(race.sizeCalls.at(-1).options), ['G', 'GG']);
  assert.equal(race.sizeCalls.at(-1).selectedSize, 'G');

  verifySizeSelector();
  console.log('PASS all product sizes: exact apparel/children/unique/fraction/range labels, independent categories, API facets beyond the first page, literal UI selection and stale-facet protection.');
}

function verifySizeSelector() {
  const stateSource = section(html, 'const PRODUCT_TREE =', '// ============== HELPERS VISUAIS');
  const treeSource = section(html, 'function renderFilterTree(', 'let catSearchTimer;');
  assert.ok(!stateSource.includes('const SIZE_LIST'), 'The static footwear-only size list has been removed');
  const elements = new Map();
  const calls = [];
  const context = {
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', value: '' });
      return elements.get(id);
    } },
    window: { onCatalogSearch: () => calls.push('catalog'), onInventorySearchFromTree: () => calls.push('inventory') },
    escPreco: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  };
  vm.createContext(context);
  vm.runInContext(stateSource + treeSource, context);
  context.renderFilterTree('catalogTree', 'onCatalogSearch');
  const initialTree = elements.get('catalogTree').innerHTML;
  assert.match(initialTree, /Todos os produtos|Todos produtos/i, 'The user can select products beyond footwear');
  assert.match(elements.get('catalogTreeSizes').innerHTML, /Tamanho/, 'The size selector is visible without selecting Tênis or Chuteira');
  const labels = ['PP', 'P', 'M', 'G', 'GG', '2 anos', 'Único', '39.5', '35/38', ' M '];
  context.renderSizeOptions('catalogTree', labels, 'M');
  const markup = [...elements.values()].map(element => element.innerHTML).join('\n');
  for (const label of labels) assert.ok(markup.includes(label), `The selector exposes ${label}`);
  assert.match(markup, /<select\b/, 'One selector handles all catalog sizes without a fixed footwear grid');
  assert.match(markup, /value="M"[^>]*selected|selected[^>]*value="M"/, 'The selected literal size remains visibly selected');
  for (const label of ['M', 'G', 'GG', '2 anos', 'Único', '39.5', '35/38', ' M ']) {
    context.pickFilter('size', label, 'catalogTree');
    assert.equal(vm.runInContext('_filterSize', context), label, `Picking a literal does not coerce or expand it: ${label}`);
  }
  context.pickFilter('type', '', 'catalogTree');
  assert.ok(!vm.runInContext('_filterType', context));
  assert.equal(vm.runInContext('_filterSize', context), null, 'Switching product scope clears the previous size coherently');
  context.pickFilter('size', 'P', 'inventoryTree');
  assert.equal(vm.runInContext('_filterSize', context), 'P');
  assert.equal(calls.at(-1), 'inventory', 'The same literal selector works in Estoque');
  context.clearFilters('catalogTree');
  assert.equal(vm.runInContext('_filterSize', context), null);
  context.renderSizeOptions('catalogTree', [], 'M');
  assert.match(elements.get('catalogTreeSizes').innerHTML, /M — sem estoque neste filtro/, 'A depleted selection stays visible instead of changing silently');
  context.renderSizeOptions('catalogTree', null, 'M', true);
  assert.match(elements.get('catalogTreeSizes').innerHTML, /Não foi possível carregar/);
  assert.ok(!elements.get('catalogTreeSizes').innerHTML.includes('Carregando tamanhos'));
  context.renderProductPages('catalogPages', 1, 2);
  assert.match(elements.get('catalogPages').innerHTML, /onCatalogSearch\(2\)/);
  assert.match(elements.get('catalogPages').innerHTML, /onclick="onCatalogSearch\(0\)" disabled/);
  context.renderProductPages('invPages', 2, 2);
  assert.match(elements.get('invPages').innerHTML, /onInventorySearch\(1\)/);
  assert.match(elements.get('invPages').innerHTML, /onclick="onInventorySearch\(3\)" disabled/);
  context.renderProductPages('catalogPages', 1, 1);
  assert.equal(elements.get('catalogPages').innerHTML, '');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
