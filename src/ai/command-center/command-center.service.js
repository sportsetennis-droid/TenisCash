// =====================================================================
// Command Center Service — Centro de Comando da Operação IA
// =====================================================================
// Camada de GOVERNANÇA sobre os agentes (as peças que faltavam):
//   - FinOps        → custo de IA por agente + teto (cap) + alerta
//   - Medição       → o que a IA realmente fez (atividade)
//   - Scorecard     → confiabilidade/custo por agente
//   - Aprovações    → funil + taxa de aprovação + tempo de decisão
//   - Briefing COO  → resumo diário + alertas acionáveis
//
// Tudo lido de dados REAIS já gravados (AILog, AIOrchestration,
// AIOrchestrationTask, AIApproval). NENHUMA tabela nova é criada.
// O único estado próprio é o "cap" (teto), salvo em cap.json.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { prisma } = require('../../middleware');

// America/Fortaleza = UTC-3 fixo (sem horário de verão) — regra do projeto.
const TZ_OFFSET_MS = 3 * 60 * 60 * 1000;

// Nome amigável por código de agente (sem importar o registry — desacoplado de propósito).
const AGENT_NAMES = {
  'orchestrator-agent': 'Orquestrador (consolidação)',
  'stock-agent': 'Estoque',
  'finance-agent': 'Financeiro',
  'marketing-agent': 'Marketing',
  'sales-agent': 'Vendas',
  'whatsapp-agent': 'WhatsApp',
  'report-agent': 'Relatórios',
  'operations-agent': 'Operações',
  'partner-agent': 'Parceiros',
  'product-agent': 'Produto',
  'design-brief-agent': 'Briefing Visual',
  'life-assessor-agent': 'Assessor (Clareza)',
  'safety-agent': 'Segurança',
};
function agentName(code) {
  return AGENT_NAMES[code] || code || 'desconhecido';
}

// ---------------------------------------------------------------------
// Janelas de tempo
// ---------------------------------------------------------------------
function startOfDayFortaleza(d = new Date()) {
  const loc = new Date(d.getTime() - TZ_OFFSET_MS);
  // 00:00 em Fortaleza == 03:00 UTC do mesmo dia
  return new Date(Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), loc.getUTCDate(), 3, 0, 0, 0));
}
function startOfMonthFortaleza(d = new Date()) {
  const loc = new Date(d.getTime() - TZ_OFFSET_MS);
  return new Date(Date.UTC(loc.getUTCFullYear(), loc.getUTCMonth(), 1, 3, 0, 0, 0));
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000);
}
function round2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

// ---------------------------------------------------------------------
// Teto de custo (cap) — persistido em cap.json, com fallback em env.
// Obs: filesystem da Railway é efêmero; pra teto permanente, setar
// AI_CAP_MONTHLY_BRL / AI_CAP_DAILY_BRL como env var.
// ---------------------------------------------------------------------
const CAP_FILE = path.join(__dirname, 'cap.json');

function getCostCap() {
  const envMonthly = parseFloat(process.env.AI_CAP_MONTHLY_BRL || '300');
  const envDaily = parseFloat(process.env.AI_CAP_DAILY_BRL || '30');
  let monthlyBRL = isFinite(envMonthly) ? envMonthly : 300;
  let dailyBRL = isFinite(envDaily) ? envDaily : 30;
  let source = 'env';
  try {
    if (fs.existsSync(CAP_FILE)) {
      const j = JSON.parse(fs.readFileSync(CAP_FILE, 'utf8'));
      if (typeof j.monthlyBRL === 'number') { monthlyBRL = j.monthlyBRL; source = 'file'; }
      if (typeof j.dailyBRL === 'number') { dailyBRL = j.dailyBRL; source = 'file'; }
    }
  } catch (_) { /* mantém env */ }
  return { monthlyBRL, dailyBRL, source };
}

function setCostCap({ monthlyBRL, dailyBRL } = {}) {
  const cur = getCostCap();
  const next = {
    monthlyBRL: typeof monthlyBRL === 'number' && monthlyBRL >= 0 ? monthlyBRL : cur.monthlyBRL,
    dailyBRL: typeof dailyBRL === 'number' && dailyBRL >= 0 ? dailyBRL : cur.dailyBRL,
  };
  fs.writeFileSync(CAP_FILE, JSON.stringify(next, null, 2));
  return { ...next, source: 'file' };
}

// ---------------------------------------------------------------------
// 1) Custo / FinOps
// ---------------------------------------------------------------------
async function getCost({ days = 30 } = {}) {
  const since = daysAgo(days);
  const [agg, byAgentRaw, monthAgg, todayAgg] = await Promise.all([
    prisma.aILog.aggregate({ where: { createdAt: { gte: since } }, _sum: { cost: true, tokens: true }, _count: true }),
    prisma.aILog.groupBy({ by: ['agentCode'], where: { createdAt: { gte: since } }, _sum: { cost: true, tokens: true }, _count: { _all: true } }),
    prisma.aILog.aggregate({ where: { createdAt: { gte: startOfMonthFortaleza() } }, _sum: { cost: true } }),
    prisma.aILog.aggregate({ where: { createdAt: { gte: startOfDayFortaleza() } }, _sum: { cost: true } }),
  ]);
  const cap = getCostCap();
  const byAgent = byAgentRaw
    .map((r) => ({
      agentCode: r.agentCode,
      name: agentName(r.agentCode),
      costBRL: round2(r._sum.cost || 0),
      tokens: r._sum.tokens || 0,
      calls: r._count._all || 0,
    }))
    .sort((a, b) => b.costBRL - a.costBRL);
  const monthBRL = round2(monthAgg._sum.cost || 0);
  const todayBRL = round2(todayAgg._sum.cost || 0);
  return {
    days,
    totalCostBRL: round2(agg._sum.cost || 0),
    totalTokens: agg._sum.tokens || 0,
    totalCalls: agg._count || 0,
    byAgent,
    monthToDateBRL: monthBRL,
    todayBRL,
    cap,
    monthPct: cap.monthlyBRL > 0 ? Math.round((monthBRL / cap.monthlyBRL) * 100) : 0,
    dayPct: cap.dailyBRL > 0 ? Math.round((todayBRL / cap.dailyBRL) * 100) : 0,
    monthOverCap: monthBRL > cap.monthlyBRL,
    dayOverCap: todayBRL > cap.dailyBRL,
  };
}

// ---------------------------------------------------------------------
// 2) Atividade / Medição
// ---------------------------------------------------------------------
async function getActivity({ days = 30 } = {}) {
  const since = daysAgo(days);
  const [orchTotal, orchByStatus, taskByStatus, apprByStatus, logTotal, logByAction] = await Promise.all([
    prisma.aIOrchestration.count({ where: { createdAt: { gte: since } } }),
    prisma.aIOrchestration.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aIOrchestrationTask.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aIApproval.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aILog.count({ where: { createdAt: { gte: since } } }),
    prisma.aILog.groupBy({ by: ['action'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const toMap = (rows, key = 'status') => rows.reduce((m, r) => { m[r[key]] = r._count._all; return m; }, {});
  return {
    days,
    orchestrations: { total: orchTotal, byStatus: toMap(orchByStatus) },
    tasks: { byStatus: toMap(taskByStatus) },
    approvals: { byStatus: toMap(apprByStatus) },
    logs: { total: logTotal, byAction: toMap(logByAction, 'action') },
  };
}

// ---------------------------------------------------------------------
// 3) Scorecard por agente (confiabilidade + custo)
// ---------------------------------------------------------------------
async function getScorecard({ days = 30 } = {}) {
  const since = daysAgo(days);
  const [logsByAgent, errLogsByAgent, tasksByAgentStatus] = await Promise.all([
    prisma.aILog.groupBy({ by: ['agentCode'], where: { createdAt: { gte: since } }, _sum: { cost: true, tokens: true }, _count: { _all: true } }),
    prisma.aILog.groupBy({ by: ['agentCode'], where: { createdAt: { gte: since }, error: { not: null } }, _count: { _all: true } }),
    prisma.aIOrchestrationTask.groupBy({ by: ['agentCode', 'status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
  ]);
  const errMap = errLogsByAgent.reduce((m, r) => { m[r.agentCode] = r._count._all; return m; }, {});
  const taskAgg = {};
  for (const r of tasksByAgentStatus) {
    const a = taskAgg[r.agentCode] = taskAgg[r.agentCode] || { completed: 0, failed: 0, total: 0 };
    a.total += r._count._all;
    if (r.status === 'completed') a.completed += r._count._all;
    if (r.status === 'failed') a.failed += r._count._all;
  }
  const codes = new Set([...logsByAgent.map((r) => r.agentCode), ...Object.keys(taskAgg)]);
  const agents = [...codes].map((code) => {
    const lg = logsByAgent.find((r) => r.agentCode === code) || { _sum: { cost: 0, tokens: 0 }, _count: { _all: 0 } };
    const calls = lg._count._all || 0;
    const errors = errMap[code] || 0;
    const t = taskAgg[code] || { completed: 0, failed: 0, total: 0 };
    return {
      agentCode: code,
      name: agentName(code),
      calls,
      costBRL: round2(lg._sum.cost || 0),
      tokens: lg._sum.tokens || 0,
      errors,
      errorRate: calls ? Math.round((errors / calls) * 100) : 0,
      taskCompleted: t.completed,
      taskFailed: t.failed,
      taskFailRate: t.total ? Math.round((t.failed / t.total) * 100) : 0,
    };
  }).sort((a, b) => b.calls - a.calls);
  return { days, agents };
}

// ---------------------------------------------------------------------
// 4) Funil de aprovações
// ---------------------------------------------------------------------
async function getApprovals({ days = 30 } = {}) {
  const since = daysAgo(days);
  const [byStatus, decided, oldestPending] = await Promise.all([
    prisma.aIApproval.groupBy({ by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.aIApproval.findMany({ where: { createdAt: { gte: since }, decidedAt: { not: null } }, select: { createdAt: true, decidedAt: true }, take: 1000 }),
    prisma.aIApproval.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const m = byStatus.reduce((acc, r) => { acc[r.status] = r._count._all; return acc; }, {});
  const total = Object.values(m).reduce((a, b) => a + b, 0);
  const approved = (m.approved || 0) + (m.executed || 0);
  const rejected = (m.rejected || 0);
  const decidedCount = approved + rejected + (m.correction_requested || 0);
  let avgDecisionHours = null;
  if (decided.length) {
    const sum = decided.reduce((a, x) => a + (new Date(x.decidedAt) - new Date(x.createdAt)), 0);
    avgDecisionHours = round2((sum / decided.length) / 3600000);
  }
  const oldestPendingHours = oldestPending ? round2((Date.now() - new Date(oldestPending.createdAt)) / 3600000) : null;
  return {
    days,
    total,
    byStatus: m,
    pending: m.pending || 0,
    approved,
    rejected,
    executed: m.executed || 0,
    correctionRequested: m.correction_requested || 0,
    approvalRate: decidedCount ? Math.round((approved / decidedCount) * 100) : null,
    avgDecisionHours,
    oldestPendingHours,
  };
}

// ---------------------------------------------------------------------
// 5) Briefing diário (a voz do COO) — resumo + alertas acionáveis
// ---------------------------------------------------------------------
async function getDailyBriefing() {
  const dayStart = startOfDayFortaleza();
  const [orchToday, orchList, pendingCount, oldestPending, pendingList, costToday, costMonth, tasksFailedToday, lastOrch] = await Promise.all([
    prisma.aIOrchestration.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.aIOrchestration.findMany({ where: { createdAt: { gte: dayStart } }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, objective: true, status: true, createdAt: true } }),
    prisma.aIApproval.count({ where: { status: 'pending' } }),
    prisma.aIApproval.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    prisma.aIApproval.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, type: true, title: true, riskLevel: true, createdAt: true } }),
    prisma.aILog.aggregate({ where: { createdAt: { gte: dayStart } }, _sum: { cost: true } }),
    prisma.aILog.aggregate({ where: { createdAt: { gte: startOfMonthFortaleza() } }, _sum: { cost: true } }),
    prisma.aIOrchestrationTask.count({ where: { createdAt: { gte: dayStart }, status: 'failed' } }),
    prisma.aIOrchestration.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
  ]);
  const cap = getCostCap();
  const todayBRL = round2(costToday._sum.cost || 0);
  const monthBRL = round2(costMonth._sum.cost || 0);
  const oldestPendingHours = oldestPending ? round2((Date.now() - new Date(oldestPending.createdAt)) / 3600000) : null;
  const daysSinceLastOrch = lastOrch ? Math.floor((Date.now() - new Date(lastOrch.createdAt)) / 86400000) : null;

  const alerts = [];
  if (todayBRL > cap.dailyBRL) alerts.push({ level: 'high', msg: `Custo de IA hoje R$ ${todayBRL.toFixed(2)} passou o teto diário (R$ ${cap.dailyBRL.toFixed(2)}).` });
  if (monthBRL > cap.monthlyBRL) alerts.push({ level: 'high', msg: `Custo do mês R$ ${monthBRL.toFixed(2)} passou o teto mensal (R$ ${cap.monthlyBRL.toFixed(2)}).` });
  if (pendingCount > 0) alerts.push({ level: oldestPendingHours && oldestPendingHours > 24 ? 'high' : 'medium', msg: `${pendingCount} aprovação(ões) esperando sua decisão${oldestPendingHours != null ? ` (mais antiga há ${oldestPendingHours.toFixed(1)}h)` : ''}.` });
  if (tasksFailedToday > 0) alerts.push({ level: 'medium', msg: `${tasksFailedToday} tarefa(s) de agente falharam hoje.` });
  if (daysSinceLastOrch != null && daysSinceLastOrch >= 7) alerts.push({ level: 'medium', msg: `Operação ociosa: nenhum orquestrador rodado há ${daysSinceLastOrch} dias — os agentes estão parados.` });
  if (daysSinceLastOrch == null) alerts.push({ level: 'medium', msg: 'A Central IA nunca foi acionada. Rode o primeiro objetivo na aba "Rodar Orquestrador".' });

  const status = alerts.some((a) => a.level === 'high') ? 'attention' : (alerts.length ? 'watch' : 'ok');
  const summaryText = [
    `Hoje: ${orchToday} orquestração(ões) · custo R$ ${todayBRL.toFixed(2)} de R$ ${cap.dailyBRL.toFixed(2)} (teto diário).`,
    `Mês até agora: R$ ${monthBRL.toFixed(2)} de R$ ${cap.monthlyBRL.toFixed(2)} (teto mensal).`,
    `Aprovações esperando você: ${pendingCount}.`,
    alerts.length ? `Pontos de atenção: ${alerts.length}.` : 'Sem alertas — operação no controle.',
  ].join(' ');

  return {
    generatedAt: new Date().toISOString(),
    status,
    today: { orchestrations: orchToday, costBRL: todayBRL, capDailyBRL: cap.dailyBRL, tasksFailed: tasksFailedToday, recent: orchList },
    month: { costBRL: monthBRL, capMonthlyBRL: cap.monthlyBRL },
    pending: { count: pendingCount, oldestHours: oldestPendingHours, list: pendingList },
    idleDays: daysSinceLastOrch,
    alerts,
    summaryText,
  };
}

module.exports = {
  getCostCap,
  setCostCap,
  getCost,
  getActivity,
  getScorecard,
  getApprovals,
  getDailyBriefing,
  // expostos pra teste/uso interno
  agentName,
  startOfDayFortaleza,
  startOfMonthFortaleza,
};
