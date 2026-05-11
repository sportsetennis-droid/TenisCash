const { runAgent, buildUserPrompt } = require('./_base');
const { SALES_AGENT } = require('../prompts/agent-prompts');

async function salesAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'sales-agent',
    systemPrompt: SALES_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      salesScript: '',
      openingQuestions: [],
      objectionHandling: [],
      closingLine: '',
      dailyGoalSuggestion: '',
      nextAction: 'Vendas indisponível — abordagem manual.',
    },
    createdById,
  });
}

module.exports = salesAgent;
