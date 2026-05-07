const { prisma } = require('../middleware');

const productCardSelect = {
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
  sizes: {
    where: { stock: { gt: 0 } },
    select: { size: true, stock: true },
  },
};

function formatProductCard(p) {
  const sizes = (p.sizes || []).map((s) => ({ size: s.size, stock: s.stock }));
  return {
    id: p.id,
    sku: p.sku,
    name: p.name,
    brand: p.brand,
    category: p.category,
    subcategory: p.subcategory,
    shortDescription: p.shortDescription,
    price: p.price,
    promoPrice: p.promoPrice,
    imageUrl: p.imageUrl,
    featured: p.featured,
    sizes,
  };
}

async function searchProductsForAI(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { products: [], message: 'Use pelo menos 2 caracteres na busca.' };

  const products = await prisma.product.findMany({
    where: {
      active: true,
      sizes: { some: { stock: { gt: 0 } } },
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { category: { contains: q, mode: 'insensitive' } },
      ],
    },
    take: 15,
    orderBy: [{ featured: 'desc' }, { name: 'asc' }],
    select: productCardSelect,
  });

  return { products: products.map(formatProductCard) };
}

async function getProductBySkuForAI(sku) {
  const s = String(sku || '').trim();
  if (!s) return { error: 'SKU obrigatório' };

  const p = await prisma.product.findFirst({
    where: {
      sku: { equals: s, mode: 'insensitive' },
      active: true,
    },
    select: {
      ...productCardSelect,
      longDescription: true,
      features: true,
      recommendedFor: true,
      notRecommendedFor: true,
      imageUrls: true,
    },
  });

  if (!p) return { error: 'Produto não encontrado ou inativo' };

  const withStock = {
    ...p,
    sizes: (p.sizes || []).filter((x) => x.stock > 0),
  };
  if (!withStock.sizes.length) return { error: 'Produto sem estoque disponível' };

  return { product: formatProductCard(withStock), detail: withStock };
}

module.exports = {
  searchProductsForAI,
  getProductBySkuForAI,
  formatProductCard,
  productCardSelect,
};
