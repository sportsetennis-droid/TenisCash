// =====================================================================
// Instagram Publisher — Meta Graph API v22.0
// =====================================================================
// Publica foto/reel num Instagram Business Account.
//
// Pré-requisitos:
//   - Conta Instagram Business vinculada a uma Página do Facebook
//   - App Meta com permissão instagram_content_publish
//   - User access token de longa duração (60d) ou system user token
//
// Env vars necessárias:
//   META_IG_USER_ID          → ID do Instagram Business Account (não é o @)
//   META_IG_ACCESS_TOKEN     → token Page (preferir long-lived)
//   META_GRAPH_API_VERSION   → v22.0 (default)
//
// Fluxo Meta:
//   1. POST /{ig-user-id}/media   → cria container (upload da media)
//   2. POST /{ig-user-id}/media_publish?creation_id=X → publica
//   3. Resposta: media_id (pode buscar permalink depois)
//
// Pra Reels: usar media_type=REELS + video_url
// Pra Foto:  usar image_url
// =====================================================================

const API_VERSION = process.env.META_GRAPH_API_VERSION || 'v22.0';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

async function api(path, opts = {}) {
  const url = BASE + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error || `HTTP ${res.status}`;
    const e = new Error(errMsg);
    e.status = res.status;
    e.fbCode = data?.error?.code;
    e.fbSubcode = data?.error?.error_subcode;
    throw e;
  }
  return data;
}

// ID da conta vem do resolvedor único (confere no Graph; se a env estiver
// errada, descobre o ID real pela Página). Ver src/services/igAccount.js.
const { getIgCredentials, igToken } = require('./igAccount');
// igUserId opcional: publica em OUTRA conta do portfólio (lojas, Meta, Baratão)
// usando o token do usuário do sistema (META_SYSTEM_TOKEN), que enxerga todas.
async function getCredentials(igUserId) {
  if (igUserId) {
    const token = process.env.META_SYSTEM_TOKEN || igToken();
    if (!token) throw new Error('sem token Meta (META_SYSTEM_TOKEN)');
    return { userId: String(igUserId), token };
  }
  return getIgCredentials();
}

// Espera o container ficar com status FINISHED antes de publicar
async function waitForContainerReady(containerId, token, maxWaitSec = 120) {
  const start = Date.now();
  while ((Date.now() - start) / 1000 < maxWaitSec) {
    const status = await api(`/${containerId}?fields=status_code&access_token=${token}`);
    if (status.status_code === 'FINISHED') return true;
    if (status.status_code === 'ERROR') throw new Error('Container Meta retornou status ERROR');
    if (status.status_code === 'EXPIRED') throw new Error('Container Meta expirou');
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Timeout esperando container Meta ficar pronto');
}

/**
 * Publica foto no Feed do IG.
 * @returns {Promise<{ mediaId, permalink }>}
 */
async function publishPhoto({ imageUrl, caption, collaborators, igUserId }) {
  const { userId, token } = await getCredentials(igUserId);

  // 1. Cria container
  const container = await api(`/${userId}/media`, {
    method: 'POST',
    body: {
      image_url: imageUrl,
      caption: caption || '',
      access_token: token,
      ...(collaborators && collaborators.length ? { collaborators: JSON.stringify(collaborators.slice(0, 3)) } : {}),
    },
  });

  // 2. Aguarda processar (foto é rápido, mas garante)
  await waitForContainerReady(container.id, token, 60);

  // 3. Publica
  const published = await api(`/${userId}/media_publish`, {
    method: 'POST',
    body: { creation_id: container.id, access_token: token },
  });

  // 4. Busca permalink
  let permalink = null;
  try {
    const info = await api(`/${published.id}?fields=permalink&access_token=${token}`);
    permalink = info.permalink;
  } catch {}

  return { mediaId: published.id, permalink };
}

/**
 * Publica STORY (imagem 9:16) no IG. Story não tem caption visível nem collaborators via API.
 * @returns {Promise<{ mediaId }>}
 */
async function publishStory({ imageUrl, videoUrl, igUserId }) {
  const { userId, token } = await getCredentials(igUserId);
  // Story em VÍDEO tem que ir como video_url. Mandar o MP4 em image_url faz a Meta aceitar,
  // mas o story fica todo preto no app (bug visto em 28/11/2026).
  const url = videoUrl || imageUrl;
  const isVideo = !!videoUrl || /\.(mp4|mov|m4v)(\?|#|$)/i.test(String(url || ''));

  const container = await api(`/${userId}/media`, {
    method: 'POST',
    body: {
      media_type: 'STORIES',
      ...(isVideo ? { video_url: url } : { image_url: url }),
      access_token: token,
    },
  });

  await waitForContainerReady(container.id, token, isVideo ? 180 : 90);

  const published = await api(`/${userId}/media_publish`, {
    method: 'POST',
    body: { creation_id: container.id, access_token: token },
  });

  return { mediaId: published.id };
}

/**
 * Publica Reel (vídeo vertical 9:16) no IG.
 */
async function publishReel({ videoUrl, caption, shareToFeed = true, collaborators, coverUrl, thumbOffset, igUserId }) {
  const { userId, token } = await getCredentials(igUserId);

  const container = await api(`/${userId}/media`, {
    method: 'POST',
    body: {
      media_type: 'REELS',
      video_url: videoUrl,
      caption: caption || '',
      share_to_feed: shareToFeed,
      access_token: token,
      // cover = imagem principal do reel (grade do perfil). Preferir cover_url (frame do produto);
      // thumb_offset (ms) é fallback. Sem isso o IG escolhe um frame qualquer (às vezes texto).
      ...(coverUrl ? { cover_url: coverUrl } : {}),
      ...(!coverUrl && thumbOffset != null ? { thumb_offset: thumbOffset } : {}),
      ...(collaborators && collaborators.length ? { collaborators: JSON.stringify(collaborators.slice(0, 3)) } : {}),
    },
  });

  // Reels demoram (até 1-2 min pra processar)
  await waitForContainerReady(container.id, token, 180);

  const published = await api(`/${userId}/media_publish`, {
    method: 'POST',
    body: { creation_id: container.id, access_token: token },
  });

  let permalink = null;
  try {
    const info = await api(`/${published.id}?fields=permalink&access_token=${token}`);
    permalink = info.permalink;
  } catch {}

  return { mediaId: published.id, permalink };
}

/**
 * Publica CARROSSEL (2-10 imagens) no feed do IG, com collab opcional.
 * @param {string[]} imageUrls  URLs públicas das imagens (na ordem)
 * @param {string}   caption
 * @param {string[]} collaborators  usernames a convidar (máx 3, contas públicas)
 */
async function publishCarousel({ imageUrls = [], caption, collaborators, igUserId }) {
  const { userId, token } = await getCredentials(igUserId);
  if (imageUrls.length < 2) throw new Error('Carrossel precisa de pelo menos 2 imagens');

  // 1. Cria um container-filho por imagem
  const childIds = [];
  for (const url of imageUrls.slice(0, 10)) {
    const child = await api(`/${userId}/media`, {
      method: 'POST',
      body: { image_url: url, is_carousel_item: true, access_token: token },
    });
    await waitForContainerReady(child.id, token, 60);
    childIds.push(child.id);
  }

  // 2. Container do carrossel (collab vai aqui, no container-pai)
  const container = await api(`/${userId}/media`, {
    method: 'POST',
    body: {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption: caption || '',
      access_token: token,
      ...(collaborators && collaborators.length ? { collaborators: JSON.stringify(collaborators.slice(0, 3)) } : {}),
    },
  });
  await waitForContainerReady(container.id, token, 120);

  // 3. Publica
  const published = await api(`/${userId}/media_publish`, {
    method: 'POST',
    body: { creation_id: container.id, access_token: token },
  });

  let permalink = null;
  try {
    const info = await api(`/${published.id}?fields=permalink&access_token=${token}`);
    permalink = info.permalink;
  } catch {}

  return { mediaId: published.id, permalink, collaborators: collaborators || [] };
}

/**
 * Busca métricas (views, likes, comments) de uma publicação Meta.
 * Roda depois (cron diário) pra atualizar MarketingPublication.metric*
 */
async function getInsights(mediaId) {
  const { token } = await getCredentials();
  const metrics = 'impressions,reach,likes,comments,shares,saved';
  const data = await api(`/${mediaId}/insights?metric=${metrics}&access_token=${token}`);
  const out = {};
  for (const m of data.data || []) {
    out[m.name] = m.values?.[0]?.value || 0;
  }
  return out;
}

module.exports = { api, getCredentials, publishPhoto, publishStory, publishReel, publishCarousel, getInsights };
