// =====================================================================
// MONITOR DE WHATSAPP (admin) — o dono acompanha tudo que chega em CADA
// número (instância Evolution: S&T / Baratão / Meta Fardamentos / Meta APS)
// num só lugar. Lê o que foi capturado em WhatsappMessage (daqui pra frente)
// + status de conexão ao vivo da Evolution.
// =====================================================================
const express = require('express');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');
const { sendEvolutionRaw } = require('../whatsapp');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/[^\x21-\x7E]/g, '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = (process.env.EVOLUTION_API_KEY || '').replace(/[^\x21-\x7E]/g, '');

const INSTANCES = [
  { key: (process.env.EVOLUTION_INSTANCE || 'teniscash').trim(), label: 'Sports & Tennis' },
  { key: (process.env.BARATAO_EVOLUTION_INSTANCE || 'baratao').trim(), label: 'Baratão dos Esportes' },
  { key: (process.env.METAFARD_EVOLUTION_INSTANCE || 'metafardamentos').trim(), label: 'Meta Fardamentos' },
  { key: (process.env.METAAPS_EVOLUTION_INSTANCE || 'metaaps').trim(), label: 'Meta APS' },
];

// status de conexão ao vivo de cada instância (open/close/connecting) + número
async function fetchEvolutionStatus() {
  const map = {};
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return map;
  try {
    const r = await fetch(EVOLUTION_API_URL + '/instance/fetchInstances', { headers: { apikey: EVOLUTION_API_KEY } });
    if (!r.ok) return map;
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j.instances || []);
    for (const it of arr) {
      const i = it.instance || it;
      const name = i.instanceName || i.name || i.id;
      if (name) {
        map[name] = {
          status: i.connectionStatus || i.status || i.state || 'unknown',
          number: (i.number || i.ownerJid || i.owner || '').toString().replace(/[^0-9]/g, '') || null,
        };
      }
    }
  } catch (e) { /* Evolution fora do ar não derruba a aba */ }
  return map;
}

// GET /numbers — cada instância: status ao vivo + contadores (total/recebidas/última)
router.get('/numbers', async (_req, res) => {
  try {
    const live = await fetchEvolutionStatus();
    // início do dia em João Pessoa (America/Fortaleza, UTC-3) → em UTC
    const now = new Date();
    const fort = new Date(now.getTime() - 3 * 3600 * 1000);
    const startUTC = new Date(Date.UTC(fort.getUTCFullYear(), fort.getUTCMonth(), fort.getUTCDate(), 3, 0, 0));
    const numbers = [];
    for (const inst of INSTANCES) {
      const [total, recebidas, hoje, last] = await Promise.all([
        prisma.whatsappMessage.count({ where: { instance: inst.key } }),
        prisma.whatsappMessage.count({ where: { instance: inst.key, fromMe: false } }),
        prisma.whatsappMessage.count({ where: { instance: inst.key, fromMe: false, ts: { gte: startUTC } } }),
        prisma.whatsappMessage.findFirst({ where: { instance: inst.key }, orderBy: { ts: 'desc' }, select: { ts: true } }),
      ]);
      const l = live[inst.key] || {};
      numbers.push({
        instance: inst.key,
        label: inst.label,
        status: l.status || 'unknown',
        number: l.number || null,
        total,
        recebidas,
        hoje,
        lastAt: last ? last.ts : null,
      });
    }
    res.json({ numbers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /chats?instance=&groups=0 — uma linha por conversa (última mensagem)
router.get('/chats', async (req, res) => {
  try {
    const instance = String(req.query.instance || '').trim();
    if (!instance) return res.status(400).json({ error: 'instance obrigatório' });
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT ON ("chatJid") "chatJid", "contactName", "phone", "isGroup", "text", "fromMe", "ts"
      FROM "WhatsappMessage"
      WHERE "instance" = ${instance}
      ORDER BY "chatJid", "ts" DESC`;
    let chats = (rows || []).map((r) => ({
      chatJid: r.chatJid,
      contactName: r.contactName,
      phone: r.phone,
      isGroup: r.isGroup,
      lastText: r.text,
      lastFromMe: r.fromMe,
      lastAt: r.ts,
    }));
    if (String(req.query.groups) === '0') chats = chats.filter((c) => !c.isGroup);
    // enriquece com nome do cliente no CRM da Meta (MfCustomer) via telefone
    try {
      const phones = Array.from(new Set(chats.filter((c) => !c.isGroup && c.phone).map((c) => c.phone)));
      if (phones.length) {
        const custs = await prisma.mfCustomer.findMany({ where: { phone: { in: phones } }, select: { id: true, phone: true, name: true } });
        const byPhone = {};
        custs.forEach((c) => { if (c.phone) byPhone[c.phone] = { id: c.id, name: c.name }; });
        chats.forEach((c) => { const m = c.phone && byPhone[c.phone]; if (m) { c.crmName = m.name; c.crmId = m.id; } });
      }
    } catch (e) { /* CRM opcional */ }
    chats.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    res.json({ chats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /messages?instance=&jid=&limit= — thread de uma conversa (ordem cronológica)
router.get('/messages', async (req, res) => {
  try {
    const instance = String(req.query.instance || '').trim();
    const jid = String(req.query.jid || '').trim();
    if (!instance || !jid) return res.status(400).json({ error: 'instance e jid obrigatórios' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);
    const messages = await prisma.whatsappMessage.findMany({
      where: { instance, chatJid: jid },
      orderBy: { ts: 'asc' },
      take: limit,
      select: { id: true, fromMe: true, text: true, msgType: true, contactName: true, phone: true, ts: true },
    });
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /send { instance, jid, text } — ENVIA mensagem pelo número (Evolution) e grava no inbox.
// Torna a Central de WhatsApp de mão dupla: o dono responde os clientes por aqui.
router.post('/send', async (req, res) => {
  try {
    const instance = String(req.body.instance || '').trim();
    const jid = String(req.body.jid || '').trim();
    const text = String(req.body.text || '').trim();
    if (!instance || !jid || !text) return res.status(400).json({ error: 'instance, jid e text são obrigatórios' });
    if (text.length > 4096) return res.status(400).json({ error: 'Mensagem muito longa' });
    if (!INSTANCES.some((i) => i.key === instance)) return res.status(400).json({ error: 'instância desconhecida' });

    const isGroup = jid.endsWith('@g.us');
    const target = isGroup ? jid : jid.replace(/@.*/, ''); // número puro p/ diretos, JID p/ grupos
    const result = await sendEvolutionRaw(target, text, instance);
    if (!result || !result.ok) {
      return res.status(502).json({ error: (result && result.error) || 'Falha ao enviar pela Evolution' });
    }

    // grava a mensagem enviada pra aparecer na hora (o webhook-eco tem o mesmo messageId → dedup pela unique [instance,messageId])
    const phone = isGroup ? null : target.replace(/[^0-9]/g, '');
    const messageId = result.messageId || null;
    let saved = null;
    try {
      saved = await prisma.whatsappMessage.create({
        data: { instance, chatJid: jid, isGroup, fromMe: true, text, msgType: 'text', phone, messageId, ts: new Date() },
      });
    } catch (e) { /* já capturado pelo eco do webhook — ok */ }
    res.json({ ok: true, id: messageId, ts: saved ? saved.ts : new Date() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /send-media { instance, jid, media(base64), mimetype, fileName, caption } — envia IMAGEM/mídia
router.post('/send-media', async (req, res) => {
  try {
    const instance = String(req.body.instance || '').trim();
    const jid = String(req.body.jid || '').trim();
    const media = String(req.body.media || ''); // base64 puro (sem prefixo data:)
    const mimetype = String(req.body.mimetype || 'image/jpeg');
    const caption = String(req.body.caption || '').trim();
    const fileName = String(req.body.fileName || 'imagem.jpg').slice(0, 120);
    if (!instance || !jid || !media) return res.status(400).json({ error: 'instance, jid e media são obrigatórios' });
    if (!INSTANCES.some((i) => i.key === instance)) return res.status(400).json({ error: 'instância desconhecida' });
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY) return res.status(500).json({ error: 'Evolution não configurado' });

    const isGroup = jid.endsWith('@g.us');
    const target = isGroup ? jid : jid.replace(/@.*/, '');
    const mediatype = mimetype.startsWith('image') ? 'image' : (mimetype.startsWith('video') ? 'video' : (mimetype.startsWith('audio') ? 'audio' : 'document'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let data = {};
    try {
      const r = await fetch(EVOLUTION_API_URL + '/message/sendMedia/' + encodeURIComponent(instance), {
        method: 'POST',
        headers: { apikey: EVOLUTION_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ number: String(target), mediatype, mimetype, media, fileName, caption }),
        signal: controller.signal,
      });
      data = await r.json().catch(() => ({}));
      if (!r.ok) return res.status(502).json({ error: (data && data.message) || ('Evolution ' + r.status) });
    } catch (e) {
      return res.status(502).json({ error: e.name === 'AbortError' ? 'Timeout Evolution (mídia)' : (e.message || 'Erro Evolution') });
    } finally { clearTimeout(timer); }

    const phone = isGroup ? null : target.replace(/[^0-9]/g, '');
    const messageId = (data && data.key && data.key.id) || null;
    try {
      await prisma.whatsappMessage.create({
        data: { instance, chatJid: jid, isGroup, fromMe: true, text: caption || '📷 imagem', msgType: mediatype, phone, messageId, ts: new Date() },
      });
    } catch (e) { /* dedup */ }
    res.json({ ok: true, id: messageId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
