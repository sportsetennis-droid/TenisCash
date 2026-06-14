// =====================================================================
// TikTok Shop Sync — sobe produto do TenisCash pro TikTok Shop
// =====================================================================
// Espelha src/services/nuvemshopHandlers.js (pushProductToNuvemshop),
// respeitando as MESMAS regras inquebráveis do catálogo:
//   - 4 classificações (Categoria + Sub + Modalidade + Especialidade)
//   - ESTOQUE = Σ StoreStock de TODAS as lojas (físico/localizado), NÃO o comprado
//   - só sobe TAMANHO com estoque > 0; sem nenhum disponível, não publica
//   - PREÇO de venda com markup; nunca o custo. price <= custo ou price 0 → não sobe
//
// ⚠️ DADOS QUE A API DO TIKTOK EXIGE E QUE NÃO PODEM SER CHUTADOS
// (regra "NUNCA INVENTAR" — se faltar, o push PULA com motivo, não adivinha):
//   - category_id  → nó folha da árvore de categorias do TikTok (GET /product/202309/categories).
//                    Resolvido por produto em aiContext.tiktokMapping.categoryId.
//   - warehouse_id → depósito do seller (GET /logistics/202309/warehouses).
//                    Default em TIKTOK_DEFAULT_WAREHOUSE_ID ou aiContext.tiktokMapping.warehouseId.
//   - package_weight → peso do pacote. Sem peso real no schema; default
//                    TIKTOK_DEFAULT_WEIGHT_KG (só se o dono definir). Não inventa.
//   - main_images  → imagens precisam ser hospedadas no CDN do TikTok primeiro
//                    (uploadImageToTikTok). URLs externas não entram direto.
// =====================================================================

const { prisma } = require('../middleware');
const tt = require('./tiktokShop');

const CURRENCY = process.env.TIKTOK_CURRENCY || 'BRL';
const DEFAULT_WAREHOUSE = process.env.TIKTOK_DEFAULT_WAREHOUSE_ID || null;
const DEFAULT_WEIGHT_KG = process.env.TIKTOK_DEFAULT_WEIGHT_KG || null; // string, ex "0.8"

async function getConnection() {
  return prisma.tikTokShopConnection.findFirst({ where: { status: 'active' } });
}

function ctxOf(product) {
  try {
    if (!product.aiContext) return {};
    return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
  } catch (_) { return {}; }
}

// Coleta imagens locais (mesma lógica do Nuvemshop): imageUrl + imageUrls[].
function collectLocalImages(product) {
  const out = [];
  if (product.imageUrl) out.push(product.imageUrl);
  if (product.imageUrls) {
    try {
      const arr = typeof product.imageUrls === 'string' ? JSON.parse(product.imageUrls) : product.imageUrls;
      if (Array.isArray(arr)) arr.forEach((u) => { if (u && !out.includes(u)) out.push(u); });
    } catch (_) {}
  }
  return out;
}

// Hospeda uma imagem (por URL) no CDN do TikTok e devolve o uri.
// O TikTok aceita upload por arquivo binário; aqui baixamos a URL e enviamos.
async function uploadImageToTikTok(connection, imageUrl) {
  // POST /product/202309/images/upload — multipart. O sign PULA o body em multipart,
  // então não dá pra usar tiktokApi (que serializa JSON). Montamos manual.
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error('falha baixando imagem: ' + imageUrl);
  const buf = Buffer.from(await resp.arrayBuffer());

  const path = '/product/202309/images/upload';
  const timestamp = Math.floor(Date.now() / 1000);
  const query = { app_key: process.env.TIKTOK_APP_KEY, timestamp };
  // multipart → body fora da assinatura
  query.sign = tt.signRequest({ path, query, method: 'POST', contentType: 'multipart/form-data', bodyString: '' });

  const form = new FormData();
  form.append('data', new Blob([buf]), 'image.jpg');
  form.append('use_case', 'MAIN_IMAGE');

  const base = tt._config.API_BASE;
  const url = `${base}${path}?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-tts-access-token': connection.accessToken },
    body: form,
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0 || !json.data?.uri) {
    throw new Error('upload imagem TikTok falhou: ' + (json.message || res.status));
  }
  return json.data.uri;
}

// Monta o payload de criação/edição de produto no formato 202309.
// `sizes` já devem vir com stock = Σ StoreStock (localizado). `opts` carrega os
// dados account-dependent JÁ RESOLVIDOS (nunca chutados).
function buildTikTokProductPayload(product, sizes, opts = {}) {
  const { categoryId, warehouseId, brandId, weightKg, imageUris = [], mode = 'create' } = opts;

  const hasSizes = Array.isArray(sizes) && sizes.length > 0;
  const price = Number(product.price || 0);

  const skus = (hasSizes ? sizes : [{ size: null, stock: 0, barcode: null }]).map((s) => {
    const sku = {
      seller_sku: s.barcode || (hasSizes ? `${product.sku}-${s.size}` : product.sku),
      price: { amount: price.toFixed(2), currency: CURRENCY },
      inventory: [{ warehouse_id: warehouseId, quantity: parseInt(s.stock || 0, 10) }],
    };
    if (hasSizes) sku.sales_attributes = [{ name: 'Size', value_name: String(s.size) }];
    if (s.barcode) sku.identifier_code = { code: String(s.barcode), type: 'GTIN' };
    return sku;
  });

  const description = product.longDescription || product.shortDescription || product.name || '';

  const payload = {
    title: product.name,
    description,
    category_id: String(categoryId),
    main_images: imageUris.map((uri) => ({ uri })),
    skus,
    package_weight: { value: String(weightKg), unit: 'KILOGRAM' },
  };
  if (brandId) payload.brand_id = String(brandId);
  // is_cod_open etc. ficam no default do seller. mode reservado pra futuro (edit usa PUT).
  return payload;
}

// Push de UM produto. Retorna { action } ou { skipped, reason }.
async function pushProductToTikTok(localProductId, connection) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: { include: { storeStocks: { select: { stock: true } } } } },
  });
  if (!product) throw new Error(`Produto ${localProductId} não encontrado`);

  const ctx = ctxOf(product);
  const cls = ctx.classification || {};
  const map = ctx.tiktokMapping || {};

  // ===== REGRA INQUEBRÁVEL — 4 classificações =====
  const badCat = ['', 'A CLASSIFICAR', 'A DEFINIR'];
  const has = (v) => v != null && String(v).trim() !== '';
  const fullyClassified = has(product.category) && !badCat.includes(String(product.category).trim())
    && has(product.subcategory) && has(cls.modality) && has(cls.tier);
  if (!fullyClassified) {
    return { skipped: true, action: 'skipped', reason: 'classificacao incompleta (precisa Categoria + Sub + Modalidade + Especialidade)' };
  }

  // ===== REGRA INQUEBRÁVEL — preço de venda com markup, nunca o custo =====
  const price = Number(product.price || 0);
  const cost = Number(product.costPrice || 0);
  if (!(price > 0)) {
    return { skipped: true, action: 'skipped', reason: 'preco 0 — produto so sobe com preco de venda' };
  }
  if (cost > 0 && price <= cost) {
    return { skipped: true, action: 'skipped', reason: `preco (${price}) <= custo (${cost}) — markup nao aplicado` };
  }

  // ===== REGRA INQUEBRÁVEL — estoque físico = Σ StoreStock, só tamanhos disponíveis =====
  const hasSizes = (product.sizes || []).length > 0;
  const sizesLocated = (product.sizes || []).map((s) => ({
    ...s,
    stock: (s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0),
  }));
  const saleableSizes = sizesLocated.filter((s) => s.stock > 0);
  if (hasSizes && saleableSizes.length === 0) {
    return { skipped: true, action: 'skipped', reason: 'sem estoque fisico (nenhum tamanho disponivel)' };
  }
  const sizesToSend = hasSizes ? saleableSizes : (product.sizes || []);

  // ===== DADOS ACCOUNT-DEPENDENT — NUNCA CHUTAR (regra NUNCA INVENTAR) =====
  const categoryId = map.categoryId || null;
  const warehouseId = map.warehouseId || DEFAULT_WAREHOUSE;
  const weightKg = map.weightKg || DEFAULT_WEIGHT_KG;
  const brandId = map.brandId || null; // opcional
  const missing = [];
  if (!categoryId) missing.push('categoryId (aiContext.tiktokMapping.categoryId — nó da árvore TikTok)');
  if (!warehouseId) missing.push('warehouseId (TIKTOK_DEFAULT_WAREHOUSE_ID ou aiContext.tiktokMapping.warehouseId)');
  if (!weightKg) missing.push('weightKg (TIKTOK_DEFAULT_WEIGHT_KG ou aiContext.tiktokMapping.weightKg)');
  if (missing.length) {
    return { skipped: true, action: 'skipped', reason: 'faltam dados obrigatorios do TikTok (nao chutar): ' + missing.join('; ') };
  }

  // Imagens: hospeda no CDN do TikTok (só as locais existentes).
  const localImages = collectLocalImages(product);
  const imageUris = [];
  for (const u of localImages.slice(0, 9)) { // TikTok aceita até 9 main images
    try { imageUris.push(await uploadImageToTikTok(connection, u)); }
    catch (e) { console.warn('[tiktok push] imagem falhou:', e.message); }
  }
  if (imageUris.length === 0) {
    return { skipped: true, action: 'skipped', reason: 'sem imagem hospedada (TikTok exige pelo menos 1 main_image)' };
  }

  const existing = await prisma.tikTokShopProductMapping.findUnique({ where: { localProductId: product.id } });
  const payload = buildTikTokProductPayload(product, sizesToSend, {
    categoryId, warehouseId, brandId, weightKg, imageUris,
    mode: existing ? 'update' : 'create',
  });

  let ttProduct;
  let action;
  if (existing) {
    // Edit: PUT /product/202309/products/{product_id}
    ttProduct = await tt.tiktokApi(connection, 'PUT', `/product/202309/products/${existing.tiktokProductId}`, { body: payload });
    await prisma.tikTokShopProductMapping.update({
      where: { id: existing.id },
      data: { syncStatus: 'synced', lastSyncedAt: new Date() },
    });
    action = 'updated';
  } else {
    ttProduct = await tt.tiktokApi(connection, 'POST', '/product/202309/products', { body: payload });
    const ttProductId = String(ttProduct.product_id || ttProduct.id);
    await prisma.tikTokShopProductMapping.upsert({
      where: { localProductId: product.id },
      create: { localProductId: product.id, tiktokProductId: ttProductId, syncStatus: 'synced', lastSyncedAt: new Date() },
      update: { tiktokProductId: ttProductId, syncStatus: 'synced', lastSyncedAt: new Date() },
    });
    // Mapeia SKUs criados (TikTok devolve skus com id) → ProductSize local
    if (Array.isArray(ttProduct.skus)) {
      for (let i = 0; i < ttProduct.skus.length; i++) {
        const ttSku = ttProduct.skus[i];
        const localSize = sizesToSend[i];
        if (localSize && ttSku?.id) {
          try {
            await prisma.tikTokShopVariantMapping.create({
              data: {
                localInventoryId: localSize.id,
                localProductId: product.id,
                tiktokProductId: ttProductId,
                tiktokSkuId: String(ttSku.id),
                sku: ttSku.seller_sku || null,
                barcode: localSize.barcode || null,
              },
            });
          } catch (_) { /* mapping pode já existir */ }
        }
      }
    }
    action = 'created';
  }

  return { action, tiktokProductId: String(ttProduct.product_id || ttProduct.id || existing?.tiktokProductId), localProductId: product.id };
}

async function pushAllToTikTok({ onlyMissing = true, limit = 500 } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão TikTok Shop ativa');

  let where = { active: true };
  if (onlyMissing) {
    const mapped = await prisma.tikTokShopProductMapping.findMany({ select: { localProductId: true } });
    const ids = mapped.map((m) => m.localProductId);
    if (ids.length) where.id = { notIn: ids };
  }

  const products = await prisma.product.findMany({ where, take: limit, orderBy: { createdAt: 'asc' } });
  const out = { total: products.length, created: 0, updated: 0, skipped: 0, failed: 0, reasons: {}, errors: [] };
  for (const p of products) {
    try {
      const r = await pushProductToTikTok(p.id, connection);
      if (r.skipped) { out.skipped++; out.reasons[r.reason] = (out.reasons[r.reason] || 0) + 1; }
      else if (r.action === 'created') out.created++;
      else out.updated++;
      await new Promise((res) => setTimeout(res, 250));
    } catch (err) {
      out.failed++;
      out.errors.push({ sku: p.sku, error: err.message });
    }
  }
  return out;
}

module.exports = {
  getConnection,
  collectLocalImages,
  uploadImageToTikTok,
  buildTikTokProductPayload,
  pushProductToTikTok,
  pushAllToTikTok,
};
