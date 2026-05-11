const { runAgent } = require('./_base');
const { SAFETY_AGENT_PROMPT } = require('../prompts/system-prompts');

/**
 * safetyAgent — revisa payload de outro agente/plano antes de apresentar.
 * @param {Object} opts
 * @param {Object} opts.payload - JSON da resposta a revisar
 * @param {string} [opts.contextNote]
 * @param {string} [opts.createdById]
 */
async function safetyAgent({ payload, contextNote, createdById }) {
  const userPrompt = [
    '# Conteúdo para revisar (JSON do agente):',
    '```json',
    JSON.stringify(payload || {}, null, 2).slice(0, 10000),
    '```',
    contextNote ? `\n# Contexto adicional\n${contextNote}` : '',
    '\nClassifique o risco e retorne SOMENTE o JSON especificado no system prompt.',
  ].filter(Boolean).join('\n');

  return runAgent({
    agentCode: 'safety-agent',
    systemPrompt: SAFETY_AGENT_PROMPT,
    userPrompt,
    input: { payload, contextNote },
    maxTokens: 800,
    fallback: {
      approved: true,
      riskLevel: 'medium',
      risks: [{ type: 'safety_agent_unavailable', description: 'Revisão de segurança não disponível — recomenda-se revisão humana antes de qualquer ação sensível.' }],
      requiredHumanValidation: ['Revisão humana antes de executar.'],
      safeVersionNotes: '',
    },
    createdById,
  });
}

module.exports = safetyAgent;
