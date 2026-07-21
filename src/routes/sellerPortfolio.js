// =====================================================================
// Routes: /api/seller/portfolio — Carteira do Vendedor
// =====================================================================
// Tudo aqui é "do próprio vendedor" — usa req.userId como sellerId.
// Admin pode olhar qualquer carteira via /api/admin/seller/...
// =====================================================================

const express = require('express');
const { authMiddleware, storeScope, enforceStoreId, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware, storeScope);

function requireSeller(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a vendedores / loja' });
  }
  next();
}

function ownSellerId(req, requested) {
  if (req.userRole === 'seller') return req.userId;
  return String(requested || req.userId || '').trim();
}

function phoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : digits;
}

// Dashboard do vendedor
router.get('/dashboard', requireSeller, async (req, res) => {
  try {
    const sellerId = ownSellerId(req, req.query.sellerId);
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

// Clientes da carteira — filtros opcionais: sellerId, storeId, status, priority
router.get('/customers', requireSeller, async (req, res) => {
  try {
    const { status, priority, limit, storeId } = req.query;
    const sellerId = ownSellerId(req, req.query.sellerId);
    const where = {
      ...(sellerId ? { sellerId } : {}),
      ...(storeId && storeId !== 'all' ? { storeId } : {}),
      ...(status ? { relationshipStatus: status } : {}),
      ...(priority ? { priority } : {}),
    };
    // Se NAO veio sellerId nem storeId, usar o logado (fallback antigo pro PWA mobile)
    if (!where.sellerId && !where.storeId && req.userRole === 'seller') where.sellerId = req.userId;

    const customers = await prisma.sellerCustomerAssignment.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { nextActionDate: 'asc' }],
      take: Math.min(parseInt(limit, 10) || 100, 500),
    });

    // Enriquecer com nome do cliente (User TenisCash) e nome do vendedor
    if (customers.length) {
      const customerIds = [...new Set(customers.map(c => c.customerId))];
      const sellerIds = [...new Set(customers.map(c => c.sellerId))];
      const [users, sellerClients, sellers] = await Promise.all([
        prisma.user.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true, email: true, balance: true } }),
        prisma.sellerClient.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true, phone: true, email: true, tcUserId: true, totalSpent: true, purchaseCount: true } }),
        prisma.user.findMany({ where: { id: { in: sellerIds } }, select: { id: true, name: true, employeeCode: true } }),
      ]);
      const uMap = new Map(users.map(u => [u.id, u]));
      const clientMap = new Map(sellerClients.map(client => [client.id, client]));
      const sMap = new Map(sellers.map(s => [s.id, s]));
      customers.forEach(c => {
        const u = uMap.get(c.customerId) || clientMap.get(c.customerId);
        const s = sMap.get(c.sellerId);
        c.customerName = u?.name || 'Cliente sem nome cadastrado';
        c.customerPhone = u?.phone || null;
        c.customerEmail = u?.email || null;
        c.customerBalance = u?.balance || 0;
        c.customerSource = clientMap.has(c.customerId) ? 'SELLER_CLIENT' : 'USER';
        c.sellerName = s?.name || null;
        c.sellerCode = s?.employeeCode || null;
      });
    }

    res.json({ customers });
  } catch (err) {
    console.error('[seller/portfolio/customers] erro:', err);
    res.status(500).json({ error: 'Erro ao listar clientes' });
  }
});

// Visao factual do relacionamento. Campos ausentes permanecem nulos; nada e estimado.
router.get('/customers/:id/360', requireSeller, async (req, res) => {
  try {
    const requestedSellerId = ownSellerId(req, req.query.sellerId);
    const assignment = await prisma.sellerCustomerAssignment.findFirst({
      where: {
        id: req.params.id,
        sellerId: requestedSellerId,
        ...(req.scope?.isStoreLocked ? { storeId: req.scope.storeId } : {}),
      },
    });
    if (!assignment) return res.status(404).json({ error: 'Cliente nao encontrado nesta carteira' });

    const [user, sellerClient] = await Promise.all([
      prisma.user.findUnique({
        where: { id: assignment.customerId },
        select: { id: true, name: true, phone: true, email: true, balance: true, createdAt: true },
      }),
      prisma.sellerClient.findUnique({
        where: { id: assignment.customerId },
        select: {
          id: true, tcUserId: true, name: true, phone: true, email: true, birthDate: true,
          city: true, state: true, shirtSize: true, shoeSize: true, notes: true, tags: true,
          totalSpent: true, purchaseCount: true, lastPurchase: true, createdAt: true,
        },
      }),
    ]);
    const customer = user || sellerClient;
    if (!customer) return res.status(404).json({ error: 'Cadastro do cliente nao localizado' });
    const userIds = [user?.id, sellerClient?.tcUserId].filter(Boolean);
    const clientIds = sellerClient ? [sellerClient.id] : [];
    const saleWhere = {
      sellerId: assignment.sellerId,
      OR: [
        ...(userIds.length ? [{ customerUserId: { in: userIds } }] : []),
        ...(clientIds.length ? [{ clientId: { in: clientIds } }] : []),
      ],
    };

    const [sales, interactions, tasks, journeys, whatsappRows, salesCount, paidAggregate, interactionsCount, openTasks] = await Promise.all([
      prisma.sale.findMany({
        where: saleWhere,
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, totalAmount: true, discount: true, tcUsed: true, paymentMethod: true,
          status: true, referralCode: true, createdAt: true,
          items: { select: { productName: true, brand: true, size: true, quantity: true, unitPrice: true, totalPrice: true } },
        },
      }),
      prisma.customerInteraction.findMany({
        where: { sellerId: assignment.sellerId, customerId: assignment.customerId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.sellerTask.findMany({
        where: { sellerId: assignment.sellerId, customerId: assignment.customerId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      userIds.length ? prisma.sellerCommissionJourney.findMany({
        where: { sellerId: assignment.sellerId, customerUserId: { in: userIds } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, cycleNumber: true, purchasePosition: true, baseAmount: true, currentPct: true,
          status: true, startedAt: true,
          stages: { orderBy: { position: 'asc' }, select: { title: true, targetPct: true, status: true, submittedAt: true, reviewedAt: true, reviewNote: true } },
        },
      }) : [],
      prisma.sellerAssistantWhatsappMessage.findMany({
        where: { sellerId: assignment.sellerId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, recipientName: true, phone: true, message: true, status: true, openedAt: true, createdAt: true },
      }),
      prisma.sale.count({ where: saleWhere }),
      prisma.sale.aggregate({ where: { ...saleWhere, status: 'completed' }, _sum: { totalAmount: true } }),
      prisma.customerInteraction.count({ where: { sellerId: assignment.sellerId, customerId: assignment.customerId } }),
      prisma.sellerTask.count({ where: { sellerId: assignment.sellerId, customerId: assignment.customerId, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
    ]);

    const customerPhone = phoneDigits(customer.phone);
    const whatsapp = customerPhone
      ? whatsappRows.filter((row) => phoneDigits(row.phone) === customerPhone).slice(0, 30)
      : [];
    const timeline = [
      ...sales.map((sale) => ({ type: 'SALE', at: sale.createdAt, title: `Venda de R$ ${Number(sale.totalAmount || 0).toFixed(2)}`, detail: sale.items.map((item) => `${item.quantity}x ${item.brand} ${item.productName}`).join(' | '), status: sale.status })),
      ...interactions.map((item) => ({ type: 'INTERACTION', at: item.createdAt, title: `${item.interactionType} via ${item.channel}`, detail: item.summary || item.result || null })),
      ...tasks.map((item) => ({ type: 'TASK', at: item.createdAt, title: item.title, detail: item.description || null, status: item.status, dueAt: item.dueDate })),
      ...whatsapp.map((item) => ({ type: 'WHATSAPP', at: item.createdAt, title: item.status === 'OPENED' ? 'WhatsApp aberto para conferencia' : 'WhatsApp preparado', detail: item.message })),
      ...journeys.flatMap((journey) => journey.stages.filter((stage) => stage.submittedAt || stage.reviewedAt).map((stage) => ({ type: 'COMMISSION', at: stage.reviewedAt || stage.submittedAt, title: `${stage.title} - ${stage.status}`, detail: `Ciclo ${journey.cycleNumber}, ${Number(stage.targetPct).toFixed(2)}%` }))),
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 100);

    res.json({
      assignment,
      customer: {
        source: user ? 'USER' : 'SELLER_CLIENT',
        name: customer.name,
        phone: customer.phone || null,
        email: customer.email || null,
        balance: user?.balance ?? null,
        birthDate: sellerClient?.birthDate || null,
        city: sellerClient?.city || null,
        state: sellerClient?.state || null,
        shirtSize: sellerClient?.shirtSize || null,
        shoeSize: sellerClient?.shoeSize || null,
        notes: sellerClient?.notes || assignment.notes || null,
        tags: sellerClient?.tags || null,
        registeredAt: customer.createdAt,
      },
      summary: {
        salesCount,
        paidSalesTotal: Number(paidAggregate._sum.totalAmount || 0),
        interactionsCount,
        openTasks,
      },
      sales,
      interactions,
      tasks,
      commissionJourneys: journeys,
      whatsapp,
      timeline,
      notice: 'Historico do WhatsApp registra somente mensagens preparadas/abertas no TenisCash; nao confirma entrega nem leitura.',
    });
  } catch (err) {
    console.error('[seller/portfolio/customers/360] erro:', err);
    res.status(500).json({ error: 'Erro ao montar a visao 360 do cliente' });
  }
});

// Dashboard agregado por LOJA (somando vendedores da loja)
router.get('/store-dashboard', requireSeller, async (req, res) => {
  try {
    const storeId = req.query.storeId;
    if (!storeId || storeId === 'all') return res.status(400).json({ error: 'storeId é obrigatório' });

    const where = { storeId };
    const [total, callToday, inactive, rebuy, sellers, pendingTasks, recentInteractions] = await Promise.all([
      prisma.sellerCustomerAssignment.count({ where }),
      prisma.sellerCustomerAssignment.count({ where: { ...where, nextActionDate: { lte: new Date() }, relationshipStatus: { not: 'LOST' } } }),
      prisma.sellerCustomerAssignment.count({ where: { ...where, relationshipStatus: 'INACTIVE' } }),
      prisma.sellerCustomerAssignment.count({ where: { ...where, relationshipStatus: 'REBUY_OPPORTUNITY' } }),
      prisma.user.findMany({ where: { role: 'seller', active: true, storeId }, select: { id: true, name: true, employeeCode: true } }),
      prisma.sellerTask.count({ where: { storeId, status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.customerInteraction.findMany({ where: { storeId }, orderBy: { createdAt: 'desc' }, take: 8 }),
    ]);

    // Contagem de clientes por vendedor da loja
    const byVendor = await prisma.sellerCustomerAssignment.groupBy({
      by: ['sellerId'],
      where,
      _count: { _all: true },
    });
    const vendorMap = new Map(sellers.map(s => [s.id, s]));
    const perSeller = byVendor.map(v => ({
      sellerId: v.sellerId,
      name: vendorMap.get(v.sellerId)?.name || '(removido)',
      employeeCode: vendorMap.get(v.sellerId)?.employeeCode || null,
      customerCount: v._count._all,
    })).sort((a, b) => b.customerCount - a.customerCount);

    res.json({
      stats: { totalCustomers: total, customersToCallToday: callToday, inactiveCustomers: inactive, rebuyOpportunities: rebuy },
      pendingTasks,
      recentInteractions,
      perSeller,
      sellersCount: sellers.length,
    });
  } catch (err) {
    console.error('[seller/portfolio/store-dashboard] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard agregado GERAL (todas as lojas) — apenas admin
router.get('/global-dashboard', requireSeller, async (req, res) => {
  try {
    const [total, callToday, inactive, rebuy, byStore, stores] = await Promise.all([
      prisma.sellerCustomerAssignment.count(),
      prisma.sellerCustomerAssignment.count({ where: { nextActionDate: { lte: new Date() }, relationshipStatus: { not: 'LOST' } } }),
      prisma.sellerCustomerAssignment.count({ where: { relationshipStatus: 'INACTIVE' } }),
      prisma.sellerCustomerAssignment.count({ where: { relationshipStatus: 'REBUY_OPPORTUNITY' } }),
      prisma.sellerCustomerAssignment.groupBy({ by: ['storeId'], _count: { _all: true } }),
      prisma.store.findMany({ where: { active: true }, select: { id: true, name: true, code: true } }),
    ]);
    const sMap = new Map(stores.map(s => [s.id, s]));
    const perStore = byStore.filter(b => b.storeId).map(b => ({
      storeId: b.storeId,
      name: sMap.get(b.storeId)?.name || '?',
      code: sMap.get(b.storeId)?.code || '?',
      customerCount: b._count._all,
    })).sort((a, b) => b.customerCount - a.customerCount);
    res.json({
      stats: { totalCustomers: total, customersToCallToday: callToday, inactiveCustomers: inactive, rebuyOpportunities: rebuy },
      perStore,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/customers', requireSeller, async (req, res) => {
  try {
    const data = req.body || {};
    const sellerId = ownSellerId(req, data.sellerId);
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
    const sellerId = ownSellerId(req, data.sellerId);
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
    const sellerId = ownSellerId(req, req.query.sellerId);
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
    const sellerId = ownSellerId(req, req.query.sellerId);
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
    const sellerId = ownSellerId(req, data.sellerId);
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
