const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const context = { window: {}, document: { readyState: 'loading', addEventListener() {} }, setTimeout() {}, clearTimeout() {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync('public/_product-card.js', 'utf8'), context);
const product = { id: 'p', name: 'Chuteira', brand: 'Umbro', price: 100, sizes: [
  { id: 's34', size: '34', stock: 6, storeStocks: [] },
  { id: 's35', size: '35', stock: 6, storeStocks: [] },
], verification: [{ productSizeId: 's34', size: '34', storeId: 'loja06', status: 'verified', available: 1 }] };
const render = (p = product, opts = {}) => context.window.PCard.render(p, { actions: 'public', onlyStoreId: 'loja06', ...opts });
assert.match(render(), /Disponível na conferência atual/);
assert.doesNotMatch(render(), /Sem estoque nesta loja/);
assert.match(render(product, { onlyStoreId: 'loja05' }), /Sem estoque nesta loja/);
assert.match(render(product, { selectedSize: '35' }), /Sem estoque nesta loja/);
assert.match(render({ ...product, verification: [{ ...product.verification[0], available: 0 }] }), /Sem estoque nesta loja/);
assert.match(render({ ...product, verification: [{ ...product.verification[0], status: 'pending' }] }), /Sem estoque nesta loja/);
const page = fs.readFileSync('public/loja.html', 'utf8');
const chooser = page.slice(page.indexOf('function _chooseSaleSize(p)'), page.indexOf('function addToCartById('));
let displayed = '', answer = '34';
context.activeStore = { id: 'loja06' };
context._promptManualSellerSize = (name, message) => { displayed = message; return answer; };
vm.runInContext(chooser, context);
assert.equal(context._chooseSaleSize(product).id, 's34');
assert.match(displayed, /34 \(conferido nesta rodada: 1\)/);
assert.doesNotMatch(displayed, /35|saldo nesta loja: 0/);
answer = '40';
assert.equal(context._chooseSaleSize(product).id, null, 'another size cannot silently consume the only verified variant');
assert.equal(product.sizes[0].stock, 6, 'purchased stock remains unchanged');
console.log('PASS partial sale: store isolation, size isolation, depleted and pending counts, correct size selection, no invented balance');
