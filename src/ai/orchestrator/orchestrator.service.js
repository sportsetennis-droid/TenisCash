// =====================================================================
// Orchestrator Service — Central IA Sports & Tennis
// =====================================================================
// Coordena agentes especialistas para transformar objetivos em planos.
//   1. Carrega contexto de negócio
//   2. Seleciona agentes
//   3. Cria AIOrchestration e tasks
//   4. Executa agentes (sequencial nesta v1)
//   5. Consolida com IA (orquestrador como agente)
//   6. Passa consolidação pelo safety agent
//   7. Cria AIApproval para itens sensíveis
//   8. Persiste resultado final
// =====================================================================

const { prisma } = require('../../middleware');
const { callAI } = require('../ai-client');
const { ORCHESTRATOR_PROMPT } = require('../prompts/system-prompts');
const { logAIAction } = require('../logs/ai-log.service');
const { getAgentSchema } = require('../prompts/agent-schemas');
const {
  getAgent,
  resolveAgentVariant,
  selectAgentsForObjective,
  listAgents,
} = require('../agents/agent.registry');
const safetyAgent = require('../agents/safety.agent');
const { loadBusinessContext } = require('../context/business-context.service');
const { createManyApprovals } = require('../approvals/approval.service');
const learning = require('../learning/learning.service');

function describeTaskForAgent(agentCode, objective) {
  const map = {
    'stock-agent': 'Analisar estoque, identificar produtos parados e oportunidades de giro.',
    'finance-agent': 'Avaliar margem e indicar desconto seguro. Marcar aprovações financeiras.',
    'marketing-agent': 'Criar conceito de campanha, legenda, story, frase de vitrine e roteiro.',
    'sales-agent': 'Criar script de venda, perguntas de diagnóstico e tratamento de objeções.',
    'whatsapp-agent': 'Preparar mensagens (individual, campanha, follow-up). Marcar approval para envio em massa.',
    'report-agent': 'Resumir desempenho, apontar problemas e oportunidades.',
    'operations-agent': 'Transformar plano em checklist e timeline operacional.',
    'partner-agent': 'Preparar campanha e texto de divulgação para parceiros.',
    'product-agent': 'Sugerir produtos relevantes para o objetivo e identificar lacunas.',
    'market-intelligence-agent': 'Ler sinais de mercado, preço, demanda e concorrência para orientar as jogadas do dia.',
    'life-assessor-agent': 'Gerar possibilidades personalizadas para o usuário.',
  };
  return map[agentCode] || `Contribuir com a especialidade do agente para o objetivo: ${objective}`;
}

async function runOrchestration({
  objective,
  storeId,
  notes,
  userId,
  createdById,
  extraContext,
  source,
  metadata,
} = {}) {
  if (!objective || typeof objective !== 'string' || !objective.trim()) {
    throw new Error('objective é obrigatório');
  }

  // 1) Contexto de negócio
  const baseBusinessContext = await loadBusinessContext({ storeId, userId });
  const { aiMemory, ...businessContextWithoutMemory } = baseBusinessContext || {};
  const businessContext = extraContext
    ? { ...businessContextWithoutMemory, extraContext, aiMemory }
    : baseBusinessContext;

  const requestedAgentVariant = metadata?.agentVariant
    || metadata?.squadVariant
    || extraContext?.operatingMode?.agentVariant
    || null;
  const agentVariant = resolveAgentVariant({ agentVariant: requestedAgentVariant });

  // 2) Seleção de agentes (filtrando safety — chamado por último, em separado)
  const selected = selectAgentsForObjective(objective, { agentVariant }).filter((c) => c !== 'safety-agent');

  // 3) Cria orquestração
  const orchestration = await prisma.aIOrchestration.create({
    data: {
      objective,
      company: 'Sports & Tennis',
      status: 'running',
      input: {
        storeId: storeId || null,
        notes: notes || null,
        userId: userId || null,
        source: source || 'manual',
        metadata: {
          ...(metadata || {}),
          agentVariant,
        },
      },
      context: businessContext,
      createdById: createdById || null,
    },
  });

  // 4) Cria tasks + executa agentes sequencialmente
  const agentOutputs = {};
  const taskRecords = [];
  for (const agentCode of selected) {
    const fn = getAgent(agentCode);
    if (!fn) continue;
    const taskDesc = describeTaskForAgent(agentCode, objective);

    const taskRow = await prisma.aIOrchestrationTask.create({
      data: {
        orchestrationId: orchestration.id,
        agentCode,
        task: taskDesc,
        status: 'running',
        input: { objective, notes: notes || null },
      },
    });

    try {
      const out = await fn({
        task: taskDesc,
        objective,
        context: { business: businessContext, notes: notes || null },
        createdById,
      });
      await prisma.aIOrchestrationTask.update({
        where: { id: taskRow.id },
        data: { status: 'completed', output: out },
      });
      agentOutputs[agentCode] = out;
      taskRecords.push({ id: taskRow.id, agentCode, task: taskDesc, output: out });
    } catch (err) {
      await prisma.aIOrchestrationTask.update({
        where: { id: taskRow.id },
        data: { status: 'failed', error: err.message },
      });
      agentOutputs[agentCode] = { _error: err.message };
    }
  }

  // 5) Consolidação via IA (orquestrador como agente)
  const consolidationPrompt = [
    `# Objetivo\n${objective}`,
    notes ? `# Observações do admin\n${notes}` : '',
    `# Saída de cada agente especialista`,
    '```json',
    JSON.stringify(agentOutputs, null, 2).slice(0, 14000),
    '```',
    '# Sua tarefa',
    'Consolide as saídas acima em UM plano coerente para a Sports & Tennis. '
      + 'Separe claramente o que está pronto para usar do que precisa de aprovação humana. '
      + 'Liste riscos. Aponte a próxima ação recomendada. '
      + 'Retorne SOMENTE o JSON conforme system prompt.',
  ].filter(Boolean).join('\n\n');

  const consolidation = await callAI({
    systemPrompt: ORCHESTRATOR_PROMPT,
    userPrompt: consolidationPrompt,
    jsonMode: true,
    jsonSchema: getAgentSchema('orchestrator-agent'),
    maxTokens: 8000,
  });

  let consolidated;
  if (consolidation.ok && consolidation.json) {
    consolidated = consolidation.json;
  } else {
    consolidated = {
      objective,
      companyContext: 'Sports & Tennis',
      agentsUsed: selected,
      agentTasks: selected.map((c) => ({ agentCode: c, task: describeTaskForAgent(c, objective) })),
      consolidatedPlan: 'Consolidação automática indisponível. Veja outputs por agente.',
      readyMaterials: agentOutputs,
      approvalRequired: [],
      risks: ['Consolidação degradada — revisar manualmente.'],
      canExecuteNow: [],
      needsHumanValidation: ['Plano completo precisa de revisão humana.'],
      nextRecommendedAction: 'Revisar manualmente as saídas dos agentes.',
      _degraded: true,
      _error: consolidation.error,
    };
  }

  // Normalização defensiva
  consolidated.objective = consolidated.objective || objective;
  consolidated.companyContext = 'Sports & Tennis';
  consolidated.agentsUsed = [...new Set([
    ...selected,
    ...(Array.isArray(consolidated.agentsUsed) ? consolidated.agentsUsed : []),
  ])];
  consolidated.readyMaterials = {
    ...agentOutputs,
    ...((consolidated.readyMaterials && typeof consolidated.readyMaterials === 'object') ? consolidated.readyMaterials : {}),
  };
  consolidated.approvalRequired = Array.isArray(consolidated.approvalRequired) ? consolidated.approvalRequired : [];
  consolidated.risks = Array.isArray(consolidated.risks) ? consolidated.risks : [];
  consolidated.canExecuteNow = Array.isArray(consolidated.canExecuteNow) ? consolidated.canExecuteNow : [];
  consolidated.needsHumanValidation = Array.isArray(consolidated.needsHumanValidation) ? consolidated.needsHumanValidation : [];

  // 5b) Coleta aprovações que os agentes já marcaram nas suas saídas
  for (const [code, out] of Object.entries(agentOutputs)) {
    if (out && Array.isArray(out.approvalRequired)) {
      for (const a of out.approvalRequired) {
        if (a && a.type && a.title) {
          consolidated.approvalRequired.push({
            ...a,
            description: a.description || `Solicitação do agente ${code}.`,
          });
        }
      }
    }
  }

  const seenApprovalKeys = new Set();
  consolidated.approvalRequired = consolidated.approvalRequired.filter((a) => {
    if (!a || !a.type || !a.title) return false;
    const key = `${String(a.type).toLowerCase()}::${String(a.title).toLowerCase().trim()}`;
    if (seenApprovalKeys.has(key)) return false;
    seenApprovalKeys.add(key);
    return true;
  });

  // 6) Safety pass
  const safetyResult = await safetyAgent({
    payload: consolidated,
    contextNote: `Objetivo: ${objective}. Loja: ${storeId || 'todas'}.`,
    createdById,
  });
  consolidated.safetyReview = {
    approved: !!safetyResult.approved,
    riskLevel: safetyResult.riskLevel || 'medium',
    risks: safetyResult.risks || [],
    requiredHumanValidation: safetyResult.requiredHumanValidation || [],
    safeVersionNotes: safetyResult.safeVersionNotes || '',
  };
  if (Array.isArray(safetyResult.requiredHumanValidation)) {
    for (const item of safetyResult.requiredHumanValidation) {
      if (item && !consolidated.needsHumanValidation.includes(item)) {
        consolidated.needsHumanValidation.push(item);
      }
    }
  }

  // 7) Cria registros de aprovação no banco
  const createdApprovals = await createManyApprovals(orchestration.id, consolidated.approvalRequired);

  // 8) Persiste resultado final
  const finalStatus = consolidation.ok ? 'completed' : 'completed'; // sempre completed; degradado já marcado em result
  const saved = await prisma.aIOrchestration.update({
    where: { id: orchestration.id },
    data: {
      status: finalStatus,
      result: consolidated,
    },
  });

  await logAIAction({
    agentCode: 'orchestrator-agent',
    action: 'orchestrate',
    input: { objective, storeId, notes, userId },
    output: { orchestrationId: orchestration.id, approvalsCreated: createdApprovals.length, source: source || 'manual' },
    cost: consolidation.cost?.brl || 0,
    tokens: (consolidation.cost?.inT || 0) + (consolidation.cost?.outT || 0),
    error: consolidation.ok ? null : consolidation.error,
    createdById,
  });

  const learningResult = await learning.recordOrchestrationLearning(orchestration.id).catch((err) => {
    console.error('[learning.recordOrchestrationLearning] falhou (ignorado):', err.message);
    return null;
  });

  return {
    orchestrationId: saved.id,
    objective,
    agentsUsed: consolidated.agentsUsed,
    agentTasks: taskRecords.map((t) => ({ agentCode: t.agentCode, task: t.task })),
    consolidatedPlan: consolidated.consolidatedPlan,
    readyMaterials: consolidated.readyMaterials,
    approvalRequired: createdApprovals.map((a) => ({
      id: a.id,
      type: a.type,
      title: a.title,
      riskLevel: a.riskLevel,
      status: a.status,
    })),
    risks: consolidated.risks,
    safetyReview: consolidated.safetyReview,
    canExecuteNow: consolidated.canExecuteNow,
    needsHumanValidation: consolidated.needsHumanValidation,
    nextRecommendedAction: consolidated.nextRecommendedAction || '',
    learning: learningResult,
  };
}

async function listOrchestrations({ limit = 20 } = {}) {
  return prisma.aIOrchestration.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true,
      objective: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      createdById: true,
    },
  });
}

async function getOrchestration(id) {
  if (!id) return null;
  return prisma.aIOrchestration.findUnique({
    where: { id },
    include: {
      tasks: { orderBy: { createdAt: 'asc' } },
      approvals: { orderBy: { createdAt: 'desc' } },
    },
  });
}

module.exports = {
  runOrchestration,
  listOrchestrations,
  getOrchestration,
  listAgents,
};
