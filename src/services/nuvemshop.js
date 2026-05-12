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
  const res = await fetch(url, opts);
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) {
    throw new Error('[Nuvemshop ' + res.status + '] ' + (data?.message || JSON.stringify(data)));
  }
  return data;
}

module.exports = {
  isConfigured,
  buildAuthUrl,
  exchangeCode,
  nuvemshopApi,
};
