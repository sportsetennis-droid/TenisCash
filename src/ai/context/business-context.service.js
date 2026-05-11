// =====================================================================
// Business Context Service — resume estado do negócio para os agentes
// =====================================================================
// Retorna um snapshot COMPACTO (poucos tokens) com lojas, produtos,
// vendas recentes, clientes, vendedores, parceiros, transações.

const { prisma } = require('../../middleware');

function safeNumber(n, def = 0) {
  return typeof n === 'number' && Number.isFinite(n) ? n : def;
}

async function getStoresSummary() {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, dna: true, mall: true, city: true },
      take: 20,
    });
    return stores;
  } catch (err) {
    return [];
  }
}

async function getProductsSummary({ storeId } = {}) {
  try {
    const total = await prisma.product.count({ where: { active: true } });
    const featured = await prisma.product.count({ where: { active: true, featured: true } });
    const promo = await prisma.product.count({
      where: { active: true, promoPrice: { not: null } },
    });
    const byBrand = await prisma.product.groupBy({
      by: ['brand'],
      where: { active: true },
      _count: { _all: true },
      orderBy: { _count: { brand: 'desc' } },
      take: 10,
    });
    const byCategory = await prisma.product.groupBy({
      by: ['category'],
      where: { active: true },
      _count: { _all: true },
      orderBy: { _count: { category: 'desc' } },
      take: 10,
    });
    return {
      totalActive: total,
      totalFeatured: featured,
      totalInPromo: promo,
      topBrands: byBrand.map((b) => ({ brand: b.brand, count: b._count._all })),
      topCategories: byCategory.map((c) => ({ category: c.category, count: c._count._all })),
      _note: storeId ? `Snapshot global; estoque por loja não filtrado nesta versão.` : 'Snapshot global.',
    };
  } catch (err) {
    return { totalActive: 0, topBrands: [], topCategories: [], _error: err.message };
  }
}

async function getRecentSalesSummary({ storeId, days = 7 } = {}) {
  try {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const where = { createdAt: { gte: since }, status: 'completed', ...(storeId ? { storeId } : {}) };
    const sales = await prisma.sale.findMany({
      where,
      select: { totalAmount: true, tcUsed: true, tcEarned: true, storeId: true, createdAt: true },
      take: 500,
    });
    const totalRevenue = sales.reduce((s, x) => s + safeNumber(x.totalAmount), 0);
    const totalTcUsed = sales.reduce((s, x) => s + safeNumber(x.tcUsed), 0);
    const totalTcEarned = sales.reduce((s, x) => s + safeNumber(x.tcEarned), 0);
    return {
      windowDays: days,
      count: sales.length,
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalTcUsed: Number(totalTcUsed.toFixed(2)),
      totalTcEarned: Number(totalTcEarned.toFixed(2)),
      avgTicket: sales.length ? Number((totalRevenue / sales.length).toFixed(2)) : 0,
    };
  } catch (err) {
    return { count: 0, _error: err.message };
  }
}

async function getCustomersSummary() {
  try {
    const total = await prisma.user.count({ where: { role: 'user', active: true } });
    const withBalance = await prisma.user.count({
      where: { role: 'user', active: true, balance: { gt: 0 } },
    });
    const balanceAgg = await prisma.user.aggregate({
      where: { role: 'user', active: true },
      _sum: { balance: true },
    });
    return {
      totalActive: total,
      withTenisCashBalance: withBalance,
      totalTenisCashOutstanding: Number((balanceAgg._sum.balance || 0).toFixed(2)),
    };
  } catch (err) {
    return { totalActive: 0, _error: err.message };
  }
}

async function getSellersSummary({ storeId } = {}) {
  try {
    const where = { role: 'seller', active: true, ...(storeId ? { storeId } : {}) };
    const sellers = await prisma.user.findMany({
      where,
      select: { id: true, name: true, employeeCode: true, storeId: true },
      take: 50,
    });
    return { count: sellers.length, sellers };
  } catch (err) {
    return { count: 0, sellers: [], _error: err.message };
  }
}

async function getPartnersSummary() {
  try {
    const list = await prisma.partner.findMany({
      where: { active: true },
      select: { id: true, name: true, type: true, code: true },
      take: 50,
    });
    return { count: list.length, partners: list };
  } catch (err) {
    return { count: 0, partners: [], _error: err.message };
  }
}

async function getRecentTransactionsSummary({ days = 7 } = {}) {
  try {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const txs = await prisma.transaction.findMany({
      where: { createdAt: { gte: since } },
      select: { amount: true, type: true, status: true, createdAt: true },
      take: 500,
    });
    const total = txs.reduce((s, x) => s + safeNumber(x.amount), 0);
    return {
      windowDays: days,
      count: txs.length,
      totalAmount: Number(total.toFixed(2)),
    };
  } catch (err) {
    return { count: 0, _error: err.message };
  }
}

/**
 * loadBusinessContext — snapshot compacto para alimentar agentes.
 * Tudo é tolerante a falha: campos individuais que falham aparecem com _error.
 */
async function loadBusinessContext({ storeId, userId } = {}) {
  const warnings = [];
  const [
    storesSummary,
    productsSummary,
    recentSalesSummary,
    customersSummary,
    sellersSummary,
    partnersSummary,
    transactionsSummary,
  ] = await Promise.all([
    getStoresSummary(),
    getProductsSummary({ storeId }),
    getRecentSalesSummary({ storeId }),
    getCustomersSummary(),
    getSellersSummary({ storeId }),
    getPartnersSummary(),
    getRecentTransactionsSummary({}),
  ]);

  if (storeId) {
    const exists = (storesSummary || []).some((s) => s.id === storeId || s.code === storeId);
    if (!exists) warnings.push(`storeId/code ${storeId} não encontrado entre lojas ativas.`);
  }

  return {
    company: 'Sports & Tennis',
    snapshotAt: new Date().toISOString(),
    storeContext: storeId || null,
    userContext: userId || null,
    storesSummary,
    productsSummary,
    recentSalesSummary,
    customersSummary,
    sellersSummary,
    partnersSummary,
    transactionsSummary,
    warnings,
  };
}

module.exports = { loadBusinessContext };
