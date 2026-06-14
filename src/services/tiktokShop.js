// =====================================================================
// TikTok Shop Service — Partner API v202309 (assinatura HMAC, OAuth, catálogo)
// =====================================================================
// NOTAS DE SETUP (precisa fazer no TikTok Shop Partner Center — GLOBAL):
//   1. Criar App em https://partner.tiktokshop.com (portal GLOBAL, cobre o Brasil)
//   2. Pegar App Key, App Secret e Service ID do app
//   3. Configurar a Redirect URL do app pra:
//        https://teniscash.com.br/api/tiktok-shop/oauth/callback
//   4. Conta de seller (CNPJ) APROVADA pra vender no TikTok Shop BR
//   5. Setar env vars no Railway:
//        TIKTOK_SHOP_APP_KEY
//        TIKTOK_SHOP_APP_SECRET
//        TIKTOK_SHOP_SERVICE_ID
//        TIKTOK_SHOP_REDIRECT_URI=https://teniscash.com.br/api/tiktok-shop/oauth/callback
//        TIKTOK_SHOP_WAREHOUSE_ID  (pega via getWarehouses depois de conectar)
// Base oficial: https://open-api.tiktokglobalshop.com  | token: https://auth.tiktok-shops.com
// Assinatura confirmada contra a impl. de referência (EcomPHP/tiktokshop-php, v202309).
// =====================================================================

const crypto = require('crypto');

const APP_KEY = process.env.TIKTOK_SHOP_APP_KEY;
const APP_SECRET = process.env.TIKTOK_SHOP_APP_SECRET;
const SERVICE_ID = process.env.TIKTOK_SHOP_SERVICE_ID;
const REDIRECT_URI = process.env.TIKTOK_SHOP_REDIRECT_URI;
const BASE_URL = process.env.TIKTOK_SHOP_BASE_URL || 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = process.env.TIKTOK_SHOP_AUTH_BASE || 'https://auth.tiktok-shops.com';
const AUTH_PORTAL = process.env.TIKTOK_SHOP_AUTH_PORTAL || 'https://services.tiktokshop.com';
// Versão da API embutida nos paths (/product/202309/...). Centralizada pra facilitar upgrade.
const API_VERSION = '202309';

function isConfigured() {
  return !!(APP_KEY && APP_SECRET);
}

// =====================================================================
// ASSINATURA (v202309) — espelha exatamente a impl. de referência:
//   1. remove sign, access_token, x-tts-access-token dos params
//   2. ordena as chaves (ksort) e concatena {key}{value} (pula arrays)
//   3. prepend do PATH da requisição
//   4. append do BODY cru (só quando NÃO é multipart/form-data)
//   5. envolve com app_secret nas duas pontas
//   6. HMAC-SHA256 (key = app_secret) → hex MINÚSCULO
// =====================================================================
function sign(path, query, bodyStr) {
  const params = { ...query };
  delete params.sign;
  delete params.access_token;
  delete params['x-tts-access-token'];

  const keys = Object.keys(params).sort();
  let base = '';
  for (const k of keys) {
    const v = params[k];
    if (Array.isArray(v) || (v && typeof v === 'object')) continue; // pula arrays/objetos
    base += `${k}${v}`;
  }
  base = path + base;
  if (bodyStr) base += bodyStr;
  base = APP_SECRET + base + APP_SECRET;

  return crypto.createHmac('sha256', APP_SECRET).update(base, 'utf8').digest('hex');
}

// =====================================================================
// Cliente HTTP assinado. `connection` precisa de { accessToken, shopCipher }.
// =====================================================================
async function tiktokApi(connection, method, path, opts = {}) {
  if (!isConfigured()) throw new Error('TikTok Shop não configurado (TIKTOK_SHOP_APP_KEY / APP_SECRET)');
  const { query = {}, body = null, multipart = null, useShopCipher = true } = opts;

  const q = {
    app_key: APP_KEY,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...query,
  };
  if (useShopCipher && connection && connection.shopCipher) {
    q.shop_cipher = connection.shopCipher;
  }

  const bodyStr = body != null ? JSON.stringify(body) : '';
  // Body NÃO entra na assinatura quando é multipart (upload de imagem)
  q.sign = sign(path, q, multipart ? '' : bodyStr);

  const url = `${BASE_URL}${path}?${new URLSearchParams(q).toString()}`;
  const headers = {};
  if (connection && connection.accessToken) headers['x-tts-access-token'] = connection.accessToken;

  const fetchOpts = { method, headers };
  if (multipart) {
    fetchOpts.body = multipart; // FormData define o content-type (com boundary) sozinho
  } else if (body != null) {
    headers['content-type'] = 'application/json';
    fetchOpts.body = bodyStr;
  }

  const res = await fetch(url, fetchOpts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* corpo vazio/não-JSON */ }

  if (!res.ok) {
    throw new Error(`[TikTok HTTP ${res.status}] ${data ? JSON.stringify(data).slice(0, 400) : 'sem corpo'}`);
  }
  // Envelope padrão TikTok: { code, message, request_id, data }
  if (data && data.code !== undefined && data.code !== 0) {
    throw new Error(`[TikTok ${data.code}] ${data.message || 'erro'}${data.request_id ? ' (req ' + data.request_id + ')' : ''}`);
  }
  return data ? data.data : null;
}

// =====================================================================
// OAUTH — os endpoints de token NÃO são assinados; usam app_key+app_secret
// direto na query string.
// =====================================================================

// URL pra onde mandar o seller logar/autorizar o app. Volta no Redirect URI com ?code=
function buildAuthUrl(state) {
  if (!SERVICE_ID) return null;
  return `${AUTH_PORTAL}/open/authorize?service_id=${encodeURIComponent(SERVICE_ID)}&state=${encodeURIComponent(state || '')}`;
}

async function exchangeCode(authCode) {
  if (!isConfigured()) throw new Error('TikTok Shop OAuth não configurado');
  const url = `${AUTH_BASE}/api/v2/token/get`
    + `?app_key=${encodeURIComponent(APP_KEY)}`
    + `&app_secret=${encodeURIComponent(APP_SECRET)}`
    + `&auth_code=${encodeURIComponent(authCode)}`
    + `&grant_type=authorized_code`;
  const res = await fetch(url, { headers: { 'content-type': 'application/json' } });
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw new Error('OAuth TikTok falhou: ' + (data.message || res.status));
  }
  // { access_token, access_token_expire_in, refresh_token, refresh_token_expire_in,
  //   open_id, seller_name, seller_base_region, ... }
  return data.data;
}

async function refreshAccessToken(refreshToken) {
  if (!isConfigured()) throw new Error('TikTok Shop OAuth não configurado');
  const url = `${AUTH_BASE}/api/v2/token/refresh`
    + `?app_key=${encodeURIComponent(APP_KEY)}`
    + `&app_secret=${encodeURIComponent(APP_SECRET)}`
    + `&refresh_token=${encodeURIComponent(refreshToken)}`
    + `&grant_type=refresh_token`;
  const res = await fetch(url, { headers: { 'content-type': 'application/json' } });
  const data = await res.json();
  if (!res.ok || data.code !== 0) {
    throw new Error('Refresh token TikTok falhou: ' + (data.message || res.status));
  }
  return data.data;
}

// Lista as lojas que o seller autorizou. É daqui que sai o shop_cipher (obrigatório
// em toda chamada de catálogo) e o shop_id. Assinado, mas SEM shop_cipher.
async function getAuthorizedShops(accessToken) {
  return tiktokApi({ accessToken }, 'GET', `/authorization/${API_VERSION}/shops`, { useShopCipher: false });
}

// =====================================================================
// CATÁLOGO — categorias, atributos, marcas, armazéns, imagens, produtos
// =====================================================================

async function getCategories(connection, { locale = 'pt-BR' } = {}) {
  return tiktokApi(connection, 'GET', `/product/${API_VERSION}/categories`, {
    query: { locale, category_version: 'v2' },
  });
}

// Sugere a category_id a partir do título/descrição/imagem do produto.
async function recommendCategory(connection, { productTitle, description, images = [] }) {
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/categories/recommend`, {
    body: {
      product_title: productTitle,
      description: description || undefined,
      images: images.length ? images.map((uri) => ({ uri })) : undefined,
    },
  });
}

async function getCategoryAttributes(connection, categoryId, { locale = 'pt-BR' } = {}) {
  return tiktokApi(connection, 'GET', `/product/${API_VERSION}/categories/${categoryId}/attributes`, {
    query: { locale, category_version: 'v2' },
  });
}

async function searchBrands(connection, { brandName, categoryId, pageSize = 50 } = {}) {
  const query = { page_size: String(pageSize) };
  if (brandName) query.brand_name = brandName;
  if (categoryId) query.category_id = categoryId;
  return tiktokApi(connection, 'GET', `/product/${API_VERSION}/brands`, { query });
}

async function getWarehouses(connection) {
  return tiktokApi(connection, 'GET', `/logistics/${API_VERSION}/warehouses`);
}

// Sobe uma imagem (Buffer) e devolve { uri } pra usar em main_images/sku_img.
// use_case: MAIN_IMAGE | ATTRIBUTE_IMAGE | DESCRIPTION_IMAGE | CERTIFICATION_IMAGE | SIZE_CHART_IMAGE
async function uploadImage(connection, buffer, { useCase = 'MAIN_IMAGE', filename = 'image.jpg' } = {}) {
  const form = new FormData();
  form.append('data', new Blob([buffer]), filename);
  form.append('use_case', useCase);
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/images/upload`, { multipart: form, useShopCipher: false });
}

async function createProduct(connection, payload) {
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/products`, { body: payload });
}

async function editProduct(connection, productId, payload) {
  return tiktokApi(connection, 'PUT', `/product/${API_VERSION}/products/${productId}`, { body: payload });
}

async function getProduct(connection, productId) {
  return tiktokApi(connection, 'GET', `/product/${API_VERSION}/products/${productId}`);
}

// skus: [{ id, price: { amount, currency } }]
async function updatePrices(connection, productId, skus) {
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/products/${productId}/prices/update`, {
    body: { skus },
  });
}

// skus: [{ id, inventory: [{ warehouse_id, quantity }] }]
async function updateInventory(connection, productId, skus) {
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/products/${productId}/inventory/update`, {
    body: { skus },
  });
}

async function deactivateProducts(connection, productIds) {
  return tiktokApi(connection, 'POST', `/product/${API_VERSION}/products/deactivate`, {
    body: { product_ids: productIds.map(String) },
  });
}

// ===== PEDIDOS (acompanhamento de vendas) =====
// POST /order/202309/orders/search — lista pedidos por janela de tempo.
// body aceita create_time_ge/lt (epoch s), order_status, etc. Precisa do
// escopo "Order" autorizado no app (senão TikTok devolve erro de permissão).
async function searchOrders(connection, { pageSize = 50, pageToken = '', body = {} } = {}) {
  const query = { page_size: String(pageSize), sort_field: 'create_time', sort_order: 'DESC' };
  if (pageToken) query.page_token = pageToken;
  return tiktokApi(connection, 'POST', `/order/${API_VERSION}/orders/search`, { query, body });
}

// GET /order/202309/orders?ids=a,b — detalhe (valores, itens) de pedidos.
async function getOrderDetail(connection, ids = []) {
  return tiktokApi(connection, 'GET', `/order/${API_VERSION}/orders`, {
    query: { ids: ids.map(String).join(',') },
  });
}

module.exports = {
  isConfigured,
  sign,
  tiktokApi,
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getAuthorizedShops,
  getCategories,
  recommendCategory,
  getCategoryAttributes,
  searchBrands,
  getWarehouses,
  uploadImage,
  createProduct,
  editProduct,
  getProduct,
  updatePrices,
  updateInventory,
  deactivateProducts,
  searchOrders,
  getOrderDetail,
  API_VERSION,
};
