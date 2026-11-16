'use strict';

// Comissão pela REGRA CONFIGURADA (PayrollCommissionRule.config) — nada fixo no código.
// Venda cancelada nunca entra; venda pendente só entra como comissão provisória.
// Valor de cada item = total líquido da venda rateado pelo valor do item (desconto rateado).

const cal = require('./calendar');

const cents = (v) => Math.round((Number(v) || 0) * 100);
const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

function itemMatches(item, match) {
  if (!match) return false;
  const brand = fold(item.brand || item.product?.brand);
  const category = fold(item.category || item.product?.category);
  const name = String(item.productName || item.product?.name || '').toLowerCase();
  if (match.brands?.length && !match.brands.map(fold).includes(brand)) return false;
  if (match.categories?.length && !match.categories.map(fold).includes(category)) return false;
  if (match.nameIncludes?.length && !match.nameIncludes.some((w) => name.includes(String(w).toLowerCase()))) return false;
  return true;
}

function allocate(sale) {
  const items = sale.items || [];
  const gross = items.reduce((s, it) => s + Math.max(0, cents(it.totalPrice)), 0);
  const net = Math.max(0, cents(sale.totalAmount));
  let acc = 0, done = 0;
  return items.map((it) => {
    acc += Math.max(0, cents(it.totalPrice));
    const next = gross ? Math.round(net * acc / gross) : 0;
    const value = next - done; done = next;
    return { item: it, netCents: value };
  });
}

function rateFor(totalCents, config) {
  const tiers = [...(config.tiers || [])].sort((a, b) => a.aboveCents - b.aboveCents);
  let current = tiers[0] || { aboveCents: 0, pct: 0 };
  for (const t of tiers) if (t.aboveCents === 0 || totalCents > t.aboveCents) current = t;
  const next = tiers.find((t) => t.aboveCents > current.aboveCents) || null;
  return { current, next };
}

function commissionOn(totalCents, config) {
  if ((config.tierMode || 'ALL') === 'MARGINAL') {
    const tiers = [...(config.tiers || [])].sort((a, b) => a.aboveCents - b.aboveCents);
    let total = 0;
    tiers.forEach((t, i) => {
      const top = tiers[i + 1] ? Math.min(totalCents, tiers[i + 1].aboveCents) : totalCents;
      if (top > t.aboveCents) total += (top - t.aboveCents) * t.pct / 100;
    });
    return Math.round(total);
  }
  return Math.round(totalCents * rateFor(totalCents, config).current.pct / 100);
}

// Comissão sobre um conjunto de vendas (já filtradas por status).
function computeOn(sales, config) {
  const lines = sales.flatMap((s) => allocate(s).map((l) => ({ ...l, sale: s })));
  const totalCents = lines.reduce((s, l) => s + l.netCents, 0);
  const specials = (config.special || []).map((sp) => {
    const own = lines.filter((l) => itemMatches(l.item, sp.match));
    const spTotal = own.reduce((s, l) => s + l.netCents, 0);
    return { rule: sp, lines: own, totalCents: spTotal, reached: spTotal > sp.aboveCents };
  });
  // Itens da regra especial atingida saem da base geral e recebem o percentual próprio.
  const specialLines = new Set(specials.filter((s) => s.reached).flatMap((s) => s.lines));
  const { current, next } = rateFor(totalCents, config);
  const generalBase = lines.filter((l) => !specialLines.has(l)).reduce((s, l) => s + l.netCents, 0);
  const generalCommission = (config.tierMode || 'ALL') === 'MARGINAL'
    ? Math.round(commissionOn(totalCents, config) * (totalCents ? generalBase / totalCents : 0))
    : Math.round(generalBase * current.pct / 100);
  const specialCommission = specials.filter((s) => s.reached).reduce((sum, s) => sum + Math.round(s.totalCents * s.rule.pct / 100), 0);
  return {
    totalCents, generalBaseCents: generalBase, generalPct: current.pct, generalCommissionCents: generalCommission,
    nextTier: next ? { aboveCents: next.aboveCents, pct: next.pct, missingCents: Math.max(0, next.aboveCents - totalCents + 1) } : null,
    specials: specials.map((s) => ({
      name: s.rule.name, aboveCents: s.rule.aboveCents, pct: s.rule.pct, totalCents: s.totalCents, reached: s.reached,
      commissionCents: s.reached ? Math.round(s.totalCents * s.rule.pct / 100) : 0,
      missingCents: s.reached ? 0 : Math.max(0, s.rule.aboveCents - s.totalCents + 1),
    })),
    commissionCents: generalCommission + specialCommission,
  };
}

// sales: vendas do vendedor na competência (todas as lojas do mesmo empregador).
function computeCommission(sales, rule, { competence, asOfDay } = {}) {
  if (!rule) return { missingRule: true };
  const config = rule.config || {};
  const st = (s) => String(s.status || '').toLowerCase();
  const inList = (list, s) => (list || []).map((x) => String(x).toLowerCase()).includes(st(s));
  const scoped = (sales || []).filter((s) => !rule.storeIds?.length || rule.storeIds.includes(s.storeId));
  const confirmed = scoped.filter((s) => inList(config.confirmedStatuses || ['completed'], s));
  const pending = scoped.filter((s) => inList(config.pendingStatuses, s));
  const canceled = scoped.filter((s) => inList(config.canceledStatuses || ['canceled', 'cancelled'], s));
  const other = scoped.filter((s) => !confirmed.includes(s) && !pending.includes(s) && !canceled.includes(s));
  const confirmedCalc = computeOn(confirmed, config);
  const withPending = computeOn([...confirmed, ...pending], config);
  const sum = (list) => list.reduce((s, x) => s + Math.max(0, cents(x.totalAmount)), 0);
  const byCategory = new Map();
  for (const sale of confirmed) for (const l of allocate(sale)) {
    const key = l.item.category || 'Sem categoria';
    byCategory.set(key, (byCategory.get(key) || 0) + l.netCents);
  }
  // Projeção linear até o fim do mês (só informativa).
  let projection = null;
  if (competence && asOfDay) {
    const all = cal.monthDays(competence);
    const elapsed = all.filter((d) => d <= asOfDay).length;
    if (elapsed && elapsed < all.length) {
      const f = all.length / elapsed;
      const scaled = confirmed.map((s) => ({ ...s, totalAmount: Number(s.totalAmount) * f, items: (s.items || []).map((i) => ({ ...i, totalPrice: Number(i.totalPrice) * f })) }));
      const p = computeOn(scaled, config);
      projection = { salesCents: p.totalCents, commissionCents: p.commissionCents, pct: p.generalPct, basis: `ritmo de ${elapsed} de ${all.length} dias` };
    }
  }
  return {
    ruleId: rule.id || null, ruleName: rule.name, ruleVersion: rule.version || 1, config,
    confirmed: { count: confirmed.length, salesCents: sum(confirmed), ...confirmedCalc },
    pending: { count: pending.length, salesCents: sum(pending), extraCommissionCents: Math.max(0, withPending.commissionCents - confirmedCalc.commissionCents) },
    canceled: { count: canceled.length, salesCents: sum(canceled) },
    other: { count: other.length, statuses: [...new Set(other.map(st))] },
    byCategory: [...byCategory].map(([category, salesCents]) => ({ category, salesCents })).sort((a, b) => b.salesCents - a.salesCents),
    projection,
  };
}

module.exports = { computeCommission, computeOn, itemMatches, allocate };
