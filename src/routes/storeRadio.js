const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const radio = require('../services/storeRadio');

// Voz NEURAL (fal.ai ElevenLabs multilingual) — muito mais expressiva/emotiva que a voz do navegador.
let _fal = null;
async function getFal() {
  if (_fal) return _fal;
  const mod = await import('@fal-ai/client');
  _fal = mod.fal;
  if (process.env.FAL_KEY) _fal.config({ credentials: process.env.FAL_KEY });
  return _fal;
}
async function neuralTtsUrl(text, voice) {
  const fal = await getFal();
  const r = await fal.subscribe('fal-ai/elevenlabs/tts/multilingual-v2', {
    input: {
      text: String(text || '').slice(0, 900),
      voice: voice || 'Aria',
      stability: 0.3,          // baixo = mais expressivo/emotivo
      similarity_boost: 0.75,
      style: 0.7,              // alto = mais entusiasmo
      speed: 1.06,             // um tiquinho acelerado = mais animado
    },
  });
  return (r && r.data && ((r.data.audio && r.data.audio.url) || r.data.url)) || null;
}

const router = express.Router();

// Resolve lojas-alvo: 'all' | array de ids | id único → lista de ids de lojas ATIVAS
async function resolveStoreIds(input) {
  if (input === 'all' || input === '*' || (Array.isArray(input) && input.includes('all'))) {
    const all = await prisma.store.findMany({ where: { active: true }, select: { id: true } });
    return all.map((s) => s.id);
  }
  if (Array.isArray(input)) return [...new Set(input.map(String).filter(Boolean))];
  if (input) return [String(input)];
  return [];
}

// ======================================================================
// PLAYER — "rede real": autentica pela CHAVE FIXA da loja (?storeId=&key=)
// Sem token de admin, sem expirar. Baixo privilégio: só toca a rádio da loja.
// ======================================================================
async function playerAuth(req, res, next) {
  try {
    const storeId = req.query.storeId || req.body?.storeId;
    const key = req.query.key || req.body?.key;
    const cfg = await radio.getByPlayerKey(storeId, key);
    if (!cfg) return res.status(403).json({ error: 'Chave da rádio inválida.' });
    req.radioStoreId = String(storeId);
    req.radioConfig = cfg;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Falha na autenticação da rádio.' });
  }
}

// O player pergunta "o que tocar agora?" a cada poucos segundos.
router.get('/next', playerAuth, async (req, res) => {
  try {
    const storeId = req.radioStoreId;
    await radio.touchPlayer(storeId); // marca a loja como ONLINE
    const config = req.radioConfig;
    const announcement = config.enabled ? await radio.claimNext(storeId) : null;
    res.json({
      ok: true,
      enabled: !!config.enabled,
      config: {
        volume: config.volume,
        language: config.language,
        voiceName: config.voiceName,
        media: config.mediaKind ? { kind: config.mediaKind, ref: config.mediaRef, title: config.mediaTitle, at: config.mediaUpdatedAt } : null,
      },
      announcement,
    });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível consultar a fila.' });
  }
});

router.post('/:id/complete', playerAuth, async (req, res) => {
  try { const r = await radio.complete(req.params.id); res.json({ ok: true, updated: r.count > 0 }); }
  catch { res.status(500).json({ error: 'Não foi possível confirmar a reprodução.' }); }
});

router.post('/:id/fail', playerAuth, async (req, res) => {
  try { const r = await radio.fail(req.params.id, req.body?.error); res.json({ ok: true, updated: r.count > 0 }); }
  catch { res.status(500).json({ error: 'Não foi possível registrar a falha.' }); }
});

// Voz NEURAL do anúncio: o player pede aqui e toca o áudio (com emoção) em vez da voz robótica do navegador.
router.get('/tts', playerAuth, async (req, res) => {
  try {
    const text = String(req.query.text || '').trim();
    if (!text) return res.status(400).json({ error: 'sem texto' });
    if (!process.env.FAL_KEY) return res.status(503).json({ error: 'voz neural indisponível' });
    const voice = req.radioConfig && req.radioConfig.voiceName ? req.radioConfig.voiceName : undefined;
    const url = await neuralTtsUrl(text, voice);
    if (!url) return res.status(502).json({ error: 'não gerou a voz' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, url });
  } catch (e) {
    console.error('[store-radio] tts:', e && e.message);
    res.status(502).json({ error: 'falha na voz neural' });
  }
});

// ======================================================================
// CENTRAL DO DONO — daqui pra baixo, tudo exige ADMIN. Controle total.
// ======================================================================
router.use(authMiddleware);
router.use(adminMiddleware);

// Estado de TODAS as lojas: online, tocando, fila, chave do player, template.
router.get('/state', async (_req, res) => {
  try { res.json({ ok: true, defaultTemplate: radio.DEFAULT_TEMPLATE, stores: await radio.listState() }); }
  catch (e) { console.error('[store-radio] state:', e); res.status(500).json({ error: 'Falha ao carregar as rádios.' }); }
});

// compat: /config devolve o mesmo estado
router.get('/config', async (_req, res) => {
  try { res.json({ ok: true, defaultTemplate: radio.DEFAULT_TEMPLATE, stores: await radio.listState() }); }
  catch (e) { res.status(500).json({ error: 'Falha ao carregar a configuração.' }); }
});

// Salva config de UMA loja (liga/desliga, template, volume, voz) + garante a chave fixa.
router.patch('/config/:storeId', async (req, res) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: String(req.params.storeId || '') }, select: { id: true, name: true } });
    if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
    await radio.ensureConfig(store.id, {
      enabled: req.body?.enabled, volume: req.body?.volume, language: req.body?.language,
      voiceName: req.body?.voiceName, announcementTemplate: req.body?.announcementTemplate,
    });
    const config = await radio.ensurePlayerKey(store.id);
    res.json({ ok: true, store, config });
  } catch (error) { res.status(400).json({ error: error.message || 'Não foi possível salvar a rádio.' }); }
});

// Liga/desliga a rádio em 1, várias ou TODAS as lojas.
router.post('/enable', async (req, res) => {
  try {
    const ids = await resolveStoreIds(req.body?.storeIds ?? req.body?.storeId);
    const enabled = req.body?.enabled !== false;
    for (const id of ids) { await radio.ensureConfig(id, { enabled }); await radio.ensurePlayerKey(id); }
    res.json({ ok: true, count: ids.length, enabled });
  } catch (e) { res.status(400).json({ error: e.message || 'Falha ao ligar a rádio.' }); }
});

// TOCAR MÚSICA (YouTube/stream) em 1, várias ou TODAS ao mesmo tempo.
router.post('/media', async (req, res) => {
  try {
    const ids = await resolveStoreIds(req.body?.storeIds ?? req.body?.storeId);
    if (!ids.length) return res.status(400).json({ error: 'Escolha ao menos uma loja.' });
    for (const id of ids) { await radio.ensureConfig(id, { enabled: true }); await radio.ensurePlayerKey(id); await radio.setMedia(id, { kind: req.body?.kind, ref: req.body?.ref, title: req.body?.title }); }
    res.json({ ok: true, count: ids.length });
  } catch (e) { res.status(400).json({ error: e.message || 'Falha ao tocar mídia.' }); }
});

// PARAR a música (os avisos de venda continuam).
router.post('/stop', async (req, res) => {
  try {
    const ids = await resolveStoreIds(req.body?.storeIds ?? req.body?.storeId);
    for (const id of ids) await radio.setMedia(id, { kind: null });
    res.json({ ok: true, count: ids.length });
  } catch (e) { res.status(400).json({ error: e.message || 'Falha ao parar.' }); }
});

// FALAR uma mensagem/aviso do dono em 1, várias ou TODAS (broadcast).
router.post('/announce', async (req, res) => {
  try {
    const ids = await resolveStoreIds(req.body?.storeIds ?? req.body?.storeId);
    if (!ids.length) return res.status(400).json({ error: 'Escolha ao menos uma loja.' });
    let n = 0;
    for (const id of ids) { await radio.ensureConfig(id, { enabled: true }); await radio.ensurePlayerKey(id); await radio.queueVoice({ storeId: id, message: req.body?.message, source: 'announce' }); n++; }
    res.json({ ok: true, count: n });
  } catch (e) { res.status(400).json({ error: e.message || 'Falha ao anunciar.' }); }
});

router.post('/test', async (req, res) => {
  try { const a = await radio.queueTestAnnouncement({ storeId: req.body?.storeId, message: req.body?.message }); res.json({ ok: true, announcement: a }); }
  catch (error) { res.status(400).json({ error: error.message || 'Não foi possível criar o teste.' }); }
});

router.get('/history', async (req, res) => {
  try {
    const storeId = req.query.storeId ? String(req.query.storeId) : undefined;
    const rows = await prisma.radioAnnouncement.findMany({
      where: storeId ? { storeId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit || 30), 1), 100),
      select: { id: true, source: true, message: true, status: true, attempts: true, error: true, createdAt: true, playedAt: true, saleId: true, storeId: true },
    });
    res.json({ ok: true, announcements: rows });
  } catch (error) { res.status(500).json({ error: 'Não foi possível carregar o histórico.' }); }
});

module.exports = router;
