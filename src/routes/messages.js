const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

function sellerOnly(req, res, next) {
  if (req.userRole !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
  }
  next();
}

function isValidType(type) {
  return ['message', 'demand', 'announcement', 'request'].includes(type);
}

function isValidPriority(p) {
  return ['low', 'normal', 'high', 'urgent'].includes(p);
}

function safeStr(v, max = 2000) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function parseDueDate(v) {
  if (!v) return null;
  const d = new Date(v);
  // eslint-disable-next-line no-restricted-globals
  if (isNaN(d.getTime())) return null;
  return d;
}

async function getMe(req) {
  return prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, role: true, active: true, storeId: true, store: { select: { id: true, code: true, name: true } } },
  });
}

// ==================== INBOX ====================
router.get('/inbox', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { type, status } = req.query || {};
    const where = {
      OR: [
        { toId: me.id },
        ...(me.storeId ? [{ toId: null, toStoreId: me.storeId }] : []),
        { toId: null, toAll: true },
      ],
      ...(type && isValidType(type) ? { type } : {}),
      ...(status ? { status: String(status) } : {}),
    };

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        priority: true,
        dueDate: true,
        status: true,
        readAt: true,
        doneAt: true,
        repliedAt: true,
        createdAt: true,
        from: { select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } } },
      },
    });

    res.json({ messages });
  } catch (err) {
    console.error('Erro messages/inbox:', err);
    res.status(500).json({ error: 'Erro ao listar mensagens' });
  }
});

// ==================== SENT ====================
router.get('/sent', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const messages = await prisma.message.findMany({
      where: { fromId: me.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        priority: true,
        dueDate: true,
        status: true,
        readAt: true,
        repliedAt: true,
        replyContent: true,
        createdAt: true,
        to: { select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } } },
        toStore: { select: { id: true, code: true, name: true } },
        toAll: true,
      },
    });

    res.json({ messages });
  } catch (err) {
    console.error('Erro messages/sent:', err);
    res.status(500).json({ error: 'Erro ao listar enviadas' });
  }
});

// ==================== PENDING ====================
router.get('/pending', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const now = new Date();

    const incoming = await prisma.message.findMany({
      where: {
        toId: me.id,
        OR: [
          { type: 'demand', NOT: { status: 'done' } },
          { type: 'announcement', NOT: { status: 'confirmed' } },
        ],
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        priority: true,
        dueDate: true,
        status: true,
        createdAt: true,
        from: { select: { id: true, name: true, store: { select: { code: true } } } },
      },
    });

    const requestsAnswered = await prisma.message.findMany({
      where: {
        fromId: me.id,
        type: 'request',
        OR: [{ status: 'approved' }, { status: 'rejected' }],
        // vendedor ainda não abriu a resposta
        readAt: null,
      },
      orderBy: { repliedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        status: true,
        repliedAt: true,
        replyContent: true,
        createdAt: true,
      },
    });

    const items = incoming.map((m) => ({
      ...m,
      overdue: m.type === 'demand' && m.dueDate ? new Date(m.dueDate).getTime() < now.getTime() && m.status !== 'done' : false,
    }));

    res.json({ pending: items, requestReplies: requestsAnswered });
  } catch (err) {
    console.error('Erro messages/pending:', err);
    res.status(500).json({ error: 'Erro ao listar pendências' });
  }
});

// ==================== CREATE ====================
router.post('/', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (req.userRole !== 'seller') return res.status(403).json({ error: 'Apenas vendedor pode criar nesta rota' });

    const { toId, type, title, content, priority, dueDate } = req.body || {};
    const t = String(type || '').trim();
    if (!isValidType(t)) return res.status(400).json({ error: 'Tipo inválido' });

    const c = safeStr(content, 2000);
    if (!c) return res.status(400).json({ error: 'Conteúdo é obrigatório' });

    const ttl = title ? safeStr(title, 120) : null;
    const pr = priority ? String(priority).trim() : null;
    const dd = parseDueDate(dueDate);

    // validações por tipo
    if (t === 'announcement') return res.status(403).json({ error: 'Vendedor não pode enviar anúncio' });

    if (t === 'demand') {
      if (!toId) return res.status(400).json({ error: 'toId é obrigatório para demanda' });
      if (!ttl) return res.status(400).json({ error: 'Título é obrigatório para demanda' });
      if (!dd) return res.status(400).json({ error: 'dueDate é obrigatório e deve ser válido' });
      if (pr && !isValidPriority(pr)) return res.status(400).json({ error: 'priority inválido (low/normal/high/urgent)' });
    }

    if (t === 'request') {
      if (!ttl) return res.status(400).json({ error: 'Título é obrigatório para solicitação' });
    }

    if (t === 'message') {
      if (!toId) return res.status(400).json({ error: 'toId é obrigatório para mensagem' });
    }

    if (toId && String(toId) === me.id) return res.status(400).json({ error: 'Não pode enviar mensagem para si mesmo' });

    // Destino request: primeiro superadmin/admin ativo (um único destinatário)
    if (t === 'request') {
      const admin = await prisma.user.findFirst({
        where: { active: true, role: { in: ['superadmin', 'admin'] } },
        orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
        select: { id: true },
      });
      if (!admin) return res.status(400).json({ error: 'Nenhum admin disponível para receber solicitações' });

      const msg = await prisma.message.create({
        data: {
          fromId: me.id,
          toId: admin.id,
          type: 'request',
          title: ttl,
          content: c,
          status: 'sent',
        },
      });
      return res.json({ success: true, message: msg });
    }

    // Demanda/mensagem: valida destinatário
    const dest = await prisma.user.findUnique({
      where: { id: String(toId) },
      select: { id: true, role: true, active: true },
    });
    if (!dest || !dest.active) return res.status(404).json({ error: 'Destinatário não encontrado' });

    if (dest.role === 'admin' || dest.role === 'superadmin') {
      if (t !== 'message') return res.status(400).json({ error: 'Vendedor só pode falar com admin via message ou request' });
    }

    if (dest.role !== 'seller' && dest.role !== 'admin' && dest.role !== 'superadmin') {
      return res.status(400).json({ error: 'Destinatário inválido' });
    }

    const msg = await prisma.message.create({
      data: {
        fromId: me.id,
        toId: dest.id,
        type: t,
        title: ttl,
        content: c,
        priority: t === 'demand' ? (pr || 'normal') : null,
        dueDate: t === 'demand' ? dd : null,
        status: 'sent',
      },
    });

    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('Erro messages create:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// ==================== READ ====================
router.put('/:id/read', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const id = String(req.params.id);
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, toId: true, fromId: true, status: true, type: true, repliedAt: true },
    });
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });

    const can =
      msg.toId === me.id ||
      (msg.fromId === me.id && msg.type === 'request' && msg.repliedAt); // vendedor lendo a resposta do admin
    if (!can) return res.status(403).json({ error: 'Sem permissão' });

    const updated = await prisma.message.update({
      where: { id },
      data: {
        readAt: msg.status === 'read' || msg.status === 'done' || msg.status === 'confirmed' ? undefined : new Date(),
        status: msg.status === 'sent' ? 'read' : msg.status,
      },
      select: { id: true, status: true, readAt: true },
    });
    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Erro messages/read:', err);
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// ==================== DONE (demand) ====================
router.put('/:id/done', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const id = String(req.params.id);
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, toId: true, type: true, status: true },
    });
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.type !== 'demand') return res.status(400).json({ error: 'Apenas demandas podem ser marcadas como feito' });
    if (msg.toId !== me.id) return res.status(403).json({ error: 'Apenas o destinatário pode concluir a demanda' });

    const updated = await prisma.message.update({
      where: { id },
      data: { status: 'done', doneAt: new Date(), doneById: me.id },
      select: { id: true, status: true, doneAt: true },
    });
    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Erro messages/done:', err);
    res.status(500).json({ error: 'Erro ao marcar como feito' });
  }
});

// ==================== CONFIRM (announcement) ====================
router.put('/:id/confirm', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const id = String(req.params.id);
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, toId: true, type: true },
    });
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.type !== 'announcement') return res.status(400).json({ error: 'Apenas anúncios podem ser confirmados' });
    if (msg.toId !== me.id) return res.status(403).json({ error: 'Apenas o destinatário pode confirmar' });

    const updated = await prisma.message.update({
      where: { id },
      data: { status: 'confirmed', doneAt: new Date(), doneById: me.id },
      select: { id: true, status: true },
    });
    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Erro messages/confirm:', err);
    res.status(500).json({ error: 'Erro ao confirmar' });
  }
});

// ==================== DONE (alias obrigatório na spec) ====================
router.put('/:id/done', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const me = await getMe(req);
    if (!me || !me.active) return res.status(404).json({ error: 'Usuário não encontrado' });

    const id = String(req.params.id);
    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, toId: true, type: true },
    });
    if (!msg) return res.status(404).json({ error: 'Mensagem não encontrada' });
    if (msg.type !== 'demand') return res.status(400).json({ error: 'Apenas demandas podem ser marcadas como feito' });
    if (msg.toId !== me.id) return res.status(403).json({ error: 'Apenas o destinatário pode concluir a demanda' });

    const updated = await prisma.message.update({
      where: { id },
      data: { status: 'done', doneAt: new Date(), doneById: me.id },
      select: { id: true, status: true, doneAt: true },
    });
    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Erro messages/done:', err);
    res.status(500).json({ error: 'Erro ao marcar como feito' });
  }
});

module.exports = router;

