// =====================================================================
// JSON schemas for OpenAI Structured Outputs.
// Strict=false keeps agents flexible, but root is always an object.
// =====================================================================

const stringArray = { type: 'array', items: { type: 'string' } };
const objectArray = { type: 'array', items: { type: 'object', additionalProperties: true } };

function obj(name, properties) {
  return {
    name,
    schema: {
      type: 'object',
      additionalProperties: true,
      properties,
    },
  };
}

const SCHEMAS = {
  'stock-agent': obj('stock_agent_response', {
    agentCode: { type: 'string' },
    summary: { type: 'string' },
    recommendedProducts: objectArray,
    stockRisks: stringArray,
    campaignOpportunities: stringArray,
    nextAction: { type: 'string' },
  }),
  'finance-agent': obj('finance_agent_response', {
    agentCode: { type: 'string' },
    summary: { type: 'string' },
    marginNotes: stringArray,
    safeDiscountSuggestion: { type: ['object', 'null'], additionalProperties: true },
    approvalRequired: objectArray,
    financialRisks: stringArray,
    nextAction: { type: 'string' },
  }),
  'marketing-agent': obj('marketing_agent_response', {
    agentCode: { type: 'string' },
    campaignName: { type: 'string' },
    mainConcept: { type: 'string' },
    mainPhrase: { type: 'string' },
    instagramCaption: { type: 'string' },
    stories: stringArray,
    videoScript: { type: 'string' },
    storeCallout: { type: 'string' },
    whatsappVariation: { type: 'string' },
    nextAction: { type: 'string' },
  }),
  'sales-agent': obj('sales_agent_response', {
    agentCode: { type: 'string' },
    salesScript: { type: 'string' },
    openingQuestions: stringArray,
    objectionHandling: objectArray,
    closingLine: { type: 'string' },
    dailyGoalSuggestion: { type: 'string' },
    nextAction: { type: 'string' },
  }),
  'whatsapp-agent': obj('whatsapp_agent_response', {
    agentCode: { type: 'string' },
    individualMessage: { type: 'string' },
    campaignMessage: { type: 'string' },
    followUpMessage: { type: 'string' },
    approvalRequired: objectArray,
    nextAction: { type: 'string' },
  }),
  'report-agent': obj('report_agent_response', {
    agentCode: { type: 'string' },
    summary: { type: 'string' },
    keyMetrics: objectArray,
    problemsFound: stringArray,
    opportunities: stringArray,
    nextReviewTime: { type: 'string' },
    nextAction: { type: 'string' },
  }),
  'operations-agent': obj('operations_agent_response', {
    agentCode: { type: 'string' },
    checklist: stringArray,
    teamTasks: objectArray,
    storeRoutine: stringArray,
    executionTimeline: objectArray,
    nextAction: { type: 'string' },
  }),
  'partner-agent': obj('partner_agent_response', {
    agentCode: { type: 'string' },
    partnerCampaign: { type: 'string' },
    partnerPostText: { type: 'string' },
    partnerGoal: { type: 'string' },
    commissionNotes: { type: 'string' },
    approvalRequired: objectArray,
    nextAction: { type: 'string' },
  }),
  'product-agent': obj('product_agent_response', {
    agentCode: { type: 'string' },
    productRecommendations: objectArray,
    productGaps: stringArray,
    catalogImprovements: stringArray,
    nextAction: { type: 'string' },
  }),
  'market-intelligence-agent': obj('market_intelligence_agent_response', {
    agentCode: { type: 'string' },
    summary: { type: 'string' },
    marketRead: { type: 'string' },
    pricePositioning: objectArray,
    demandSignals: objectArray,
    competitorWatch: objectArray,
    dailyBets: objectArray,
    watchouts: stringArray,
    approvalRequired: objectArray,
    nextAction: { type: 'string' },
  }),
  'design-brief-agent': obj('design_brief_agent_response', {
    agentCode: { type: 'string' },
    campaignName: { type: 'string' },
    feed: { type: 'object', additionalProperties: true },
    story: { type: 'object', additionalProperties: true },
    nextAction: { type: 'string' },
  }),
  'life-assessor-agent': obj('life_assessor_agent_response', {
    summary: { type: 'string' },
    possibilities: objectArray,
    clarityNote: { type: 'string' },
    safetyNotes: stringArray,
    nextQuestion: { type: 'string' },
  }),
  'safety-agent': obj('safety_agent_response', {
    approved: { type: 'boolean' },
    riskLevel: { type: 'string' },
    risks: objectArray,
    requiredHumanValidation: stringArray,
    safeVersionNotes: { type: 'string' },
  }),
  'orchestrator-agent': obj('orchestrator_agent_response', {
    objective: { type: 'string' },
    companyContext: { type: 'string' },
    agentsUsed: stringArray,
    agentTasks: objectArray,
    consolidatedPlan: { type: 'string' },
    readyMaterials: { type: 'object', additionalProperties: true },
    approvalRequired: objectArray,
    risks: stringArray,
    canExecuteNow: stringArray,
    needsHumanValidation: stringArray,
    nextRecommendedAction: { type: 'string' },
  }),
};

function getAgentSchema(agentCode) {
  return SCHEMAS[agentCode] || obj('agent_response', {});
}

module.exports = { getAgentSchema };
