// =====================================================================
// Helper interno para agentes — wrappper sobre callAI + logs + fallback
// =====================================================================

const { callAI } = require('../ai-client');
const { logAIAction } = require('../logs/ai-log.service');

/**
 * runAgent — executa um agente padrão.
 * @param {Object} opts
 * @param {string} opts.agentCode
 * @param {string} opts.systemPrompt
 * @param {string} opts.userPrompt
 * @param {Object} opts.input - para registro em log
 * @param {Object} [opts.fallback] - JSON retornado quando IA falha
 * @param {number} [opts.maxTokens=1200]
 * @param {string} [opts.createdById]
 */
async function runAgent({
  agentCode,
  systemPrompt,
  userPrompt,
  input,
  fallback,
  maxTokens = 1200,
  createdById,
}) {
  const result = await callAI({ systemPrompt, userPrompt, jsonMode: true, maxTokens });

  if (!result.ok) {
    const safeFallback = {
      agentCode,
      summary: `Agente ${agentCode} indisponível. Operando em modo seguro.`,
      ...(fallback || {}),
      _degraded: true,
      _error: result.error,
    };
    await logAIAction({
      agentCode,
      action: 'run',
      input,
      output: safeFallback,
      error: result.error,
      cost: result.cost?.brl || 0,
      tokens: (result.cost?.inT || 0) + (result.cost?.outT || 0),
      createdById,
    });
    return safeFallback;
  }

  const output = result.json || {};
  if (!output.agentCode) output.agentCode = agentCode;

  await logAIAction({
    agentCode,
    action: 'run',
    input,
    output,
    error: null,
    cost: result.cost?.brl || 0,
    tokens: (result.cost?.inT || 0) + (result.cost?.outT || 0),
    createdById,
  });

  return output;
}

function compactContext(context) {
  if (!context) return '';
  try {
    const json = JSON.stringify(context, null, 0);
    if (json.length > 12000) return json.slice(0, 12000) + '... [truncated]';
    return json;
  } catch (_) {
    return String(context);
  }
}

function buildUserPrompt({ objective, task, context }) {
  const parts = [];
  if (objective) parts.push(`# Objetivo geral\n${objective}`);
  if (task) parts.push(`# Sua tarefa específica\n${task}`);
  if (context) parts.push(`# Contexto disponível (JSON)\n${compactContext(context)}`);
  parts.push('Responda apenas com o JSON especificado no system prompt.');
  return parts.join('\n\n');
}

module.exports = { runAgent, buildUserPrompt, compactContext };
