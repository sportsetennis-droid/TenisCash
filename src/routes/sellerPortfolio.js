// =====================================================================
// Routes: /api/seller/portfolio — Carteira do Vendedor
// =====================================================================
// Tudo aqui é "do próprio vendedor" — usa req.userId como sellerId.
// Admin pode olhar qualquer carteira via /api/admin/seller/...
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

function requireSeller(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a vendedores / loja' });
  }
  next();
}

// Dashboard do vendedor
router.get('/dashboard', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);

    const [assignments, customersToCallToday, tasksDue, recentInteractions, weeklyInterview] = await Promise.all([
      prisma.sellerCustomerAssignment.count({ where: { sellerId } }),
      prisma.sellerCustomerAssignment.count({
        where: { sellerId, nextActionDate: { lte: new Date() }, relationshipStatus: { not: 'LOST' } },
      }),
      prisma.sellerTask.findMany({
        where: { sellerId, status: { in: ['TODO', 'IN_PROGRESS'] } },
        orderBy: { dueDate: 'asc' },
        take: 10,
      }),
      prisma.customerInteraction.findMany({
        where: { sellerId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.sellerWeeklyInterview.findFirst({
        where: { sellerId },
        orderBy: { weekStartDate: 'desc' },
      }),
    ]);

    const inactiveCustomers = await prisma.sellerCustomerAssignment.count({
      where: { sellerId, relationshipStatus: 'INACTIVE' },
    });
    const rebuyOpps = await prisma.sellerCustomerAssignment.count({
      where: { sellerId, relationshipStatus: 'REBUY_OPPORTUNITY' },
    });

    res.json({
      stats: {
        totalCustomers: assignments,
        customersToCallToday,
        inactiveCustomers,
        rebuyOpportunities: rebuyOpps,
      },
      tasks: tasksDue,
      recentInteractions,
      weeklyInterview: weeklyInterview
        ? { id: weeklyInterview.id, status: weeklyInterview.status, weekStartDate: weeklyInterview.weekStartDate, submittedAt: weeklyInterview.submittedAt }
        : null,
    });
  } catch (err) {
    console.error('[seller/portfolio/dashboard] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// Clientes da carteira
router.get('/customers', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const { status, priority, limit } = req.query;
    const where = {
      sellerId,
      ...(status ? { relationshipStatus: status } : {}),
      ...(priority ? { priority } : {}),
    };
    const customers = await prisma.sellerCustomerAssignment.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { nextActionDate: 'asc' }],
      take: Math.min(parseInt(limit, 10) || 100, 500),
    });
    res.json({ customers });
  } catch (err) {
    console.error('[seller/portfolio/customers] erro:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

router.post('/customers', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    const sellerId = data.sellerId || req.userId;
    if (!data.customerId) return res.status(400).json({ error: 'customerId é obrigatório' });
    const assignment = await prisma.sellerCustomerAssignment.create({
      data: {
        sellerId,
        customerId: data.customerId,
        storeId: data.storeId || null,
        relationshipStatus: data.relationshipStatus || 'NEW_LEAD',
        priority: data.priority || 'MEDIUM',
        nextAction: data.nextAction || null,
        nextActionDate: data.nextActionDate ? new Date(data.nextActionDate) : null,
        potentialValue: data.potentialValue || null,
        notes: data.notes || null,
      },
    });
    res.json({ assignment });
  } catch (err) {
    console.error('[seller/portfolio/customers POST] erro:', err);
    res.status(500).json({ error: 'Erro ao atribuir cliente', detail: err.message });
  }
});

router.put('/customers/:id', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    if (data.nextActionDate) data.nextActionDate = new Date(data.nextActionDate);
    const assignment = await prisma.sellerCustomerAssignment.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ assignment });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar cliente', detail: err.message });
  }
});

// Interações
router.post('/interactions', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    const sellerId = data.sellerId || req.userId;
    if (!data.customerId || !data.channel || !data.interactionType) {
      return res.status(400).json({ error: 'customerId, channel e interactionType são obrigatórios' });
    }
    const interaction = await prisma.customerInteraction.create({
      data: {
        sellerId,
        customerId: data.customerId,
        storeId: data.storeId || null,
        channel: data.channel,
        interactionType: data.interactionType,
        productId: data.productId || null,
        summary: data.summary || null,
        result: data.result || null,
        nextAction: data.nextAction || null,
        nextActionDate: data.nextActionDate ? new Date(data.nextActionDate) : null,
      },
    });
    res.json({ interaction });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao registrar interação', detail: err.message });
  }
});

router.get('/interactions', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const customerId = req.query.customerId || null;
    const where = { sellerId, ...(customerId ? { customerId } : {}) };
    const list = await prisma.customerInteraction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ interactions: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar interações' });
  }
});

// Tarefas
router.get('/tasks', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const status = req.query.status;
    const where = { sellerId, ...(status ? { status } : {}) };
    const tasks = await prisma.sellerTask.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      take: 100,
    });
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar tarefas' });
  }
});

router.post('/tasks', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    const sellerId = data.sellerId || req.userId;
    if (!data.title || !data.type) return res.status(400).json({ error: 'title e type são obrigatórios' });
    const task = await prisma.sellerTask.create({
      data: {
        sellerId,
        customerId: data.customerId || null,
        storeId: data.storeId || null,
        title: data.title,
        description: data.description || null,
        type: data.type,
        priority: data.priority || 'MEDIUM',
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        status: 'TODO',
      },
    });
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar tarefa', detail: err.message });
  }
});

router.put('/tasks/:id', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    const task = await prisma.sellerTask.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ task });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa', detail: err.message });
  }
});

module.exports = router;
