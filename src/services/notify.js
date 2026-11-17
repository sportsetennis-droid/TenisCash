// =====================================================================
// APEX — Notificações in-app (central de avisos do atleta)
// ---------------------------------------------------------------------
// Grava avisos na tabela AppNotification + push no celular (clubPush, Web
// Push com as chaves VAPID do banco) + WhatsApp quando a Cloud API está ligada. O app lê via
// GET /api/tournaments/notifications/mine e mostra o sininho com contador.
// Nunca derruba o fluxo que chamou: erro aqui é logado, não propagado.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const whatsappCloud = require('./whatsappCloud');
const clubPush = require('./clubPush');

// opts.whatsapp=false → só o sininho (ex: conquistas do app de atividade).
async function notify(userId, { type, title, body, link } = {}, opts = {}) {
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
    // WhatsApp: liga com a Cloud API oficial (WHATSAPP_TOKEN) OU a ponte (WA_BRIDGE_KEY).
    // Sem nenhuma das duas, não faz nada (só o sininho). Nunca derruba o fluxo.
    if (opts.whatsapp !== false && (whatsappCloud.enabled() || process.env.WA_BRIDGE_KEY)) enqueueWhatsApp(userId, title, body).catch(() => {});
    // Push no celular (Club): só pra quem tem inscrição e deixou o tipo ligado. Best-effort.
    clubPush.sendPush(userId, { type: n.type, title, body, link });
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
