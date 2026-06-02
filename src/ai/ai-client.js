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

// Remove vírgulas penduradas antes de } ou ] (erro comum de LLM), sem
// tocar em vírgulas dentro de strings.
function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      // olha o próximo caractere não-branco
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // descarta a vírgula
    }
    out += c;
  }
  return out;
}

// Varredura balanceada a partir de `start` (que aponta para { ou [),
// respeitando strings e escapes. Retorna a substring fechada ou null
// (null = não fechou → provável truncamento por max_tokens).
function balancedFrom(raw, start) {
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

// Tenta achar o primeiro valor JSON que REALMENTE parseia, testando cada
// posição de abertura ({ ou [). Robusto a prosa e a chaves soltas no texto
// (ex.: placeholders "{valor}") antes do JSON de verdade.
function extractFirstValidJSON(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '{' && c !== '[') continue;
    const candidate = balancedFrom(raw, i);
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch (_) { /* segue */ }
    try { return JSON.parse(stripTrailingCommas(candidate)); } catch (_) { /* segue */ }
  }
  return null;
}

function tryParseJSON(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();

  // Tentativa 1: parse direto
  try { return JSON.parse(trimmed); } catch (_) { /* segue */ }

  // Tentativa 2: se vier em cerca tripla ```json ... ```, usa o miolo
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence && fence[1] ? fence[1].trim() : null;
  if (fenced) {
    try { return JSON.parse(fenced); } catch (_) { /* segue */ }
  }

  // Tentativa 3: primeiro valor JSON válido (objeto OU array), varrendo cada
  // posição de abertura e reparando vírgulas penduradas. Tenta no miolo da
  // cerca primeiro, depois no texto inteiro.
  for (const src of [fenced, trimmed]) {
    if (!src) continue;
    const parsed = extractFirstValidJSON(src);
    if (parsed !== null) return parsed;
  }

  // Tentativa 4: último recurso — repara o texto inteiro
  try { return JSON.parse(stripTrailingCommas(trimmed)); } catch (_) { /* desiste */ }

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
