// Ofertas rotativas das 12 placas físicas.
// O QR impresso aponta sempre para /oferta/placa-XX; somente a oferta ativa muda.

const express = require('express');
const QRCode = require('qrcode');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');
const ns = require('../services/nuvemshop');
const nsHandlers = require('../services/nuvemshopHandlers');

const adminRouter = express.Router();
const publicRouter = express.Router();

const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || 'https://teniscash.com.br').replace(/\/+$/, '');
const STORE_BASE = (process.env.NUVEMSHOP_STORE_URL || 'https://www.sportsetennis.com.br').replace(/\/+$/, '');
const PLATE_COUNT = 12;
const DEFAULT_DURATION_HOURS = 24;
const QR_OFFER_DISCOUNT_PCT = 30;
const QR_DISCOUNT_PROMOTION_NAME = 'TenisCash QR exclusivo 30%';
const handleCache = new Map();
const remoteImageCache = new Map();
const REMOTE_PUBLISHED_CACHE_MS = 10 * 60 * 1000;
let remotePublishedCache = { expiresAt: 0, ids: new Set() };
// Saída para gráfica: H recupera até ~30% de dano e SVG não perde resolução.
const QR_PRINT_OPTIONS = { errorCorrectionLevel: 'H', margin: 4 };
const QR_PRINT_PNG_WIDTH = 2400;
const staleBoardsReconciled = new Set();
let storefrontPromotionsReconciled = false;
let qrDiscountPromotionReconciled = false;
let qrDiscountPromotionId = null;
let qrDiscountStoreId = null;
let qrDiscountEligibility = new Map();

function plateNumber(raw) {
  const m = String(raw || '').toLowerCase().match(/(?:placa[-_ ]*)?(\d{1,2})/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= PLATE_COUNT ? n : null;
}

function plateCode(n) { return `placa-${String(n).padStart(2, '0')}`; }

// Os QR codes já impressos continuam apontando para a URL fixa do TenisCash.
// Essa URL redireciona para a loja, onde o script da Nuvemshop apresenta a oferta.
function offerCategoryHandle(code) { return `ofertas${String(code).replace(/[^a-z0-9]/gi, '')}`; }

function storeOfferUrl(code, couponCode) {
  const base = `${STORE_BASE}/${offerCategoryHandle(code)}/`;
  return couponCode ? `${base}?coupon=${encodeURIComponent(couponCode)}` : base;
}

function fixedQrUrl(code) { return `${PUBLIC_BASE}/oferta/${code}`; }

function qrOfferTitle(number) {
  return `Oferta exclusiva da Placa ${String(number).padStart(2, '0')} — ${QR_OFFER_DISCOUNT_PCT}% OFF`;
}

function offerBasePrice(product) {
  const normal = Number(product?.price);
  return Number.isFinite(normal) && normal > 0 ? normal : 0;
}

function offerDiscountedPrice(product, discountPct = QR_OFFER_DISCOUNT_PCT) {
  const base = offerBasePrice(product);
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 100);
  return Math.round((base * (1 - pct / 100) + Number.EPSILON) * 100) / 100;
}

function brl(value) {
  return Number(value || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quickBuyMarkup(product) {
  const quick = product?.quickBuy;
  const variants = Array.isArray(quick?.variants) ? quick.variants : [];
  if (!quick?.action || !quick?.productId || !variants.length) {
    return `<a class="buy-fallback" href="${escapeHtml(product.storeUrl)}">Escolher tamanho e comprar agora</a>`;
  }
  const options = variants.map((variant) => (
    `<option value="${escapeHtml(variant.variantId)}" data-size="${escapeHtml(variant.size)}">${escapeHtml(variant.size)}</option>`
  )).join('');
  return `<form class="quick-buy" action="${escapeHtml(quick.action)}" method="post" style="display:grid;gap:8px"><label style="font-size:13px;font-weight:900">Escolha o tamanho</label><select name="variant_id" data-size-picker aria-label="Tamanho" onchange="this.form.querySelector('[data-size-value]').value=this.options[this.selectedIndex].dataset.size" style="width:100%;padding:11px;border:1px solid #d9c8bd;border-radius:10px;background:#fff;font-size:16px">${options}</select><input type="hidden" name="variation[0]" value="${escapeHtml(variants[0].size)}" data-size-value><input type="hidden" name="add_to_cart" value="${escapeHtml(quick.productId)}"><input type="hidden" name="quantity" value="1"><button type="submit" style="border:0;border-radius:12px;padding:14px 10px;background:#f4511e;color:#fff;font-size:15px;font-weight:900;cursor:pointer;box-shadow:0 6px 14px #f4511e35">Comprar agora com 30% OFF</button></form>`;
}

function offerProductCard(product) {
  return `<article class="product"><img src="${escapeHtml(product.imageUrl || '')}" alt="${escapeHtml(product.name)}"><div><small>${escapeHtml(product.brand || '')}</small><h2>${escapeHtml(product.name)}</h2><div class="pricing"><span class="original">De R$ ${brl(product.originalPrice)}</span><strong class="exclusive">Por R$ ${brl(product.exclusivePrice)}</strong><span class="saving">30% OFF exclusivo desta placa</span></div>${quickBuyMarkup(product)}</div></article>`;
}

function promotionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function disableStorefrontPromotions(conn) {
  const payload = await ns.nuvemshopApi(conn, 'GET', '/promotions?per_page=100&page=1');
  const active = promotionRows(payload).filter((promotion) => (
    promotion?.active !== false
    && promotion?.id != null
    && promotion?.name !== QR_DISCOUNT_PROMOTION_NAME
  ));
  for (const promotion of active) {
    await ns.nuvemshopApi(conn, 'PATCH', `/promotions/${encodeURIComponent(promotion.id)}`, { active: false });
  }
  return active.length;
}

async function ensureQrDiscountPromotion(conn) {
  const callbackUrl = `${PUBLIC_BASE}/api/nuvemshop/discounts/qr-offers`;
  await ns.nuvemshopApi(conn, 'PUT', '/discounts/callbacks', { url: callbackUrl });

  const listed = promotionRows(await ns.nuvemshopApi(conn, 'GET', '/promotions?per_page=100&page=1'));
  let promotion = listed.find((row) => row?.name === QR_DISCOUNT_PROMOTION_NAME && row?.id != null);
  const settings = {
    active: true,
    combines_with_quantity_discounts: false,
    combines_with_free_shipping: true,
    combines_with_cart_amount_discounts: false,
    combines_with_app_discounts: false,
    combines_with_price_discounts: false,
  };
  let created = false;
  if (!promotion) {
    const response = await ns.nuvemshopApi(conn, 'POST', '/promotions', {
      name: QR_DISCOUNT_PROMOTION_NAME,
      description: '30% OFF exclusivo para compras iniciadas pelas placas QR da Sports & Tennis',
      disclaimer: 'Valido somente para os produtos e durante o prazo da placa acessada',
      allocation_type: 'line_item',
      ...settings,
    });
    promotion = response?.data || response;
    created = true;
  } else {
    await ns.nuvemshopApi(conn, 'PATCH', `/promotions/${encodeURIComponent(promotion.id)}`, settings);
  }
  if (!promotion?.id) throw new Error('A Nuvemshop nao confirmou a promocao exclusiva dos QR Codes');
  qrDiscountPromotionId = String(promotion.id);
  qrDiscountStoreId = String(conn.nuvemshopUserId || conn.storeId || '');
  return { ready: true, created, callbackConfigured: true };
}

function qrMarkerFromCart(payload) {
  const rows = Array.isArray(payload?.utm) ? payload.utm : [];
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index] || {};
    const source = String(row.utm_source || row.source || '').toLowerCase();
    const medium = String(row.utm_medium || row.medium || '').toLowerCase();
    const campaign = String(row.utm_campaign || row.campaign || '').toLowerCase();
    const content = String(row.utm_content || row.content || '');
    const number = plateNumber(campaign);
    if (source === 'teniscash' && medium === 'qr' && number) {
      return { plate: plateCode(number), offerId: content };
    }
  }
  return null;
}

function qrPromotionInCart(payload, promotionId) {
  return (Array.isArray(payload?.promotions) ? payload.promotions : [])
    .find((promotion) => String(promotion?.id || '') === String(promotionId || '')) || null;
}

function buildQrDiscountCommands(payload, promotionId, eligibleRemoteIds) {
  const eligible = eligibleRemoteIds instanceof Set ? eligibleRemoteIds : new Set(eligibleRemoteIds || []);
  const lineItems = (Array.isArray(payload?.products) ? payload.products : [])
    .filter((product) => eligible.has(String(product?.product_id || '')) && product?.id != null)
    .map((product) => ({
      line_item: String(product.id),
      discount_specs: { type: 'percentage', amount: `${QR_OFFER_DISCOUNT_PCT.toFixed(2)}` },
    }));
  if (lineItems.length) {
    return [{
      command: 'create_or_update_discount',
      specs: {
        promotion_id: String(promotionId),
        currency: String(payload?.currency || 'BRL'),
        display_text: { 'pt-br': '30% OFF exclusivo da placa' },
        line_items: lineItems,
      },
    }];
  }

  const applied = qrPromotionInCart(payload, promotionId);
  const appliedItems = Array.isArray(applied?.line_items) ? applied.line_items.map(String) : [];
  if (!appliedItems.length) return [];
  return [{
    command: 'remove_discount',
    specs: {
      scope: 'line_item',
      promotion_id: String(promotionId),
      line_items: appliedItems,
    },
  }];
}

async function refreshQrDiscountEligibility(offers, now = new Date()) {
  const active = (offers || []).filter((offer) => offerState(offer, now) === 'ACTIVE');
  const localIds = Array.from(new Set(active.flatMap((offer) => (
    (offer.products || []).map((row) => String(row.productId || row.product?.id || '')).filter(Boolean)
  ))));
  const mappings = localIds.length ? await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: localIds } },
    select: { localProductId: true, nuvemshopProductId: true },
  }) : [];
  const byLocalId = new Map(mappings.map((row) => [String(row.localProductId), String(row.nuvemshopProductId)]));
  const next = new Map();
  for (const offer of active) {
    const ids = new Set((offer.products || [])
      .map((row) => byLocalId.get(String(row.productId || row.product?.id || '')))
      .filter(Boolean));
    next.set(plateCode(offer.board.number), {
      offerId: String(offer.id),
      startsAt: new Date(offer.startsAt).getTime(),
      endsAt: new Date(offer.endsAt).getTime(),
      remoteProductIds: ids,
    });
  }
  qrDiscountEligibility = next;
  return next.size;
}

async function qrSvg(code) {
  return QRCode.toString(fixedQrUrl(code), { type: 'svg', ...QR_PRINT_OPTIONS });
}

async function qrPng(code, width = QR_PRINT_PNG_WIDTH) {
  return QRCode.toBuffer(fixedQrUrl(code), { type: 'png', width, ...QR_PRINT_OPTIONS });
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseDate(raw, fallback) {
  const d = raw ? new Date(raw) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function normalizeProductIds(raw) {
  const ids = Array.isArray(raw) ? raw : [];
  return Array.from(new Set(ids.map((v) => String(v || '').trim()).filter(Boolean))).slice(0, 24);
}

function offerState(offer, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const starts = new Date(offer.startsAt).getTime();
  const ends = new Date(offer.endsAt).getTime();
  if (!Number.isFinite(at) || !Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts || ends <= at) return 'EXPIRED';
  if (starts > at) return 'SCHEDULED';
  return 'ACTIVE';
}

async function ensureBoards() {
  const rows = [];
  for (let n = 1; n <= PLATE_COUNT; n++) {
    rows.push(await prisma.qRBoard.upsert({
      where: { number: n },
      update: { code: plateCode(n) },
      create: { number: n, code: plateCode(n), label: `Placa ${String(n).padStart(2, '0')}` },
    }));
  }
  return rows;
}

async function activeConnection() {
  // Keep every QR operation bound to the same Sports & Tennis storefront used
  // by the catalog sync. An arbitrary old active connection is unsafe here.
  return nsHandlers.getConnection();
}

async function productViews(products, offer) {
  const mappings = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: products.map((product) => product.id) } },
    select: { localProductId: true, nuvemshopProductId: true },
  });
  const byLocalId = new Map(mappings.map((mapping) => [String(mapping.localProductId), String(mapping.nuvemshopProductId)]));
  if (offer?.board?.code && offerState(offer) === 'ACTIVE') {
    qrDiscountEligibility.set(offer.board.code, {
      offerId: String(offer.id),
      startsAt: new Date(offer.startsAt).getTime(),
      endsAt: new Date(offer.endsAt).getTime(),
      remoteProductIds: new Set(byLocalId.values()),
    });
  }
  const localSizeIds = products.flatMap((product) => (product.sizes || []).map((size) => String(size.id)));
  const variantMappings = localSizeIds.length ? await prisma.nuvemshopVariantMapping.findMany({
    where: { localInventoryId: { in: localSizeIds } },
    select: { localInventoryId: true, nuvemshopVariantId: true },
  }) : [];
  const byLocalSizeId = new Map(variantMappings.map((mapping) => (
    [String(mapping.localInventoryId), String(mapping.nuvemshopVariantId)]
  )));
  const missingRemoteIds = Array.from(new Set(
    mappings
      .map((mapping) => String(mapping.nuvemshopProductId))
      .filter((id) => id && (!handleCache.has(id) || !remoteImageCache.has(id))),
  ));
  if (missingRemoteIds.length) {
    try {
      const conn = await activeConnection();
      if (conn) {
        const remote = await ns.nuvemshopApi(
          conn,
          'GET',
          `/products?ids=${missingRemoteIds.map(encodeURIComponent).join(',')}&published=true&fields=id,handle,images,published&per_page=30&page=1`,
        );
        for (const item of Array.isArray(remote) ? remote : []) {
          const handle = typeof item.handle === 'object' ? (item.handle.pt || Object.values(item.handle)[0]) : item.handle;
          if (handle) handleCache.set(String(item.id), String(handle));
          const image = remoteProductImage(item);
          if (image) remoteImageCache.set(String(item.id), image);
        }
      }
    } catch (error) {
      console.warn('[qr-offers] resolve handles em lote:', error.message);
    }
  }
  return products.map((product) => {
    const remoteId = byLocalId.get(String(product.id));
    const handle = remoteId ? handleCache.get(remoteId) : null;
    const direct = handle ? `${STORE_BASE}/produtos/${encodeURIComponent(handle)}/` : `${STORE_BASE}/search/?q=${encodeURIComponent(product.name)}`;
    const params = new URLSearchParams();
    // A origem QR segue como UTM no carrinho. A promocao privada do app usa
    // essa marca para aplicar 30% sem expor nem exigir cupom do cliente.
    if (offer?.board?.code) {
      params.set('utm_source', 'teniscash');
      params.set('utm_medium', 'qr');
      params.set('utm_campaign', offer.board.code);
      params.set('utm_content', String(offer.id || ''));
      params.set('qr_offer', offer.board.code);
    }
    if (offer?.endsAt) params.set('qr_expires', new Date(offer.endsAt).toISOString());
    const query = params.toString();
    const variants = (product.sizes || []).map((size) => ({
      size: String(size.size),
      variantId: byLocalSizeId.get(String(size.id)),
    })).filter((variant) => variant.variantId);
    const trackedUrl = query ? `${direct}${direct.includes('?') ? '&' : '?'}${query}` : direct;
    const quickBuyAction = query ? `${STORE_BASE}/comprar/?${query}` : `${STORE_BASE}/comprar/`;
    return {
      id: product.id,
      name: product.name,
      brand: product.brand,
      imageUrl: (remoteId && remoteImageCache.get(remoteId)) || product.imageUrl,
      price: product.price,
      promoPrice: product.promoPrice,
      originalPrice: offerBasePrice(product),
      exclusivePrice: offerDiscountedPrice(product, QR_OFFER_DISCOUNT_PCT),
      discountPct: QR_OFFER_DISCOUNT_PCT,
      storeUrl: trackedUrl,
      quickBuy: remoteId && variants.length ? {
        action: quickBuyAction,
        productId: remoteId,
        variants,
      } : null,
    };
  });
}

async function findOfferByPlate(n) {
  const exists = await prisma.qRBoard.findUnique({ where: { number: n }, select: { id: true } });
  if (!exists) await ensureBoards();
  const board = await prisma.qRBoard.findUnique({
    where: { number: n },
    include: {
      offers: {
        where: { status: { in: ['ACTIVE', 'SCHEDULED'] } },
        orderBy: { startsAt: 'desc' },
        take: 1,
        include: {
          products: {
            orderBy: { position: 'asc' },
            include: {
              product: {
                include: {
                  sizes: {
                    where: { storeStocks: { some: { stock: { gt: 0 } } } },
                    orderBy: { size: 'asc' },
                    select: { id: true, size: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const raw = board && board.offers && board.offers[0];
  if (!raw || offerState(raw) !== 'ACTIVE') return { board, offer: null };
  const eligibleProducts = (raw.products || []).filter((row) => row.product?.active).map((row) => row.product);
  const products = await productViews(eligibleProducts, { ...raw, board });
  // O identificador usado para aplicar o desconto pertence somente ao fluxo
  // interno. A pagina publica apresenta preco final e compra automatica.
  const { couponCode: _couponCode, nsCouponId: _nsCouponId, notes: _notes, ...publicOffer } = raw;
  return {
    board,
    offer: {
      ...publicOffer,
      title: qrOfferTitle(board.number),
      discountPct: QR_OFFER_DISCOUNT_PCT,
      discountAppliedAutomatically: true,
      products,
    },
  };
}

async function getOffer(id) {
  return prisma.qROffer.findUnique({
    where: { id },
    include: { board: true, products: { orderBy: { position: 'asc' }, include: { product: true } } },
  });
}

async function disableNuvemshopCoupon(offer, connection = null, options = {}) {
  if (!offer || !offer.nsCouponId) return;
  try {
    const conn = connection || await activeConnection();
    if (!conn) throw new Error('Nuvemshop não está conectada');
    await ns.setCouponValid(conn, offer.nsCouponId, false);
  } catch (e) {
    if (/\[Nuvemshop 404\]/.test(e.message || '')) return;
    if (options.strict) throw e;
    console.warn('[qr-offers] disable coupon:', e.message);
  }
}

function validateBody(body) {
  const title = String(body.title || '').trim().slice(0, 140);
  if (!title) throw new Error('Informe um título para a oferta');
  const discountPct = QR_OFFER_DISCOUNT_PCT;
  const durationHours = Number(body.durationHours || DEFAULT_DURATION_HOURS);
  if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 24) throw new Error('A validade deve ser de 1 a 24 horas');
  const startsAt = parseDate(body.startsAt, new Date());
  const endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);
  return { title, discountPct, durationHours, startsAt, endsAt, freeExchange: body.freeExchange !== false, notes: body.notes ? String(body.notes).slice(0, 1000) : null };
}

async function selectedProducts(ids) {
  if (!ids.length) throw new Error('Selecione ao menos um produto');
  const products = await prisma.product.findMany({
    where: {
      id: { in: ids }, active: true, price: { gt: 0 },
      AND: [{ imageUrl: { not: null } }, { imageUrl: { not: '' } }],
      sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
    },
    select: { id: true },
  });
  if (products.length !== ids.length) throw new Error('Só é permitido selecionar produtos ativos, com foto e estoque físico bipado');
  const mappings = await prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: ids } }, select: { localProductId: true } });
  if (mappings.length !== ids.length) throw new Error('Todos os produtos precisam estar publicados na Nuvemshop');
  return products;
}

async function remoteOfferProductIds(offer) {
  const localIds = (offer.products || [])
    .map((row) => String(row.productId || row.product?.id || ''))
    .filter(Boolean);
  if (!localIds.length) throw new Error('A oferta não tem produtos para restringir o cupom');
  const mappings = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: localIds } },
    select: { localProductId: true, nuvemshopProductId: true },
  });
  const byLocalId = new Map(mappings.map((mapping) => [String(mapping.localProductId), mapping.nuvemshopProductId]));
  const remoteIds = localIds.map((id) => Number(byLocalId.get(id))).filter((id) => Number.isInteger(id) && id > 0);
  if (remoteIds.length !== localIds.length || new Set(remoteIds).size !== localIds.length) {
    throw new Error('A oferta precisa ter todos os produtos publicados e mapeados de forma exclusiva na Nuvemshop');
  }
  return remoteIds;
}

async function deactivateBoardOffers(boardId, exceptId, conn) {
  const old = await prisma.qROffer.findMany({ where: { boardId, status: { in: ['ACTIVE', 'SCHEDULED'] }, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  for (const offer of old) {
    // The category belongs to the board and may already contain the new offer;
    // only the superseded coupon is retired during an atomic replacement.
    await disableNuvemshopCoupon(offer, conn, { strict: true });
    await prisma.qROffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED' } });
  }
}

async function publishOffer(offer) {
  const conn = await activeConnection();
  if (!conn) throw new Error('Nuvemshop não está conectada no TenisCash');
  const state = offerState(offer);
  if (state === 'EXPIRED') throw new Error('A validade da oferta já terminou');
  const suffix = String(offer.id || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  const savedCode = String(offer.couponCode || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  const code = savedCode || `QR${String(offer.board.number).padStart(2, '0')}${new Date(offer.startsAt).toISOString().slice(0, 10).replace(/-/g, '')}${suffix}`;
  const title = qrOfferTitle(offer.board.number);
  const preparedOffer = {
    ...offer,
    title,
    discountPct: QR_OFFER_DISCOUNT_PCT,
    couponCode: code,
    status: state,
  };

  // A primeira versão das placas usava páginas customizadas na loja. Elas são
  // removidas para não manter destinos antigos concorrendo com a URL fixa.
  await deleteOfferPages(preparedOffer, conn);
  // A própria API da Nuvemshop permite restringir um cupom por produtos. Isso
  // mantém a seleção exata sem consumir categorias da loja (que tem teto de
  // 1.000) e deixa a vitrine exclusiva na URL fixa codificada no QR.
  const remoteProductIds = await remoteOfferProductIds(preparedOffer);
  const couponOpts = {
    code,
    discountPct: QR_OFFER_DISCOUNT_PCT,
    valid: false,
    startDate: offer.startsAt,
    endDate: offer.endsAt,
    products: remoteProductIds,
  };

  let coupon;
  let couponId = offer.nsCouponId || null;
  try {
    coupon = offer.nsCouponId
      ? await ns.updateCoupon(conn, offer.nsCouponId, couponOpts)
      : await ns.createCoupon(conn, couponOpts);
    couponId = coupon?.id != null ? String(coupon.id) : couponId;
    if (couponId == null) throw new Error('A Nuvemshop não confirmou o ID do cupom');
    // Persist the prepared remote identity before the activation steps. If a
    // later API call fails, the next reconciliation updates the same coupon
    // instead of creating a duplicate with the same code.
    await prisma.qROffer.update({
      where: { id: offer.id },
      data: { couponCode: code, nsCouponId: couponId, discountPct: QR_OFFER_DISCOUNT_PCT, title },
    });
    await deactivateBoardOffers(offer.boardId, offer.id, conn);
    if (state === 'ACTIVE') {
      await ns.setCouponValid(conn, couponId, true);
    }
  } catch (err) {
    if (couponId != null) {
      try { await ns.setCouponValid(conn, couponId, false); } catch (_) {}
    }
    throw err;
  }

  try {
    return await prisma.qROffer.update({
      where: { id: offer.id },
      data: {
        status: state,
        title,
        discountPct: QR_OFFER_DISCOUNT_PCT,
        couponCode: code,
        nsCouponId: couponId,
        publishedAt: new Date(),
      },
    });
  } catch (err) {
    if (couponId != null) {
      try { await ns.setCouponValid(conn, couponId, false); } catch (_) {}
    }
    throw err;
  }
}

function localizedValue(value) {
  if (!value || typeof value !== 'object') return String(value || '');
  return String(value.pt || value.pt_BR || value['pt-BR'] || Object.values(value)[0] || '');
}

function numericCategoryId(value) {
  const raw = value && typeof value === 'object' ? value.id : value;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function offerCategoryName(offer) {
  return `Ofertas Placa ${String(offer.board.number).padStart(2, '0')}`;
}

function offerCategoryDescription(offer) {
  const title = escapeHtml(offer.title || 'Oferta exclusiva');
  const discount = Number(offer.discountPct);
  const pct = Number.isFinite(discount) ? `${discount}% OFF` : 'desconto exclusivo';
  const coupon = escapeHtml(offer.couponCode || 'informado no checkout');
  return `Oferta exclusiva para quem leu a Placa ${String(offer.board.number).padStart(2, '0')}: ${pct}. Confira o preco normal do produto no site e aplique o cupom ${coupon} no checkout. Validade de ate 24 horas. ${title}`;
}

async function findOfferCategory(offer, conn) {
  const handle = offerCategoryHandle(plateCode(offer.board.number));
  const listed = await ns.nuvemshopApi(conn, 'GET', `/categories?handle=${encodeURIComponent(handle)}&language=pt&per_page=50&page=1`);
  const categories = Array.isArray(listed) ? listed : [];
  let category = categories.find((item) => localizedValue(item.handle) === handle);
  if (category) return category;

  // Compatibility with categories created by the previous version without a
  // predictable handle. The short window avoids walking the entire tree.
  const updatedAfter = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const all = await ns.nuvemshopApi(conn, 'GET', `/categories?updated_at_min=${encodeURIComponent(updatedAfter)}&per_page=100&page=1`);
  const marker = `Oferta exclusiva para quem leu a Placa ${String(offer.board.number).padStart(2, '0')}:`;
  category = (Array.isArray(all) ? all : []).find((item) => localizedValue(item.description).includes(marker));
  return category || null;
}

function pagesFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.pages?.results)) return payload.pages.results;
  if (Array.isArray(payload?.pages)) return payload.pages;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

async function findOfferPages(offer, conn) {
  const handle = offerCategoryHandle(plateCode(offer.board.number));
  const matches = [];
  for (let page = 1; page <= 50; page++) {
    // Pages has a stricter limit than v1 resources: per_page must be < 20.
    const payload = await ns.nuvemshopVersionedApi(conn, 'GET', `/pages?page=${page}&per_page=19`);
    const rows = pagesFromResponse(payload);
    for (const item of rows) {
      if (localizedValue(item.handle) === handle) matches.push(item);
    }
    const lastPage = Number(payload?.pages?.lastPage || payload?.lastPage || 1);
    if (!rows.length || page >= lastPage) break;
  }
  return matches;
}

async function deleteOfferPages(offer, conn) {
  const pages = await findOfferPages(offer, conn);
  for (const page of pages) {
    await ns.nuvemshopVersionedApi(conn, 'DELETE', `/pages/${page.id}`);
  }
  return { deleted: pages.length, ids: pages.map((page) => page.id) };
}

async function setOfferCategoryVisibility(offer, conn, categoryId, visible) {
  const visibility = visible ? 'visible' : 'hidden';
  return ns.nuvemshopApi(conn, 'PUT', `/categories/${categoryId}`, {
    name: { pt: offerCategoryName(offer), es: offerCategoryName(offer), en: offerCategoryName(offer) },
    description: { pt: offerCategoryDescription(offer) },
    visibility,
    parent: null,
  });
}

function categoryIdsOf(product) {
  return Array.isArray(product && product.categories)
    ? product.categories.map(numericCategoryId).filter((id) => id != null)
    : [];
}

function categoryMembershipDiff(currentIds, selectedIds) {
  const current = new Set(Array.from(currentIds || [], String));
  const selected = new Set(Array.from(selectedIds || [], String));
  return {
    add: [...selected].filter((id) => !current.has(id)),
    remove: [...current].filter((id) => !selected.has(id)),
  };
}

// Cria/atualiza a categoria oculta que funciona como vitrine da placa.
// A categoria não é adicionada ao menu; o endereço só é divulgado no QR.
async function syncOfferCategory(offer, conn, opts = {}) {
  const code = plateCode(offer.board.number);
  const handle = offerCategoryHandle(code);
  const name = offerCategoryName(offer);
  const visible = opts.visible !== false;
  const visibility = visible ? 'visible' : 'hidden';
  let category = await findOfferCategory(offer, conn);

  if (!category) {
    category = await ns.nuvemshopApi(conn, 'POST', '/categories', {
      name: { pt: name, es: name, en: name },
      description: { pt: offerCategoryDescription(offer) },
      visibility,
      parent: null,
    });
  } else {
    category = await ns.nuvemshopApi(conn, 'PUT', `/categories/${category.id}`, {
      name: { pt: name, es: name, en: name },
      description: { pt: offerCategoryDescription(offer) },
      visibility,
      parent: null,
    });
  }

  // Nuvemshop renderiza categoria oculta como pagina 404 com HTTP 200.
  if (!category) throw new Error(`Categoria da Placa ${String(offer.board.number).padStart(2, '0')} não foi criada`);
  if (category.visibility !== visibility || !localizedValue(category.name)) {
    category = await setOfferCategoryVisibility(offer, conn, category.id, visible);
  }
  if (!category || category.visibility !== visibility || !localizedValue(category.handle)) {
    throw new Error(`Categoria da Placa ${String(offer.board.number).padStart(2, '0')} não ficou ${visibility} na Nuvemshop`);
  }

  const localIds = opts.clear
    ? []
    : (offer.products || []).map((row) => row.productId || (row.product && row.product.id)).filter(Boolean);
  const mappings = await prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: localIds } }, select: { localProductId: true, nuvemshopProductId: true } });
  const selected = new Set(mappings.map((row) => String(row.nuvemshopProductId)));
  const related = await ns.fetchAllPages(conn, `/products?category_id=${encodeURIComponent(category.id)}`, { perPage: 100, max: 1000 });
  const currentById = new Map(related.map((item) => [String(item.id), item]));
  const diff = categoryMembershipDiff(currentById.keys(), selected);

  // Busca os selecionados que ainda não pertencem à categoria em uma única
  // chamada (o parâmetro ids aceita até 30; uma placa aceita no máximo 24).
  if (diff.add.length) {
    const incoming = await ns.nuvemshopApi(conn, 'GET', `/products?ids=${diff.add.map(encodeURIComponent).join(',')}&per_page=30&page=1`);
    for (const item of Array.isArray(incoming) ? incoming : []) currentById.set(String(item.id), item);
  }

  for (const remoteId of [...diff.remove, ...diff.add]) {
    const product = currentById.get(String(remoteId)) || await ns.getProduct(conn, remoteId);
    const before = categoryIdsOf(product);
    const has = before.includes(Number(category.id));
    const shouldHave = selected.has(String(remoteId));
    const after = shouldHave ? Array.from(new Set([...before, Number(category.id)])) : before.filter((id) => id !== Number(category.id));
    if (has !== shouldHave) await ns.updateProduct(conn, remoteId, { categories: after });
  }

  // Verificação autoritativa: publicação só termina quando a categoria remota
  // contém exatamente a seleção solicitada.
  const verified = await ns.fetchAllPages(conn, `/products?category_id=${encodeURIComponent(category.id)}`, { perPage: 100, max: 1000 });
  const verifiedIds = new Set(verified.map((item) => String(item.id)));
  const remaining = categoryMembershipDiff(verifiedIds, selected);
  if (remaining.add.length || remaining.remove.length) {
    throw new Error(`Categoria da Placa ${String(offer.board.number).padStart(2, '0')} divergiu: faltam ${remaining.add.length}, sobram ${remaining.remove.length}`);
  }
  return { id: category.id, handle, url: storeOfferUrl(code), products: verifiedIds.size };
}

async function deleteOfferCategory(offer, conn) {
  const category = await findOfferCategory(offer, conn);
  if (!category) return { deleted: false, reason: 'category does not exist' };

  // Remove all product relationships first. This prevents an intermediate
  // storefront cache from continuing to render the old offer while the
  // category itself is being deleted.
  const related = await ns.fetchAllPages(conn, `/products?category_id=${encodeURIComponent(category.id)}`, { perPage: 100, max: 1000 });
  for (const product of related) {
    const categories = categoryIdsOf(product).filter((id) => id !== Number(category.id));
    await ns.updateProduct(conn, product.id, { categories });
  }
  const remaining = await ns.fetchAllPages(conn, `/products?category_id=${encodeURIComponent(category.id)}`, { perPage: 100, max: 1000 });
  if (remaining.length) {
    throw new Error(`Categoria da Placa ${String(offer.board.number).padStart(2, '0')} ainda tem ${remaining.length} produtos`);
  }

  await setOfferCategoryVisibility(offer, conn, category.id, false);
  await ns.nuvemshopApi(conn, 'DELETE', `/categories/${category.id}`);
  return { deleted: true, id: category.id, productsRemoved: related.length };
}

async function retireOfferExternalState(offer, conn) {
  const errors = [];
  try {
    await disableNuvemshopCoupon(offer, conn, { strict: true });
  } catch (error) {
    errors.push(`cupom: ${error.message}`);
  }
  try {
    await deleteOfferPages(offer, conn);
  } catch (error) {
    errors.push(`pagina: ${error.message}`);
  }
  if (errors.length) throw new Error(errors.join(' | '));
}

async function expireOffer(offer, conn) {
  await retireOfferExternalState(offer, conn);
  return prisma.qROffer.update({ where: { id: offer.id }, data: { status: 'EXPIRED' } });
}

async function scheduleOffer(offer, conn) {
  const errors = [];
  try { await disableNuvemshopCoupon(offer, conn, { strict: true }); }
  catch (error) { errors.push(`cupom: ${error.message}`); }
  try { await deleteOfferPages(offer, conn); }
  catch (error) { errors.push(`pagina: ${error.message}`); }
  if (errors.length) throw new Error(errors.join(' | '));
  if (offer.nsCouponId) {
    const products = await remoteOfferProductIds(offer);
    await ns.updateCoupon(conn, offer.nsCouponId, {
      code: offer.couponCode,
      discountPct: QR_OFFER_DISCOUNT_PCT,
      valid: false,
      startDate: offer.startsAt,
      endDate: offer.endsAt,
      products,
    });
  }
  return prisma.qROffer.update({
    where: { id: offer.id },
    data: {
      status: 'SCHEDULED',
      title: qrOfferTitle(offer.board.number),
      discountPct: QR_OFFER_DISCOUNT_PCT,
    },
  });
}

async function activateOffer(offer, conn) {
  await deleteOfferPages(offer, conn);
  const products = await remoteOfferProductIds(offer);
  const opts = {
    code: offer.couponCode,
    discountPct: QR_OFFER_DISCOUNT_PCT,
    valid: false,
    startDate: offer.startsAt,
    endDate: offer.endsAt,
    products,
  };
  const coupon = offer.nsCouponId
    ? await ns.updateCoupon(conn, offer.nsCouponId, opts)
    : await ns.createCoupon(conn, opts);
  const couponId = coupon?.id != null ? String(coupon.id) : offer.nsCouponId;
  if (!couponId) throw new Error('A Nuvemshop não confirmou o ID do cupom');
  await ns.setCouponValid(conn, couponId, true);
  try {
    return await prisma.qROffer.update({
      where: { id: offer.id },
      data: {
        status: 'ACTIVE',
        nsCouponId: couponId,
        title: qrOfferTitle(offer.board.number),
        discountPct: QR_OFFER_DISCOUNT_PCT,
      },
    });
  } catch (err) {
    try { await ns.setCouponValid(conn, couponId, false); } catch (_) {}
    throw err;
  }
}

async function reconcileQROffers(now = new Date()) {
  const conn = await activeConnection();
  if (!conn) return { processed: 0, activated: 0, scheduled: 0, expired: 0, errors: ['Nuvemshop não conectada'] };
  const offers = await prisma.qROffer.findMany({
    where: { status: { in: ['ACTIVE', 'SCHEDULED'] } },
    orderBy: { startsAt: 'asc' },
    include: { board: true, products: { include: { product: true } } },
  });
  const result = {
    processed: offers.length,
    activated: 0,
    scheduled: 0,
    expired: 0,
    staleCategoriesDeleted: 0,
    stalePagesDeleted: 0,
    staleCouponsDisabled: 0,
    normalizedDiscounts: 0,
    storefrontPromotionsDisabled: 0,
    storefrontPromotionCleanupError: null,
    qrDiscountPromotionReady: !!qrDiscountPromotionId,
    qrDiscountPromotionCreated: false,
    qrDiscountCallbackConfigured: !!qrDiscountPromotionId,
    qrDiscountPromotionError: null,
    qrDiscountEligiblePlates: 0,
    errors: [],
  };

  // O site normal nao deve manter ofertas automaticas ou progressivas. Os
  // unicos descontos ativos ficam restritos aos identificadores internos das
  // placas, aplicados somente quando o cliente entra pelo respectivo QR.
  if (!storefrontPromotionsReconciled) {
    try {
      result.storefrontPromotionsDisabled = await disableStorefrontPromotions(conn);
      storefrontPromotionsReconciled = true;
    } catch (error) {
      // Algumas instalacoes antigas nao receberam o escopo de Promotions.
      // Mantemos o QR operacional e deixamos o diagnostico explicito no health.
      result.storefrontPromotionCleanupError = error.message;
    }
  }
  if (!qrDiscountPromotionReconciled) {
    try {
      const promotion = await ensureQrDiscountPromotion(conn);
      result.qrDiscountPromotionReady = promotion.ready;
      result.qrDiscountPromotionCreated = promotion.created;
      result.qrDiscountCallbackConfigured = promotion.callbackConfigured;
      qrDiscountPromotionReconciled = true;
    } catch (error) {
      result.qrDiscountPromotionError = error.message;
    }
  }
  for (const offer of offers) {
    try {
      const state = offerState(offer, now);
      if (state === 'EXPIRED') {
        await expireOffer(offer, conn);
        result.expired++;
      } else if (state === 'SCHEDULED' && offer.status !== 'SCHEDULED') {
        await scheduleOffer(offer, conn);
        result.scheduled++;
      } else if (state === 'ACTIVE' && offer.status !== 'ACTIVE') {
        await activateOffer(offer, conn);
        result.activated++;
      } else if (
        Number(offer.discountPct) !== QR_OFFER_DISCOUNT_PCT
        || offer.title !== qrOfferTitle(offer.board.number)
      ) {
        if (state === 'ACTIVE') await activateOffer(offer, conn);
        else await scheduleOffer(offer, conn);
        result.normalizedDiscounts++;
      }
    } catch (err) {
      result.errors.push({ offerId: offer.id, plate: offer.board && offer.board.number, error: err.message });
    }
  }
  try {
    result.qrDiscountEligiblePlates = await refreshQrDiscountEligibility(offers, now);
  } catch (error) {
    result.errors.push({ offerId: null, plate: null, error: `cache promocao QR: ${error.message}` });
  }

  // A deployment of the legacy code may have marked the database offer as
  // expired after cleaning a different connected store. Reconcile each board
  // with no current offer once per process so those orphan storefront pages
  // and their historical coupons are removed from the real target store too.
  const livePlates = new Set(
    offers.filter((offer) => offerState(offer, now) !== 'EXPIRED').map((offer) => offer.board.number),
  );
  for (let number = 1; number <= PLATE_COUNT; number++) {
    if (livePlates.has(number)) {
      staleBoardsReconciled.delete(number);
      continue;
    }
    if (staleBoardsReconciled.has(number)) continue;
    try {
      const historical = await prisma.qROffer.findMany({
        where: { board: { number }, nsCouponId: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: { board: true },
      });
      for (const old of historical) {
        await disableNuvemshopCoupon(old, conn, { strict: true });
        result.staleCouponsDisabled++;
      }
      const placeholder = {
        board: { number },
        title: 'Oferta encerrada',
        discountPct: 0,
        couponCode: '',
      };
      const deleted = await deleteOfferCategory(placeholder, conn);
      if (deleted.deleted) result.staleCategoriesDeleted++;
      const deletedPages = await deleteOfferPages(placeholder, conn);
      result.stalePagesDeleted += deletedPages.deleted;
      staleBoardsReconciled.add(number);
    } catch (err) {
      result.errors.push({ plate: number, phase: 'stale-cleanup', error: err.message });
    }
  }
  return result;
}

const AUTO_RESTORE_MARKER = '[qr-auto-restore:v1]';

function physicalStockUnits(product) {
  return (product.sizes || []).reduce(
    (total, size) => total + (size.storeStocks || []).reduce(
      (sum, stock) => sum + Math.max(0, Number(stock.stock) || 0),
      0,
    ),
    0,
  );
}

function remoteProductImage(remote) {
  const images = Array.isArray(remote?.images) ? remote.images : [];
  for (const image of images) {
    const src = String(image?.src || '').trim();
    if (/^https:\/\//i.test(src)) return src;
  }
  return null;
}

function allocateExclusiveProductIds(preferredIds, poolIds, usedIds, limit = 24) {
  const selected = [];
  for (const id of [...(preferredIds || []), ...(poolIds || [])]) {
    const normalized = String(id || '');
    if (!normalized || usedIds.has(normalized) || selected.includes(normalized)) continue;
    selected.push(normalized);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function eligibleOfferProductPool() {
  const products = await prisma.product.findMany({
    where: {
      active: true,
      price: { gt: 0 },
      AND: [{ imageUrl: { not: null } }, { imageUrl: { not: '' } }],
      sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
    },
    select: {
      id: true,
      updatedAt: true,
      sizes: { select: { storeStocks: { select: { stock: true } } } },
    },
  });
  if (!products.length) return [];
  const mappings = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: products.map((product) => product.id) } },
    select: { localProductId: true, nuvemshopProductId: true },
  });
  if (Date.now() >= remotePublishedCache.expiresAt) {
    const conn = await activeConnection();
    if (!conn) throw new Error('Nuvemshop não está conectada para validar produtos publicados');
    const remoteProducts = await ns.fetchAllPages(
      conn,
      '/products?published=true&fields=id,handle,images,published',
      { perPage: 100, max: 10000 },
    );
    const ids = new Set();
    for (const remote of remoteProducts) {
      if (remote?.published === false || remote?.id == null) continue;
      const remoteId = String(remote.id);
      const image = remoteProductImage(remote);
      if (!image) continue;
      ids.add(remoteId);
      const handle = typeof remote.handle === 'object' ? (remote.handle.pt || Object.values(remote.handle)[0]) : remote.handle;
      if (handle) handleCache.set(remoteId, String(handle));
      remoteImageCache.set(remoteId, image);
    }
    remotePublishedCache = { expiresAt: Date.now() + REMOTE_PUBLISHED_CACHE_MS, ids };
  }
  const published = new Set(
    mappings
      .filter((mapping) => remotePublishedCache.ids.has(String(mapping.nuvemshopProductId)))
      .map((mapping) => String(mapping.localProductId)),
  );
  return products
    .filter((product) => published.has(String(product.id)))
    .sort((a, b) => physicalStockUnits(b) - physicalStockUnits(a)
      || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function restoreExclusiveOffers(now = new Date()) {
  const result = {
    checked: PLATE_COUNT,
    eligibleProducts: 0,
    published: 0,
    retried: 0,
    skippedActive: 0,
    skippedCancelled: 0,
    skippedDraft: 0,
    replacedInvalid: 0,
    errors: [],
  };
  if (process.env.DISABLE_QR_AUTO_RESTORE === '1') return { ...result, disabled: true };

  const boards = await ensureBoards();
  const states = [];
  for (const board of boards) {
    const [current, latest] = await Promise.all([
      prisma.qROffer.findFirst({
        where: {
          boardId: board.id,
          status: { in: ['ACTIVE', 'SCHEDULED'] },
          endsAt: { gt: now },
        },
        orderBy: { startsAt: 'desc' },
        include: { board: true, products: { include: { product: true } } },
      }),
      prisma.qROffer.findFirst({
        where: { boardId: board.id },
        orderBy: { createdAt: 'desc' },
        include: { board: true, products: { orderBy: { position: 'asc' }, include: { product: true } } },
      }),
    ]);
    states.push({ board, current, latest });
  }

  const pool = await eligibleOfferProductPool();
  result.eligibleProducts = pool.length;
  const poolIds = pool.map((product) => product.id);
  const eligibleIds = new Set(poolIds);

  for (const state of states) {
    if (!state.current || !String(state.current.notes || '').includes(AUTO_RESTORE_MARKER)) continue;
    const currentIds = (state.current.products || []).map((row) => String(row.productId));
    const valid = currentIds.length === 24 && currentIds.every((id) => eligibleIds.has(id));
    if (valid) continue;
    try {
      const conn = await activeConnection();
      if (!conn) throw new Error('Nuvemshop não está conectada');
      await retireOfferExternalState(state.current, conn);
      await prisma.qROffer.update({ where: { id: state.current.id }, data: { status: 'EXPIRED' } });
      state.current = null;
      result.replacedInvalid++;
    } catch (error) {
      state.blocked = true;
      result.errors.push({ plate: state.board.number, phase: 'replace-invalid', error: error.message });
    }
  }

  const usedIds = new Set();
  for (const state of states) {
    if (state.blocked) continue;
    for (const row of state.current?.products || []) usedIds.add(String(row.productId));
  }

  for (const { board, current, latest, blocked } of states) {
    if (blocked) continue;
    if (current) {
      result.skippedActive++;
      continue;
    }
    if (!latest) {
      result.errors.push({ plate: board.number, error: 'placa sem oferta historica para restaurar' });
      continue;
    }
    if (latest.status === 'CANCELLED') {
      // An explicit cancellation is a business decision and must never be
      // undone by the automatic continuity repair.
      result.skippedCancelled++;
      continue;
    }
    if (latest.status === 'DRAFT' && !String(latest.notes || '').includes(AUTO_RESTORE_MARKER)) {
      result.skippedDraft++;
      continue;
    }

    try {
      if (latest.status === 'DRAFT' && String(latest.notes || '').includes(AUTO_RESTORE_MARKER)) {
        const draftIds = (latest.products || []).map((row) => String(row.productId));
        const reusable = offerState(latest, now) !== 'EXPIRED'
          && draftIds.length === 24
          && draftIds.every((id) => eligibleIds.has(id) && !usedIds.has(id));
        if (reusable) {
          await selectedProducts(draftIds);
          await publishOffer(latest);
          for (const productId of draftIds) usedIds.add(productId);
          result.retried++;
          result.published++;
          continue;
        }
        // A partially published draft can outlive its stock or its 24-hour
        // window. Retire only this internal recovery draft and build a fresh
        // one from the current eligible catalog below.
        await prisma.qROffer.update({ where: { id: latest.id }, data: { status: 'EXPIRED' } });
      }

      const preferred = (latest.products || [])
        .map((row) => String(row.productId))
        .filter((id) => eligibleIds.has(id));
      const productIds = allocateExclusiveProductIds(preferred, poolIds, usedIds, 24);
      if (productIds.length < 24) {
        throw new Error(`somente ${productIds.length} produtos exclusivos elegiveis; minimo 24`);
      }
      await selectedProducts(productIds);

      const durationHours = Math.min(Math.max(Number(latest.durationHours) || DEFAULT_DURATION_HOURS, 1), 24);
      const discountPct = QR_OFFER_DISCOUNT_PCT;
      const startsAt = new Date(now);
      const endsAt = new Date(startsAt.getTime() + durationHours * 60 * 60 * 1000);
      const title = qrOfferTitle(board.number);
      const notes = `${AUTO_RESTORE_MARKER} source=${latest.id}`;
      const offer = await prisma.qROffer.create({
        data: {
          boardId: board.id,
          title,
          status: 'DRAFT',
          startsAt,
          endsAt,
          durationHours,
          discountPct,
          freeExchange: latest.freeExchange !== false,
          notes,
          products: {
            create: productIds.map((productId, position) => ({ productId, position })),
          },
        },
        include: { board: true, products: { orderBy: { position: 'asc' }, include: { product: true } } },
      });
      await publishOffer(offer);
      for (const productId of productIds) usedIds.add(productId);
      result.published++;
    } catch (error) {
      result.errors.push({ plate: board.number, error: error.message });
    }
  }
  return result;
}

// ---------------- ADMIN ----------------
adminRouter.use(authMiddleware, adminMiddleware);

adminRouter.get('/plates', async (_req, res) => {
  try {
    const boards = await ensureBoards();
    const now = new Date();
    const out = [];
    for (const board of boards) {
      const current = await prisma.qROffer.findFirst({ where: { boardId: board.id, status: { in: ['ACTIVE', 'SCHEDULED'] } }, orderBy: { startsAt: 'desc' }, include: { _count: { select: { products: true } } } });
      const qrUrl = fixedQrUrl(board.code);
      out.push({ number: board.number, code: board.code, label: board.label, fixedUrl: qrUrl, destinationUrl: qrUrl, qrSvgUrl: `/qr-ofertas/${board.code}?format=svg`, qrPngUrl: `/qr-ofertas/${board.code}?format=png`, qrDataUrl: await QRCode.toDataURL(qrUrl, { margin: 4, width: 1000, errorCorrectionLevel: 'H' }), current: current ? { id: current.id, title: current.title, status: offerState(current, now), startsAt: current.startsAt, endsAt: current.endsAt, discountPct: current.discountPct, couponCode: current.couponCode, products: current._count.products } : null });
    }
    res.json({ boards: out, publicBase: PUBLIC_BASE, storeBase: STORE_BASE, qrDestination: 'exclusive-offer-page' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/reconcile', async (_req, res) => {
  try {
    const result = await reconcileQROffers();
    res.status(result.errors.length ? 207 : 200).json(result);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

adminRouter.get('/products', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const products = await prisma.product.findMany({
      where: {
        active: true, price: { gt: 0 },
        AND: [{ imageUrl: { not: null } }, { imageUrl: { not: '' } }],
        ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { brand: { contains: search, mode: 'insensitive' } }, { sku: { contains: search, mode: 'insensitive' } }] } : {}),
        sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } },
      },
      orderBy: { updatedAt: 'desc' }, take: 80,
      select: { id: true, sku: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true },
    });
    const mappings = await prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: products.map((p) => p.id) } }, select: { localProductId: true } });
    const published = new Set(mappings.map((m) => m.localProductId));
    res.json({ products: products.filter((p) => published.has(p.id)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/offers', async (req, res) => {
  try {
    const where = req.query.plate ? { board: { number: plateNumber(req.query.plate) || -1 } } : {};
    const offers = await prisma.qROffer.findMany({ where, orderBy: { createdAt: 'desc' }, include: { board: true, products: { orderBy: { position: 'asc' }, include: { product: { select: { id: true, name: true, brand: true, imageUrl: true, price: true, promoPrice: true } } } } } });
    res.json({ offers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/plates/:plate/sync-category', async (req, res) => {
  try {
    const n = plateNumber(req.params.plate);
    if (!n) return res.status(400).json({ error: 'Placa deve ser entre 01 e 12' });
    const offer = await prisma.qROffer.findFirst({ where: { board: { number: n }, status: 'ACTIVE' }, orderBy: { startsAt: 'desc' }, include: { board: true, products: { include: { product: true } } } });
    if (!offer) return res.status(404).json({ error: 'A placa não tem oferta ativa' });
    const conn = await activeConnection();
    if (!conn) return res.status(502).json({ error: 'Nuvemshop não está conectada' });
    const products = await remoteOfferProductIds(offer);
    if (!offer.nsCouponId) return res.status(409).json({ error: 'A oferta ainda não tem cupom publicado' });
    const coupon = await ns.updateCoupon(conn, offer.nsCouponId, {
      code: offer.couponCode,
      discountPct: QR_OFFER_DISCOUNT_PCT,
      valid: true,
      startDate: offer.startsAt,
      endDate: offer.endsAt,
      products,
    });
    res.json({ coupon, products: products.length, destinationUrl: fixedQrUrl(plateCode(n)) });
  } catch (e) { res.status(502).json({ error: 'Não foi possível sincronizar a oferta da placa', detail: e.message }); }
});

adminRouter.post('/offers', async (req, res) => {
  try {
    const n = plateNumber(req.body.plate);
    if (!n) return res.status(400).json({ error: 'Placa deve ser entre 01 e 12' });
    const body = validateBody(req.body);
    const ids = normalizeProductIds(req.body.productIds);
    await selectedProducts(ids);
    const board = (await ensureBoards())[n - 1];
    const offer = await prisma.qROffer.create({ data: { boardId: board.id, ...body, products: { create: ids.map((productId, position) => ({ productId, position })) } }, include: { board: true, products: { include: { product: true } } } });
    res.json({ offer });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

adminRouter.put('/offers/:id', async (req, res) => {
  try {
    const existing = await getOffer(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Oferta não encontrada' });
    if (existing.status === 'ACTIVE' && existing.nsCouponId) return res.status(409).json({ error: 'Oferta publicada: crie uma nova oferta para trocar os produtos sem perder o histórico' });
    const body = validateBody(req.body);
    const ids = normalizeProductIds(req.body.productIds);
    await selectedProducts(ids);
    await prisma.qROfferProduct.deleteMany({ where: { offerId: existing.id } });
    const offer = await prisma.qROffer.update({ where: { id: existing.id }, data: { ...body, products: { create: ids.map((productId, position) => ({ productId, position })) } }, include: { board: true, products: { include: { product: true } } } });
    res.json({ offer });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

adminRouter.post('/offers/:id/publish', async (req, res) => {
  try {
    const offer = await getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
    if (new Date(offer.endsAt) <= new Date()) return res.status(400).json({ error: 'A validade da oferta já terminou' });
    const updated = await publishOffer(offer);
    res.json({ offer: updated, fixedUrl: fixedQrUrl(offer.board.code), destinationUrl: fixedQrUrl(offer.board.code) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

adminRouter.post('/offers/:id/cancel', async (req, res) => {
  try {
    const offer = await getOffer(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
    const conn = await activeConnection();
    if (!conn) return res.status(502).json({ error: 'Nuvemshop não está conectada' });
    await retireOfferExternalState(offer, conn);
    const updated = await prisma.qROffer.update({ where: { id: offer.id }, data: { status: 'CANCELLED' } });
    res.json({ offer: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- PUBLIC ----------------
// Callback da Discounts API da Nuvemshop. A origem e a oferta ficam marcadas
// como UTM no clique/POST da placa, sem campo de cupom para o consumidor.
publicRouter.post('/api/nuvemshop/discounts/qr-offers', async (req, res) => {
  try {
    const payload = req.body || {};
    if (!qrDiscountPromotionId || !qrDiscountStoreId) return res.sendStatus(204);
    if (String(payload.store_id || '') !== qrDiscountStoreId) return res.sendStatus(204);
    if (payload.execution_tier && payload.execution_tier !== 'line_item') return res.sendStatus(204);

    const marker = qrMarkerFromCart(payload);
    const eligibility = marker ? qrDiscountEligibility.get(marker.plate) : null;
    const now = Date.now();
    const valid = !!(
      eligibility
      && marker.offerId
      && marker.offerId === eligibility.offerId
      && now >= eligibility.startsAt
      && now < eligibility.endsAt
    );
    const commands = buildQrDiscountCommands(
      payload,
      qrDiscountPromotionId,
      valid ? eligibility.remoteProductIds : new Set(),
    );
    if (!commands.length) return res.sendStatus(204);
    res.set('Cache-Control', 'no-store');
    return res.json({ commands });
  } catch (error) {
    // O contrato tem limite curto. Em qualquer falha, nao aplicar desconto e
    // deixar a proxima alteracao do carrinho tentar novamente e mais seguro.
    console.error('[qr-offers/discount-callback]', error.message);
    return res.sendStatus(204);
  }
});

publicRouter.get('/api/qr-offers/plates/:plate', async (req, res) => {
  try {
    const n = plateNumber(req.params.plate);
    if (!n) return res.status(404).json({ error: 'Placa inválida' });
    const { board, offer } = await findOfferByPlate(n);
    res.set('Cache-Control', 'no-store');
    res.json({ board: board ? { number: board.number, code: board.code, label: board.label } : { number: n, code: plateCode(n) }, offer });
  } catch (e) { res.status(500).json({ error: 'Não foi possível carregar a oferta' }); }
});

publicRouter.get('/qr-ofertas-folha', async (_req, res) => {
  try {
    const boards = await ensureBoards();
    const cards = boards.map((board) => {
      const code = board.code;
      const destinationUrl = fixedQrUrl(code);
      const svgUrl = `/qr-ofertas/${code}?format=svg`;
      const pngUrl = `/qr-ofertas/${code}?format=png`;
      return `<article><div class="head">OFERTA DE HOJE<br><small>PLACA ${String(board.number).padStart(2, '0')}</small></div><img src="${svgUrl}" alt="QR ${code}"><strong>${destinationUrl}</strong><small class="fixed">QR vetorial · pronto para grande formato</small><div class="downloads"><a href="${svgUrl}" download="sports-tennis-${code}.svg">Baixar SVG</a><a href="${pngUrl}" download="sports-tennis-${code}.png">PNG 2400px</a></div></article>`;
    });
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>12 QR — Sports &amp; Tennis</title><style>@page{size:A4;margin:10mm}body{font-family:Arial,sans-serif;margin:0;color:#111}.toolbar{padding:12px 0;text-align:right}.toolbar button{padding:9px 15px;border:0;border-radius:7px;background:#f4511e;color:#fff;font-weight:800;cursor:pointer}.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}article{border:1px solid #ddd;min-height:76mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4mm;box-sizing:border-box;break-inside:avoid}.head{font-size:15px;font-weight:900;color:#fff;background:#f4511e;width:100%;padding:7px 0;line-height:1.25}.head small{font-size:10px}.sheet img{width:42mm;height:42mm;margin:4mm 0;image-rendering:pixelated}.sheet strong{font-size:7px;word-break:break-all}.fixed{font-size:8px;margin-top:2mm;color:#555}.downloads{display:flex;gap:6px;margin-top:3mm;font-size:8px}.downloads a{color:#c43d15}@media print{.toolbar,.downloads{display:none}.sheet{gap:5mm}}</style><div class="toolbar"><button onclick="window.print()">Imprimir / salvar PDF</button></div><main class="sheet">${cards.join('')}</main>`);
  } catch (e) { res.status(500).type('html').send('<h1>Não foi possível gerar a folha dos QR</h1>'); }
});

// Compatibilidade: a versão anterior continua acessível, mas a folha acima
// agora usa SVG vetorial e links individuais para PNG de alta resolução.
publicRouter.get('/qr-ofertas-folha-legacy', async (_req, res) => {
  try {
    const boards = await ensureBoards();
    const cards = [];
    for (const board of boards) {
      const qrUrl = `${PUBLIC_BASE}/oferta/${board.code}`;
      const destinationUrl = fixedQrUrl(board.code);
      const qr = await QRCode.toDataURL(qrUrl, { margin: 1, width: 420 });
      cards.push(`<article><div class="head">OFERTA DE HOJE<br><small>PLACA ${String(board.number).padStart(2, '0')}</small></div><img src="${qr}" alt="QR ${board.code}"><strong>${destinationUrl}</strong><small class="fixed">QR fixo · vitrine exclusiva</small></article>`);
    }
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>12 QR — Sports &amp; Tennis</title><style>@page{size:A4;margin:10mm}body{font-family:Arial,sans-serif;margin:0;color:#111}.toolbar{padding:12px 0;text-align:right}.toolbar button{padding:9px 15px;border:0;border-radius:7px;background:#f4511e;color:#fff;font-weight:800;cursor:pointer}.sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}article{border:1px solid #ddd;min-height:76mm;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:4mm;box-sizing:border-box;break-inside:avoid}.head{font-size:15px;font-weight:900;color:#fff;background:#f4511e;width:100%;padding:7px 0;line-height:1.25}.head small{font-size:10px}.sheet img{width:42mm;height:42mm;margin:4mm 0}.sheet strong{font-size:7px;word-break:break-all}@media print{.toolbar{display:none}.sheet{gap:5mm}}</style><div class="toolbar"><button onclick="window.print()">Imprimir / salvar PDF</button></div><main class="sheet">${cards.join('')}</main>`);
  } catch (e) { res.status(500).type('html').send('<h1>Não foi possível gerar a folha dos QR</h1>'); }
});

// Arquivos individuais para impressão: SVG é vetorial e não perde qualidade,
// enquanto o PNG de 2400px atende gráficas que exigem bitmap. A rota aceita
// ?format=svg/png para funcionar também em hospedagens que reescrevem extensões.
publicRouter.get('/qr-ofertas/:plate', async (req, res, next) => {
  const raw = String(req.params.plate || '');
  const n = plateNumber(raw);
  if (!n) return next();
  const wantsPng = String(req.query.format || '').toLowerCase() === 'png' || /\.png$/i.test(raw);
  try {
    if (wantsPng) {
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="sports-tennis-${plateCode(n)}.png"` });
      return res.send(await qrPng(plateCode(n)));
    }
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="sports-tennis-${plateCode(n)}.svg"` });
    return res.send(await qrSvg(plateCode(n)));
  } catch (e) { return next(e); }
});

publicRouter.get('/qr-ofertas/:plate.svg', async (req, res) => {
  try {
    const n = plateNumber(req.params.plate);
    if (!n) return res.status(404).type('text').send('Placa invalida');
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="sports-tennis-${plateCode(n)}.svg"` });
    res.send(await qrSvg(plateCode(n)));
  } catch (e) { res.status(500).type('text').send('QR indisponivel'); }
});

publicRouter.get('/qr-ofertas/:plate.png', async (req, res) => {
  try {
    const n = plateNumber(req.params.plate);
    if (!n) return res.status(404).type('text').send('Placa invalida');
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="sports-tennis-${plateCode(n)}.png"` });
    res.send(await qrPng(plateCode(n)));
  } catch (e) { res.status(500).type('text').send('QR indisponivel'); }
});

// Compatibilidade para placas que tenham sido impressas com uma variação
// antiga do caminho. Todas continuam levando à mesma vitrine exclusiva.
publicRouter.get([
  '/oferta/:plate',
  '/oferta/placa:plate',
  '/ofertas/:plate',
  '/ofertasplaca:plate',
  '/ofertasplaca/:plate',
  '/qr-oferta/:plate',
], async (req, res) => {
  try {
    const n = plateNumber(req.params.plate);
    if (!n) return res.status(404).type('html').send('<h1>Placa inválida</h1>');
    const { offer } = await findOfferByPlate(n);
    // A vitrine mora na URL fixa gravada no QR. O cliente ve o valor final
    // antes de abrir a loja e nao precisa copiar nem informar codigo algum.
    const productCards = offer && offer.products.length
      ? offer.products.map(offerProductCard).join('')
      : '<div class="empty">Esta placa está entre uma oferta e outra. Volte mais tarde.</div>';
    const end = offer ? new Date(offer.endsAt).toISOString() : '';
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(offer ? offer.title : 'Oferta exclusiva')} — Sports & Tennis</title><style>body{margin:0;background:#fff5ee;color:#21150f;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:960px;margin:auto;padding:18px 16px 48px}.brand{color:#f4511e;font-weight:900;letter-spacing:.5px}.hero{background:linear-gradient(135deg,#f4511e,#ff7b45);color:white;border-radius:22px;padding:26px 24px;margin:12px 0 16px;box-shadow:0 12px 30px #6b3b1c24}.hero h1{font-size:clamp(26px,5vw,46px);line-height:1.05;margin:10px 0}.hero p{font-size:17px;line-height:1.45;margin:8px 0}.badge{display:inline-block;background:white;color:#df3e12;border-radius:999px;padding:7px 12px;font-weight:900}.count{display:inline-block;background:#822500;color:#fff;border-radius:10px;padding:10px 12px;font-size:18px;font-weight:900;margin-top:14px}.fast{background:#fff;border-left:5px solid #f4511e;border-radius:14px;padding:14px 16px;margin:0 0 18px;font-weight:800}.products{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.product{background:white;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px #6b3b1c16}.product img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fafafa}.product>div{padding:16px}.product small{color:#7d6f68;font-weight:800}.product h2{font-size:17px;min-height:44px;margin:8px 0}.pricing{display:flex;flex-direction:column;gap:3px;margin:12px 0}.original{font-size:14px;color:#74665f;text-decoration:line-through}.exclusive{font-size:25px;line-height:1.05;color:#df3e12}.saving{font-size:12px;color:#08783e;font-weight:900}.product a{display:block;text-align:center;background:#f4511e;color:white;text-decoration:none;border-radius:12px;padding:14px 10px;font-size:15px;font-weight:900;box-shadow:0 6px 14px #f4511e35}.empty{text-align:center;background:white;border-radius:18px;padding:40px 18px}.exchange{margin:14px 0;padding:12px 16px;background:#fff;border-radius:14px;font-weight:700}@media(max-width:600px){.wrap{padding:12px 10px 32px}.hero{padding:22px 17px;border-radius:16px}.products{grid-template-columns:1fr;gap:12px}.product{display:grid;grid-template-columns:42% 58%;align-items:stretch}.product img{height:100%;min-height:210px}.product>div{padding:13px}.product h2{font-size:15px;min-height:0}.exclusive{font-size:23px}.product a{padding:13px 8px}}</style></head><body><main class="wrap"><div class="brand">SPORTS &amp; TENNIS · OFERTA QR ${String(n).padStart(2, '0')}</div>${offer ? `<section class="hero"><span class="badge">PREÇO EXCLUSIVO DA PLACA</span><h1>${escapeHtml(offer.title)}</h1><p>O valor com 30% OFF já aparece em cada produto. Escolha o tamanho e compre antes do contador zerar.</p><div class="count" id="count">Calculando o tempo restante…</div></section><div class="fast">Compra rápida: toque no produto, escolha o tamanho e finalize. O desconto é aplicado automaticamente.</div>${offer.freeExchange ? '<div class="exchange">↺ Troca grátis garantida pela Sports &amp; Tennis.</div>' : ''}` : `<section class="hero"><span class="badge">PLACA ${String(n).padStart(2, '0')}</span><h1>Oferta exclusiva em breve</h1><p>Esta placa recebe uma seleção nova todos os dias. Aponte a câmera novamente mais tarde.</p></section>`}<section class="products">${productCards}</section></main>${offer ? `<script>const end=${JSON.stringify(end)};function tick(){const d=Math.max(0,new Date(end)-new Date()),h=Math.floor(d/36e5),m=Math.floor(d%36e5/6e4),s=Math.floor(d%6e4/1e3);document.getElementById('count').textContent=d?'Oferta termina em '+h+'h '+m+'min '+s+'s':'Oferta encerrada';}tick();setInterval(tick,1000)</script>` : ''}</body></html>`);
  } catch (e) { console.error('[qr-offers/public]', e.message); res.status(500).type('html').send('<h1>Oferta temporariamente indisponível</h1>'); }
});

module.exports = {
  adminRouter,
  publicRouter,
  ensureBoards,
  reconcileQROffers,
  restoreExclusiveOffers,
  _test: {
    QR_OFFER_DISCOUNT_PCT,
    QR_DISCOUNT_PROMOTION_NAME,
    plateNumber,
    plateCode,
    qrOfferTitle,
    offerBasePrice,
    offerDiscountedPrice,
    promotionRows,
    qrMarkerFromCart,
    buildQrDiscountCommands,
    quickBuyMarkup,
    normalizeProductIds,
    offerState,
    categoryMembershipDiff,
    pagesFromResponse,
    physicalStockUnits,
    remoteProductImage,
    allocateExclusiveProductIds,
  },
};
