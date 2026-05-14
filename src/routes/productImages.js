// =====================================================================
// Routes: /api/admin/product-images — busca e seleção de imagem do produto
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const gis = require('../services/googleImageSearch');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Status da configuração Google
router.get('/status', (_req, res) => {
  res.json({ configured: gis.isConfigured() });
});

// Busca candidatas de imagem pra um produto
router.get('/search/:productId', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    // Constrói query: usa nome do produto + marca + cor (do aiContext)
    const ctx = (() => {
      try {
        if (!product.aiContext) return {};
        return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
      } catch (_) { return {}; }
    })();

    const queryOverride = req.query.q;
    const query = queryOverride || gis.buildProductQuery({
      brand: product.brand,
      model: product.name,
      color: ctx.color,
      category: product.category,
    });

    const result = await gis.searchImages(query, {
      count: parseInt(req.query.count || '5', 10),
      imgSize: req.query.imgSize || 'large',
    });

    res.json({ query, ...result });
  } catch (err) {
    console.error('[product-images/search] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Seleciona uma imagem como principal do produto
router.post('/select/:productId', async (req, res) => {
  try {
    const { imageUrl, additionalImages } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl é obrigatório' });

    const data = { imageUrl };
    if (Array.isArray(additionalImages) && additionalImages.length) {
      data.imageUrls = additionalImages;
    }

    const product = await prisma.product.update({
      where: { id: req.params.productId },
      data,
    });
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Limpa imagem selecionada (volta a estar "pendente de revisão")
router.delete('/select/:productId', async (req, res) => {
  try {
    const product = await prisma.product.update({
      where: { id: req.params.productId },
      data: { imageUrl: null, imageUrls: null },
    });
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista produtos pendentes de imagem (sem imageUrl)
router.get('/pending', async (req, res) => {
  try {
    const { brand, limit, supplierCnpj } = req.query;
    const where = {
      active: true,
      imageUrl: null,
      ...(brand ? { brand: { contains: String(brand), mode: 'insensitive' } } : {}),
    };
    let products = await prisma.product.findMany({
      where,
      take: Math.min(parseInt(limit || '50', 10), 200),
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, sku: true, name: true, brand: true, category: true,
        price: true, aiContext: true, createdAt: true,
      },
    });

    // Filtro adicional por supplierCnpj (vem do aiContext)
    if (supplierCnpj) {
      products = products.filter((p) => {
        try {
          const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext;
          return ctx?.supplierCnpj === supplierCnpj;
        } catch (_) { return false; }
      });
    }

    const totalPending = await prisma.product.count({ where: { active: true, imageUrl: null } });
    res.json({ products, totalPending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
