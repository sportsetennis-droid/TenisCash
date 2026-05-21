// =====================================================================
// Routes: /api/admin/markup — gestão de markup por produto / fornecedor
// =====================================================================
// Modelo:
//   - Product.costPrice    = custo unitário (vem da NF-e)
//   - Product.markupPercent = override individual (null = herda)
//   - Supplier.averageMarkup = markup default do fornecedor
//
// Preço efetivo = costPrice * (1 + markupEfetivo/100)
//   onde markupEfetivo = product.markupPercent ?? supplier.averageMarkup
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

function computePrice(cost, markup) {
  if (cost == null || markup == null) return null;
  return Math.round(cost * (1 + markup / 100) * 100) / 100;
}

// Resumo: lista fornecedores com markup, totais de produtos, custo médio etc.
router.get('/summary', async (_req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where: { active: true, cnpj: { not: null } },
      orderBy: { companyName: 'asc' },
    });

    // Agrega unidades reais compradas via NFe entrada, agrupado por CNPJ emissor
    const nfeAgg = await prisma.$queryRaw`
      SELECT d."issuerCnpj" as cnpj,
             sum(i.quantity)::float as units,
             sum(i."totalValue")::float as value,
             count(i.id)::int as lines,
             count(DISTINCT d.id)::int as nfes
      FROM "XmlFiscalItem" i
      JOIN "XmlFiscalDocument" d ON i."fiscalDocumentId"=d.id
      WHERE d."docType"='entrada' AND d."issuerCnpj" IS NOT NULL
      GROUP BY d."issuerCnpj"
    `;
    const nfeMap = Object.fromEntries(nfeAgg.map(r => [r.cnpj, r]));

    const rows = [];
    for (const s of suppliers) {
      const where = {
        active: true,
        aiContext: { path: ['supplierCnpj'], equals: s.cnpj },
      };
      const [productCount, withCost, withPrice, agg] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.count({ where: { ...where, costPrice: { not: null } } }),
        prisma.product.count({ where: { ...where, price: { gt: 0 } } }),
        prisma.product.aggregate({
          _avg: { costPrice: true, price: true },
          where,
        }),
      ]);
      const nfe = nfeMap[s.cnpj] || {};
      rows.push({
        supplierId: s.id,
        cnpj: s.cnpj,
        companyName: s.companyName,
        markup: s.averageMarkup,
        productCount,
        withCost,
        withPrice,
        avgCost: agg._avg.costPrice,
        avgPrice: agg._avg.price,
        // Unidades reais compradas via NFe entrada
        unitsBought: nfe.units || 0,
        purchaseValue: nfe.value || 0,
        nfeLines: nfe.lines || 0,
        nfeCount: nfe.nfes || 0,
      });
    }
    res.json({ suppliers: rows });
  } catch (err) {
    console.error('[markup/summary] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Lista produtos de um fornecedor com custo/markup/preço
router.get('/supplier/:cnpj/products', async (req, res) => {
  try {
    const cnpj = req.params.cnpj;
    const supplier = await prisma.supplier.findUnique({ where: { cnpj } });
    const products = await prisma.product.findMany({
      where: {
        active: true,
        aiContext: { path: ['supplierCnpj'], equals: cnpj },
      },
      select: {
        id: true, sku: true, name: true, brand: true, category: true,
        costPrice: true, markupPercent: true, price: true, promoPrice: true,
        imageUrl: true, aiContext: true,
        longDescription: true, shortDescription: true,
        sizes: { select: { size: true, stock: true } },
      },
      orderBy: { name: 'asc' },
    });
    const supplierMarkup = supplier?.averageMarkup ?? null;
    const enriched = products.map((p) => {
      const effectiveMarkup = p.markupPercent ?? supplierMarkup;
      const computed = computePrice(p.costPrice, effectiveMarkup);
      return { ...p, effectiveMarkup, computedPrice: computed };
    });
    res.json({
      supplier: supplier ? { cnpj, companyName: supplier.companyName, averageMarkup: supplier.averageMarkup } : null,
      products: enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setar markup de um fornecedor + opcionalmente aplicar nos produtos (atualiza price)
router.post('/supplier/:cnpj', async (req, res) => {
  try {
    const cnpj = req.params.cnpj;
    const { markup, applyToProducts } = req.body || {};
    const m = parseFloat(markup);
    if (isNaN(m) || m < 0) return res.status(400).json({ error: 'markup inválido (ex: 80 para 80%)' });

    const supplier = await prisma.supplier.update({
      where: { cnpj },
      data: { averageMarkup: m },
    });

    let applied = 0;
    if (applyToProducts) {
      // Aplica em TODOS os produtos do fornecedor que NÃO têm markup individual.
      // Recalcula price = cost * (1 + m/100).
      const candidates = await prisma.product.findMany({
        where: {
          active: true,
          aiContext: { path: ['supplierCnpj'], equals: cnpj },
          markupPercent: null,
          costPrice: { not: null, gt: 0 },
        },
        select: { id: true, costPrice: true },
      });
      for (const p of candidates) {
        const newPrice = computePrice(p.costPrice, m);
        if (newPrice == null) continue;
        await prisma.product.update({ where: { id: p.id }, data: { price: newPrice } });
        applied++;
      }
    }

    res.json({ supplier, applied });
  } catch (err) {
    console.error('[markup/supplier] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Setar markup de UM produto (override) + recalcula preço
router.post('/product/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { markup, costPrice } = req.body || {};
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const ctx = (() => {
      try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
      catch (_) { return {}; }
    })();
    const supplier = ctx.supplierCnpj ? await prisma.supplier.findUnique({ where: { cnpj: ctx.supplierCnpj } }) : null;

    const data = {};
    if (costPrice != null) {
      const c = parseFloat(costPrice);
      if (!isNaN(c) && c >= 0) data.costPrice = c;
    }
    let markupToUse = product.markupPercent;
    if (markup === null || markup === '') {
      data.markupPercent = null; // remove override → volta pro do supplier
      markupToUse = supplier?.averageMarkup ?? null;
    } else if (markup != null) {
      const m = parseFloat(markup);
      if (!isNaN(m) && m >= 0) {
        data.markupPercent = m;
        markupToUse = m;
      }
    }
    // Calcula novo preço com cost atualizado se mudou
    const effectiveCost = data.costPrice != null ? data.costPrice : product.costPrice;
    const newPrice = computePrice(effectiveCost, markupToUse);
    if (newPrice != null) data.price = newPrice;

    const updated = await prisma.product.update({ where: { id }, data });
    res.json({ product: updated, effectiveMarkup: markupToUse, computedPrice: newPrice });
  } catch (err) {
    console.error('[markup/product] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reaplica markups (refaz price em todos os produtos com custo + markup definidos).
// Útil depois de backfill de custo ou mudança em massa.
router.post('/recompute-all', async (req, res) => {
  try {
    const { supplierCnpj } = req.body || {};
    const where = {
      active: true,
      costPrice: { not: null, gt: 0 },
    };
    if (supplierCnpj) {
      where.aiContext = { path: ['supplierCnpj'], equals: String(supplierCnpj) };
    }
    const products = await prisma.product.findMany({
      where,
      select: { id: true, costPrice: true, markupPercent: true, aiContext: true },
    });
    const supplierMarkupCache = new Map();
    let updated = 0;
    for (const p of products) {
      let m = p.markupPercent;
      if (m == null) {
        const cnpj = (typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {})).supplierCnpj;
        if (!cnpj) continue;
        if (!supplierMarkupCache.has(cnpj)) {
          const s = await prisma.supplier.findUnique({ where: { cnpj } });
          supplierMarkupCache.set(cnpj, s?.averageMarkup ?? null);
        }
        m = supplierMarkupCache.get(cnpj);
      }
      const newPrice = computePrice(p.costPrice, m);
      if (newPrice == null) continue;
      await prisma.product.update({ where: { id: p.id }, data: { price: newPrice } });
      updated++;
    }
    res.json({ updated, total: products.length });
  } catch (err) {
    console.error('[markup/recompute-all] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
