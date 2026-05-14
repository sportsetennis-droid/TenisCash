// =====================================================================
// Routes: /api/admin/ai-curation — agente curador autônomo com IA
// =====================================================================
// Fluxo: pega produtos sem imagem/descrição completas, chama o
// curationAgent.curateProduct pra cada um (que usa Claude Vision pra
// escolher a melhor imagem + scraper pra descrição + push Nuvemshop)
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { curateProduct } = require('../services/curationAgent');
const { isConfigured: visionConfigured } = require('../services/visionValidator');
const serperImg = require('../services/serperImageSearch');
const serperWeb = require('../services/serperWebSearch');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Status das integrações necessárias
router.get('/status', (_req, res) => {
  res.json({
    vision: visionConfigured(),
    serperImage: serperImg.isConfigured(),
    serperWeb: serperWeb.isConfigured(),
    ready: visionConfigured() && serperImg.isConfigured(),
  });
});

// Cura UM produto (síncrono) — útil pra polling do frontend
router.post('/product/:id', async (req, res) => {
  try {
    const opts = {
      skipImage: !!req.body?.skipImage,
      skipDescription: !!req.body?.skipDescription,
      skipNuvemshop: !!req.body?.skipNuvemshop,
      minScore: req.body?.minScore != null ? Number(req.body.minScore) : 5,
      imageCandidates: req.body?.imageCandidates != null ? Number(req.body.imageCandidates) : 6,
    };
    const r = await curateProduct(req.params.id, opts);
    res.json(r);
  } catch (err) {
    console.error('[ai-curation/product] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Lista de produtos pendentes de curadoria pra um fornecedor
router.get('/queue/:cnpj', async (req, res) => {
  try {
    const cnpj = req.params.cnpj;
    const products = await prisma.product.findMany({
      where: {
        active: true,
        aiContext: { path: ['supplierCnpj'], equals: cnpj },
        OR: [{ imageUrl: null }, { longDescription: null }],
      },
      select: { id: true, sku: true, name: true, imageUrl: true, longDescription: true },
      orderBy: { name: 'asc' },
    });
    res.json({ cnpj, total: products.length, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cura em massa por fornecedor — síncrono, devolve relatório completo
router.post('/supplier/:cnpj', async (req, res) => {
  try {
    const cnpj = req.params.cnpj;
    const limit = parseInt(req.body?.limit, 10) || 100;
    const opts = {
      skipImage: !!req.body?.skipImage,
      skipDescription: !!req.body?.skipDescription,
      skipNuvemshop: !!req.body?.skipNuvemshop,
      minScore: req.body?.minScore != null ? Number(req.body.minScore) : 5,
      imageCandidates: req.body?.imageCandidates != null ? Number(req.body.imageCandidates) : 6,
    };
    const where = {
      active: true,
      aiContext: { path: ['supplierCnpj'], equals: cnpj },
      OR: [{ imageUrl: null }, { longDescription: null }],
    };
    const products = await prisma.product.findMany({ where, take: limit });

    let imageOk = 0, descOk = 0, nsOk = 0, errors = 0;
    let totalCostBRL = 0;
    const reports = [];
    for (const p of products) {
      const r = await curateProduct(p.id, opts);
      if (r.steps.image?.ok) imageOk++;
      if (r.steps.description?.ok) descOk++;
      if (r.steps.nuvemshop?.synced) nsOk++;
      if (r.error) errors++;
      totalCostBRL += r.costBRL || 0;
      reports.push(r);
      await new Promise((rs) => setTimeout(rs, 300));
    }

    res.json({
      ok: true, cnpj,
      total: products.length,
      imageOk, descOk, nsOk, errors,
      totalCostBRL: Math.round(totalCostBRL * 100) / 100,
      reports: reports.slice(0, 50),
    });
  } catch (err) {
    console.error('[ai-curation/supplier] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
