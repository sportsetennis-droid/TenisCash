const { runAgent, buildUserPrompt } = require('./_base');
const { MARKETING_AGENT } = require('../prompts/agent-prompts');

async function marketingAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'marketing-agent',
    systemPrompt: MARKETING_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      campaignName: '',
      mainConcept: '',
      mainPhrase: '',
      instagramCaption: '',
      stories: [],
      videoScript: '',
      storeCallout: '',
      whatsappVariation: '',
      nextAction: 'Marketing indisponível — produzir comunicação manualmente.',
    },
    createdById,
  });
}

module.exports = marketingAgent;
