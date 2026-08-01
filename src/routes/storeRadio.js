const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const radio = require('../services/storeRadio');
const WebSocket = require('ws');
const crypto = require('node:crypto');

// Voz NEURAL pt-BR via Microsoft edge-tts (GRÁTIS, sem chave). Ritmo/pitch acelerados = mais animado.
const EDGE_TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_VER = '1-143.0.3650.75'; // se um dia der 403, atualizar pra versão atual do Edge
function edgeSecToken() {
  let t = Math.floor(Date.now() / 1000) + 11644473600;
  t -= t % 300;
  t *= 1e7;
  return crypto.createHash('sha256').update(String(t) + EDGE_TRUSTED, 'ascii').digest('hex').toUpperCase();
}
function edgeTtsMp3(text, voice) {
  return new Promise((resolve, reject) => {
    const cid = crypto.randomUUID().replace(/-/g, '');
    const rid = crypto.randomUUID().replace(/-/g, '');
    const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${EDGE_TRUSTED}&Sec-MS-GEC=${edgeSecToken()}&Sec-MS-GEC-Version=${EDGE_VER}&ConnectionId=${cid}`;
    const ws = new WebSocket(url, { headers: {
      Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    } });
    const chunks = [];
    const v = voice || 'pt-BR-ThalitaMultilingualNeural';
    const safe = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').slice(0, 900);
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='pt-BR'><voice name='${v}'><prosody rate='+18%' pitch='+10%'>${safe}</prosody></voice></speak>`;
    let settled = false;
    const done = (err, buf) => { if (settled) return; settled = true; try { ws.close(); } catch (e) {} if (err) reject(err); else resolve(buf); };
    const timer = setTimeout(() => done(new Error('timeout')), 15000);
    ws.on('open', () => {
      ws.send(`X-Timestamp:${new Date().toISOString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`);
      ws.send(`X-RequestId:${rid}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date().toISOString()}Z\r\nPath:ssml\r\n\r\n${ssml}`);
    });
    ws.on('message', (d, isBin) => {
      try {
        if (isBin) { const hl = d.readUInt16BE(0); if (d.slice(2, 2 + hl).toString().includes('Path:audio')) chunks.push(d.slice(2 + hl)); }
        else if (d.toString().includes('Path:turn.end')) { clearTimeout(timer); const buf = Buffer.concat(chunks); done(buf.length > 500 ? null : new Error('vazio'), buf); }
      } catch (e) { clearTimeout(timer); done(e); }
    });
    ws.on('error', (e) => { clearTimeout(timer); done(e); });
  });
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

// Voz NEURAL pt-BR do anúncio (edge-tts): o player toca o MP3 daqui em vez da voz robótica do navegador.
router.get('/tts', playerAuth, async (req, res) => {
  try {
    const text = String(req.query.text || '').trim();
    if (!text) return res.status(400).json({ error: 'sem texto' });
    const voice = (req.radioConfig && req.radioConfig.voiceName) || 'pt-BR-ThalitaMultilingualNeural';
    let mp3 = null;
    // A nuvem (Railway) é bloqueada pelo edge-tts (IP de datacenter). Então a voz é gerada
    // num relay em IP residencial e chega aqui por túnel (RADIO_TTS_RELAY_URL).
    const relay = process.env.RADIO_TTS_RELAY_URL;
    if (relay) {
      try {
        const rr = await fetch(relay.replace(/\/+$/, '') + '/tts?s=' + encodeURIComponent(process.env.RADIO_TTS_RELAY_SECRET || '')
          + '&voice=' + encodeURIComponent(voice) + '&text=' + encodeURIComponent(text));
        if (rr.ok) { const ab = await rr.arrayBuffer(); mp3 = Buffer.from(ab); }
      } catch (e) { /* cai pro edge direto */ }
    }
    if (!mp3 || mp3.length < 500) { try { mp3 = await edgeTtsMp3(text, voice); } catch (e) {} }
    if (!mp3 || mp3.length < 500) return res.status(502).json({ error: 'voz vazia' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-store');
    res.send(mp3);
  } catch (e) {
    console.error('[store-radio] tts:', e && e.message);
    res.status(502).json({ error: 'falha na voz' });
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
