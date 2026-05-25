// =====================================================================
// /api/stocktake — Contagem por bipe (público + admin)
// =====================================================================
// Endpoints públicos (sem auth) usados pela página /bipar.html:
//   GET  /api/stocktake/stores            → lista lojas ativas
//   GET  /api/stocktake/sellers?storeId=  → lista vendedores da loja
//   POST /api/stocktake/bipe              → registra um bipe
//
// Endpoints admin (com auth):
//   GET  /api/stocktake/bipes             → lista bipes p/ revisão (filtros)
//   GET  /api/stocktake/summary           → resumo por loja/vendedor
//   DELETE /api/stocktake/bipes/:id       → remove um bipe (caso erro)
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();

// ============== PÚBLICOS ==============

// GET /api/stocktake/stores → lojas ativas (dropdown)
router.get('/stores', async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true, mall: true },
      orderBy: { name: 'asc' },
    });
    res.json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/sellers?storeId=X → vendedores da loja (dropdown)
router.get('/sellers', async (req, res) => {
  try {
    const where = { active: true, role: 'seller' };
    if (req.query.storeId) where.storeId = String(req.query.storeId);
    const sellers = await prisma.user.findMany({
      where,
      select: { id: true, name: true, employeeCode: true, storeId: true },
      orderBy: { name: 'asc' },
    });
    res.json({ sellers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake/bipe → registra bipe + retorna produto (se achou)
router.post('/bipe', async (req, res) => {
  try {
    const { barcode, storeId, sellerId, sellerName } = req.body || {};
    if (!barcode) return res.status(400).json({ error: 'barcode obrigatório' });

    const code = String(barcode).trim();
    if (!code) return res.status(400).json({ error: 'barcode vazio' });

    // Busca produto pelo barcode no ProductSize
    const sizes = await prisma.productSize.findMany({
      where: { barcode: code },
      include: {
        product: { select: { id: true, name: true, brand: true, sku: true, active: true, imageUrl: true } },
      },
    });

    // Tenta variantes (sem zeros à esquerda)
    let matched = sizes;
    if (matched.length === 0) {
      const stripped = code.replace(/^0+/, '');
      if (stripped && stripped !== code) {
        matched = await prisma.productSize.findMany({
          where: { barcode: stripped },
          include: { product: { select: { id: true, name: true, brand: true, sku: true, active: true, imageUrl: true } } },
        });
      }
    }

    const found = matched.length > 0;
    const duplicate = matched.length > 1;
    // Prefere produto ativo se ambíguo
    const chosen = found ? (matched.find((m) => m.product.active) || matched[0]) : null;

    // Snapshot do vendedor (se sellerId enviado)
    let sellerNameSnap = sellerName || null;
    if (sellerId && !sellerNameSnap) {
      const u = await prisma.user.findUnique({ where: { id: sellerId }, select: { name: true } });
      sellerNameSnap = u?.name || null;
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 200);

    const bipe = await prisma.stocktakeBipe.create({
      data: {
        barcode: code,
        storeId: storeId || null,
        sellerId: sellerId || null,
        sellerName: sellerNameSnap,
        productId: chosen?.product.id || null,
        productSizeId: chosen?.id || null,
        productName: chosen?.product.name || null,
        productSize: chosen?.size || null,
        productBrand: chosen?.product.brand || null,
        found,
        duplicate,
        ip: ip || null,
        userAgent: ua || null,
      },
    });

    res.json({
      success: true,
      bipeId: bipe.id,
      found,
      duplicate,
      product: chosen
        ? {
            name: chosen.product.name,
            brand: chosen.product.brand,
            size: chosen.size,
            sku: chosen.product.sku,
            imageUrl: chosen.product.imageUrl,
            active: chosen.product.active,
          }
        : null,
      candidates: duplicate ? matched.map((m) => ({ name: m.product.name, size: m.size, sku: m.product.sku, active: m.product.active })) : undefined,
    });
  } catch (err) {
    console.error('[stocktake/bipe]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============== ADMIN ==============

router.use(authMiddleware, adminMiddleware);

// GET /api/stocktake/bipes?storeId=&sellerId=&dateFrom=&dateTo=&applied=&found=&today=1&limit=
router.get('/bipes', async (req, res) => {
  try {
    const { storeId, sellerId, sellerName, dateFrom, dateTo, applied, found, today, limit } = req.query;
    const where = {};
    if (storeId) where.storeId = String(storeId);
    if (sellerId) where.sellerId = String(sellerId);
    if (sellerName) where.sellerName = String(sellerName);
    if (applied === 'true') where.applied = true;
    if (applied === 'false') where.applied = false;
    if (found === 'true') where.found = true;
    if (found === 'false') where.found = false;
    if (today === '1') {
      // hoje pela timezone America/Fortaleza
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today`;
      where.bipedAt = { gte: r[0].today };
    } else if (dateFrom || dateTo) {
      where.bipedAt = {};
      if (dateFrom) where.bipedAt.gte = new Date(dateFrom);
      if (dateTo) where.bipedAt.lte = new Date(dateTo);
    }
    const bipes = await prisma.stocktakeBipe.findMany({
      where,
      orderBy: { bipedAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 500, 5000),
    });
    res.json({ bipes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/summary → contagem total + hoje + por vendedor (HOJE)
router.get('/summary', async (_req, res) => {
  try {
    // Define o início do dia em America/Fortaleza
    const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today`;
    const todayStart = r[0].today;

    const [total, totalToday, foundToday, notFoundToday, sellerGroupsToday] = await Promise.all([
      prisma.stocktakeBipe.count(),
      prisma.stocktakeBipe.count({ where: { bipedAt: { gte: todayStart } } }),
      prisma.stocktakeBipe.count({ where: { bipedAt: { gte: todayStart }, found: true } }),
      prisma.stocktakeBipe.count({ where: { bipedAt: { gte: todayStart }, found: false } }),
      prisma.stocktakeBipe.groupBy({
        by: ['sellerId', 'sellerName'],
        where: { bipedAt: { gte: todayStart } },
        _count: { id: true },
      }),
    ]);

    // Pra cada vendedor hoje, contar found/notFound separado
    const bySellerWithFound = [];
    for (const g of sellerGroupsToday) {
      const where = { bipedAt: { gte: todayStart }, sellerId: g.sellerId, sellerName: g.sellerName };
      const [f, nf] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
      ]);
      bySellerWithFound.push({
        id: g.sellerId,
        name: g.sellerName || '(sem nome)',
        total: g._count.id,
        found: f,
        notFound: nf,
      });
    }
    bySellerWithFound.sort((a, b) => b.total - a.total);

    res.json({
      total,
      today: {
        total: totalToday,
        found: foundToday,
        notFound: notFoundToday,
        sellers: sellerGroupsToday.length,
      },
      bySeller: bySellerWithFound,
    });
  } catch (err) {
    console.error('[stocktake/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stocktake/bipes/:id → remove bipe (caso erro)
router.delete('/bipes/:id', async (req, res) => {
  try {
    await prisma.stocktakeBipe.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
