// =====================================================================
// APEX — Notificações in-app (central de avisos do atleta)
// ---------------------------------------------------------------------
// Grava avisos na tabela AppNotification (sininho em /torneios.html, lido via
// GET /api/tournaments/notifications/mine) e manda NOTIFICAÇÃO PUSH no celular
// de quem ativou os avisos (Web Push/VAPID — GRÁTIS, sem custo por mensagem).
//
// WhatsApp automático fica DESLIGADO por padrão (dono 2026-11-10: "tem que ser
// de graça" — a Cloud API cobra por mensagem iniciada pela empresa). Só liga
// com WA_AUTO_NOTIFY=1 no Railway. WHATSAPP_TOKEN sozinho NÃO dispara envio.
// Nunca derruba o fluxo que chamou: erro aqui é logado, não propagado.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const whatsappCloud = require('./whatsappCloud');
const pushNotifications = require('./pushNotifications');

function waAutoEnabled() {
  return process.env.WA_AUTO_NOTIFY === '1' && (whatsappCloud.enabled() || !!process.env.WA_BRIDGE_KEY);
}

// Push no celular (best-effort). `link` vira a URL aberta ao tocar.
// tag única por aviso: um aviso novo não apaga o anterior na bandeja do celular.
function sendPush(userId, { id, type, title, body, link }) {
  return pushNotifications.sendToUser(userId, {
    title: title ? String(title).slice(0, 120) : 'TenisCash',
    body: String(body || '').slice(0, 300),
    url: link || '/torneios.html',
    tag: (type || 'aviso') + ':' + (id || Date.now()),
  }).catch((e) => console.error('[notify] push falhou:', e.message));
}

async function notify(userId, { type, title, body, link } = {}) {
  if (!userId) return null;
  try {
    const n = await prisma.appNotification.create({
      data: {
        userId,
        type: type || 'info',
        title: title ? String(title).slice(0, 120) : null,
        body: String(body || '').slice(0, 500),
        link: link ? String(link).slice(0, 300) : null,
      },
    });
    // Push grátis no celular (só chega em quem ativou os avisos no app).
    sendPush(userId, { id: n.id, type, title, body, link });
    // WhatsApp automático: só com WA_AUTO_NOTIFY=1 (é pago). Padrão: desligado.
    if (waAutoEnabled()) enqueueWhatsApp(userId, title, body).catch(() => {});
    return n;
  } catch (e) {
    console.error('[notify] falhou:', e.message);
    return null;
  }
}

// Enfileira o aviso e, se a Cloud API oficial estiver ligada, envia na hora.
async function enqueueWhatsApp(userId, title, body) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!u || !u.phone) return;
    const text = (title ? `${title}: ` : '') + String(body || '').slice(0, 900);
    const row = await prisma.whatsAppOutbox.create({ data: { phone: u.phone, body: text, userId } });
    // Envio imediato pela API OFICIAL (se ligada). A ponte não-oficial, se usada, puxa o PENDING.
    if (whatsappCloud.enabled()) {
      const r = await whatsappCloud.sendNotification(u.phone, text);
      await prisma.whatsAppOutbox.update({
        where: { id: row.id },
        data: r.ok ? { status: 'SENT', sentAt: new Date() } : { status: 'FAILED', error: String(r.error || '').slice(0, 300) },
      }).catch(() => {});
    }
  } catch (e) { /* silencioso: WhatsApp é best-effort */ }
}

// Dispara o mesmo aviso pra vários usuários (ex: os 2 da dupla).
// Opcionalmente ignora um userId (ex: não notificar quem fez a ação).
async function notifyMany(userIds, payload, exceptUserId) {
  const seen = new Set();
  const out = [];
  for (const uid of userIds || []) {
    if (!uid || uid === exceptUserId || seen.has(uid)) continue;
    seen.add(uid);
    out.push(await notify(uid, payload));
  }
  return out;
}

module.exports = { notify, notifyMany };
