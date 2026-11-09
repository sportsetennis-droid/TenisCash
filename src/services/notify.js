// =====================================================================
// APEX — Notificações in-app (central de avisos do atleta)
// ---------------------------------------------------------------------
// Grava avisos na tabela AppNotification. Sem push externo / WhatsApp
// (isso é fase posterior, depende de VAPID/Cloud API). O app lê via
// GET /api/tournaments/notifications/mine e mostra o sininho com contador.
// Nunca derruba o fluxo que chamou: erro aqui é logado, não propagado.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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
    // WhatsApp (ponte não-oficial): só enfileira se a chave estiver configurada.
    // A ponte externa (whatsapp-bridge) puxa a fila e envia. Nunca derruba o fluxo.
    if (process.env.WA_BRIDGE_KEY) enqueueWhatsApp(userId, title, body).catch(() => {});
    return n;
  } catch (e) {
    console.error('[notify] falhou:', e.message);
    return null;
  }
}

// Enfileira o aviso pra sair no WhatsApp (se o usuário tem telefone).
async function enqueueWhatsApp(userId, title, body) {
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    if (!u || !u.phone) return;
    const text = (title ? `*${title}*\n` : '') + String(body || '').slice(0, 900);
    await prisma.whatsAppOutbox.create({ data: { phone: u.phone, body: text, userId } });
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
