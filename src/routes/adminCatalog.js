const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const Anthropic = require('@anthropic-ai/sdk');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function multerErrorHandler(err, _req, res, _next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo muito grande. Limite: 50MB.' });
  }
  return res.status(400).json({ error: err && err.message ? err.message : 'Erro no upload' });
}

function adminOnly(req, res, next) {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

function sellerOrAdmin(req, res, next) {
  if (!['seller', 'admin', 'superadmin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

function parseJsonSafe(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

router.get('/products/:id', adminOnly, async (req, res) => {
  try {
    const p = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { sizes: { orderBy: { size: 'asc' } } },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ product: p });
  } catch (err) {
    console.error('admin catalog get', err);
    res.status(500).json({ error: 'Erro ao carregar produto' });
  }
});

router.get('/products', adminOnly, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const brand = String(req.query.brand || '').trim();
    const category = String(req.query.category || '').trim();
    const active = req.query.active;
    const featured = req.query.featured;

    const where = {
      ...(brand ? { brand: { contains: brand, mode: 'insensitive' } } : {}),
      ...(category ? { category: { contains: category, mode: 'insensitive' } } : {}),
      ...(active === 'true' ? { active: true } : active === 'false' ? { active: false } : {}),
      ...(featured === 'true' ? { featured: true } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const products = await prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
      include: {
        sizes: { orderBy: { size: 'asc' } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    res.json({ products });
  } catch (err) {
    console.error('admin catalog products list', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

router.post('/products', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    const name = String(b.name || '').trim();
    const brand = String(b.brand || '').trim();
    const category = String(b.category || '').trim();
    const price = parseFloat(b.price);
    if (!sku || !name || !brand || !category || Number.isNaN(price)) {
      return res.status(400).json({ error: 'sku, name, brand, category e price são obrigatórios' });
    }

    const sizes = Array.isArray(b.sizes) ? b.sizes : [];

    const product = await prisma.product.create({
      data: {
        sku,
        name,
        brand,
        category,
        subcategory: b.subcategory ? String(b.subcategory) : null,
        shortDescription: b.shortDescription ? String(b.shortDescription).slice(0, 2000) : null,
        longDescription: b.longDescription ? String(b.longDescription).slice(0, 8000) : null,
        features: parseJsonSafe(b.features),
        aiContext: parseJsonSafe(b.aiContext),
        recommendedFor: parseJsonSafe(b.recommendedFor),
        notRecommendedFor: parseJsonSafe(b.notRecommendedFor),
        imageUrl: b.imageUrl ? String(b.imageUrl) : null,
        imageUrls: parseJsonSafe(b.imageUrls),
        price,
        promoPrice: b.promoPrice != null && b.promoPrice !== '' ? parseFloat(b.promoPrice) : null,
        active: b.active !== false,
        featured: !!b.featured,
        source: b.source ? String(b.source).slice(0, 32) : 'manual',
        createdById: req.userId,
        sizes: {
          create: sizes
            .filter((s) => s && s.size)
            .map((s) => ({
              size: String(s.size),
              stock: Math.max(0, parseInt(s.stock, 10) || 0),
              barcode: s.barcode ? String(s.barcode) : null,
            })),
        },
      },
      include: { sizes: true },
    });
    res.json({ product });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU já cadastrado' });
    console.error('admin catalog create', err);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

router.put('/products/:id', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

    const data = {
      ...(b.sku != null ? { sku: String(b.sku).trim() } : {}),
      ...(b.name != null ? { name: String(b.name).trim() } : {}),
      ...(b.brand != null ? { brand: String(b.brand).trim() } : {}),
      ...(b.category != null ? { category: String(b.category).trim() } : {}),
      ...(b.subcategory !== undefined ? { subcategory: b.subcategory ? String(b.subcategory) : null } : {}),
      ...(b.shortDescription !== undefined
        ? { shortDescription: b.shortDescription ? String(b.shortDescription).slice(0, 2000) : null }
        : {}),
      ...(b.longDescription !== undefined
        ? { longDescription: b.longDescription ? String(b.longDescription).slice(0, 8000) : null }
        : {}),
      ...(b.features !== undefined ? { features: parseJsonSafe(b.features) } : {}),
      ...(b.aiContext !== undefined ? { aiContext: parseJsonSafe(b.aiContext) } : {}),
      ...(b.recommendedFor !== undefined ? { recommendedFor: parseJsonSafe(b.recommendedFor) } : {}),
      ...(b.notRecommendedFor !== undefined ? { notRecommendedFor: parseJsonSafe(b.notRecommendedFor) } : {}),
      ...(b.imageUrl !== undefined ? { imageUrl: b.imageUrl ? String(b.imageUrl) : null } : {}),
      ...(b.imageUrls !== undefined ? { imageUrls: parseJsonSafe(b.imageUrls) } : {}),
      ...(b.price != null ? { price: parseFloat(b.price) } : {}),
      ...(b.promoPrice !== undefined
        ? { promoPrice: b.promoPrice != null && b.promoPrice !== '' ? parseFloat(b.promoPrice) : null }
        : {}),
      ...(b.active !== undefined ? { active: !!b.active } : {}),
      ...(b.featured !== undefined ? { featured: !!b.featured } : {}),
      ...(b.source != null ? { source: String(b.source).slice(0, 32) } : {}),
    };

    if (Array.isArray(b.sizes)) {
      await prisma.productSize.deleteMany({ where: { productId: id } });
      data.sizes = {
        create: b.sizes
          .filter((s) => s && s.size)
          .map((s) => ({
            size: String(s.size),
            stock: Math.max(0, parseInt(s.stock, 10) || 0),
            barcode: s.barcode ? String(s.barcode) : null,
          })),
      };
    }

    const product = await prisma.product.update({
      where: { id },
      data,
      include: { sizes: true },
    });
    res.json({ product });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU já cadastrado' });
    console.error('admin catalog update', err);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

router.delete('/products/:id', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.productSize.deleteMany({ where: { productId: id } });
    await prisma.product.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2003') {
      return res.status(400).json({ error: 'Produto vinculado a outras tabelas — não é possível excluir' });
    }
    console.error('admin catalog delete', err);
    res.status(500).json({ error: 'Erro ao remover produto' });
  }
});

/* ====================== IMPORTAÇÃO CSV ====================== */

const REQUIRED_HEADERS = ['sku', 'nome', 'marca', 'categoria', 'subcategoria', 'preco_custo', 'preco_venda'];

function normalizeBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parsePtNumber(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  s = s.replace(/\s+/g, '').replace(/[Rr]\$/g, '');
  // 1.234,56 -> 1234.56
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.indexOf(',') >= 0) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseCatalogCsv(text) {
  const cleaned = normalizeBom(text);
  const parsed = Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => String(h || '').trim().toLowerCase(),
  });
  return parsed;
}

function summarizeBrands(grouped) {
  const counts = new Map();
  for (const it of grouped) {
    counts.set(it.brand, (counts.get(it.brand) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([brand, count]) => ({ brand, count }))
    .sort((a, b) => b.count - a.count);
}

function groupCatalogRows(rows) {
  const bySku = new Map();
  const errors = [];
  let totalRows = 0;
  let totalVariants = 0;

  rows.forEach((row, idx) => {
    const lineNumber = idx + 2; // +2 = cabeçalho + 1 (linhas humanas)
    if (!row || typeof row !== 'object') return;

    const sku = String(row.sku || '').trim();
    const nome = String(row.nome || '').trim();
    const marca = String(row.marca || '').trim();
    const categoria = String(row.categoria || '').trim();
    const subcategoria = String(row.subcategoria || '').trim();
    const tamanho = String(row.tamanho || '').trim();
    const codigoBarras = String(row.codigo_barras || '').trim();
    const fornecedor = String(row.fornecedor || '').trim();

    if (!sku && !nome && !marca && !tamanho) return;
    totalRows += 1;

    if (!sku) {
      errors.push({ line: lineNumber, error: 'SKU vazio' });
      return;
    }
    if (!nome) {
      errors.push({ line: lineNumber, sku, error: 'Nome vazio' });
      return;
    }
    if (!marca) {
      errors.push({ line: lineNumber, sku, error: 'Marca vazia' });
      return;
    }
    if (!categoria) {
      errors.push({ line: lineNumber, sku, error: 'Categoria vazia' });
      return;
    }

    const precoCusto = parsePtNumber(row.preco_custo);
    const precoVenda = parsePtNumber(row.preco_venda);
    if (Number.isNaN(precoVenda) || precoVenda <= 0) {
      errors.push({ line: lineNumber, sku, error: 'preco_venda inválido' });
      return;
    }
    if (Number.isNaN(precoCusto) || precoCusto < 0) {
      errors.push({ line: lineNumber, sku, error: 'preco_custo inválido' });
      return;
    }

    if (!bySku.has(sku)) {
      bySku.set(sku, {
        sku,
        name: nome,
        brand: marca,
        category: categoria.toLowerCase(),
        subcategory: subcategoria || null,
        price: precoVenda,
        costPrice: precoCusto,
        supplier: fornecedor || null,
        sizes: [],
      });
    }
    const g = bySku.get(sku);
    if (precoVenda && (!g.price || g.price < precoVenda)) {
      // mantém o maior preço de venda visto entre as linhas (caso variem)
      // mas idealmente deve ser o mesmo em todas as linhas
    }
    if (tamanho) {
      const seen = g.sizes.find((s) => s.size === tamanho);
      if (!seen) {
        g.sizes.push({
          size: tamanho,
          stock: 0,
          barcode: codigoBarras || null,
        });
        totalVariants += 1;
      } else if (codigoBarras && !seen.barcode) {
        seen.barcode = codigoBarras;
      }
    }
  });

  return {
    items: Array.from(bySku.values()),
    totalRows,
    totalVariants,
    errors,
  };
}

function validateHeaders(parsed) {
  const headers = (parsed.meta && parsed.meta.fields) || [];
  const set = new Set(headers.map((h) => String(h || '').trim().toLowerCase()));
  const missing = REQUIRED_HEADERS.filter((h) => !set.has(h));
  return missing;
}

router.post(
  '/import-preview',
  adminOnly,
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? multerErrorHandler(err, req, res, next) : next())),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Envie o arquivo CSV no campo file' });
      }
      const text = req.file.buffer.toString('utf8');
      const parsed = parseCatalogCsv(text);

      const missing = validateHeaders(parsed);
      if (missing.length) {
        return res.status(400).json({
          error: 'Cabeçalhos obrigatórios faltando: ' + missing.join(', '),
          required: REQUIRED_HEADERS,
        });
      }

      const parseErrs = (parsed.errors || []).slice(0, 20).map((e) => ({
        line: (e.row != null ? e.row + 2 : null),
        error: e.message || 'Erro de parse CSV',
      }));

      const grouped = groupCatalogRows(parsed.data || []);
      const errors = parseErrs.concat(grouped.errors).slice(0, 200);

      const items = grouped.items;
      const brands = summarizeBrands(items);

      res.json({
        ok: true,
        totalRows: grouped.totalRows,
        uniqueProducts: items.length,
        totalVariants: grouped.totalVariants,
        brandsCount: brands.length,
        brands,
        preview: items.slice(0, 10).map((it) => ({
          sku: it.sku,
          name: it.name,
          brand: it.brand,
          category: it.category,
          subcategory: it.subcategory,
          costPrice: it.costPrice,
          price: it.price,
          sizes: it.sizes,
        })),
        errors,
      });
    } catch (err) {
      console.error('import-preview', err);
      res.status(500).json({ error: 'Erro ao processar CSV' });
    }
  },
);

router.post(
  '/import-csv',
  adminOnly,
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? multerErrorHandler(err, req, res, next) : next())),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Envie o arquivo CSV no campo file' });
      }
      const text = req.file.buffer.toString('utf8');
      const parsed = parseCatalogCsv(text);

      const missing = validateHeaders(parsed);
      if (missing.length) {
        return res.status(400).json({
          error: 'Cabeçalhos obrigatórios faltando: ' + missing.join(', '),
          required: REQUIRED_HEADERS,
        });
      }

      const grouped = groupCatalogRows(parsed.data || []);
      const errors = grouped.errors.slice();
      const items = grouped.items;

      let productsCreated = 0;
      let productsUpdated = 0;
      let sizesCreated = 0;

      for (const it of items) {
        try {
          const aiContext = {
            costPrice: it.costPrice,
            supplier: it.supplier || null,
          };

          const sizesData = it.sizes
            .filter((s) => s && s.size)
            .map((s) => ({
              size: String(s.size).slice(0, 20),
              stock: 0,
              barcode: s.barcode ? String(s.barcode).slice(0, 64) : null,
            }));

          const existing = await prisma.product.findUnique({
            where: { sku: it.sku },
            select: { id: true, sizes: { select: { size: true } } },
          });

          if (existing) {
            await prisma.product.update({
              where: { id: existing.id },
              data: {
                name: it.name,
                brand: it.brand,
                category: it.category,
                subcategory: it.subcategory || null,
                price: it.price,
                source: 'csv',
                aiContext,
              },
            });
            const existingSizes = new Set(existing.sizes.map((s) => s.size));
            const toCreate = sizesData.filter((s) => !existingSizes.has(s.size));
            if (toCreate.length) {
              for (const s of toCreate) {
                try {
                  await prisma.productSize.create({
                    data: { ...s, productId: existing.id },
                  });
                  sizesCreated += 1;
                } catch (e2) {
                  errors.push({ sku: it.sku, error: 'Falha ao criar tamanho ' + s.size + ': ' + (e2.code || e2.message || 'erro') });
                }
              }
            }
            productsUpdated += 1;
          } else {
            const created = await prisma.product.create({
              data: {
                sku: it.sku,
                name: it.name,
                brand: it.brand,
                category: it.category,
                subcategory: it.subcategory || null,
                price: it.price,
                source: 'csv',
                createdById: req.userId,
                aiContext,
                sizes: sizesData.length ? { create: sizesData } : undefined,
              },
              select: { id: true, sizes: { select: { id: true } } },
            });
            productsCreated += 1;
            sizesCreated += created.sizes.length;
          }
        } catch (eRow) {
          errors.push({ sku: it.sku, error: eRow.code || eRow.message || 'erro' });
        }
      }

      res.json({
        ok: true,
        totalRows: grouped.totalRows,
        productsCreated,
        productsUpdated,
        sizesCreated,
        errors: errors.slice(0, 200),
      });
    } catch (err) {
      console.error('import-csv', err);
      res.status(500).json({ error: 'Erro ao importar CSV' });
    }
  },
);

router.post('/products/auto-fill', sellerOrAdmin, async (req, res) => {
  try {
    const sku = String(req.body?.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku é obrigatório' });
    const brandHint = String(req.body?.brand || '').trim();

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(503).json({ error: 'IA indisponível' });

    const client = new Anthropic({ apiKey: key });
    const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

    const userMsg = `Pesquise informações sobre o produto com SKU ou código de modelo: "${sku}"${brandHint ? ` da marca ${brandHint}` : ''}.
Retorne APENAS um objeto JSON válido (sem markdown) com as chaves:
name, brand, category, subcategory, shortDescription, longDescription, features (objeto com specs), recommendedFor (array de strings), notRecommendedFor (array de strings), imageUrls (array de URLs se encontrar), suggestedRetailPrice (número), suggestedSizes (array de {size, stock} com estoques plausíveis).`;

    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

    let textOut = '';
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'Você é especialista em calçados e artigos esportivos. Use web_search quando necessário. Responda somente JSON válido.',
        messages: [{ role: 'user', content: userMsg }],
        tools,
      });
      const blocks = resp.content || [];
      textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } catch (e1) {
      console.warn('auto-fill web_search falhou, tentando sem web:', e1.message);
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'Você é especialista em calçados e artigos esportivos. Com base no SKU e marca, sugira dados plausíveis. Responda somente JSON válido.',
        messages: [{ role: 'user', content: userMsg }],
      });
      const blocks = resp.content || [];
      textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }

    let json = null;
    const m = textOut.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        json = JSON.parse(m[0]);
      } catch {
        json = null;
      }
    }
    if (!json) return res.status(422).json({ error: 'Não foi possível interpretar a resposta da IA', raw: textOut.slice(0, 500) });

    res.json({ fill: json, sku });
  } catch (err) {
    console.error('auto-fill', err);
    res.status(500).json({ error: 'Erro no auto-preenchimento' });
  }
});

module.exports = router;
