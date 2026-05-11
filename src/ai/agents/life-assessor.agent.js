const { runAgent, buildUserPrompt } = require('./_base');
const { LIFE_ASSESSOR_PROMPT } = require('../prompts/system-prompts');

async function lifeAssessorAgent({ task, context, objective, createdById }) {
  const out = await runAgent({
    agentCode: 'life-assessor-agent',
    systemPrompt: LIFE_ASSESSOR_PROMPT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    maxTokens: 1500,
    fallback: {
      summary: 'Assessor indisponível agora. Quando quiser, retome com uma pergunta simples sobre como você está.',
      possibilities: [],
      clarityNote: '',
      safetyNotes: [],
      nextQuestion: '',
    },
    createdById,
  });

  // Defensivo: garantir array de possibilidades e flag de aprovação
  if (!Array.isArray(out.possibilities)) out.possibilities = [];
  out.possibilities = out.possibilities.slice(0, 3).map((p) => ({
    title: p.title || '',
    whyItMakesSense: p.whyItMakesSense || '',
    energyRequired: p.energyRequired || 'low',
    timeRequired: p.timeRequired || '',
    estimatedCost: p.estimatedCost || '',
    probableBenefit: p.probableBenefit || '',
    attentionPoint: p.attentionPoint || '',
    nextStep: p.nextStep || '',
    requiresApproval: p.requiresApproval !== false,
    actionType: p.actionType || 'other',
  }));

  if (!Array.isArray(out.safetyNotes)) out.safetyNotes = [];
  return out;
}

module.exports = lifeAssessorAgent;
