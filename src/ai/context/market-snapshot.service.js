// =====================================================================
// Market Snapshot Service
// =====================================================================
// Monta um resumo compacto e operacional do negocio para o motor diario.
// Nao executa acoes; apenas le dados reais e devolve sinais para agentes.
// =====================================================================

const { prisma } = require('../../middleware');

const TZ_OFFSET_MS = 3 * 60 * 60 * 1000; // America/Fortaleza/PB = UTC-3

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function safeNumber(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}

function todayKeyFortaleza(d = new Date()) {
  const loc = new Date(d.getTime() - TZ_OFFSET_MS);
  return [
    loc.getUTCFullYear(),
    String(loc.getUTCMonth() + 1).padStart(2, '0'),
    String(loc.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function startOfDayFortaleza(d = new Date()) {
  const loc = new Date(d.getTime() - TZ_OFFSET_MS);
  return new Date(Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), 3, 0, 0, 0));
}

function marginPct(price, cost) {
  if (!price || !cost || price <= 0) return null;
  return round2(((price - cost) / price) * 100);
}

function totalStock(product) {
  let total = 0;
  for (const size of product.sizes || []) {
    for (const ss of size.storeStocks || []) total += safeNumber(ss.stock);
  }
  return total;
}

function stockByStore(product) {
  const byStore = {};
  for (const size of product.sizes || []) {
    for (const ss of size.storeStocks || []) {
      const code = ss.store?.code || ss.storeId || 'sem-loja';
      byStore[code] = (byStore[code] || 0) + safeNumber(ss.stock);
    }
  }
  return byStore;
}

async function safeSection(name, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    return { ...(fallback || {}), _error: `${name}: ${err.message}` };
  }
}

async function getStoreMap() {
  const stores = await prisma.store.findMany({
    where: { active: true },
    select: { id: true, code: true, name: true, dna: true, mall: true, city: true },
  });
  return {
    stores,
    byId: stores.reduce((m, s) => { m[s.id] = s; return m; }, {}),
  };
}

async function getSalesSummary({ days, storeMap }) {
  const since = daysAgo(days);
  const [salesAgg, salesByStore, topProducts, topSellers] = await Promise.all([
    prisma.sale.aggregate({
      where: { createdAt: { gte: since }, status: 'completed' },
      _sum: { totalAmount: true, tcUsed: true, tcEarned: true },
      _count: true,
    }),
    prisma.sale.groupBy({
      by: ['storeId'],
      where: { createdAt: { gte: since }, status: 'completed' },
      _sum: { totalAmount: true, tcUsed: true, tcEarned: true },
      _count: { _all: true },
    }),
    prisma.saleItem.groupBy({
      by: ['productId', 'productName', 'brand', 'category'],
      where: { sale: { createdAt: { gte: since }, status: 'completed' } },
      _sum: { quantity: true, totalPrice: true },
      _count: { _all: true },
      orderBy: { _sum: { totalPrice: 'desc' } },
      take: 12,
    }),
    prisma.sale.groupBy({
      by: ['sellerId'],
      where: { createdAt: { gte: since }, status: 'completed' },
      _sum: { totalAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 8,
    }),
  ]);

  const sellerIds = topSellers.map((s) => s.sellerId).filter(Boolean);
  const sellers = sellerIds.length
    ? await prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, storeId: true } })
    : [];
  const sellerMap = sellers.reduce((m, s) => { m[s.id] = s; return m; }, {});
  const revenue = safeNumber(salesAgg._sum.totalAmount);
  const count = salesAgg._count || 0;

  return {
    days,
    total: {
      count,
      revenue: round2(revenue),
      avgTicket: count ? round2(revenue / count) : 0,
      tcUsed: round2(salesAgg._sum.tcUsed || 0),
      tcEarned: round2(salesAgg._sum.tcEarned || 0),
    },
    byStore: salesByStore.map((r) => ({
      storeId: r.storeId,
      storeCode: storeMap.byId[r.storeId || '']?.code || null,
      storeName: storeMap.byId[r.storeId || '']?.name || 'Sem loja',
      count: r._count._all,
      revenue: round2(r._sum.totalAmount || 0),
      avgTicket: r._count._all ? round2((r._sum.totalAmount || 0) / r._count._all) : 0,
    })).sort((a, b) => b.revenue - a.revenue),
    topProducts: topProducts.map((p) => ({
      productId: p.productId,
      productName: p.productName,
      brand: p.brand,
      category: p.category,
      quantity: p._sum.quantity || 0,
      revenue: round2(p._sum.totalPrice || 0),
    })),
    topSellers: topSellers.map((s) => ({
      sellerId: s.sellerId,
      sellerName: sellerMap[s.sellerId]?.name || 'Vendedor',
      storeCode: storeMap.byId[sellerMap[s.sellerId]?.storeId || '']?.code || null,
      count: s._count._all,
      revenue: round2(s._sum.totalAmount || 0),
    })),
  };
}

async function getInventorySignals() {
  const thirtyDaysAgo = daysAgo(30);
  const products = await prisma.product.findMany({
    where: {
      active: true,
      price: { gt: 0 },
      sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
    },
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      category: true,
      subcategory: true,
      price: true,
      promoPrice: true,
      costPrice: true,
      featured: true,
      createdAt: true,
      saleItems: {
        where: { sale: { createdAt: { gte: thirtyDaysAgo }, status: 'completed' } },
        select: { quantity: true, totalPrice: true },
        take: 100,
      },
      sizes: {
        select: {
          size: true,
          storeStocks: { select: { stock: true, storeId: true, store: { select: { code: true, name: true } } } },
        },
      },
    },
    take: 700,
  });

  const enriched = products.map((p) => {
    const stock = totalStock(p);
    const sold30 = (p.saleItems || []).reduce((s, x) => s + safeNumber(x.quantity), 0);
    const revenue30 = (p.saleItems || []).reduce((s, x) => s + safeNumber(x.totalPrice), 0);
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      category: p.category,
      subcategory: p.subcategory,
      price: p.price,
      promoPrice: p.promoPrice,
      costPrice: p.costPrice,
      marginPct: marginPct(p.promoPrice || p.price, p.costPrice),
      stock,
      stockByStore: stockByStore(p),
      sold30,
      revenue30: round2(revenue30),
      featured: p.featured,
      createdAt: p.createdAt,
    };
  }).filter((p) => p.stock > 0);

  const slowMovers = enriched
    .filter((p) => p.sold30 === 0 && p.stock >= 2)
    .sort((a, b) => b.stock - a.stock)
    .slice(0, 18);

  const lowStockWinners = enriched
    .filter((p) => p.sold30 > 0 && p.stock <= 3)
    .sort((a, b) => b.sold30 - a.sold30)
    .slice(0, 12);

  const cashRecovery = enriched
    .filter((p) => p.stock >= 3 && p.costPrice && p.costPrice > 0)
    .map((p) => ({ ...p, inventoryCost: round2(p.stock * p.costPrice) }))
    .sort((a, b) => b.inventoryCost - a.inventoryCost)
    .slice(0, 15);

  const marginRisks = enriched
    .filter((p) => p.marginPct !== null && p.marginPct < 30)
    .sort((a, b) => a.marginPct - b.marginPct)
    .slice(0, 12);

  const promoCandidates = enriched
    .filter((p) => p.sold30 === 0 && p.stock >= 2 && (p.marginPct === null || p.marginPct >= 35))
    .sort((a, b) => (b.marginPct || 0) - (a.marginPct || 0))
    .slice(0, 12);

  return {
    scannedProducts: enriched.length,
    totalUnitsInSnapshot: enriched.reduce((s, p) => s + p.stock, 0),
    slowMovers,
    lowStockWinners,
    cashRecovery,
    marginRisks,
    promoCandidates,
  };
}

async function getCustomerSignals() {
  const [total, withBalance, balanceAgg, topBalances] = await Promise.all([
    prisma.user.count({ where: { role: 'user', active: true } }),
    prisma.user.count({ where: { role: 'user', active: true, balance: { gt: 0 } } }),
    prisma.user.aggregate({ where: { role: 'user', active: true }, _sum: { balance: true } }),
    prisma.user.findMany({
      where: { role: 'user', active: true, balance: { gt: 0 } },
      orderBy: { balance: 'desc' },
      take: 12,
      select: { id: true, name: true, balance: true, city: true, favBrands: true, sportsPractice: true },
    }),
  ]);

  return {
    totalActiveCustomers: total,
    customersWithTenisCash: withBalance,
    tenisCashOutstanding: round2(balanceAgg._sum.balance || 0),
    topBalances: topBalances.map((u) => ({
      id: u.id,
      name: u.name,
      balance: round2(u.balance),
      city: u.city,
      favBrands: u.favBrands,
      sportsPractice: u.sportsPractice,
    })),
  };
}

async function getCampaignSignals() {
  const [active, recent, pendingCreatives, pendingApprovals] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, name: true, channel: true, storeId: true, budget: true, generatedRevenue: true, roi: true, notes: true },
    }),
    prisma.campaign.findMany({
      where: { createdAt: { gte: daysAgo(14) } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, name: true, channel: true, status: true, generatedRevenue: true, roi: true, createdAt: true },
    }),
    prisma.productCreative.count({ where: { status: 'pending_review' } }),
    prisma.aIApproval.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true, type: true, title: true, riskLevel: true, createdAt: true },
    }),
  ]);

  return { active, recent, pendingCreatives, pendingApprovals };
}

async function getFinancialSignals() {
  const today = startOfDayFortaleza();
  const weekAhead = new Date(today.getTime() + 7 * 86400000);
  const [payablesDue, payablesOverdue, receivablesDue, suppliers] = await Promise.all([
    prisma.accountPayable.aggregate({
      where: { status: 'PENDING', dueDate: { gte: today, lte: weekAhead } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.accountPayable.aggregate({
      where: { status: 'PENDING', dueDate: { lt: today } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.accountReceivable.aggregate({
      where: { status: 'PENDING', dueDate: { lte: weekAhead } },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.supplier.findMany({
      where: { active: true },
      orderBy: [{ profitabilityRating: 'asc' }, { updatedAt: 'desc' }],
      take: 10,
      select: { id: true, companyName: true, suppliedBrands: true, averageMarkup: true, profitabilityRating: true, paymentDeadline: true },
    }),
  ]);

  return {
    payablesDue7d: { count: payablesDue._count || 0, amount: round2(payablesDue._sum.amount || 0) },
    payablesOverdue: { count: payablesOverdue._count || 0, amount: round2(payablesOverdue._sum.amount || 0) },
    receivablesDue7d: { count: receivablesDue._count || 0, amount: round2(receivablesDue._sum.amount || 0) },
    supplierWatchlist: suppliers,
  };
}

async function getAISignals() {
  const [todayCost, pendingApprovals, failedToday] = await Promise.all([
    prisma.aILog.aggregate({ where: { createdAt: { gte: startOfDayFortaleza() } }, _sum: { cost: true, tokens: true }, _count: true }),
    prisma.aIApproval.count({ where: { status: 'pending' } }),
    prisma.aIOrchestrationTask.count({ where: { createdAt: { gte: startOfDayFortaleza() }, status: 'failed' } }),
  ]);
  return {
    todayCalls: todayCost._count || 0,
    todayCostBRL: round2(todayCost._sum.cost || 0),
    todayTokens: todayCost._sum.tokens || 0,
    pendingApprovals,
    failedTasksToday: failedToday,
  };
}

async function getTrendConfig() {
  const keys = ['marketing_trends_today', 'daily_market_notes', 'daily_market_focus'];
  const rows = await prisma.config.findMany({ where: { key: { in: keys } }, select: { key: true, value: true } });
  return rows.reduce((m, r) => { m[r.key] = r.value; return m; }, {});
}

async function buildMarketSnapshot({ days = 30 } = {}) {
  const storeMap = await safeSection('stores', getStoreMap, { stores: [], byId: {} });
  const runDate = todayKeyFortaleza();
  const [
    sales,
    inventory,
    customers,
    campaigns,
    financial,
    ai,
    trendConfig,
  ] = await Promise.all([
    safeSection('sales', () => getSalesSummary({ days, storeMap }), { days, total: {}, byStore: [], topProducts: [] }),
    safeSection('inventory', getInventorySignals, { slowMovers: [], lowStockWinners: [], marginRisks: [] }),
    safeSection('customers', getCustomerSignals, {}),
    safeSection('campaigns', getCampaignSignals, {}),
    safeSection('financial', getFinancialSignals, {}),
    safeSection('ai', getAISignals, {}),
    safeSection('trendConfig', getTrendConfig, {}),
  ]);

  return {
    type: 'daily-market-snapshot',
    company: 'Sports & Tennis',
    runDate,
    generatedAt: new Date().toISOString(),
    timezone: 'America/Fortaleza',
    windows: { salesDays: days, inventorySalesDays: 30 },
    stores: storeMap.stores || [],
    sales,
    inventory,
    customers,
    campaigns,
    financial,
    ai,
    trendConfig,
  };
}

module.exports = {
  buildMarketSnapshot,
  todayKeyFortaleza,
  startOfDayFortaleza,
};
