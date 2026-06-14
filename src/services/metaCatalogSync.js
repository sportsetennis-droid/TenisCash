// =====================================================================
// Sync TenisCash -> Catálogo da Meta (Commerce) via Graph API (items_batch)
// =====================================================================
// Reflete sozinho como a Nuvemshop: roda no cron/hook e faz upsert dos
// produtos vendáveis no catálogo da Meta, que alimenta FB + IG + WhatsApp.
//
// GATED: só roda se META_CATALOG_ID estiver setado E o token tiver a
// permissão catalog_management (senão a Meta recusa com #100). Enquanto
// não destravar, isEnabled()=false e o sync fica inerte (não polui log).
//
// Régua (MESMA da loja/TikTok): active + classificado nas 4 + preço de
// venda c/ markup + ESTOQUE = Σ StoreStock das LOJAS S&T (localizado,
// nunca comprado) e EXCLUI o Baratão (LOJA01, outra empresa).
// =====================================================================
const { prisma } = require('../middleware');
const meta = require('./meta');

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, '');

function ctxOf(p) {
  try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
  catch { return {}; }
}
function isValidGtin(code) {
  const s = String(code || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(s.length)) return false;
  const d = s.split('').map(Number); const chk = d.pop();
  let sum = 0; d.reverse().forEach((n, i) => { sum += n * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === chk;
}
function httpImages(p) {
  const out = [];
  const push = (u) => { if (u && typeof u === 'string' && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u); };
  push(p.imageUrl);
  try {
    const arr = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : p.imageUrls;
    if (Array.isArray(arr)) arr.forEach(push);
  } catch (_) {}
  return out.slice(0, 20);
}
function isRealSize(sz) {
  const s = String(sz || '').trim().toUpperCase().replace(',', '.');
  if (!s) return false;
  if (['UNICO', 'ÚNICO', 'U', 'UN'].includes(s)) return true;
  if (/^(PP|P|M|G|GG|XG|XGG|XS|S|L|XL|XXL|XXG)$/.test(s)) return true;
  if (/^\d{1,2}(\.5)?$/.test(s)) { const n = parseFloat(s); if (n >= 1 && n <= 48) return true; }
  return false;
}
function cleanName(name) {
  let n = String(name || '');
  n = n.replace(/\bREF[:.\s]*[A-Z0-9][A-Z0-9\-\/.]*/gi, ' ');
  n = n.replace(/\b\d{2,3}\s*\/\s*\d{2,3}\b/g, ' ');
  n = n.replace(/\b\d{5,}\b/g, ' ');
  n = n.replace(/\s{2,}/g, ' ').replace(/[\s\-]+$/, '').trim();
  return n || String(name || '').trim();
}

async function getBaratoId() {
  const b = await prisma.store.findFirst({
    where: { OR: [{ code: 'LOJA01' }, { name: { contains: 'barat', mode: 'insensitive' } }] },
    select: { id: true },
  });
  return b?.id || null;
}

// Monta os itens (1 por tamanho) de UM produto no formato do catálogo da Meta.
// `id` = retailer_id (GTIN se válido, senão sku-size). item_group_id agrupa as variações.
function buildItemsForProduct(p, baratoId) {
  const ctx = ctxOf(p);
  if (ctx.hideFromNuvemshop === true) return []; // oculto na loja → fora do Meta também
  const cls = ctx.classification || {};
  const badCat = ['', 'A CLASSIFICAR', 'A DEFINIR'];
  const has = (v) => v != null && String(v).trim() !== '';

  const classified = has(p.category) && !badCat.includes(String(p.category).trim())
    && has(p.subcategory) && has(cls.modality) && has(cls.tier);
  if (!classified) return [];

  const price = Number(p.price || 0), cost = Number(p.costPrice || 0);
  if (!(price > 0) || (cost > 0 && price <= cost)) return [];

  const sizes = (p.sizes || []).map((s) => ({
    size: s.size, barcode: s.barcode,
    loc: (s.storeStocks || []).filter((ss) => ss.storeId !== baratoId).reduce((a, ss) => a + (ss.stock || 0), 0),
  })).filter((s) => s.loc > 0 && isRealSize(s.size));
  if (!sizes.length) return [];

  const imgs = httpImages(p);
  if (!imgs.length) return []; // Meta exige image_link

  const color = ctx.color || '';
  let title = cleanName(p.name);
  const brand = (p.brand || '').trim();
  if (brand && !title.toLowerCase().includes(brand.toLowerCase())) title = `${brand} ${title}`;
  if (color && !title.toLowerCase().includes(color.toLowerCase())) title = `${title} ${color}`;
  title = title.trim().slice(0, 200);
  const description = String(p.longDescription || p.shortDescription || title).replace(/\s+/g, ' ').trim().slice(0, 9999);
  const link = `${PUBLIC_BASE}/p/${p.id}`;
  const promo = Number(p.promoPrice || 0);

  return sizes.map((s) => {
    const gtin = isValidGtin(s.barcode) ? String(s.barcode).replace(/\D/g, '') : '';
    const data = {
      id: gtin || `${p.sku || p.id}-${s.size}`,
      title,
      description,
      availability: 'in stock',
      condition: 'new',
      price: `${price.toFixed(2)} BRL`,
      link,
      image_link: imgs[0],
      brand: brand || 'Sports & Tennis',
      item_group_id: p.id,
      size: s.size,
      quantity_to_sell_on_facebook: s.loc,
    };
    if (imgs.length > 1) data.additional_image_link = imgs.slice(1, 11).join(',');
    if (color) data.color = color;
    if (promo > 0 && promo < price) data.sale_price = `${promo.toFixed(2)} BRL`;
    if (gtin) data.gtin = gtin;
    return data;
  });
}

async function buildAllItems() {
  const baratoId = await getBaratoId();
  // ESPELHO DA LOJA (decisão do dono 2026-06-14): o catálogo Meta sobe SÓ o que está
  // na loja online (Nuvemshop) — produtos MAPEADOS na Nuvemshop, ativos, não-ocultos
  // e na régua (classificado + estoque loja S&T). 1 controle só: o que você libera pra
  // loja vai pro Meta; o que tira da loja, sai do Meta (reconciliação no syncAll).
  const maps = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
  const mappedIds = maps.map((m) => m.localProductId);
  if (!mappedIds.length) return [];
  const products = await prisma.product.findMany({
    where: { active: true, id: { in: mappedIds } },
    include: { sizes: { include: { storeStocks: true } } },
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  });
  const items = [];
  for (const p of products) items.push(...buildItemsForProduct(p, baratoId));
  return items;
}

// Token do catálogo: EXIGE META_CATALOG_TOKEN (System User c/ catalog_management).
// NÃO cai no META_USER_TOKEN — esse não tem catalog_management (dá #100). Sem o
// token de catálogo setado, isEnabled()=false e o cron fica inerte (não erra à toa).
function catalogToken() {
  return process.env.META_CATALOG_TOKEN || null;
}

function isEnabled() {
  return !!process.env.META_CATALOG_ID && !!catalogToken();
}

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v22.0'}`;

// Lista os retailer_id que JÁ estão no catálogo (paginado) — pra remover os que saíram da loja.
async function fetchExistingRetailerIds(catalogId, token) {
  const ids = new Set();
  let url = `${GRAPH}/${catalogId}/products?fields=retailer_id&limit=200&access_token=${encodeURIComponent(token)}`;
  let guard = 0;
  while (url && guard++ < 300) {
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || 'list products');
    (d.data || []).forEach((x) => { if (x.retailer_id != null) ids.add(String(x.retailer_id)); });
    url = d.paging && d.paging.next ? d.paging.next : null;
  }
  return ids;
}

async function batchOp(catalogId, token, requests) {
  await meta.graphApi(`/${catalogId}/items_batch`, {
    method: 'POST', token,
    params: { item_type: 'PRODUCT_ITEM', requests: JSON.stringify(requests) },
  });
}

// Espelha a loja no catálogo da Meta: UPSERT dos produtos da loja + DELETE dos que
// saíram (estão no catálogo mas não na loja). items_batch em lotes de 1000.
// dryRun só monta (não chama a Meta).
async function syncAll({ dryRun = false } = {}) {
  if (!isEnabled()) {
    return { ok: false, skip: !process.env.META_CATALOG_ID ? 'META_CATALOG_ID ausente' : 'META_CATALOG_TOKEN ausente' };
  }
  const catalogId = process.env.META_CATALOG_ID;
  const token = catalogToken();
  const items = await buildAllItems();
  const desired = new Set(items.map((i) => String(i.id)));
  if (dryRun) return { ok: true, dryRun: true, items: items.length, sample: items.slice(0, 2) };

  let sent = 0, deleted = 0; const errors = [];
  // 1) UPSERT (UPDATE = upsert) os produtos que estão na loja
  for (let i = 0; i < items.length; i += 1000) {
    const chunk = items.slice(i, i + 1000);
    try { await batchOp(catalogId, token, chunk.map((data) => ({ method: 'UPDATE', data }))); sent += chunk.length; }
    catch (e) { errors.push('update: ' + e.message); }
  }
  // 2) DELETE os que saíram da loja (no catálogo mas não na lista desejada)
  try {
    const existing = await fetchExistingRetailerIds(catalogId, token);
    const toDelete = [...existing].filter((id) => !desired.has(id));
    for (let i = 0; i < toDelete.length; i += 1000) {
      const chunk = toDelete.slice(i, i + 1000);
      try { await batchOp(catalogId, token, chunk.map((id) => ({ method: 'DELETE', data: { id } }))); deleted += chunk.length; }
      catch (e) { errors.push('delete: ' + e.message); }
    }
  } catch (e) { errors.push('reconcile: ' + e.message); }

  return { ok: errors.length === 0, items: items.length, sent, deleted, errors };
}

module.exports = { isEnabled, syncAll, buildAllItems, buildItemsForProduct, getBaratoId };
