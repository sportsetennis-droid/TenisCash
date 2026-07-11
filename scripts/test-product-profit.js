const assert = require('assert');
const {
  sanitizeSettings,
  monthlyProrationFactor,
  calculateProductProfit,
} = require('../src/services/productProfit');

assert.strictEqual(Math.round(monthlyProrationFactor('2026-07-01', '2026-07-31') * 1e9) / 1e9, 1);
assert.strictEqual(sanitizeSettings({ taxPct: 200, packagingPerSale: -2 }).taxPct, 100);
assert.strictEqual(sanitizeSettings({ taxPct: 200, packagingPerSale: -2 }).packagingPerSale, 0);

const sales = [
  {
    id: 's1', storeId: 'loja1', totalAmount: 100, discount: 20, tcUsed: 10, tcEarned: 50,
    paymentMethod: 'credit_card', commissions: [{ brand: 'MARCA A', amount: 5 }],
    items: [{
      productId: 'p1', productName: 'Produto A', brand: 'MARCA A', quantity: 1, totalPrice: 100,
      unitCost: 40, product: { sku: 'A1', name: 'Produto A', brand: 'MARCA A', costPrice: 99 },
    }],
  },
  {
    id: 's2', storeId: 'loja2', totalAmount: 100, discount: 0, tcUsed: 0, tcEarned: 0,
    paymentMethod: 'cash', commissions: [],
    items: [{
      productId: 'p2', productName: 'Produto B', brand: 'MARCA B', quantity: 1, totalPrice: 100,
      unitCost: 50, product: { sku: 'B1', name: 'Produto B', brand: 'MARCA B', costPrice: 99 },
    }],
  },
];
const expenses = [
  { amount: 31, storeId: null },
  { amount: 31, storeId: 'loja1' },
];
const settings = {
  paymentFeesPct: { credit_card: 2, debit_card: 0, pix: 0, cash: 0, other: 0 },
  taxPct: 10,
  otherVariablePct: 1,
  packagingPerSale: 1,
  tcEarnedProvisionPct: 20,
};

const result = calculateProductProfit({ sales, expenses, settings, from: '2026-07-01', to: '2026-07-31' });
const a = result.products.find((p) => p.productId === 'p1');
const b = result.products.find((p) => p.productId === 'p2');

assert.deepStrictEqual({ revenue: a.revenue, cogs: a.cogs, commissions: a.commissions }, { revenue: 100, cogs: 40, commissions: 5 });
assert.deepStrictEqual({ fees: a.paymentFees, taxes: a.taxes, other: a.otherVariableCosts, pack: a.packaging }, { fees: 2, taxes: 10, other: 1, pack: 1 });
assert.deepStrictEqual({ tcUsed: a.tcUsed, tcProvision: a.tcProvision, fixed: a.fixedAllocated, profit: a.profit }, { tcUsed: 10, tcProvision: 10, fixed: 46.5, profit: -25.5 });
assert.deepStrictEqual({ cogs: b.cogs, source: b.costSources[0], fixed: b.fixedAllocated, profit: b.profit }, { cogs: 50, source: 'snapshot', fixed: 15.5, profit: 22.5 });
assert.strictEqual(result.summary.profit, -3);
assert.strictEqual(result.summary.cogsCoverage, 100);

const onlyStore1 = calculateProductProfit({ sales, expenses, settings, from: '2026-07-01', to: '2026-07-31', storeId: 'loja1' });
assert.strictEqual(onlyStore1.products.length, 1);
assert.strictEqual(onlyStore1.products[0].fixedAllocated, 46.5);

const missing = calculateProductProfit({
  sales: [{ ...sales[0], id: 's3', items: [{ productId: 'p3', productName: 'Sem custo', brand: 'X', quantity: 2, totalPrice: 100, unitCost: null, product: { sku: 'X1', costPrice: null } }], commissions: [] }],
  expenses: [], settings: {}, from: '2026-07-01', to: '2026-07-31',
});
assert.strictEqual(missing.summary.cogsCoverage, 0);
assert.strictEqual(missing.summary.missingCostUnits, 2);
assert.strictEqual(missing.summary.profit, null);
assert.strictEqual(missing.products[0].profit, null);
assert.strictEqual(missing.products[0].calculationStatus, 'not_assessed');

console.log('productProfit: OK');
