const assert = require('assert');
const {
  quarterIdForYmd,
  quarterBounds,
  calculateQuarterlyRealProfit,
} = require('../src/services/realProfitTax');

assert.strictEqual(quarterIdForYmd('2026-07-11'), '2026-Q3');
assert.deepStrictEqual(quarterBounds('2026-Q3').from, '2026-07-01');
assert.deepStrictEqual(quarterBounds('2026-Q3').to, '2026-09-30');

const result = calculateQuarterlyRealProfit({
  revenue: 100000,
  profitBeforeTaxes: 50000,
  salesTaxDebits: { icms: 20000, pis: 1320, cofins: 6080, cbs: 653, ibs: 73 },
  automaticCredits: { icms: 8000, pis: 500, cofins: 2300 },
  adjustment: {
    taxableAdditions: 1000,
    taxableExclusions: 500,
    taxLossCarryforward: 100000,
    csllNegativeBaseCarryforward: 100000,
    closed: true,
  },
  settings: { cbsIbs2026ComplianceConfirmed: true },
  from: '2026-07-01',
  to: '2026-09-30',
  actualSalesRevenue: 100000,
  purchaseDocuments: 10,
});

assert.strictEqual(result.status, 'closed');
assert.strictEqual(result.consumption.expense, 16600);
assert.strictEqual(result.taxableProfit.adjustedBeforeLosses, 33900);
assert.strictEqual(result.taxableProfit.irpjLossUsed, 10170);
assert.strictEqual(result.taxableProfit.irpjBase, 23730);
assert.strictEqual(result.income.irpj, 3559.5);
assert.strictEqual(result.income.irpjAdditional, 0);
assert.strictEqual(result.income.csll, 2135.7);
assert.strictEqual(result.netProfit, 27704.8);

const additional = calculateQuarterlyRealProfit({
  revenue: 100000,
  profitBeforeTaxes: 100000,
  salesTaxDebits: { icms: 0, pis: 0, cofins: 0, cbs: 0, ibs: 0 },
  settings: { cbsIbs2026ComplianceConfirmed: true },
  from: '2026-07-01', to: '2026-09-30', actualSalesRevenue: 100000, purchaseDocuments: 1,
  adjustment: { closed: true },
});
assert.strictEqual(additional.status, 'closed');
assert.strictEqual(additional.income.irpj, 15000);
assert.strictEqual(additional.income.irpjAdditional, 4000);
assert.strictEqual(additional.income.csll, 9000);

const incomplete = calculateQuarterlyRealProfit({
  revenue: 1000,
  profitBeforeTaxes: 400,
  salesTaxDebits: { icms: 100, pis: 10, cofins: 40, cbs: 0, ibs: 0 },
  settings: { cbsIbs2026ComplianceConfirmed: true },
  from: '2026-07-01', to: '2026-07-11', actualSalesRevenue: 500,
});
assert.strictEqual(incomplete.status, 'not_assessed');
assert.strictEqual(incomplete.totalTaxExpense, null);
assert.strictEqual(incomplete.netProfit, null);
assert.strictEqual(incomplete.consumption.icms.expense, null);
assert.ok(incomplete.blockingIssues.some((x) => x.includes('XMLs fiscais')));

assert.throws(() => calculateQuarterlyRealProfit({ from: '2026-06-30', to: '2026-07-01' }), /mesmo trimestre/);

console.log('realProfitTax: OK');
