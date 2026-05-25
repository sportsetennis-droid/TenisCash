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

// GET /api/stocktake/summary?date=YYYY-MM-DD → contagem total + dia + por vendedor
// (sem ?date usa hoje no fuso America/Fortaleza)
router.get('/summary', async (req, res) => {
  try {
    let dayStart, dayEnd;
    if (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date))) {
      // Range exato do dia escolhido em UTC-3 (Fortaleza)
      dayStart = new Date(req.query.date + 'T00:00:00-03:00');
      dayEnd = new Date(req.query.date + 'T23:59:59.999-03:00');
    } else {
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today, (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '1 day' - INTERVAL '1 millisecond')::timestamp AS end_today`;
      dayStart = r[0].today;
      dayEnd = r[0].end_today;
    }

    const dayWhere = { bipedAt: { gte: dayStart, lte: dayEnd } };

    const [total, totalDay, foundDay, notFoundDay, sellerGroupsDay, storeGroupsDay] = await Promise.all([
      prisma.stocktakeBipe.count(),
      prisma.stocktakeBipe.count({ where: dayWhere }),
      prisma.stocktakeBipe.count({ where: { ...dayWhere, found: true } }),
      prisma.stocktakeBipe.count({ where: { ...dayWhere, found: false } }),
      prisma.stocktakeBipe.groupBy({
        by: ['sellerId', 'sellerName'],
        where: dayWhere,
        _count: { id: true },
      }),
      prisma.stocktakeBipe.groupBy({
        by: ['storeId'],
        where: dayWhere,
        _count: { id: true },
      }),
    ]);

    // Hidrata nome da loja — TODAS as ativas (mesmo as sem bipe)
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true },
      orderBy: { code: 'asc' },
    });
    const storeMap = Object.fromEntries(stores.map((s) => [s.id, s]));

    // Mapa dos grupos que tiveram bipe (acesso O(1))
    const groupedById = {};
    storeGroupsDay.forEach(g => { groupedById[g.storeId || 'NULL'] = g._count.id; });

    // Loop por TODAS as lojas ativas (lista completa)
    const byStoreWithFound = [];
    for (const store of stores) {
      const where = { ...dayWhere, storeId: store.id };
      const [f, nf, total] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
        prisma.stocktakeBipe.count({ where }),
      ]);
      byStoreWithFound.push({
        id: store.id,
        name: store.name,
        code: store.code,
        total,
        found: f,
        notFound: nf,
      });
    }
    // Bipes sem storeId (vendedor não escolheu loja)
    const semLojaCount = groupedById['NULL'] || 0;
    if (semLojaCount > 0) {
      const where = { ...dayWhere, storeId: null };
      const [f, nf] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
      ]);
      byStoreWithFound.push({
        id: null,
        name: '(sem loja selecionada)',
        code: '⚠️',
        total: semLojaCount,
        found: f,
        notFound: nf,
      });
    }
    // Ordena: mais bipes primeiro, depois alfabético
    byStoreWithFound.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

    const bySellerWithFound = [];
    for (const g of sellerGroupsDay) {
      const where = { ...dayWhere, sellerId: g.sellerId, sellerName: g.sellerName };
      const [f, nf, storeBreak] = await Promise.all([
        prisma.stocktakeBipe.count({ where: { ...where, found: true } }),
        prisma.stocktakeBipe.count({ where: { ...where, found: false } }),
        prisma.stocktakeBipe.groupBy({ by: ['storeId'], where, _count: { id: true } }),
      ]);
      // Lojas onde esse vendedor bipou no dia
      const stores = storeBreak.map(s => ({
        id: s.storeId,
        name: storeMap[s.storeId]?.name || '(sem loja)',
        count: s._count.id,
      })).sort((a, b) => b.count - a.count);
      bySellerWithFound.push({
        id: g.sellerId,
        name: g.sellerName || '(sem nome)',
        total: g._count.id,
        found: f,
        notFound: nf,
        stores,
      });
    }
    bySellerWithFound.sort((a, b) => b.total - a.total);

    res.json({
      total,
      day: {
        total: totalDay,
        found: foundDay,
        notFound: notFoundDay,
        sellers: sellerGroupsDay.length,
        stores: storeGroupsDay.length,
      },
      // alias 'today' pra compat
      today: {
        total: totalDay,
        found: foundDay,
        notFound: notFoundDay,
        sellers: sellerGroupsDay.length,
      },
      byStore: byStoreWithFound,
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
