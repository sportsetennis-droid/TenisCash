// =====================================================================
// Instagram Graph API — postar feed e story da loja Sports & Tennis
// =====================================================================
// REQUER (env vars no Railway):
//   META_IG_ACCESS_TOKEN     — token de longa duração (Page Access Token)
//   META_IG_BUSINESS_ID      — ID da conta Instagram Business
//
// SETUP ÚNICO (passo-a-passo) está em INSTAGRAM_SETUP.md.
// =====================================================================

const ACCESS_TOKEN = process.env.META_IG_ACCESS_TOKEN;
const BUSINESS_ID = process.env.META_IG_BUSINESS_ID;
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';

function isConfigured() {
  return !!(ACCESS_TOKEN && BUSINESS_ID);
}

function configError() {
  if (!ACCESS_TOKEN) return 'META_IG_ACCESS_TOKEN não configurada no Railway';
  if (!BUSINESS_ID) return 'META_IG_BUSINESS_ID não configurada no Railway';
  return null;
}

async function metaApi(path, method = 'GET', body = null, query = {}) {
  const params = new URLSearchParams({ access_token: ACCESS_TOKEN, ...query });
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${path}?${params.toString()}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok || data.error) {
    const err = data.error || { message: 'Erro Meta API' };
    throw new Error(`[Meta ${res.status}] ${err.message || JSON.stringify(err)}`);
  }
  return data;
}

/**
 * postFeed — publica imagem no feed do Instagram.
 * @param {Object} opts
 * @param {string} opts.imageUrl - URL pública da imagem (jpg/png; precisa estar online)
 * @param {string} opts.caption - legenda completa (até 2200 chars)
 */
async function postFeed({ imageUrl, caption }) {
  const cfgErr = configError();
  if (cfgErr) return { ok: false, error: cfgErr };
  if (!imageUrl) return { ok: false, error: 'imageUrl é obrigatório' };

  try {
    // 1) Cria container de mídia
    const container = await metaApi(`${BUSINESS_ID}/media`, 'POST', null, {
      image_url: imageUrl,
      caption: caption || '',
    });
    if (!container.id) return { ok: false, error: 'Falha ao criar container de mídia' };

    // 2) Publica o container
    const published = await metaApi(`${BUSINESS_ID}/media_publish`, 'POST', null, {
      creation_id: container.id,
    });
    return { ok: true, postId: published.id, containerId: container.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * postStory — publica imagem como story.
 * Stories duram 24h. Story só aceita media_type=STORIES.
 */
async function postStory({ imageUrl }) {
  const cfgErr = configError();
  if (cfgErr) return { ok: false, error: cfgErr };
  if (!imageUrl) return { ok: false, error: 'imageUrl é obrigatório' };

  try {
    const container = await metaApi(`${BUSINESS_ID}/media`, 'POST', null, {
      image_url: imageUrl,
      media_type: 'STORIES',
    });
    if (!container.id) return { ok: false, error: 'Falha ao criar container de story' };
    const published = await metaApi(`${BUSINESS_ID}/media_publish`, 'POST', null, {
      creation_id: container.id,
    });
    return { ok: true, postId: published.id, containerId: container.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * getInsights — métricas básicas de um post do feed.
 */
async function getInsights(postId) {
  const cfgErr = configError();
  if (cfgErr) return { ok: false, error: cfgErr };
  try {
    const data = await metaApi(`${postId}/insights`, 'GET', null, {
      metric: 'impressions,reach,likes,comments,saved,shares',
    });
    return { ok: true, insights: data.data || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * getAccountInfo — confirma que as credenciais funcionam.
 */
async function getAccountInfo() {
  const cfgErr = configError();
  if (cfgErr) return { ok: false, error: cfgErr };
  try {
    const data = await metaApi(BUSINESS_ID, 'GET', null, {
      fields: 'id,username,name,profile_picture_url,followers_count,media_count',
    });
    return { ok: true, account: data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  isConfigured,
  postFeed,
  postStory,
  getInsights,
  getAccountInfo,
};
