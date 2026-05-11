const { runAgent, buildUserPrompt } = require('./_base');
const { PARTNER_AGENT } = require('../prompts/agent-prompts');

async function partnerAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'partner-agent',
    systemPrompt: PARTNER_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      partnerCampaign: '',
      partnerPostText: '',
      partnerGoal: '',
      commissionNotes: '',
      approvalRequired: [],
      nextAction: 'Programa de parceiros indisponível — escrever campanha manualmente.',
    },
    createdById,
  });
}

module.exports = partnerAgent;
