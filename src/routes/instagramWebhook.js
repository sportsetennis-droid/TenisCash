// =====================================================================
// WEBHOOK DO INSTAGRAM (DM) — quem manda Direct pra uma conta das empresas
// entra no CRM DA EMPRESA DONA DA CONTA (S&T/lojas, Baratão, Meta Fardamentos)
// e a mensagem fica no monitor (instância "ig:<conta>").
// SÓ CAPTURA: não responde no Direct (resposta = equipe, pelo app).
// Assinatura conferida com META_APP_SECRET.
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const { prisma } = require('../middleware');
const { CANAIS, canalByInstagram } = require('../config/canais');
const crm = require('../services/crmContacts');
const { igToken } = require('../services/igAccount');

const router = express.Router();
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v22.0'}`;
const VERIFY = process.env.META_IG_VERIFY_TOKEN || process.env.META_WHATSAPP_VERIFY_TOKEN || 'teniscash-whatsapp-webhook-2026';

// id da conta IG -> canal (descoberto pelo @ via Business Discovery; cache 6h)
let idMap = { at: 0, map: {} };
async function canalByIgId(igId) {
  if (Date.now() - idMap.at > 6 * 3600 * 1000 || !idMap.map[igId]) {
    const token = igToken();
    const { resolveIgAccount } = require('../services/igAccount');
    const me = await resolveIgAccount().catch(() => null);
    const map = {};
    if (me && me.ok) map[me.igId] = canalByInstagram(me.username);
    for (const c of CANAIS.filter((x) => x.instagram)) {
      if (!token || !me || !me.ok) break;
      try {
        const r = await fetch(`${GRAPH}/${me.igId}?fields=business_discovery.username(${encodeURIComponent(c.instagram)}){id,username}&access_token=${encodeURIComponent(token)}`);
        const j = await r.json();
        if (j.business_discovery && j.business_discovery.id) map[j.business_discovery.id] = c;
      } catch (_) { /* conta pessoal / sem acesso */ }
    }
    idMap = { at: Date.now(), map };
  }
  return idMap.map[igId] || null;
}

async function igProfile(senderId) {
  const token = igToken();
  if (!token) return {};
  try {
    const r = await fetch(`${GRAPH}/${senderId}?fields=name,username&access_token=${encodeURIComponent(token)}`);
    const j = await r.json();
    return j.error ? {} : { name: j.name || null, username: j.username || null };
  } catch (_) { return {}; }
}

function validSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true;
  const sig = String(req.headers['x-hub-signature-256'] || '');
  if (!sig || !req.rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY && req.query['hub.challenge']) {
    return res.status(200).send(String(req.query['hub.challenge']));
  }
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.json({ received: true });
  try {
    const body = req.body || {};
    if (body.object !== 'instagram' && body.object !== 'page') return;
    for (const entry of body.entry || []) {
      for (const ev of entry.messaging || []) {
        const msg = ev.message;
        if (!msg || msg.is_deleted) continue;
        const echo = !!msg.is_echo;
        const accountId = echo ? ev.sender && ev.sender.id : ev.recipient && ev.recipient.id;
        const peerId = echo ? ev.recipient && ev.recipient.id : ev.sender && ev.sender.id;
        if (!accountId || !peerId) continue;
        const canal = await canalByIgId(String(entry.id || accountId)) || await canalByIgId(String(accountId));
        const conta = canal ? canal.instagram : String(accountId);
        const text = msg.text || (msg.attachments ? '📎 (anexo)' : '(mensagem)');
        const prof = echo ? {} : await igProfile(peerId);
        await prisma.whatsappMessage.upsert({
          where: { instance_messageId: { instance: 'ig:' + conta, messageId: String(msg.mid || '') } },
          update: {},
          create: {
            instance: 'ig:' + conta, chatJid: 'ig:' + peerId, isGroup: false,
            contactName: prof.username ? '@' + prof.username : (prof.name || null), phone: null,
            fromMe: echo, text: String(text).slice(0, 4000), msgType: 'instagram', messageId: String(msg.mid || ''),
            ts: ev.timestamp ? new Date(Number(ev.timestamp)) : new Date(),
          },
        }).catch(() => {});
        if (!echo && canal) {
          await crm.registerContact({
            empresa: canal.empresa, instance: 'ig:' + conta, storeCode: canal.storeCode,
            phone: null, lidKey: 'ig:' + peerId, profileName: prof.name || prof.username || null, instagram: prof.username || null,
          });
        }
        console.log(`[instagram] DM ${echo ? 'enviada' : 'recebida'} @${conta}${canal ? '' : ' (conta sem canal)'}: "${String(text).slice(0, 80)}"`);
      }
    }
  } catch (e) {
    console.error('[instagram/webhook] erro:', e.message);
  }
});

module.exports = router;
