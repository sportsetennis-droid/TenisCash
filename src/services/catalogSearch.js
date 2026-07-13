const { prisma } = require('../middleware');

// ---------------------------------------------------------------------
// LINK do produto — "pega o card e vira link" (pedido do dono).
// Usa a PDP publica do PROPRIO TenisCash (/p/:id, src/index.js): cobre 100%
// dos produtos (nao so os ~3% publicados na loja online), mostra fotos, preco
// e ESTOQUE POR LOJA, e ja roda em prod. teniscash.com.br/p/<id> -> sempre 200.
// ---------------------------------------------------------------------
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
const STORE_BASE = (process.env.STORE_PUBLIC_URL || 'https://www.sportsetennis.com.br').replace(/\/+$/, '');

function resolveProductLink(localProductId, name, prefix = '/p/') {
  if (localProductId) return `${PUBLIC_BASE}${prefix}${localProductId}`;
  // fallback raro (produto sem id): leva pra busca da loja online
  return `${STORE_BASE}/?q=${encodeURIComponent(String(name || '').trim())}`;
}

const baseProductSelect = {
  id: true,
  sku: true,
  name: true,
  brand: true,
  category: true,
  subcategory: true,
  shortDescription: true,
  price: true,
  promoPrice: true,
  imageUrl: true,
  featured: true,
  active: true,
  sizes: {
    select: {
      id: true,
      size: true,
      stock: true,
      barcode: true,
      storeStocks: { select: { stock: true, store: { select: { name: true, code: true, neighborhood: true } } } },
    },
  },
};

function formatProductCard(p) {
  // Mantém storeStocks se vierem incluídos (PCard usa)
  const sizes = (p.sizes || []).map((s) => ({
    id: s.id,
    size: s.size,
    stock: s.stock,
    barcode: s.barcode || null,
    ...(s.storeStocks ? { storeStocks: s.storeStocks } : {}),
  }));
  const availableSizes = sizes.filter((s) => (s.stock || 0) > 0);
  const stockTotal = sizes.reduce((acc, s) => acc + (s.stock || 0), 0);
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    subcategory: p.subcategory,
    shortDescription: p.shortDescription,
    longDescription: p.longDescription || null,
    price: p.price,
    promoPrice: p.promoPrice,
    imageUrl: p.imageUrl,
    imageUrls: p.imageUrls || null,
    aiContext: p.aiContext || null,
    featured: p.featured,
    sizes,
    availableSizes,
    stockTotal,
    inStock: stockTotal > 0,
  };
}

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

// Palavras genéricas de linguagem natural que NÃO são termo de produto/marca.
// (evita "quero"/"um" virar filtro; "um" batia em pUMa/UMbro/rhUMell por substring)
const STOP_WORDS = new Set([
  'quero', 'queria', 'preciso', 'busco', 'procuro', 'gostaria', 'me', 'um', 'uma', 'uns', 'umas',
  'de', 'do', 'da', 'dos', 'das', 'para', 'pra', 'pro', 'por', 'com', 'sem', 'que', 'os', 'as',
  'meu', 'minha', 'mais', 'muito', 'bem', 'tipo', 'algum', 'alguma', 'qualquer', 'ao', 'no', 'na',
]);
// tokens úteis: ≥3 letras e fora da lista de stopwords (mantém "tenis", "confortavel", modelos, etc.)
function significantTokens(q) {
  return tokenize(q).filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

async function detectBrandsInQuery(rawQuery) {
  const tokens = significantTokens(rawQuery);
  if (!tokens.length) return [];
  const brandsRows = await prisma.product.findMany({
    where: { active: true },
    distinct: ['brand'],
    select: { brand: true },
  });
  const brands = brandsRows.map((b) => b.brand).filter(Boolean);
  // casa por PALAVRA da marca (não por substring solto): token == palavra da marca,
  // ou token grande (≥4) contido na marca. Assim "nike"/"puma" batem, "um" não.
  return brands.filter((br) => {
    const bl = br.toLowerCase();
    const bwords = bl.split(/\s+/);
    return tokens.some((t) => bwords.includes(t) || (t.length >= 4 && bl.includes(t)));
  });
}

async function searchProductsForAI(query) {
  const q = String(query || '').trim();
  console.log('[ai] tool search_products called with query:', JSON.stringify(q));
  if (q.length < 2) {
    const out = { products: [], message: 'Use pelo menos 2 caracteres na busca.' };
    console.log('[ai] tool search_products short-query, returning empty');
    return out;
  }

  const matchedBrands = await detectBrandsInQuery(q);
  console.log('[ai] tool search_products matchedBrands:', matchedBrands);

  const orderBy = [{ featured: 'desc' }, { name: 'asc' }];
  const fields = ['name', 'sku', 'category', 'subcategory', 'shortDescription', 'longDescription'];
  const anyFieldContains = (term) => ({ OR: fields.map((f) => ({ [f]: { contains: term, mode: 'insensitive' } })) });
  // busca um pool maior (take 80) e RE-RANQUEIA por relevância abaixo (nome/categoria > descrição).
  const run = (where) => prisma.product.findMany({ where, take: 80, orderBy, select: baseProductSelect });
  // pontua o produto: match no NOME/categoria pesa muito mais que na descrição; + estoque.
  const queryToks = significantTokens(q);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const rankScore = (p) => {
    const nome = norm(p.name) + ' ' + norm(p.category) + ' ' + norm(p.subcategory) + ' ' + norm(p.brand);
    const desc = norm(p.shortDescription) + ' ' + norm(p.longDescription);
    let s = 0;
    for (const t of queryToks) {
      if (nome.includes(t)) s += 10; else if (desc.includes(t)) s += 1;
    }
    if (p.featured) s += 2;
    if ((p.sizes || []).some((z) => (z.storeStocks || []).some((ss) => (ss.stock || 0) > 0))) s += 3;
    return s;
  };
  const rerank = (arr) => arr.slice().sort((a, b) => rankScore(b) - rankScore(a) || String(a.name).localeCompare(String(b.name))).slice(0, 25);

  let rows = [];
  if (matchedBrands.length) {
    const brandOR = matchedBrands.map((br) => ({ brand: { equals: br, mode: 'insensitive' } }));
    // termos da query que NAO sao o nome da marca (ex.: "sparta" em "kappa sparta")
    const restTokens = significantTokens(q).filter(
      (t) => !matchedBrands.some((br) => br.toLowerCase().includes(t) || t.includes(br.toLowerCase())),
    );
    if (restTokens.length) {
      // marca + modelo: refina por marca E pelos termos restantes (acha o modelo certo)
      rows = await run({ active: true, AND: [{ OR: brandOR }, { OR: restTokens.map(anyFieldContains) }] });
    }
    // sem termos extras, ou refino vazio -> todos da marca (nunca nega produto que existe)
    if (!rows.length) rows = await run({ active: true, OR: brandOR });
  } else {
    // SEM marca: procura por TOKENS úteis (ex.: "tenis", "confortavel"), não a frase inteira.
    const toks = significantTokens(q);
    const terms = toks.length ? toks : [q];
    // 1º PASSO — só campos FORTES (nome/categoria/subcategoria/marca): tira ruído de descrição
    // (ex.: "tenis" não traz joelheira que só tem "tênis" no texto de marketing).
    const strong = ['name', 'category', 'subcategory', 'brand'];
    const strongContains = (t) => ({ OR: strong.map((f) => ({ [f]: { contains: t, mode: 'insensitive' } })) });
    rows = await run({ active: true, OR: terms.map(strongContains) });
    // 2º PASSO — se veio pouco, completa com match em descrição também.
    if (rows.length < 8) {
      const more = await run({ active: true, OR: terms.map(anyFieldContains) });
      const seen = new Set(rows.map((r) => r.id));
      rows = rows.concat(more.filter((m) => !seen.has(m.id)));
    }
  }

  const products = rerank(rows).map(formatProductCard);

  console.log('[ai] tool search_products returning:', products.length, 'products');

  if (!products.length) {
    const fallback = await listCatalogSummary();
    return {
      products: [],
      message: 'Nenhum produto encontrado para "' + q + '".',
      catalog: fallback,
    };
  }

  const inStockCount = products.filter((p) => p.inStock).length;
  return {
    products,
    note:
      inStockCount === 0
        ? 'Nenhum tamanho cadastrado tem estoque > 0 (estoque pode não estar sincronizado), mas estes produtos ESTÃO no catálogo da Sports & Tennis. Pode recomendar.'
        : null,
  };
}

async function getProductBySkuForAI(sku) {
  const s = String(sku || '').trim();
  console.log('[ai] tool get_product called with sku:', JSON.stringify(s));
  if (!s) return { error: 'SKU obrigatório' };

  const p = await prisma.product.findFirst({
    where: {
      sku: { equals: s, mode: 'insensitive' },
      active: true,
    },
    select: {
      ...baseProductSelect,
      longDescription: true,
      features: true,
      recommendedFor: true,
      notRecommendedFor: true,
      imageUrls: true,
    },
  });

  if (!p) {
    console.log('[ai] tool get_product not found for sku:', s);
    return { error: 'Produto não encontrado ou inativo' };
  }

  const card = formatProductCard(p);
  console.log('[ai] tool get_product found:', p.sku, '/ inStock=', card.inStock);
  return {
    product: card,
    longDescription: p.longDescription,
    features: p.features,
    recommendedFor: p.recommendedFor,
    notRecommendedFor: p.notRecommendedFor,
  };
}

async function listCatalogSummary() {
  const [byBrand, byCategory, totalActive] = await Promise.all([
    prisma.product.groupBy({
      by: ['brand'],
      where: { active: true },
      _count: { brand: true },
      orderBy: { _count: { brand: 'desc' } },
      take: 30,
    }),
    prisma.product.groupBy({
      by: ['category'],
      where: { active: true },
      _count: { category: true },
      orderBy: { _count: { category: 'desc' } },
      take: 30,
    }),
    prisma.product.count({ where: { active: true } }),
  ]);
  return {
    totalActiveProducts: totalActive,
    brands: byBrand.map((b) => ({ brand: b.brand, count: b._count?.brand || 0 })),
    categories: byCategory.map((c) => ({ category: c.category, count: c._count?.category || 0 })),
  };
}

module.exports = {
  searchProductsForAI,
  getProductBySkuForAI,
  listCatalogSummary,
  formatProductCard,
  resolveProductLink,
};
