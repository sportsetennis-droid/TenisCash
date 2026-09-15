const assert = require('node:assert/strict');
const PCard = require('../public/_product-card');

// Render the production card without browser/network effects or stock mutations.
const stores = {
  local: { id: 'local', code: 'LOJA02', name: 'Bessa' },
  remote: { id: 'remote', code: 'LOJA05', name: 'Tambau' },
  empty: { id: 'empty', code: 'LOJA06', name: 'Tambia' },
};
const variant = (size, purchased, balances = []) => ({
  id: `size-${size}`, size, stock: purchased,
  storeStocks: balances.map(([id, stock]) => ({ storeId: id, stock, store: stores[id] })),
});
const product = (id, sizes) => ({ id, sku: `REF-${id}`, name: `Tenis ${id}`, brand: 'Marca', sizes, price: 100 });
const render = (value, opts = {}) => PCard.render(value, { actions: 'public', physicalStockOnly: true, ...opts });
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const hasPill = (html, size) => new RegExp('>' + size.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:<span|</span>)').test(html);

const unavailable = product('esgotado', [
  variant('39', 12, [['local', 0], ['remote', -2]]),
  variant('40', 5, [['local', 3]]),
  variant('39.5', 1, [['local', 1]]),
  variant('139', 1, [['local', 1]]),
]);
let html = render(unavailable, { selectedSize: '39' });
assert.match(plain(html), /Sem estoque físico no tamanho 39/);
assert.doesNotMatch(html, /Tamanhos disponíveis|LOJA02|LOJA05/);
for (const size of ['39', '40', '39.5', '139']) assert.equal(hasPill(html, size), false, `No unavailable/unselected size pill: ${size}`);

const available = product('disponivel', [
  variant('39', 12, [['local', 2], ['remote', 1], ['empty', 0]]),
  variant('40', 5, [['local', 7]]),
]);
const before = JSON.stringify(available);
html = render(available, { selectedSize: '39' });
assert.match(plain(html), /Estoque físico por loja — tamanho 39 3 un\. total/);
assert.match(plain(html), /Estoque comprado do produto \(todos os tamanhos\) 17 un/);
assert.match(html, /LOJA02/);
assert.match(html, /LOJA05/);
assert.doesNotMatch(html, /LOJA06/);
assert.ok(hasPill(html, '39'));
assert.equal(hasPill(html, '40'), false);
assert.match(plain(html), /LOJA02 Bessa 2 un\./);
assert.match(plain(html), /LOJA05 Tambau 1 un\./);

html = render(available);
assert.ok(hasPill(html, '39') && hasPill(html, '40'), 'Unfiltered view keeps each available size');
assert.match(plain(html), /10 un\. total/);
assert.doesNotMatch(plain(html), /todos os tamanhos/);

const purchasedOnly = product('apenas-comprado', [variant('39', 20)]);
html = render(purchasedOnly, { selectedSize: '39' });
assert.match(plain(html), /Sem estoque físico no tamanho 39/);
assert.doesNotMatch(html, /Tamanhos disponíveis/);
assert.equal(hasPill(html, '39'), false);
assert.match(plain(render(purchasedOnly)), /Sem estoque físico/);
assert.match(PCard.render(purchasedOnly, { actions: 'public' }), /Tamanhos disponíveis/, 'Legacy callers keep their existing fallback without the new option');
const knownZero = product('saldo-zero', [variant('39', 20, [['local', 0]])]);
assert.doesNotMatch(PCard.render(knownZero, { actions: 'public' }), /Tamanhos disponíveis/, 'Existing zero stock rows must never activate the legacy purchased fallback');

const otherReference = product('outra-referencia', [variant('39', 2, [['remote', 2]])]);
assert.match(plain(render(otherReference, { selectedSize: '39' })), /2 un\. total/);
assert.match(plain(render(unavailable, { selectedSize: '39' })), /Sem estoque físico no tamanho 39/, 'Stock never leaks from another product rendered previously');
assert.match(plain(render(available, { selectedSize: '39' })), /3 un\. total/);

html = render(available, { selectedSize: '39', onlyStoreId: 'local' });
assert.match(plain(html), /2 un\. total/);
assert.match(html, /LOJA02/);
assert.doesNotMatch(html, /LOJA05|LOJA06/);
assert.equal(hasPill(html, '40'), false);
assert.match(plain(render(available, { selectedSize: '39', onlyStoreId: 'empty' })), /Sem estoque físico no tamanho 39 nesta loja/);
// Some catalog callers include store.id but do not select storeId explicitly.
const nestedStore = product('nested-store', [variant('39', 1, [['local', 1]])]);
delete nestedStore.sizes[0].storeStocks[0].storeId;
assert.match(plain(render(nestedStore, { selectedSize: '39', onlyStoreId: 'local' })), /1 un\. total/);

const literalSizes = product('literal-variants', [
  variant(' M ', 10, [['local', 2]]),
  variant('M', 10, [['local', 7]]),
]);
html = render(literalSizes, { selectedSize: ' M ' });
assert.match(plain(html), /2 un\. total/);
assert.ok(hasPill(html, ' M '));
assert.equal(hasPill(html, 'M'), false, 'A literal size with spaces never borrows the plain-size balance');
html = render(literalSizes, { selectedSize: 'M' });
assert.match(plain(html), /7 un\. total/);
assert.ok(hasPill(html, 'M'));
assert.equal(hasPill(html, ' M '), false);
assert.match(plain(render(literalSizes)), /9 un\. total/, 'Both variants remain independently counted in the complete grid');

assert.equal(JSON.stringify(available), before, 'Rendering leaves product variants and balances untouched');
assert.doesNotMatch(render(available, { selectedSize: '39', showStock: false }), /Estoque físico|Estoque comprado|Sem estoque físico/);

const legacyName = { ...available, name: 'TENIS MODELO 43 REF-ABC43 PRETO -Tam:43' };
assert.equal(PCard.productDisplayName(legacyName), 'TENIS MODELO 43 REF-ABC43 PRETO');
assert.doesNotMatch(render(legacyName, { selectedSize: '39' }), /Tam:43/);
assert.match(plain(render(legacyName, { selectedSize: '39' })), /MODELO 43 REF-ABC43 PRETO/);
assert.match(PCard.render(legacyName, { actions: 'public' }), /-Tam:43/, 'Legacy renderers preserve the original name');
assert.equal(legacyName.name, 'TENIS MODELO 43 REF-ABC43 PRETO -Tam:43', 'Display helper does not edit the registration');
for (const name of ['TENIS MODELO 43', 'TENIS -Tam:43 PRETO', 'TENIS REF-Tam:ABC', 'TENIS -Tam:']) {
  assert.equal(PCard.productDisplayName({ ...available, name }), name, `Preserve names without the exact final legacy suffix: ${name}`);
}
assert.equal(PCard.productDisplayName({ name: 'TENIS -Tam:43', sizes: [] }), 'TENIS -Tam:43');
assert.equal(PCard.productDisplayName({ name: 'TENIS -Tam:43' }), 'TENIS -Tam:43');
assert.equal(PCard.productDisplayName({ ...available, name: 'TENIS -Tam:39.5' }), 'TENIS');
assert.equal(PCard.productDisplayName({ ...available, name: 'TENIS -Tam:39,5' }), 'TENIS');
const pending = product('tamanhos-pendentes', [
  variant('?', 1, [['local', 1]]),
  variant('', 1, [['local', 1]]),
  variant('T-EAN', 1, [['local', 1]]),
  variant('39', 1, [['local', 1]]),
]);
html = render(pending);
assert.match(plain(html), /3 un\. sem tamanho — definir/);
assert.match(plain(html), /4 un\. total/);
assert.doesNotMatch(html, />\?<\/span>|>T-EAN</);
assert.ok(hasPill(html, '39'));
html = render(pending, { selectedSize: '39' });
assert.match(plain(html), /1 un\. total/);
assert.doesNotMatch(html, /sem tamanho|T-EAN/);
console.log('PASS product card physical sizes: exact variant, current positive stock, store scope, purchased-only, separate products, legacy name presentation, pending sizes and unchanged legacy options.');
