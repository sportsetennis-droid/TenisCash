// =====================================================================
// MONITOR DE WHATSAPP (admin) — o dono acompanha tudo que chega em CADA
// número (instância Evolution: S&T / Baratão / Meta Fardamentos / Meta APS)
// num só lugar. Lê o que foi capturado em WhatsappMessage (daqui pra frente)
// + status de conexão ao vivo da Evolution.
// =====================================================================
const express = require('express');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');

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

module.exports = router;
