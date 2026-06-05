const { prisma } = require('../../middleware');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countWords(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function material(orchestration, key) {
  const result = orchestration?.result || {};
  if (result?.readyMaterials && result.readyMaterials[key]) return result.readyMaterials[key];
  const task = asArray(orchestration?.tasks).find((t) => t.agentCode === key && t.output);
  return task?.output || {};
}

function scoreOrchestration(orchestration) {
  const result = orchestration?.result || {};
  const tasks = asArray(orchestration?.tasks);
  const approvals = asArray(orchestration?.approvals);
  const completedTasks = tasks.filter((t) => t.status === 'completed').length;
  const failedTasks = tasks.filter((t) => t.status === 'failed').length;
  const taskScore = tasks.length ? Math.round((completedTasks / tasks.length) * 20) : 0;

  const stock = material(orchestration, 'stock-agent');
  const marketing = material(orchestration, 'marketing-agent');
  const sales = material(orchestration, 'sales-agent');
  const operations = material(orchestration, 'operations-agent');
  const whatsapp = material(orchestration, 'whatsapp-agent');
  const market = material(orchestration, 'market-intelligence-agent');

  const actionabilitySignals = [
    countWords(result.consolidatedPlan) >= 80,
    countWords(result.nextRecommendedAction) >= 18,
    asArray(stock.recommendedProducts).length >= 3,
    !!marketing.instagramCaption || !!marketing.mainConcept,
    !!sales.salesScript,
    asArray(operations.executionTimeline).length >= 3 || asArray(operations.checklist).length >= 4,
    !!whatsapp.campaignMessage,
  ].filter(Boolean).length;
  const actionabilityScore = Math.round((actionabilitySignals / 7) * 25);

  const safety = result.safetyReview || {};
  const highRiskPenalty = safety.riskLevel === 'high' ? 8 : 0;
  const safetyScore = clamp(
    15
      - highRiskPenalty
      - Math.min(failedTasks * 3, 9)
      + (asArray(result.needsHumanValidation).length ? 2 : 0),
    0,
    15
  );

  const approvalSignals = [
    approvals.length > 0,
    approvals.some((a) => a.type === 'whatsapp_bulk'),
    approvals.every((a) => a.title && a.riskLevel),
    approvals.length <= 14,
  ].filter(Boolean).length;
  const approvalScore = Math.round((approvalSignals / 4) * 15);

  const marketSignals = [
    !!market.marketRead,
    asArray(market.dailyBets).length >= 3,
    asArray(market.competitorWatch).length >= 3,
    asArray(market.pricePositioning).some((p) => p.needsApproval === true || p.recommendedMove),
    asArray(market.watchouts).length > 0,
  ].filter(Boolean).length;
  const marketScore = Math.round((marketSignals / 5) * 15);

  const costScore = clamp(10 - Math.max(tasks.length - 10, 0) - failedTasks * 2, 0, 10);

  const total = taskScore + actionabilityScore + safetyScore + approvalScore + marketScore + costScore;
  return {
    orchestrationId: orchestration.id,
    createdAt: orchestration.createdAt,
    agentVariant: orchestration.input?.metadata?.agentVariant || 'unknown',
    agentsUsed: asArray(result.agentsUsed),
    tasks: { total: tasks.length, completed: completedTasks, failed: failedTasks, score: taskScore },
    actionability: { score: actionabilityScore },
    safety: { score: safetyScore, riskLevel: safety.riskLevel || null },
    approvals: { total: approvals.length, score: approvalScore },
    marketCoverage: { score: marketScore, hasMarketAgent: !!market.agentCode || !!market.marketRead },
    costDiscipline: { score: costScore },
    total,
    nextRecommendedAction: result.nextRecommendedAction || '',
  };
}

function compareScores(baseline, candidate) {
  const delta = candidate.total - baseline.total;
  return {
    baseline,
    candidate,
    delta,
    verdict: delta > 5
      ? 'candidate_better'
      : delta < -5
        ? 'baseline_better'
        : 'too_close',
    note: 'Score heuristico. Use como filtro de qualidade; validacao final precisa medir aprovacao humana, execucao e resultado comercial.',
  };
}

async function loadOrchestration(id) {
  return prisma.aIOrchestration.findUnique({
    where: { id },
    include: {
      tasks: { orderBy: { createdAt: 'asc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
    },
  });
}

async function evaluateDailyMarketPair({ baselineId, candidateId }) {
  if (!baselineId || !candidateId) {
    throw new Error('baselineId e candidateId sao obrigatorios');
  }
  const [baselineOrch, candidateOrch] = await Promise.all([
    loadOrchestration(baselineId),
    loadOrchestration(candidateId),
  ]);
  if (!baselineOrch) throw new Error(`baseline nao encontrada: ${baselineId}`);
  if (!candidateOrch) throw new Error(`candidate nao encontrada: ${candidateId}`);
  return compareScores(scoreOrchestration(baselineOrch), scoreOrchestration(candidateOrch));
}

module.exports = {
  scoreOrchestration,
  compareScores,
  evaluateDailyMarketPair,
};
