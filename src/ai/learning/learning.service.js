// =====================================================================
// Learning Service — transforma execucoes em memoria reaproveitavel.
// =====================================================================
// Camadas:
//   1. evento: tudo que a rodada ensinou fica na linha do tempo;
//   2. candidato: regra potencial vira approval type=memory_promotion;
//   3. fato: somente apos aprovacao humana vira memoria fixada.
// =====================================================================

const { prisma } = require('../../middleware');
const memory = require('../memory/memory.service');
const { createApproval } = require('../approvals/approval.service');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function agentVariant(orchestration) {
  return orchestration?.input?.metadata?.agentVariant
    || orchestration?.context?.extraContext?.operatingMode?.agentVariant
    || 'classic';
}

function marketSnapshot(orchestration) {
  return orchestration?.context?.extraContext?.marketSnapshot || null;
}

function collectCandidateLearnings(orchestration) {
  const result = orchestration?.result || {};
  const snapshot = marketSnapshot(orchestration);
  const tasks = asArray(orchestration?.tasks);
  const approvals = asArray(orchestration?.approvals);
  const ready = result.readyMaterials || {};
  const candidates = [];

  if (snapshot?.sales?.total && Number(snapshot.sales.total.count || 0) === 0) {
    candidates.push({
      title: 'Validar integracao antes de tratar vendas zeradas como demanda zero',
      detail: 'Quando o snapshot de vendas vier zerado, a IA deve primeiro levantar a hipotese de falha/incompletude de integracao PDV/Nuvemshop antes de concluir que nao houve demanda.',
      category: 'regra',
      importance: 3,
      confidence: 0.86,
      promote: true,
      evidence: { salesWindowDays: snapshot.sales.days, salesCount: snapshot.sales.total.count },
    });
  }

  if (agentVariant(orchestration) === 'market' && ready['market-intelligence-agent']?.marketRead) {
    candidates.push({
      title: 'Inteligencia de mercado melhora plano quando ha excesso de estoque sem giro',
      detail: compactText(ready['market-intelligence-agent'].marketRead, 900),
      category: 'aprendizado',
      importance: 2,
      confidence: 0.72,
      promote: false,
      evidence: {
        dailyBets: asArray(ready['market-intelligence-agent'].dailyBets).length,
        competitorWatch: asArray(ready['market-intelligence-agent'].competitorWatch).length,
      },
    });
  }

  if (approvals.length > 12) {
    candidates.push({
      title: 'Planos com muitas aprovacoes precisam ser agrupados antes da operacao',
      detail: `Esta rodada criou ${approvals.length} aprovacoes. Antes de executar, a IA deve tentar agrupar aprovacoes por campanha/canal para reduzir friccao operacional.`,
      category: 'regra',
      importance: 2,
      confidence: 0.78,
      promote: true,
      evidence: { approvalCount: approvals.length },
    });
  }

  const failedTasks = tasks.filter((t) => t.status === 'failed');
  if (failedTasks.length) {
    candidates.push({
      title: 'Quando agente falhar, manter plano em modo degradado e apontar revisao humana',
      detail: `Falharam: ${failedTasks.map((t) => t.agentCode).join(', ')}.`,
      category: 'regra',
      importance: 2,
      confidence: 0.8,
      promote: true,
      evidence: { failedAgents: failedTasks.map((t) => t.agentCode) },
    });
  }

  if (result.nextRecommendedAction) {
    candidates.push({
      title: 'Proxima acao operacional gerada pela IA',
      detail: compactText(result.nextRecommendedAction, 900),
      category: 'aprendizado',
      importance: 1,
      confidence: 0.6,
      promote: false,
      evidence: { orchestrationId: orchestration.id },
    });
  }

  return candidates;
}

async function createPromotionApproval(orchestration, candidate) {
  if (!candidate.promote) return null;
  const title = `Promover aprendizado: ${candidate.title}`;
  const exists = await prisma.aIApproval.findFirst({
    where: {
      orchestrationId: orchestration.id,
      type: 'memory_promotion',
      title,
    },
    select: { id: true },
  });
  if (exists) return null;
  return createApproval({
    orchestrationId: orchestration.id,
    type: 'memory_promotion',
    title,
    description: candidate.detail,
    riskLevel: candidate.importance >= 3 ? 'medium' : 'low',
    payload: {
      memory: {
        kind: 'fact',
        category: candidate.category || 'aprendizado',
        title: candidate.title,
        detail: candidate.detail,
        data: {
          confidence: candidate.confidence,
          evidence: candidate.evidence || {},
          sourceOrchestrationId: orchestration.id,
          sourceVariant: agentVariant(orchestration),
        },
        importance: candidate.importance || 2,
        pinned: true,
      },
    },
  });
}

async function recordOrchestrationLearning(orchestrationId) {
  if (!orchestrationId) return null;
  const orchestration = await prisma.aIOrchestration.findUnique({
    where: { id: orchestrationId },
    include: {
      tasks: { orderBy: { createdAt: 'asc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!orchestration || orchestration.status !== 'completed') return null;

  const already = await prisma.companyMemory.findFirst({
    where: {
      source: 'learning-engine',
      refType: 'AIOrchestration',
      refId: orchestration.id,
      category: 'aprendizado',
    },
    select: { id: true },
  });
  if (already) return { skipped: true, memoryId: already.id };

  const candidates = collectCandidateLearnings(orchestration);
  const tasks = asArray(orchestration.tasks);
  const approvals = asArray(orchestration.approvals);
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const failed = tasks.filter((t) => t.status === 'failed').length;
  const variant = agentVariant(orchestration);
  const result = orchestration.result || {};

  const event = await memory.recordEvent({
    kind: 'event',
    category: 'aprendizado',
    title: `Aprendizado da rodada ${variant}: ${orchestration.id}`,
    detail: compactText(result.nextRecommendedAction || result.consolidatedPlan || 'Rodada concluida sem proxima acao explicita.', 1400),
    data: {
      orchestrationId: orchestration.id,
      agentVariant: variant,
      tasks: { total: tasks.length, completed, failed },
      approvals: { total: approvals.length, byStatus: approvals.reduce((m, a) => { m[a.status] = (m[a.status] || 0) + 1; return m; }, {}) },
      safety: result.safetyReview || null,
      candidates,
    },
    source: 'learning-engine',
    refType: 'AIOrchestration',
    refId: orchestration.id,
    importance: candidates.some((c) => c.importance >= 3) ? 3 : 2,
  });

  const promotionApprovals = [];
  for (const candidate of candidates) {
    const approval = await createPromotionApproval(orchestration, candidate).catch(() => null);
    if (approval) promotionApprovals.push(approval);
  }

  return {
    memoryId: event?.id || null,
    candidates: candidates.length,
    promotionApprovals: promotionApprovals.length,
  };
}

async function promoteLearningFromApproval(approval, approvedById = null) {
  if (!approval || approval.type !== 'memory_promotion' || approval.status !== 'approved') return null;
  const mem = approval.payload?.memory || null;
  if (!mem || !mem.title) return null;

  const existing = await prisma.companyMemory.findFirst({
    where: {
      kind: 'fact',
      source: 'learning-engine',
      refType: 'AIApproval',
      refId: approval.id,
    },
    select: { id: true },
  });
  if (existing) return existing;

  return memory.addFact({
    category: mem.category || 'aprendizado',
    title: mem.title,
    detail: mem.detail || null,
    data: mem.data || null,
    source: 'learning-engine',
    refType: 'AIApproval',
    refId: approval.id,
    importance: mem.importance != null ? mem.importance : 2,
    pinned: mem.pinned != null ? !!mem.pinned : true,
    createdById: approvedById,
  });
}

module.exports = {
  collectCandidateLearnings,
  recordOrchestrationLearning,
  promoteLearningFromApproval,
};
