// =====================================================================
// /api/messages-v2 — Sistema novo de mensagens (Timeline + Conversas)
// =====================================================================
// Ver doc: docs/MENSAGENS.md
//
// Endpoints:
//   GET    /timelines                            lista timelines do user
//   POST   /timelines                            cria timeline privada
//   POST   /timelines/:id/members                adiciona membro
//   DELETE /timelines/:id/members/:userId        remove membro
//   GET    /timelines/:id/posts                  lista posts (do dia atual, não expirados)
//   POST   /timelines/:id/posts                  cria post
//   PATCH  /posts/:id                            edita post (próprio, até 00:00)
//   DELETE /posts/:id                            apaga post (próprio, até 00:00)
//
//   GET    /conversations                        lista conversas
//   POST   /conversations                        cria/recupera conversa
//   GET    /conversations/:id/messages           lista mensagens
//   POST   /conversations/:id/messages           envia mensagem
//   PATCH  /messages/:id                         edita mensagem (próprio)
//   DELETE /messages/:id                         apaga mensagem (me|both<2h)
//   PATCH  /conversations/:id/read               marca conversa como lida
//
//   GET    /people/search?q=...                  busca pessoas pra convidar
//   GET    /notifications/summary                contagem de não lidos
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

const TZ = 'America/Fortaleza';

// Helper: pega o início do dia (00:00) no timezone PB pra usar como filtro
async function getTodayStart() {
  const r = await prisma.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE ${TZ})::timestamp AS today`;
  return r[0].today;
}

// Helper: ordena 2 userIds canônicamente (menor primeiro) pra DM
function canonicalDmPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

// ====================================================
// TIMELINE
// ====================================================

// GET /timelines — lista timelines do usuário (pública + privadas que participa)
router.get('/timelines', async (req, res) => {
  try {
    const userId = req.userId;
    const todayStart = await getTodayStart();

    // Timeline pública (sistema) — todos são membros implícitos
    const publicTimeline = await prisma.timeline.findFirst({ where: { isPublic: true, deletedAt: null } });

    // Timelines privadas onde sou membro
    const privateMemberships = await prisma.timelineMember.findMany({
      where: { userId, leftAt: null },
      include: { timeline: { include: { _count: { select: { members: { where: { leftAt: null } } } } } } },
    });

    const result = [];

    if (publicTimeline) {
      const unreadCount = await prisma.timelinePost.count({
        where: {
          timelineId: publicTimeline.id,
          deletedAt: null,
          expiredAt: null,
          createdAt: { gte: todayStart },
          authorId: { not: userId },
        },
      });
      result.push({
        id: publicTimeline.id,
        name: publicTimeline.name,
        isPublic: true,
        memberCount: null,
        unreadCount,
      });
    }

    for (const m of privateMemberships) {
      if (!m.timeline || m.timeline.deletedAt) continue;
      const unreadCount = await prisma.timelinePost.count({
        where: {
          timelineId: m.timeline.id,
          deletedAt: null,
          expiredAt: null,
          createdAt: { gte: todayStart, gt: m.lastReadAt },
          authorId: { not: userId },
        },
      });
      result.push({
        id: m.timeline.id,
        name: m.timeline.name,
        isPublic: false,
        memberCount: m.timeline._count.members,
        unreadCount,
      });
    }

    res.json({ timelines: result });
  } catch (err) {
    console.error('[messagesV2/timelines]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /timelines — cria timeline privada
router.post('/timelines', async (req, res) => {
  try {
    const userId = req.userId;
    const { name, inviteUserIds } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'nome obrigatório' });

    const timeline = await prisma.timeline.create({
      data: {
        name: name.trim(),
        isPublic: false,
        createdById: userId,
        members: {
          create: [
            { userId, role: 'creator' },
            ...(Array.isArray(inviteUserIds) ? inviteUserIds.filter((id) => id && id !== userId).map((id) => ({ userId: id, role: 'member' })) : []),
          ],
        },
      },
      include: { members: true },
    });

    res.json({ timeline });
  } catch (err) {
    console.error('[messagesV2/timelines POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /timelines/:id/members — adicionar membro
router.post('/timelines/:id/members', async (req, res) => {
  try {
    const userId = req.userId;
    const { userId: newUserId, phone, username } = req.body || {};

    // Verifica que sou o creator
    const me = await prisma.timelineMember.findFirst({
      where: { timelineId: req.params.id, userId, role: 'creator', leftAt: null },
    });
    if (!me) return res.status(403).json({ error: 'só o criador pode adicionar membros' });

    // Resolve quem adicionar
    let targetUserId = newUserId;
    if (!targetUserId && phone) {
      const u = await prisma.user.findUnique({ where: { phone } });
      targetUserId = u?.id;
    }
    if (!targetUserId && username) {
      const u = await prisma.user.findUnique({ where: { username } });
      targetUserId = u?.id;
    }
    if (!targetUserId) return res.status(400).json({ error: 'informe userId, phone ou username' });

    const member = await prisma.timelineMember.upsert({
      where: { timelineId_userId: { timelineId: req.params.id, userId: targetUserId } },
      update: { leftAt: null },
      create: { timelineId: req.params.id, userId: targetUserId, role: 'member' },
    });

    res.json({ member });
  } catch (err) {
    console.error('[messagesV2/timelines/:id/members POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /timelines/:id/members/:userId — sai ou remove
router.delete('/timelines/:id/members/:targetUserId', async (req, res) => {
  try {
    const userId = req.userId;
    const targetUserId = req.params.targetUserId;
    const timelineId = req.params.id;

    // Pode sair sozinho. Creator pode remover qualquer um.
    const me = await prisma.timelineMember.findFirst({
      where: { timelineId, userId, leftAt: null },
    });
    if (!me) return res.status(403).json({ error: 'você não é membro' });

    if (me.userId !== targetUserId && me.role !== 'creator') {
      return res.status(403).json({ error: 'só creator pode remover outros' });
    }

    await prisma.timelineMember.updateMany({
      where: { timelineId, userId: targetUserId },
      data: { leftAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[messagesV2/timelines/:id/members DELETE]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /timelines/:id/posts — posts do dia, não expirados
router.get('/timelines/:id/posts', async (req, res) => {
  try {
    const userId = req.userId;
    const timelineId = req.params.id;
    const todayStart = await getTodayStart();

    // Verifica acesso (pública = todos; privada = só membros)
    const timeline = await prisma.timeline.findUnique({ where: { id: timelineId } });
    if (!timeline || timeline.deletedAt) return res.status(404).json({ error: 'timeline não existe' });

    if (!timeline.isPublic) {
      const member = await prisma.timelineMember.findFirst({
        where: { timelineId, userId, leftAt: null },
      });
      if (!member) return res.status(403).json({ error: 'você não é membro desta timeline' });
    }

    const posts = await prisma.timelinePost.findMany({
      where: {
        timelineId,
        deletedAt: null,
        expiredAt: null,
        createdAt: { gte: todayStart },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        author: { select: { id: true, name: true, username: true } },
        productCard: { select: { id: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true } },
      },
    });

    // Atualiza lastReadAt do membro (se for privada e ele for membro)
    if (!timeline.isPublic) {
      await prisma.timelineMember.updateMany({
        where: { timelineId, userId, leftAt: null },
        data: { lastReadAt: new Date() },
      });
    }

    res.json({ timeline: { id: timeline.id, name: timeline.name, isPublic: timeline.isPublic }, posts });
  } catch (err) {
    console.error('[messagesV2/timelines/:id/posts GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /timelines/:id/posts — cria post novo
router.post('/timelines/:id/posts', async (req, res) => {
  try {
    const userId = req.userId;
    const timelineId = req.params.id;
    const { content, mediaType, mediaUrl, mediaDuration, productCardId } = req.body || {};

    if (!content && !mediaUrl && !productCardId) {
      return res.status(400).json({ error: 'content, mediaUrl ou productCardId obrigatório' });
    }

    // Verifica acesso
    const timeline = await prisma.timeline.findUnique({ where: { id: timelineId } });
    if (!timeline || timeline.deletedAt) return res.status(404).json({ error: 'timeline não existe' });

    if (!timeline.isPublic) {
      const member = await prisma.timelineMember.findFirst({
        where: { timelineId, userId, leftAt: null },
      });
      if (!member) return res.status(403).json({ error: 'você não é membro' });
    }

    const post = await prisma.timelinePost.create({
      data: {
        timelineId,
        authorId: userId,
        content: content || null,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null,
        mediaDuration: mediaDuration || null,
        productCardId: productCardId || null,
      },
      include: {
        author: { select: { id: true, name: true, username: true } },
        productCard: { select: { id: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true } },
      },
    });

    res.json({ post });
  } catch (err) {
    console.error('[messagesV2/timelines/:id/posts POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /posts/:id — editar post (próprio, antes de expirar)
router.patch('/posts/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { content, mediaUrl, mediaType } = req.body || {};

    const post = await prisma.timelinePost.findUnique({ where: { id: req.params.id } });
    if (!post || post.deletedAt) return res.status(404).json({ error: 'post não existe' });
    if (post.authorId !== userId) return res.status(403).json({ error: 'não é seu post' });
    if (post.expiredAt) return res.status(400).json({ error: 'post já expirou (00:00 passou)' });

    const updated = await prisma.timelinePost.update({
      where: { id: req.params.id },
      data: {
        content: content !== undefined ? content : post.content,
        mediaUrl: mediaUrl !== undefined ? mediaUrl : post.mediaUrl,
        mediaType: mediaType !== undefined ? mediaType : post.mediaType,
        editedAt: new Date(),
      },
    });
    res.json({ post: updated });
  } catch (err) {
    console.error('[messagesV2/posts PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /posts/:id — apagar post (próprio)
router.delete('/posts/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const post = await prisma.timelinePost.findUnique({ where: { id: req.params.id } });
    if (!post) return res.status(404).json({ error: 'post não existe' });
    if (post.authorId !== userId) return res.status(403).json({ error: 'não é seu post' });

    await prisma.timelinePost.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[messagesV2/posts DELETE]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// CONVERSAS
// ====================================================

// GET /conversations — lista do usuário
router.get('/conversations', async (req, res) => {
  try {
    const userId = req.userId;
    const convs = await prisma.conversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }, { clientUserId: userId }],
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 200,
      include: {
        userA: { select: { id: true, name: true, username: true } },
        userB: { select: { id: true, name: true, username: true } },
        store: { select: { id: true, name: true, code: true } },
        clientUser: { select: { id: true, name: true } },
        messages: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          where: {
            OR: [
              { AND: [{ deletedForBothAt: null }, { senderId: userId }, { deletedForSenderAt: null }] },
              { AND: [{ deletedForBothAt: null }, { senderId: { not: userId } }, { deletedForRecipientAt: null }] },
            ],
          },
        },
      },
    });

    // Conta não lidas
    const enriched = await Promise.all(convs.map(async (c) => {
      const unread = await prisma.chatMessage.count({
        where: {
          conversationId: c.id,
          senderId: { not: userId },
          readAt: null,
          deletedForRecipientAt: null,
          deletedForBothAt: null,
        },
      });
      const otherParty = c.type === 'loja'
        ? { type: 'store', id: c.store?.id, name: c.store?.name, code: c.store?.code }
        : c.userAId === userId
          ? { type: 'user', id: c.userB?.id, name: c.userB?.name, username: c.userB?.username }
          : { type: 'user', id: c.userA?.id, name: c.userA?.name, username: c.userA?.username };
      return {
        id: c.id,
        type: c.type,
        otherParty,
        lastMessage: c.messages[0] || null,
        lastMessageAt: c.lastMessageAt,
        unreadCount: unread,
      };
    }));

    res.json({ conversations: enriched });
  } catch (err) {
    console.error('[messagesV2/conversations GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations — cria/recupera (idempotente)
router.post('/conversations', async (req, res) => {
  try {
    const userId = req.userId;
    const { type, toUserId, toStoreId } = req.body || {};

    if (type === 'dm') {
      if (!toUserId || toUserId === userId) return res.status(400).json({ error: 'toUserId inválido' });
      const [a, b] = canonicalDmPair(userId, toUserId);
      const conv = await prisma.conversation.upsert({
        where: { userAId_userBId: { userAId: a, userBId: b } },
        update: {},
        create: { type: 'dm', userAId: a, userBId: b },
      });
      return res.json({ conversation: conv });
    }

    if (type === 'loja') {
      if (!toStoreId) return res.status(400).json({ error: 'toStoreId obrigatório' });
      const conv = await prisma.conversation.upsert({
        where: { storeId_clientUserId: { storeId: toStoreId, clientUserId: userId } },
        update: {},
        create: { type: 'loja', storeId: toStoreId, clientUserId: userId },
      });
      return res.json({ conversation: conv });
    }

    res.status(400).json({ error: 'type deve ser dm ou loja' });
  } catch (err) {
    console.error('[messagesV2/conversations POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /conversations/:id/messages — lista mensagens
router.get('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.userId;
    const convId = req.params.id;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    // Verifica acesso
    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ error: 'conversa não existe' });
    const isParticipant =
      conv.userAId === userId || conv.userBId === userId || conv.clientUserId === userId;
    if (!isParticipant) return res.status(403).json({ error: 'sem acesso' });

    // Filtra por soft-delete
    const messages = await prisma.chatMessage.findMany({
      where: {
        conversationId: convId,
        deletedForBothAt: null,
        OR: [
          { AND: [{ senderId: userId }, { deletedForSenderAt: null }] },
          { AND: [{ senderId: { not: userId } }, { deletedForRecipientAt: null }] },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        sender: { select: { id: true, name: true, username: true } },
        productCard: { select: { id: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true, sku: true } },
      },
    });

    res.json({ conversation: conv, messages: messages.reverse() });
  } catch (err) {
    console.error('[messagesV2/conversations/:id/messages GET]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /conversations/:id/messages — envia mensagem
router.post('/conversations/:id/messages', async (req, res) => {
  try {
    const userId = req.userId;
    const convId = req.params.id;
    const { content, mediaType, mediaUrl, mediaDuration, productCardId } = req.body || {};

    if (!content && !mediaUrl && !productCardId) {
      return res.status(400).json({ error: 'content, mediaUrl ou productCardId obrigatório' });
    }

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ error: 'conversa não existe' });
    const isParticipant =
      conv.userAId === userId || conv.userBId === userId || conv.clientUserId === userId;
    if (!isParticipant) return res.status(403).json({ error: 'sem acesso' });

    const senderType = conv.type === 'loja' && conv.clientUserId !== userId ? 'store' : 'user';

    const msg = await prisma.chatMessage.create({
      data: {
        conversationId: convId,
        senderId: userId,
        senderType,
        content: content || null,
        mediaType: mediaType || null,
        mediaUrl: mediaUrl || null,
        mediaDuration: mediaDuration || null,
        productCardId: productCardId || null,
      },
      include: {
        sender: { select: { id: true, name: true, username: true } },
        productCard: { select: { id: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true } },
      },
    });

    await prisma.conversation.update({
      where: { id: convId },
      data: { lastMessageAt: new Date() },
    });

    res.json({ message: msg });
  } catch (err) {
    console.error('[messagesV2/conversations/:id/messages POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /messages/:id — editar mensagem (próprio)
router.patch('/messages/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const { content } = req.body || {};

    const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
    if (!msg) return res.status(404).json({ error: 'mensagem não existe' });
    if (msg.senderId !== userId) return res.status(403).json({ error: 'não é sua mensagem' });

    const updated = await prisma.chatMessage.update({
      where: { id: req.params.id },
      data: { content: content !== undefined ? content : msg.content, editedAt: new Date() },
    });
    res.json({ message: updated });
  } catch (err) {
    console.error('[messagesV2/messages PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /messages/:id — apaga mensagem
router.delete('/messages/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const scope = String(req.query.scope || req.body?.scope || 'me'); // 'me' | 'both'

    const msg = await prisma.chatMessage.findUnique({ where: { id: req.params.id } });
    if (!msg) return res.status(404).json({ error: 'mensagem não existe' });

    const conv = await prisma.conversation.findUnique({ where: { id: msg.conversationId } });
    const isParticipant =
      conv.userAId === userId || conv.userBId === userId || conv.clientUserId === userId;
    if (!isParticipant) return res.status(403).json({ error: 'sem acesso' });

    if (scope === 'both') {
      if (msg.senderId !== userId) return res.status(403).json({ error: 'só o remetente pode apagar pros dois' });
      const ageMs = Date.now() - new Date(msg.createdAt).getTime();
      if (ageMs > 2 * 60 * 60 * 1000) {
        return res.status(400).json({ error: 'janela de 2h expirou — só dá pra apagar pro seu lado' });
      }
      await prisma.chatMessage.update({ where: { id: msg.id }, data: { deletedForBothAt: new Date() } });
      return res.json({ success: true, scope: 'both' });
    }

    // scope = 'me' — sempre permitido
    if (msg.senderId === userId) {
      await prisma.chatMessage.update({ where: { id: msg.id }, data: { deletedForSenderAt: new Date() } });
    } else {
      await prisma.chatMessage.update({ where: { id: msg.id }, data: { deletedForRecipientAt: new Date() } });
    }
    res.json({ success: true, scope: 'me' });
  } catch (err) {
    console.error('[messagesV2/messages DELETE]', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /conversations/:id/read — marca como lida
router.patch('/conversations/:id/read', async (req, res) => {
  try {
    const userId = req.userId;
    const convId = req.params.id;

    const conv = await prisma.conversation.findUnique({ where: { id: convId } });
    if (!conv) return res.status(404).json({ error: 'conversa não existe' });
    const isParticipant =
      conv.userAId === userId || conv.userBId === userId || conv.clientUserId === userId;
    if (!isParticipant) return res.status(403).json({ error: 'sem acesso' });

    await prisma.chatMessage.updateMany({
      where: {
        conversationId: convId,
        senderId: { not: userId },
        readAt: null,
      },
      data: { readAt: new Date() },
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[messagesV2/conversations/:id/read PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// BUSCA DE PESSOAS (pra convidar em timelines)
// ====================================================

router.get('/people/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ people: [] });

    const cleanPhone = q.replace(/\D/g, '');
    const where = {
      active: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { username: { contains: q.toLowerCase() } },
      ],
    };
    if (cleanPhone.length >= 8) where.OR.push({ phone: { contains: cleanPhone } });

    const people = await prisma.user.findMany({
      where,
      select: { id: true, name: true, username: true, phone: true },
      take: 20,
    });

    res.json({ people });
  } catch (err) {
    console.error('[messagesV2/people/search]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// BUSCA DE PRODUTOS (pra anexar como card em chat/post)
// ====================================================

router.get('/products/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) return res.json({ products: [] });

    const where = {
      active: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { barcode: { contains: q } },
      ],
    };

    const products = await prisma.product.findMany({
      where,
      select: { id: true, sku: true, name: true, brand: true, price: true, promoPrice: true, imageUrl: true },
      orderBy: [{ featured: 'desc' }, { name: 'asc' }],
      take: 20,
    });

    res.json({ products });
  } catch (err) {
    console.error('[messagesV2/products/search]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// NOTIFICAÇÕES (summary pro badge)
// ====================================================

router.get('/notifications/summary', async (req, res) => {
  try {
    const userId = req.userId;
    const todayStart = await getTodayStart();

    // Conversas com mensagens não lidas
    const convs = await prisma.conversation.findMany({
      where: {
        OR: [{ userAId: userId }, { userBId: userId }, { clientUserId: userId }],
      },
      select: { id: true },
    });
    const convIds = convs.map((c) => c.id);

    const unreadConversations = convIds.length === 0 ? 0 : await prisma.chatMessage.count({
      where: {
        conversationId: { in: convIds },
        senderId: { not: userId },
        readAt: null,
        deletedForRecipientAt: null,
        deletedForBothAt: null,
      },
    });

    // Timelines com posts não lidos
    const publicTimeline = await prisma.timeline.findFirst({ where: { isPublic: true, deletedAt: null } });
    const memberships = await prisma.timelineMember.findMany({
      where: { userId, leftAt: null },
      include: { timeline: true },
    });

    const unreadTimelines = [];
    if (publicTimeline) {
      const c = await prisma.timelinePost.count({
        where: {
          timelineId: publicTimeline.id,
          deletedAt: null,
          expiredAt: null,
          createdAt: { gte: todayStart },
          authorId: { not: userId },
        },
      });
      if (c > 0) unreadTimelines.push({ timelineId: publicTimeline.id, name: publicTimeline.name, unreadCount: c });
    }

    for (const m of memberships) {
      if (!m.timeline || m.timeline.deletedAt) continue;
      const c = await prisma.timelinePost.count({
        where: {
          timelineId: m.timeline.id,
          deletedAt: null,
          expiredAt: null,
          createdAt: { gte: todayStart, gt: m.lastReadAt },
          authorId: { not: userId },
        },
      });
      if (c > 0) unreadTimelines.push({ timelineId: m.timeline.id, name: m.timeline.name, unreadCount: c });
    }

    res.json({
      unreadConversations,
      unreadTimelines,
      totalUnread: unreadConversations + unreadTimelines.reduce((s, t) => s + t.unreadCount, 0),
    });
  } catch (err) {
    console.error('[messagesV2/notifications/summary]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
