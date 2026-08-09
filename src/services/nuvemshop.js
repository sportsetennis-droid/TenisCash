// =====================================================================
// Nuvemshop Service — OAuth, webhook ingestion, sync
// =====================================================================
// NOTAS DE SETUP (precisa fazer no painel Nuvemshop):
//   1. Criar Partner App em https://partners.nuvemshop.com.br
//   2. Configurar Redirect URI: https://teniscash.com.br/api/nuvemshop/oauth/callback
//   3. Configurar Webhooks pointing to: https://teniscash.com.br/api/webhooks/nuvemshop
//   4. Setar env vars no Railway:
//      NUVEMSHOP_CLIENT_ID
//      NUVEMSHOP_CLIENT_SECRET
//      NUVEMSHOP_REDIRECT_URI=https://teniscash.com.br/api/nuvemshop/oauth/callback
//      NUVEMSHOP_API_BASE_URL=https://api.tiendanube.com/v1
// =====================================================================

const CLIENT_ID = process.env.NUVEMSHOP_CLIENT_ID;
const CLIENT_SECRET = process.env.NUVEMSHOP_CLIENT_SECRET;
const REDIRECT_URI = process.env.NUVEMSHOP_REDIRECT_URI;
const API_BASE = process.env.NUVEMSHOP_API_BASE_URL || 'https://api.tiendanube.com/v1';
const VERSIONED_API_BASE = process.env.NUVEMSHOP_VERSIONED_API_BASE_URL || 'https://api.tiendanube.com/2025-03';

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

function buildAuthUrl(state) {
  if (!CLIENT_ID) return null;
  // Tienda Nube usa redirect direto da loja, mas Nuvemshop BR redireciona pra:
  return `https://www.nuvemshop.com.br/apps/${CLIENT_ID}/authorize?state=${encodeURIComponent(state || '')}`;
}

async function exchangeCode(code) {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Nuvemshop OAuth não configurado');
  const res = await fetch('https://www.nuvemshop.com.br/apps/authorize/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error('OAuth Nuvemshop falhou: ' + (data.error_description || data.error || res.status));
  }
  return data; // { access_token, token_type, scope, user_id }
}

async function nuvemshopApi(connection, method, path, body = null) {
  if (!connection?.accessToken || !connection?.nuvemshopUserId) {
    throw new Error('Conexão Nuvemshop inválida');
  }
  const url = `${API_BASE}/${connection.nuvemshopUserId}${path}`;
  const opts = {
    method,
    headers: {
      'Authentication': `bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'TenisCash/1.0',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  // Retry em 429 (rate limit — Nuvemshop usa leaky bucket ~2 req/s) e 503. Sem isso, rajadas
  // de PUT/DELETE (ex: reconciliar variantes) falham silenciosamente e deixam resíduo na loja.
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, opts);
    if (res.status !== 429 && res.status !== 503) break;
    const ra = Number(res.headers.get('Retry-After')) || 0;
    const waitMs = ra > 0 ? ra * 1000 : 600 * (attempt + 1);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    throw new Error('[Nuvemshop ' + res.status + '] ' + JSON.stringify(data));
  }
  return data;
}

// New content resources such as Pages are available only on the dated API,
// while the rest of this integration still uses v1. Keep the transport
// explicit so a page request can never silently hit the legacy base URL.
async function nuvemshopVersionedApi(connection, method, path, body = null) {
  if (!connection?.accessToken || !connection?.nuvemshopUserId) {
    throw new Error('ConexÃ£o Nuvemshop invÃ¡lida');
  }
  const url = `${VERSIONED_API_BASE}/${connection.nuvemshopUserId}${path}`;
  const opts = {
    method,
    headers: {
      Authentication: `bearer ${connection.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'TenisCash/1.0',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, opts);
    if (res.status !== 429 && res.status !== 503) break;
    const retryAfter = Number(res.headers.get('Retry-After')) || 0;
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : 600 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error('[Nuvemshop ' + res.status + '] ' + JSON.stringify(data));
  return data;
}

// =====================================================================
// API helpers de alto nível
// =====================================================================

async function fetchAllPages(connection, path, { perPage = 50, max = 1000 } = {}) {
  const items = [];
  let page = 1;
  while (items.length < max) {
    const sep = path.includes('?') ? '&' : '?';
    let data;
    try {
      data = await nuvemshopApi(connection, 'GET', `${path}${sep}per_page=${perPage}&page=${page}`);
    } catch (e) {
      // Tiendanube responde 404 quando a página passa do FIM (total múltiplo exato de perPage).
      // Isso é "acabou", não erro — sem este guard, 1 página vazia derruba TODA a listagem
      // (ex: 200 categorias / per_page 100 → page 3 = 404 → loadNsCategories quebra → nenhum
      // produto sincroniza). Em página > 1, 404 = fim. Em página 1, propaga (erro real).
      if (page > 1 && /\[Nuvemshop 404\]/.test(e.message || '')) break;
      throw e;
    }
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }
  return items.slice(0, max);
}

async function listProducts(connection, opts = {}) {
  return fetchAllPages(connection, '/products', opts);
}

async function listOrders(connection, opts = {}) {
  return fetchAllPages(connection, '/orders', opts);
}

async function listCustomers(connection, opts = {}) {
  return fetchAllPages(connection, '/customers', opts);
}

async function getProduct(connection, productId) {
  return nuvemshopApi(connection, 'GET', `/products/${productId}`);
}

async function updateProduct(connection, productId, payload) {
  return nuvemshopApi(connection, 'PUT', `/products/${productId}`, payload);
}

async function deleteProduct(connection, productId) {
  return nuvemshopApi(connection, 'DELETE', `/products/${productId}`);
}

async function getOrder(connection, orderId) {
  return nuvemshopApi(connection, 'GET', `/orders/${orderId}`);
}

async function getCustomer(connection, customerId) {
  return nuvemshopApi(connection, 'GET', `/customers/${customerId}`);
}

async function listScripts(connection, opts = {}) {
  const perPage = Number(opts.perPage) || 100;
  const page = Number(opts.page) || 1;
  return nuvemshopApi(connection, 'GET', `/scripts?per_page=${perPage}&page=${page}`);
}

async function updateVariantStock(connection, productId, variantId, stock) {
  return nuvemshopApi(connection, 'PUT', `/products/${productId}/variants/${variantId}`, { stock });
}

// =====================================================================
// CUPONS — usados pelo programa Creation (afiliados)
// =====================================================================

// Monta o payload de cupom percentual padrão de um Creation.
function normalizeIdList(values) {
  if (!Array.isArray(values)) return undefined;
  return Array.from(new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0)));
}

function couponDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida para o cupom da Nuvemshop');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Fortaleza',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function buildCouponPayload({
  code,
  discountPct,
  valid = true,
  minPrice = 0,
  startDate,
  endDate,
  categories,
  products,
}) {
  const payload = {
    code: String(code),
    type: 'percentage',
    value: String(Number(discountPct).toFixed(2)),
    valid: !!valid,
    max_uses: null,
    min_price: Number(minPrice) || 0,
    includes_shipping: false,
    combines_with_other_discounts: false,
  };
  if (startDate != null) payload.start_date = couponDate(startDate);
  if (endDate != null) payload.end_date = couponDate(endDate);
  const categoryIds = normalizeIdList(categories);
  const productIds = normalizeIdList(products);
  if (categoryIds) payload.categories = categoryIds;
  if (productIds) payload.products = productIds;
  return payload;
}

async function createCoupon(connection, opts) {
  return nuvemshopApi(connection, 'POST', '/coupons', buildCouponPayload(opts));
}

async function updateCoupon(connection, couponId, opts) {
  // PUT aceita os mesmos campos; só manda o que veio
  const payload = {};
  if (opts.code != null) payload.code = String(opts.code);
  if (opts.discountPct != null) { payload.type = 'percentage'; payload.value = String(Number(opts.discountPct).toFixed(2)); }
  if (opts.valid != null) payload.valid = !!opts.valid;
  if (opts.minPrice != null) payload.min_price = Number(opts.minPrice) || 0;
  if (opts.startDate != null) payload.start_date = couponDate(opts.startDate);
  if (opts.endDate != null) payload.end_date = couponDate(opts.endDate);
  const categoryIds = normalizeIdList(opts.categories);
  const productIds = normalizeIdList(opts.products);
  if (categoryIds) payload.categories = categoryIds;
  if (productIds) payload.products = productIds;
  return nuvemshopApi(connection, 'PUT', `/coupons/${couponId}`, payload);
}

async function setCouponValid(connection, couponId, valid) {
  return nuvemshopApi(connection, 'PUT', `/coupons/${couponId}`, { valid: !!valid });
}

async function deleteCoupon(connection, couponId) {
  return nuvemshopApi(connection, 'DELETE', `/coupons/${couponId}`);
}

// =====================================================================
// CUPOM DE RESGATE DE TENISCASH (cashback do cliente vira desconto)
// =====================================================================
// Percentual (pct do carrinho) com TETO em R$ = saldo do cliente
// (max_discount_amount). Uso único. Não combina com outros descontos
// (cliente escolhe: ou cupom de Creation, ou TenisCash).
function buildRedemptionCouponPayload({ code, pct, maxAmount, minPrice = 0 }) {
  return {
    code: String(code),
    type: 'percentage',
    value: String(Number(pct).toFixed(2)),
    valid: true,
    max_uses: 1,
    max_discount_amount: Number(Number(maxAmount).toFixed(2)),
    min_price: Number(minPrice) || 0,
    includes_shipping: false,
    combines_with_other_discounts: false,
  };
}

async function createRedemptionCoupon(connection, opts) {
  return nuvemshopApi(connection, 'POST', '/coupons', buildRedemptionCouponPayload(opts));
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCode,
  nuvemshopApi,
  nuvemshopVersionedApi,
  fetchAllPages,
  listProducts,
  listOrders,
  listCustomers,
  getProduct,
  updateProduct,
  deleteProduct,
  getOrder,
  getCustomer,
  listScripts,
  updateVariantStock,
  buildCouponPayload,
  createCoupon,
  updateCoupon,
  setCouponValid,
  deleteCoupon,
  buildRedemptionCouponPayload,
  createRedemptionCoupon,
};
