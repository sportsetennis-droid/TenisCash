// =====================================================================
// Routes: /api/admin/product-images — busca e seleção de imagem do produto
// =====================================================================

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

// Upload memory storage — limita 15MB por arquivo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não suportado. Use JPG/PNG/WebP.'));
  },
});
const googleGis = require('../services/googleImageSearch');
const braveGis = require('../services/braveImageSearch');
const serperGis = require('../services/serperImageSearch');
const serperWeb = require('../services/serperWebSearch');
const { scrapeProductPage } = require('../services/productPageScraper');
const nsHandlers = require('../services/nuvemshopHandlers');
const imageStd = require('../services/imageStandardizer');
const { getSupplierMeta, siteForSupplier, brandForSupplier } = require('../services/supplierOfficialSites');

// Helper: re-empurra produto pra Nuvemshop se já tem mapping
async function syncToNuvemshopIfMapped(productId) {
  try {
    const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: productId } });
    if (!mapping) return { synced: false, reason: 'sem mapping' };
    const connection = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!connection) return { synced: false, reason: 'sem conexão' };
    const result = await nsHandlers.pushProductToNuvemshop(productId, connection);
    return { synced: true, action: result.action };
  } catch (err) {
    return { synced: false, error: err.message };
  }
}

// Prioridade: Serper (Google real) > Brave > Google Custom Search
// Serper devolve os mesmos resultados que o Google.com, que indexa
// converse.com.br profundo. Brave indexa pouco esse tipo de site.
let gis, providerName;
if (serperGis.isConfigured()) {
  gis = serperGis; providerName = 'serper';
} else if (braveGis.isConfigured()) {
  gis = braveGis; providerName = 'brave';
} else {
  gis = googleGis; providerName = 'google';
}

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Status da configuração (Google ou Brave conforme env)
router.get('/status', (_req, res) => {
  res.json({ configured: gis.isConfigured(), provider: providerName });
});

// Metadados de um fornecedor (site oficial, marca, etc.)
router.get('/supplier-meta/:cnpj', (req, res) => {
  const meta = getSupplierMeta(req.params.cnpj);
  res.json({ cnpj: req.params.cnpj, meta: meta || null });
});

// Teste de chave/CSE arbitrário — recebe via query string. Útil pra debug.
router.get('/test-key', async (req, res) => {
  try {
    const apiKey = req.query.key;
    const cseId = req.query.cx;
    if (!apiKey || !cseId) {
      return res.json({ error: 'Passe ?key=AIza...&cx=... na URL' });
    }
    const url = `https://customsearch.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=converse&searchType=image`;
    const r = await fetch(url);
    const d = await r.json();
    res.json({
      status: r.status,
      ok: r.ok,
      error: d.error?.message || null,
      errorDetail: d.error?.errors || null,
      hasItems: !!d.items?.length,
      itemCount: d.items?.length || 0,
      firstItem: d.items?.[0] ? { url: d.items[0].link, source: d.items[0].displayLink } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnóstico: testa o provider ativo (Serper, Brave ou Google)
router.get('/diagnose', async (_req, res) => {
  try {
    if (providerName === 'serper') {
      const apiKey = process.env.SERPER_API_KEY;
      if (!apiKey) return res.json({ provider: 'serper', error: 'SERPER_API_KEY não setada' });
      const result = await serperGis.searchImages('Converse "CK13120001"', { count: 5 });
      res.json({
        provider: 'serper',
        keyPreview: apiKey.slice(0, 6) + '...',
        keyLength: apiKey.length,
        testQuery: 'Converse "CK13120001"',
        testImage: {
          ok: result.ok,
          error: result.error || null,
          itemCount: result.items?.length || 0,
          firstItems: (result.items || []).slice(0, 3).map((it) => ({
            source: it.source,
            title: it.title?.slice(0, 80),
            pageUrl: it.pageUrl?.slice(0, 100),
          })),
        },
      });
      return;
    }

    if (providerName === 'brave') {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) return res.json({ provider: 'brave', error: 'BRAVE_API_KEY não setada' });
      const result = await braveGis.searchImages('converse chuck taylor', { count: 3 });
      res.json({
        provider: 'brave',
        keyPreview: apiKey.slice(0, 6) + '...',
        keyLength: apiKey.length,
        testImage: {
          ok: result.ok,
          error: result.error || null,
          itemCount: result.items?.length || 0,
          firstItem: result.items?.[0] ? {
            source: result.items[0].source,
            title: result.items[0].title?.slice(0, 80),
          } : null,
        },
      });
      return;
    }

    // fallback: diagnose Google
    const apiKey = process.env.GOOGLE_API_KEY;
    const cseId = process.env.GOOGLE_CSE_ID;
    if (!apiKey || !cseId) {
      return res.json({ provider: 'google', error: 'env vars não setadas', hasKey: !!apiKey, hasCseId: !!cseId });
    }
    const url1 = `https://customsearch.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=converse`;
    const r1 = await fetch(url1);
    const d1 = await r1.json();
    const url2 = `https://customsearch.googleapis.com/customsearch/v1?key=${apiKey}&cx=${cseId}&q=converse&searchType=image`;
    const r2 = await fetch(url2);
    const d2 = await r2.json();
    res.json({
      provider: 'google',
      cseIdLength: cseId.length,
      cseIdPreview: cseId.slice(0, 4) + '...' + cseId.slice(-4),
      keyPreview: apiKey.slice(0, 6) + '...',
      testWeb: { status: r1.status, error: d1.error?.message || null, hasItems: !!d1.items?.length },
      testImage: { status: r2.status, error: d2.error?.message || null, errorDetail: d2.error?.errors || null, hasItems: !!d2.items?.length },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    // Extrai a referência do fornecedor (cProd da NF-e). Prioridade:
    //   1. ctx.supplierRef (futuras importações salvam explícito)
    //   2. ctx.baseProductKey (importações antigas — extrai por regex)
    //   3. product.sku após o "-" do CNPJ (ex: "0750-CT00010001" → "CT00010001")
    let supplierRef = ctx.supplierRef || null;
    if (!supplierRef && ctx.baseProductKey) {
      const m = String(ctx.baseProductKey).match(/([a-z]{2,4}\d{6,12})/i);
      if (m) supplierRef = m[1].toUpperCase();
    }
    if (!supplierRef && product.sku) {
      const m = String(product.sku).match(/-([A-Za-z]{2,4}\d{6,12})/);
      if (m) supplierRef = m[1].toUpperCase();
    }

    const queryOverride = req.query.q;
    const siteFilter = (req.query.site || '').trim().toLowerCase();

    // Estratégia de busca:
    //  - Se filtrando pelo site oficial Converse, NÃO usa a referência (a Converse
    //    não indexa o cProd em página pública). Usa o nome descritivo do produto
    //    que aparece literal nas páginas (ex: "Chuck Taylor All Star Branco Lilás").
    //  - Caso contrário (busca ampla ou outro site), usa marca + "ref" entre aspas.
    const isOfficialConverse = siteFilter && /(^|\.)converse\.com(\.br)?$/.test(siteFilter);

    let query;
    if (queryOverride) {
      query = queryOverride;
    } else if (isOfficialConverse) {
      // Query descritiva — usa nome completo do produto + cor pra match no site oficial
      const parts = [];
      // Remove prefixo "Tênis " redundante (a Converse só vende tênis no site)
      const cleanName = (product.name || '').replace(/^t[eê]nis\s+/i, '').trim();
      if (product.brand && !/converse/i.test(cleanName)) parts.push(product.brand);
      if (cleanName) parts.push(cleanName);
      if (ctx.color && !cleanName.toLowerCase().includes(String(ctx.color).toLowerCase())) {
        parts.push(ctx.color);
      }
      query = parts.join(' ').trim();
    } else {
      query = gis.buildProductQuery({
        brand: product.brand,
        supplierRef,
        model: product.name,
        color: ctx.color,
        category: product.category,
      });
    }

    // Anexa o filtro de site (sem substituir a query)
    if (siteFilter && /^[a-z0-9.\-]+\.[a-z]{2,}$/.test(siteFilter)) {
      query = `${query} site:${siteFilter}`.trim();
    }

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

// Status geral do pipeline (Catálogo → Estoque → Imagem → Nuvemshop)
// Aceita ?supplierCnpj=XXX pra filtrar por fornecedor.
router.get('/pipeline-status', async (req, res) => {
  try {
    const { supplierCnpj } = req.query;
    const baseWhere = { active: true };
    if (supplierCnpj) {
      baseWhere.aiContext = { path: ['supplierCnpj'], equals: String(supplierCnpj) };
    }

    const [
      totalCatalog,
      withStock,
      withImage,
      withDescription,
      withMapping,
      stockSum,
    ] = await Promise.all([
      prisma.product.count({ where: baseWhere }),
      prisma.product.count({
        where: { ...baseWhere, sizes: { some: { stock: { gt: 0 } } } },
      }),
      prisma.product.count({ where: { ...baseWhere, imageUrl: { not: null } } }),
      prisma.product.count({ where: { ...baseWhere, longDescription: { not: null } } }),
      prisma.product.count({
        where: {
          ...baseWhere,
          // Produtos com mapping Nuvemshop ativo. JoinRaw porque mapping é em outra tabela.
          id: {
            in: (
              await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } })
            ).map((m) => m.localProductId),
          },
        },
      }),
      prisma.productSize.aggregate({
        _sum: { stock: true },
        where: supplierCnpj
          ? {
              product: {
                active: true,
                aiContext: { path: ['supplierCnpj'], equals: String(supplierCnpj) },
              },
            }
          : { product: { active: true } },
      }),
    ]);

    res.json({
      supplierCnpj: supplierCnpj || null,
      catalog: totalCatalog,
      withStock,
      stockTotal: stockSum._sum.stock || 0,
      withImage,
      withDescription,
      pushedToNuvemshop: withMapping,
      readyToPush: Math.max(0, withImage - withMapping),
      pendingImage: Math.max(0, totalCatalog - withImage),
      pendingDescription: Math.max(0, totalCatalog - withDescription),
    });
  } catch (err) {
    console.error('[pipeline-status] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Importa a descrição oficial da página do produto no converse.com.br
// Fluxo: monta query descritiva → web search → acha URL converse.com.br →
//        fetch da página → extrai descrição/título/imagens → salva no produto
router.post('/import-description/:productId', async (req, res) => {
  try {
    if (!serperWeb.isConfigured()) {
      return res.status(400).json({ error: 'SERPER_API_KEY não configurada — necessária pra busca web' });
    }
    const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const ctx = (() => {
      try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
      catch (_) { return {}; }
    })();

    // Permite override de URL via body (se o usuário já souber qual página)
    const { url: urlOverride, site: siteOverride, replaceImages } = req.body || {};
    const site = (siteOverride || 'converse.com.br').toLowerCase();

    let productUrl = urlOverride || null;
    let searchQuery = null;

    if (!productUrl) {
      // Constrói query descritiva: marca + nome (sem prefixo "Tênis") + cor
      const cleanName = (product.name || '').replace(/^t[eê]nis\s+/i, '').trim();
      const parts = [];
      if (product.brand && !new RegExp(product.brand, 'i').test(cleanName)) parts.push(product.brand);
      if (cleanName) parts.push(cleanName);
      if (ctx.color && !cleanName.toLowerCase().includes(String(ctx.color).toLowerCase())) {
        parts.push(ctx.color);
      }
      searchQuery = parts.join(' ') + ' site:' + site;

      const search = await serperWeb.searchWeb(searchQuery, { count: 10 });
      if (!search.ok) return res.json({ ok: false, error: search.error, query: searchQuery });

      // Pega a primeira URL desse domínio
      const siteRe = new RegExp(site.replace(/\./g, '\\.') + '(/|$)', 'i');
      productUrl = (search.results || []).find((r) => siteRe.test(r.url || ''))?.url || null;
      if (!productUrl) {
        return res.json({
          ok: false,
          error: `Nenhuma página de ${site} encontrada`,
          query: searchQuery,
          attemptedResults: (search.results || []).slice(0, 5).map((r) => r.url),
        });
      }
    }

    const scraped = await scrapeProductPage(productUrl);
    if (!scraped.ok) return res.json({ ok: false, error: scraped.error, productUrl, query: searchQuery });
    if (!scraped.description) {
      return res.json({ ok: false, error: 'Página encontrada mas sem descrição extraível', productUrl, query: searchQuery });
    }

    // Salva no banco — usa o HTML formatado se disponível (renderiza bonito na Nuvemshop),
    // senão usa o texto plano. Overview (curto) vira shortDescription se existir.
    const longDesc = scraped.descriptionHtml || scraped.description;
    const shortBase = scraped.overview || scraped.description;
    const data = {
      longDescription: longDesc,
      shortDescription: shortBase
        ? (shortBase.length > 200 ? shortBase.slice(0, 200) + '…' : shortBase)
        : null,
    };
    // Se o produto não tem imagem ainda, ou replaceImages=true, traz as imagens também
    if (replaceImages || !product.imageUrl) {
      if (scraped.mainImage) data.imageUrl = scraped.mainImage;
      if (scraped.images && scraped.images.length) data.imageUrls = scraped.images.slice(0, 8);
    }

    const updated = await prisma.product.update({ where: { id: product.id }, data });
    // Auto-sync pra Nuvemshop se já tem espelho
    const nsSync = await syncToNuvemshopIfMapped(updated.id);
    res.json({
      ok: true,
      productUrl,
      query: searchQuery,
      title: scraped.title,
      description: scraped.description,
      images: scraped.images,
      product: { id: updated.id, sku: updated.sku, longDescription: updated.longDescription, imageUrl: updated.imageUrl },
      nuvemshop: nsSync,
    });
  } catch (err) {
    console.error('[import-description] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk: AUTO-importa a 1ª imagem da busca em massa pra produtos sem imageUrl
// Pega o 1º resultado do Serper e salva direto. Risco: imagem pode estar errada.
// Usuário pode revisar depois clicando no produto na aba Imagens.
router.post('/auto-image-bulk', async (req, res) => {
  try {
    if (!gis.isConfigured()) {
      return res.status(400).json({ error: 'Provider de busca não configurado' });
    }
    const { supplierCnpj, limit = 200, picks = 5, site: siteOverride } = req.body || {};
    if (!supplierCnpj) return res.status(400).json({ error: 'supplierCnpj obrigatório' });

    // Site oficial do fornecedor (mapa centralizado), com override possível via body
    const supplierMeta = getSupplierMeta(supplierCnpj);
    const officialSite = (siteOverride || (supplierMeta && supplierMeta.site) || '').trim().toLowerCase();

    const products = await prisma.product.findMany({
      where: {
        active: true,
        imageUrl: null,
        aiContext: { path: ['supplierCnpj'], equals: String(supplierCnpj) },
      },
      take: parseInt(limit, 10) || 200,
    });

    let ok = 0, failed = 0, syncedToNs = 0;
    const errors = [];

    for (const product of products) {
      try {
        const ctx = (() => {
          try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
          catch (_) { return {}; }
        })();
        const supplierRef = ctx.supplierRef || null;
        // Constrói query — limpa o nome dos slashs da NF-e e usa a marca do fornecedor se a do produto for genérica
        const cleanName = (product.name || '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim();
        const brandToUse = (supplierMeta && supplierMeta.brand)
          || (/A\s*DEFINIR|^$/i.test(product.brand || '') ? null : product.brand)
          || product.brand;
        let query = gis.buildProductQuery({
          brand: brandToUse,
          supplierRef,
          model: cleanName || product.name,
          color: ctx.color,
          category: product.category,
        });
        if (officialSite && /^[a-z0-9.\-]+\.[a-z]{2,}$/.test(officialSite)) {
          query = `${query} site:${officialSite}`.trim();
        }
        const result = await gis.searchImages(query, { count: parseInt(picks, 10) || 5 });
        if (!result.ok || !result.items?.length) {
          failed++;
          errors.push({ sku: product.sku, reason: 'sem resultados', query });
          continue;
        }
        const first = result.items[0];
        const extras = result.items.slice(1, parseInt(picks, 10) || 5).map((i) => i.url).filter(Boolean);

        await prisma.product.update({
          where: { id: product.id },
          data: {
            imageUrl: first.url,
            imageUrls: extras.length ? extras : undefined,
          },
        });
        ok++;
        const sync = await syncToNuvemshopIfMapped(product.id);
        if (sync.synced) syncedToNs++;
        await new Promise((r) => setTimeout(r, 250));
      } catch (err) {
        failed++;
        errors.push({ sku: product.sku, reason: err.message });
      }
    }

    res.json({
      ok: true,
      total: products.length,
      succeeded: ok,
      failed,
      syncedToNuvemshop: syncedToNs,
      errors: errors.slice(0, 20),
    });
  } catch (err) {
    console.error('[auto-image-bulk] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Bulk: importa descrição/imagens pra TODOS os produtos de um fornecedor
router.post('/import-description-bulk', async (req, res) => {
  try {
    if (!serperWeb.isConfigured()) {
      return res.status(400).json({ error: 'SERPER_API_KEY não configurada' });
    }
    const { supplierCnpj, site = 'converse.com.br', replaceImages = false, onlyMissing = true, limit = 200 } = req.body || {};
    if (!supplierCnpj) return res.status(400).json({ error: 'supplierCnpj obrigatório' });

    const where = {
      active: true,
      aiContext: { path: ['supplierCnpj'], equals: String(supplierCnpj) },
      ...(onlyMissing ? { longDescription: null } : {}),
    };
    const products = await prisma.product.findMany({ where, take: parseInt(limit, 10) || 200 });

    let ok = 0, failed = 0;
    let syncedToNs = 0;
    const errors = [];

    for (const product of products) {
      try {
        // Reusa a mesma lógica via fetch interno? Não — inline pra não fazer round-trip.
        const ctx = (() => {
          try { return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : (product.aiContext || {}); }
          catch (_) { return {}; }
        })();
        const cleanName = (product.name || '').replace(/^t[eê]nis\s+/i, '').trim();
        const parts = [];
        if (product.brand && !new RegExp(product.brand, 'i').test(cleanName)) parts.push(product.brand);
        if (cleanName) parts.push(cleanName);
        if (ctx.color && !cleanName.toLowerCase().includes(String(ctx.color).toLowerCase())) parts.push(ctx.color);
        const q = parts.join(' ') + ' site:' + site;

        const search = await serperWeb.searchWeb(q, { count: 5 });
        const siteRe = new RegExp(site.replace(/\./g, '\\.') + '(/|$)', 'i');
        const productUrl = (search.results || []).find((r) => siteRe.test(r.url || ''))?.url;
        if (!productUrl) { failed++; errors.push({ sku: product.sku, reason: 'sem URL', query: q }); continue; }

        const scraped = await scrapeProductPage(productUrl);
        if (!scraped.ok || !scraped.description) { failed++; errors.push({ sku: product.sku, reason: 'sem descrição', productUrl }); continue; }

        const longDesc = scraped.descriptionHtml || scraped.description;
        const shortBase = scraped.overview || scraped.description;
        const data = {
          longDescription: longDesc,
          shortDescription: shortBase
            ? (shortBase.length > 200 ? shortBase.slice(0, 200) + '…' : shortBase)
            : null,
        };
        if (replaceImages || !product.imageUrl) {
          if (scraped.mainImage) data.imageUrl = scraped.mainImage;
          if (scraped.images && scraped.images.length) data.imageUrls = scraped.images.slice(0, 8);
        }
        await prisma.product.update({ where: { id: product.id }, data });
        ok++;
        // Auto-sync pra Nuvemshop se já tem espelho lá
        const sync = await syncToNuvemshopIfMapped(product.id);
        if (sync.synced) syncedToNs++;
        // pequeno delay pra não martelar Serper/Converse/Nuvemshop
        await new Promise((r) => setTimeout(r, 300));
      } catch (err) {
        failed++;
        errors.push({ sku: product.sku, reason: err.message });
      }
    }

    res.json({ ok: true, total: products.length, succeeded: ok, failed, syncedToNuvemshop: syncedToNs, errors: errors.slice(0, 20) });
  } catch (err) {
    console.error('[import-description-bulk] erro:', err);
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
    const take = Math.min(parseInt(limit || '50', 10), 500);

    const where = {
      active: true,
      imageUrl: null,
      ...(brand ? { brand: { contains: String(brand), mode: 'insensitive' } } : {}),
      // Filtro por supplierCnpj usando JSON path do Prisma/Postgres
      ...(supplierCnpj
        ? { aiContext: { path: ['supplierCnpj'], equals: String(supplierCnpj) } }
        : {}),
    };

    let products = await prisma.product.findMany({
      where,
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, sku: true, name: true, brand: true, category: true,
        price: true, aiContext: true, createdAt: true,
        longDescription: true, shortDescription: true,
        sizes: { select: { size: true, stock: true } },
      },
    });

    const totalPending = await prisma.product.count({ where: { active: true, imageUrl: null } });
    const filteredCount = await prisma.product.count({ where });
    res.json({ products, totalPending, filteredCount });
  } catch (err) {
    console.error('[product-images/pending] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Enriquece com IA produtos de um fornecedor (preenche brand/model/color/cleanName)
router.post('/enrich-supplier/:cnpj', async (req, res) => {
  try {
    const { extractFromName } = require('../services/productEnrichmentAI');
    const supplier = await prisma.supplier.findUnique({ where: { cnpj: req.params.cnpj } });
    const supplierName = supplier?.companyName || '';

    const matching = await prisma.product.findMany({
      where: {
        active: true,
        aiContext: { path: ['supplierCnpj'], equals: req.params.cnpj },
      },
      take: 5000,
    });

    let enriched = 0;
    let failed = 0;
    let totalCost = 0;
    for (const p of matching) {
      try {
        const result = await extractFromName(p.name, supplierName);
        if (!result.ok) { failed++; continue; }
        const d = result.data;
        totalCost += result.cost || 0;
        const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {});
        ctx.color = d.color || ctx.color;
        ctx.gender = d.gender || ctx.gender;
        ctx.sport = d.sport || ctx.sport;
        await prisma.product.update({
          where: { id: p.id },
          data: {
            name: d.cleanName || p.name,
            brand: d.brand || p.brand,
            category: d.category || p.category,
            subcategory: d.subcategory || p.subcategory,
            aiContext: ctx,
          },
        });
        enriched++;
        await new Promise((r) => setTimeout(r, 200));
      } catch (err) {
        failed++;
      }
    }

    res.json({ total: matching.length, enriched, failed, totalCostBRL: totalCost });
  } catch (err) {
    console.error('[enrich-supplier] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// UPLOAD de imagens do computador — processa pra 4:5 com sharp
// =====================================================================
// POST /admin/product-images/upload/:productId
// FormData field: "files" (array, até 10 imagens jpg/png/webp/heic)
//   - mode=preview (default): NÃO salva, só retorna processados pro preview
//   - mode=save: salva imediatamente
// Pipeline: original → rotate(EXIF) → resize cover 800x1000 (4:5) → webp q82
// 1ª foto vira Product.imageUrl, demais vão pra Product.imageUrls[].
// =====================================================================
async function processOne(buf) {
  const out = await sharp(buf, { failOn: 'none' })
    .rotate()
    .resize(800, 1000, { fit: 'cover', position: 'attention' })
    .webp({ quality: 82 })
    .toBuffer();
  return { dataUrl: `data:image/webp;base64,${out.toString('base64')}`, kb: Math.round(out.length / 1024) };
}

router.post('/upload/:productId',
  (req, res, next) => upload.array('files', 10)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo > 15MB' });
      return res.status(400).json({ error: err.message });
    }
    next();
  }),
  async (req, res) => {
    try {
      if (!req.files || !req.files.length) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado (campo "files")' });
      }
      const product = await prisma.product.findUnique({ where: { id: req.params.productId } });
      if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

      const mode = String(req.body.mode || 'save').toLowerCase();
      const processed = [];
      for (const f of req.files) {
        try { processed.push(await processOne(f.buffer)); }
        catch (e) { processed.push({ error: e.message }); }
      }
      const success = processed.filter(p => !p.error);

      if (mode !== 'preview' && success.length) {
        const main = success[0].dataUrl;
        const extras = success.slice(1).map(p => p.dataUrl);
        await prisma.product.update({
          where: { id: product.id },
          data: { imageUrl: main, imageUrls: extras.length ? extras : (product.imageUrls || []) },
        });
      }

      res.json({
        ok: true,
        productId: product.id,
        sku: product.sku,
        mode,
        count: success.length,
        images: processed.map((p, i) => p.error
          ? { idx: i, error: p.error }
          : { idx: i, dataUrl: p.dataUrl, kb: p.kb, dimensions: '800x1000', format: 'webp' }),
      });
    } catch (err) {
      console.error('[product-images/upload] erro:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// =====================================================================
// POST /standardize/:productId — uniformiza TODAS as imagens do produto
// pro padrão da loja (1:1 ~1200px webp) e re-empurra pra Nuvemshop.
// Resolve "diferença de tamanho" (fontes 2048/1200/1000 misturadas) e
// encolhe PNGs gigantes. Body opcional: { size, ratio:'1:1'|'4:5', fit, sync }
// =====================================================================
router.post('/standardize/:productId', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.productId },
      select: { id: true, sku: true, name: true, imageUrl: true, imageUrls: true },
    });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const srcs = nsHandlers.collectLocalImages(product);
    if (!srcs.length) return res.status(400).json({ error: 'produto sem imagens' });

    const { size, ratio = '1:1', fit = 'cover', sync = true } = req.body || {};
    const results = await imageStd.standardizeList(srcs, { size, ratio, fit });

    const urls = results.map((r) => r.url).filter(Boolean);
    if (!urls.length) return res.status(500).json({ error: 'nenhuma imagem padronizada', results });

    await prisma.product.update({
      where: { id: product.id },
      data: { imageUrl: urls[0], imageUrls: urls.slice(1) },
    });

    let nuvemshop = { synced: false, reason: 'sync=false' };
    if (sync) nuvemshop = await syncToNuvemshopIfMapped(product.id);

    res.json({
      ok: true,
      product: { id: product.id, sku: product.sku, name: product.name },
      count: urls.length,
      ratio, size: size || imageStd.DEFAULT_SIZE,
      results: results.map((r) => ({ ok: r.ok, before: r.before, beforeKb: r.beforeKb, afterKb: r.afterKb, error: r.error })),
      nuvemshop,
    });
  } catch (err) {
    console.error('[product-images/standardize] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
