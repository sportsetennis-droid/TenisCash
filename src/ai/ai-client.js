// =====================================================================
// AI Client — wrapper único para chamadas ao Anthropic SDK
// =====================================================================
// Centraliza:
//  - construção do cliente
//  - modelo padrão (env AI_ORCHESTRATOR_MODEL > AI_MODEL > haiku-4-5)
//  - parsing de JSON com fallback
//  - cálculo de custo (mesma fórmula do /api/ai/chat)
//  - tratamento de erro sem derrubar a aplicação chamadora
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

function buildClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY não configurada');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return new Anthropic({ apiKey: key });
}

function defaultModel() {
  return (
    process.env.AI_ORCHESTRATOR_MODEL
    || process.env.AI_MODEL
    || 'claude-haiku-4-5-20251001'
  );
}

function computeCostBRL(usage) {
  const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
  const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const inT = usage?.input_tokens || 0;
  const outT = usage?.output_tokens || 0;
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { usd, brl: usd * brl, inT, outT };
}

function extractText(resp) {
  const blocks = resp?.content || [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function tryParseJSON(raw) {
  if (!raw) return null;
  // Tentativa 1: parse direto
  try {
    return JSON.parse(raw);
  } catch (_) {
    // ignorar e tentar extração
  }
  // Tentativa 2: extrair do primeiro { até último } balanceado
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    const candidate = raw.slice(first, last + 1);
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // ignorar
    }
  }
  // Tentativa 3: extrair de cerca tripla ```json ... ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {
      // ignorar
    }
  }
  return null;
}

/**
 * callAI — chamada padronizada ao modelo.
 *
 * @param {Object} options
 * @param {string} options.systemPrompt - prompt de sistema (obrigatório)
 * @param {string} options.userPrompt - prompt do usuário (obrigatório)
 * @param {boolean} [options.jsonMode=true] - se true, força resposta em JSON e faz parse
 * @param {number} [options.maxTokens=1200]
 * @param {number} [options.temperature]
 * @param {string} [options.model] - override do modelo padrão
 *
 * @returns {Promise<{ok: boolean, json: any|null, text: string, usage: object, cost: object, error: string|null}>}
 *   - ok=false NUNCA lança — sempre retorna estrutura para callers tratarem fallback.
 */
async function callAI({
  systemPrompt,
  userPrompt,
  jsonMode = true,
  maxTokens = 1200,
  temperature,
  model,
} = {}) {
  if (!systemPrompt || !userPrompt) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: { usd: 0, brl: 0, inT: 0, outT: 0 },
      error: 'systemPrompt e userPrompt são obrigatórios',
    };
  }

  let client;
  try {
    client = buildClient();
  } catch (err) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: { usd: 0, brl: 0, inT: 0, outT: 0 },
      error: err.message || 'Falha ao inicializar cliente IA',
    };
  }

  const finalSystem = jsonMode
    ? systemPrompt
      + '\n\nIMPORTANTE: Responda APENAS com JSON válido, sem markdown e sem texto antes ou depois. '
      + 'O JSON deve seguir exatamente o formato pedido pelo prompt do usuário.'
    : systemPrompt;

  const requestBody = {
    model: model || defaultModel(),
    max_tokens: maxTokens,
    system: finalSystem,
    messages: [{ role: 'user', content: userPrompt }],
  };
  if (typeof temperature === 'number') {
    requestBody.temperature = temperature;
  }

  try {
    const resp = await client.messages.create(requestBody);
    const text = extractText(resp);
    const usage = resp?.usage || null;
    const cost = computeCostBRL(usage);

    if (jsonMode) {
      const parsed = tryParseJSON(text);
      if (!parsed) {
        return {
          ok: false,
          json: null,
          text,
          usage,
          cost,
          error: 'Resposta da IA não pôde ser parseada como JSON',
        };
      }
      return { ok: true, json: parsed, text, usage, cost, error: null };
    }

    return { ok: true, json: null, text, usage, cost, error: null };
  } catch (err) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: { usd: 0, brl: 0, inT: 0, outT: 0 },
      error: err?.message || 'Erro desconhecido ao chamar IA',
    };
  }
}

module.exports = {
  callAI,
  buildClient,
  defaultModel,
  computeCostBRL,
  tryParseJSON,
};
