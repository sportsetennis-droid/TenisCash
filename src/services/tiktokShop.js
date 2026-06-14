// =====================================================================
// TikTok Shop Service — OAuth, request signing, API helper
// =====================================================================
// Espelha src/services/nuvemshop.js, mas a API do TikTok Shop EXIGE
// assinatura HMAC-SHA256 em TODA requisição (ver signRequest abaixo).
//
// NOTAS DE SETUP (fazer no TikTok Shop Partner Center — partner.tiktokshop.com):
//   1. Criar app: App & Service > Create app & service > "Custom app"
//      (app pra loja própria; não precisa publicar na App Store do TikTok).
//   2. Pegar App Key + App Secret.
//   3. Configurar a Redirect URL do app:
//        https://teniscash.com.br/api/tiktok/oauth/callback
//   4. Autorizar a loja: o dono abre buildAuthUrl(), loga no seller,
//      autoriza → TikTok redireciona pra callback com ?code=...
//   5. Setar env vars no Railway:
//        TIKTOK_APP_KEY
//        TIKTOK_APP_SECRET
//        TIKTOK_REDIRECT_URI=https://teniscash.com.br/api/tiktok/oauth/callback
//      (opcionais, têm default global/não-US):
//        TIKTOK_API_BASE_URL=https://open-api.tiktokglobalshop.com
//        TIKTOK_AUTH_BASE_URL=https://auth.tiktok-shops.com
//        TIKTOK_AUTH_PORTAL_URL=https://services.tiktokshop.com/open/authorize
//
// Algoritmo de assinatura confirmado na doc oficial + SDK EcomPHP/tiktokshop-php:
//   sign = HMAC_SHA256( app_secret + path + sorted(k+v) + body + app_secret , key=app_secret )
//   - exclui das params: sign, access_token, x-tts-access-token
//   - ordena params por chave (asc), concatena "chave""valor" sem separador
//   - prepende o PATH da request
//   - se método != GET e content-type != multipart/form-data: anexa o BODY cru (JSON)
//   - envolve com app_secret nas duas pontas
//   - HMAC-SHA256 hex, key = app_secret
// =====================================================================

const crypto = require('crypto');

const APP_KEY = process.env.TIKTOK_APP_KEY;
const APP_SECRET = process.env.TIKTOK_APP_SECRET;
const REDIRECT_URI = process.env.TIKTOK_REDIRECT_URI;
const API_BASE = process.env.TIKTOK_API_BASE_URL || 'https://open-api.tiktokglobalshop.com';
const AUTH_BASE = process.env.TIKTOK_AUTH_BASE_URL || 'https://auth.tiktok-shops.com';
const AUTH_PORTAL = process.env.TIKTOK_AUTH_PORTAL_URL || 'https://services.tiktokshop.com/open/authorize';

function isConfigured() {
  return !!(APP_KEY && APP_SECRET && REDIRECT_URI);
}

// URL pro dono autorizar a loja (consentimento do seller no custom app).
function buildAuthUrl(state) {
  if (!APP_KEY) return null;
  const q = new URLSearchParams({ app_key: APP_KEY, state: state || '' });
  return `${AUTH_PORTAL}?${q.toString()}`;
}

// =====================================================================
// ASSINATURA — núcleo testável (pure function, sem rede)
// =====================================================================
// query: objeto de query params (sem sign). path: caminho da API (ex /product/202309/products).
// bodyString: corpo cru já serializado (string) ou ''. method: HTTP method.
// contentType: header content-type (pra pular o body em multipart).
function signRequest({ path, query = {}, bodyString = '', method = 'GET', contentType = 'application/json', appSecret = APP_SECRET }) {
  if (!appSecret) throw new Error('TikTok app secret ausente');

  // 1) params menos os excluídos, ordenados por chave
  const exclude = new Set(['sign', 'access_token', 'x-tts-access-token']);
  const keys = Object.keys(query)
    .filter((k) => !exclude.has(k) && query[k] != null && query[k] !== '')
    .sort();

  // 2) concatena chave+valor sem separador
  let base = '';
  for (const k of keys) base += `${k}${query[k]}`;

  // 3) prepende o path
  base = `${path}${base}`;

  // 4) anexa body cru (exceto GET ou multipart)
  const isMultipart = String(contentType || '').includes('multipart/form-data');
  if (String(method).toUpperCase() !== 'GET' && !isMultipart && bodyString) {
    base += bodyString;
  }

  // 5) envolve com app_secret nas duas pontas
  base = `${appSecret}${base}${appSecret}`;

  // 6) HMAC-SHA256 hex
  return crypto.createHmac('sha256', appSecret).update(base, 'utf8').digest('hex');
}

// =====================================================================
// OAUTH — troca de auth_code por token + refresh
// (endpoints de token NÃO são assinados; usam app_key/app_secret na query)
// =====================================================================
async function exchangeCode(authCode) {
  if (!APP_KEY || !APP_SECRET) throw new Error('TikTok OAuth não configurado');
  const q = new URLSearchParams({
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    auth_code: authCode,
    grant_type: 'authorized_code',
  });
  const res = await fetch(`${AUTH_BASE}/api/v2/token/get?${q.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error('OAuth TikTok falhou: ' + (json.message || res.status));
  }
  return json.data; // { access_token, refresh_token, access_token_expire_in, refresh_token_expire_in, ... }
}

async function refreshAccessToken(refreshToken) {
  if (!APP_KEY || !APP_SECRET) throw new Error('TikTok OAuth não configurado');
  const q = new URLSearchParams({
    app_key: APP_KEY,
    app_secret: APP_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(`${AUTH_BASE}/api/v2/token/refresh?${q.toString()}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0 || !json.data) {
    throw new Error('Refresh token TikTok falhou: ' + (json.message || res.status));
  }
  return json.data;
}

// =====================================================================
// API helper assinado
// =====================================================================
// connection: { accessToken, shopCipher? }. path: ex /product/202309/products.
// query: params extras. body: objeto (vira JSON). shopScoped: inclui shop_cipher.
async function tiktokApi(connection, method, path, { query = {}, body = null, shopScoped = true } = {}) {
  if (!isConfigured()) throw new Error('TikTok Shop não configurado (env)');
  if (!connection?.accessToken) throw new Error('Conexão TikTok inválida (sem accessToken)');

  const timestamp = Math.floor(Date.now() / 1000);
  const q = { app_key: APP_KEY, timestamp, ...query };
  if (shopScoped) {
    if (!connection.shopCipher) throw new Error('Conexão TikTok sem shopCipher (rode getAuthorizedShops primeiro)');
    q.shop_cipher = connection.shopCipher;
  }

  const bodyString = body != null ? JSON.stringify(body) : '';
  const contentType = 'application/json';
  q.sign = signRequest({ path, query: q, bodyString, method, contentType });

  const url = `${API_BASE}${path}?${new URLSearchParams(q).toString()}`;
  const opts = {
    method,
    headers: {
      'x-tts-access-token': connection.accessToken,
      'Content-Type': contentType,
    },
  };
  if (bodyString) opts.body = bodyString;

  // Retry em 429/503 (rate limit). TikTok Shop usa limite por app+shop.
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await fetch(url, opts);
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  const json = res.status === 204 ? null : await res.json();
  // TikTok devolve HTTP 200 com code != 0 em erro de negócio.
  if (!res.ok || (json && json.code !== 0 && json.code !== undefined)) {
    throw new Error('[TikTok ' + res.status + ' code=' + (json?.code) + '] ' + (json?.message || JSON.stringify(json)));
  }
  return json?.data !== undefined ? json.data : json;
}

// Lista as lojas autorizadas (pega shop_id + shop_cipher). NÃO é shop-scoped.
async function getAuthorizedShops(connection) {
  const data = await tiktokApi(connection, 'GET', '/authorization/202309/shops', { shopScoped: false });
  return Array.isArray(data?.shops) ? data.shops : [];
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  signRequest,
  exchangeCode,
  refreshAccessToken,
  tiktokApi,
  getAuthorizedShops,
  // expostos pra debug/teste
  _config: { API_BASE, AUTH_BASE, AUTH_PORTAL },
};
