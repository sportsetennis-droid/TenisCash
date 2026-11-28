// =====================================================================
// /api/ig — publicação no Instagram em QUALQUER conta do portfólio
// (S&T principal, 5 lojas, Meta Fardamentos, Baratão) sem login/senha.
// ---------------------------------------------------------------------
// Usa o token do usuário do sistema "teniscash" (META_SYSTEM_TOKEN) do
// Business Manager, que enxerga as contas atribuídas a ele. Cai pro token
// atual (META_PAGE_TOKEN) se o do sistema não estiver configurado.
//
// Endpoints:
//   GET  /api/ig/img/:id          PÚBLICO — serve a imagem enviada (a Meta baixa daqui)
//   GET  /api/ig/accounts         [admin] contas que o token enxerga (username → id)
//   POST /api/ig/upload           [admin] multipart files[] → URLs públicas (vale 6h)
//   POST /api/ig/publish          [admin] { account, type: carousel|photo|story|reel,
//                                           imageUrls[], caption, collaborators[] } → { jobId }
//   GET  /api/ig/jobs/:id         [admin] status do job (publicação demora ~1 min)
//   DELETE /api/ig/media/:id?account=  [admin] apaga post/Reel/story da conta
//   GET  /api/ig/insights?account=&limit=  [admin] SÓ LEITURA: posts/Reels recentes
//                                  com alcance, views, curtidas, comentários, salvos,
//                                  compartilhamentos + stories no ar (24h)
//
// Não publica sozinho: só publica quando um admin logado chama /publish.
// Nunca devolve token.
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const { authMiddleware, prisma } = require('../middleware');
const ig = require('../services/instagramPublisher');
const { igToken } = require('../services/igAccount');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 10 } }); // 40MB: cabe vídeo de Reel

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || process.env.META_GRAPH_VERSION || 'v22.0'}`;
const BUSINESS_ID = process.env.META_BUSINESS_ID || '31915792481369241';
const IMG_TTL_MS = 6 * 60 * 60 * 1000;

const images = new Map(); // id -> { buf, type, at }
const jobs = new Map();   // id -> { status, account, type, result?, error?, at }

function sweep() {
  const now = Date.now();
  for (const [k, v] of images) if (now - v.at > IMG_TTL_MS) images.delete(k);
  for (const [k, v] of jobs) if (now - v.at > 24 * 60 * 60 * 1000) jobs.delete(k);
}

function systemToken() {
  return process.env.META_SYSTEM_TOKEN || igToken();
}

async function graphGet(path, params = {}) {
  const token = systemToken();
  if (!token) throw new Error('sem token Meta');
  const qs = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${qs}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`[Meta ${r.status}${e.code ? ' #' + e.code : ''}] ${e.message || 'erro'}`);
  }
  return j;
}

// ---------- PÚBLICO: a Meta baixa a imagem daqui ----------
router.get('/img/:id', (req, res) => {
  const id = String(req.params.id).replace(/\.(jpe?g|png|mp4|mov)$/i, '');
  const it = images.get(id);
  if (!it) return res.status(404).json({ error: 'imagem expirada ou inexistente' });
  res.set('Content-Type', it.type || 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(it.buf);
});

// ---------- daqui pra baixo: só admin logado ----------
router.use(authMiddleware);
router.use((req, res, next) => {
  prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } })
    .then((u) => {
      if (!u || !['admin', 'superadmin'].includes(u.role)) return res.status(403).json({ error: 'apenas admin' });
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
});

// Descobre as contas IG que o token enxerga (várias rotas da Meta; junta tudo).
let accCache = null;
async function discoverAccounts(force = false) {
  if (!force && accCache && Date.now() - accCache.at < 10 * 60 * 1000) return accCache.data;
  const found = new Map(); // username -> id
  const tried = [];
  const add = (acc, src) => { if (acc && acc.id && acc.username) found.set(acc.username.toLowerCase(), { id: String(acc.id), username: acc.username, src }); };

  let me = null;
  try { me = await graphGet('me', { fields: 'id,name' }); } catch (e) { tried.push({ step: 'me', error: e.message }); }

  for (const edge of ['owned_instagram_accounts', 'instagram_accounts', 'client_instagram_accounts']) {
    try {
      const j = await graphGet(`${BUSINESS_ID}/${edge}`, { fields: 'id,username', limit: '100' });
      (j.data || []).forEach((a) => add(a, edge));
      tried.push({ step: edge, count: (j.data || []).length });
    } catch (e) { tried.push({ step: edge, error: e.message.slice(0, 200) }); }
  }
  for (const ref of ['me/accounts', `${BUSINESS_ID}/owned_pages`, `${BUSINESS_ID}/client_pages`]) {
    try {
      const j = await graphGet(ref, { fields: 'name,instagram_business_account{id,username}', limit: '100' });
      (j.data || []).forEach((p) => add(p.instagram_business_account, ref));
      tried.push({ step: ref, count: (j.data || []).length });
    } catch (e) { tried.push({ step: ref, error: e.message.slice(0, 200) }); }
  }
  // IDs conhecidos via env JSON opcional: META_IG_ACCOUNTS='{"sportsetennistambau":"1784..."}'
  try {
    const extra = JSON.parse(process.env.META_IG_ACCOUNTS || '{}');
    for (const [u, id] of Object.entries(extra)) {
      try { const j = await graphGet(String(id), { fields: 'id,username' }); add(j, 'env'); }
      catch (e) { tried.push({ step: `env:${u}`, error: e.message.slice(0, 200) }); }
    }
  } catch { /* env inválida: ignora */ }

  const data = {
    tokenSource: process.env.META_SYSTEM_TOKEN ? 'META_SYSTEM_TOKEN' : 'fallback (META_IG_ACCESS_TOKEN/META_PAGE_TOKEN)',
    me: me ? { id: me.id, name: me.name } : null,
    accounts: [...found.values()].sort((a, b) => a.username.localeCompare(b.username)),
    tried,
  };
  accCache = { at: Date.now(), data };
  return data;
}

async function resolveAccount(account) {
  const a = String(account || '').trim().replace(/^@/, '').toLowerCase();
  if (!a) throw new Error('account obrigatório (@ ou id)');
  if (/^\d{10,}$/.test(a)) return { id: a, username: null };
  const { accounts } = await discoverAccounts();
  const hit = accounts.find((x) => x.username.toLowerCase() === a);
  if (!hit) throw new Error(`conta @${a} não acessível pelo token (veja GET /api/ig/accounts)`);
  return hit;
}

router.get('/accounts', async (req, res) => {
  try { res.json(await discoverAccounts(req.query.force === '1')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/upload', upload.array('files', 10), (req, res) => {
  sweep();
  const base = `${req.protocol}://${req.get('host')}`.replace(/^http:/, 'https:');
  const urls = (req.files || []).map((f) => {
    const id = crypto.randomBytes(12).toString('hex');
    images.set(id, { buf: f.buffer, type: f.mimetype || 'image/jpeg', at: Date.now() });
    const ext = /^video\//.test(f.mimetype || '') ? 'mp4' : 'jpg';
    return { name: f.originalname, url: `${base}/api/ig/img/${id}.${ext}`, bytes: f.size };
  });
  if (!urls.length) return res.status(400).json({ error: 'nenhum arquivo (campo files)' });
  res.json({ urls });
});

router.post('/publish', async (req, res) => {
  try {
    sweep();
    const { account, type = 'carousel', imageUrls = [], caption = '', collaborators = [], thumbOffset } = req.body || {};
    const acc = await resolveAccount(account);
    if (!Array.isArray(imageUrls) || !imageUrls.length) return res.status(400).json({ error: 'imageUrls vazio' });
    if (!['carousel', 'photo', 'story', 'reel'].includes(type)) return res.status(400).json({ error: 'type inválido' });

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = { status: 'running', account: acc.username || acc.id, type, at: Date.now() };
    jobs.set(jobId, job);
    console.log(`[ig/publish] job ${jobId} ${type} @${job.account} por user ${req.userId}`);

    (async () => {
      try {
        const collab = (collaborators || []).map((c) => String(c).replace(/^@/, '')).filter(Boolean);
        let r;
        if (type === 'carousel') r = await ig.publishCarousel({ imageUrls, caption, collaborators: collab, igUserId: acc.id });
        else if (type === 'photo') r = await ig.publishPhoto({ imageUrl: imageUrls[0], caption, collaborators: collab, igUserId: acc.id });
        // reel: imageUrls[0] = URL do MP4 enviado em /upload (trilha própria no arquivo)
        else if (type === 'reel') r = await ig.publishReel({ videoUrl: imageUrls[0], caption, collaborators: collab, igUserId: acc.id, ...(thumbOffset != null ? { thumbOffset: Number(thumbOffset) } : {}) });
        else r = await ig.publishStory({ imageUrl: imageUrls[0], igUserId: acc.id });
        Object.assign(job, { status: 'done', result: r });
      } catch (e) {
        Object.assign(job, { status: 'error', error: e.message });
      }
    })();

    res.json({ jobId, account: job.account, type });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Teste de permissão SEM publicar: cria só o container (rascunho) na Meta,
// que expira sozinho em 24h. Prova que o token pode postar naquela conta.
router.post('/check', async (req, res) => {
  try {
    const { account, imageUrl } = req.body || {};
    const acc = await resolveAccount(account);
    const token = process.env.META_SYSTEM_TOKEN || igToken();
    const c = await ig.api(`/${acc.id}/media`, { method: 'POST', body: { image_url: imageUrl, media_type: 'STORIES', access_token: token } });
    res.json({ ok: true, account: acc.username || acc.id, containerId: c.id, published: false });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job não encontrado' });
  res.json(j);
});

// ---------- SÓ LEITURA: métricas pra saber o que deu bom e o que deu ruim ----------
async function mediaInsights(m) {
  const isStory = m.media_product_type === 'STORY';
  const tries = isStory
    ? ['reach,views,replies,shares,total_interactions,navigation', 'reach,views,replies', 'reach']
    : ['reach,views,likes,comments,saved,shares,total_interactions', 'reach,likes,comments,saved,shares', 'reach'];
  for (const metric of tries) {
    try {
      const j = await graphGet(`${m.id}/insights`, { metric });
      const out = {};
      for (const x of j.data || []) out[x.name] = x.values?.[0]?.value ?? x.total_value?.value ?? 0;
      return out;
    } catch (e) { /* métrica não suportada nesse tipo: tenta a lista menor */ }
  }
  return {};
}

router.get('/insights', async (req, res) => {
  try {
    const acc = await resolveAccount(req.query.account || 'sportsetennis');
    const limit = Math.min(Number(req.query.limit) || 30, 60);
    const fields = 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count';
    const feed = await graphGet(`${acc.id}/media`, { fields, limit: String(limit) });
    let stories = [];
    try { stories = (await graphGet(`${acc.id}/stories`, { fields: 'id,media_type,media_product_type,timestamp,permalink,media_url,thumbnail_url' })).data || []; } catch { /* sem story no ar */ }
    const all = [...(feed.data || []), ...stories];
    const out = [];
    for (let i = 0; i < all.length; i += 6) {
      const part = await Promise.all(all.slice(i, i + 6).map(async (m) => ({
        id: m.id,
        tipo: m.media_product_type === 'STORY' ? 'STORY' : m.media_product_type === 'REELS' ? 'REEL' : m.media_type === 'CAROUSEL_ALBUM' ? 'CARROSSEL' : m.media_type,
        quando: m.timestamp,
        link: m.permalink,
        formato: m.media_type,
        arquivo: m.media_url ? String(m.media_url).split('?')[0].split('.').pop().slice(0, 8) : null,
        legenda: String(m.caption || '').replace(/\s+/g, ' ').slice(0, 140),
        curtidas: m.like_count,
        comentarios: m.comments_count,
        ...(await mediaInsights(m)),
      })));
      out.push(...part);
    }
    res.json({ account: acc.username || acc.id, total: out.length, itens: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Convites de colaboração (collab) de cada conta de loja — API oficial "IG User Collaboration Invites".
//   GET  /api/ig/collab-invites?account=sportsetennistambia     → convites pendentes da conta
//   POST /api/ig/collab-invites { account, mediaId, accept=true } → aceita (ou recusa) o convite daquela mídia
// Dono 25/11/2026: "Você tem que colaborar com todas as lojas e ainda tem que aceitar todas."
router.get('/collab-invites', async (req, res) => {
  try {
    const acc = await resolveAccount(req.query.account);
    const j = await graphGet(`${acc.id}/collaboration_invites`, { fields: 'media_id,media_owner_username,caption,media_url' });
    res.json({ account: acc.username || acc.id, convites: j.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/collab-invites', async (req, res) => {
  try {
    const { account, mediaId, accept = true } = req.body || {};
    if (!mediaId) return res.status(400).json({ error: 'mediaId obrigatório' });
    const acc = await resolveAccount(account);
    const token = systemToken();
    const qs = new URLSearchParams({ media_id: String(mediaId), accept: accept ? 'true' : 'false', access_token: token });
    const r = await fetch(`${GRAPH}/${acc.id}/collaboration_invites?${qs}`, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return res.status(422).json({ error: (j.error && j.error.message) || `Meta ${r.status}`, meta: j.error || null }); // 422: o Cloudflare esconde 502
    console.log(`[ig/collab] @${acc.username || acc.id} ${accept ? 'aceitou' : 'recusou'} ${mediaId} por user ${req.userId}`);
    res.json({ ok: true, account: acc.username || acc.id, mediaId, accept: !!accept, meta: j });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apagar uma mídia (post, Reel ou story) da conta — API oficial "IG Media Deleting" (dez/2025).
//   DELETE /api/ig/media/:id?account=sportsetennistambia
// Só admin logado e só por ordem do dono (28/11/2026: stories que saíram pretos).
// Antes de apagar, confere que a mídia é da conta pedida (não apaga mídia de outra conta).
router.delete('/media/:id', async (req, res) => {
  try {
    const mediaId = String(req.params.id || '');
    if (!/^\d{5,30}$/.test(mediaId)) return res.status(400).json({ error: 'mediaId inválido' });
    const acc = await resolveAccount(req.query.account);
    const m = await graphGet(mediaId, { fields: 'id,owner,media_type,media_product_type,timestamp' });
    if (m.owner && m.owner.id && String(m.owner.id) !== String(acc.id)) {
      return res.status(403).json({ error: 'mídia não é dessa conta', owner: m.owner.id });
    }
    const token = systemToken();
    const r = await fetch(`${GRAPH}/${mediaId}?access_token=${encodeURIComponent(token)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return res.status(422).json({ error: (j.error && j.error.message) || `Meta ${r.status}`, meta: j.error || null });
    console.log(`[ig/delete] @${acc.username || acc.id} apagou ${mediaId} (${m.media_product_type || m.media_type}) por user ${req.userId}`);
    res.json({ ok: true, account: acc.username || acc.id, mediaId, tipo: m.media_product_type || m.media_type, timestamp: m.timestamp, meta: j });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
