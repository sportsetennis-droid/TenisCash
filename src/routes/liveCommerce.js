// =====================================================================
// Live Commerce — vitrine ao vivo + chat de atendimento
// =====================================================================
// Fluxo: cliente abre /aovivo/LOJA01, vê a câmera da loja ao vivo e o
// chat. Manda mensagem → cai no painel do vendedor (/atendimento) em
// tempo real (SSE) + push no celular + WhatsApp (escalonamento). O
// vendedor responde, mostra produto (vídeo/foto), fecha a venda.
//
// Transporte em tempo real = SSE (sem socket.io). Visitante é anônimo
// (sem login) — autenticado por um visitorToken secreto por conversa.
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');
const bus = require('../services/liveBus');
const pushSvc = require('../services/pushNotifications');
const whatsapp = require('../whatsapp');

const router = express.Router();

const MAX_MSG = 2000;
const clean = (s) => String(s == null ? '' : s).trim();
const CAMERA_LIVE_DIR = process.env.CAMERA_LIVE_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-live')
  : '/data/camera-live');
const CAMERA_CORRECTED_DIR = process.env.CAMERA_CORRECTED_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'camera-live-corrected')
  : '/data/camera-live-corrected');

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Resolve a loja por code (LOJA01) — case-insensitive — ou por id.
async function resolveStore(ref) {
  const v = clean(ref);
  if (!v) return null;
  return (
    (await prisma.store.findUnique({ where: { code: v.toUpperCase() } }).catch(() => null)) ||
    (await prisma.store.findUnique({ where: { id: v } }).catch(() => null))
  );
}

// Auth flexível: aceita Bearer no header OU ?token= na query (necessário
// porque o EventSource do SSE não deixa setar header Authorization).
function authFlexible(req, res, next) {
  let token = null;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) token = h.split(' ')[1];
  else if (req.query && req.query.token) token = String(req.query.token);
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    req.userId = d.userId;
    req.userRole = d.role;
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

// storeId do operador logado (vendedor/loja) ou, pra admin, a loja pedida.
async function operatorStore(req) {
  const u = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, role: true, storeId: true, name: true },
  });
  if (!u) return { user: null, store: null };
  const isAdmin = ['admin', 'superadmin', 'manager'].includes(u.role);
  let store = null;
  if (u.storeId) store = await prisma.store.findUnique({ where: { id: u.storeId } });
  if (!store && isAdmin) {
    const ref = req.query.loja || req.body?.loja || req.query.storeCode || req.body?.storeCode;
    if (ref) store = await resolveStore(ref);
  }
  return { user: u, store, isAdmin };
}

// Notifica os vendedores da loja: push sempre (best-effort), WhatsApp só
// quando escalonando (ninguém com o painel aberto, ou primeiro contato).
async function notifySellers(store, { title, body, url, whatsapp: waText }) {
  try {
    const sellers = await prisma.user.findMany({
      where: { storeId: store.id, active: true, role: { in: ['seller', 'store', 'manager'] } },
      select: { id: true, phone: true, name: true },
    });
    for (const s of sellers) {
      pushSvc.sendToUser(s.id, { title, body, url, tag: 'live-' + store.id }).catch(() => {});
      if (waText && s.phone && whatsapp.isWhatsAppConfigured && whatsapp.isWhatsAppConfigured()) {
        whatsapp.sendCustomMessage(s.phone, waText).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[live] notifySellers falhou:', e.message);
  }
}

function publicMsg(m) {
  return { id: m.id, sender: m.sender, body: m.body, createdAt: m.createdAt };
}

// =====================================================================
// PÚBLICO (visitante anônimo)
// =====================================================================

// Estado da transmissão de uma loja (a página /aovivo consulta isso).
// Vitrine ao vivo de Tambaú. Os fragmentos enviados pelo notebook não têm
// áudio; esta rota expõe somente as seis câmeras autorizadas da LOJA05.
router.get('/camera/:storeCode/:camera/:name', (req, res) => {
  const storeCode = String(req.params.storeCode || '').toUpperCase();
  const camera = String(req.params.camera || '').toLowerCase();
  const name = path.basename(String(req.params.name || '')).replace(/[^A-Za-z0-9._-]/g, '');
  if (storeCode !== 'LOJA05' || !/^loja05_camera[1-6]$/.test(camera)) {
    return res.status(404).json({ error: 'câmera não encontrada' });
  }
  if (!/^(?:index\.m3u8|[A-Fa-f0-9]+_video\d+_(?:init|seg\d+)\.mp4)$/.test(name)) {
    return res.status(400).json({ error: 'arquivo HLS inválido' });
  }
  const rawRequested = String(req.query.raw || '') === '1';
  const correctedPlaylist = path.join(CAMERA_CORRECTED_DIR, storeCode, camera, 'index.m3u8');
  let correctedReady = false;
  if (!rawRequested && fs.existsSync(correctedPlaylist)) {
    try {
      correctedReady = Date.now() - fs.statSync(correctedPlaylist).mtimeMs < 20000;
    } catch (_) {}
  }
  const root = correctedReady ? CAMERA_CORRECTED_DIR : CAMERA_LIVE_DIR;
  const full = path.join(root, storeCode, camera, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'transmissão iniciando' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, no-store, max-age=0');
  res.setHeader('Content-Type', name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4');
  if (rawRequested && name.endsWith('.m3u8')) {
    const playlist = fs.readFileSync(full, 'utf8').replace(
      /(\.mp4)(\?[^"\r\n]*)?/g,
      (_match, extension, query = '') => `${extension}${query}${query ? '&' : '?'}raw=1`,
    );
    return res.send(playlist);
  }
  fs.createReadStream(full).pipe(res);
});

router.get('/channel/:storeCode', async (req, res) => {
  try {
    const store = await resolveStore(req.params.storeCode);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
    const ch = await prisma.liveChannel.findUnique({ where: { storeId: store.id } });
    res.json({
      storeCode: store.code,
      storeName: store.name,
      isLive: !!ch?.isLive,
      title: ch?.title || null,
      hlsUrl: ch?.isLive ? ch?.hlsUrl || null : null,
      startedAt: ch?.startedAt || null,
    });
  } catch (err) {
    console.error('[live/channel]', err);
    res.status(500).json({ error: err.message });
  }
});

// Abre uma conversa (opcionalmente já com a primeira mensagem).
router.post('/chat', async (req, res) => {
  try {
    const store = await resolveStore(req.body?.storeCode || req.body?.loja);
    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
    const visitorName = clean(req.body?.visitorName).slice(0, 60) || 'Visitante';
    const firstMsg = clean(req.body?.message).slice(0, MAX_MSG);

    const visitorToken = crypto.randomBytes(24).toString('hex');
    const chat = await prisma.liveChat.create({
      data: { storeId: store.id, visitorName, visitorToken, status: 'open' },
    });

    let msg = null;
    if (firstMsg) {
      msg = await prisma.liveMessage.create({
        data: { chatId: chat.id, sender: 'visitor', body: firstMsg },
      });
      await prisma.liveChat.update({
        where: { id: chat.id },
        data: { lastMessageAt: new Date(), sellerUnread: 1 },
      });
    }

    // Avisa o painel do vendedor (novo atendimento) + escalonamento
    bus.emitToStore(store.id, {
      type: 'chat:new',
      chat: { id: chat.id, visitorName, lastMessageAt: new Date(), sellerUnread: firstMsg ? 1 : 0, preview: firstMsg || '' },
    });
    notifySellers(store, {
      title: `🛒 ${visitorName} quer atendimento`,
      body: firstMsg ? firstMsg.slice(0, 120) : 'Novo cliente no chat da loja ao vivo',
      url: '/atendimento',
      whatsapp: `🛒 *Cliente no chat ao vivo* (${store.name})\n${visitorName}: ${firstMsg || '(entrou no chat)'}\n\nAtenda em teniscash.com.br/atendimento`,
    });

    res.json({ chatId: chat.id, visitorToken, message: msg ? publicMsg(msg) : null });
  } catch (err) {
    console.error('[live/chat create]', err);
    res.status(500).json({ error: err.message });
  }
});

// Carrega o chat pra validar o token e checar se a conversa ainda existe.
async function loadChatForVisitor(req) {
  const chatId = req.params.chatId;
  const token = req.headers['x-visitor-token'] || req.query.token || req.body?.visitorToken;
  if (!chatId || !token) return { error: 401 };
  const chat = await prisma.liveChat.findUnique({ where: { id: chatId } });
  if (!chat) return { error: 404 };
  if (chat.visitorToken !== token) return { error: 403 };
  return { chat };
}

// Histórico da conversa (visitante).
router.get('/chat/:chatId/messages', async (req, res) => {
  try {
    const { chat, error } = await loadChatForVisitor(req);
    if (error) return res.status(error).json({ error: 'Acesso negado' });
    const msgs = await prisma.liveMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json({ status: chat.status, messages: msgs.map(publicMsg) });
  } catch (err) {
    console.error('[live/chat messages]', err);
    res.status(500).json({ error: err.message });
  }
});

// Visitante envia mensagem.
router.post('/chat/:chatId/message', async (req, res) => {
  try {
    const { chat, error } = await loadChatForVisitor(req);
    if (error) return res.status(error).json({ error: 'Acesso negado' });
    if (chat.status === 'closed') return res.status(409).json({ error: 'Conversa encerrada' });
    const body = clean(req.body?.body).slice(0, MAX_MSG);
    if (!body) return res.status(400).json({ error: 'Mensagem vazia' });

    const msg = await prisma.liveMessage.create({
      data: { chatId: chat.id, sender: 'visitor', body },
    });
    await prisma.liveChat.update({
      where: { id: chat.id },
      data: { lastMessageAt: new Date(), sellerUnread: { increment: 1 } },
    });

    // Tempo real: pra quem está na conversa + pro painel da loja
    bus.emitToChat(chat.id, { type: 'message', message: publicMsg(msg) });
    bus.emitToStore(chat.storeId, {
      type: 'chat:message',
      chatId: chat.id,
      visitorName: chat.visitorName,
      message: publicMsg(msg),
    });

    // Se ninguém está com o painel aberto, escala pro celular
    if (!bus.storeHasListeners(chat.storeId)) {
      const store = await prisma.store.findUnique({ where: { id: chat.storeId } });
      if (store) {
        notifySellers(store, {
          title: `💬 ${chat.visitorName}`,
          body: body.slice(0, 120),
          url: '/atendimento',
          whatsapp: null,
        });
      }
    }

    res.json({ message: publicMsg(msg) });
  } catch (err) {
    console.error('[live/chat message]', err);
    res.status(500).json({ error: err.message });
  }
});

// SSE: visitante escuta as respostas do vendedor.
router.get('/chat/:chatId/stream', async (req, res) => {
  try {
    const { chat, error } = await loadChatForVisitor(req);
    if (error) return res.status(error).json({ error: 'Acesso negado' });
    bus.addChatClient(chat.id, req, res);
  } catch (err) {
    try { res.status(500).end(); } catch (_) {}
  }
});

// =====================================================================
// VENDEDOR (autenticado)
// =====================================================================

// Liga/desliga a transmissão da loja + define título e URL do player.
router.post('/seller/go-live', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const isLive = !!req.body?.isLive;
    const title = clean(req.body?.title).slice(0, 120) || null;
    const hlsUrl = clean(req.body?.hlsUrl) || null;

    const ch = await prisma.liveChannel.upsert({
      where: { storeId: store.id },
      update: { isLive, title, ...(hlsUrl ? { hlsUrl } : {}), startedAt: isLive ? new Date() : null },
      create: { storeId: store.id, isLive, title, hlsUrl, startedAt: isLive ? new Date() : null },
    });
    res.json({ isLive: ch.isLive, title: ch.title, hlsUrl: ch.hlsUrl });
  } catch (err) {
    console.error('[live/go-live]', err);
    res.status(500).json({ error: err.message });
  }
});

// Estado atual do canal da loja do operador.
router.get('/seller/channel', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const ch = await prisma.liveChannel.findUnique({ where: { storeId: store.id } });
    res.json({
      storeCode: store.code,
      storeName: store.name,
      isLive: !!ch?.isLive,
      title: ch?.title || null,
      hlsUrl: ch?.hlsUrl || null,
    });
  } catch (err) {
    console.error('[live/seller channel]', err);
    res.status(500).json({ error: err.message });
  }
});

// Lista as conversas abertas da loja (com prévia + não-lidas).
router.get('/seller/threads', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const chats = await prisma.liveChat.findMany({
      where: { storeId: store.id, status: 'open' },
      orderBy: { lastMessageAt: 'desc' },
      take: 100,
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    res.json({
      threads: chats.map((c) => ({
        id: c.id,
        visitorName: c.visitorName,
        lastMessageAt: c.lastMessageAt,
        unread: c.sellerUnread,
        preview: c.messages[0]?.body?.slice(0, 80) || '',
      })),
    });
  } catch (err) {
    console.error('[live/threads]', err);
    res.status(500).json({ error: err.message });
  }
});

// Histórico de uma conversa (e zera não-lidas + assume o atendimento).
router.get('/seller/threads/:chatId/messages', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const chat = await prisma.liveChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || chat.storeId !== store.id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const msgs = await prisma.liveMessage.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      take: 300,
    });
    await prisma.liveChat.update({
      where: { id: chat.id },
      data: { sellerUnread: 0, assignedSellerId: req.userId },
    });
    res.json({
      chat: { id: chat.id, visitorName: chat.visitorName, status: chat.status },
      messages: msgs.map(publicMsg),
    });
  } catch (err) {
    console.error('[live/thread messages]', err);
    res.status(500).json({ error: err.message });
  }
});

// Vendedor responde.
router.post('/seller/threads/:chatId/reply', authFlexible, async (req, res) => {
  try {
    const { store, user } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const chat = await prisma.liveChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || chat.storeId !== store.id) return res.status(404).json({ error: 'Conversa não encontrada' });
    const body = clean(req.body?.body).slice(0, MAX_MSG);
    if (!body) return res.status(400).json({ error: 'Mensagem vazia' });

    const msg = await prisma.liveMessage.create({
      data: { chatId: chat.id, sender: 'seller', sellerId: user.id, body },
    });
    await prisma.liveChat.update({
      where: { id: chat.id },
      data: { lastMessageAt: new Date(), assignedSellerId: user.id },
    });

    bus.emitToChat(chat.id, { type: 'message', message: publicMsg(msg) });
    bus.emitToStore(chat.storeId, { type: 'chat:message', chatId: chat.id, visitorName: chat.visitorName, message: publicMsg(msg), fromSeller: true });

    res.json({ message: publicMsg(msg) });
  } catch (err) {
    console.error('[live/reply]', err);
    res.status(500).json({ error: err.message });
  }
});

// Encerra o atendimento.
router.post('/seller/threads/:chatId/close', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    const chat = await prisma.liveChat.findUnique({ where: { id: req.params.chatId } });
    if (!chat || chat.storeId !== store.id) return res.status(404).json({ error: 'Conversa não encontrada' });
    await prisma.liveChat.update({ where: { id: chat.id }, data: { status: 'closed' } });
    bus.emitToChat(chat.id, { type: 'closed' });
    bus.emitToStore(chat.storeId, { type: 'chat:closed', chatId: chat.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[live/close]', err);
    res.status(500).json({ error: err.message });
  }
});

// SSE: painel do vendedor escuta a loja inteira (novos chats, mensagens).
router.get('/seller/stream', authFlexible, async (req, res) => {
  try {
    const { store } = await operatorStore(req);
    if (!store) return res.status(403).json({ error: 'Operador sem loja vinculada' });
    bus.addStoreClient(store.id, req, res);
  } catch (err) {
    try { res.status(500).end(); } catch (_) {}
  }
});

module.exports = router;
