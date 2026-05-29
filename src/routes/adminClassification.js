// =====================================================================
// Routes: /api/admin/classification — Editor de classificação IA
// =====================================================================
// Permite revisar e corrigir a classificação Tênis/Chuteira/Outro +
// gênero + modalidade + tier feita pelo classificador automático.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

// Árvore oficial (espelho do frontend) — usada pra validar
const VALID = {
  types: ['Tênis', 'Chuteira', 'Outro'],
  genders: ['Feminino', 'Masculino', 'Inf. M', 'Inf. F'],
  modalities: {
    'Tênis': ['Corrida', 'Caminhada / Treino leve', 'LifeStyle', 'Recuperação', 'Musculação / CrossFit / Hyrox', 'Streetwear', 'Sapatilha'],
    'Chuteira': ['Futsal', 'Society', 'Campo'],
  },
  tiers: {
    'Corrida': ['máximo conforto', 'confortável', 'velocidade', 'custo benefício', 'super treino', 'pau pra toda obra', 'maratona'],
    'LifeStyle': ['premium', 'clássico', 'casual'],
    'Musculação / CrossFit / Hyrox': ['pro', 'intermediário', 'custo benefício'],
    'Futsal': ['entrada', 'custo benefício', 'treino', 'pro'],
    'Society': ['entrada', 'custo benefício', 'treino', 'pro'],
    'Campo': ['entrada', 'custo benefício', 'treino', 'pro'],
  },
};

// GET /api/admin/classification/tree → devolve a árvore pro front montar dropdowns
router.get('/tree', (_req, res) => res.json(VALID));

// GET /api/admin/classification/products?type=&gender=&modality=&tier=&especialidade=&brand=&q=&unclassified=&limit=
router.get('/products', async (req, res) => {
  try {
    const { type, gender, modality, brand, q } = req.query;
    // Aceita 'tier' OU 'especialidade' (alias)
    const tier = req.query.tier || req.query.especialidade;
    const unclassified = req.query.unclassified === '1' || req.query.unclassified === 'true';
    const lowConfidence = req.query.lowConfidence === '1' || req.query.lowConfidence === 'true';
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const cursor = req.query.cursor;

    const filters = [];
    // Casa com a 1ª OU a 2ª classificação (classification2)
    if (type) filters.push({ OR: [
      { aiContext: { path: ['classification', 'type'], equals: type } },
      { aiContext: { path: ['classification2', 'type'], equals: type } },
    ] });
    if (gender) filters.push({ OR: [
      { aiContext: { path: ['classification', 'gender'], equals: gender } },
      { aiContext: { path: ['classification2', 'gender'], equals: gender } },
    ] });
    if (modality) filters.push({ OR: [
      { aiContext: { path: ['classification', 'modality'], equals: modality } },
      { aiContext: { path: ['classification2', 'modality'], equals: modality } },
    ] });
    if (tier) filters.push({ OR: [
      { aiContext: { path: ['classification', 'tier'], equals: tier } },
      { aiContext: { path: ['classification2', 'tier'], equals: tier } },
    ] });
    if (unclassified) filters.push({ OR: [
      { aiContext: { equals: null } },
      { aiContext: { path: ['classification'], equals: null } },
    ] });

    const where = {
      active: true,
      ...(filters.length ? { AND: filters } : {}),
      ...(brand ? { brand: { contains: brand, mode: 'insensitive' } } : {}),
      ...(q ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { sku: { contains: q, mode: 'insensitive' } },
          { brand: { contains: q, mode: 'insensitive' } },
        ],
      } : {}),
    };

    const products = await prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, sku: true, name: true, brand: true, category: true, subcategory: true,
        shortDescription: true, imageUrl: true, price: true, promoPrice: true, aiContext: true,
        sizes: { select: { size: true, stock: true }, orderBy: { size: 'asc' } },
      },
    });

    const hasMore = products.length > limit;
    const list = (hasMore ? products.slice(0, limit) : products).map(p => {
      let cls = null;
      try {
        const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext;
        cls = ctx?.classification || null;
      } catch {}
      return {
        id: p.id, sku: p.sku, name: p.name, brand: p.brand, category: p.category,
        imageUrl: p.imageUrl, price: p.price, promoPrice: p.promoPrice,
        sizes: p.sizes || [],
        classification: cls,
        supplierRef: ctx?.supplierRef || null,
        shortDescription: p.shortDescription || null,
      };
    });

    // Filtro lowConfidence em memória (pq é numérico)
    const final = lowConfidence ? list.filter(p => (p.classification?.confidence || 0) < 0.7) : list;

    res.json({
      products: final,
      nextCursor: hasMore ? list[list.length - 1].id : null,
    });
  } catch (err) {
    console.error('classification/products', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/classification/:productId
// Body: { type, gender, modality, tier|especialidade, brand }
router.patch('/:productId', async (req, res) => {
  try {
    const { type, gender, modality, brand } = req.body || {};
    const tier = req.body?.tier ?? req.body?.especialidade ?? null;

    if (type !== null && type !== undefined && type !== '' && !VALID.types.includes(type)) {
      return res.status(400).json({ error: 'type inválido' });
    }
    if (gender && !VALID.genders.includes(gender)) {
      return res.status(400).json({ error: 'gender inválido' });
    }
    if (modality && type && VALID.modalities[type] && !VALID.modalities[type].includes(modality)) {
      return res.status(400).json({ error: `modality inválida pra ${type}` });
    }
    if (tier && modality && VALID.tiers[modality] && !VALID.tiers[modality].includes(tier)) {
      return res.status(400).json({ error: `especialidade inválida pra modalidade ${modality}` });
    }

    const p = await prisma.product.findUnique({
      where: { id: req.params.productId },
      select: { id: true, aiContext: true, brand: true },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });

    const existingCtx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch { return {}; }
    })();

    const newClassification = {
      type: type || null,
      gender: gender || null,
      modality: modality || null,
      tier: tier || null,
      confidence: 1,
      classifiedAt: new Date().toISOString(),
      manualEdit: true,
      editedBy: req.userId,
    };

    const updateData = { aiContext: { ...existingCtx, classification: newClassification } };
    // Marca editável (vai no campo brand do Product, não no aiContext)
    if (brand !== undefined && brand !== null) {
      updateData.brand = String(brand).trim() || 'A DEFINIR';
    }

    await prisma.product.update({ where: { id: p.id }, data: updateData });

    res.json({ ok: true, classification: newClassification, brand: updateData.brand || p.brand });
  } catch (err) {
    console.error('classification PATCH', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /brands — lista de marcas distintas pra autocomplete
router.get('/brands', async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT brand FROM "Product"
      WHERE active = true AND brand IS NOT NULL AND brand != 'A DEFINIR'
      ORDER BY brand ASC
    `;
    res.json({ brands: rows.map(r => r.brand) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/classification/:productId/reclassify
// Roda o classificador IA de novo neste produto (caso queira sobrescrever manual)
router.post('/:productId/reclassify', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY não configurada' });

    const p = await prisma.product.findUnique({
      where: { id: req.params.productId },
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, shortDescription: true, longDescription: true, aiContext: true },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const SYSTEM = `Você é classificador de produtos da rede Sports & Tennis.
Tipos: ${VALID.types.join(' | ')}
Gêneros: ${VALID.genders.join(' | ')}
Modalidades Tênis: ${VALID.modalities['Tênis'].join(' | ')}
Modalidades Chuteira: ${VALID.modalities['Chuteira'].join(' | ')}
Tiers: variam por modalidade.

Retorne SOMENTE JSON: {"type":"...","gender":"...","modality":"...","tier":"...","confidence":0-1}`;

    const userMsg = `Produto: ${p.name} (${p.brand}). Categoria: ${p.category || '?'}. ${p.shortDescription || p.longDescription || ''}`.slice(0, 500);

    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'IA não retornou JSON válido' });
    const obj = JSON.parse(m[0]);

    const existingCtx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch { return {}; }
    })();
    const newClassification = {
      type: obj.type || null,
      gender: obj.gender || null,
      modality: obj.modality || null,
      tier: obj.tier || null,
      confidence: obj.confidence || 0.5,
      classifiedAt: new Date().toISOString(),
      manualEdit: false,
    };
    await prisma.product.update({
      where: { id: p.id },
      data: { aiContext: { ...existingCtx, classification: newClassification } },
    });

    res.json({ ok: true, classification: newClassification });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/classification/stats — visão geral pro dashboard
router.get('/stats', async (_req, res) => {
  try {
    const total = await prisma.product.count({ where: { active: true } });
    const classified = await prisma.product.count({
      where: { active: true, aiContext: { path: ['classification', 'classifiedAt'], not: null } },
    });

    // Distribuição por tipo
    const byType = {};
    for (const t of VALID.types) {
      byType[t] = await prisma.product.count({
        where: { active: true, aiContext: { path: ['classification', 'type'], equals: t } },
      });
    }

    // Baixa confiança (< 0.7)
    const lowConfSample = await prisma.product.findMany({
      where: { active: true, aiContext: { path: ['classification', 'classifiedAt'], not: null } },
      select: { aiContext: true },
      take: 10000,
    });
    let lowConfCount = 0;
    lowConfSample.forEach(s => {
      try {
        const ctx = typeof s.aiContext === 'string' ? JSON.parse(s.aiContext) : s.aiContext;
        if ((ctx?.classification?.confidence || 0) < 0.7) lowConfCount++;
      } catch {}
    });

    res.json({
      total,
      classified,
      pending: total - classified,
      progressPct: total ? Math.round((classified / total) * 100) : 0,
      byType,
      lowConfidenceCount: lowConfCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
