const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
const start = html.indexOf('function _cleanSellerSize(value)');
const end = html.indexOf('\nfunction addToCartById(', start);
assert.ok(start >= 0 && end > start, 'fluxo manual de tamanho nao encontrado');
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
  vm.runInContext(functionSource, context, { filename: 'loja-manual-size.js' });
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
assert.equal(legacy.selected.sellerSize, 'M');
assert.match(legacy.prompts[0], /DIGITE MANUALMENTE O TAMANHO/);

const canceledLegacy = choose({ name: 'Camiseta Legada', sizes: [] }, { answer: '' });
assert.equal(canceledLegacy.selected, null);
assert.match(canceledLegacy.alerts[0], /Digite o tamanho antes/);

const multiStore = {
  name: 'Tenis Multiloja',
  sizes: [
    { id: 'size-38', size: '38', storeStocks: [{ storeId: 'store-b', stock: 4 }] },
    { id: 'size-39', size: '39', storeStocks: [{ storeId: 'store-a', stock: 2 }] },
    { id: 'size-40', size: '40', storeStocks: [{ storeId: 'store-a', stock: 0 }] },
  ],
};
const localOnly = choose(multiStore, { storeId: 'store-a', answer: '39' });
assert.equal(localOnly.selected.id, 'size-39');
assert.equal(localOnly.selected.sellerSize, '39');
assert.equal(localOnly.prompts.length, 1);

const noLocalStock = choose(multiStore, { storeId: 'store-c', answer: '40' });
assert.equal(noLocalStock.selected.id, 'size-40');
assert.match(noLocalStock.prompts[0], /saldo nesta loja: 0/);

const pendingSingle = choose({
  name: 'Tenis Pendente',
  sizes: [{ id: 'technical', size: 'T-789', sizeConfirmedAt: null, storeStocks: [{ storeId: 'store-a', stock: 1 }] }],
}, { answer: '42' });
assert.equal(pendingSingle.selected.id, 'technical');
assert.equal(pendingSingle.selected.sellerSize, '42');

const pendingAmbiguous = choose({
  name: 'Tenis Pendente Multiplo',
  sizes: [
    { id: 'technical-a', size: 'T-111', sizeConfirmedAt: null, storeStocks: [{ storeId: 'store-a', stock: 1 }] },
    { id: 'technical-b', size: 'T-222', sizeConfirmedAt: null, storeStocks: [{ storeId: 'store-a', stock: 1 }] },
  ],
}, { answer: '43' });
assert.equal(pendingAmbiguous.selected.id, null);
assert.equal(pendingAmbiguous.selected.size, '43');
assert.equal(pendingAmbiguous.selected.sellerSize, '43');
assert.equal(pendingAmbiguous.selected.isNewSize, true);

assert.match(html, /isNewSize: !!i\.isNewSize/);
assert.match(html, /isNewSize: !!opts\.isNewSize/);
assert.match(html, /sellerSize: i\.sellerSize \|\| null/);
assert.match(html, /DIGITE MANUALMENTE O TAMANHO/);
assert.match(html, /TAMANHO MANUAL:/);
assert.match(html, /function editCartSellerSize/);
assert.doesNotMatch(html, /TAMANHO INFORMADO PELO VENDEDOR — OPCIONAL/);
assert.match(html, /sellerSize, sizeConfirmedAt/);

const sellerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'seller.js'), 'utf8');
assert.match(sellerSource, /Digite manualmente o tamanho de \$\{p\.name\} ao escolher o produto/);

const biparHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'bipar.html'), 'utf8');
assert.match(biparHtml, /o estoque já foi somado\. Você pode informar agora ou deixar para depois/);
assert.match(biparHtml, /id="size-skip" onclick="pularTamanho\(\)"/);
assert.doesNotMatch(biparHtml, /O tamanho é obrigatório/);

const stocktakeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'stocktake.js'), 'utf8');
assert.match(stocktakeSource, /function sizeConfirmationBlocksStock\(\) \{\s*return false;/);

console.log('ALL_PASS loja sale selection (manual size at selection, edit in cart, backend requirement, payload)');
