// Lucro por produto a partir das vendas concluidas.
// Regra: desconto ja esta embutido em SaleItem.totalPrice e nao e subtraido duas vezes.
// O custo precisa estar gravado na venda. A Constituição proíbe usar o custo atual
// do produto como substituto para uma informação histórica ausente.

const { DEFAULT_REAL_PROFIT_SETTINGS, sanitizeRealProfitSettings } = require('./realProfitTax');

const DEFAULT_SETTINGS = Object.freeze({
  paymentFeesPct: {
    credit_card: 0,
    debit_card: 0,
    pix: 0,
    cash: 0,
    other: 0,
  },
  taxPct: 0,
  otherVariablePct: 0,
  packagingPerSale: 0,
  tcEarnedProvisionPct: 0,
  realProfit: DEFAULT_REAL_PROFIT_SETTINGS,
});

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const normalize = (s) => String(s || '').trim().toLowerCase();

function sanitizeSettings(input = {}) {
  const p = input.paymentFeesPct || {};
  return {
    paymentFeesPct: {
      credit_card: clampPct(p.credit_card),
      debit_card: clampPct(p.debit_card),
      pix: clampPct(p.pix),
      cash: clampPct(p.cash),
      other: clampPct(p.other),
    },
    taxPct: clampPct(input.taxPct),
    otherVariablePct: clampPct(input.otherVariablePct),
    packagingPerSale: Math.max(0, Number(input.packagingPerSale) || 0),
    tcEarnedProvisionPct: clampPct(input.tcEarnedProvisionPct),
    realProfit: sanitizeRealProfitSettings(input.realProfit || {}),
  };
}

function paymentKey(method) {
  const m = normalize(method);
  if (['credit_card', 'credito', 'credit'].includes(m)) return 'credit_card';
  if (['debit_card', 'debito', 'debit'].includes(m)) return 'debit_card';
  if (m === 'pix') return 'pix';
  if (['cash', 'dinheiro'].includes(m)) return 'cash';
  return 'other';
}

function ymdDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('Data invalida: ' + ymd);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

// Soma a fracao mensal correspondente a cada dia do periodo inclusivo.
// Ex.: julho inteiro = 1; 10 dias de julho = 10/31.
function monthlyProrationFactor(fromYmd, toYmd) {
  const start = ymdDate(fromYmd);
  const end = ymdDate(toYmd);
  if (end < start) throw new Error('Periodo invalido');
  let factor = 0;
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    const days = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    factor += 1 / days;
  }
  return factor;
}

function makeRow(item) {
  return {
    productId: item.productId || null,
    sku: item.product?.sku || null,
    name: item.productName || item.product?.name || 'Produto sem nome',
    brand: item.brand || item.product?.brand || 'SEM MARCA',
    units: 0,
    salesCount: 0,
    revenue: 0,
    discount: 0,
    cogs: 0,
    cogsKnownRevenue: 0,
    missingCostUnits: 0,
    commissions: 0,
    paymentFees: 0,
    taxes: 0,
    otherVariableCosts: 0,
    packaging: 0,
    tcUsed: 0,
    tcProvision: 0,
    fixedAllocated: 0,
    storeRevenue: new Map(),
    issuerRevenue: new Map(),
    saleIds: new Set(),
    costSources: new Set(),
  };
}

function itemKey(item) {
  if (item.productId) return item.productId;
  return `legacy:${normalize(item.brand)}:${normalize(item.productName)}`;
}

function saleItemRevenue(sale) {
  return (sale.items || []).reduce((sum, item) => sum + (Number(item.totalPrice) || 0), 0);
}

function calculateProductProfit({ sales = [], expenses = [], settings = {}, from, to, storeId = null }) {
  const cfg = sanitizeSettings(settings);
  const factor = monthlyProrationFactor(from, to);

  // Denominadores de toda a empresa: necessarios para ratear despesas globais corretamente,
  // mesmo quando a tela filtra uma unica loja.
  let companyRevenue = 0;
  const revenueByStore = new Map();
  for (const sale of sales) {
    const rev = saleItemRevenue(sale);
    companyRevenue += rev;
    const sid = sale.storeId || '__none__';
    revenueByStore.set(sid, (revenueByStore.get(sid) || 0) + rev);
  }

  let companyExpensePool = 0;
  const expensePoolByStore = new Map();
  for (const expense of expenses) {
    const amount = (Number(expense.amount) || 0) * factor;
    if (expense.storeId) expensePoolByStore.set(expense.storeId, (expensePoolByStore.get(expense.storeId) || 0) + amount);
    else companyExpensePool += amount;
  }

  const rows = new Map();
  let salesWithoutItems = 0;
  let revenueWithoutItems = 0;
  let revenueNotRepresentedByItems = 0;
  let selectedSales = 0;

  for (const sale of sales) {
    if (storeId && sale.storeId !== storeId) continue;
    selectedSales += 1;
    const items = sale.items || [];
    const itemRevenue = saleItemRevenue(sale);
    const saleRevenue = Number(sale.totalAmount) || 0;
    if (!items.length || itemRevenue <= 0) {
      salesWithoutItems += 1;
      revenueWithoutItems += saleRevenue;
      continue;
    }
    revenueNotRepresentedByItems += Math.max(0, saleRevenue - itemRevenue);

    const brandRevenue = new Map();
    for (const item of items) {
      const b = normalize(item.brand || item.product?.brand);
      brandRevenue.set(b, (brandRevenue.get(b) || 0) + (Number(item.totalPrice) || 0));
    }
    const commissionByBrand = new Map();
    for (const commission of sale.commissions || []) {
      const b = normalize(commission.brand);
      commissionByBrand.set(b, (commissionByBrand.get(b) || 0) + (Number(commission.amount) || 0));
    }

    const feePct = cfg.paymentFeesPct[paymentKey(sale.paymentMethod)] || 0;
    for (const item of items) {
      const revenue = Number(item.totalPrice) || 0;
      if (revenue <= 0) continue;
      const key = itemKey(item);
      const row = rows.get(key) || makeRow(item);
      rows.set(key, row);

      const qty = Math.max(0, Number(item.quantity) || 0);
      const saleShare = itemRevenue > 0 ? revenue / itemRevenue : 0;
      const b = normalize(item.brand || item.product?.brand);
      const brandShare = (brandRevenue.get(b) || 0) > 0 ? revenue / brandRevenue.get(b) : 0;
      const snapshotCost = item.unitCost == null ? null : Number(item.unitCost);
      const unitCost = Number.isFinite(snapshotCost) && snapshotCost >= 0 ? snapshotCost : null;

      row.units += qty;
      row.revenue += revenue;
      row.discount += (Number(sale.discount) || 0) * saleShare;
      row.commissions += (commissionByBrand.get(b) || 0) * brandShare;
      row.paymentFees += revenue * feePct / 100;
      row.taxes += revenue * cfg.taxPct / 100;
      row.otherVariableCosts += revenue * cfg.otherVariablePct / 100;
      row.packaging += cfg.packagingPerSale * saleShare;
      row.tcUsed += (Number(sale.tcUsed) || 0) * saleShare;
      row.tcProvision += (Number(sale.tcEarned) || 0) * cfg.tcEarnedProvisionPct / 100 * saleShare;
      row.saleIds.add(sale.id);
      const sid = sale.storeId || '__none__';
      row.storeRevenue.set(sid, (row.storeRevenue.get(sid) || 0) + revenue);
      const issuerId = sale.issuerId || '__unassigned__';
      row.issuerRevenue.set(issuerId, (row.issuerRevenue.get(issuerId) || 0) + revenue);

      if (unitCost != null) {
        row.cogs += unitCost * qty;
        row.cogsKnownRevenue += revenue;
        row.costSources.add('snapshot');
      } else {
        row.missingCostUnits += qty;
        row.costSources.add('missing');
      }
    }
  }

  const out = [];
  for (const row of rows.values()) {
    row.fixedAllocated = companyRevenue > 0 ? companyExpensePool * row.revenue / companyRevenue : 0;
    for (const [sid, revenue] of row.storeRevenue.entries()) {
      const storePool = expensePoolByStore.get(sid) || 0;
      const denom = revenueByStore.get(sid) || 0;
      if (denom > 0) row.fixedAllocated += storePool * revenue / denom;
    }
    const variableCosts = row.commissions + row.paymentFees + row.taxes + row.otherVariableCosts + row.packaging + row.tcUsed + row.tcProvision;
    const costComplete = row.missingCostUnits === 0;
    const contribution = costComplete ? row.revenue - row.cogs - variableCosts : null;
    const profit = contribution == null ? null : contribution - row.fixedAllocated;
    out.push({
      productId: row.productId,
      sku: row.sku,
      name: row.name,
      brand: row.brand,
      units: round2(row.units),
      salesCount: row.saleIds.size,
      revenue: round2(row.revenue),
      discount: round2(row.discount),
      cogs: round2(row.cogs),
      grossProfit: costComplete ? round2(row.revenue - row.cogs) : null,
      commissions: round2(row.commissions),
      paymentFees: round2(row.paymentFees),
      taxes: round2(row.taxes),
      otherVariableCosts: round2(row.otherVariableCosts),
      packaging: round2(row.packaging),
      tcUsed: round2(row.tcUsed),
      tcProvision: round2(row.tcProvision),
      variableCosts: round2(variableCosts),
      contribution: contribution == null ? null : round2(contribution),
      fixedAllocated: round2(row.fixedAllocated),
      profit: profit == null ? null : round2(profit),
      marginPct: profit != null && row.revenue > 0 ? round2(profit / row.revenue * 100) : null,
      calculationStatus: costComplete ? 'calculated_before_taxes' : 'not_assessed',
      cogsCoverage: row.revenue > 0 ? round2(row.cogsKnownRevenue / row.revenue * 100) : null,
      missingCostUnits: round2(row.missingCostUnits),
      costSources: [...row.costSources],
      issuerRevenue: Object.fromEntries([...row.issuerRevenue.entries()].map(([k, v]) => [k, round2(v)])),
    });
  }

  const summary = out.reduce((a, r) => {
    a.units += r.units;
    a.revenue += r.revenue;
    a.discount += r.discount;
    a.cogs += r.cogs;
    if (r.grossProfit == null) a.incompleteCostProducts += 1;
    else a.grossProfit += r.grossProfit;
    a.commissions += r.commissions;
    a.paymentFees += r.paymentFees;
    a.taxes += r.taxes;
    a.otherVariableCosts += r.otherVariableCosts;
    a.packaging += r.packaging;
    a.tcUsed += r.tcUsed;
    a.tcProvision += r.tcProvision;
    a.variableCosts += r.variableCosts;
    if (r.contribution != null) a.contribution += r.contribution;
    a.fixedAllocated += r.fixedAllocated;
    if (r.profit != null) a.profit += r.profit;
    a.missingCostUnits += r.missingCostUnits;
    a.knownCostRevenue += r.revenue * (r.cogsCoverage || 0) / 100;
    return a;
  }, { units: 0, revenue: 0, discount: 0, cogs: 0, grossProfit: 0, commissions: 0, paymentFees: 0, taxes: 0, otherVariableCosts: 0, packaging: 0, tcUsed: 0, tcProvision: 0, variableCosts: 0, contribution: 0, fixedAllocated: 0, profit: 0, missingCostUnits: 0, knownCostRevenue: 0, incompleteCostProducts: 0 });

  for (const key of Object.keys(summary)) summary[key] = round2(summary[key]);
  const incomplete = summary.incompleteCostProducts > 0 || salesWithoutItems > 0 || revenueNotRepresentedByItems > 0.01;
  if (incomplete) {
    summary.grossProfit = null;
    summary.contribution = null;
    summary.profit = null;
    summary.marginPct = null;
    summary.calculationStatus = 'not_assessed';
  } else {
    summary.marginPct = summary.revenue > 0 ? round2(summary.profit / summary.revenue * 100) : null;
    summary.calculationStatus = 'calculated_before_taxes';
  }
  summary.cogsCoverage = summary.revenue > 0 ? round2(summary.knownCostRevenue / summary.revenue * 100) : null;
  delete summary.knownCostRevenue;
  summary.products = out.length;
  summary.sales = selectedSales;
  summary.salesWithoutItems = salesWithoutItems;
  summary.revenueWithoutItems = round2(revenueWithoutItems);
  summary.revenueNotRepresentedByItems = round2(revenueNotRepresentedByItems);

  return {
    settings: cfg,
    expenseProrationFactor: factor,
    summary,
    products: out,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  monthlyProrationFactor,
  calculateProductProfit,
};
