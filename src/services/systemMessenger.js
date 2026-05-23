// =====================================================================
// System Messenger — bot "TenisCash" envia mensagem automática pro user
// =====================================================================
// Usado em hooks de:
//   - sale paga → cashback creditado
//   - badge APEX desbloqueado
//   - cupom expirando
//   - novidade no app
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SYSTEM_ID = 'system-teniscash';

async function ensureSystemUser() {
  let bot = await prisma.user.findUnique({ where: { id: SYSTEM_ID } });
  if (!bot) {
    bot = await prisma.user.create({
      data: {
        id: SYSTEM_ID,
        name: 'TenisCash',
        username: 'teniscash',
        phone: '+5500000000000',
        pin: 'system-no-login',
        role: 'system',
        active: true,
      },
    }).catch(async () => prisma.user.findUnique({ where: { id: SYSTEM_ID } }));
  }
  return bot;
}

function canonicalDmPair(a, b) { return a < b ? [a, b] : [b, a]; }

/**
 * Envia mensagem do bot pra qualquer userId.
 * @param {string} userId destinatário
 * @param {object} opts { content, productCardId, pushTitle, pushBody }
 * @returns {Promise<object>} { messageId, conversationId } ou null se falhar
 */
async function notify(userId, opts = {}) {
  try {
    if (!userId) return null;
    const { content, productCardId, pushTitle, pushBody } = opts;
    if (!content && !productCardId) return null;

    const bot = await ensureSystemUser();
    if (userId === bot.id) return null;

    const [a, b] = canonicalDmPair(bot.id, userId);
    const conv = await prisma.conversation.upsert({
      where: { userAId_userBId: { userAId: a, userBId: b } },
      update: {},
      create: { type: 'dm', userAId: a, userBId: b },
    });
    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: conv.id,
        senderId: bot.id,
        senderType: 'system',
        content: content || null,
        productCardId: productCardId || null,
      },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { lastMessageAt: new Date() } });

    // push best-effort
    try {
      const pushSvc = require('./pushNotifications');
      await pushSvc.sendToUser(userId, {
        title: pushTitle || 'TenisCash',
        body: pushBody || (content ? content.slice(0, 100) : '🛍️ Produto'),
        url: '/app.html?conv=' + conv.id,
        tag: 'system-' + conv.id,
      });
    } catch (e) { /* push é best-effort */ }

    return { messageId: msg.id, conversationId: conv.id };
  } catch (err) {
    console.error('[systemMessenger.notify]', err.message);
    return null;
  }
}

// ====================================================
// Templates pré-fabricados (atalhos)
// ====================================================

async function notifyCashbackEarned(userId, amount, saleId) {
  const txt = `🎉 Você ganhou R$ ${Number(amount).toFixed(2)} de TenisCash nessa compra! Seu saldo já tá disponível.`;
  return notify(userId, {
    content: txt,
    pushTitle: 'TenisCash',
    pushBody: `+ R$ ${Number(amount).toFixed(2)} de cashback`,
  });
}

async function notifyBadgeEarned(userId, badgeName, cashbackAwarded) {
  const txt = cashbackAwarded
    ? `🏅 Badge desbloqueado: ${badgeName}! Você ganhou R$ ${Number(cashbackAwarded).toFixed(2)} de TenisCash.`
    : `🏅 Badge desbloqueado: ${badgeName}!`;
  return notify(userId, {
    content: txt,
    pushTitle: '🏅 ' + badgeName,
    pushBody: cashbackAwarded ? `+ R$ ${Number(cashbackAwarded).toFixed(2)}` : 'Você desbloqueou um novo badge!',
  });
}

async function notifyCustom(userId, content, opts = {}) {
  return notify(userId, { content, ...opts });
}

module.exports = {
  ensureSystemUser,
  notify,
  notifyCashbackEarned,
  notifyBadgeEarned,
  notifyCustom,
};
