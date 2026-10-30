const assert = require('assert');
const { sellerWorksInStore } = require('../src/services/sellerStoreAssignment');

const store07 = 'store-07';
assert.strictEqual(sellerWorksInStore({ storeId: store07, storeIds: [store07] }, store07), true, 'loja principal continua autorizada');
assert.strictEqual(sellerWorksInStore({ storeId: 'store-02', storeIds: ['store-02', store07] }, store07), true, 'vendedor multi-loja pode bater ponto na Loja 07 vinculada');
assert.strictEqual(sellerWorksInStore({ storeId: 'store-02', storeIds: ['store-02'] }, store07), false, 'vendedor sem vínculo à Loja 07 continua bloqueado');
assert.strictEqual(sellerWorksInStore({ storeId: null, storeIds: [] }, store07), false, 'vendedor sem loja continua bloqueado');

process.stdout.write('PASS: vínculo principal e multi-loja aceitos; vendedor não vinculado permanece bloqueado.\n');
