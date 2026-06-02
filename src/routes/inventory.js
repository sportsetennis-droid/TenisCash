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
    const { lifecycleStatus, brand, category, subcategory, lowStock, search, gender, modality, tier, supplier, storeId } = req.query;
    const jsonFilters = [];
    // Gender mantido pra retrocompat — novos clientes devem usar subcategory
    if (gender) jsonFilters.push({ aiContext: { path: ['classification', 'gender'], equals: String(gender) } });
    if (modality) jsonFilters.push({ aiContext: { path: ['classification', 'modality'], equals: String(modality) } });
    if (tier) jsonFilters.push({ aiContext: { path: ['classification', 'tier'], equals: String(tier) } });
    if (supplier) {
      jsonFilters.push({
        OR: [
          { aiContext: { path: ['supplierCnpj'], equals: String(supplier) } },
          { aiContext: { path: ['supplierId'], equals: String(supplier) } },
        ],
      });
    }
    const where = {
      active: true,
      ...(brand ? { brand: { equals: String(brand), mode: 'insensitive' } } : {}),
      ...(category ? { category: { equals: String(category), mode: 'insensitive' } } : {}),
      ...(subcategory ? { subcategory: { equals: String(subcategory), mode: 'insensitive' } } : {}),
      // Busca livre: nome, SKU, marca, categoria, subcategoria + modalidade/especialidade (JSON)
      ...(search ? {
        OR: [
          { name: { contains: String(search), mode: 'insensitive' } },
          { sku: { contains: String(search), mode: 'insensitive' } },
          { brand: { contains: String(search), mode: 'insensitive' } },
          { category: { contains: String(search), mode: 'insensitive' } },
          { subcategory: { contains: String(search), mode: 'insensitive' } },
          { aiContext: { path: ['classification', 'modality'], string_contains: String(search) } },
          { aiContext: { path: ['classification', 'tier'], string_contains: String(search) } },
          { aiContext: { path: ['supplierRef'], string_contains: String(search) } },
        ],
      } : {}),
      ...(jsonFilters.length ? { AND: jsonFilters } : {}),
    };
    const products = await prisma.product.findMany({
      where,
      include: {
        sizes: {
          orderBy: { size: 'asc' },
          include: { storeStocks: { include: { store: { select: { id: true, code: true, name: true } } } } },
        },
      },
      // Limite alto suficiente pra cobrir todos ativos (~7.6k hoje). Sem cap "silencioso".
      take: 20000,
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
          subcategory: p.subcategory || null,
          supplierRef: ctx.supplierRef || null,
          gender: ctx.gender || null,
          ageGroup: ctx.ageGroup || null,
          sport: ctx.sport || null,
          color: ctx.color || null,
          location: ctx.location || null,
          longDescription: p.longDescription || null,
          shortDescription: p.shortDescription || null,
          price: p.price,
          promoPrice: p.promoPrice,
          // Campos visuais usados pelo PCard.render
          imageUrl: p.imageUrl || null,
          imageUrls: p.imageUrls || [],
          aiContext: p.aiContext || null,
          active: p.active,
          featured: p.featured || false,
          totalStock,
          sizes: p.sizes,
          lifecycle,
        };
      })
      .filter((it) => {
        if (lifecycleStatus && it.lifecycle?.lifecycleStatus !== lifecycleStatus) return false;
        if (lowStock === 'true' && it.totalStock > 5) return false;
        // Filtro POR LOJA: só mostra produtos com pelo menos 1 ProductSize com stock > 0 nessa storeId
        if (storeId) {
          const hasStockInStore = (it.sizes || []).some(sz =>
            (sz.storeStocks || []).some(ss => ss.storeId === storeId && (ss.stock || 0) > 0)
          );
          if (!hasStockInStore) return false;
        }
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

// Ajuste manual de estoque (contagem física POR LOJA).
// MODELO (dono 2026-06-02): ProductSize.stock = COMPRADO (total fixo, vem da NFe de entrada).
//   StoreStock = LOCALIZAÇÃO (quanto daquele item está em cada loja, via bipe/contagem).
//   O ajuste atualiza SÓ o StoreStock da loja. NUNCA recalcula/sobrescreve ProductSize.stock,
//   senão o total comprado seria corrompido (vira soma dos bipes). Por isso NÃO há recalc aqui.
router.post('/adjust', async (req, res) => {
  try {
    const { productSizeId, delta, reason, storeId, newStock, productId, size } = req.body || {};

    // Modo Contagem Física (com storeId) — mexe SÓ na localização (StoreStock)
    if (storeId != null) {
      if (newStock == null) return res.status(400).json({ error: 'newStock é obrigatório no modo contagem' });
      let psId = productSizeId;
      // Se não veio productSizeId mas veio size + productId, acha
      if (!psId && productId && size) {
        const found = await prisma.productSize.findFirst({ where: { productId, size: String(size) } });
        if (!found) return res.status(404).json({ error: 'ProductSize não encontrado pra esse productId+size' });
        psId = found.id;
      }
      if (!psId) return res.status(400).json({ error: 'productSizeId ou productId+size é obrigatório' });

      const newQty = Math.max(0, parseInt(newStock, 10) || 0);
      // Atualiza SÓ o StoreStock desta loja (localização). NÃO toca no total comprado.
      const existing = await prisma.storeStock.findFirst({ where: { productSizeId: psId, storeId } });
      if (existing) {
        await prisma.storeStock.update({ where: { id: existing.id }, data: { stock: newQty } });
      } else {
        await prisma.storeStock.create({ data: { productSizeId: psId, storeId, stock: newQty } });
      }
      // ProductSize.stock (= COMPRADO) permanece intocado. Só devolvemos info de localização.
      const allStocks = await prisma.storeStock.findMany({ where: { productSizeId: psId } });
      const totalLocalizado = allStocks.reduce((s, x) => s + (x.stock || 0), 0);
      const comprado = (await prisma.productSize.findUnique({ where: { id: psId }, select: { stock: true } }))?.stock ?? null;

      return res.json({
        ok: true,
        productSizeId: psId,
        storeId,
        newStockInStore: newQty,
        totalLocalizado,        // soma das lojas (quanto já foi localizado/contado)
        estoqueComprado: comprado, // total FIXO — não muda com ajuste/bipe
        reason: reason || null,
      });
    }

    // Modo sem loja: bloqueado. Ajuste é SEMPRE por loja (localização).
    // Escrever direto no ProductSize.stock corromperia o total comprado.
    return res.status(400).json({
      error: 'Estoque é por loja. Envie storeId + newStock (contagem física).',
      hint: 'POST /adjust { storeId, newStock, productSizeId (ou productId+size) }',
    });
  } catch (err) {
    console.error('[inventory/adjust]', err);
    res.status(500).json({ error: 'Erro ao ajustar estoque', detail: err.message });
  }
});

module.exports = router;
