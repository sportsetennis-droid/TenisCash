const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/loja.html'), 'utf8');
const source = html.slice(html.indexOf('function _cleanSellerSize(value)'), html.indexOf('\nfunction _askSizeForBipe('));

async function scan(product, answer) {
  const input = { value: '2015052069439', focus() {} };
  const message = { style: {} };
  const added = [];
  const context = {
    document: { getElementById: id => id === 'sellBipeInput' ? input : message },
    api: async () => ({ recognized: true, product }),
    prompt: () => answer,
    alert() {},
    addToCart: (...args) => added.push(args),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  await context.onSellBipe();
  return { added, message };
}

(async () => {
  const product = { id: 'nike-dm3982', name: 'Porta calçado Nike DM3982-010', price: 160.64, productSizeId: null, size: null };
  const internalBarcode = await scan(product, 'Único');
  const item = internalBarcode.added[0][5];
  assert.equal(item.productSizeId, null);
  assert.equal(item.size, 'ÚNICO');
  assert.equal(item.sellerSize, 'ÚNICO');
  assert.equal(item.barcode, '2015052069439');
  assert.equal(item.isNewSize, undefined, 'Bipe de código interno não deve criar outra variante');

  const exactBarcode = await scan({ ...product, productSizeId: 'known-size', size: '40' }, '40');
  assert.equal(exactBarcode.added[0][5].productSizeId, 'known-size');
  assert.equal(exactBarcode.added[0][5].size, '40');

  const canceled = await scan(product, '');
  assert.equal(canceled.added.length, 0);
  console.log('ALL_PASS bipe encaminha tamanho manual e preserva variante reconhecida');
})().catch(error => { console.error(error); process.exitCode = 1; });
