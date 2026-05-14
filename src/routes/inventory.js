// =====================================================================
// Routes: /api/admin/inventory — Estoque com ciclo de vida do produto
// =====================================================================
// Trabalha em cima de Product + ProductSize (que já existem) e
// ProductLifecycle (modelo novo). Reclassifica status do ciclo conforme
// idade e venda — chamado em /reclassify.

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Dashboard de estoque
router.get('/dashboard', async (_req, res) => {
  try {
    const [totalProducts, lowStock, allLifecycles, stockValueAgg] = await Promise.all([
      prisma.product.count({ where: { active: true } }),
      prisma.productSize.findMany({ where: { stock: { lte: 5 } }, include: { product: true } }),
      prisma.productLifecycle.findMany(),
      prisma.productSize.findMany({ include: { product: true } }),
    ]);

    // Valor total de estoque
    const stockValue = stockValueAgg.reduce((s, sz) => s + (sz.stock || 0) * (sz.product?.price || 0), 0);

    // Distribuição por lifecycle
    const lifecycleDistribution = {};
    allLifecycles.forEach((l) => {
      lifecycleDistribution[l.lifecycleStatus] = (lifecycleDistribution[l.lifecycleStatus] || 0) + 1;
    });

    res.json({
      stats: {
        totalActiveProducts: totalProducts,
        lowStockSkus: lowStock.length,
        totalStockValue: Number(stockValue.toFixed(2)),
        productsWithLifecycle: allLifecycles.length,
      },
      lifecycleDistribution,
      lowStockTop: lowStock.slice(0, 20).map((s) => ({
        sku: s.product?.sku,
        name: s.product?.name,
        size: s.size,
        stock: s.stock,
      })),
    });
  } catch (err) {
    console.error('[inventory/dashboard] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard de estoque' });
  }
});

// Lista produtos com info de lifecycle e estoque
router.get('/products', async (req, res) => {
  try {
    const { lifecycleStatus, brand, category, lowStock } = req.query;
    const where = {
      active: true,
      ...(brand ? { brand: { contains: brand, mode: 'insensitive' } } : {}),
      ...(category ? { category: { contains: category, mode: 'insensitive' } } : {}),
    };
    const products = await prisma.product.findMany({
      where,
      include: { sizes: true },
      take: 200,
      orderBy: { name: 'asc' },
    });

    // Junta lifecycle
    const lifecycles = await prisma.productLifecycle.findMany({
      where: { productId: { in: products.map((p) => p.id) } },
    });
    const lcByProductId = Object.fromEntries(lifecycles.map((l) => [l.productId, l]));

    const items = products
      .map((p) => {
        const totalStock = (p.sizes || []).reduce((s, x) => s + (x.stock || 0), 0);
        const lifecycle = lcByProductId[p.id] || null;
        const ctx = (() => {
          try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
          catch (_) { return {}; }
        })();
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          brand: p.brand,
          category: p.category,
          supplierRef: ctx.supplierRef || null,
          gender: ctx.gender || null,
          ageGroup: ctx.ageGroup || null,
          sport: ctx.sport || null,
          color: ctx.color || null,
          location: ctx.location || null,
          price: p.price,
          promoPrice: p.promoPrice,
          totalStock,
          sizes: p.sizes,
          lifecycle,
        };
      })
      .filter((it) => {
        if (lifecycleStatus && it.lifecycle?.lifecycleStatus !== lifecycleStatus) return false;
        if (lowStock === 'true' && it.totalStock > 5) return false;
        return true;
      });

    res.json({ products: items });
  } catch (err) {
    console.error('[inventory/products] erro:', err);
    res.status(500).json({ error: 'Erro ao listar estoque' });
  }
});

// Reclassifica lifecycle de todos os produtos
router.post('/reclassify', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { active: true },
      include: { sizes: true },
    });

    let created = 0;
    let updated = 0;
    const now = Date.now();

    for (const p of products) {
      const totalStock = (p.sizes || []).reduce((s, x) => s + (x.stock || 0), 0);
      const daysInStock = Math.floor((now - new Date(p.createdAt).getTime()) / (24 * 3600 * 1000));

      let status = 'NEW';
      if (totalStock === 0) status = 'SOLD_OUT';
      else if (daysInStock < 15) status = 'NEW';
      else if (daysInStock > 90) status = 'STUCK';
      else if (daysInStock > 60) status = 'SLOW_TURNOVER';
      else status = 'NORMAL_TURNOVER';

      const existing = await prisma.productLifecycle.findUnique({ where: { productId: p.id } });
      if (existing) {
        await prisma.productLifecycle.update({
          where: { productId: p.id },
          data: { lifecycleStatus: status, daysInStock, lastEvaluatedAt: new Date() },
        });
        updated++;
      } else {
        await prisma.productLifecycle.create({
          data: {
            productId: p.id,
            lifecycleStatus: status,
            daysInStock,
            stockEntryDate: p.createdAt,
            lastEvaluatedAt: new Date(),
          },
        });
        created++;
      }
    }

    res.json({ ok: true, created, updated, totalProducts: products.length });
  } catch (err) {
    console.error('[inventory/reclassify] erro:', err);
    res.status(500).json({ error: 'Erro ao reclassificar', detail: err.message });
  }
});

// Atualizar lifecycle manualmente
router.put('/lifecycle/:productId', async (req, res) => {
  try {
    const data = req.body || {};
    const existing = await prisma.productLifecycle.findUnique({ where: { productId: req.params.productId } });
    let lc;
    if (existing) {
      lc = await prisma.productLifecycle.update({ where: { productId: req.params.productId }, data });
    } else {
      lc = await prisma.productLifecycle.create({ data: { productId: req.params.productId, ...data } });
    }
    res.json({ lifecycle: lc });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar lifecycle' });
  }
});

// Ajuste manual de estoque (de tamanho específico)
router.post('/adjust', async (req, res) => {
  try {
    const { productSizeId, delta, reason } = req.body || {};
    if (!productSizeId || delta == null) return res.status(400).json({ error: 'productSizeId e delta são obrigatórios' });
    const size = await prisma.productSize.findUnique({ where: { id: productSizeId } });
    if (!size) return res.status(404).json({ error: 'Tamanho não encontrado' });
    const newStock = Math.max(0, (size.stock || 0) + parseInt(delta, 10));
    const updated = await prisma.productSize.update({
      where: { id: productSizeId },
      data: { stock: newStock },
    });
    res.json({ size: updated, previousStock: size.stock, delta: parseInt(delta, 10), reason: reason || null });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao ajustar estoque', detail: err.message });
  }
});

module.exports = router;
