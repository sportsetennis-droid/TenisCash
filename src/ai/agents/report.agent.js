const { runAgent, buildUserPrompt } = require('./_base');
const { REPORT_AGENT } = require('../prompts/agent-prompts');

async function reportAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'report-agent',
    systemPrompt: REPORT_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      summary: 'Relatório indisponível.',
      keyMetrics: [],
      problemsFound: [],
      opportunities: [],
      nextReviewTime: '',
      nextAction: 'Revisar indicadores manualmente.',
    },
    createdById,
  });
}

module.exports = reportAgent;
