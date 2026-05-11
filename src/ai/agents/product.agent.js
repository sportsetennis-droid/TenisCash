const { runAgent, buildUserPrompt } = require('./_base');
const { PRODUCT_AGENT } = require('../prompts/agent-prompts');

async function productAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'product-agent',
    systemPrompt: PRODUCT_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      productRecommendations: [],
      productGaps: [],
      catalogImprovements: [],
      nextAction: 'Recomendações de produto indisponíveis.',
    },
    createdById,
  });
}

module.exports = productAgent;
