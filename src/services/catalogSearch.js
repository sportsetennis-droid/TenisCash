const { prisma } = require('../middleware');

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
  sizes: { select: { size: true, stock: true } },
};

function formatProductCard(p) {
  // Mantém storeStocks se vierem incluídos (PCard usa)
  const sizes = (p.sizes || []).map((s) => ({
    size: s.size,
    stock: s.stock,
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

async function detectBrandsInQuery(rawQuery) {
  const tokens = tokenize(rawQuery);
  if (!tokens.length) return [];
  const brandsRows = await prisma.product.findMany({
    where: { active: true },
    distinct: ['brand'],
    select: { brand: true },
  });
  const brands = brandsRows.map((b) => b.brand).filter(Boolean);
  return brands.filter((br) => tokens.some((t) => br.toLowerCase().includes(t) || t.includes(br.toLowerCase())));
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

  let where;
  if (matchedBrands.length) {
    where = {
      active: true,
      OR: matchedBrands.map((br) => ({ brand: { equals: br, mode: 'insensitive' } })),
    };
  } else {
    where = {
      active: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
        { subcategory: { contains: q, mode: 'insensitive' } },
        { shortDescription: { contains: q, mode: 'insensitive' } },
        { longDescription: { contains: q, mode: 'insensitive' } },
      ],
    };
  }

  const rows = await prisma.product.findMany({
    where,
    take: 25,
    orderBy: [{ featured: 'desc' }, { name: 'asc' }],
    select: baseProductSelect,
  });

  const products = rows.map(formatProductCard);

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
};
