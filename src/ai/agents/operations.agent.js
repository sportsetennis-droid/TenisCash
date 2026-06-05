const { runAgent, buildUserPrompt } = require('./_base');
const { OPERATIONS_AGENT } = require('../prompts/agent-prompts');

async function operationsAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'operations-agent',
    systemPrompt: OPERATIONS_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      checklist: [],
      teamTasks: [],
      storeRoutine: [],
      executionTimeline: [],
      nextAction: 'Operação indisponível — organizar checklist manualmente.',
    },
    maxTokens: 3500,
    createdById,
  });
}

module.exports = operationsAgent;
