// =====================================================================
// TikTok Shop Handlers — PUSH TenisCash → TikTok Shop (cria/edita produtos)
// =====================================================================
// Espelha src/services/nuvemshopHandlers.js (lado PUSH). Mesmo modelo de
// dados: Product (card) → ProductSize (tamanho, barcode=EAN=SKU).
//
// REGRAS INQUEBRÁVEIS herdadas do CLAUDE.md (valem pra QUALQUER loja):
//   1. Só sobe produto CLASSIFICADO nas 4 (Categoria + Sub + Modalidade +
//      Especialidade). Sem as 4 → NÃO sobe.
//   2. Produto que vai pra loja SÓ com PREÇO DE VENDA COM MARKUP, nunca o
//      custo. Se costPrice vazio ou price <= costPrice → NÃO sobe.
//
// FASE 1 (este arquivo): listar catálogo (criar/editar produto, preço,
//   estoque, imagens). FASE 2 (TODO): webhook de pedido → Sale + NFe 55 +
//   cashback (espelhar upsertSaleFromOrder do nuvemshopHandlers).
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const tk = require('./tiktokShop');

const DEFAULT_WAREHOUSE_ID = process.env.TIKTOK_SHOP_WAREHOUSE_ID || null;
const DEFAULT_WEIGHT_KG = process.env.TIKTOK_SHOP_DEFAULT_WEIGHT_KG || '0.6';
const CURRENCY = 'BRL';

async function logSync(entity, status, message, payload = null) {
  try {
    await prisma.tiktokShopSyncLog.create({
      data: { type: 'export', entity, status, message, payload },
    });
  } catch (_) { /* silencioso */ }
}

// ---------------------------------------------------------------------
// Conexão ativa + refresh automático do access_token (expira em ~24h).
// ---------------------------------------------------------------------
async function ensureFreshToken(conn) {
  if (!conn || !conn.refreshToken) return conn;
  const exp = conn.accessTokenExpireAt ? new Date(conn.accessTokenExpireAt).getTime() : 0;
  // Renova se falta menos de 1h pro vencimento (ou se já venceu / sem data)
  if (exp - Date.now() > 60 * 60 * 1000) return conn;
  try {
    const t = await tk.refreshAccessToken(conn.refreshToken);
    return prisma.tiktokShopConnection.update({
      where: { id: conn.id },
      data: {
        accessToken: t.access_token,
        refreshToken: t.refresh_token || conn.refreshToken,
        // TikTok manda expire_in como epoch ABSOLUTO (segundos)
        accessTokenExpireAt: t.access_token_expire_in ? new Date(Number(t.access_token_expire_in) * 1000) : null,
        refreshTokenExpireAt: t.refresh_token_expire_in ? new Date(Number(t.refresh_token_expire_in) * 1000) : conn.refreshTokenExpireAt,
        status: 'active',
      },
    });
  } catch (e) {
    console.warn('[tiktok] refresh do token falhou:', e.message);
    return conn; // tenta com o token atual; se falhar, a chamada estoura e loga
  }
}

async function getConnection() {
  const conn = await prisma.tiktokShopConnection.findFirst({
    where: { status: 'active' },
    orderBy: { createdAt: 'desc' },
  });
  if (!conn) return null;
  return ensureFreshToken(conn);
}

// ---------------------------------------------------------------------
// Helpers de classificação / preço / imagem (espelham o padrão Nuvemshop)
// ---------------------------------------------------------------------
function ctxOf(product) {
  try {
    if (!product.aiContext) return {};
    return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
  } catch (_) { return {}; }
}

// REGRA 1 — classificação completa nas 4
function classificationGate(product) {
  const ctx = ctxOf(product);
  const cls = ctx.classification || {};
  const badCat = ['', 'A CLASSIFICAR', 'A DEFINIR'];
  const has = (v) => v != null && String(v).trim() !== '';
  const ok = has(product.category) && !badCat.includes(String(product.category).trim())
    && has(product.subcategory)
    && has(cls.modality)
    && has(cls.tier);
  return ok ? null : 'classificação incompleta (precisa Categoria + Sub + Modalidade + Especialidade)';
}

// REGRA 2 — preço de venda COM markup (nunca o custo)
function priceGate(product) {
  const price = Number(product.price || 0);
  const cost = Number(product.costPrice || 0);
  if (!(price > 0)) return 'sem preço de venda';
  if (!(cost > 0)) return 'custo vazio — não dá pra garantir que o markup foi aplicado';
  if (price <= cost) return 'preço sem markup (price <= costPrice) — o custo nunca vai pra loja';
  return null;
}

// Junta capa + galeria, deduplicado e na ordem (1ª = capa).
function collectLocalImages(product) {
  const out = [];
  const push = (u) => { if (u && typeof u === 'string' && !out.includes(u)) out.push(u); };
  push(product.imageUrl);
  if (product.imageUrls) {
    try {
      const arr = typeof product.imageUrls === 'string' ? JSON.parse(product.imageUrls) : product.imageUrls;
      if (Array.isArray(arr)) arr.forEach(push);
    } catch (_) { /* ignora */ }
  }
  return out.slice(0, 9); // TikTok aceita até 9 imagens
}

function imageSignature(srcs) {
  return crypto.createHash('sha1').update(srcs.join('|')).digest('hex');
}

// http(s) → baixa; data:URL → decodifica base64. Devolve { buffer, filename }.
async function fetchImageBuffer(src, idx) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
  if (m) {
    const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return { buffer: Buffer.from(m[2], 'base64'), filename: `img-${idx}.${ext}` };
  }
  const res = await fetch(src, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`download imagem ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (res.headers.get('content-type') || 'image/jpeg').split('/')[1] || 'jpg';
  return { buffer: buf, filename: `img-${idx}.${ext.replace('jpeg', 'jpg')}` };
}

// Sobe as imagens locais pro TikTok e devolve as URIs. Cacheia em
// aiContext.tiktokImages (uris + assinatura) pra não re-subir a cada push.
async function resolveImageUris(connection, product) {
  const srcs = collectLocalImages(product);
  if (!srcs.length) return [];
  const sig = imageSignature(srcs);
  const ctx = ctxOf(product);
  if (ctx.tiktokImages && ctx.tiktokImages.sig === sig && Array.isArray(ctx.tiktokImages.uris) && ctx.tiktokImages.uris.length) {
    return ctx.tiktokImages.uris;
  }
  const uris = [];
  for (let i = 0; i < srcs.length; i++) {
    try {
      const { buffer, filename } = await fetchImageBuffer(srcs[i], i + 1);
      const up = await tk.uploadImage(connection, buffer, { useCase: 'MAIN_IMAGE', filename });
      if (up && up.uri) uris.push(up.uri);
    } catch (e) {
      console.warn('[tiktok img] falha na imagem', i + 1, e.message);
    }
  }
  if (uris.length) {
    ctx.tiktokImages = { sig, uris };
    try { await prisma.product.update({ where: { id: product.id }, data: { aiContext: ctx } }); }
    catch (e) { console.warn('[tiktok img] salvar cache de uris falhou:', e.message); }
  }
  return uris;
}

// Valida checksum de GTIN (EAN-8/12/13/14). Evita mandar placeholder (T-xxx)
// como identifier_code e tomar rejeição.
function isValidGtin(code) {
  const s = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(s.length)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === check;
}

// =====================================================================
// MAPPER — Product (+ sizes) → payload de produto do TikTok Shop (v202309)
// =====================================================================
function buildTiktokProductPayload(product, sizes, opts = {}) {
  const ctx = ctxOf(product);
  const color = ctx.color ? ` ${ctx.color}` : '';
  const title = `${product.brand ? product.brand + ' ' : ''}${product.name}${color}`.trim().slice(0, 255);

  const descText = product.longDescription || product.shortDescription || `${product.brand || ''} ${product.name}`.trim();
  const description = `<p>${String(descText).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;

  const warehouseId = opts.warehouseId || DEFAULT_WAREHOUSE_ID;
  const priceAmount = Number(product.price || 0).toFixed(2);

  const hasSizes = Array.isArray(sizes) && sizes.length > 0;
  const rows = hasSizes ? sizes : [{ size: null, stock: 0, barcode: null }];

  const skus = rows.map((s) => {
    const sku = {
      seller_sku: s.barcode || (hasSizes ? `${product.sku}-${s.size}` : product.sku),
      price: { amount: priceAmount, currency: CURRENCY },
      inventory: warehouseId ? [{ warehouse_id: warehouseId, quantity: parseInt(s.stock || 0, 10) }] : undefined,
    };
    // Variação de tamanho → sales attribute custom "Tamanho"
    if (hasSizes && s.size) {
      sku.sales_attributes = [{ name: 'Tamanho', value_name: String(s.size) }];
    }
    // EAN válido → identifier_code (GTIN). Inválido/placeholder → omite.
    if (isValidGtin(s.barcode)) {
      sku.identifier_code = { code: String(s.barcode).replace(/\D/g, ''), type: 'GTIN' };
    }
    return sku;
  });

  const payload = {
    save_mode: opts.saveMode || 'AS_DRAFT', // entra como rascunho; dono publica no Seller Center
    title,
    description,
    category_id: String(opts.categoryId),
    main_images: (opts.imageUris || []).map((uri) => ({ uri })),
    skus,
    package_weight: { value: String(opts.weightKg || DEFAULT_WEIGHT_KG), unit: 'KILOGRAM' },
    package_dimensions: opts.dimensions || { length: '33', width: '23', height: '13', unit: 'CENTIMETER' },
  };
  if (opts.brandId) payload.brand_id = String(opts.brandId);

  // TODO (fiscal BR): o TikTok Shop BR pode exigir NCM e dados do responsável
  // fiscal como ATRIBUTOS da categoria (product_attributes) ou no fluxo de
  // compliance. product.ncm está disponível. Mapear o attribute_id correto
  // assim que rodar getCategoryAttributes contra a conta no sandbox/produção.
  if (Array.isArray(opts.productAttributes) && opts.productAttributes.length) {
    payload.product_attributes = opts.productAttributes;
  }

  return payload;
}

// =====================================================================
// PUSH de 1 produto
// =====================================================================
async function pushProductToTiktok(localProductId, connection, opts = {}) {
  const product = await prisma.product.findUnique({
    where: { id: localProductId },
    include: { sizes: true },
  });
  if (!product) throw new Error(`Produto ${localProductId} não encontrado`);

  // ===== REGRAS INQUEBRÁVEIS =====
  const clsErr = classificationGate(product);
  if (clsErr) return { skipped: true, action: 'skipped', reason: clsErr };
  const priceErr = priceGate(product);
  if (priceErr) return { skipped: true, action: 'skipped', reason: priceErr };

  const imageSrcs = collectLocalImages(product);
  if (!imageSrcs.length) return { skipped: true, action: 'skipped', reason: 'sem imagem' };

  // category_id do TikTok tem que estar resolvida (via recommend-categories).
  const ctx = ctxOf(product);
  const categoryId = opts.categoryId || ctx.tiktokMapping?.categoryId;
  if (!categoryId) {
    return { skipped: true, action: 'skipped', reason: 'category_id do TikTok não resolvida — rode recommend-categories antes' };
  }

  const warehouseId = opts.warehouseId || DEFAULT_WAREHOUSE_ID;
  if (!warehouseId) throw new Error('TIKTOK_SHOP_WAREHOUSE_ID não configurado (pegue via getWarehouses)');

  // Sobe imagens → uris
  const imageUris = await resolveImageUris(connection, product);
  if (!imageUris.length) return { skipped: true, action: 'skipped', reason: 'falha ao subir imagens pro TikTok' };

  const payload = buildTiktokProductPayload(product, product.sizes || [], {
    categoryId,
    brandId: opts.brandId || ctx.tiktokMapping?.brandId,
    warehouseId,
    imageUris,
    saveMode: opts.saveMode,
  });

  const existing = await prisma.tiktokShopProductMapping.findUnique({ where: { localProductId: product.id } });

  let result;
  let action;
  if (existing) {
    // editProduct reenvia o payload completo (save_mode AS_DRAFT por padrão), então
    // um update de CONTEÚDO devolve o produto pra rascunho — o dono republica no
    // Seller Center. O update frequente (preço/estoque) usa pushStockAndPrice, que
    // mexe só nos endpoints dedicados e NÃO despublica.
    result = await tk.editProduct(connection, existing.tiktokProductId, payload);
    await prisma.tiktokShopProductMapping.update({
      where: { id: existing.id },
      data: { lastSyncedAt: new Date(), syncStatus: 'synced' },
    });
    action = 'updated';
  } else {
    result = await tk.createProduct(connection, payload);
    await prisma.tiktokShopProductMapping.create({
      data: {
        localProductId: product.id,
        tiktokProductId: String(result.product_id),
        syncStatus: 'synced',
        lastSyncedAt: new Date(),
      },
    });
    action = 'created';
  }

  // Mapeia os SKUs criados (TikTok devolve skus[].id + seller_sku) → ProductSize
  const tiktokProductId = String(result.product_id || existing?.tiktokProductId);
  const retSkus = Array.isArray(result.skus) ? result.skus : [];
  for (const rs of retSkus) {
    const local = (product.sizes || []).find((s) => (s.barcode && s.barcode === rs.seller_sku) || `${product.sku}-${s.size}` === rs.seller_sku);
    if (!local) continue;
    try {
      await prisma.tiktokShopVariantMapping.upsert({
        where: { localInventoryId: local.id },
        update: { tiktokSkuId: String(rs.id), tiktokProductId, sellerSku: rs.seller_sku || null, barcode: local.barcode || null, lastSyncedAt: new Date() },
        create: {
          localInventoryId: local.id,
          localProductId: product.id,
          tiktokProductId,
          tiktokSkuId: String(rs.id),
          sellerSku: rs.seller_sku || null,
          barcode: local.barcode || null,
        },
      });
    } catch (_) { /* mapping pode já existir */ }
  }

  return { action, tiktokProductId, localProductId: product.id, skus: retSkus.length };
}

// =====================================================================
// PUSH em massa
// =====================================================================
async function pushAllProducts({ onlyMissing = true, limit = 1000, withImageOnly = true, saveMode } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão TikTok Shop ativa');

  // Mira só nos VENDÁVEIS (curados): categoria/sub no banco + custo + preço. Evita
  // gastar tempo nos produtos antigos sem 4 classificações/custo (que o push pularia).
  const where = {
    active: true,
    category: { not: null },
    subcategory: { not: null },
    costPrice: { gt: 0 },
    price: { gt: 0 },
  };
  if (withImageOnly) where.imageUrl = { not: null };
  if (onlyMissing) {
    const mapped = await prisma.tiktokShopProductMapping.findMany({ select: { localProductId: true } });
    const ids = mapped.map((m) => m.localProductId);
    if (ids.length) where.id = { notIn: ids };
  }

  const products = await prisma.product.findMany({ where, take: limit, orderBy: { createdAt: 'asc' } });
  let created = 0; let updated = 0; let skipped = 0; let failed = 0;
  const skipReasons = {};
  const errors = [];

  for (const p of products) {
    try {
      const r = await pushProductToTiktok(p.id, connection, { saveMode });
      if (r.action === 'created') created++;
      else if (r.action === 'updated') updated++;
      else { skipped++; if (r.reason) skipReasons[r.reason] = (skipReasons[r.reason] || 0) + 1; }
      await new Promise((res) => setTimeout(res, 250)); // anti rate-limit
    } catch (err) {
      failed++;
      errors.push({ sku: p.sku, error: err.message });
      await logSync('product', 'error', `Push ${p.sku}: ${err.message}`);
    }
  }

  await logSync('product', 'ok', `Push TenisCash → TikTok: ${products.length} total, ${created} criados, ${updated} atualizados, ${skipped} pulados, ${failed} falhas`);
  return { total: products.length, created, updated, skipped, failed, skipReasons, errors: errors.slice(0, 20) };
}

// Atualiza só preço + estoque de um produto já mapeado.
async function pushStockAndPrice(localProductId) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão TikTok Shop ativa');
  const mapping = await prisma.tiktokShopProductMapping.findUnique({ where: { localProductId } });
  if (!mapping) throw new Error('Produto sem mapping com TikTok Shop');

  const sizes = await prisma.productSize.findMany({ where: { productId: localProductId } });
  const variants = await prisma.tiktokShopVariantMapping.findMany({ where: { localProductId } });
  const product = await prisma.product.findUnique({ where: { id: localProductId } });
  const warehouseId = DEFAULT_WAREHOUSE_ID;

  const priceSkus = [];
  const invSkus = [];
  for (const v of variants) {
    const s = sizes.find((x) => x.id === v.localInventoryId);
    if (!s) continue;
    priceSkus.push({ id: v.tiktokSkuId, price: { amount: Number(product.price || 0).toFixed(2), currency: CURRENCY } });
    if (warehouseId) invSkus.push({ id: v.tiktokSkuId, inventory: [{ warehouse_id: warehouseId, quantity: parseInt(s.stock || 0, 10) }] });
  }
  if (priceSkus.length) await tk.updatePrices(connection, mapping.tiktokProductId, priceSkus);
  if (invSkus.length) await tk.updateInventory(connection, mapping.tiktokProductId, invSkus);
  await logSync('product', 'ok', `Preço/estoque ${product.sku}: ${priceSkus.length} skus`);
  return { priceUpdated: priceSkus.length, inventoryUpdated: invSkus.length };
}

// =====================================================================
// Categorização — resolve category_id do TikTok pros produtos (recommend API)
// e grava em aiContext.tiktokMapping.categoryId. Rodar ANTES do push.
// =====================================================================
async function recommendCategoriesForProducts({ limit = 200, force = false } = {}) {
  const connection = await getConnection();
  if (!connection) throw new Error('Sem conexão TikTok Shop ativa');

  // Mira só nos produtos VENDÁVEIS (curados): com categoria/sub no banco, custo e preço.
  // Os mais antigos (lixo de NFe: nome só código, sem 4 classificações, sem custo) ficam de fora
  // — TikTok rejeita nome incompleto e o push nunca passaria os portões mesmo.
  const products = await prisma.product.findMany({
    where: {
      active: true,
      imageUrl: { not: null },
      category: { not: null },
      subcategory: { not: null },
      costPrice: { gt: 0 },
      price: { gt: 0 },
    },
    take: limit,
    orderBy: { createdAt: 'asc' },
  });

  let resolved = 0; let skipped = 0; let failed = 0;
  for (const p of products) {
    // Não gasta chamada de API em produto que não passaria nos portões do push.
    if (classificationGate(p) || priceGate(p)) { skipped++; continue; }
    const ctx = ctxOf(p);
    if (!force && ctx.tiktokMapping?.categoryId) { skipped++; continue; }
    try {
      const rec = await tk.recommendCategory(connection, {
        productTitle: `${p.brand ? p.brand + ' ' : ''}${p.name}`.trim(),
        description: p.shortDescription || p.longDescription || undefined,
      });
      const categoryId = rec?.category_id || rec?.leaf_category_id || (Array.isArray(rec?.categories) ? rec.categories.at(-1)?.id : null);
      if (categoryId) {
        ctx.tiktokMapping = { ...(ctx.tiktokMapping || {}), categoryId: String(categoryId) };
        await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
        resolved++;
      } else { skipped++; }
      await new Promise((res) => setTimeout(res, 300));
    } catch (err) {
      failed++;
      await logSync('category', 'error', `recommend ${p.sku}: ${err.message}`);
    }
  }
  await logSync('category', 'ok', `Recommend categorias: ${resolved} resolvidas, ${skipped} puladas, ${failed} falhas`);
  return { total: products.length, resolved, skipped, failed };
}

module.exports = {
  getConnection,
  ensureFreshToken,
  buildTiktokProductPayload,
  pushProductToTiktok,
  pushAllProducts,
  pushStockAndPrice,
  recommendCategoriesForProducts,
  resolveImageUris,
  collectLocalImages,
  isValidGtin,
  classificationGate,
  priceGate,
  logSync,
};
