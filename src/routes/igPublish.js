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
//   POST /api/ig/publish          [admin] { account, type: carousel|photo|story,
//                                           imageUrls[], caption, collaborators[] } → { jobId }
//   GET  /api/ig/jobs/:id         [admin] status do job (publicação demora ~1 min)
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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10 } });

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
  const id = String(req.params.id).replace(/\.(jpe?g|png)$/i, '');
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
    return { name: f.originalname, url: `${base}/api/ig/img/${id}.jpg`, bytes: f.size };
  });
  if (!urls.length) return res.status(400).json({ error: 'nenhum arquivo (campo files)' });
  res.json({ urls });
});

router.post('/publish', async (req, res) => {
  try {
    sweep();
    const { account, type = 'carousel', imageUrls = [], caption = '', collaborators = [] } = req.body || {};
    const acc = await resolveAccount(account);
    if (!Array.isArray(imageUrls) || !imageUrls.length) return res.status(400).json({ error: 'imageUrls vazio' });
    if (!['carousel', 'photo', 'story'].includes(type)) return res.status(400).json({ error: 'type inválido' });

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

router.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'job não encontrado' });
  res.json(j);
});

module.exports = router;
