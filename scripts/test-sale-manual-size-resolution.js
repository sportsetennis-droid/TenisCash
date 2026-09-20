const assert = require('node:assert/strict');
const { SaleStockError, resolveProductSize, planSaleProductSize, applyStoreStockDelta } = require('../src/services/storeStockLedger');

// Reproduz a grade da referência DM3982-010: comprado e localização distintos.
const product = {
  id: 'nike-dm3982-010', name: 'Porta calçado Nike DM3982-010', internalBarcode: '2015052069439',
  sizes: [
    { id: 'legacy', size: 'UNICO', stock: 9, barcode: 'SEM GTIN', storeStocks: [{ storeId: 'loja06', stock: -1 }] },
    { id: 'located', size: 'Único', stock: 0, barcode: null, storeStocks: [{ storeId: 'loja05', stock: 9 }] },
  ],
};
const before = JSON.stringify(product);
const internalScan = { barcode: product.internalBarcode, productSizeId: null, size: null };

async function main() {
  assert.equal(planSaleProductSize(product, { ...internalScan, sellerSize: 'UNICO' }).productSize.id, 'legacy');
  assert.equal(planSaleProductSize(product, { ...internalScan, sellerSize: 'ÚNICO' }).productSize.id, 'located');
  assert.equal(planSaleProductSize(product, { ...internalScan, sellerSize: 'ÚNICO' }).needsNewProductSize, false);
  assert.equal(resolveProductSize(product, { productSizeId: 'located', sellerSize: 'UNICO', barcode: 'SEM GTIN' }).id, 'located', 'id explicitly selected must prevail');
  assert.equal(resolveProductSize(product, { barcode: 'SEM GTIN', sellerSize: 'ÚNICO' }).id, 'located', 'placeholder must not select the legacy variant');
  assert.throws(() => resolveProductSize(product, { barcode: 'SEM GTIN' }), /Escolha o tamanho/);
  assert.throws(() => planSaleProductSize(product, { ...internalScan, sellerSize: 'U' }), /Mais de uma variante/);
  assert.throws(() => planSaleProductSize(product, { size: 'U', sellerSize: 'U', isNewSize: true }), /Mais de uma variante/, 'ambiguity cannot create a third variant');
  assert.throws(() => planSaleProductSize(product, { size: 'P', sellerSize: 'P', barcode: 'SEM GTIN', isNewBarcode: true, isNewSize: true }), /SEM GTIN não é/, 'never learn placeholder as a barcode');
  assert.throws(() => planSaleProductSize(product, { ...internalScan, sellerSize: 'P' }), SaleStockError, 'manual label alone must not create an unknown variant');
  const single = { ...product, sizes: [product.sizes[1]] };
  assert.equal(resolveProductSize(single, { ...internalScan, sellerSize: 'U' }).id, 'located');
  assert.equal(resolveProductSize(single, { ...internalScan, sellerSize: 'UNICO' }).id, 'located');
  const duplicateCode = { ...product, sizes: product.sizes.map(s => ({ ...s, barcode: '789000123' })) };
  assert.throws(() => resolveProductSize(duplicateCode, { barcode: '789000123' }), /Mais de uma variante/);
  assert.equal(resolveProductSize(duplicateCode, { barcode: '789000123', productSizeId: 'located' }).id, 'located');

  // Finalizar em loja sem saldo continua usando o razão local, sem inventar
  // estoque comprado nem retirar de uma loja diferente automaticamente.
  const balances = new Map([['loja05:located', 9]]), movements = [];
  const tx = {
    storeStock: { async upsert({ create, update }) {
      const key = `${create.storeId}:${create.productSizeId}`;
      const stock = balances.has(key) ? balances.get(key) + update.stock.increment : create.stock;
      balances.set(key, stock); return { ...create, stock };
    } },
    storeStockMovement: { async create({ data }) { movements.push(data); return data; } },
  };
  const selected = planSaleProductSize(product, { ...internalScan, sellerSize: 'ÚNICO' }).productSize;
  await applyStoreStockDelta(tx, { storeId: 'loja06', productSizeId: selected.id, quantity: -1, type: 'sale', saleId: 'test-sale', saleItemId: 'test-item' });
  assert.equal(balances.get('loja05:located'), 9);
  assert.equal(balances.get('loja06:located'), -1);
  assert.equal(movements[0].quantity, -1);
  assert.equal(JSON.stringify(product), before, 'resolving a manual size never changes purchased stock, labels or barcodes');
  console.log('PASS sale manual size: internal barcode, exact variant, safe unique equivalence, ambiguous refusal, SEM GTIN protection and local ledger isolation');
}
main().catch(err => { console.error(err); process.exitCode = 1; });
