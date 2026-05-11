// =====================================================================
// Possibility Engine — gera possibilidades personalizadas para o usuário
// =====================================================================
// Fluxo:
//   1. Carrega contexto do usuário (perfil de vida, humor, treinos)
//   2. Chama life-assessor-agent
//   3. Passa resposta pelo safety-agent
//   4. Salva UserRecommendation
//   5. Cria UserAction para possibilidades que exigem aprovação
//   6. Retorna estrutura final
// =====================================================================

const { prisma } = require('../../middleware');
const { loadUserLifeContext } = require('../context/user-context.service');
const lifeAssessorAgent = require('../agents/life-assessor.agent');
const safetyAgent = require('../agents/safety.agent');

async function generatePossibilities({ userId, currentCondition, objective, context } = {}) {
  if (!userId) throw new Error('userId é obrigatório');

  // 1) Contexto do usuário
  const userContext = await loadUserLifeContext(userId);

  // 2) Chama Life Assessor
  const fullContext = {
    user: userContext,
    currentCondition: currentCondition || null,
    extra: context || null,
  };
  const lifeOutput = await lifeAssessorAgent({
    objective: objective || 'Gerar possibilidades personalizadas para o usuário neste momento.',
    task: 'Apresente 1 a 3 possibilidades com clareza real, respeitando o estado atual e o perfil.',
    context: fullContext,
    createdById: userId,
  });

  // 3) Safety pass — Life Agent é particularmente sensível (saúde mental, suplementação, etc.)
  const safetyResult = await safetyAgent({
    payload: lifeOutput,
    contextNote: `Life Assessor para userId=${userId}. Condição atual: ${JSON.stringify(currentCondition || {}).slice(0, 500)}`,
    createdById: userId,
  });

  const possibilities = Array.isArray(lifeOutput.possibilities) ? lifeOutput.possibilities : [];

  // 4) Persiste UserRecommendation
  const recommendation = await prisma.userRecommendation.create({
    data: {
      userId,
      source: 'life-assessor-agent',
      input: { currentCondition: currentCondition || null, objective: objective || null, contextNote: context || null },
      possibilities: { summary: lifeOutput.summary || '', items: possibilities, clarityNote: lifeOutput.clarityNote || '' },
      status: 'generated',
    },
  });

  // 5) Cria UserAction para possibilidades que envolvem terceiros/compra/agendamento
  const createdActions = [];
  for (const p of possibilities) {
    if (!p || !p.title) continue;
    const requiresApproval = p.requiresApproval !== false;
    const action = await prisma.userAction.create({
      data: {
        userId,
        recommendationId: recommendation.id,
        type: p.actionType || 'other',
        title: p.title,
        status: 'pending',
        payload: p,
        requiresApproval,
      },
    });
    createdActions.push({
      id: action.id,
      type: action.type,
      title: action.title,
      requiresApproval: action.requiresApproval,
    });
  }

  return {
    recommendationId: recommendation.id,
    summary: lifeOutput.summary || '',
    possibilities,
    actions: createdActions,
    clarityNote: lifeOutput.clarityNote || '',
    safetyNotes: [
      ...(Array.isArray(lifeOutput.safetyNotes) ? lifeOutput.safetyNotes : []),
      ...(Array.isArray(safetyResult.requiredHumanValidation) ? safetyResult.requiredHumanValidation : []),
    ],
    safetyReview: {
      approved: !!safetyResult.approved,
      riskLevel: safetyResult.riskLevel || 'low',
      risks: safetyResult.risks || [],
    },
    nextQuestion: lifeOutput.nextQuestion || '',
  };
}

async function listUserRecommendations(userId, { limit = 20 } = {}) {
  if (!userId) return [];
  return prisma.userRecommendation.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
}

module.exports = { generatePossibilities, listUserRecommendations };
