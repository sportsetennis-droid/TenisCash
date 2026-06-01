// =====================================================================
// Routes: /api/admin/vitrine — Montador da vitrine da home (sportsetennis)
// =====================================================================
// Regras do dono:
//  - 18 imagens (9 por gênero): 5 cards 3:4 + 4 wide 2.08:1.
//  - Cada imagem é única: NENHUM produto repetido entre os 18 slots.
//  - Sem imagem recortada / reaproveitada em 2 locais.
//  - Produto é o protagonista (escolhido aqui pelo SKU real, não por prompt).
//  - Seleção gated por ESTOQUE (só produto com tamanho em estoque).
//  - Cada slot tem ao menos 1 frase (copy).
//  - Divisão por taxonomia: Subcategoria × Modalidade × Especialidade.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

const CONFIG_KEY = 'vitrine_selection_v1';

// Config é key/value JSON. Passamos id=key explícito no create pra não colidir
// com o @default("global") do schema (que limitaria a 1 linha).
async function getConfig(key, def) {
  try {
    const row = await prisma.config.findUnique({ where: { key } });
    return row?.value ? JSON.parse(row.value) : def;
  } catch { return def; }
}
async function setConfig(key, value) {
  await prisma.config.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { id: key, key, value: JSON.stringify(value) },
  });
  return value;
}

// ---------------------------------------------------------------------
// Definição dos 9 slots por gênero (espelha o bloco da home Morelia).
// filter = dica de taxonomia pro candidato; o dono escolhe o produto.
// dims = master a gerar depois (protagonista, sem recorte).
// ---------------------------------------------------------------------
const SLOTS = [
  // 5 cards 3:4 (1080×1440)
  { id: 'corrida',     label: 'Corrida',      shape: 'card', ratio: '3:4',    dims: '1080x1440', filter: { type: 'Tênis', modality: 'Corrida' } },
  { id: 'lifestyle',   label: 'Lifestyle',    shape: 'card', ratio: '3:4',    dims: '1080x1440', filter: { type: 'Tênis', modality: 'LifeStyle' } },
  { id: 'treino',      label: 'Treino',       shape: 'card', ratio: '3:4',    dims: '1080x1440', filter: { type: 'Tênis', modality: 'Caminhada / Treino leve' } },
  { id: 'recuperacao', label: 'Recuperação',  shape: 'card', ratio: '3:4',    dims: '1080x1440', filter: { type: 'Tênis', modality: 'Recuperação' } },
  { id: 'streetwear',  label: 'Streetwear',   shape: 'card', ratio: '3:4',    dims: '1080x1440', filter: { type: 'Tênis', modality: 'Streetwear' } },
  // 4 wide 2.08:1 (1456×700)
  { id: 'tenis',       label: 'Tênis (destaque)', shape: 'wide', ratio: '2.08:1', dims: '1456x700', filter: { type: 'Tênis' } },
  { id: 'roupas',      label: 'Roupas',       shape: 'wide', ratio: '2.08:1', dims: '1456x700', filter: { category: 'roupa' } },
  { id: 'acessorios',  label: 'Acessórios',   shape: 'wide', ratio: '2.08:1', dims: '1456x700', filter: { category: 'acessorio' } },
  { id: 'wellness',    label: 'Wellness',     shape: 'wide', ratio: '2.08:1', dims: '1456x700', filter: { type: 'Tênis', modality: 'Recuperação' } },
];

const GENDERS = ['Feminino', 'Masculino'];

// ---------------------------------------------------------------------
// Estoque por tamanho: soma StoreStock (verdade); fallback ProductSize.stock.
// ---------------------------------------------------------------------
function sizesWithStock(sizes) {
  return (sizes || []).map((s) => {
    const fromStores = (s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0);
    const stock = (s.storeStocks && s.storeStocks.length) ? fromStores : (s.stock || 0);
    return { size: s.size, stock };
  });
}

function parseCls(aiContext) {
  try {
    const ctx = typeof aiContext === 'string' ? JSON.parse(aiContext) : aiContext;
    return ctx?.classification || null;
  } catch { return null; }
}

// GET /api/admin/vitrine/slots → defs + seleção salva
router.get('/slots', async (_req, res) => {
  try {
    const saved = await getConfig(CONFIG_KEY, {});
    res.json({ genders: GENDERS, slots: SLOTS, selection: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vocabulário real do banco é bagunçado: gênero vem como 'Mulher'/'Homem'/'Menina'…
// e só ~163 produtos têm classificação. Por isso o picker é BUSCA-PRIMEIRO:
// retorna todos em estoque; filtros (gênero/tipo/categoria) são OPCIONAIS e tolerantes.
const GENDER_SYNONYMS = {
  Feminino: ['Feminino', 'Mulher', 'Menina', 'Inf. F', 'Infantil Feminino', 'Fem', 'feminino'],
  Masculino: ['Masculino', 'Homem', 'Menino', 'Inf. M', 'Infantil Masculino', 'Masc', 'masculino'],
};

// GET /api/admin/vitrine/candidates?q=&gender=&type=&category=&limit=
router.get('/candidates', async (req, res) => {
  try {
    const { q, gender, type, category } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 400);

    const and = [];
    if (gender && GENDER_SYNONYMS[gender]) {
      const ors = GENDER_SYNONYMS[gender].map((v) => ({ aiContext: { path: ['classification', 'gender'], equals: v } }));
      ors.push({ subcategory: { contains: gender === 'Feminino' ? 'emin' : 'asculin', mode: 'insensitive' } });
      and.push({ OR: ors });
    }
    if (type) and.push({ aiContext: { path: ['classification', 'type'], equals: type } });
    if (category) and.push({ category: { contains: category, mode: 'insensitive' } });

    const where = {
      active: true,
      // só produtos com ALGUM tamanho em estoque (legado OU por loja) — filtra no banco
      sizes: { some: { OR: [
        { stock: { gt: 0 } },
        { storeStocks: { some: { stock: { gt: 0 } } } },
      ] } },
      ...(and.length ? { AND: and } : {}),
      ...(q ? { OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    };

    // take com folga porque o sizesWithStock pode zerar alguns (mismatch legado×loja).
    const products = await prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      take: limit * 2,
      select: {
        id: true, sku: true, name: true, brand: true, category: true, subcategory: true,
        imageUrl: true, price: true, promoPrice: true, aiContext: true,
        sizes: {
          select: { size: true, stock: true, storeStocks: { select: { stock: true } } },
          orderBy: { size: 'asc' },
        },
      },
    });

    const list = products.map((p) => {
      const sizes = sizesWithStock(p.sizes).filter((s) => s.stock > 0);
      const totalStock = sizes.reduce((a, s) => a + s.stock, 0);
      const cls = parseCls(p.aiContext);
      let color = null;
      try { const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext; color = ctx?.color || null; } catch {}
      return {
        id: p.id, sku: p.sku, name: p.name, brand: p.brand,
        category: p.category, subcategory: p.subcategory, color,
        imageUrl: p.imageUrl, price: p.price, promoPrice: p.promoPrice,
        classification: cls,
        sizes, totalStock,
      };
    }).filter((p) => p.totalStock > 0).slice(0, limit);

    res.json({ products: list, count: list.length });
  } catch (e) { console.error('vitrine/candidates', e); res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/vitrine/slots → salva seleção, bloqueando produto repetido
// body: { selection: { Feminino: { slotId: {productId, phrase} }, Masculino: {...} } }
router.put('/slots', async (req, res) => {
  try {
    const selection = req.body?.selection;
    if (!selection || typeof selection !== 'object') {
      return res.status(400).json({ error: 'selection obrigatório' });
    }

    // valida slots/gêneros e detecta produto repetido em qualquer um dos 18
    const seen = new Map(); // productId -> "Gênero/slot"
    const dups = [];
    for (const g of GENDERS) {
      const byGender = selection[g] || {};
      for (const slotId of Object.keys(byGender)) {
        const item = byGender[slotId] || {};
        const pid = item.productId;
        if (!pid) continue;
        if (!SLOTS.find((s) => s.id === slotId)) {
          return res.status(400).json({ error: `slot inválido: ${slotId}` });
        }
        if (seen.has(pid)) dups.push({ productId: pid, a: seen.get(pid), b: `${g}/${slotId}` });
        else seen.set(pid, `${g}/${slotId}`);
      }
    }
    if (dups.length) {
      return res.status(409).json({ error: 'produto repetido (cada imagem é única)', dups });
    }

    const saved = await setConfig(CONFIG_KEY, { selection, updatedAt: new Date().toISOString() });
    res.json({ ok: true, selection: saved.selection });
  } catch (e) { console.error('vitrine/slots PUT', e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
