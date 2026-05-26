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

// Extrai tamanho da descricao da NFe (mesmo regex do script create-products-from-nfe-pending.js)
function inferSizeFromDescription(description) {
  if (!description) return 'Único';
  const d = String(description).toUpperCase().trim();
  const acessorios = /\b(MEIA|MEIAS|BOLSA|MOCHILA|GARRAFA|TOALHA|VISEIRA|BONE|BONÉ|BANDEIRA|FAIXA|MUNHEQUEIRA|RAQUETE|BOLA|CORDA|CASQUEIRA|GORRO|TOUCA|LUVA|ÓCULOS|OCULOS|RELOGIO|MEDALHA|TROFEU)\b/;
  if (acessorios.test(d)) return 'Único';
  // Padrao: "TAMANHO:38;COR:..."
  const mTamCol = d.match(/TAMANHO:\s*([A-Z0-9]+)\s*[;,]/);
  if (mTamCol) return mTamCol[1];
  const mTam = d.match(/\bTAM\.?\s*(\d{2})\b/);
  if (mTam) return mTam[1];
  const mTamL = d.match(/\bTAM\.?\s*(PP|P|M|G|GG|XGG|XG)\b/);
  if (mTamL) return mTamL[1];
  if (/\b\d{2}[\/\-A]\s*\d{2}\b/.test(d) || /\b\d{2}\s+A\s+\d{2}\b/.test(d)) return '?';
  const mEnd = d.match(/\s(\d{2})\s*$/);
  if (mEnd) return mEnd[1];
  if (/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/.test(d)) {
    const m = d.match(/\b(PP|XGG|XG|GG|G|M|P)\b\s*$/);
    if (m) return m[1];
  }
  return 'Único';
}

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

    // FALLBACK NFe DESLIGADO (26/05/2026): estava causando matches errados.
    // Quando EAN nao acha ProductSize, agora deixa como found=false (igual
    // antes do dia 26/05) pra dono revisar manual em /bipes.html.
    // Não criar ProductSize nem incrementar StoreStock baseado em NFe.
    let autoCreated = false;

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

    // REAL-TIME: bipe atualiza StoreStock NA HORA (+1 unidade)
    // Regra confirmada pelo dono: cada bipe = +1 unidade da SKU naquela loja, imediatamente.
    let appliedToStock = false;
    if (chosen && storeId && chosen.id) {
      try {
        await prisma.storeStock.upsert({
          where: { storeId_productSizeId: { storeId, productSizeId: chosen.id } },
          update: { stock: { increment: 1 } },
          create: { storeId, productSizeId: chosen.id, stock: 1 },
        });
        await prisma.stocktakeBipe.update({ where: { id: bipe.id }, data: { applied: true } });
        appliedToStock = true;
      } catch (e) {
        console.warn('[bipe] upsert StoreStock falhou:', e.message);
      }
    }

    res.json({
      success: true,
      bipeId: bipe.id,
      appliedToStock,
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

// GET /api/stocktake/biped-product-ids
// Retorna lista única de productIds que já apareceram em bipes (com found=true)
// Usado pelo card de classificação pra filtrar só produtos que foram bipados.
router.get('/biped-product-ids', async (req, res) => {
  try {
    const { storeId, days } = req.query;
    const where = { productId: { not: null }, found: true };
    if (storeId) where.storeId = String(storeId);
    if (days && /^\d+$/.test(String(days))) {
      const since = new Date(Date.now() - parseInt(days, 10) * 86400000);
      where.bipedAt = { gte: since };
    }
    const rows = await prisma.stocktakeBipe.findMany({
      where,
      select: { productId: true },
      distinct: ['productId'],
    });
    const productIds = rows.map(r => r.productId).filter(Boolean);
    res.json({ productIds, total: productIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// POST /api/stocktake/apply-to-stock — aplica bipes no StoreStock
// Body opcional: { date: 'YYYY-MM-DD', storeId, sellerId, dryRun: true }
// Modo "Substituir": pra cada (productSize, store), conta TODOS os bipes
// found=true daquele dia/filtro e SOBRESCREVE o stock com esse número.
// Marca bipes como applied=true.
router.post('/apply-to-stock', async (req, res) => {
  try {
    const { date, storeId, sellerId, dryRun } = req.body || {};

    // Range do dia (default: hoje America/Fortaleza)
    let dayStart, dayEnd;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      dayStart = new Date(date + 'T00:00:00-03:00');
      dayEnd = new Date(date + 'T23:59:59.999-03:00');
    } else {
      const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS today, (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '1 day' - INTERVAL '1 millisecond')::timestamp AS end_today`;
      dayStart = r[0].today; dayEnd = r[0].end_today;
    }

    const where = {
      bipedAt: { gte: dayStart, lte: dayEnd },
      found: true,
      applied: false,
      productSizeId: { not: null },
      storeId: { not: null },
    };
    if (storeId) where.storeId = String(storeId);
    if (sellerId) where.sellerId = String(sellerId);

    // Agrupa por (storeId, productSizeId) e conta os bipes
    const groups = await prisma.stocktakeBipe.groupBy({
      by: ['storeId', 'productSizeId'],
      where,
      _count: { id: true },
    });

    if (groups.length === 0) {
      return res.json({ ok: true, applied: 0, products: 0, bipes: 0, dryRun: !!dryRun, message: 'Sem bipes pra aplicar' });
    }

    // Pega produtos pra mostrar mudanças
    const sizeIds = [...new Set(groups.map(g => g.productSizeId))];
    const sizes = await prisma.productSize.findMany({
      where: { id: { in: sizeIds } },
      include: { product: { select: { id: true, name: true, brand: true, sku: true } } },
    });
    const sizeMap = Object.fromEntries(sizes.map(s => [s.id, s]));

    const storeIds = [...new Set(groups.map(g => g.storeId))];
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, code: true } });
    const storeMap = Object.fromEntries(stores.map(s => [s.id, s]));

    // Estoque atual pra calcular delta
    const currentStocks = await prisma.storeStock.findMany({
      where: {
        OR: groups.map(g => ({ storeId: g.storeId, productSizeId: g.productSizeId })),
      },
    });
    const currentMap = Object.fromEntries(currentStocks.map(s => [s.storeId + ':' + s.productSizeId, s.stock]));

    // Monta plano
    const plan = groups.map(g => {
      const key = g.storeId + ':' + g.productSizeId;
      const current = currentMap[key] || 0;
      const newStock = g._count.id;
      const size = sizeMap[g.productSizeId];
      const store = storeMap[g.storeId];
      return {
        storeId: g.storeId, storeName: store?.name, storeCode: store?.code,
        productSizeId: g.productSizeId, size: size?.size, productName: size?.product?.name,
        brand: size?.product?.brand, sku: size?.product?.sku,
        currentStock: current,
        newStock,
        delta: newStock - current,
        bipes: g._count.id,
      };
    });

    if (dryRun) {
      return res.json({ ok: true, dryRun: true, plan, total: plan.length });
    }

    // EXECUTA: upsert StoreStock + marca bipes como applied
    let appliedStocks = 0;
    for (const item of plan) {
      await prisma.storeStock.upsert({
        where: { storeId_productSizeId: { storeId: item.storeId, productSizeId: item.productSizeId } },
        update: { stock: item.newStock },
        create: { storeId: item.storeId, productSizeId: item.productSizeId, stock: item.newStock },
      });
      appliedStocks++;
    }
    const upd = await prisma.stocktakeBipe.updateMany({ where, data: { applied: true } });

    res.json({
      ok: true,
      applied: appliedStocks,
      bipes: upd.count,
      products: new Set(plan.map(p => p.productSizeId)).size,
      stores: new Set(plan.map(p => p.storeId)).size,
      plan,
    });
  } catch (err) {
    console.error('[stocktake/apply-to-stock]', err);
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
