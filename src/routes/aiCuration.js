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

// ---------------------------------------------------------------------
// TEMPORÁRIO (remover após uso): disparo de FOTO-ONLY pros produtos de
// 2026 sem imagem. Protegido por chave na query. NÃO usa authMiddleware
// porque é rodado pelo operador via curl (chaves Serper/Vision/JWT só no
// servidor). Roda em lotes (limit) pra não estourar timeout. Só grava
// imageUrl (skipDescription+skipNuvemshop) — não toca em categoria.
// ---------------------------------------------------------------------
const PULL2026_GUARD = 'px2026_9f3a7c1e8b5d4a26q';
router.post('/_pull2026', async (req, res) => {
  if (req.query.g !== PULL2026_GUARD) return res.status(404).json({ error: 'not found' });
  try {
    if (!serperImg.isConfigured() || !visionConfigured()) {
      return res.json({ ready: false, serper: serperImg.isConfigured(), vision: visionConfigured() });
    }
    const limit = Math.min(15, Math.max(1, Number(req.query.limit) || 8));
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT pr.id FROM "XmlFiscalItem" i
       JOIN "XmlFiscalDocument" d ON d.id=i."fiscalDocumentId"
       JOIN "Product" pr ON pr.id=i."productId"
       WHERE d."docType"='entrada' AND d."issueDate">='2026-01-01' AND pr.active=true AND pr."imageUrl" IS NULL
       LIMIT ${limit}`);
    let withPhoto = 0; const results = [];
    for (const r of rows) {
      try {
        const rep = await curateProduct(r.id, { skipDescription: true, skipNuvemshop: true });
        const url = rep && rep.steps && rep.steps.image ? rep.steps.image.url : null;
        if (url) withPhoto++;
        results.push({ id: r.id, url: url || null, reason: rep?.steps?.image?.reason || null });
      } catch (e) { results.push({ id: r.id, err: e.message }); }
    }
    const remaining = (await prisma.$queryRawUnsafe(
      `SELECT count(DISTINCT pr.id)::int n FROM "XmlFiscalItem" i
       JOIN "XmlFiscalDocument" d ON d.id=i."fiscalDocumentId"
       JOIN "Product" pr ON pr.id=i."productId"
       WHERE d."docType"='entrada' AND d."issueDate">='2026-01-01' AND pr.active=true AND pr."imageUrl" IS NULL`))[0].n;
    res.json({ ready: true, processed: rows.length, withPhoto, remaining, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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

// Resumo GLOBAL de pendências por fornecedor — pra o agente autônomo
// saber por onde começar e o que falta em todo o catálogo.
router.get('/pending-summary', async (_req, res) => {
  try {
    // Agrupa produtos pendentes (sem imagem OU sem descrição) por supplierCnpj.
    const pending = await prisma.product.findMany({
      where: {
        active: true,
        OR: [{ imageUrl: null }, { longDescription: null }],
      },
      select: { id: true, aiContext: true, imageUrl: true, longDescription: true, brand: true },
    });
    const bySupplier = new Map();
    for (const p of pending) {
      const ctx = (() => {
        try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
        catch (_) { return {}; }
      })();
      const cnpj = ctx.supplierCnpj || 'sem-cnpj';
      const entry = bySupplier.get(cnpj) || { cnpj, pending: 0, missingImage: 0, missingDesc: 0, brands: new Set() };
      entry.pending++;
      if (!p.imageUrl) entry.missingImage++;
      if (!p.longDescription) entry.missingDesc++;
      if (p.brand) entry.brands.add(p.brand);
      bySupplier.set(cnpj, entry);
    }
    // Vira array + enriquece com nome do fornecedor
    const cnpjs = [...bySupplier.keys()].filter((c) => c !== 'sem-cnpj');
    const suppliers = await prisma.supplier.findMany({
      where: { cnpj: { in: cnpjs } },
      select: { cnpj: true, companyName: true, averageMarkup: true },
    });
    const supplierByCnpj = Object.fromEntries(suppliers.map((s) => [s.cnpj, s]));

    const list = [...bySupplier.values()]
      .map((e) => ({
        cnpj: e.cnpj,
        companyName: supplierByCnpj[e.cnpj]?.companyName || (e.cnpj === 'sem-cnpj' ? 'Sem CNPJ' : e.cnpj),
        pending: e.pending,
        missingImage: e.missingImage,
        missingDesc: e.missingDesc,
        brands: [...e.brands].slice(0, 3),
      }))
      .sort((a, b) => b.pending - a.pending);

    res.json({ totalPending: pending.length, suppliers: list });
  } catch (err) {
    console.error('[ai-curation/pending-summary] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Fila GLOBAL — todos os produtos pendentes em TODOS os fornecedores
router.get('/queue-all', async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        active: true,
        OR: [{ imageUrl: null }, { longDescription: null }],
      },
      select: { id: true, sku: true, name: true, brand: true, imageUrl: true, longDescription: true, aiContext: true },
      orderBy: [{ brand: 'asc' }, { name: 'asc' }],
    });
    const enriched = products.map((p) => {
      let ctx = {};
      try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
      return {
        id: p.id, sku: p.sku, name: p.name, brand: p.brand,
        supplierCnpj: ctx.supplierCnpj || null,
        missingImage: !p.imageUrl,
        missingDesc: !p.longDescription,
      };
    });
    res.json({ total: enriched.length, products: enriched });
  } catch (err) {
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

// Conserta produtos que tem imageUrl mas estao SEM imageUrls extras (efeito
// colateral do early stop do vision). Busca rapida no Serper e adiciona ate
// 5 fotos extras, sem rodar vision de novo.
router.post('/fix-missing-extras', async (req, res) => {
  try {
    if (!serperImg.isConfigured()) return res.status(400).json({ error: 'Serper não configurado' });
    const { supplierCnpj, limit = 500 } = req.body || {};
    const { getSupplierMeta } = require('../services/supplierOfficialSites');

    const where = {
      active: true,
      imageUrl: { not: null },
      OR: [{ imageUrls: { equals: null } }, { imageUrls: { equals: [] } }],
    };
    if (supplierCnpj) where.aiContext = { path: ['supplierCnpj'], equals: String(supplierCnpj) };

    const products = await prisma.product.findMany({ where, take: parseInt(limit, 10) || 500 });
    let ok = 0, skipped = 0;
    for (const product of products) {
      const ctx = (() => {
        try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
        catch (_) { return {}; }
      })();
      const supplierMeta = getSupplierMeta(ctx.supplierCnpj);
      const officialSite = supplierMeta?.site || null;
      const brandToUse = supplierMeta?.brand || product.brand;
      const cleanName = (product.name || '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim();

      let query = serperImg.buildProductQuery({
        brand: brandToUse,
        supplierRef: ctx.supplierRef,
        model: cleanName,
        color: ctx.color,
        category: product.category,
      });
      if (officialSite) query = `${query} site:${officialSite}`.trim();

      const result = await serperImg.searchImages(query, { count: 8 });
      if (!result.ok || !result.items?.length) { skipped++; continue; }

      const extras = result.items
        .map((it) => it.url)
        .filter((u) => u && u !== product.imageUrl)
        .slice(0, 5);
      if (!extras.length) { skipped++; continue; }

      await prisma.product.update({ where: { id: product.id }, data: { imageUrls: extras } });
      ok++;
      await new Promise((r) => setTimeout(r, 200));
    }

    res.json({ ok: true, total: products.length, completed: ok, skipped });
  } catch (err) {
    console.error('[ai-curation/fix-missing-extras] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
