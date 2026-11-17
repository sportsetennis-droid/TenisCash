// Painel de vendas (admin, só leitura).
//   GET /api/sales-dashboard/summary?days=30
// Vendas por loja/dia (dia do calendário de Fortaleza), ticket médio e top
// marcas. Conta só venda com status 'completed' (cancelada/aguardando
// pagamento ficam de fora). Valores da venda = Sale.totalAmount (líquido do
// desconto); marcas = soma de SaleItem.totalPrice das mesmas vendas.
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
const TZ = 'America/Fortaleza';

function todayYmd(now = new Date()) { return now.toLocaleDateString('en-CA', { timeZone: TZ }); }
function addDays(ymd, n) { return new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10); }
// 00:00 de Fortaleza (UTC-3 fixo) em UTC. Sale.createdAt é gravado em UTC.
function localMidnightUtc(ymd) { return new Date(ymd + 'T03:00:00.000Z'); }
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

async function buildSummary(prismaClient, { days = 30, now = new Date() } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 30));
  const lastDay = todayYmd(now);
  const firstDay = addDays(lastDay, -(n - 1));
  const from = localMidnightUtc(firstDay);
  const to = localMidnightUtc(addDays(lastDay, 1));

  const [perDay, brands, stores] = await Promise.all([
    prismaClient.$queryRaw`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS "day",
             "storeId", COUNT(*)::int AS "sales", COALESCE(SUM("totalAmount"), 0)::float8 AS "revenue"
        FROM "Sale"
       WHERE "status" = 'completed' AND "createdAt" >= ${from} AND "createdAt" < ${to}
       GROUP BY 1, 2`,
    prismaClient.$queryRaw`
      SELECT COALESCE(NULLIF(TRIM(i."brand"), ''), 'Sem marca') AS "brand",
             COALESCE(SUM(i."quantity"), 0)::int AS "units", COALESCE(SUM(i."totalPrice"), 0)::float8 AS "revenue"
        FROM "SaleItem" i JOIN "Sale" s ON s."id" = i."saleId"
       WHERE s."status" = 'completed' AND s."createdAt" >= ${from} AND s."createdAt" < ${to}
       GROUP BY 1 ORDER BY "revenue" DESC LIMIT 10`,
    prismaClient.store.findMany({ select: { id: true, code: true, name: true } }),
  ]);

  const storeById = new Map(stores.map((s) => [s.id, s]));
  const dayList = [];
  for (let d = firstDay; d <= lastDay; d = addDays(d, 1)) dayList.push(d);

  const byStore = new Map();
  let totalSales = 0;
  let totalRevenue = 0;
  for (const r of perDay) {
    const key = r.storeId || '_none';
    if (!byStore.has(key)) {
      const st = r.storeId ? storeById.get(r.storeId) : null;
      byStore.set(key, {
        storeId: r.storeId || null,
        code: st ? st.code : null,
        name: st ? st.name : (r.storeId ? 'Loja ' + String(r.storeId).slice(0, 6) : 'Sem loja'),
        sales: 0, revenue: 0, daily: Object.fromEntries(dayList.map((d) => [d, 0])),
      });
    }
    const s = byStore.get(key);
    s.sales += r.sales;
    s.revenue += r.revenue;
    if (s.daily[r.day] !== undefined) s.daily[r.day] += r.revenue;
    totalSales += r.sales;
    totalRevenue += r.revenue;
  }
  const storeRows = [...byStore.values()]
    .map((s) => ({
      storeId: s.storeId, code: s.code, name: s.name,
      sales: s.sales, revenue: round2(s.revenue), avgTicket: s.sales ? round2(s.revenue / s.sales) : 0,
      daily: dayList.map((d) => round2(s.daily[d])),
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    timezone: TZ,
    from: firstDay,
    to: lastDay,
    days: dayList,
    totals: { sales: totalSales, revenue: round2(totalRevenue), avgTicket: totalSales ? round2(totalRevenue / totalSales) : 0 },
    stores: storeRows,
    topBrands: brands.map((b) => ({ brand: b.brand, units: b.units, revenue: round2(b.revenue) })),
  };
}

router.get('/summary', authMiddleware, adminMiddleware, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await buildSummary(prisma, { days: req.query.days }));
  } catch (e) {
    console.error('[sales-dashboard/summary]', e.message);
    res.status(500).json({ error: 'Não foi possível montar o painel agora.' });
  }
});

router.buildSummary = buildSummary;
module.exports = router;
