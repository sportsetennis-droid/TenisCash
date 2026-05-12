// =====================================================================
// Recommendation Engine — gera AiRecommendation por REGRAS (sem IA)
// =====================================================================
// Roda sob demanda (POST /api/admin/recommendations/run) ou em cron.
// Cada regra:
//   - varre dados existentes
//   - cria AiRecommendation se condição atende
//   - evita duplicar: chave (type + relatedX) marcada como aberta nas últimas 24h

const { prisma } = require('../middleware');

async function alreadyHas({ type, relatedProductId, relatedCustomerId, relatedSellerId, relatedStoreId }) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const existing = await prisma.aiRecommendation.findFirst({
    where: {
      type,
      status: { in: ['OPEN', 'IN_REVIEW'] },
      createdAt: { gte: since },
      ...(relatedProductId ? { relatedProductId } : {}),
      ...(relatedCustomerId ? { relatedCustomerId } : {}),
      ...(relatedSellerId ? { relatedSellerId } : {}),
      ...(relatedStoreId ? { relatedStoreId } : {}),
    },
  });
  return !!existing;
}

async function createRec(rec) {
  if (await alreadyHas(rec)) return null;
  return prisma.aiRecommendation.create({ data: rec });
}

// REGRA 1: Produtos antigos sem venda há mais de 60 dias → INVENTORY_RISK
async function ruleOldStock() {
  const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const products = await prisma.product.findMany({
    where: { active: true, createdAt: { lt: cutoff } },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });
  let created = 0;
  for (const p of products) {
    const rec = await createRec({
      type: 'INVENTORY_RISK',
      title: `Produto antigo sem promoção: ${p.name}`,
      description: `SKU ${p.sku} — mais de 60 dias ativo sem promoPrice. Considere expor ou promover.`,
      priority: 'MEDIUM',
      relatedProductId: p.id,
      status: 'OPEN',
    });
    if (rec) created++;
  }
  return created;
}

// REGRA 2: Produtos com estoque baixo (soma de sizes.stock <= 5) → INVENTORY_RISK
async function ruleLowStock() {
  const products = await prisma.product.findMany({
    where: { active: true },
    include: { sizes: true },
    take: 200,
  });
  let created = 0;
  for (const p of products) {
    const total = (p.sizes || []).reduce((s, x) => s + (x.stock || 0), 0);
    if (total > 0 && total <= 5) {
      const rec = await createRec({
        type: 'REBUY',
        title: `Estoque baixo: ${p.name}`,
        description: `Apenas ${total} unidades restantes. Avalie recompra.`,
        priority: 'MEDIUM',
        relatedProductId: p.id,
        status: 'OPEN',
      });
      if (rec) created++;
    }
  }
  return created;
}

// REGRA 3: Clientes com saldo TenisCash > 0 sem login há 60d → CUSTOMER_REACTIVATION
async function ruleInactiveCustomersWithBalance() {
  const cutoff = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const customers = await prisma.user.findMany({
    where: {
      role: 'user',
      active: true,
      balance: { gt: 0 },
      updatedAt: { lt: cutoff },
    },
    take: 30,
    orderBy: { balance: 'desc' },
  });
  let created = 0;
  for (const c of customers) {
    const rec = await createRec({
      type: 'CUSTOMER_REACTIVATION',
      title: `Reativar: ${c.name} (T$ ${c.balance.toFixed(2)})`,
      description: `Cliente sem atividade há 60+ dias, mas tem saldo. Ligar/WhatsApp.`,
      priority: 'HIGH',
      relatedCustomerId: c.id,
      status: 'OPEN',
    });
    if (rec) created++;
  }
  return created;
}

// REGRA 4: Contas a pagar vencendo nos próximos 7 dias → FINANCE_ALERT
async function ruleAccountsPayableDueSoon() {
  const in7 = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const accounts = await prisma.accountPayable.findMany({
    where: { status: 'PENDING', dueDate: { lte: in7, gte: new Date() } },
    take: 50,
    orderBy: { dueDate: 'asc' },
  });
  let created = 0;
  for (const a of accounts) {
    const rec = await createRec({
      type: 'FINANCE_ALERT',
      title: `Conta vence em breve: ${a.description}`,
      description: `R$ ${a.amount.toFixed(2)} vence em ${a.dueDate.toLocaleDateString('pt-BR')}.`,
      priority: 'HIGH',
      status: 'OPEN',
    });
    if (rec) created++;
  }
  return created;
}

// REGRA 5: Conta a pagar VENCIDA → FINANCE_ALERT URGENT
async function ruleAccountsPayableOverdue() {
  const accounts = await prisma.accountPayable.findMany({
    where: { status: 'PENDING', dueDate: { lt: new Date() } },
    take: 50,
    orderBy: { dueDate: 'asc' },
  });
  let created = 0;
  for (const a of accounts) {
    // Atualiza status pra OVERDUE no banco
    await prisma.accountPayable.update({ where: { id: a.id }, data: { status: 'OVERDUE' } });
    const rec = await createRec({
      type: 'FINANCE_ALERT',
      title: `CONTA ATRASADA: ${a.description}`,
      description: `R$ ${a.amount.toFixed(2)} venceu em ${a.dueDate.toLocaleDateString('pt-BR')}.`,
      priority: 'URGENT',
      status: 'OPEN',
    });
    if (rec) created++;
  }
  return created;
}

// REGRA 6: Curadoria sem checklist concluído próximo do startDate → CURATION_SUGGESTION
async function ruleCurationChecklistAlert() {
  const upcoming = await prisma.storeCuration.findMany({
    where: {
      status: { in: ['DRAFT', 'SETUP'] },
      startDate: { gte: new Date(), lte: new Date(Date.now() + 3 * 24 * 3600 * 1000) },
    },
    include: { checklist: true },
    take: 20,
  });
  let created = 0;
  for (const c of upcoming) {
    const pending = (c.checklist || []).filter((x) => x.status !== 'DONE').length;
    if (pending > 0) {
      const rec = await createRec({
        type: 'CURATION_SUGGESTION',
        title: `Curadoria "${c.name}" inicia em breve`,
        description: `${pending} tarefa(s) do checklist ainda pendente(s).`,
        priority: 'MEDIUM',
        relatedStoreId: c.storeId,
        status: 'OPEN',
      });
      if (rec) created++;
    }
  }
  return created;
}

// REGRA 7: Insights de entrevista que viraram tarefas de venda → SELLER_TASK
async function ruleInterviewInsights() {
  const insights = await prisma.sellerInsight.findMany({
    where: { status: 'OPEN', priority: { in: ['HIGH', 'URGENT'] } },
    take: 30,
    orderBy: { createdAt: 'desc' },
  });
  let created = 0;
  for (const i of insights) {
    const rec = await createRec({
      type: 'SELLER_TASK',
      title: `Ação do insight: ${i.title}`,
      description: i.description || '',
      priority: i.priority,
      relatedSellerId: i.sellerId,
      relatedStoreId: i.storeId,
      status: 'OPEN',
    });
    if (rec) created++;
  }
  return created;
}

async function runAllRules() {
  const results = {
    oldStock: await ruleOldStock(),
    lowStock: await ruleLowStock(),
    inactiveCustomers: await ruleInactiveCustomersWithBalance(),
    accountsDueSoon: await ruleAccountsPayableDueSoon(),
    accountsOverdue: await ruleAccountsPayableOverdue(),
    curationAlerts: await ruleCurationChecklistAlert(),
    interviewInsights: await ruleInterviewInsights(),
  };
  const total = Object.values(results).reduce((s, x) => s + x, 0);
  return { total, byRule: results };
}

module.exports = { runAllRules };
