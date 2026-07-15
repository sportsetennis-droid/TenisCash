const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
const start = html.indexOf('function _chooseSaleSize(p)');
const end = html.indexOf('\nfunction addToCartById(', start);
assert.ok(start >= 0 && end > start, 'funcao _chooseSaleSize nao encontrada');
const functionSource = html.slice(start, end);

function choose(product, { storeId = 'store-a', answer = '' } = {}) {
  const alerts = [];
  const prompts = [];
  const context = {
    activeStore: { id: storeId },
    prompt(message) {
      prompts.push(message);
      return answer;
    },
    alert(message) {
      alerts.push(message);
    },
  };
  vm.createContext(context);
  vm.runInContext(functionSource, context, { filename: 'loja-_chooseSaleSize.js' });
  return {
    selected: context._chooseSaleSize(product),
    alerts,
    prompts,
  };
}

const legacy = choose({ name: 'Camiseta Legada', sizes: [] }, { answer: 'M' });
assert.equal(legacy.selected.size, 'M');
assert.equal(legacy.selected.id, null);
assert.equal(legacy.selected.isNewSize, true);
assert.match(legacy.prompts[0], /TAMANHO REAL/);

const canceledLegacy = choose({ name: 'Camiseta Legada', sizes: [] }, { answer: '' });
assert.equal(canceledLegacy.selected, null);
assert.match(canceledLegacy.alerts[0], /Informe o tamanho real/);

const multiStore = {
  name: 'Tenis Multiloja',
  sizes: [
    { id: 'size-38', size: '38', storeStocks: [{ storeId: 'store-b', stock: 4 }] },
    { id: 'size-39', size: '39', storeStocks: [{ storeId: 'store-a', stock: 2 }] },
    { id: 'size-40', size: '40', storeStocks: [{ storeId: 'store-a', stock: 0 }] },
  ],
};
const localOnly = choose(multiStore, { storeId: 'store-a' });
assert.equal(localOnly.selected.id, 'size-39');
assert.equal(localOnly.prompts.length, 0);

const noLocalStock = choose(multiStore, { storeId: 'store-c', answer: '40' });
assert.equal(noLocalStock.selected.id, 'size-40');
assert.match(noLocalStock.prompts[0], /saldo nesta loja: 0/);

assert.match(html, /isNewSize: !!i\.isNewSize/);
assert.match(html, /isNewSize: !!opts\.isNewSize/);
assert.match(html, /sellerSize: i\.sellerSize \|\| null/);
assert.match(html, /TAMANHO INFORMADO PELO VENDEDOR — OPCIONAL, NÃO TRAVA/);
assert.match(html, /function _isAdidasSizePending/);

console.log('ALL_PASS loja sale selection (legacy size, store-only choices, seller size without lock, payload)');
