const { runAgent, buildUserPrompt } = require('./_base');
const { STOCK_AGENT } = require('../prompts/agent-prompts');

async function stockAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'stock-agent',
    systemPrompt: STOCK_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      summary: 'Sem análise de estoque disponível no momento.',
      recommendedProducts: [],
      stockRisks: [],
      campaignOpportunities: [],
      nextAction: 'Revisar estoque manualmente.',
    },
    maxTokens: 2000,
    createdById,
  });
}

module.exports = stockAgent;
