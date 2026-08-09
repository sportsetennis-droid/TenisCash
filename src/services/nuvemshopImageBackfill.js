const { prisma } = require('../middleware');
const ns = require('./nuvemshop');
const nsHandlers = require('./nuvemshopHandlers');

function usableImageUrls(remoteProduct) {
  const seen = new Set();
  const urls = [];
  for (const image of Array.isArray(remoteProduct?.images) ? remoteProduct.images : []) {
    const url = String(image?.src || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function backfillLocalImagesFromNuvemshop(options = {}) {
  const connection = options.connection || await nsHandlers.getConnection();
  if (!connection) throw new Error('Nuvemshop não conectada');

  const mappings = await prisma.nuvemshopProductMapping.findMany({
    select: { localProductId: true, nuvemshopProductId: true },
  });
  const mappingByLocalId = new Map(
    mappings.map((row) => [row.localProductId, String(row.nuvemshopProductId)]),
  );
  const limit = Math.min(Math.max(Number(options.limit) || 5000, 1), 10000);
  const candidates = await prisma.product.findMany({
    where: {
      active: true,
      id: { in: [...mappingByLocalId.keys()] },
      OR: [{ imageUrl: null }, { imageUrl: '' }],
    },
    take: limit,
    select: { id: true, sku: true, aiContext: true },
  });

  const remoteProducts = Array.isArray(options.remoteProducts)
    ? options.remoteProducts
    : await ns.fetchAllPages(connection, '/products', { perPage: 100, max: 10000 });
  const remoteById = new Map(
    remoteProducts
      .filter((product) => product?.id != null)
      .map((product) => [String(product.id), product]),
  );

  let recovered = 0;
  let noRemoteImage = 0;
  const errors = [];
  for (const product of candidates) {
    const remoteId = mappingByLocalId.get(product.id);
    const urls = usableImageUrls(remoteById.get(remoteId));
    if (!urls.length) {
      noRemoteImage++;
      continue;
    }
    let context = {};
    try {
      context = (typeof product.aiContext === 'string'
        ? JSON.parse(product.aiContext)
        : product.aiContext) || {};
    } catch (_) {}
    context.imageSource = 'nuvemshop_backfill';
    context.imageRecoveredAt = new Date().toISOString();
    // A imagem já está no destino remoto: evita que a reconciliação apague e
    // reenvie o mesmo arquivo CDN desnecessariamente.
    context.nsImagesSig = nsHandlers.imageSignature(urls.slice(0, 8));
    try {
      // updateMany preserva uma imagem que possa ter sido escolhida enquanto a
      // reconciliação estava rodando.
      const result = await prisma.product.updateMany({
        where: { id: product.id, OR: [{ imageUrl: null }, { imageUrl: '' }] },
        data: {
          imageUrl: urls[0],
          imageUrls: urls.slice(1, 8),
          aiContext: context,
        },
      });
      recovered += result.count;
    } catch (error) {
      errors.push({ productId: product.id, sku: product.sku, error: error.message });
    }
  }

  return {
    candidates: candidates.length,
    recovered,
    noRemoteImage,
    errors: errors.slice(0, 50),
  };
}

module.exports = { backfillLocalImagesFromNuvemshop, usableImageUrls };
