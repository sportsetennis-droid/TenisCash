const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const Anthropic = require('@anthropic-ai/sdk');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

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

function groupCsvRows(rows) {
  const bySku = new Map();
  for (const row of rows) {
    const sku = String(row.sku || row.SKU || '').trim();
    if (!sku) continue;
    const name = String(row.name || row.nome || '').trim();
    const brand = String(row.brand || row.marca || '').trim();
    const category = String(row.category || row.categoria || 'tenis').trim();
    const subcategory = row.subcategory ? String(row.subcategory).trim() : null;
    const price = parseFloat(row.price || row.preco || '0');
    const size = String(row.size || row.tamanho || '').trim();
    const stock = parseInt(row.stock || row.estoque || '0', 10) || 0;
    const imageUrl = row.imageUrl || row.image || row.foto ? String(row.imageUrl || row.image || row.foto).trim() : null;

    if (!bySku.has(sku)) {
      bySku.set(sku, {
        sku,
        name: name || sku,
        brand: brand || '—',
        category: category || 'tenis',
        subcategory,
        price: Number.isNaN(price) ? 0 : price,
        imageUrl,
        sizes: [],
      });
    }
    const g = bySku.get(sku);
    if (size) g.sizes.push({ size, stock });
    if (name) g.name = name;
    if (brand) g.brand = brand;
    if (!Number.isNaN(price) && price > 0) g.price = price;
    if (imageUrl) g.imageUrl = imageUrl;
  }
  return Array.from(bySku.values());
}

router.post('/import-csv', adminOnly, upload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Envie o arquivo CSV no campo file' });
    }
    const text = req.file.buffer.toString('utf8');
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    if (parsed.errors && parsed.errors.length) {
      return res.status(400).json({ error: 'CSV inválido', details: parsed.errors.slice(0, 5) });
    }
    const items = groupCsvRows(parsed.data || []);
    const preview = items.slice(0, 10);
    res.json({
      preview,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error('import-csv', err);
    res.status(500).json({ error: 'Erro ao processar CSV' });
  }
});

router.post('/import-csv/apply', adminOnly, async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'items (array) é obrigatório' });
    }
    let created = 0;
    let updated = 0;
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      if (!sku) continue;
      const name = String(it.name || '').trim() || sku;
      const brand = String(it.brand || '').trim() || '—';
      const category = String(it.category || '').trim() || 'tenis';
      const price = parseFloat(it.price);
      if (Number.isNaN(price)) continue;

      const sizes = Array.isArray(it.sizes) ? it.sizes : [];

      const existing = await prisma.product.findUnique({ where: { sku } });
      if (existing) {
        await prisma.productSize.deleteMany({ where: { productId: existing.id } });
        await prisma.product.update({
          where: { id: existing.id },
          data: {
            name,
            brand,
            category,
            subcategory: it.subcategory || null,
            price,
            imageUrl: it.imageUrl || null,
            source: 'csv',
            sizes: {
              create: sizes
                .filter((s) => s && s.size)
                .map((s) => ({
                  size: String(s.size),
                  stock: Math.max(0, parseInt(s.stock, 10) || 0),
                })),
            },
          },
        });
        updated += 1;
      } else {
        await prisma.product.create({
          data: {
            sku,
            name,
            brand,
            category,
            subcategory: it.subcategory || null,
            price,
            imageUrl: it.imageUrl || null,
            source: 'csv',
            createdById: req.userId,
            sizes: {
              create: sizes
                .filter((s) => s && s.size)
                .map((s) => ({
                  size: String(s.size),
                  stock: Math.max(0, parseInt(s.stock, 10) || 0),
                })),
            },
          },
        });
        created += 1;
      }
    }
    res.json({ success: true, created, updated });
  } catch (err) {
    console.error('import-csv apply', err);
    res.status(500).json({ error: 'Erro ao importar produtos' });
  }
});

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
