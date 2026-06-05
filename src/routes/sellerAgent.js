// =====================================================================
// Routes: /api/seller/agent - IA ST Vendedor
// =====================================================================
// V1: cria plano diario, conversa contextual e aplica tarefas sugeridas
// usando a carteira existente do vendedor.
// =====================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware, storeScope, prisma } = require('../middleware');
const { searchProductsForAI, listCatalogSummary } = require('../services/catalogSearch');
const serperWeb = require('../services/serperWebSearch');
const { recordEvent, getBrain } = require('../ai/memory/memory.service');

const router = express.Router();
router.use(authMiddleware, storeScope);

const ACTIVE_TASK_STATUS = ['TODO', 'IN_PROGRESS'];
const ALLOWED_TASK_TYPES = new Set([
  'CALL_CUSTOMER',
  'SEND_WHATSAPP',
  'INVITE_TO_STORE',
  'SEND_PROMOTION',
  'FOLLOW_UP',
  'POST_SALE',
  'REACTIVATE_CUSTOMER',
  'SEND_PRODUCT',
]);

const PRIORITY_WEIGHT = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const SELLER_PRODUCT_SELECT = {
  id: true,
  sku: true,
  name: true,
  brand: true,
  category: true,
  subcategory: true,
  shortDescription: true,
  longDescription: true,
  features: true,
  aiContext: true,
  recommendedFor: true,
  notRecommendedFor: true,
  imageUrl: true,
  imageUrls: true,
  price: true,
  promoPrice: true,
  featured: true,
  active: true,
  updatedAt: true,
  sizes: {
    orderBy: { size: 'asc' },
    select: {
      id: true,
      size: true,
      stock: true,
      barcode: true,
      storeStocks: {
        select: {
          storeId: true,
          stock: true,
          store: { select: { id: true, code: true, name: true, city: true } },
        },
      },
    },
  },
};

const PRODUCT_INTENT_STOPWORDS = new Set([
  'a', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
  'para', 'pra', 'pro', 'por', 'com', 'sem', 'ao', 'aos', 'ate', 'até', 'que', 'qual', 'quais', 'quero', 'quer',
  'queria', 'precisa', 'preciso', 'cliente', 'clientes', 'vender', 'venda', 'produto', 'produtos', 'item', 'itens',
  'indica', 'indique', 'recomenda', 'recomende', 'sugere', 'sugira', 'sugestao', 'sugestão', 'melhor', 'bom',
  'boa', 'algo', 'algum', 'alguma', 'me', 'vc', 'voce', 'você', 'pode', 'poderia', 'ajuda', 'ajudar', 'achar',
  'buscar', 'procura', 'procurar', 'pesquisa', 'pesquisar', 'internet', 'google', 'detalhes', 'detalhe', 'sobre',
  'mais', 'loja', 'lojas', 'estoque', 'tem', 'onde', 'tamanho', 'numero', 'número', 'real', 'reais', 'preco',
  'preço', 'orcamento', 'orçamento',
]);

const RELATIONSHIP_WEIGHT = {
  HIGH_INTENT: 5,
  REBUY_OPPORTUNITY: 4,
  ALMOST_BOUGHT: 4,
  VIP: 4,
  PRICE_SENSITIVE: 3,
  INACTIVE: 3,
  NEW_LEAD: 2,
  ATTENDED: 2,
  RECURRING: 2,
  BUYER: 1,
  LOST: 0,
};

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  skip: () => process.env.NODE_ENV === 'test',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `seller-agent:${req.userId || req.ip}`,
  message: { error: 'Muitas mensagens para a IA ST Vendedor. Aguarde um instante.' },
});

function requireSeller(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a vendedores' });
  }
  next();
}

function resolveSellerId(req) {
  if (req.userRole === 'seller') return req.userId;
  return String(req.query.sellerId || req.body?.sellerId || req.userId || '').trim();
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function safeText(value, max = 600) {
  let s = String(value || '').trim();
  s = s.replace(/ignore (previous|all) instructions/gi, '[redacted]');
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function safeMessageText(value, max = 2000) {
  return safeText(value, max)
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMessages(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(JSON.stringify(json));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseJsonSafe(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed == null ? fallback : parsed;
    } catch {
      return fallback;
    }
  }
  if (typeof value === 'object') return value;
  return fallback;
}

function arrayFromJson(value) {
  const parsed = parseJsonSafe(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .map(([k, v]) => (typeof v === 'boolean' ? (v ? k : '') : `${k}: ${v}`))
      .filter(Boolean);
  }
  return [];
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function moneyBRL(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeProductNeed(text) {
  const raw = normalizeText(text)
    .replace(/r\$\s*\d+(?:[,.]\d{1,2})?/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .filter((t) => !PRODUCT_INTENT_STOPWORDS.has(t))
    .filter((t) => !/^\d+$/.test(t));
}

function cleanProductNeed(text, maxTerms = 8) {
  const seen = new Set();
  const terms = [];
  for (const term of tokenizeProductNeed(text)) {
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= maxTerms) break;
  }
  return terms.join(' ');
}

function extractBudget(text) {
  const raw = normalizeText(text).replace(/\s+/g, ' ');
  const m = raw.match(/(?:ate|menos de|no maximo|maximo|abaixo de|por ate|r\$)\s*r?\$?\s*([0-9]+(?:[,.][0-9]{1,2})?)/i);
  if (!m) return null;
  const value = parseFloat(String(m[1]).replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function sanitizeAiContextForSeller(aiContext) {
  const ctx = parseJsonSafe(aiContext, {}) || {};
  const out = {};
  [
    'classification',
    'classification2',
    'color',
    'modelGroup',
    'supplierRef',
    'nuvemshopMapping',
    'sellerAgentResearch',
  ].forEach((key) => {
    if (ctx[key] != null) out[key] = ctx[key];
  });
  return out;
}

function compactProductText(product) {
  const ctx = sanitizeAiContextForSeller(product.aiContext);
  return [
    product.name,
    product.brand,
    product.category,
    product.subcategory,
    product.shortDescription,
    product.longDescription,
    JSON.stringify(product.features || {}),
    JSON.stringify(product.recommendedFor || []),
    JSON.stringify(ctx.classification || {}),
    JSON.stringify(ctx.classification2 || {}),
    ctx.color,
    ctx.modelGroup,
    ctx.supplierRef,
  ].filter(Boolean).join(' ');
}

function productTypePenalty(product, terms) {
  const title = normalizeText(`${product.brand || ''} ${product.name || ''}`);
  const hay = normalizeText(compactProductText(product));
  const needShoe = terms.some((t) => ['tenis', 'corrida', 'caminhada', 'running', 'walk'].includes(t));
  const needBag = terms.some((t) => ['bolsa', 'mochila', 'mala', 'tote'].includes(t));
  const needSoccerBoot = terms.some((t) => ['chuteira', 'society', 'futsal', 'campo'].includes(t));
  let penalty = 0;
  const notes = [];

  if (needShoe) {
    if (/\b(luva|luvas|bola|bolas|bolinha|bolinhas|tenis de mesa|mesa|bolsa|mochila|mala|camiseta|camisa|short|calca|calça|meia|bone|boné|garrafa|raquete)\b/.test(title)) {
      penalty -= 45;
      notes.push('tipo do produto parece diferente de tenis');
    }
    if (terms.includes('corrida') && /\b(samba|samba adv|superstar|forum|gazelle|campus|stan smith|court|vl court|skate)\b/.test(title)) {
      penalty -= 22;
      notes.push('modelo parece mais casual/skate do que corrida');
    }
    if (terms.includes('corrida') && !/\b(corrida|running|run|runner|clifton|nimbus|adizero|ultraboost|duramo|gel-|gel |wave|pegasus|revolution|corre)\b/.test(hay)) {
      penalty -= 6;
    }
    if (terms.includes('caminhada') && !/\b(caminhada|walking|walk|conforto|casual|leve|dia a dia)\b/.test(hay)) {
      penalty -= 4;
    }
  }

  if (needBag && /\b(tenis|chuteira|luva|bola|camiseta|camisa|short|calca|calça|meia)\b/.test(title)) {
    penalty -= 35;
    notes.push('tipo do produto parece diferente de bolsa/mochila');
  }

  if (needSoccerBoot && /\b(bolsa|mochila|camiseta|camisa|short|calca|calça|meia|luva)\b/.test(title)) {
    penalty -= 35;
    notes.push('tipo do produto parece diferente de chuteira');
  }

  return { penalty, notes };
}

function productModelKey(product) {
  const brand = normalizeText(product.brand || '').replace(/\bsem marca\b/g, '').trim();
  const name = normalizeText(product.name || '')
    .replace(/\bref:?\s*[a-z0-9-]+\b/g, ' ')
    .replace(/\b\d{2}\s*\/\s*\d{2}\b/g, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\btamanho\s*[a-z0-9]+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${brand}|${name || normalizeText(product.sku || '')}`;
}

function scoreProductForNeed(product, terms, opts = {}) {
  const hay = normalizeText(compactProductText(product));
  const name = normalizeText(`${product.brand || ''} ${product.name || ''}`);
  const category = normalizeText(`${product.category || ''} ${product.subcategory || ''}`);
  let score = 0;
  const reasons = [];
  for (const term of terms) {
    if (name.includes(term)) {
      score += 8;
      reasons.push(`bate com "${term}" no nome/modelo`);
    } else if (category.includes(term)) {
      score += 6;
      reasons.push(`bate com "${term}" na categoria`);
    } else if (hay.includes(term)) {
      score += 3;
      reasons.push(`tem sinal de "${term}" nos detalhes`);
    }
  }
  if (product.featured) score += 2;
  const typeCheck = productTypePenalty(product, terms);
  score += typeCheck.penalty;
  reasons.push(...typeCheck.notes);
  const stock = computeProductStock(product, { store: opts.store, size: opts.size });
  if (stock.totalStock > 0) {
    score += 5;
    reasons.push(`tem ${stock.totalStock} un. no estoque real`);
  }
  if (opts.budget) {
    const price = product.promoPrice || product.price || 0;
    if (price && price <= opts.budget) {
      score += 4;
      reasons.push(`fica dentro do orçamento de ${moneyBRL(opts.budget)}`);
    } else if (price && price > opts.budget) {
      score -= 3;
    }
  }
  return { score, reasons: [...new Set(reasons)].slice(0, 4), stock };
}

function computeProductStock(product, filters = {}) {
  const sizeWanted = safeText(filters.size, 20).toLowerCase();
  const storeWanted = safeText(filters.store, 80);
  const byStore = new Map();
  const bySize = new Map();

  for (const size of product.sizes || []) {
    if (sizeWanted && String(size.size || '').toLowerCase() !== sizeWanted) continue;
    for (const ss of size.storeStocks || []) {
      const store = ss.store;
      if (!store || !matchesStore(store, storeWanted)) continue;
      const qty = Math.max(0, ss.stock || 0);
      if (qty <= 0) continue;
      const storeKey = store.id;
      const storeEntry = byStore.get(storeKey) || {
        id: store.id,
        code: store.code,
        name: store.name,
        city: store.city,
        totalStock: 0,
        sizes: [],
      };
      storeEntry.totalStock += qty;
      storeEntry.sizes.push({ size: size.size, stock: qty });
      byStore.set(storeKey, storeEntry);
      bySize.set(size.size, (bySize.get(size.size) || 0) + qty);
    }
  }

  const stores = Array.from(byStore.values())
    .sort((a, b) => b.totalStock - a.totalStock || String(a.code || '').localeCompare(String(b.code || '')));
  const availableSizes = Array.from(bySize.entries())
    .map(([size, stock]) => ({ size, stock }))
    .sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }));
  return {
    totalStock: stores.reduce((sum, s) => sum + s.totalStock, 0),
    availableSizes,
    stores,
  };
}

function formatSellerProduct(product, filters = {}) {
  const aiContext = sanitizeAiContextForSeller(product.aiContext);
  const stock = computeProductStock(product, filters);
  const images = arrayFromJson(product.imageUrls);
  if (product.imageUrl && !images.includes(product.imageUrl)) images.unshift(product.imageUrl);
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    shortDescription: product.shortDescription,
    longDescription: product.longDescription,
    price: product.price,
    promoPrice: product.promoPrice,
    currentPrice: product.promoPrice || product.price || null,
    priceLabel: moneyBRL(product.promoPrice || product.price),
    imageUrl: product.imageUrl,
    imageUrls: images.slice(0, 8),
    features: parseJsonSafe(product.features, null),
    recommendedFor: arrayFromJson(product.recommendedFor).slice(0, 20),
    notRecommendedFor: arrayFromJson(product.notRecommendedFor).slice(0, 20),
    aiContext,
    sellerResearch: aiContext.sellerAgentResearch || null,
    stock,
    updatedAt: formatDateTime(product.updatedAt),
  };
}

function buildProductWhereFromTerms(terms) {
  if (!terms.length) return { active: true };
  return {
    active: true,
    OR: terms.flatMap((term) => [
      { name: { contains: term, mode: 'insensitive' } },
      { sku: { contains: term, mode: 'insensitive' } },
      { brand: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { subcategory: { contains: term, mode: 'insensitive' } },
      { shortDescription: { contains: term, mode: 'insensitive' } },
      { longDescription: { contains: term, mode: 'insensitive' } },
      { sizes: { some: { barcode: { contains: term, mode: 'insensitive' } } } },
    ]),
  };
}

async function findProductsForNeed(text, opts = {}) {
  const terms = tokenizeProductNeed(text).slice(0, 8);
  const limit = Math.min(parseInt(opts.limit, 10) || 8, 12);
  const rows = await prisma.product.findMany({
    where: buildProductWhereFromTerms(terms),
    orderBy: [{ featured: 'desc' }, { updatedAt: 'desc' }],
    take: terms.length ? 80 : 25,
    select: SELLER_PRODUCT_SELECT,
  });

  const ranked = rows
    .map((product) => {
      const scored = scoreProductForNeed(product, terms, opts);
      return {
        product,
        detail: formatSellerProduct(product, opts),
        score: scored.score,
        reasons: scored.reasons,
      };
    })
    .filter((item) => !terms.length || item.score > 0)
    .sort((a, b) => b.score - a.score || (b.detail.stock.totalStock - a.detail.stock.totalStock));

  const seen = new Set();
  const deduped = [];
  for (const item of ranked) {
    const key = productModelKey(item.product);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

async function getProductDetailsForAgent(input, snapshot) {
  const productId = safeText(input?.productId || input?.id, 80);
  const sku = safeText(input?.sku, 80);
  const query = safeText(input?.query || input?.name || input?.need, 220);
  const size = safeText(input?.size, 20);
  const store = safeText(input?.store || snapshot?.seller?.store?.code || '', 80);

  let product = null;
  if (productId) {
    product = await prisma.product.findFirst({
      where: { id: productId, active: true },
      select: SELLER_PRODUCT_SELECT,
    });
  }
  if (!product && sku) {
    product = await prisma.product.findFirst({
      where: { sku: { equals: sku, mode: 'insensitive' }, active: true },
      select: SELLER_PRODUCT_SELECT,
    });
  }
  if (product) {
    return { product: formatSellerProduct(product, { size, store }), rawProductId: product.id, candidates: [] };
  }
  if (!query || cleanProductNeed(query).length < 2) {
    return { product: null, candidates: [], message: 'Informe produto, modelo, SKU ou necessidade do cliente.' };
  }

  const found = await findProductsForNeed(query, { size, store, limit: 6 });
  if (!found.length) {
    return { product: null, candidates: [], message: `Nao encontrei produto ativo para "${query}".` };
  }
  const [best, second] = found;
  const confident = !second || best.score >= second.score + 4 || normalizeText(best.detail.sku) === normalizeText(query);
  if (confident) {
    return {
      product: best.detail,
      rawProductId: best.product.id,
      candidates: found.slice(0, 5).map((x) => ({ product: x.detail, score: x.score, reasons: x.reasons })),
    };
  }
  return {
    product: null,
    candidates: found.slice(0, 5).map((x) => ({ product: x.detail, score: x.score, reasons: x.reasons })),
    message: 'Encontrei mais de um produto possivel. Escolha um SKU/modelo para eu detalhar.',
  };
}

async function recommendProductsForAgent(input, snapshot) {
  const need = safeText(input?.need || input?.query || input?.customerNeed || input?.message, 320);
  const budget = Number(input?.budget) || extractBudget(need) || null;
  const size = safeText(input?.size, 20);
  const store = safeText(input?.store || snapshot?.seller?.store?.code || '', 80);
  const query = cleanProductNeed(need);
  const limit = Math.min(parseInt(input?.limit, 10) || 5, 8);

  if (!query && !need) {
    return {
      need,
      query,
      products: [],
      message: 'Diga o tipo de cliente ou produto: corrida, caminhada, chuteira, mochila, faixa de preco, tamanho etc.',
    };
  }

  let foundRaw = await findProductsForNeed(query || need, { budget, size, store, limit: Math.max(limit * 2, 10) });
  const withStock = foundRaw.filter((item) => (item.detail.stock?.totalStock || 0) > 0);
  if (withStock.length) foundRaw = withStock;
  let found = foundRaw;
  let budgetMatched = true;
  if (budget && foundRaw.length) {
    const withinBudget = foundRaw.filter((item) => {
      const price = item.detail.currentPrice || item.detail.price || null;
      return price != null && price <= budget;
    });
    if (withinBudget.length) {
      found = withinBudget;
    } else {
      budgetMatched = false;
    }
  }
  found = found.slice(0, limit);

  const products = found.map((item) => ({
    ...item.detail,
    matchScore: item.score,
    why: item.reasons.length
      ? item.reasons
      : ['melhor encaixe encontrado no catalogo para a necessidade informada'],
  }));

  await recordEvent({
    category: 'ia-vendedor',
    title: `IA ST Vendedor recomendou ${products.length} produto(s)`,
    detail: `Necessidade: ${need || query}. Produtos: ${products.map((p) => `${p.brand} ${p.name}`).join(', ') || 'nenhum'}.`,
    data: {
      sellerId: snapshot?.seller?.id || null,
      storeId: snapshot?.seller?.storeId || null,
      need,
      query,
      budget,
      productIds: products.map((p) => p.id),
      skus: products.map((p) => p.sku),
    },
    source: 'seller-agent',
    importance: products.length ? 1 : 0,
    createdById: snapshot?.seller?.id || null,
  });

  return {
    need,
    query,
    budget,
    size: size || null,
    store: store || null,
    products,
    count: products.length,
    budgetMatched,
    saved: true,
    message: products.length
      ? budgetMatched
        ? 'Recomendacao baseada no catalogo, detalhes do produto e estoque por loja.'
        : `Nao encontrei opcao dentro de ${moneyBRL(budget)}; trouxe as mais proximas fora do orcamento.`
      : `Nao encontrei produto ativo para "${query || need}".`,
  };
}

function buildResearchPrompt(product, results) {
  return [
    'Responda APENAS com JSON valido, sem markdown.',
    'Voce e especialista em varejo esportivo e precisa transformar dados de produto em inteligencia para vendedores.',
    'Use os resultados web abaixo como apoio, mas nao invente especificacoes que nao estejam claras.',
    'Formato obrigatorio:',
    '{"summary":"2 frases praticas","sellingAngles":["..."],"customerFit":["..."],"objections":[{"objection":"...","answer":"..."}],"comparisonNotes":["..."],"keywords":["..."],"confidence":"low|medium|high"}',
    '',
    'Produto do sistema:',
    JSON.stringify(product, null, 2),
    '',
    'Resultados web:',
    JSON.stringify(results, null, 2),
  ].join('\n');
}

function fallbackResearchFromResults(product, results) {
  const snippets = (results || [])
    .map((r) => r.snippet)
    .filter(Boolean)
    .slice(0, 4);
  const summary = snippets.length
    ? snippets.join(' ').slice(0, 600)
    : `${product.brand || ''} ${product.name || ''}`.trim() + ' precisa de validacao externa; use os dados do sistema e confirme detalhes especificos com o cliente.';
  return {
    summary,
    sellingAngles: [
      product.shortDescription || 'Use categoria, marca, preco e disponibilidade por loja como gancho principal.',
      product.promoPrice ? 'Destaque o preco promocional antes de falar do preco cheio.' : 'Destaque beneficio e encaixe antes de falar preco.',
    ].filter(Boolean).slice(0, 4),
    customerFit: arrayFromJson(product.recommendedFor).slice(0, 4),
    objections: [
      {
        objection: 'Cliente achou caro',
        answer: 'Compare beneficio, durabilidade e disponibilidade imediata; se houver promocao, mostre a economia com clareza.',
      },
    ],
    comparisonNotes: [],
    keywords: tokenizeProductNeed(`${product.brand} ${product.name} ${product.category}`).slice(0, 8),
    confidence: results?.length ? 'medium' : 'low',
  };
}

async function summarizeResearchWithAI(product, results) {
  const client = anthropicClient();
  if (!client) return fallbackResearchFromResults(product, results);
  try {
    const model = process.env.SELLER_AGENT_RESEARCH_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
    const resp = await client.messages.create({
      model,
      max_tokens: 900,
      system: 'Voce resume pesquisa web para vendedores de loja esportiva. Responda apenas JSON valido.',
      messages: [{ role: 'user', content: buildResearchPrompt(product, results) }],
    });
    const textOut = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const parsed = extractJsonObject(textOut);
    if (parsed && typeof parsed === 'object') {
      return {
        summary: safeText(parsed.summary, 900),
        sellingAngles: arrayFromJson(parsed.sellingAngles).map((x) => safeText(x, 220)).filter(Boolean).slice(0, 8),
        customerFit: arrayFromJson(parsed.customerFit).map((x) => safeText(x, 180)).filter(Boolean).slice(0, 8),
        objections: Array.isArray(parsed.objections)
          ? parsed.objections.map((o) => ({
              objection: safeText(o?.objection || o, 140),
              answer: safeText(o?.answer || '', 300),
            })).filter((o) => o.objection).slice(0, 6)
          : [],
        comparisonNotes: arrayFromJson(parsed.comparisonNotes).map((x) => safeText(x, 220)).filter(Boolean).slice(0, 6),
        keywords: arrayFromJson(parsed.keywords).map((x) => safeText(x, 80)).filter(Boolean).slice(0, 12),
        confidence: ['low', 'medium', 'high'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      };
    }
  } catch (err) {
    console.warn('[seller-agent/research] resumo IA falhou:', err.message);
  }
  return fallbackResearchFromResults(product, results);
}

function isResearchFresh(research) {
  if (!research?.updatedAt) return false;
  const updated = new Date(research.updatedAt).getTime();
  if (!updated) return false;
  const maxAgeDays = parseInt(process.env.SELLER_AGENT_RESEARCH_CACHE_DAYS || '30', 10);
  return Date.now() - updated < Math.max(maxAgeDays, 1) * 86400000;
}

async function researchProductWebForAgent(input, snapshot) {
  const force = !!input?.force;
  const detailResult = await getProductDetailsForAgent(input, snapshot);
  if (!detailResult.product) {
    return {
      ...detailResult,
      saved: false,
      message: detailResult.message || 'Nao encontrei um produto do sistema para pesquisar. Informe nome, modelo ou SKU.',
    };
  }

  const raw = await prisma.product.findUnique({
    where: { id: detailResult.rawProductId || detailResult.product.id },
    select: SELLER_PRODUCT_SELECT,
  });
  if (!raw) return { product: detailResult.product, saved: false, message: 'Produto nao encontrado ao salvar pesquisa.' };

  const ctx = parseJsonSafe(raw.aiContext, {}) || {};
  if (!force && isResearchFresh(ctx.sellerAgentResearch)) {
    return {
      product: formatSellerProduct(raw, input),
      research: ctx.sellerAgentResearch,
      cached: true,
      saved: true,
      message: 'Usei pesquisa ja salva na memoria do produto.',
    };
  }

  const query = safeText(
    input?.webQuery || [raw.brand, raw.name, raw.sku, raw.category, 'ficha tecnica review beneficio para vender'].filter(Boolean).join(' '),
    260,
  );
  const web = await serperWeb.searchWeb(query, { count: Math.min(parseInt(input?.count, 10) || 6, 10) });
  const results = web.ok ? web.results.slice(0, 8) : [];
  const publicProduct = formatSellerProduct(raw, input);
  const summary = await summarizeResearchWithAI(publicProduct, results);
  const research = {
    updatedAt: new Date().toISOString(),
    query,
    source: web.ok ? 'serper+anthropic' : 'local-catalog',
    webOk: !!web.ok,
    webError: web.ok ? null : web.error || null,
    summary: summary.summary,
    sellingAngles: summary.sellingAngles || [],
    customerFit: summary.customerFit || [],
    objections: summary.objections || [],
    comparisonNotes: summary.comparisonNotes || [],
    keywords: summary.keywords || [],
    confidence: summary.confidence || (web.ok ? 'medium' : 'low'),
    sources: results.map((r) => ({
      title: safeText(r.title, 180),
      url: safeText(r.url, 500),
      snippet: safeText(r.snippet, 260),
    })),
  };

  const nextCtx = { ...ctx, sellerAgentResearch: research };
  await prisma.product.update({
    where: { id: raw.id },
    data: { aiContext: nextCtx },
  });

  await recordEvent({
    category: 'produto',
    title: `IA ST pesquisou ${raw.brand || ''} ${raw.name || raw.sku}`.trim(),
    detail: research.summary,
    data: {
      sellerId: snapshot?.seller?.id || null,
      storeId: snapshot?.seller?.storeId || null,
      productId: raw.id,
      sku: raw.sku,
      query,
      sources: research.sources,
      sellingAngles: research.sellingAngles,
      confidence: research.confidence,
    },
    source: 'seller-agent',
    refType: 'Product',
    refId: raw.id,
    importance: 2,
    createdById: snapshot?.seller?.id || null,
  });

  return {
    product: formatSellerProduct({ ...raw, aiContext: nextCtx }, input),
    research,
    cached: false,
    saved: true,
    message: web.ok
      ? 'Pesquisa feita na internet e salva no produto.'
      : `Pesquisa web indisponivel (${web.error || 'sem configuracao'}). Salvei inteligencia baseada no catalogo.`,
  };
}

async function saveSellerLearningForAgent(input, snapshot) {
  const detail = safeText(input?.detail || input?.text || input?.message, 1800);
  const title = safeText(input?.title || detail.slice(0, 120), 160);
  if (!detail || detail.length < 4) return { saved: false, message: 'Diga o aprendizado que devo guardar.' };
  const category = safeText(input?.category || 'ia-vendedor', 60);
  const importance = Math.min(Math.max(parseInt(input?.importance, 10) || 2, 0), 3);
  const productId = safeText(input?.productId || input?.relatedProductId, 80) || null;
  const memory = await recordEvent({
    category,
    title,
    detail,
    data: {
      sellerId: snapshot?.seller?.id || null,
      storeId: snapshot?.seller?.storeId || null,
      productId,
      raw: input || {},
    },
    source: 'seller-agent',
    refType: productId ? 'Product' : null,
    refId: productId,
    importance,
    createdById: snapshot?.seller?.id || null,
  });
  return {
    saved: !!memory,
    memoryId: memory?.id || null,
    message: memory ? 'Aprendizado salvo na memoria da empresa.' : 'Nao consegui salvar a memoria agora.',
  };
}

function firstStockLine(stock) {
  if (!stock?.totalStock) return 'sem estoque registrado';
  const firstStore = stock.stores?.[0];
  const sizes = (stock.availableSizes || []).slice(0, 5).map((s) => s.size).join(', ');
  if (!firstStore) return `${stock.totalStock} un. no total${sizes ? `, tamanhos ${sizes}` : ''}`;
  return `${stock.totalStock} un. no total; maior disponibilidade em ${firstStore.code || ''} ${firstStore.name || ''}`.trim();
}

function formatRecommendationReply(result) {
  if (!result?.products?.length) {
    return [
      result?.message || 'Nao encontrei produto no catalogo para essa necessidade.',
      'Me diga modalidade, faixa de preco, marca desejada ou tamanho para eu refinar.',
    ].join('\n');
  }
  const lines = [];
  lines.push(`Usei catalogo, detalhes do produto e estoque real para "${result.need || result.query}".`);
  if (result.budget && result.budgetMatched === false) {
    lines.push(`Nao encontrei opcao dentro de ${moneyBRL(result.budget)}; abaixo estao as mais proximas fora do orcamento.`);
  }
  result.products.slice(0, 3).forEach((p, idx) => {
    const price = p.priceLabel ? ` - ${p.priceLabel}` : '';
    lines.push(`${idx + 1}. ${[p.brand, p.name].filter(Boolean).join(' ')}${price}`);
    lines.push(`   Por que: ${(p.why || []).slice(0, 2).join('; ') || 'bom encaixe para a necessidade.'}`);
    lines.push(`   Estoque: ${firstStockLine(p.stock)}.`);
  });
  lines.push('Salvei a recomendacao na memoria para a IA ST melhorar as proximas respostas.');
  return lines.join('\n');
}

function formatResearchReply(result) {
  if (!result?.product) {
    const candidates = (result?.candidates || []).slice(0, 4);
    if (candidates.length) {
      return [
        result.message || 'Encontrei mais de um produto possivel.',
        ...candidates.map((c, idx) => `${idx + 1}. ${c.product.sku} - ${[c.product.brand, c.product.name].filter(Boolean).join(' ')}`),
        'Me mande o SKU ou nome exato para eu pesquisar e salvar.',
      ].join('\n');
    }
    return result?.message || 'Nao encontrei produto do sistema para pesquisar.';
  }
  const p = result.product;
  const r = result.research || p.sellerResearch || {};
  const lines = [];
  lines.push(`${result.cached ? 'Usei memoria ja salva' : 'Pesquisei e salvei'} para ${[p.brand, p.name].filter(Boolean).join(' ')} (${p.sku}).`);
  if (r.summary) lines.push(r.summary);
  const angles = (r.sellingAngles || []).slice(0, 3);
  if (angles.length) lines.push(`Argumentos: ${angles.join(' | ')}`);
  const objection = (r.objections || [])[0];
  if (objection) lines.push(`Objecao: ${objection.objection}. Resposta: ${objection.answer || 'explique o beneficio antes do preco.'}`);
  const sources = (r.sources || []).slice(0, 3).map((s) => s.title || s.url).filter(Boolean);
  if (sources.length) lines.push(`Fontes usadas: ${sources.join(' ; ')}`);
  lines.push('Esse aprendizado ficou no produto e na memoria da empresa para proximas conversas.');
  return lines.join('\n');
}

async function persistSellerAgentTurn(req, text, reply, metadata = {}) {
  try {
    let conv = null;
    const conversationId = String(req.body?.conversationId || '').trim();
    if (conversationId) {
      conv = await prisma.aIConversation.findFirst({
        where: { id: conversationId, userId: req.userId, active: true },
      });
    }
    if (!conv) {
      conv = await prisma.aIConversation.create({
        data: {
          userId: req.userId,
          userType: 'seller-agent',
          title: `IA ST Vendedor: ${text.slice(0, 55)}`,
        },
      });
    }
    const msgs = parseMessages(conv.messages);
    msgs.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    msgs.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString(), metadata });
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: { messages: msgs, updatedAt: new Date() },
    });
    return conv.id;
  } catch (err) {
    console.warn('[seller-agent] falha ao persistir conversa:', err.message);
    return null;
  }
}

function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function buildCostBRL(usage) {
  const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
  const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { usd, brl: usd * brl, inT, outT };
}

function formatDateTime(dt) {
  if (!dt) return null;
  try {
    return new Date(dt).toISOString();
  } catch {
    return null;
  }
}

function isDueTodayOrLate(dt) {
  if (!dt) return false;
  return new Date(dt) <= endOfDay();
}

function customerDisplay(id, userMap, sellerClientMap) {
  const sc = sellerClientMap.get(id);
  if (sc) {
    return {
      id,
      name: sc.name || 'Cliente',
      phone: sc.phone || null,
      email: sc.email || null,
      shoeSize: sc.shoeSize || null,
      tags: sc.tags || null,
      source: 'sellerClient',
    };
  }
  const u = userMap.get(id);
  if (u) {
    return {
      id,
      name: u.name || 'Cliente TenisCash',
      phone: u.phone || null,
      email: u.email || null,
      balance: u.balance || 0,
      sportsPractice: u.sportsPractice || null,
      favBrands: u.favBrands || null,
      source: 'user',
    };
  }
  return { id, name: 'Cliente', source: 'unknown' };
}

function rankAssignment(a) {
  const due = isDueTodayOrLate(a.nextActionDate) ? 10 : 0;
  return (
    due +
    (PRIORITY_WEIGHT[a.priority] || 0) * 2 +
    (RELATIONSHIP_WEIGHT[a.relationshipStatus] || 0)
  );
}

function summarizeSaleItems(items) {
  const byProduct = new Map();
  for (const item of items || []) {
    const key = item.productId || item.productName || 'produto';
    const cur = byProduct.get(key) || {
      productId: item.productId || null,
      name: item.product?.name || item.productName || 'Produto',
      brand: item.product?.brand || item.brand || '',
      category: item.product?.category || item.category || '',
      imageUrl: item.product?.imageUrl || null,
      quantity: 0,
      total: 0,
    };
    cur.quantity += item.quantity || 0;
    cur.total += item.totalPrice || 0;
    byProduct.set(key, cur);
  }
  return Array.from(byProduct.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

function productSearchWhere(query) {
  const q = safeText(query, 120);
  const terms = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!terms.length) {
    return { OR: [{ active: true }, { sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } } }] };
  }
  return {
    AND: [
      { OR: [{ active: true }, { sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } } }] },
      ...terms.map((term) => ({
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { sku: { contains: term, mode: 'insensitive' } },
          { brand: { contains: term, mode: 'insensitive' } },
          { category: { contains: term, mode: 'insensitive' } },
          { subcategory: { contains: term, mode: 'insensitive' } },
          { shortDescription: { contains: term, mode: 'insensitive' } },
          { longDescription: { contains: term, mode: 'insensitive' } },
          { sizes: { some: { barcode: { contains: term, mode: 'insensitive' } } } },
        ],
      })),
    ],
  };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function productStockSearchText(product) {
  const barcodes = (product.sizes || []).map((s) => s.barcode).filter(Boolean).join(' ');
  return normalizeStoreNeedle([
    product.sku,
    product.name,
    product.brand,
    product.category,
    product.subcategory,
    product.shortDescription,
    product.longDescription,
    barcodes,
  ].filter(Boolean).join(' '));
}

function stockQueryMatchesProduct(product, query) {
  const terms = normalizeStoreNeedle(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!terms.length) return true;
  const hay = productStockSearchText(product);
  return terms.every((term) => {
    if (/^\d{1,3}$/.test(term)) {
      return new RegExp(`(^|[^0-9])${escapeRegExp(term)}([^0-9]|$)`).test(hay);
    }
    return hay.includes(term);
  });
}

function normalizeStoreNeedle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function matchesStore(store, wanted) {
  const needle = normalizeStoreNeedle(wanted);
  if (!needle) return true;
  const hay = normalizeStoreNeedle(`${store?.id || ''} ${store?.code || ''} ${store?.name || ''}`);
  return hay.includes(needle);
}

function isInternalMessageIntent(text) {
  const msg = normalizeStoreNeedle(text);
  return (
    /\b(manda|mande|mandar|envia|envie|enviar)\b.*\bmensagem\b/.test(msg) ||
    /\bmensagem\b.*\b(para|pra|pro|ao|a)\b/.test(msg) ||
    /\b(avisa|avisar|avise|fala|fale|diga)\b.*\b(para|pra|pro|ao|a)\b/.test(msg)
  );
}

function parseInternalMessageCommand(text) {
  const raw = safeText(text, 2200);
  const patterns = [
    /(?:manda|mande|mandar|envia|envie|enviar)\s+(?:uma\s+)?mensagem\s+(?:para|pra|pro|ao|a)\s+(.+?)\s+(?:dizendo|falando|com\s+o\s+texto|que|:)\s+(.+)/i,
    /(?:mensagem)\s+(?:para|pra|pro|ao|a)\s+(.+?)\s*(?:dizendo|falando|com\s+o\s+texto|que|:|-)\s*(.+)/i,
    /(?:avisa|avisar|avise|fala|fale|diga)\s+(?:para|pra|pro|ao|a)\s+(.+?)\s+(?:que|:)\s+(.+)/i,
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (!m) continue;
    const recipientQuery = safeText(m[1], 120)
      .replace(/^(o|a|ao|aos|as|pro|pra)\s+/i, '')
      .trim();
    const content = safeMessageText(m[2], 1800);
    if (recipientQuery && content) return { recipientQuery, content };
  }
  return { recipientQuery: '', content: '' };
}

async function searchInternalRecipients(query, senderId) {
  const q = safeText(query, 120);
  if (!q || q.length < 2) return [];
  const terms = q.split(/\s+/).map((t) => t.trim()).filter((t) => t.length >= 2);
  return prisma.user.findMany({
    where: {
      active: true,
      id: { not: senderId },
      role: { in: ['seller', 'admin', 'superadmin', 'manager'] },
      ...(terms.length
        ? {
            AND: terms.map((term) => ({
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { phone: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
                { employeeCode: { contains: term, mode: 'insensitive' } },
              ],
            })),
          }
        : {}),
    },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
    take: 8,
    select: {
      id: true,
      name: true,
      role: true,
      employeeCode: true,
      store: { select: { code: true, name: true } },
    },
  });
}

function bestRecipientMatch(query, recipients) {
  if (!recipients.length) return null;
  const needle = normalizeStoreNeedle(query);
  const exact = recipients.filter((r) => normalizeStoreNeedle(r.name) === needle || normalizeStoreNeedle(r.employeeCode) === needle);
  if (exact.length === 1) return exact[0];
  const contains = recipients.filter((r) => normalizeStoreNeedle(r.name).includes(needle));
  if (contains.length === 1) return contains[0];
  return recipients.length === 1 ? recipients[0] : null;
}

async function handleInternalMessageIntent(req, text) {
  const parsed = parseInternalMessageCommand(text);
  if (!parsed.recipientQuery || !parsed.content) {
    return {
      handled: true,
      reply: 'Posso enviar pelo sistema de mensagens. Use assim: "Mande mensagem para Nome dizendo Texto da mensagem".',
      suggestions: ['Mande mensagem para vendedor dizendo preciso de ajuda', 'Abrir mensagens', 'Quem eu chamo primeiro?'],
    };
  }

  const recipients = await searchInternalRecipients(parsed.recipientQuery, req.userId);
  const recipient = bestRecipientMatch(parsed.recipientQuery, recipients);
  if (!recipient) {
    if (!recipients.length) {
      return {
        handled: true,
        reply: `Nao encontrei nenhum vendedor ou admin ativo para "${parsed.recipientQuery}". Tente nome completo ou codigo do vendedor.`,
        suggestions: ['Tentar nome completo', 'Abrir mensagens', 'Pedir plano do dia'],
      };
    }
    const list = recipients.map((r, idx) => {
      const store = r.store?.code ? ` - ${r.store.code}` : '';
      const code = r.employeeCode ? ` (${r.employeeCode})` : '';
      return `${idx + 1}. ${r.name}${code}${store}`;
    }).join('\n');
    return {
      handled: true,
      reply: `Encontrei mais de uma pessoa. Me diga o nome mais completo ou codigo:\n${list}`,
      suggestions: recipients.slice(0, 3).map((r) => `Mande mensagem para ${r.name} dizendo ${parsed.content.slice(0, 50)}`),
    };
  }

  const message = await prisma.message.create({
    data: {
      fromId: req.userId,
      toId: recipient.id,
      type: 'message',
      title: 'IA ST Vendedor',
      content: parsed.content,
      status: 'sent',
    },
    select: {
      id: true,
      title: true,
      content: true,
      createdAt: true,
      to: { select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } } },
    },
  });

  return {
    handled: true,
    reply: `Mensagem enviada para ${recipient.name} pelo sistema interno:\n"${parsed.content}"`,
    suggestions: ['Ver mensagens enviadas', 'Enviar outra mensagem', 'Montar proxima tarefa'],
    message,
  };
}

function isStockIntent(text) {
  const msg = normalizeStoreNeedle(text);
  const hasShoeSize = /\b(3[0-9]|4[0-9]|5[0-2])\b/.test(msg);
  const hasProductTerm = msg
    .split(/\s+/)
    .some((term) => /^[a-z0-9-]{3,}$/.test(term) && !['qual', 'quais', 'onde', 'loja', 'lojas', 'tem', 'para', 'pra', 'com'].includes(term));
  return (
    /\bestoque\b/.test(msg) ||
    /\bdisponivel\b/.test(msg) ||
    /\bdisponibilidade\b/.test(msg) ||
    /\btamanho\b/.test(msg) ||
    /\btamanhos\b/.test(msg) ||
    (hasShoeSize && hasProductTerm) ||
    /\b(tam|numero|numeros|n)\b\s*[:#-]?\s*([a-z]{1,3}|3[0-9]|4[0-9]|5[0-2])\b/.test(msg) ||
    /\bonde tem\b/.test(msg) ||
    /\b(em\s+qual|qual|quais|onde)\s+lojas?\b/.test(msg) ||
    /\blojas?\b.*\b(3[0-9]|4[0-9]|5[0-2])\b/.test(msg) ||
    /\btem\b.*\bloja/.test(msg) ||
    /\btem\b.*\b(3[0-9]|4[0-9]|5[0-2])\b/.test(msg)
  );
}

function isWebResearchIntent(text) {
  const msg = normalizeStoreNeedle(text);
  return (
    /\b(pesquisa|pesquise|procurar|procura|buscar|busca)\b.*\b(internet|google|web|site|sites)\b/.test(msg) ||
    /\b(internet|google|web)\b.*\b(produto|modelo|tenis|chuteira|mochila|bolsa|camiseta)\b/.test(msg) ||
    /\b(ficha tecnica|especificacao|especificacoes|review|resenha|detalhes completos|mais detalhes)\b/.test(msg)
  );
}

function isProductRecommendationIntent(text) {
  const msg = normalizeStoreNeedle(text);
  if (isStockIntent(text) || isInternalMessageIntent(text)) return false;
  return (
    /\b(indica|indique|recomenda|recomende|sugere|sugira|sugestao|sugestao de|melhor produto)\b/.test(msg) ||
    /\b(cliente|alguem)\b.*\b(quer|precisa|procura|busca|gosta)\b/.test(msg) ||
    /\b(qual|quais)\b.*\b(tenis|chuteira|mochila|bolsa|camiseta|produto)\b/.test(msg) ||
    /\b(produto|modelo)\b.*\b(vender|oferecer|abordar|mostrar)\b/.test(msg)
  );
}

function isLearningIntent(text) {
  const msg = normalizeStoreNeedle(text);
  return (
    /\b(aprenda|aprende|guarde|guardar|salve|salvar|lembre|anote|anota|memoriza|registre)\b/.test(msg) ||
    /\b(cliente|clientes)\b.*\b(falou|falaram|pediu|pediram|achou|acharam|reclamou|reclamaram)\b/.test(msg)
  );
}

function isStockSizeDisplayComplaint(text) {
  const msg = normalizeStoreNeedle(text);
  return /\btamanhos?\b/.test(msg) && /\b(nao|consigo|mostrando|mostrar|aparece|aparecendo|exibe|exibir|sumiu)\b/.test(msg);
}

function detectSizeFromText(text) {
  const normalizedSizeText = normalizeStoreNeedle(text);
  const explicitSize = normalizedSizeText.match(/\b(?:tamanho|tam|numero)\b\s*[:#-]?\s*([0-9]{2}|[a-z]{1,3})\b/i);
  if (explicitSize) return explicitSize[1].toUpperCase();
  const numericSize = normalizedSizeText.match(/\b(3[0-9]|4[0-9]|5[0-2])\b/);
  return numericSize ? numericSize[1] : '';
}

function detectStoreFromText(text, stores) {
  const msg = normalizeStoreNeedle(text);
  return (stores || []).find((store) => {
    const code = normalizeStoreNeedle(store.code);
    const name = normalizeStoreNeedle(store.name);
    const parts = name.split(/\s+/).filter((p) => p.length >= 4 && !['sports', 'tennis', 'loja'].includes(p));
    return (code && msg.includes(code)) || parts.some((p) => msg.includes(p));
  }) || null;
}

function cleanStockQuery(text, stores, size, store) {
  let q = normalizeStoreNeedle(text);
  q = q.replace(/(?:tamanho|tam|numero|n[uú]mero)\s*[:#-]?\s*([0-9]{2}|[a-z]{1,3})/gi, ' ');
  if (size) q = q.replace(new RegExp(`\\b${String(size).toLowerCase()}\\b`, 'g'), ' ');
  if (store) {
    q = q.replace(new RegExp(`\\b${normalizeStoreNeedle(store.code)}\\b`, 'g'), ' ');
    normalizeStoreNeedle(store.name)
      .split(/\s+/)
      .filter((p) => p.length >= 4)
      .forEach((p) => { q = q.replace(new RegExp(`\\b${p}\\b`, 'g'), ' '); });
  }
  q = q
    .replace(/\b(vc|voce|você|consegue|conseguiria|pode|poderia|sabe|saber|consulta|consultar|localiza|localizar|procura|procurar|acha|achar|me|dizer|qual|quais|tem|tenho|estoque|disponivel|disponibilidade|onde|loja|lojas|nas|nos|na|no|em|de|do|da|das|dos|para|pra|um|uma|uns|umas|esse|essa|este|esta|produto|produtos)\b/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  q = q
    .replace(/\b(busca|buscar|ver|ve|veja|olha|olhar|confere|conferir|mim|pra|favor|por|algum|alguma|alguns|algumas|item|itens)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  q = q
    .replace(/\b(ai|nao|ta|esta|estou|to|consigo|consegui|mostrar|mostra|mostrando|aparece|aparecendo|exibe|exibir|tamanho|tamanhos|numero|numeros|entao|os|as|o|a)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q || q.length < 2) return '';
  return q;
}

function stockNeedsProductReply() {
  return [
    'Sim, consigo saber onde tem um produto no estoque das lojas.',
    'Me diga o produto, modelo ou SKU. Se quiser, mande tambem tamanho e loja.',
    'Exemplo: "Nimbus 27 tamanho 41" ou "bolsa yoga tote na Tambau".',
  ].join('\n');
}

function stockSizeDisplayHelpReply() {
  return [
    'Entendi. Quando o tamanho aparece como "Tamanho nao identificado", o estoque existe, mas a grade desse item esta cadastrada sem tamanho no sistema.',
    'Me diga o produto ou SKU que eu mostro loja, quantidade e se o tamanho veio sem identificacao.',
    'Depois precisa corrigir esse tamanho no cadastro/estoque para o vendedor conseguir vender sem conferir fisicamente.',
  ].join('\n');
}

async function parseStockInputFromText(text) {
  const stores = await prisma.store.findMany({
    where: { active: true },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, name: true, city: true },
  });
  const size = detectSizeFromText(text);
  const store = detectStoreFromText(text, stores);
  return {
    query: cleanStockQuery(text, stores, size, store),
    size,
    store: store ? (store.code || store.name) : '',
    limit: 6,
  };
}

function isUnknownStockSize(size) {
  const s = String(size || '').trim().toLowerCase();
  return !s || s === '?' || s === '-' || s === 'nan' || s === 'null' || s === 'undefined';
}

function normalizeStockSize(size) {
  return normalizeStoreNeedle(size).replace(/\s+/g, '');
}

function stockSizeMatches(size, wanted) {
  const current = normalizeStockSize(size);
  const target = normalizeStockSize(wanted);
  if (!current || !target || isUnknownStockSize(current)) return false;
  if (current === target) return true;
  return current.split(/[\/,-]/).filter(Boolean).includes(target);
}

function displayStockSize(size) {
  return isUnknownStockSize(size) ? 'Tamanho nao identificado' : size;
}

function formatStoreSizeList(store) {
  return (store.sizes || [])
    .map((s) => `${displayStockSize(s.size)}: ${s.stock}`)
    .join(', ');
}

function formatKnownSizeList(sizes, opts = {}) {
  const rows = (sizes || []).slice(0, opts.limit || 10);
  return rows.map((s) => {
    const label = displayStockSize(s.size);
    return s.stock > 0 ? `${label}: ${s.stock}` : `${label} sem saldo`;
  }).join(', ');
}

function formatUnlocatedSizeList(sizes, opts = {}) {
  return (sizes || [])
    .filter((s) => s.stock > 0)
    .slice(0, opts.limit || 10)
    .map((s) => `${displayStockSize(s.size)}: ${s.stock}`)
    .join(', ');
}

function formatProductSizeSummary(product, requestedSize = '') {
  const lines = [];
  const knownSizes = (product.knownSizes || [])
    .filter((s) => !isUnknownStockSize(s.size))
    .sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }));
  const unlocatedKnownSizes = (product.unlocatedKnownSizes || [])
    .filter((s) => !isUnknownStockSize(s.size) && s.stock > 0)
    .sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }));

  if (requestedSize) {
    if (product.requestedSizeKnown) {
      lines.push(product.requestedSizeStock > 0
        ? `Tamanho ${requestedSize}: ${product.requestedSizeStock} un.`
        : `Tamanho ${requestedSize}: cadastrado, mas sem saldo nas lojas consultadas`);
      if (product.requestedSizeUnlocatedStock > 0) {
        lines.push(`Tamanho ${requestedSize}: ${product.requestedSizeUnlocatedStock} un. no estoque geral sem loja vinculada`);
      }
    } else {
      lines.push(`Tamanho ${requestedSize}: nao aparece como grade cadastrada desse produto`);
    }
  }

  const available = knownSizes.filter((s) => s.stock > 0);
  const withoutStock = knownSizes
    .filter((s) => s.stock <= 0 && (!requestedSize || !stockSizeMatches(s.size, requestedSize)));
  if (available.length) lines.push(`Tamanhos com saldo: ${formatKnownSizeList(available)}`);
  if (withoutStock.length) lines.push(`Tamanhos cadastrados sem saldo: ${withoutStock.slice(0, 10).map((s) => displayStockSize(s.size)).join(', ')}`);
  if (product.unknownSizeStock > 0) lines.push(`${product.unknownSizeStock} un. com tamanho nao identificado no cadastro`);
  if (unlocatedKnownSizes.length) lines.push(`Estoque geral sem loja vinculada: ${formatUnlocatedSizeList(unlocatedKnownSizes)}`);
  if (product.unlocatedUnknownSizeStock > 0) lines.push(`Estoque geral sem loja vinculada e sem tamanho identificado: ${product.unlocatedUnknownSizeStock} un.`);
  return lines.join(' | ') || 'Nao encontrei grade de tamanho legivel no cadastro.';
}

function formatStockReply(stockResult) {
  if (!stockResult?.products?.length) {
    if (stockResult?.alternatives?.length) {
      const lines = [];
      lines.push(`Nao localizei estoque registrado para "${stockResult.query || 'esse produto'}"${stockResult.size ? ` no tamanho ${stockResult.size}` : ''}.`);
      lines.push('O que eu li no cadastro e no estoque real:');
      stockResult.alternatives.slice(0, 3).forEach((p, idx) => {
        const title = `${idx + 1}. ${p.brand || ''} ${p.name || ''}`.trim();
        lines.push(`${title} - total ${p.totalStock} un.`);
        lines.push(`   Tamanhos lidos: ${formatProductSizeSummary(p, stockResult.size)}`);
        p.stores.slice(0, 4).forEach((store) => {
          lines.push(`   ${store.code} ${store.name}: ${store.totalStock} un. (${formatStoreSizeList(store)})`);
        });
      });
      lines.push('Se aparecer "Tamanho nao identificado", eu nao vou assumir que e o tamanho pedido; precisa corrigir o cadastro ou conferir fisicamente na loja.');
      return lines.join('\n');
    }
    if (stockResult?.catalogMatches?.length) {
      const lines = [];
      lines.push(`Nao encontrei saldo por loja para "${stockResult.query || 'esse produto'}"${stockResult.size ? ` no tamanho ${stockResult.size}` : ''}.`);
      lines.push('Mas eu li o cadastro do produto e a grade registrada:');
      stockResult.catalogMatches.slice(0, 3).forEach((p, idx) => {
        const title = `${idx + 1}. ${p.brand || ''} ${p.name || ''}`.trim();
        lines.push(`${title}`);
        lines.push(`   Tamanhos lidos: ${formatProductSizeSummary(p, stockResult.size)}`);
      });
      lines.push('Quando aparecer estoque geral sem loja vinculada, eu nao consigo afirmar em qual loja esta. Precisa distribuir/corrigir o estoque antes de prometer ao cliente.');
      return lines.join('\n');
    }
    return `Consultei o estoque das lojas e nao localizei estoque registrado para "${stockResult?.query || 'esse produto'}"${stockResult?.size ? ` no tamanho ${stockResult.size}` : ''}.`;
  }
  const lines = [];
  lines.push(`Consultei o estoque real das lojas para "${stockResult.query}"${stockResult.size ? ` tamanho ${stockResult.size}` : ''}:`);
  stockResult.products.slice(0, 4).forEach((p, idx) => {
    const title = `${idx + 1}. ${p.brand || ''} ${p.name || ''}`.trim();
    lines.push(`${title} - total ${p.totalStock} un.`);
    lines.push(`   Tamanhos lidos: ${formatProductSizeSummary(p, stockResult.size)}`);
    p.stores.slice(0, 6).forEach((store) => {
      lines.push(`   ${store.code} ${store.name}: ${store.totalStock} un. (${formatStoreSizeList(store)})`);
    });
  });
  lines.push('Nao mostrei custo, apenas disponibilidade por loja e tamanho.');
  if (stockResult.hasUnknownSize) {
    lines.push('Atencao: alguma unidade esta com tamanho nao identificado no cadastro; confirme antes de prometer um numero ao cliente.');
  }
  return lines.join('\n');
}

function mapProductStock(product, stores, filters = {}) {
  const sizeWanted = safeText(filters.size, 20).toLowerCase();
  const filterBySize = !!sizeWanted && filters.filterBySize !== false;
  const storeWanted = safeText(filters.store, 80);
  const storeMap = new Map(stores.map((s) => [s.id, s]));
  const byStore = new Map(stores.map((s) => [s.id, {
    id: s.id,
    code: s.code,
    name: s.name,
    totalStock: 0,
    sizes: [],
  }]));
  const sizeTotals = new Map();
  const knownSizeTotals = new Map();
  const unlocatedKnownSizeTotals = new Map();
  let unknownSizeStock = 0;
  let unlocatedUnknownSizeStock = 0;
  let unlocatedStockTotal = 0;
  let requestedSizeKnown = false;
  let requestedSizeStock = 0;
  let requestedSizeUnlocatedStock = 0;

  for (const size of product.sizes || []) {
    const matchesRequestedSize = sizeWanted && stockSizeMatches(size.size, sizeWanted);
    const matchedStoreStocks = (size.storeStocks || []).filter((ss) => {
      const store = storeMap.get(ss.storeId) || ss.store;
      return store && matchesStore(store, storeWanted);
    });
    const totalForAnyMatchedStore = matchedStoreStocks.reduce((sum, ss) => sum + Math.max(0, ss.stock || 0), 0);
    const productSizeStock = Math.max(0, size.stock || 0);
    const unlocatedQty = Math.max(0, productSizeStock - totalForAnyMatchedStore);
    unlocatedStockTotal += unlocatedQty;
    if (isUnknownStockSize(size.size)) {
      unknownSizeStock += totalForAnyMatchedStore;
      unlocatedUnknownSizeStock += unlocatedQty;
    } else {
      knownSizeTotals.set(size.size, (knownSizeTotals.get(size.size) || 0) + totalForAnyMatchedStore);
      unlocatedKnownSizeTotals.set(size.size, (unlocatedKnownSizeTotals.get(size.size) || 0) + unlocatedQty);
    }
    if (matchesRequestedSize) {
      requestedSizeKnown = true;
      requestedSizeStock += totalForAnyMatchedStore;
      requestedSizeUnlocatedStock += unlocatedQty;
    }
    if (filterBySize && !matchesRequestedSize) continue;
    let totalForSize = 0;
    for (const ss of matchedStoreStocks) {
      const store = storeMap.get(ss.storeId) || ss.store;
      const qty = Math.max(0, ss.stock || 0);
      if (qty <= 0) continue;
      const entry = byStore.get(store.id);
      if (!entry) continue;
      entry.totalStock += qty;
      entry.sizes.push({ size: size.size, stock: qty });
      totalForSize += qty;
    }
    if (totalForSize > 0) {
      sizeTotals.set(size.size, (sizeTotals.get(size.size) || 0) + totalForSize);
    }
  }

  const storesWithStock = Array.from(byStore.values())
    .filter((s) => s.totalStock > 0)
    .sort((a, b) => b.totalStock - a.totalStock || String(a.code).localeCompare(String(b.code)));
  const totalStock = storesWithStock.reduce((sum, s) => sum + s.totalStock, 0);
  const hasUnknownSize = storesWithStock.some((s) => (s.sizes || []).some((x) => isUnknownStockSize(x.size)));

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    brand: product.brand,
    category: product.category,
    subcategory: product.subcategory,
    price: product.price,
    promoPrice: product.promoPrice,
    imageUrl: product.imageUrl,
    totalStock,
    hasUnknownSize,
    sizes: Array.from(sizeTotals.entries()).map(([size, stock]) => ({ size, stock })),
    knownSizes: Array.from(knownSizeTotals.entries()).map(([size, stock]) => ({ size, stock })),
    unlocatedKnownSizes: Array.from(unlocatedKnownSizeTotals.entries()).map(([size, stock]) => ({ size, stock })),
    unknownSizeStock,
    unlocatedUnknownSizeStock,
    unlocatedStockTotal,
    catalogStockTotal: totalStock + unlocatedStockTotal,
    requestedSize: sizeWanted || null,
    requestedSizeKnown,
    requestedSizeStock,
    requestedSizeUnlocatedStock,
    stores: storesWithStock,
  };
}

async function searchStoreStockForAgent(input, snapshot) {
  const query = safeText(input?.query, 120);
  const size = safeText(input?.size, 20);
  const store = safeText(input?.store || input?.storeCode || input?.storeName, 80);
  const limit = Math.min(parseInt(input?.limit, 10) || 8, 15);
  if (!query || query.length < 2) {
    return { products: [], message: 'Informe pelo menos 2 caracteres do produto para consultar estoque.' };
  }

  const [stores, products] = await Promise.all([
    prisma.store.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, city: true },
    }),
    prisma.product.findMany({
      where: productSearchWhere(query),
      orderBy: [{ featured: 'desc' }, { name: 'asc' }],
      take: 25,
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        subcategory: true,
        price: true,
        promoPrice: true,
        imageUrl: true,
        sizes: {
          orderBy: { size: 'asc' },
          select: {
            id: true,
            size: true,
            stock: true,
            barcode: true,
            storeStocks: {
              select: {
                storeId: true,
                stock: true,
                store: { select: { id: true, code: true, name: true, city: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const matchedProducts = products.filter((p) => stockQueryMatchesProduct(p, query));
  const productPool = matchedProducts.length ? matchedProducts : products;

  const mapped = productPool
    .map((p) => mapProductStock(p, stores, { size, store }))
    .filter((p) => p.totalStock > 0)
    .slice(0, limit);
  const alternatives = size && !mapped.length
    ? productPool
        .map((p) => mapProductStock(p, stores, { size, store, filterBySize: false }))
        .filter((p) => p.totalStock > 0)
        .slice(0, limit)
    : [];
  const catalogMatches = !mapped.length && !alternatives.length
    ? productPool
        .map((p) => mapProductStock(p, stores, { size, store, filterBySize: false }))
        .filter((p) => p.catalogStockTotal > 0 || p.requestedSizeKnown || (p.knownSizes || []).length)
        .slice(0, limit)
    : [];

  const currentStoreId = snapshot?.seller?.storeId || null;
  const currentStore = stores.find((s) => s.id === currentStoreId) || null;

  return {
    query,
    size: size || null,
    store: store || null,
    currentStore,
    products: mapped,
    alternatives,
    catalogMatches,
    count: mapped.length,
    hasUnknownSize: mapped.some((p) => p.hasUnknownSize)
      || alternatives.some((p) => p.hasUnknownSize)
      || catalogMatches.some((p) => p.hasUnknownSize || p.unlocatedUnknownSizeStock > 0),
    message: mapped.length
      ? 'Estoque consultado em StoreStock por loja e tamanho.'
      : 'Nenhum estoque localizado para esse termo/filtro. Pode existir produto no catalogo sem localizacao registrada.',
  };
}

function buildRecommendedTasks(snapshot) {
  const tasks = [];
  const now = new Date();
  const baseDue = addMinutes(now, 45);
  const customers = snapshot.priorityCustomers || [];

  customers.slice(0, 5).forEach((c, idx) => {
    const type = c.relationshipStatus === 'INACTIVE'
      ? 'REACTIVATE_CUSTOMER'
      : c.relationshipStatus === 'REBUY_OPPORTUNITY'
        ? 'SEND_PRODUCT'
        : 'FOLLOW_UP';
    const verb = type === 'REACTIVATE_CUSTOMER'
      ? 'Reativar'
      : type === 'SEND_PRODUCT'
        ? 'Enviar sugestao para'
        : 'Fazer follow-up com';
    tasks.push({
      title: `${verb} ${c.customerName}`,
      description: c.nextAction
        ? `IA ST: ${c.nextAction}`
        : `IA ST: retomar contato com abordagem curta, entender necessidade e registrar o proximo passo.`,
      type,
      priority: c.priority || 'MEDIUM',
      customerId: c.customerId || null,
      customerName: c.customerName || null,
      dueDate: formatDateTime(addMinutes(baseDue, idx * 45)),
    });
  });

  if (snapshot.stats.tasksOpen < 3) {
    tasks.push({
      title: 'Registrar 3 atendimentos do turno',
      description: 'IA ST: depois de cada conversa, registrar resumo, resultado e proxima acao.',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      customerId: null,
      customerName: null,
      dueDate: formatDateTime(addMinutes(baseDue, 30)),
    });
  }

  if (!snapshot.weeklyInterview || snapshot.weeklyInterview.status !== 'SUBMITTED') {
    tasks.push({
      title: 'Atualizar entrevista semanal',
      description: 'IA ST: responder dificuldades, produtos pedidos e oportunidades vistas na loja.',
      type: 'FOLLOW_UP',
      priority: 'LOW',
      customerId: null,
      customerName: null,
      dueDate: formatDateTime(addMinutes(baseDue, 240)),
    });
  }

  return tasks.slice(0, 7);
}

function buildPlan(snapshot) {
  const topCustomer = snapshot.priorityCustomers[0];
  const firstAction = topCustomer
    ? `Comece por ${topCustomer.customerName}: ${topCustomer.nextAction || 'retomar contato e registrar resultado.'}`
    : 'Comece criando ou revisando sua carteira de clientes para o turno.';

  const focus = snapshot.focusProducts[0]
    ? `${snapshot.focusProducts[0].brand} ${snapshot.focusProducts[0].name}`.trim()
    : 'produto de maior giro da loja';

  return {
    headline: 'Plano de turno pronto',
    firstAction,
    focus,
    priorities: [
      `${snapshot.stats.customersDue} cliente(s) com acao vencendo hoje`,
      `${snapshot.stats.tasksOpen} tarefa(s) aberta(s)`,
      `${snapshot.stats.rebuyOpportunities} oportunidade(s) de recompra`,
    ],
    recommendedTasks: buildRecommendedTasks(snapshot),
  };
}

async function enrichAssignments(assignments) {
  const customerIds = [...new Set((assignments || []).map((c) => c.customerId).filter(Boolean))];
  if (!customerIds.length) return [];
  const [users, sellerClients] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        balance: true,
        sportsPractice: true,
        favBrands: true,
      },
    }),
    prisma.sellerClient.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        shoeSize: true,
        tags: true,
        totalSpent: true,
        purchaseCount: true,
      },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const sellerClientMap = new Map(sellerClients.map((c) => [c.id, c]));

  return assignments.map((a) => {
    const meta = customerDisplay(a.customerId, userMap, sellerClientMap);
    return {
      id: a.id,
      sellerId: a.sellerId,
      customerId: a.customerId,
      customerName: meta.name,
      customerPhone: meta.phone,
      customerEmail: meta.email,
      relationshipStatus: a.relationshipStatus,
      priority: a.priority,
      nextAction: a.nextAction,
      nextActionDate: formatDateTime(a.nextActionDate),
      potentialValue: a.potentialValue,
      notes: a.notes,
      rank: rankAssignment(a),
      source: meta.source,
    };
  });
}

async function loadSellerSnapshot(req) {
  const sellerId = resolveSellerId(req);
  if (!sellerId) {
    const err = new Error('sellerId obrigatorio');
    err.statusCode = 400;
    throw err;
  }

  const seller = await prisma.user.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      name: true,
      role: true,
      employeeCode: true,
      storeId: true,
      store: { select: { id: true, name: true, code: true, dna: true, city: true } },
    },
  });
  if (!seller) {
    const err = new Error('Vendedor nao encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (req.userRole === 'seller' && seller.id !== req.userId) {
    const err = new Error('Voce so pode acessar sua propria IA ST Vendedor');
    err.statusCode = 403;
    throw err;
  }
  if (req.scope?.isStoreLocked && seller.storeId && seller.storeId !== req.scope.storeId) {
    const err = new Error('Vendedor fora da loja vinculada');
    err.statusCode = 403;
    throw err;
  }

  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const since14 = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const now = new Date();

  const assignmentWhere = {
    sellerId,
    relationshipStatus: { not: 'LOST' },
  };

  const [
    assignmentRows,
    tasks,
    recentInteractions,
    openInsights,
    weeklyInterview,
    sales30,
    saleItems30,
    catalogSummary,
    featuredProducts,
    companyBrain,
  ] = await Promise.all([
    prisma.sellerCustomerAssignment.findMany({
      where: assignmentWhere,
      orderBy: [{ updatedAt: 'desc' }],
      take: 50,
    }),
    prisma.sellerTask.findMany({
      where: { sellerId, status: { in: ACTIVE_TASK_STATUS } },
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      take: 12,
    }),
    prisma.customerInteraction.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.sellerInsight.findMany({
      where: { sellerId, status: { in: ['OPEN', 'IN_REVIEW'] } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    }),
    prisma.sellerWeeklyInterview.findFirst({
      where: { sellerId },
      orderBy: { weekStartDate: 'desc' },
    }),
    prisma.sale.findMany({
      where: { sellerId, createdAt: { gte: since30 } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, totalAmount: true, createdAt: true },
    }),
    prisma.saleItem.findMany({
      where: { sale: { sellerId, createdAt: { gte: since30 } } },
      take: 100,
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            category: true,
            imageUrl: true,
            price: true,
            promoPrice: true,
          },
        },
      },
    }),
    listCatalogSummary().catch(() => null),
    prisma.product.findMany({
      where: { active: true, featured: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        imageUrl: true,
        price: true,
        promoPrice: true,
      },
    }),
    getBrain({ maxEvents: 20, eventDays: 30 }).catch(() => null),
  ]);

  const enrichedAssignments = await enrichAssignments(assignmentRows);
  const priorityCustomers = enrichedAssignments
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 10);

  const topSoldProducts = summarizeSaleItems(saleItems30);
  const focusProducts = topSoldProducts.length
    ? topSoldProducts.map((p) => ({
        id: p.productId,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        quantity: p.quantity,
        total: p.total,
      }))
    : featuredProducts.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        price: p.price,
        promoPrice: p.promoPrice,
      }));

  const salesTotal30 = sales30.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
  const salesCount14 = sales30.filter((s) => s.createdAt >= since14).length;

  const snapshot = {
    generatedAt: now.toISOString(),
    seller,
    stats: {
      totalCustomers: assignmentRows.length,
      customersDue: assignmentRows.filter((a) => a.nextActionDate && new Date(a.nextActionDate) <= now && a.relationshipStatus !== 'LOST').length,
      inactiveCustomers: assignmentRows.filter((a) => a.relationshipStatus === 'INACTIVE').length,
      rebuyOpportunities: assignmentRows.filter((a) => a.relationshipStatus === 'REBUY_OPPORTUNITY').length,
      tasksOpen: tasks.length,
      salesCount30: sales30.length,
      salesCount14,
      salesTotal30,
    },
    priorityCustomers,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      type: t.type,
      priority: t.priority,
      status: t.status,
      customerId: t.customerId,
      dueDate: formatDateTime(t.dueDate),
    })),
    recentInteractions: recentInteractions.map((i) => ({
      id: i.id,
      channel: i.channel,
      interactionType: i.interactionType,
      summary: i.summary,
      result: i.result,
      nextAction: i.nextAction,
      nextActionDate: formatDateTime(i.nextActionDate),
      createdAt: formatDateTime(i.createdAt),
    })),
    openInsights: openInsights.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      description: i.description,
      priority: i.priority,
    })),
    weeklyInterview: weeklyInterview
      ? {
          id: weeklyInterview.id,
          status: weeklyInterview.status,
          moodScore: weeklyInterview.moodScore,
          confidenceScore: weeklyInterview.confidenceScore,
          salesEnergyScore: weeklyInterview.salesEnergyScore,
          mainObjective: weeklyInterview.mainObjective,
          summary: weeklyInterview.summary,
          weekStartDate: formatDateTime(weeklyInterview.weekStartDate),
        }
      : null,
    focusProducts,
    catalogSummary,
    companyMemoryPrompt: companyBrain?.promptText ? String(companyBrain.promptText).slice(0, 5000) : null,
  };

  snapshot.plan = buildPlan(snapshot);
  return snapshot;
}

function compactSnapshotForPrompt(snapshot) {
  return {
    data: snapshot.generatedAt,
    vendedor: {
      nome: snapshot.seller.name,
      codigo: snapshot.seller.employeeCode,
      loja: snapshot.seller.store?.name || null,
      dna: snapshot.seller.store?.dna || null,
    },
    numeros: snapshot.stats,
    clientesPrioritarios: snapshot.priorityCustomers.slice(0, 8).map((c) => ({
      nome: c.customerName,
      status: c.relationshipStatus,
      prioridade: c.priority,
      proximaAcao: c.nextAction,
      data: c.nextActionDate,
      observacao: c.notes,
    })),
    tarefasAbertas: snapshot.tasks.slice(0, 8).map((t) => ({
      titulo: t.title,
      tipo: t.type,
      prioridade: t.priority,
      prazo: t.dueDate,
    })),
    sinaisDaLoja: snapshot.openInsights.slice(0, 5),
    produtosFoco: snapshot.focusProducts.slice(0, 5).map((p) => ({
      nome: p.name,
      marca: p.brand,
      categoria: p.category,
      qtdVendida30d: p.quantity,
    })),
    entrevista: snapshot.weeklyInterview,
    plano: snapshot.plan,
  };
}

function offlineCoachReply(message, snapshot) {
  const msg = message.toLowerCase();
  const first = snapshot.priorityCustomers[0];
  if (isInternalMessageIntent(message)) {
    return 'Eu posso enviar mensagem interna. Use o formato: "Mande mensagem para Nome dizendo Texto da mensagem".';
  }
  if (msg.includes('estoque') || msg.includes('tem ') || msg.includes('tamanho') || msg.includes('disponivel') || msg.includes('disponível')) {
    return 'Eu tenho acesso ao estoque das lojas. Me diga o produto ou modelo e, se quiser, o tamanho e a loja. Exemplo: "Nimbus 27 tamanho 41 em Tambia".';
  }
  if (isWebResearchIntent(message)) {
    return 'Eu consigo pesquisar produto na internet e salvar o aprendizado no produto. Me mande o nome, modelo ou SKU. Exemplo: "Pesquise na internet o Nimbus 27".';
  }
  if (isProductRecommendationIntent(message)) {
    return 'Eu consigo indicar produto usando catalogo, detalhes e estoque real. Me diga o perfil do cliente: modalidade, tamanho, faixa de preco e marca preferida.';
  }
  if (isLearningIntent(message)) {
    return 'Posso guardar aprendizados da loja. Escreva algo como: "Guarde: clientes estao pedindo mais tenis preto para caminhada".';
  }
  if (msg.includes('quem') || msg.includes('cliente') || msg.includes('cham')) {
    if (!first) return 'Hoje eu comecaria organizando sua carteira: selecione clientes com recompra, alto interesse ou atendimento recente sem retorno.';
    return `Eu comecaria por ${first.customerName}. Motivo: status ${first.relationshipStatus}, prioridade ${first.priority}. Proximo passo: ${first.nextAction || 'fazer contato curto, entender a necessidade e registrar o resultado.'}`;
  }
  if (msg.includes('tarefa') || msg.includes('plano')) {
    return `Seu plano tem ${snapshot.plan.recommendedTasks.length} tarefas sugeridas. Priorize clientes vencidos hoje, depois oportunidades de recompra e por ultimo registros pendentes.`;
  }
  return `${snapshot.plan.firstAction} Produto foco: ${snapshot.plan.focus}. Depois de cada atendimento, registre resumo e proxima acao para eu aprender com seu ritmo.`;
}

const TOOLS = [
  {
    name: 'search_products',
    description: 'Busca produtos ativos no catalogo Sports & Tennis. Use quando o vendedor pedir sugestao de produto, marca, categoria ou modelo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de busca, ex.: tenis corrida, Adidas, chuteira, mochila.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_catalog',
    description: 'Lista marcas e categorias presentes no catalogo atual.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_store_stock',
    description: 'Consulta estoque REAL por loja e tamanho usando StoreStock. Use sempre que o vendedor perguntar disponibilidade, estoque, tamanho, loja, tem ou nao tem, quantas unidades, onde tem, ou transferencia entre lojas. Nao mostra custo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Produto, marca, SKU, modelo ou codigo de barras. Ex.: Nimbus 27, Adidas, chuteira, 789...' },
        size: { type: 'string', description: 'Tamanho desejado, opcional. Ex.: 39, 40, G, M.' },
        store: { type: 'string', description: 'Loja desejada, opcional. Pode ser codigo LOJA06, Tambia, Bessa, Tambau etc.' },
        limit: { type: 'number', description: 'Quantidade maxima de produtos no retorno.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_product_details',
    description: 'Le todos os detalhes seguros de venda de um produto do sistema: descricao, features, recomendacoes, imagens, preco e estoque por loja. Nao retorna custo nem campos fiscais.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: 'ID do produto, se conhecido.' },
        sku: { type: 'string', description: 'SKU do produto, se conhecido.' },
        query: { type: 'string', description: 'Nome/modelo/marca/categoria quando nao souber o SKU.' },
        size: { type: 'string', description: 'Tamanho desejado, opcional.' },
        store: { type: 'string', description: 'Loja desejada, opcional.' },
      },
    },
  },
  {
    name: 'recommend_products',
    description: 'Indica produtos para uma necessidade de cliente usando catalogo, detalhes do sistema e estoque real por loja. Use antes de sugerir produto ao vendedor.',
    input_schema: {
      type: 'object',
      properties: {
        need: { type: 'string', description: 'Necessidade do cliente ou contexto da venda.' },
        budget: { type: 'number', description: 'Orcamento maximo, se houver.' },
        size: { type: 'string', description: 'Tamanho desejado, se houver.' },
        store: { type: 'string', description: 'Loja desejada, opcional.' },
        limit: { type: 'number', description: 'Quantidade maxima de recomendacoes.' },
      },
      required: ['need'],
    },
  },
  {
    name: 'research_product_web',
    description: 'Pesquisa um produto do sistema na internet, resume argumentos de venda e salva o aprendizado em Product.aiContext.sellerAgentResearch e CompanyMemory. Use quando faltar detalhe, ficha tecnica, comparacao ou argumento.',
    input_schema: {
      type: 'object',
      properties: {
        productId: { type: 'string' },
        sku: { type: 'string' },
        query: { type: 'string', description: 'Produto/modelo do sistema a pesquisar.' },
        webQuery: { type: 'string', description: 'Consulta web opcional.' },
        force: { type: 'boolean', description: 'Ignora cache e pesquisa novamente.' },
      },
    },
  },
  {
    name: 'save_seller_learning',
    description: 'Salva um aprendizado ou feedback dito pelo vendedor na memoria persistente da empresa para melhorar respostas futuras.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        detail: { type: 'string' },
        category: { type: 'string' },
        importance: { type: 'number' },
        productId: { type: 'string' },
      },
      required: ['detail'],
    },
  },
];

async function execTool(name, input, snapshot) {
  if (name === 'search_products') return searchProductsForAI(input?.query);
  if (name === 'list_catalog') return listCatalogSummary();
  if (name === 'search_store_stock') return searchStoreStockForAgent(input, snapshot);
  if (name === 'get_product_details') return getProductDetailsForAgent(input, snapshot);
  if (name === 'recommend_products') return recommendProductsForAgent(input, snapshot);
  if (name === 'research_product_web') return researchProductWebForAgent(input, snapshot);
  if (name === 'save_seller_learning') return saveSellerLearningForAgent(input, snapshot);
  return { error: 'Tool desconhecida' };
}

function buildSystemPrompt(snapshot) {
  return `Voce e a IA ST Vendedor da Sports & Tennis dentro do TenisCash.

Missao: ajudar o vendedor logado a vender melhor hoje, organizar tarefas, priorizar clientes, preparar abordagem, lidar com objecoes e registrar proximos passos.

Regras:
- Responda em portugues brasileiro, direto e pratico.
- Use apenas os dados do contexto e das tools. Nao invente cliente, estoque, preco, desconto, meta ou produto.
- Voce TEM acesso ao estoque real das lojas via search_store_stock. Se o vendedor perguntar estoque, disponibilidade, tamanho, "tem?", "onde tem?", "quantas unidades?", use search_store_stock antes de responder.
- Ao responder estoque, diga loja, tamanho e quantidade. Se nao localizar, diga que nao localizou estoque registrado para aquele filtro, sem mandar o vendedor procurar outro sistema.
- Para indicar produto, use recommend_products. Para falar de um produto especifico, use get_product_details antes de responder.
- Se faltar informacao tecnica, comparacao, argumento de venda ou o vendedor pedir internet/web/Google, use research_product_web. Essa tool salva o aprendizado no produto e na memoria da empresa.
- Quando o vendedor trouxer aprendizado de loja, objecao, pedido de cliente ou insight, use save_seller_learning para guardar.
- Voce tambem pode enviar mensagem interna pelo TenisCash quando o texto vier em formato claro: "Mande mensagem para Nome dizendo Texto". Esse envio e tratado pelo sistema antes da IA responder.
- O vendedor continua no controle. Para criar tarefas, oriente a usar o botao "Criar tarefas" quando a sugestao ja existir no plano.
- Nao envie WhatsApp de verdade, nao aprove desconto e nao prometa condicao comercial sem confirmacao da loja.
- Se o vendedor pedir produto sem falar de estoque, use recommend_products antes de recomendar; use search_products apenas para busca simples/listagem.
- Diga no maximo 180 palavras. Nada de texto motivacional generico.

Memoria persistente carregada:
${snapshot.companyMemoryPrompt || '(sem memoria carregada)'}

Contexto do vendedor:
${JSON.stringify(compactSnapshotForPrompt(snapshot), null, 2)}`;
}

router.get('/today', requireSeller, async (req, res) => {
  try {
    const snapshot = await loadSellerSnapshot(req);
    res.json({
      seller: snapshot.seller,
      stats: snapshot.stats,
      priorityCustomers: snapshot.priorityCustomers,
      tasks: snapshot.tasks,
      recentInteractions: snapshot.recentInteractions,
      openInsights: snapshot.openInsights,
      weeklyInterview: snapshot.weeklyInterview,
      focusProducts: snapshot.focusProducts,
      plan: snapshot.plan,
    });
  } catch (err) {
    console.error('[seller/agent/today] erro:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao carregar IA ST Vendedor' });
  }
});

router.post('/tasks/apply', requireSeller, async (req, res) => {
  try {
    const sellerId = resolveSellerId(req);
    if (req.userRole === 'seller' && sellerId !== req.userId) {
      return res.status(403).json({ error: 'Voce so pode criar tarefas para voce' });
    }

    const rawTasks = Array.isArray(req.body?.tasks) ? req.body.tasks.slice(0, 10) : [];
    if (!rawTasks.length) return res.status(400).json({ error: 'Nenhuma tarefa enviada' });

    const seller = await prisma.user.findUnique({
      where: { id: sellerId },
      select: { id: true, storeId: true },
    });
    if (!seller) return res.status(404).json({ error: 'Vendedor nao encontrado' });

    const created = [];
    const skipped = [];

    for (const raw of rawTasks) {
      const title = safeText(raw.title, 120);
      const type = safeText(raw.type, 40);
      if (!title || !ALLOWED_TASK_TYPES.has(type)) {
        skipped.push({ title: title || '(sem titulo)', reason: 'tipo invalido' });
        continue;
      }
      const customerId = raw.customerId ? String(raw.customerId) : null;
      const duplicate = await prisma.sellerTask.findFirst({
        where: {
          sellerId,
          customerId,
          title,
          status: { in: ACTIVE_TASK_STATUS },
          createdAt: { gte: startOfDay() },
        },
        select: { id: true },
      });
      if (duplicate) {
        skipped.push({ title, reason: 'ja existe hoje' });
        continue;
      }
      const task = await prisma.sellerTask.create({
        data: {
          sellerId,
          customerId,
          storeId: raw.storeId || seller.storeId || null,
          title,
          description: safeText(raw.description, 500) || null,
          type,
          priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(raw.priority) ? raw.priority : 'MEDIUM',
          dueDate: raw.dueDate ? new Date(raw.dueDate) : null,
          status: 'TODO',
        },
      });
      created.push(task);
    }

    res.json({ created, skipped });
  } catch (err) {
    console.error('[seller/agent/tasks/apply] erro:', err);
    res.status(500).json({ error: 'Erro ao criar tarefas', detail: err.message });
  }
});

router.post('/chat', requireSeller, chatLimiter, async (req, res) => {
  try {
    const text = safeText(req.body?.message, 1200);
    if (!text) return res.status(400).json({ error: 'Mensagem obrigatoria' });

    const snapshot = await loadSellerSnapshot(req);
    if (isInternalMessageIntent(text)) {
      const messageResult = await handleInternalMessageIntent(req, text);
      const conversationId = await persistSellerAgentTurn(req, text, messageResult.reply, { intent: 'internal_message' });
      return res.json({
        conversationId,
        reply: messageResult.reply,
        suggestions: messageResult.suggestions,
        message: messageResult.message || null,
      });
    }

    if (isStockIntent(text)) {
      const stockInput = await parseStockInputFromText(text);
      if (!stockInput.query) {
        const reply = isStockSizeDisplayComplaint(text) ? stockSizeDisplayHelpReply() : stockNeedsProductReply();
        const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'stock_help' });
        return res.json({
          conversationId,
          reply,
          suggestions: ['Consultar Nimbus 27 tamanho 41', 'Consultar bolsa yoga tote', 'Buscar em uma loja especifica'],
          stock: null,
        });
      }
      const stockResult = await searchStoreStockForAgent(stockInput, snapshot);
      const reply = formatStockReply(stockResult);
      const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'stock_lookup', stock: stockResult });
      return res.json({
        conversationId,
        reply,
        suggestions: ['Ver outro tamanho', 'Buscar em uma loja especifica', 'Montar abordagem com esse produto'],
        stock: stockResult,
      });
    }

    if (isWebResearchIntent(text)) {
      const researchInput = {
        query: cleanProductNeed(text) || text,
        webQuery: text,
        force: /\b(novo|nova|atualiza|atualizar|refaz|refaca|refaça|de novo)\b/i.test(text),
      };
      const researchResult = await researchProductWebForAgent(researchInput, snapshot);
      const reply = formatResearchReply(researchResult);
      const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'product_research', productId: researchResult.product?.id || null });
      return res.json({
        conversationId,
        reply,
        suggestions: ['Indique esse produto para cliente', 'Ver estoque desse produto', 'Pesquisar outro produto na internet'],
        research: researchResult,
      });
    }

    if (isProductRecommendationIntent(text)) {
      const recommendation = await recommendProductsForAgent({ need: text, limit: 5 }, snapshot);
      const reply = formatRecommendationReply(recommendation);
      const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'product_recommendation', productIds: recommendation.products?.map((p) => p.id) || [] });
      return res.json({
        conversationId,
        reply,
        suggestions: ['Pesquisar esse produto na internet', 'Ver estoque do primeiro produto', 'Montar abordagem para cliente'],
        recommendation,
      });
    }

    if (isLearningIntent(text)) {
      const saved = await saveSellerLearningForAgent({ detail: text, title: text.slice(0, 120), importance: 2 }, snapshot);
      const reply = saved.saved
        ? 'Salvei esse aprendizado na memoria da empresa. Vou considerar isso nas proximas recomendacoes e respostas da IA ST Vendedor.'
        : saved.message;
      const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'seller_learning', memoryId: saved.memoryId || null });
      return res.json({
        conversationId,
        reply,
        suggestions: ['Indicar produto com esse aprendizado', 'Montar tarefa de venda', 'Pesquisar produto na internet'],
        learning: saved,
      });
    }

    const client = anthropicClient();
    if (!client) {
      const reply = offlineCoachReply(text, snapshot);
      const conversationId = await persistSellerAgentTurn(req, text, reply, { intent: 'offline_reply' });
      return res.json({
        conversationId,
        reply,
        suggestions: ['Quem eu chamo primeiro?', 'Crie um plano curto', 'Como responder objecao de preco?'],
        offline: true,
      });
    }

    let conv = null;
    const conversationId = String(req.body?.conversationId || '').trim();
    if (conversationId) {
      conv = await prisma.aIConversation.findFirst({
        where: { id: conversationId, userId: req.userId, active: true },
      });
      if (!conv) return res.status(404).json({ error: 'Conversa nao encontrada' });
    } else {
      conv = await prisma.aIConversation.create({
        data: {
          userId: req.userId,
          userType: 'seller-agent',
          title: `IA ST Vendedor: ${text.slice(0, 55)}`,
        },
      });
    }

    let msgs = parseMessages(conv.messages);
    msgs.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: { messages: msgs, updatedAt: new Date() },
    });

    const anthropicMessages = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-18)
      .map((m) => ({ role: m.role, content: m.content }));

    const model = process.env.SELLER_AGENT_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
    const maxTokens = parseInt(process.env.SELLER_AGENT_MAX_TOKENS || '700', 10);
    const system = buildSystemPrompt(snapshot);

    let currentMessages = anthropicMessages.map((m) => ({ ...m }));
    let finalText = '';
    let totalIn = 0;
    let totalOut = 0;
    let turn = 0;

    while (turn < 6) {
      turn += 1;
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: TOOLS,
        messages: currentMessages,
      });

      totalIn += resp.usage?.input_tokens || 0;
      totalOut += resp.usage?.output_tokens || 0;

      if (resp.stop_reason === 'tool_use') {
        currentMessages.push({ role: 'assistant', content: resp.content });
        const toolResults = [];
        for (const block of resp.content || []) {
          if (block.type !== 'tool_use') continue;
          const out = await execTool(block.name, block.input, snapshot);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out),
          });
        }
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      finalText = (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    if (!finalText) finalText = offlineCoachReply(text, snapshot);

    const fresh = await prisma.aIConversation.findUnique({
      where: { id: conv.id },
      select: { messages: true },
    });
    msgs = parseMessages(fresh.messages);
    msgs.push({ role: 'assistant', content: finalText, timestamp: new Date().toISOString() });

    const cost = buildCostBRL({ input_tokens: totalIn, output_tokens: totalOut });
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: {
        messages: msgs,
        totalTokensIn: { increment: totalIn },
        totalTokensOut: { increment: totalOut },
        totalCostBRL: { increment: cost.brl },
        updatedAt: new Date(),
      },
    });

    res.json({
      conversationId: conv.id,
      reply: finalText,
      suggestions: ['Indique produto para cliente', 'Pesquisar produto na internet', 'Ver estoque por loja'],
    });
  } catch (err) {
    console.error('[seller/agent/chat] erro:', err);
    res.status(500).json({ error: 'Erro ao conversar com a IA ST Vendedor. Tente novamente.' });
  }
});

module.exports = router;
