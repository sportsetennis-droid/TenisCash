const assert = require('node:assert/strict');
const {
  SaleStockError,
  resolveProductSize,
  planSaleProductSize,
  applyStoreStockDelta,
} = require('../src/services/storeStockLedger');

const product = {
  id: 'p1',
  name: 'Tênis Teste',
  sizes: [
    { id: 'ps40', size: '40', barcode: '78940' },
    { id: 'ps41', size: '41', barcode: '78941' },
  ],
};

function expectSaleError(fn, contains) {
  assert.throws(fn, (err) => err instanceof SaleStockError && err.message.includes(contains));
}

function fakeTransaction(initialStock) {
  let stock = initialStock;
  const movements = [];
  return {
    movements,
    storeStock: {
      async upsert(args) {
        const delta = args.update.stock.increment;
        stock = stock == null ? args.create.stock : stock + delta;
        return {
          id: 'ss1',
          storeId: args.create.storeId,
          productSizeId: args.create.productSizeId,
          stock,
        };
      },
    },
    storeStockMovement: {
      async create({ data }) {
        movements.push(data);
        return { id: `mov${movements.length}`, ...data };
      },
    },
  };
}

async function main() {
  assert.equal(resolveProductSize(product, { productSizeId: 'ps41' }).id, 'ps41');
  assert.equal(resolveProductSize(product, { barcode: '78940' }).id, 'ps40');
  assert.equal(resolveProductSize(product, { size: '41' }).id, 'ps41');
  assert.equal(resolveProductSize({ ...product, sizes: [product.sizes[0]] }, {}).id, 'ps40');
  expectSaleError(() => resolveProductSize(product, {}), 'Escolha o tamanho');
  expectSaleError(() => resolveProductSize(product, { productSizeId: 'outra' }), 'Tamanho invalido');
  expectSaleError(() => resolveProductSize({ ...product, sizes: [] }, {}), 'sem tamanho cadastrado');
  const adidasConfirmed = { ...product, brand: 'ADIDAS', sizes: [{ ...product.sizes[0], sizeConfirmedAt: new Date() }] };
  assert.equal(resolveProductSize(adidasConfirmed, {}).id, 'ps40');
  const adidasUnconfirmed = { ...product, brand: 'ADIDAS', sizes: [{ ...product.sizes[0], size: 'T-78940', sizeConfirmedAt: null }] };
  assert.equal(resolveProductSize(adidasUnconfirmed, {}).id, 'ps40');
  const nikeUnconfirmed = { ...product, brand: 'NIKE', sizes: [{ ...product.sizes[0], sizeConfirmedAt: null }] };
  assert.equal(resolveProductSize(nikeUnconfirmed, {}).id, 'ps40');
  const genericPlaceholder = { ...product, brand: 'MIZUNO', sizes: [{ ...product.sizes[0], size: 'T-78940', sizeConfirmedAt: null }] };
  assert.equal(resolveProductSize(genericPlaceholder, {}).id, 'ps40');

  const legacyPlan = planSaleProductSize(
    { ...product, sizes: [] },
    { size: 'M', isNewSize: true },
  );
  assert.equal(legacyPlan.productSize, null);
  assert.equal(legacyPlan.needsNewProductSize, true);
  assert.equal(legacyPlan.requestedSize, 'M');
  expectSaleError(
    () => planSaleProductSize({ ...product, sizes: [] }, { size: 'M' }),
    'nao cadastrado',
  );
  const manualPlan = planSaleProductSize(product, { size: '42', isNewSize: true });
  assert.equal(manualPlan.productSize, null);
  assert.equal(manualPlan.needsNewProductSize, true);
  assert.equal(manualPlan.requestedSize, '42');
  const barcodePlan = planSaleProductSize(product, {
    size: '42', barcode: '78942', isNewBarcode: true,
  });
  assert.equal(barcodePlan.needsNewProductSize, true);
  assert.equal(barcodePlan.requestedSize, '42');

  const existing = fakeTransaction(5);
  const debit = await applyStoreStockDelta(existing, {
    storeId: 'store1',
    productSizeId: 'ps40',
    saleId: 'sale1',
    saleItemId: 'item1',
    quantity: -2,
    type: 'sale',
    source: 'test',
  });
  assert.equal(debit.stockBefore, 5);
  assert.equal(debit.stockAfter, 3);
  assert.equal(existing.movements[0].quantity, -2);

  const unlocated = fakeTransaction(null);
  const deficit = await applyStoreStockDelta(unlocated, {
    storeId: 'store1',
    productSizeId: 'ps41',
    saleId: 'sale2',
    saleItemId: 'item2',
    quantity: -1,
    type: 'sale',
  });
  assert.equal(deficit.stockBefore, 0);
  assert.equal(deficit.stockAfter, -1);
  assert.equal(unlocated.movements[0].stockAfter, -1);

  await assert.rejects(
    applyStoreStockDelta(fakeTransaction(1), {
      storeId: 'store1', productSizeId: 'ps40', quantity: 0, type: 'sale',
    }),
    SaleStockError,
  );

  console.log('ALL_PASS sale stock ledger (variant resolution, atomic delta, negative deficit, audit movement)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
