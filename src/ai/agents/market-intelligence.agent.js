const { runAgent, buildUserPrompt } = require('./_base');
const { MARKET_INTELLIGENCE_AGENT } = require('../prompts/agent-prompts');

async function marketIntelligenceAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'market-intelligence-agent',
    systemPrompt: MARKET_INTELLIGENCE_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    fallback: {
      summary: 'Inteligencia de mercado indisponivel no momento.',
      marketRead: '',
      pricePositioning: [],
      demandSignals: [],
      competitorWatch: [],
      dailyBets: [],
      watchouts: ['Nao alterar preco nem anunciar desconto sem revisao humana.'],
      approvalRequired: [],
      nextAction: 'Comparar manualmente 3 SKUs foco com concorrentes antes de mudar preco.',
    },
    maxTokens: 3000,
    createdById,
  });
}

module.exports = marketIntelligenceAgent;
