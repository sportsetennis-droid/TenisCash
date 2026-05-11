const { runAgent, buildUserPrompt } = require('./_base');
const { DESIGN_BRIEF_AGENT } = require('../prompts/agent-prompts');

async function designBriefAgent({ task, context, objective, createdById }) {
  return runAgent({
    agentCode: 'design-brief-agent',
    systemPrompt: DESIGN_BRIEF_AGENT,
    userPrompt: buildUserPrompt({ objective, task, context }),
    input: { task, objective, context },
    maxTokens: 2500,
    fallback: {
      campaignName: '',
      feed: {
        format: 'Instagram Feed 1080x1080',
        palette: ['#FF6D00', '#111111', '#FFFFFF'],
        typography: { title: 'Orbitron Bold', body: 'Chakra Petch' },
        composition: 'Briefing visual indisponível — pedir manualmente ao designer.',
        mainSubject: '',
        background: '',
        textOverlay: [],
        mood: 'Sports & Tennis',
        logoPlacement: 'rodapé',
        avoid: [],
        promptForAI: '',
        canvaInstructions: '',
      },
      story: {
        format: 'Instagram Story 1080x1920',
        palette: ['#FF6D00', '#111111', '#FFFFFF'],
        typography: { title: 'Orbitron Bold', body: 'Chakra Petch' },
        composition: 'Briefing visual indisponível — pedir manualmente ao designer.',
        mainSubject: '',
        background: '',
        textOverlay: [],
        mood: 'Sports & Tennis',
        logoPlacement: 'topo ou rodapé',
        ctaSticker: '',
        avoid: [],
        promptForAI: '',
        canvaInstructions: '',
      },
      nextAction: 'Briefing visual indisponível — produzir manualmente.',
    },
    createdById,
  });
}

module.exports = designBriefAgent;
