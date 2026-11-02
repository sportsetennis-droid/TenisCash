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
    return await prisma.appNotification.create({
      data: {
        userId,
        type: type || 'info',
        title: title ? String(title).slice(0, 120) : null,
        body: String(body || '').slice(0, 500),
        link: link ? String(link).slice(0, 300) : null,
      },
    });
  } catch (e) {
    console.error('[notify] falhou:', e.message);
    return null;
  }
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
