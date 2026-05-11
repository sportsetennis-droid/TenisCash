const { runAgent, buildUserPrompt } = require('./_base');
const { FINANCE_AGENT } = require('../prompts/agent-prompts');

async function financeAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'finance-agent',
    systemPrompt: FINANCE_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      summary: 'Sem avaliação financeira disponível.',
      marginNotes: [],
      safeDiscountSuggestion: null,
      approvalRequired: [],
      financialRisks: ['Avaliação financeira indisponível — não aplicar descontos sem revisão humana.'],
      nextAction: 'Revisar margens manualmente.',
    },
    createdById,
  });
}

module.exports = financeAgent;
