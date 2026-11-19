const { prisma } = require('../middleware');
const ns = require('./nuvemshop');
const nsHandlers = require('./nuvemshopHandlers');
const { mergeAiContext } = require('./aiContextMerge');

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

// Foto tirada de propósito do card (aiContext.fotosRemovidas: era de outra cor/outro código ou link
// quebrado) NÃO volta da loja online: a loja ainda tem a foto errada e a recuperação a devolvia ao card
// (auditoria 19/11: Top Minimal Glow Rose voltou com fotos Nude/Marsala/Rosa 3 min depois). Sem foto
// certa, o card fica sem foto e a trava tira o produto do site até a foto certa chegar.
function contextoDe(product) {
  try {
    return (typeof product?.aiContext === 'string' ? JSON.parse(product.aiContext) : product?.aiContext) || {};
  } catch (_) { return {}; }
}
function fotoFoiRemovidaDePropósito(product) {
  const r = contextoDe(product).fotosRemovidas;
  return !!(r && typeof r === 'object' && (r.em || r.motivo));
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
  let skippedRemovidas = 0;
  const errors = [];
  for (const product of candidates) {
    if (fotoFoiRemovidaDePropósito(product)) { skippedRemovidas++; continue; }
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
    context.nsImagesSig = nsHandlers.imageSignature(urls.slice(0, 5)); // no máximo 5 fotos (regra do dono)
    try {
      // updateMany preserva uma imagem que possa ter sido escolhida enquanto a
      // reconciliação estava rodando.
      const result = await prisma.product.updateMany({
        where: { id: product.id, OR: [{ imageUrl: null }, { imageUrl: '' }] },
        data: {
          imageUrl: urls[0],
          imageUrls: urls.slice(1, 5),
        },
      });
      // contexto: só as chaves desta recuperação, de forma atômica (não desfaz edição do dono)
      if (result.count) await mergeAiContext(prisma, product.id, { imageSource: context.imageSource, imageRecoveredAt: context.imageRecoveredAt, nsImagesSig: context.nsImagesSig });
      recovered += result.count;
    } catch (error) {
      errors.push({ productId: product.id, sku: product.sku, error: error.message });
    }
  }

  return {
    candidates: candidates.length,
    recovered,
    noRemoteImage,
    skippedRemovidas,
    errors: errors.slice(0, 50),
  };
}

module.exports = { backfillLocalImagesFromNuvemshop, usableImageUrls, fotoFoiRemovidaDePropósito };
