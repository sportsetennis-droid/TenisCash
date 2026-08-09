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
const handleCache = new Map();
// Saída para gráfica: H recupera até ~30% de dano e SVG não perde resolução.
const QR_PRINT_OPTIONS = { errorCorrectionLevel: 'H', margin: 4 };
const QR_PRINT_PNG_WIDTH = 2400;
const staleBoardsReconciled = new Set();

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

async function resolveHandle(nuvemshopProductId) {
  const id = String(nuvemshopProductId || '');
  if (!id) return null;
  if (handleCache.has(id)) return handleCache.get(id);
  try {
    const conn = await activeConnection();
    if (!conn) return null;
    const store = conn.storeId || conn.nuvemshopUserId;
    const url = `https://api.tiendanube.com/v1/${store}/products/${encodeURIComponent(id)}?fields=id,handle`;
    const r = await fetch(url, { headers: { Authentication: `bearer ${conn.accessToken}`, 'User-Agent': 'Sports&Tennis QR Offers/1.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const handle = typeof data.handle === 'object' ? (data.handle.pt || Object.values(data.handle)[0]) : data.handle;
    if (handle) handleCache.set(id, String(handle));
    return handle ? String(handle) : null;
  } catch (e) {
    console.warn('[qr-offers] resolve handle:', e.message);
    return null;
  }
}

async function productView(product, couponCode) {
  const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: product.id } });
  const handle = mapping ? await resolveHandle(mapping.nuvemshopProductId) : null;
  const direct = handle ? `${STORE_BASE}/produtos/${encodeURIComponent(handle)}/` : `${STORE_BASE}/search/?q=${encodeURIComponent(product.name)}`;
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    imageUrl: product.imageUrl,
    price: product.price,
    promoPrice: product.promoPrice,
    storeUrl: couponCode ? `${direct}${direct.includes('?') ? '&' : '?'}coupon=${encodeURIComponent(couponCode)}` : direct,
  };
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
        include: { products: { orderBy: { position: 'asc' }, include: { product: true } } },
      },
    },
  });
  const raw = board && board.offers && board.offers[0];
  if (!raw || offerState(raw) !== 'ACTIVE') return { board, offer: null };
  const products = [];
  for (const row of raw.products || []) {
    if (!row.product || !row.product.active) continue;
    products.push(await productView(row.product, raw.couponCode));
  }
  return { board, offer: { ...raw, products } };
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
  const discountPct = Number(body.discountPct);
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 80) throw new Error('Desconto deve ficar entre 0% e 80%');
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
  const preparedOffer = { ...offer, couponCode: code, status: state };

  // A primeira versao das placas usava paginas customizadas com o mesmo
  // handle da categoria. Elas prevalecem no storefront e precisam sair antes
  // que uma oferta nova possa ser publicada nesse endereco.
  await deleteOfferPages(preparedOffer, conn);

  // Prepara a categoria escondida e CONFIRMA a lista exata antes de ativar o
  // cupom. A versão anterior respondia sucesso e deixava esta sincronização
  // rodando em background, o que gerava categorias parcialmente atualizadas.
  const category = await syncOfferCategory(preparedOffer, conn, { visible: false });
  const couponOpts = {
    code,
    discountPct: offer.discountPct,
    valid: false,
    startDate: offer.startsAt,
    endDate: offer.endsAt,
    categories: [category.id],
  };

  let coupon;
  let couponId = offer.nsCouponId || null;
  try {
    coupon = offer.nsCouponId
      ? await ns.updateCoupon(conn, offer.nsCouponId, couponOpts)
      : await ns.createCoupon(conn, couponOpts);
    couponId = coupon?.id != null ? String(coupon.id) : couponId;
    if (couponId == null) throw new Error('A Nuvemshop não confirmou o ID do cupom');
    await deactivateBoardOffers(offer.boardId, offer.id, conn);
    if (state === 'ACTIVE') {
      await ns.setCouponValid(conn, couponId, true);
      await setOfferCategoryVisibility(preparedOffer, conn, category.id, true);
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
        couponCode: code,
        nsCouponId: couponId,
        publishedAt: new Date(),
      },
    });
  } catch (err) {
    if (couponId != null) {
      try { await ns.setCouponValid(conn, couponId, false); } catch (_) {}
    }
    try { await setOfferCategoryVisibility(preparedOffer, conn, category.id, false); } catch (_) {}
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
    const payload = await ns.nuvemshopApi(conn, 'GET', `/pages?page=${page}&per_page=100`);
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
    await ns.nuvemshopApi(conn, 'DELETE', `/pages/${page.id}`);
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
    await deleteOfferCategory(offer, conn);
  } catch (error) {
    errors.push(`categoria: ${error.message}`);
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
  let category = null;
  try {
    await deleteOfferPages(offer, conn);
    category = await syncOfferCategory(offer, conn, { visible: false });
  }
  catch (error) { errors.push(`categoria: ${error.message}`); }
  if (errors.length) throw new Error(errors.join(' | '));
  if (offer.nsCouponId) {
    await ns.updateCoupon(conn, offer.nsCouponId, {
      code: offer.couponCode,
      discountPct: offer.discountPct,
      valid: false,
      startDate: offer.startsAt,
      endDate: offer.endsAt,
      categories: [category.id],
    });
  }
  return prisma.qROffer.update({ where: { id: offer.id }, data: { status: 'SCHEDULED' } });
}

async function activateOffer(offer, conn) {
  await deleteOfferPages(offer, conn);
  const category = await syncOfferCategory(offer, conn, { visible: false });
  const opts = {
    code: offer.couponCode,
    discountPct: offer.discountPct,
    valid: false,
    startDate: offer.startsAt,
    endDate: offer.endsAt,
    categories: [category.id],
  };
  const coupon = offer.nsCouponId
    ? await ns.updateCoupon(conn, offer.nsCouponId, opts)
    : await ns.createCoupon(conn, opts);
  const couponId = coupon?.id != null ? String(coupon.id) : offer.nsCouponId;
  if (!couponId) throw new Error('A Nuvemshop não confirmou o ID do cupom');
  await ns.setCouponValid(conn, couponId, true);
  try {
    await setOfferCategoryVisibility(offer, conn, category.id, true);
    return await prisma.qROffer.update({
      where: { id: offer.id },
      data: { status: 'ACTIVE', nsCouponId: couponId },
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
    errors: [],
  };
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
      }
    } catch (err) {
      result.errors.push({ offerId: offer.id, plate: offer.board && offer.board.number, error: err.message });
    }
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
      out.push({ number: board.number, code: board.code, label: board.label, fixedUrl: qrUrl, destinationUrl: storeOfferUrl(board.code), qrSvgUrl: `/qr-ofertas/${board.code}?format=svg`, qrPngUrl: `/qr-ofertas/${board.code}?format=png`, qrDataUrl: await QRCode.toDataURL(qrUrl, { margin: 4, width: 1000, errorCorrectionLevel: 'H' }), current: current ? { id: current.id, title: current.title, status: offerState(current, now), startsAt: current.startsAt, endsAt: current.endsAt, discountPct: current.discountPct, couponCode: current.couponCode, products: current._count.products } : null });
    }
    res.json({ boards: out, publicBase: PUBLIC_BASE, storeBase: STORE_BASE, qrDestination: 'store' });
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
    const category = await syncOfferCategory(offer, conn);
    res.json({ category, destinationUrl: storeOfferUrl(plateCode(n), offer.couponCode) });
  } catch (e) { res.status(502).json({ error: 'Não foi possível sincronizar a categoria da placa', detail: e.message }); }
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
    res.json({ offer: updated, fixedUrl: `${PUBLIC_BASE}/oferta/${offer.board.code}`, destinationUrl: storeOfferUrl(offer.board.code, updated.couponCode) });
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
      const destinationUrl = storeOfferUrl(code);
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
      const destinationUrl = storeOfferUrl(board.code);
      const qr = await QRCode.toDataURL(qrUrl, { margin: 1, width: 420 });
      cards.push(`<article><div class="head">OFERTA DE HOJE<br><small>PLACA ${String(board.number).padStart(2, '0')}</small></div><img src="${qr}" alt="QR ${board.code}"><strong>${destinationUrl}</strong><small class="fixed">QR fixo · destino final na loja</small></article>`);
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
// antiga do caminho. Todas continuam levando à mesma categoria atual.
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
    // Redireciona os QR codes antigos para o domínio oficial da loja. O QR
    // impresso permanece igual; só a experiência final muda para a Nuvemshop.
    res.set('Cache-Control', 'no-store');
    const { offer } = await findOfferByPlate(n);
    // Sem oferta ativa, leva para a home da loja. A categoria da placa fica
    // oculta e vazia, evitando exibir desconto ou produtos vencidos.
    const target = offer ? storeOfferUrl(plateCode(n), offer.couponCode) : `${STORE_BASE}/`;
    return res.redirect(302, target);
    const { board, offer: legacyOffer } = await findOfferByPlate(n);
    const code = board ? board.code : plateCode(n);
    const productCards = offer && offer.products.length ? offer.products.map((p) => `<article class="product"><img src="${escapeHtml(p.imageUrl || '')}" alt="${escapeHtml(p.name)}"><div><small>${escapeHtml(p.brand || '')}</small><h2>${escapeHtml(p.name)}</h2><p class="price">R$ ${Number(p.promoPrice || p.price || 0).toFixed(2).replace('.', ',')}</p><a href="${escapeHtml(p.storeUrl)}">Comprar com desconto</a></div></article>`).join('') : '<div class="empty">Esta placa está entre uma oferta e outra. Volte mais tarde.</div>';
    const end = offer ? new Date(offer.endsAt).toISOString() : '';
    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(offer ? offer.title : 'Oferta exclusiva')} — Sports & Tennis</title><style>body{margin:0;background:#fff5ee;color:#21150f;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:960px;margin:auto;padding:24px 16px 48px}.brand{color:#f4511e;font-weight:900;letter-spacing:.5px}.hero{background:linear-gradient(135deg,#f4511e,#ff7b45);color:white;border-radius:22px;padding:28px 24px;margin:14px 0 18px}.hero h1{font-size:clamp(26px,5vw,46px);margin:10px 0}.hero p{font-size:17px;line-height:1.45}.badge{display:inline-block;background:white;color:#df3e12;border-radius:999px;padding:7px 12px;font-weight:900}.count{font-weight:800;margin-top:16px}.coupon{background:#fff;border:2px dashed #f4511e;border-radius:14px;padding:14px;margin-top:18px;font-weight:800}.coupon code{font-size:22px;letter-spacing:2px;color:#df3e12}.products{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.product{background:white;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px #6b3b1c16}.product img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fafafa}.product>div{padding:16px}.product small{color:#7d6f68;font-weight:800}.product h2{font-size:17px;min-height:44px}.price{font-size:22px;font-weight:900;color:#df3e12}.product a{display:block;text-align:center;background:#f4511e;color:white;text-decoration:none;border-radius:10px;padding:12px;font-weight:900}.empty{text-align:center;background:white;border-radius:18px;padding:40px 18px}.exchange{margin:18px 0;padding:14px 16px;background:#fff;border-radius:14px;font-weight:700}</style></head><body><main class="wrap"><div class="brand">SPORTS &amp; TENNIS · OFERTA QR ${String(n).padStart(2, '0')}</div>${offer ? `<section class="hero"><span class="badge">EXCLUSIVA PARA QUEM LEU A PLACA</span><h1>${escapeHtml(offer.title)}</h1><p>Escolha seu produto e finalize na loja online com o desconto desta placa.</p><div class="count" id="count">Válida por 24 horas</div><div class="coupon">Cupom da oferta: <code>${escapeHtml(offer.couponCode || '')}</code><br><small>O link de compra já leva o cupom para a Nuvemshop.</small></div></section><div class="exchange">↺ Troca grátis garantida pela Sports &amp; Tennis.</div>` : `<section class="hero"><span class="badge">PLACA ${String(n).padStart(2, '0')}</span><h1>Oferta exclusiva em breve</h1><p>Esta placa recebe uma seleção nova todos os dias. Aponte a câmera novamente mais tarde.</p></section>`}<section class="products">${productCards}</section></main>${offer ? `<script>const end=${JSON.stringify(end)};function tick(){const d=Math.max(0,new Date(end)-new Date()),h=Math.floor(d/36e5),m=Math.floor(d%36e5/6e4),s=Math.floor(d%6e4/1e3);document.getElementById('count').textContent=d?'Termina em '+h+'h '+m+'min '+s+'s':'Oferta encerrada';}tick();setInterval(tick,1000)</script>` : ''}</body></html>`);
  } catch (e) { console.error('[qr-offers/public]', e.message); res.status(500).type('html').send('<h1>Oferta temporariamente indisponível</h1>'); }
});

module.exports = {
  adminRouter,
  publicRouter,
  ensureBoards,
  reconcileQROffers,
  _test: { plateNumber, plateCode, normalizeProductIds, offerState, categoryMembershipDiff, pagesFromResponse },
};
