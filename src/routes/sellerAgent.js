// =====================================================================
// Routes: /api/seller/agent - Agente do Vendedor
// =====================================================================
// V1: cria plano diario, conversa contextual e aplica tarefas sugeridas
// usando a carteira existente do vendedor.
// =====================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware, storeScope, prisma } = require('../middleware');
const { searchProductsForAI, listCatalogSummary } = require('../services/catalogSearch');

const router = express.Router();
router.use(authMiddleware, storeScope);

const ACTIVE_TASK_STATUS = ['TODO', 'IN_PROGRESS'];
const ALLOWED_TASK_TYPES = new Set([
  'CALL_CUSTOMER',
  'SEND_WHATSAPP',
  'INVITE_TO_STORE',
  'SEND_PROMOTION',
  'FOLLOW_UP',
  'POST_SALE',
  'REACTIVATE_CUSTOMER',
  'SEND_PRODUCT',
]);

const PRIORITY_WEIGHT = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const RELATIONSHIP_WEIGHT = {
  HIGH_INTENT: 5,
  REBUY_OPPORTUNITY: 4,
  ALMOST_BOUGHT: 4,
  VIP: 4,
  PRICE_SENSITIVE: 3,
  INACTIVE: 3,
  NEW_LEAD: 2,
  ATTENDED: 2,
  RECURRING: 2,
  BUYER: 1,
  LOST: 0,
};

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `seller-agent:${req.userId || req.ip}`,
  message: { error: 'Muitas mensagens para o agente. Aguarde um instante.' },
});

function requireSeller(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a vendedores' });
  }
  next();
}

function resolveSellerId(req) {
  if (req.userRole === 'seller') return req.userId;
  return String(req.query.sellerId || req.body?.sellerId || req.userId || '').trim();
}

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function safeText(value, max = 600) {
  let s = String(value || '').trim();
  s = s.replace(/ignore (previous|all) instructions/gi, '[redacted]');
  if (s.length > max) s = s.slice(0, max);
  return s;
}

function parseMessages(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  try {
    const v = JSON.parse(JSON.stringify(json));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function anthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function buildCostBRL(usage) {
  const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
  const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { usd, brl: usd * brl, inT, outT };
}

function formatDateTime(dt) {
  if (!dt) return null;
  try {
    return new Date(dt).toISOString();
  } catch {
    return null;
  }
}

function isDueTodayOrLate(dt) {
  if (!dt) return false;
  return new Date(dt) <= endOfDay();
}

function customerDisplay(id, userMap, sellerClientMap) {
  const sc = sellerClientMap.get(id);
  if (sc) {
    return {
      id,
      name: sc.name || 'Cliente',
      phone: sc.phone || null,
      email: sc.email || null,
      shoeSize: sc.shoeSize || null,
      tags: sc.tags || null,
      source: 'sellerClient',
    };
  }
  const u = userMap.get(id);
  if (u) {
    return {
      id,
      name: u.name || 'Cliente TenisCash',
      phone: u.phone || null,
      email: u.email || null,
      balance: u.balance || 0,
      sportsPractice: u.sportsPractice || null,
      favBrands: u.favBrands || null,
      source: 'user',
    };
  }
  return { id, name: 'Cliente', source: 'unknown' };
}

function rankAssignment(a) {
  const due = isDueTodayOrLate(a.nextActionDate) ? 10 : 0;
  return (
    due +
    (PRIORITY_WEIGHT[a.priority] || 0) * 2 +
    (RELATIONSHIP_WEIGHT[a.relationshipStatus] || 0)
  );
}

function summarizeSaleItems(items) {
  const byProduct = new Map();
  for (const item of items || []) {
    const key = item.productId || item.productName || 'produto';
    const cur = byProduct.get(key) || {
      productId: item.productId || null,
      name: item.product?.name || item.productName || 'Produto',
      brand: item.product?.brand || item.brand || '',
      category: item.product?.category || item.category || '',
      imageUrl: item.product?.imageUrl || null,
      quantity: 0,
      total: 0,
    };
    cur.quantity += item.quantity || 0;
    cur.total += item.totalPrice || 0;
    byProduct.set(key, cur);
  }
  return Array.from(byProduct.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

function buildRecommendedTasks(snapshot) {
  const tasks = [];
  const now = new Date();
  const baseDue = addMinutes(now, 45);
  const customers = snapshot.priorityCustomers || [];

  customers.slice(0, 5).forEach((c, idx) => {
    const type = c.relationshipStatus === 'INACTIVE'
      ? 'REACTIVATE_CUSTOMER'
      : c.relationshipStatus === 'REBUY_OPPORTUNITY'
        ? 'SEND_PRODUCT'
        : 'FOLLOW_UP';
    const verb = type === 'REACTIVATE_CUSTOMER'
      ? 'Reativar'
      : type === 'SEND_PRODUCT'
        ? 'Enviar sugestao para'
        : 'Fazer follow-up com';
    tasks.push({
      title: `${verb} ${c.customerName}`,
      description: c.nextAction
        ? `Agente: ${c.nextAction}`
        : `Agente: retomar contato com abordagem curta, entender necessidade e registrar o proximo passo.`,
      type,
      priority: c.priority || 'MEDIUM',
      customerId: c.customerId || null,
      customerName: c.customerName || null,
      dueDate: formatDateTime(addMinutes(baseDue, idx * 45)),
    });
  });

  if (snapshot.stats.tasksOpen < 3) {
    tasks.push({
      title: 'Registrar 3 atendimentos do turno',
      description: 'Agente: depois de cada conversa, registrar resumo, resultado e proxima acao.',
      type: 'FOLLOW_UP',
      priority: 'MEDIUM',
      customerId: null,
      customerName: null,
      dueDate: formatDateTime(addMinutes(baseDue, 30)),
    });
  }

  if (!snapshot.weeklyInterview || snapshot.weeklyInterview.status !== 'SUBMITTED') {
    tasks.push({
      title: 'Atualizar entrevista semanal',
      description: 'Agente: responder dificuldades, produtos pedidos e oportunidades vistas na loja.',
      type: 'FOLLOW_UP',
      priority: 'LOW',
      customerId: null,
      customerName: null,
      dueDate: formatDateTime(addMinutes(baseDue, 240)),
    });
  }

  return tasks.slice(0, 7);
}

function buildPlan(snapshot) {
  const topCustomer = snapshot.priorityCustomers[0];
  const firstAction = topCustomer
    ? `Comece por ${topCustomer.customerName}: ${topCustomer.nextAction || 'retomar contato e registrar resultado.'}`
    : 'Comece criando ou revisando sua carteira de clientes para o turno.';

  const focus = snapshot.focusProducts[0]
    ? `${snapshot.focusProducts[0].brand} ${snapshot.focusProducts[0].name}`.trim()
    : 'produto de maior giro da loja';

  return {
    headline: 'Plano de turno pronto',
    firstAction,
    focus,
    priorities: [
      `${snapshot.stats.customersDue} cliente(s) com acao vencendo hoje`,
      `${snapshot.stats.tasksOpen} tarefa(s) aberta(s)`,
      `${snapshot.stats.rebuyOpportunities} oportunidade(s) de recompra`,
    ],
    recommendedTasks: buildRecommendedTasks(snapshot),
  };
}

async function enrichAssignments(assignments) {
  const customerIds = [...new Set((assignments || []).map((c) => c.customerId).filter(Boolean))];
  if (!customerIds.length) return [];
  const [users, sellerClients] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        balance: true,
        sportsPractice: true,
        favBrands: true,
      },
    }),
    prisma.sellerClient.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        shoeSize: true,
        tags: true,
        totalSpent: true,
        purchaseCount: true,
      },
    }),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const sellerClientMap = new Map(sellerClients.map((c) => [c.id, c]));

  return assignments.map((a) => {
    const meta = customerDisplay(a.customerId, userMap, sellerClientMap);
    return {
      id: a.id,
      sellerId: a.sellerId,
      customerId: a.customerId,
      customerName: meta.name,
      customerPhone: meta.phone,
      customerEmail: meta.email,
      relationshipStatus: a.relationshipStatus,
      priority: a.priority,
      nextAction: a.nextAction,
      nextActionDate: formatDateTime(a.nextActionDate),
      potentialValue: a.potentialValue,
      notes: a.notes,
      rank: rankAssignment(a),
      source: meta.source,
    };
  });
}

async function loadSellerSnapshot(req) {
  const sellerId = resolveSellerId(req);
  if (!sellerId) {
    const err = new Error('sellerId obrigatorio');
    err.statusCode = 400;
    throw err;
  }

  const seller = await prisma.user.findUnique({
    where: { id: sellerId },
    select: {
      id: true,
      name: true,
      role: true,
      employeeCode: true,
      storeId: true,
      store: { select: { id: true, name: true, code: true, dna: true, city: true } },
    },
  });
  if (!seller) {
    const err = new Error('Vendedor nao encontrado');
    err.statusCode = 404;
    throw err;
  }
  if (req.userRole === 'seller' && seller.id !== req.userId) {
    const err = new Error('Voce so pode acessar seu proprio agente');
    err.statusCode = 403;
    throw err;
  }
  if (req.scope?.isStoreLocked && seller.storeId && seller.storeId !== req.scope.storeId) {
    const err = new Error('Vendedor fora da loja vinculada');
    err.statusCode = 403;
    throw err;
  }

  const since30 = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  const since14 = new Date(Date.now() - 14 * 24 * 3600 * 1000);
  const now = new Date();

  const assignmentWhere = {
    sellerId,
    relationshipStatus: { not: 'LOST' },
  };

  const [
    assignmentRows,
    tasks,
    recentInteractions,
    openInsights,
    weeklyInterview,
    sales30,
    saleItems30,
    catalogSummary,
    featuredProducts,
  ] = await Promise.all([
    prisma.sellerCustomerAssignment.findMany({
      where: assignmentWhere,
      orderBy: [{ updatedAt: 'desc' }],
      take: 50,
    }),
    prisma.sellerTask.findMany({
      where: { sellerId, status: { in: ACTIVE_TASK_STATUS } },
      orderBy: [{ dueDate: 'asc' }, { updatedAt: 'desc' }],
      take: 12,
    }),
    prisma.customerInteraction.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.sellerInsight.findMany({
      where: { sellerId, status: { in: ['OPEN', 'IN_REVIEW'] } },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    }),
    prisma.sellerWeeklyInterview.findFirst({
      where: { sellerId },
      orderBy: { weekStartDate: 'desc' },
    }),
    prisma.sale.findMany({
      where: { sellerId, createdAt: { gte: since30 } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, totalAmount: true, createdAt: true },
    }),
    prisma.saleItem.findMany({
      where: { sale: { sellerId, createdAt: { gte: since30 } } },
      take: 100,
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            brand: true,
            category: true,
            imageUrl: true,
            price: true,
            promoPrice: true,
          },
        },
      },
    }),
    listCatalogSummary().catch(() => null),
    prisma.product.findMany({
      where: { active: true, featured: true },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        imageUrl: true,
        price: true,
        promoPrice: true,
      },
    }),
  ]);

  const enrichedAssignments = await enrichAssignments(assignmentRows);
  const priorityCustomers = enrichedAssignments
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 10);

  const topSoldProducts = summarizeSaleItems(saleItems30);
  const focusProducts = topSoldProducts.length
    ? topSoldProducts.map((p) => ({
        id: p.productId,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        quantity: p.quantity,
        total: p.total,
      }))
    : featuredProducts.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        price: p.price,
        promoPrice: p.promoPrice,
      }));

  const salesTotal30 = sales30.reduce((sum, s) => sum + (s.totalAmount || 0), 0);
  const salesCount14 = sales30.filter((s) => s.createdAt >= since14).length;

  const snapshot = {
    generatedAt: now.toISOString(),
    seller,
    stats: {
      totalCustomers: assignmentRows.length,
      customersDue: assignmentRows.filter((a) => a.nextActionDate && new Date(a.nextActionDate) <= now && a.relationshipStatus !== 'LOST').length,
      inactiveCustomers: assignmentRows.filter((a) => a.relationshipStatus === 'INACTIVE').length,
      rebuyOpportunities: assignmentRows.filter((a) => a.relationshipStatus === 'REBUY_OPPORTUNITY').length,
      tasksOpen: tasks.length,
      salesCount30: sales30.length,
      salesCount14,
      salesTotal30,
    },
    priorityCustomers,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      type: t.type,
      priority: t.priority,
      status: t.status,
      customerId: t.customerId,
      dueDate: formatDateTime(t.dueDate),
    })),
    recentInteractions: recentInteractions.map((i) => ({
      id: i.id,
      channel: i.channel,
      interactionType: i.interactionType,
      summary: i.summary,
      result: i.result,
      nextAction: i.nextAction,
      nextActionDate: formatDateTime(i.nextActionDate),
      createdAt: formatDateTime(i.createdAt),
    })),
    openInsights: openInsights.map((i) => ({
      id: i.id,
      type: i.type,
      title: i.title,
      description: i.description,
      priority: i.priority,
    })),
    weeklyInterview: weeklyInterview
      ? {
          id: weeklyInterview.id,
          status: weeklyInterview.status,
          moodScore: weeklyInterview.moodScore,
          confidenceScore: weeklyInterview.confidenceScore,
          salesEnergyScore: weeklyInterview.salesEnergyScore,
          mainObjective: weeklyInterview.mainObjective,
          summary: weeklyInterview.summary,
          weekStartDate: formatDateTime(weeklyInterview.weekStartDate),
        }
      : null,
    focusProducts,
    catalogSummary,
  };

  snapshot.plan = buildPlan(snapshot);
  return snapshot;
}

function compactSnapshotForPrompt(snapshot) {
  return {
    data: snapshot.generatedAt,
    vendedor: {
      nome: snapshot.seller.name,
      codigo: snapshot.seller.employeeCode,
      loja: snapshot.seller.store?.name || null,
      dna: snapshot.seller.store?.dna || null,
    },
    numeros: snapshot.stats,
    clientesPrioritarios: snapshot.priorityCustomers.slice(0, 8).map((c) => ({
      nome: c.customerName,
      status: c.relationshipStatus,
      prioridade: c.priority,
      proximaAcao: c.nextAction,
      data: c.nextActionDate,
      observacao: c.notes,
    })),
    tarefasAbertas: snapshot.tasks.slice(0, 8).map((t) => ({
      titulo: t.title,
      tipo: t.type,
      prioridade: t.priority,
      prazo: t.dueDate,
    })),
    sinaisDaLoja: snapshot.openInsights.slice(0, 5),
    produtosFoco: snapshot.focusProducts.slice(0, 5).map((p) => ({
      nome: p.name,
      marca: p.brand,
      categoria: p.category,
      qtdVendida30d: p.quantity,
    })),
    entrevista: snapshot.weeklyInterview,
    plano: snapshot.plan,
  };
}

function offlineCoachReply(message, snapshot) {
  const msg = message.toLowerCase();
  const first = snapshot.priorityCustomers[0];
  if (msg.includes('quem') || msg.includes('cliente') || msg.includes('cham')) {
    if (!first) return 'Hoje eu comecaria organizando sua carteira: selecione clientes com recompra, alto interesse ou atendimento recente sem retorno.';
    return `Eu comecaria por ${first.customerName}. Motivo: status ${first.relationshipStatus}, prioridade ${first.priority}. Proximo passo: ${first.nextAction || 'fazer contato curto, entender a necessidade e registrar o resultado.'}`;
  }
  if (msg.includes('tarefa') || msg.includes('plano')) {
    return `Seu plano tem ${snapshot.plan.recommendedTasks.length} tarefas sugeridas. Priorize clientes vencidos hoje, depois oportunidades de recompra e por ultimo registros pendentes.`;
  }
  return `${snapshot.plan.firstAction} Produto foco: ${snapshot.plan.focus}. Depois de cada atendimento, registre resumo e proxima acao para eu aprender com seu ritmo.`;
}

const TOOLS = [
  {
    name: 'search_products',
    description: 'Busca produtos ativos no catalogo Sports & Tennis. Use quando o vendedor pedir sugestao de produto, marca, categoria ou modelo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Texto de busca, ex.: tenis corrida, Adidas, chuteira, mochila.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_catalog',
    description: 'Lista marcas e categorias presentes no catalogo atual.',
    input_schema: { type: 'object', properties: {} },
  },
];

async function execTool(name, input) {
  if (name === 'search_products') return searchProductsForAI(input?.query);
  if (name === 'list_catalog') return listCatalogSummary();
  return { error: 'Tool desconhecida' };
}

function buildSystemPrompt(snapshot) {
  return `Voce e o Agente do Vendedor da Sports & Tennis dentro do TenisCash.

Missao: ajudar o vendedor logado a vender melhor hoje, organizar tarefas, priorizar clientes, preparar abordagem, lidar com objecoes e registrar proximos passos.

Regras:
- Responda em portugues brasileiro, direto e pratico.
- Use apenas os dados do contexto e das tools. Nao invente cliente, estoque, preco, desconto, meta ou produto.
- O vendedor continua no controle. Para criar tarefas, oriente a usar o botao "Criar tarefas" quando a sugestao ja existir no plano.
- Nao envie WhatsApp de verdade, nao aprove desconto e nao prometa condicao comercial sem confirmacao da loja.
- Se o vendedor pedir produto especifico, use search_products antes de recomendar.
- Diga no maximo 180 palavras. Nada de texto motivacional generico.

Contexto do vendedor:
${JSON.stringify(compactSnapshotForPrompt(snapshot), null, 2)}`;
}

router.get('/today', requireSeller, async (req, res) => {
  try {
    const snapshot = await loadSellerSnapshot(req);
    res.json({
      seller: snapshot.seller,
      stats: snapshot.stats,
      priorityCustomers: snapshot.priorityCustomers,
      tasks: snapshot.tasks,
      recentInteractions: snapshot.recentInteractions,
      openInsights: snapshot.openInsights,
      weeklyInterview: snapshot.weeklyInterview,
      focusProducts: snapshot.focusProducts,
      plan: snapshot.plan,
    });
  } catch (err) {
    console.error('[seller/agent/today] erro:', err);
    res.status(err.statusCode || 500).json({ error: err.message || 'Erro ao carregar agente' });
  }
});

router.post('/tasks/apply', requireSeller, async (req, res) => {
  try {
    const sellerId = resolveSellerId(req);
    if (req.userRole === 'seller' && sellerId !== req.userId) {
      return res.status(403).json({ error: 'Voce so pode criar tarefas para voce' });
    }

    const rawTasks = Array.isArray(req.body?.tasks) ? req.body.tasks.slice(0, 10) : [];
    if (!rawTasks.length) return res.status(400).json({ error: 'Nenhuma tarefa enviada' });

    const seller = await prisma.user.findUnique({
      where: { id: sellerId },
      select: { id: true, storeId: true },
    });
    if (!seller) return res.status(404).json({ error: 'Vendedor nao encontrado' });

    const created = [];
    const skipped = [];

    for (const raw of rawTasks) {
      const title = safeText(raw.title, 120);
      const type = safeText(raw.type, 40);
      if (!title || !ALLOWED_TASK_TYPES.has(type)) {
        skipped.push({ title: title || '(sem titulo)', reason: 'tipo invalido' });
        continue;
      }
      const customerId = raw.customerId ? String(raw.customerId) : null;
      const duplicate = await prisma.sellerTask.findFirst({
        where: {
          sellerId,
          customerId,
          title,
          status: { in: ACTIVE_TASK_STATUS },
          createdAt: { gte: startOfDay() },
        },
        select: { id: true },
      });
      if (duplicate) {
        skipped.push({ title, reason: 'ja existe hoje' });
        continue;
      }
      const task = await prisma.sellerTask.create({
        data: {
          sellerId,
          customerId,
          storeId: raw.storeId || seller.storeId || null,
          title,
          description: safeText(raw.description, 500) || null,
          type,
          priority: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(raw.priority) ? raw.priority : 'MEDIUM',
          dueDate: raw.dueDate ? new Date(raw.dueDate) : null,
          status: 'TODO',
        },
      });
      created.push(task);
    }

    res.json({ created, skipped });
  } catch (err) {
    console.error('[seller/agent/tasks/apply] erro:', err);
    res.status(500).json({ error: 'Erro ao criar tarefas', detail: err.message });
  }
});

router.post('/chat', requireSeller, chatLimiter, async (req, res) => {
  try {
    const text = safeText(req.body?.message, 1200);
    if (!text) return res.status(400).json({ error: 'Mensagem obrigatoria' });

    const snapshot = await loadSellerSnapshot(req);
    const client = anthropicClient();
    if (!client) {
      return res.json({
        conversationId: null,
        reply: offlineCoachReply(text, snapshot),
        suggestions: ['Quem eu chamo primeiro?', 'Crie um plano curto', 'Como responder objecao de preco?'],
        offline: true,
      });
    }

    let conv = null;
    const conversationId = String(req.body?.conversationId || '').trim();
    if (conversationId) {
      conv = await prisma.aIConversation.findFirst({
        where: { id: conversationId, userId: req.userId, active: true },
      });
      if (!conv) return res.status(404).json({ error: 'Conversa nao encontrada' });
    } else {
      conv = await prisma.aIConversation.create({
        data: {
          userId: req.userId,
          userType: 'seller-agent',
          title: `Agente vendedor: ${text.slice(0, 55)}`,
        },
      });
    }

    let msgs = parseMessages(conv.messages);
    msgs.push({ role: 'user', content: text, timestamp: new Date().toISOString() });
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: { messages: msgs, updatedAt: new Date() },
    });

    const anthropicMessages = msgs
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-18)
      .map((m) => ({ role: m.role, content: m.content }));

    const model = process.env.SELLER_AGENT_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
    const maxTokens = parseInt(process.env.SELLER_AGENT_MAX_TOKENS || '700', 10);
    const system = buildSystemPrompt(snapshot);

    let currentMessages = anthropicMessages.map((m) => ({ ...m }));
    let finalText = '';
    let totalIn = 0;
    let totalOut = 0;
    let turn = 0;

    while (turn < 6) {
      turn += 1;
      const resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        tools: TOOLS,
        messages: currentMessages,
      });

      totalIn += resp.usage?.input_tokens || 0;
      totalOut += resp.usage?.output_tokens || 0;

      if (resp.stop_reason === 'tool_use') {
        currentMessages.push({ role: 'assistant', content: resp.content });
        const toolResults = [];
        for (const block of resp.content || []) {
          if (block.type !== 'tool_use') continue;
          const out = await execTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(out),
          });
        }
        currentMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      finalText = (resp.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    if (!finalText) finalText = offlineCoachReply(text, snapshot);

    const fresh = await prisma.aIConversation.findUnique({
      where: { id: conv.id },
      select: { messages: true },
    });
    msgs = parseMessages(fresh.messages);
    msgs.push({ role: 'assistant', content: finalText, timestamp: new Date().toISOString() });

    const cost = buildCostBRL({ input_tokens: totalIn, output_tokens: totalOut });
    await prisma.aIConversation.update({
      where: { id: conv.id },
      data: {
        messages: msgs,
        totalTokensIn: { increment: totalIn },
        totalTokensOut: { increment: totalOut },
        totalCostBRL: { increment: cost.brl },
        updatedAt: new Date(),
      },
    });

    res.json({
      conversationId: conv.id,
      reply: finalText,
      suggestions: ['Quem eu chamo primeiro?', 'Monte minha abordagem', 'Qual tarefa faco agora?'],
    });
  } catch (err) {
    console.error('[seller/agent/chat] erro:', err);
    res.status(500).json({ error: 'Erro ao conversar com o agente. Tente novamente.' });
  }
});

module.exports = router;
