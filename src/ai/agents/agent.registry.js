// =====================================================================
// Agent Registry — mapeia código do agente para função de execução
// =====================================================================

const stockAgent = require('./stock.agent');
const financeAgent = require('./finance.agent');
const marketingAgent = require('./marketing.agent');
const salesAgent = require('./sales.agent');
const whatsappAgent = require('./whatsapp.agent');
const reportAgent = require('./report.agent');
const operationsAgent = require('./operations.agent');
const partnerAgent = require('./partner.agent');
const productAgent = require('./product.agent');
const lifeAssessorAgent = require('./life-assessor.agent');
const safetyAgent = require('./safety.agent');

const agents = {
  'stock-agent': stockAgent,
  'finance-agent': financeAgent,
  'marketing-agent': marketingAgent,
  'sales-agent': salesAgent,
  'whatsapp-agent': whatsappAgent,
  'report-agent': reportAgent,
  'operations-agent': operationsAgent,
  'partner-agent': partnerAgent,
  'product-agent': productAgent,
  'life-assessor-agent': lifeAssessorAgent,
  'safety-agent': safetyAgent,
};

const metadata = {
  'stock-agent': { name: 'Estoque', category: 'commercial', description: 'Analisa estoque, identifica produtos parados, sugere campanhas' },
  'finance-agent': { name: 'Financeiro', category: 'commercial', description: 'Avalia margem, sugere desconto seguro, marca aprovações financeiras' },
  'marketing-agent': { name: 'Marketing', category: 'commercial', description: 'Cria conceito, legenda, story, vitrine, roteiro' },
  'sales-agent': { name: 'Vendas', category: 'commercial', description: 'Script de venda, abordagem, objeções, meta diária' },
  'whatsapp-agent': { name: 'WhatsApp', category: 'operations', description: 'Prepara mensagens — nunca envia sozinho' },
  'report-agent': { name: 'Relatórios', category: 'operations', description: 'Diagnóstico, indicadores, problemas e oportunidades' },
  'operations-agent': { name: 'Operações', category: 'operations', description: 'Checklist, rotina, execução por horário' },
  'partner-agent': { name: 'Parceiros', category: 'commercial', description: 'Programa de Parceiros Sports & Tennis' },
  'product-agent': { name: 'Produto', category: 'commercial', description: 'Recomendações, lacunas, conexão com perfil' },
  'life-assessor-agent': { name: 'Assessor (Clareza)', category: 'life', description: 'Possibilidades personalizadas com clareza real' },
  'safety-agent': { name: 'Segurança', category: 'safety', description: 'Revisão de risco antes de apresentar resposta' },
};

function getAgent(agentCode) {
  return agents[agentCode] || null;
}

function listAgents() {
  return Object.keys(agents).map((code) => ({ code, ...(metadata[code] || {}) }));
}

/**
 * selectAgentsForObjective — heurística baseada em palavras-chave do objetivo.
 * O objetivo é dado em PT-BR; a função normaliza para lowercase sem acentos.
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function selectAgentsForObjective(objective) {
  const o = normalize(objective);
  const has = (terms) => terms.some((t) => o.includes(t));

  // Life Agent — pessoa/cliente/vida/rotina/sentimento
  if (
    has([
      'cliente', 'assinante', 'vida', 'rotina', 'treino', 'possibilidad',
      'tristeza', 'triste', 'cansaco', 'cansad', 'clareza', 'humor',
      'energia', 'descansar', 'descanso', 'sentimento',
    ])
  ) {
    return ['life-assessor-agent', 'product-agent', 'whatsapp-agent', 'safety-agent'];
  }

  // Parceiros
  if (has(['parceir', 'cupom', 'cupons', 'influencer', 'atleta'])) {
    return ['partner-agent', 'marketing-agent', 'finance-agent', 'report-agent', 'safety-agent'];
  }

  // Produto/catálogo
  if (has(['produto', 'catalogo', 'recomendacao', 'recomendar', 'sku', 'modelo'])) {
    return ['product-agent', 'stock-agent', 'marketing-agent', 'safety-agent'];
  }

  // Venda/campanha/loja/meta
  if (has(['venda', 'vender', 'campanha', 'loja', 'meta', 'parad', 'giro', 'desconto'])) {
    return [
      'stock-agent', 'finance-agent', 'marketing-agent', 'sales-agent',
      'whatsapp-agent', 'report-agent', 'operations-agent', 'safety-agent',
    ];
  }

  // Genérico
  return ['report-agent', 'marketing-agent', 'operations-agent', 'safety-agent'];
}

module.exports = {
  agents,
  metadata,
  getAgent,
  listAgents,
  selectAgentsForObjective,
};
