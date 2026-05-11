const { runAgent, buildUserPrompt } = require('./_base');
const { WHATSAPP_AGENT } = require('../prompts/agent-prompts');

async function whatsappAgent({ task, context, objective, createdById }) {
  const out = await runAgent({
    agentCode: 'whatsapp-agent',
    systemPrompt: WHATSAPP_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      individualMessage: '',
      campaignMessage: '',
      followUpMessage: '',
      approvalRequired: [],
      nextAction: 'WhatsApp indisponível — escrever mensagem manualmente.',
    },
    createdById,
  });

  // Salvaguarda: se há mensagem de campanha mas não veio approvalRequired, força aprovação
  if (out.campaignMessage && (!Array.isArray(out.approvalRequired) || out.approvalRequired.length === 0)) {
    out.approvalRequired = [
      {
        type: 'whatsapp_bulk',
        title: 'Aprovar envio em massa de WhatsApp',
        riskLevel: 'medium',
        description: 'Toda mensagem de campanha exige autorização antes do envio.',
      },
    ];
  }
  return out;
}

module.exports = whatsappAgent;
