// Apuracao gerencial do Lucro Real trimestral.
// O motor separa despesa tributaria (impacta lucro) de saldo a pagar (impacta caixa).
// Ajustes de LALUR/LACS e creditos informados pela contabilidade permanecem auditaveis.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clampPct = (n) => Math.max(0, Math.min(100, Number(n) || 0));
const nonNegative = (n) => Math.max(0, Number(n) || 0);

const DEFAULT_REAL_PROFIT_SETTINGS = Object.freeze({
  regime: 'lucro_real_trimestral',
  icmsRatePct: 20,
  pisRatePct: 1.65,
  cofinsRatePct: 7.6,
  excludeIcmsFromPisCofinsBase: true,
  irpjRatePct: 15,
  irpjAdditionalRatePct: 10,
  irpjAdditionalThresholdPerMonth: 20000,
  csllRatePct: 9,
  lossCompensationLimitPct: 30,
  cbs2026RatePct: 0.9,
  ibs2026RatePct: 0.1,
  cbsIbs2026ComplianceConfirmed: false,
});

const EMPTY_QUARTER_ADJUSTMENT = Object.freeze({
  icmsCredit: 0,
  pisCredit: 0,
  cofinsCredit: 0,
  cbsCredit: 0,
  ibsCredit: 0,
  otherConsumptionTaxes: 0,
  taxableAdditions: 0,
  taxableExclusions: 0,
  taxLossCarryforward: 0,
  csllNegativeBaseCarryforward: 0,
  irpjPrepaidOrWithheld: 0,
  csllPrepaidOrWithheld: 0,
  closed: false,
  notes: '',
});

function sanitizeRealProfitSettings(input = {}) {
  return {
    regime: 'lucro_real_trimestral',
    icmsRatePct: clampPct(input.icmsRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.icmsRatePct),
    pisRatePct: clampPct(input.pisRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.pisRatePct),
    cofinsRatePct: clampPct(input.cofinsRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.cofinsRatePct),
    excludeIcmsFromPisCofinsBase: input.excludeIcmsFromPisCofinsBase !== false,
    irpjRatePct: clampPct(input.irpjRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.irpjRatePct),
    irpjAdditionalRatePct: clampPct(input.irpjAdditionalRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.irpjAdditionalRatePct),
    irpjAdditionalThresholdPerMonth: nonNegative(input.irpjAdditionalThresholdPerMonth ?? DEFAULT_REAL_PROFIT_SETTINGS.irpjAdditionalThresholdPerMonth),
    csllRatePct: clampPct(input.csllRatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.csllRatePct),
    lossCompensationLimitPct: clampPct(input.lossCompensationLimitPct ?? DEFAULT_REAL_PROFIT_SETTINGS.lossCompensationLimitPct),
    cbs2026RatePct: clampPct(input.cbs2026RatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.cbs2026RatePct),
    ibs2026RatePct: clampPct(input.ibs2026RatePct ?? DEFAULT_REAL_PROFIT_SETTINGS.ibs2026RatePct),
    cbsIbs2026ComplianceConfirmed: input.cbsIbs2026ComplianceConfirmed === true,
  };
}

function sanitizeQuarterAdjustment(input = {}) {
  const out = {};
  for (const key of Object.keys(EMPTY_QUARTER_ADJUSTMENT)) {
    if (key === 'closed') out[key] = input[key] === true;
    else if (key === 'notes') out[key] = String(input[key] || '').trim().slice(0, 2000);
    else out[key] = nonNegative(input[key]);
  }
  return out;
}

function quarterIdForYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error('Data invalida: ' + ymd);
  const month = Number(m[2]);
  return `${m[1]}-Q${Math.floor((month - 1) / 3) + 1}`;
}

function quarterBounds(quarterId) {
  const m = String(quarterId || '').match(/^(\d{4})-Q([1-4])$/);
  if (!m) throw new Error('Trimestre invalido: ' + quarterId);
  const year = Number(m[1]);
  const quarter = Number(m[2]);
  const firstMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, firstMonth, 1));
  const endExclusive = new Date(Date.UTC(year, firstMonth + 3, 1));
  const end = new Date(endExclusive.getTime() - 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return { id: quarterId, year, quarter, from: ymd(start), to: ymd(end), start, end, endExclusive };
}

function monthsTouched(fromYmd, toYmd) {
  const a = new Date(fromYmd + 'T00:00:00.000Z');
  const b = new Date(toYmd + 'T00:00:00.000Z');
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b < a) throw new Error('Periodo invalido');
  const set = new Set();
  for (let d = new Date(a); d <= b; d.setUTCDate(d.getUTCDate() + 1)) set.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
  return set.size;
}

function taxAccount(debit, automaticCredit, manualCredit) {
  const d = nonNegative(debit);
  const c = nonNegative(automaticCredit) + nonNegative(manualCredit);
  return {
    debit: round2(d),
    automaticCredit: round2(automaticCredit),
    manualCredit: round2(manualCredit),
    credit: round2(c),
    expense: round2(Math.max(0, d - c)),
    payable: round2(Math.max(0, d - c)),
    carryforward: round2(Math.max(0, c - d)),
  };
}

function calculateQuarterlyRealProfit({
  revenue = 0,
  profitBeforeTaxes = 0,
  salesTaxDebits = {},
  automaticCredits = {},
  adjustment = {},
  settings = {},
  from,
  to,
  actualSalesRevenue = 0,
  purchaseDocuments = 0,
  blockingIssues = [],
}) {
  const cfg = sanitizeRealProfitSettings(settings);
  const adj = sanitizeQuarterAdjustment(adjustment);
  const quarterFrom = quarterIdForYmd(from);
  const quarterTo = quarterIdForYmd(to);
  if (quarterFrom !== quarterTo) throw new Error('Lucro Real trimestral exige datas dentro do mesmo trimestre');
  const quarter = quarterBounds(quarterFrom);
  const months = monthsTouched(from, to);
  const debit = {
    icms: nonNegative(salesTaxDebits.icms),
    pis: nonNegative(salesTaxDebits.pis),
    cofins: nonNegative(salesTaxDebits.cofins),
    cbs: nonNegative(salesTaxDebits.cbs),
    ibs: nonNegative(salesTaxDebits.ibs),
  };

  const icms = taxAccount(debit.icms, automaticCredits.icms, adj.icmsCredit);
  const pis = taxAccount(debit.pis, automaticCredits.pis, adj.pisCredit);
  const cofins = taxAccount(debit.cofins, automaticCredits.cofins, adj.cofinsCredit);
  const cbs = taxAccount(debit.cbs, automaticCredits.cbs, adj.cbsCredit);
  const ibs = taxAccount(debit.ibs, automaticCredits.ibs, adj.ibsCredit);

  const is2026 = quarter.year === 2026;
  const cbsIbsDispensed = is2026 && cfg.cbsIbs2026ComplianceConfirmed;
  if (cbsIbsDispensed) {
    cbs.expense = 0; cbs.payable = 0;
    ibs.expense = 0; ibs.payable = 0;
  }

  const consumptionTaxExpense = round2(icms.expense + pis.expense + cofins.expense + cbs.expense + ibs.expense + adj.otherConsumptionTaxes);
  const accountingProfitAfterConsumptionTaxes = round2((Number(profitBeforeTaxes) || 0) - consumptionTaxExpense);
  const adjustedBeforeLosses = Math.max(0, accountingProfitAfterConsumptionTaxes + adj.taxableAdditions - adj.taxableExclusions);
  const maxLossComp = adjustedBeforeLosses * cfg.lossCompensationLimitPct / 100;
  const irpjLossUsed = Math.min(adj.taxLossCarryforward, maxLossComp);
  const csllLossUsed = Math.min(adj.csllNegativeBaseCarryforward, maxLossComp);
  const irpjBase = Math.max(0, adjustedBeforeLosses - irpjLossUsed);
  const csllBase = Math.max(0, adjustedBeforeLosses - csllLossUsed);
  const irpj = irpjBase * cfg.irpjRatePct / 100;
  const irpjAdditionalThreshold = cfg.irpjAdditionalThresholdPerMonth * months;
  const irpjAdditional = Math.max(0, irpjBase - irpjAdditionalThreshold) * cfg.irpjAdditionalRatePct / 100;
  const csll = csllBase * cfg.csllRatePct / 100;
  const irpjExpense = round2(irpj + irpjAdditional);
  const csllExpense = round2(csll);
  const incomeTaxExpense = round2(irpjExpense + csllExpense);
  const netProfit = round2(accountingProfitAfterConsumptionTaxes - incomeTaxExpense);

  const actualCoveragePct = revenue > 0 ? Math.min(100, nonNegative(actualSalesRevenue) / revenue * 100) : 100;
  const fullQuarter = from === quarter.from && to === quarter.to;
  const issues = [...new Set((blockingIssues || []).map((x) => String(x || '').trim()).filter(Boolean))];
  if (profitBeforeTaxes == null || !Number.isFinite(Number(profitBeforeTaxes))) issues.push('O resultado contabil antes dos tributos nao foi confirmado');
  for (const taxName of ['icms', 'pis', 'cofins']) {
    if (!Object.prototype.hasOwnProperty.call(salesTaxDebits || {}, taxName)) issues.push(`O debito de ${taxName.toUpperCase()} nao foi informado por fonte fiscal`);
  }
  if (is2026 && !cfg.cbsIbs2026ComplianceConfirmed) {
    for (const taxName of ['cbs', 'ibs']) {
      if (!Object.prototype.hasOwnProperty.call(salesTaxDebits || {}, taxName)) issues.push(`O debito de ${taxName.toUpperCase()} nao foi informado por fonte fiscal`);
    }
  }
  if (actualCoveragePct < 99.999) issues.push('Faltam XMLs fiscais autorizados vinculados a vendas do periodo');
  if (!fullQuarter) issues.push('O Lucro Real somente pode ser apurado com o trimestre completo');
  if (!adj.closed) issues.push('O fechamento do contador ainda nao foi confirmado para este trimestre');
  const uniqueIssues = [...new Set(issues)];
  const closed = uniqueIssues.length === 0;
  const warnings = [];
  if (!purchaseDocuments) warnings.push('Nenhuma NF-e de entrada foi localizada no periodo; o contador deve confirmar se realmente nao houve compras');
  if (is2026 && !cfg.cbsIbs2026ComplianceConfirmed) warnings.push('A dispensa de CBS/IBS 2026 ainda nao foi confirmada pela contabilidade');

  if (!closed) {
    for (const account of [icms, pis, cofins, cbs, ibs]) {
      account.knownBalance = account.expense;
      account.expense = null;
      account.payable = null;
    }
  }

  return {
    regime: cfg.regime,
    quarter: quarter.id,
    period: { from, to, fullQuarter, months },
    status: closed ? 'closed' : 'not_assessed',
    settings: cfg,
    revenue: round2(revenue),
    profitBeforeTaxes: round2(profitBeforeTaxes),
    consumption: {
      icms, pis, cofins, cbs, ibs,
      cbsIbsDispensed,
      other: round2(adj.otherConsumptionTaxes),
      expense: closed ? consumptionTaxExpense : null,
    },
    accountingProfitAfterConsumptionTaxes: closed ? accountingProfitAfterConsumptionTaxes : null,
    taxableProfit: {
      additions: round2(adj.taxableAdditions),
      exclusions: round2(adj.taxableExclusions),
      adjustedBeforeLosses: closed ? round2(adjustedBeforeLosses) : null,
      irpjLossUsed: closed ? round2(irpjLossUsed) : null,
      csllLossUsed: closed ? round2(csllLossUsed) : null,
      irpjBase: closed ? round2(irpjBase) : null,
      csllBase: closed ? round2(csllBase) : null,
    },
    income: {
      irpj: closed ? round2(irpj) : null,
      irpjAdditional: closed ? round2(irpjAdditional) : null,
      irpjExpense: closed ? irpjExpense : null,
      irpjPayable: closed ? round2(Math.max(0, irpjExpense - adj.irpjPrepaidOrWithheld)) : null,
      csll: closed ? csllExpense : null,
      csllExpense: closed ? csllExpense : null,
      csllPayable: closed ? round2(Math.max(0, csllExpense - adj.csllPrepaidOrWithheld)) : null,
      expense: closed ? incomeTaxExpense : null,
    },
    totalTaxExpense: closed ? round2(consumptionTaxExpense + incomeTaxExpense) : null,
    netProfit: closed ? netProfit : null,
    sourceCoverage: {
      actualSalesRevenue: round2(actualSalesRevenue),
      missingFiscalRevenue: round2(Math.max(0, revenue - actualSalesRevenue)),
      actualSalesPct: round2(actualCoveragePct),
      purchaseDocuments: Number(purchaseDocuments) || 0,
    },
    adjustment: adj,
    blockingIssues: uniqueIssues,
    warnings,
  };
}

module.exports = {
  DEFAULT_REAL_PROFIT_SETTINGS,
  EMPTY_QUARTER_ADJUSTMENT,
  sanitizeRealProfitSettings,
  sanitizeQuarterAdjustment,
  quarterIdForYmd,
  quarterBounds,
  calculateQuarterlyRealProfit,
};
