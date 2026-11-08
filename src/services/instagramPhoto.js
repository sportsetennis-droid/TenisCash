// =====================================================================
// APEX — Foto de perfil do Instagram via API OFICIAL (Business Discovery)
// ---------------------------------------------------------------------
// Puxa nome + foto de perfil de um @handle usando a conta Instagram Business
// da loja (@sportsetennis). Funciona só pra contas COMERCIAL/CRIADOR — conta
// pessoal o Instagram NÃO libera (retorna erro) → cai pro upload.
// NÃO faz scraping (proibido pelas plataformas). Precisa das envs
// META_IG_ACCESS_TOKEN + META_IG_BUSINESS_ID (já usadas no projeto).
// Roda no SERVIDOR (tem internet livre), não no sandbox.
// =====================================================================

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || process.env.META_GRAPH_API_VERSION || 'v22.0'}`;

// Resolve token + id da conta IG que CONSULTA (Business Discovery), caindo pros
// nomes de env que o resto do projeto já usa (o publisher de IG funciona com
// META_PAGE_TOKEN + META_INSTAGRAM_ID), pra ligar sem o dono criar segredo novo.
function igToken() {
  return process.env.META_IG_ACCESS_TOKEN || process.env.META_PAGE_TOKEN || process.env.META_USER_TOKEN || null;
}
function igBizId() {
  return process.env.META_IG_BUSINESS_ID || process.env.META_IG_USER_ID || process.env.META_INSTAGRAM_ID || null;
}

function igConfigured() {
  return !!(igToken() && igBizId());
}

// Retorna { username, name, picUrl } ou null (não configurado / conta pessoal / não achou).
async function fetchInstagramProfile(handle) {
  const token = igToken();
  const biz = igBizId();
  const h = String(handle || '').replace(/^@/, '').trim();
  if (!token || !biz || !h) return null;
  try {
    const fields = `business_discovery.username(${encodeURIComponent(h)}){username,name,profile_picture_url}`;
    const url = `${GRAPH}/${biz}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
    const r = await fetch(url);
    const j = await r.json().catch(() => null);
    const bd = j && j.business_discovery;
    if (!bd || !bd.profile_picture_url) return null;
    return { username: bd.username || h, name: bd.name || null, picUrl: bd.profile_picture_url };
  } catch (e) {
    console.error('[instagramPhoto] fetch falhou:', e.message);
    return null;
  }
}

// Baixa a imagem e devolve data URI base64 (durável — a URL do IG expira).
// Se a imagem for grande demais (>1.5MB) ou falhar, devolve a URL original.
async function toDataUri(picUrl) {
  try {
    const r = await fetch(picUrl);
    if (!r.ok) return picUrl;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 1500000) return picUrl;
    const ct = r.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch (e) {
    return picUrl;
  }
}

// Conveniência: do handle direto pra { name, avatar } pronto pra gravar.
async function instagramAvatar(handle) {
  const prof = await fetchInstagramProfile(handle);
  if (!prof || !prof.picUrl) return null;
  const avatar = await toDataUri(prof.picUrl);
  return { username: prof.username, name: prof.name, avatar };
}

module.exports = { fetchInstagramProfile, toDataUri, instagramAvatar, igConfigured };
