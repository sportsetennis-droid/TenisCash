const assert = require('node:assert/strict');
const { applyOrderStock, preservedPayload, remoteStockDiffers } = require('../src/services/nuvemshopStockSafety');

function database(initialStock = 5, mapping = null) {
  let data = { stock: initialStock, mapping };
  let queue = Promise.resolve();
  return {
    get data() { return data; },
    $transaction(run) {
      const operation = queue.then(async () => {
        const draft = structuredClone(data);
        const tx = {
          $executeRaw: async () => 1,
          nuvemshopOrderMapping: {
            findUnique: async () => draft.mapping,
            upsert: async ({ update, create }) => { draft.mapping = draft.mapping ? { ...draft.mapping, ...update } : create; },
          },
          store: { findFirst: async () => ({ id: 'store' }) },
          nuvemshopVariantMapping: { findFirst: async () => null },
          productSize: { findMany: async ({ where }) => where.barcode === 'EAN' ? [{ id: 'size' }] : [] },
          storeStock: {
            findMany: async () => [{ id: 'stock', storeId: 'store', stock: draft.stock }],
            updateMany: async ({ where, data: change }) => {
              if (draft.stock < where.stock.gte) return { count: 0 };
              draft.stock -= change.stock.decrement;
              return { count: 1 };
            },
            update: async ({ data: change }) => { draft.stock += change.stock.increment; },
          },
        };
        const result = await run(tx);
        data = draft;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}

(async () => {
  const order = { id: 1, number: 102, status: 'open', payment_status: 'paid', products: [{ sku: 'EAN', quantity: 2 }] };
  const db = database();
  await Promise.all([applyOrderStock(db, order), applyOrderStock(db, order)]);
  assert.equal(db.data.stock, 3, 'simultaneous deliveries deduct once');
  await applyOrderStock(db, { ...order, shipping_status: 'fulfilled' });
  await applyOrderStock(db, order);
  assert.equal(db.data.stock, 3, 'updated/paid/updated retains the receipt');
  await applyOrderStock(db, { ...order, status: 'cancelled' });
  await applyOrderStock(db, { ...order, status: 'cancelled' });
  assert.equal(db.data.stock, 5, 'cancellation returns only the recorded allocation, once');
  const legacy = database(3, { payload: { _stockDecremented: true } });
  await applyOrderStock(legacy, order);
  assert.equal(legacy.data.stock, 3, 'honors legacy receipts');
  const ambiguous = database(3, { payload: order });
  await assert.rejects(applyOrderStock(ambiguous, order), /baixa antiga/);
  assert.equal(ambiguous.data.stock, 3, 'never repeats undocumented historical deduction');
  const insufficient = database(1);
  await assert.rejects(applyOrderStock(insufficient, order), /insuficiente/);
  assert.equal(insufficient.data.stock, 1, 'failure rolls back partial deductions');
  assert.equal(insufficient.data.mapping, null);
  const unmapped = database();
  await assert.rejects(applyOrderStock(unmapped, { ...order, products: [{ sku: 'UNKNOWN', quantity: 1 }] }), /confirmado/);
  assert.equal(unmapped.data.stock, 5);
  const pending = database();
  await applyOrderStock(pending, { ...order, payment_status: 'pending' });
  await applyOrderStock(pending, order);
  assert.equal(pending.data.stock, 3, 'pending then paid works');
  assert.equal(preservedPayload({}, { _stockDecremented: true })._stockDecremented, true);
  const product = { sku: 'P', sizes: [{ size: '40', barcode: 'EAN', storeStocks: [{ stock: 3 }] }] };
  const remote = { variants: [{ sku: 'EAN', stock: 3, stock_management: true, values: [{ pt: '40' }] }] };
  assert.equal(remoteStockDiffers(product, remote), false);
  assert.equal(remoteStockDiffers(product, { variants: [{ ...remote.variants[0], stock: 8 }] }), true, 'remote drift detected without local change');
  assert.equal(remoteStockDiffers(product, { variants: [] }), true, 'missing size detected');
  console.log('Nuvemshop stock safety: 15 assertions passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
