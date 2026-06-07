// =====================================================================
// Routes: /api/admin/suppliers — CRUD de fornecedores
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { recalcSizeStock } = require('../services/stockSync');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/', async (req, res) => {
  try {
    const { search, active } = req.query;
    const where = {
      ...(active != null ? { active: active === 'true' } : {}),
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { cnpj: { contains: search } },
              { representativeName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const list = await prisma.supplier.findMany({ where, orderBy: { companyName: 'asc' }, take: 200 });
    res.json({ suppliers: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar fornecedores' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    // Estatísticas: contas a pagar, XMLs vinculados
    const [accountsCount, documents, openAmount] = await Promise.all([
      prisma.accountPayable.count({ where: { supplierId: supplier.id } }),
      prisma.xmlFiscalDocument.count({ where: { supplierId: supplier.id } }),
      prisma.accountPayable.aggregate({
        where: { supplierId: supplier.id, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);
    res.json({
      supplier,
      stats: {
        accountsCount,
        documentsImported: documents,
        openPayableAmount: openAmount._sum.amount || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar fornecedor' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.companyName) return res.status(400).json({ error: 'companyName é obrigatório' });
    const supplier = await prisma.supplier.create({
      data: {
        companyName: data.companyName,
        cnpj: data.cnpj || null,
        representativeName: data.representativeName || null,
        phone: data.phone || null,
        email: data.email || null,
        suppliedBrands: data.suppliedBrands || null,
        commercialTerms: data.commercialTerms || null,
        averageMarkup: data.averageMarkup != null ? parseFloat(data.averageMarkup) : null,
        paymentDeadline: data.paymentDeadline != null ? parseInt(data.paymentDeadline, 10) : null,
        notes: data.notes || null,
        profitabilityRating: data.profitabilityRating != null ? parseInt(data.profitabilityRating, 10) : null,
        active: data.active !== false,
      },
    });
    res.json({ supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar fornecedor', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.averageMarkup != null) data.averageMarkup = parseFloat(data.averageMarkup);
    if (data.paymentDeadline != null) data.paymentDeadline = parseInt(data.paymentDeadline, 10);
    if (data.profitabilityRating != null) data.profitabilityRating = parseInt(data.profitabilityRating, 10);
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data });
    res.json({ supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar fornecedor', detail: err.message });
  }
});

// Lista PRODUTOS do fornecedor (com unidades reais compradas via NFe entrada)
router.get('/:id/products', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    // Match por supplierCnpj OU supplierId em aiContext
    // LEFT JOIN com XmlFiscalItem pra somar unidades reais (docType=entrada)
    const products = await prisma.$queryRaw`
      SELECT p.id, p.sku, p.name, p.brand, p.active, p.price, p."costPrice", p."markupPercent",
             p."aiContext"->>'supplierRef' AS "supplierRef",
             p."updatedAt",
             COALESCE(SUM(CASE WHEN d."docType"='entrada' THEN i.quantity ELSE 0 END), 0)::float AS "unitsBought",
             COALESCE(SUM(CASE WHEN d."docType"='entrada' THEN i."totalValue" ELSE 0 END), 0)::float AS "purchaseValue",
             COUNT(CASE WHEN d."docType"='entrada' THEN 1 END)::int AS "nfeLines",
             MAX(d."issueDate") FILTER (WHERE d."docType"='entrada') AS "lastPurchaseDate"
      FROM "Product" p
      LEFT JOIN "XmlFiscalItem" i ON i."productId" = p.id
      LEFT JOIN "XmlFiscalDocument" d ON d.id = i."fiscalDocumentId"
      WHERE (
        p."aiContext"->>'supplierCnpj' = ${supplier.cnpj || ''}
        OR p."aiContext"->>'supplierId' = ${supplier.id}
      )
      GROUP BY p.id, p.sku, p.name, p.brand, p.active, p.price, p."costPrice", p."markupPercent", p."aiContext", p."updatedAt"
      ORDER BY p.brand NULLS LAST, p.name ASC
      LIMIT 2000`;
    res.json({ products, supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar produtos', detail: err.message });
  }
});

// Atribui marca em lote a vários produtos do fornecedor
router.post('/:id/products/bulk-brand', async (req, res) => {
  try {
    const { productIds, brand } = req.body || {};
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds obrigatório' });
    const brandClean = (brand || '').trim();
    if (!brandClean) return res.status(400).json({ error: 'brand obrigatório (não vazio)' });
    // Garante que os produtos pertencem ao fornecedor (por segurança)
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const r = await prisma.$queryRaw`
      UPDATE "Product"
      SET brand = ${brandClean}, "updatedAt" = NOW()
      WHERE id = ANY(${productIds}::text[])
        AND (
          "aiContext"->>'supplierCnpj' = ${supplier.cnpj || ''}
          OR "aiContext"->>'supplierId' = ${supplier.id}
        )
      RETURNING id`;
    res.json({ ok: true, updated: r.length, brand: brandClean });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir marca', detail: err.message });
  }
});

// Sugere agrupamentos de unificação baseado em productIds selecionados.
// Agrupa por (nome_limpo + supplierRef + brand) — nome_limpo = nome sem
// sufixos comuns de tamanho/cor.
router.post('/:id/products/suggest-unify', async (req, res) => {
  try {
    const { productIds } = req.body || {};
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds obrigatório' });
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, active: true },
      select: { id: true, sku: true, name: true, brand: true, imageUrl: true, imageUrls: true, aiContext: true, price: true,
        sizes: { include: { storeStocks: { include: { store: { select: { code: true, name: true } } } } } } },
    });
    function cleanName(name) {
      if (!name) return '';
      return name
        .replace(/-+\s*Tam[:.]?\s*[A-Z0-9./-]+/gi, '')   // -Tam:38 / -Tam: M / -Tam:38-43
        .replace(/\s+\d{2}([,.]\d)?\s*$/i, '')           // "MODELO 38" no fim
        .replace(/\s+-\s*$/, '')                          // hífen sobrando
        .trim();
    }
    function getRef(p) {
      try { return ((typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext)?.supplierRef || '').trim(); }
      catch { return ''; }
    }
    const groups = {};
    products.forEach(p => {
      const cn = cleanName(p.name);
      const ref = getRef(p);
      const key = `${cn}||${ref}||${p.brand || ''}`;
      if (!groups[key]) groups[key] = { masterName: cn, supplierRef: ref, brand: p.brand, products: [], imagesPool: [] };
      groups[key].products.push({
        id: p.id, sku: p.sku, name: p.name, price: p.price,
        imageUrl: p.imageUrl, imageUrls: p.imageUrls,
        sizes: (p.sizes || []).map(s => ({ size: s.size, stock: s.stock, storeStocks: s.storeStocks })),
      });
      if (p.imageUrl) groups[key].imagesPool.push(p.imageUrl);
      try { (typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || [])).forEach(u => { if (u && !groups[key].imagesPool.includes(u)) groups[key].imagesPool.push(u); }); } catch {}
    });
    res.json({ groups: Object.values(groups) });
  } catch (err) {
    console.error('[unify suggest]', err);
    res.status(500).json({ error: 'Erro ao sugerir', detail: err.message });
  }
});

// Executa unificação. Por grupo: cria Product mestre, cria ProductSize
// pra cada size dos originais (move StoreStock), marca originais como
// inactive + grava unifiedIntoId em aiContext.
router.post('/:id/products/unify', async (req, res) => {
  try {
    const { groups } = req.body || {};
    if (!Array.isArray(groups) || !groups.length) return res.status(400).json({ error: 'groups obrigatório' });
    const results = [];
    for (const g of groups) {
      const { masterName, brand, supplierRef, imageUrl, imageUrls, productIds } = g;
      if (!masterName || !Array.isArray(productIds) || productIds.length < 2) {
        results.push({ ok: false, error: 'grupo inválido (precisa nome + 2+ produtos)' });
        continue;
      }
      const originals = await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { sizes: { include: { storeStocks: true } } },
      });
      if (originals.length < 2) { results.push({ ok: false, error: 'menos de 2 originais encontrados' }); continue; }
      const first = originals[0];
      // Constrói aiContext mesclado (preserva supplierCnpj/supplierId)
      const firstCtx = (() => { try { return typeof first.aiContext === 'string' ? JSON.parse(first.aiContext) : (first.aiContext || {}); } catch { return {}; } })();
      const masterCtx = {
        ...firstCtx,
        supplierRef: supplierRef || firstCtx.supplierRef,
        unifiedFromSkus: originals.map(o => o.sku),
        unifiedFromIds: originals.map(o => o.id),
        unifiedAt: new Date().toISOString(),
      };
      // Cria mestre
      const newSku = `UNI-${first.sku || first.id}-${Date.now().toString(36).slice(-4)}`;
      const master = await prisma.product.create({
        data: {
          sku: newSku,
          name: masterName,
          brand: brand || first.brand,
          category: first.category,
          subcategory: first.subcategory,
          shortDescription: first.shortDescription,
          longDescription: first.longDescription,
          price: first.price,
          promoPrice: first.promoPrice,
          imageUrl: imageUrl || first.imageUrl,
          imageUrls: Array.isArray(imageUrls) ? imageUrls : (first.imageUrls || []),
          aiContext: masterCtx,
          ncm: first.ncm,
          cfop: first.cfop,
          unidade: first.unidade,
          active: true,
        },
      });
      // Copia sizes dos originais
      let movedSizes = 0;
      for (const o of originals) {
        for (const s of (o.sizes || [])) {
          const ps = await prisma.productSize.create({
            data: { productId: master.id, size: String(s.size), stock: 0 }, // espelho; recalc abaixo
          });
          if (s.storeStocks && s.storeStocks.length) {
            await prisma.storeStock.updateMany({
              where: { productSizeId: s.id },
              data: { productSizeId: ps.id },
            });
            // espelho ProductSize.stock = soma do StoreStock movido
            await recalcSizeStock(prisma, ps.id);
          }
          movedSizes++;
        }
      }
      // Marca originais inactive + unifiedIntoId
      for (const o of originals) {
        const ctx = (() => { try { return typeof o.aiContext === 'string' ? JSON.parse(o.aiContext) : (o.aiContext || {}); } catch { return {}; } })();
        ctx.unifiedIntoId = master.id;
        ctx.unifiedAt = new Date().toISOString();
        await prisma.product.update({ where: { id: o.id }, data: { active: false, aiContext: ctx } });
      }
      results.push({ ok: true, masterId: master.id, masterSku: master.sku, sourceCount: originals.length, movedSizes });
    }
    res.json({ ok: true, results });
  } catch (err) {
    console.error('[unify]', err);
    res.status(500).json({ error: 'Erro ao unificar', detail: err.message });
  }
});

// Lista NFes do fornecedor com a marca atribuída
router.get('/:id/nfes', async (req, res) => {
  try {
    const docs = await prisma.xmlFiscalDocument.findMany({
      where: { supplierId: req.params.id },
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: 500,
      select: {
        id: true, number: true, series: true, accessKey: true, issueDate: true,
        totalValue: true, brand: true, brandSetAt: true, status: true,
        _count: { select: { items: true } },
      },
    });
    res.json({ nfes: docs.map(d => ({
      id: d.id, number: d.number, series: d.series, accessKey: d.accessKey,
      issueDate: d.issueDate, totalValue: d.totalValue,
      brand: d.brand, brandSetAt: d.brandSetAt, status: d.status,
      itemsCount: d._count.items,
    })) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar NFes', detail: err.message });
  }
});

// Atribui marca em lote a várias NFes do fornecedor
router.post('/:id/nfes/bulk-brand', async (req, res) => {
  try {
    const { nfeIds, brand } = req.body || {};
    if (!Array.isArray(nfeIds) || !nfeIds.length) return res.status(400).json({ error: 'nfeIds obrigatório' });
    const brandClean = (brand || '').trim() || null;
    const r = await prisma.xmlFiscalDocument.updateMany({
      where: { id: { in: nfeIds }, supplierId: req.params.id },
      data: { brand: brandClean, brandSetAt: new Date(), brandSetById: req.userId || null },
    });
    res.json({ ok: true, updated: r.count, brand: brandClean });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir marca', detail: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // Soft delete (desativa)
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    res.json({ supplier, soft: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover fornecedor' });
  }
});

module.exports = router;
