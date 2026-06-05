// =====================================================================
// AI Client - wrapper unico para chamadas de IA
// =====================================================================
// Centraliza:
//  - escolha de provedor (OpenAI preferencial quando configurado)
//  - modelo padrao por provedor
//  - parsing de JSON com fallback
//  - calculo de custo
//  - tratamento de erro sem derrubar a aplicacao chamadora
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

function hasOpenAIKey() {
  return !!process.env.OPENAI_API_KEY;
}

function hasAnthropicKey() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function isOpenAIModel(model) {
  return /^(gpt-|o\d|chatgpt-|computer-use-|codex-)/i.test(String(model || ''));
}

function isAnthropicModel(model) {
  return /^claude-/i.test(String(model || ''));
}

function defaultProvider() {
  const configured = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (['openai', 'anthropic'].includes(configured)) return configured;

  // OpenAI e o motor preferencial para agentes quando a chave existe. Quem
  // quiser manter Anthropic como padrao pode setar AI_PROVIDER=anthropic.
  if (hasOpenAIKey()) return 'openai';
  if (hasAnthropicKey()) return 'anthropic';
  return 'anthropic';
}

function defaultOpenAIModel() {
  const candidates = [
    process.env.OPENAI_ORCHESTRATOR_MODEL,
    process.env.OPENAI_MODEL,
    isOpenAIModel(process.env.AI_ORCHESTRATOR_MODEL) ? process.env.AI_ORCHESTRATOR_MODEL : null,
    isOpenAIModel(process.env.AI_MODEL) ? process.env.AI_MODEL : null,
  ].filter(Boolean);
  return candidates[0] || 'gpt-5.5';
}

function defaultAnthropicModel() {
  const candidates = [
    isAnthropicModel(process.env.AI_ORCHESTRATOR_MODEL) ? process.env.AI_ORCHESTRATOR_MODEL : null,
    isAnthropicModel(process.env.AI_MODEL) ? process.env.AI_MODEL : null,
  ].filter(Boolean);
  return candidates[0] || 'claude-haiku-4-5-20251001';
}

function buildClient(provider = defaultProvider()) {
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const err = new Error('OPENAI_API_KEY nao configurada');
      err.code = 'NO_API_KEY';
      throw err;
    }
    return { provider, apiKey: key };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY nao configurada');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return { provider: 'anthropic', client: new Anthropic({ apiKey: key }) };
}

function defaultModel(provider = defaultProvider()) {
  return provider === 'openai' ? defaultOpenAIModel() : defaultAnthropicModel();
}

function defaultPriceForModel(provider, model) {
  const m = String(model || '').toLowerCase();
  if (provider === 'openai') {
    if (m.startsWith('gpt-5.5')) return { input: 1.75, output: 14 };
    if (m.startsWith('gpt-5.2')) return { input: 1.75, output: 14 };
    if (m.startsWith('gpt-5.1') || m === 'gpt-5' || m.startsWith('gpt-5-')) return { input: 1.25, output: 10 };
    if (m.startsWith('gpt-5-mini')) return { input: 0.25, output: 2 };
    if (m.startsWith('gpt-5-nano')) return { input: 0.05, output: 0.4 };
  }
  return { input: 1, output: 5 };
}

function normalizeUsage(provider, usage) {
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  if (provider === 'openai') {
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  }
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
  };
}

function computeCostBRL(usage, { provider = defaultProvider(), model = defaultModel(provider) } = {}) {
  const defaults = defaultPriceForModel(provider, model);
  const inM = parseFloat(
    process.env.AI_PRICE_INPUT_PER_1M
    || (provider === 'openai' ? process.env.OPENAI_PRICE_INPUT_PER_1M : '')
    || String(defaults.input)
  );
  const outM = parseFloat(
    process.env.AI_PRICE_OUTPUT_PER_1M
    || (provider === 'openai' ? process.env.OPENAI_PRICE_OUTPUT_PER_1M : '')
    || String(defaults.output)
  );
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const { inputTokens: inT, outputTokens: outT } = normalizeUsage(provider, usage);
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { usd, brl: usd * brl, inT, outT, provider, model };
}

function extractAnthropicText(resp) {
  const blocks = resp?.content || [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function extractOpenAIText(resp) {
  if (typeof resp?.output_text === 'string') return resp.output_text.trim();
  const out = [];
  for (const item of resp?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === 'string') out.push(c.text);
      if (typeof c?.output_text === 'string') out.push(c.output_text);
    }
  }
  return out.join('\n').trim();
}

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
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

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

function extractFirstValidJSON(raw) {
  const first = String(raw || '').search(/[{\[]/);
  if (first >= 0 && raw[first] === '{' && !balancedFrom(raw, first)) {
    return null;
  }

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '{' && c !== '[') continue;
    const candidate = balancedFrom(raw, i);
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch (_) { /* keep scanning */ }
    try { return JSON.parse(stripTrailingCommas(candidate)); } catch (_) { /* keep scanning */ }
  }
  return null;
}

function tryParseJSON(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();

  try { return JSON.parse(trimmed); } catch (_) { /* keep trying */ }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const fenced = fence && fence[1] ? fence[1].trim() : null;
  if (fenced) {
    try { return JSON.parse(fenced); } catch (_) { /* keep trying */ }
  }

  for (const src of [fenced, trimmed]) {
    if (!src) continue;
    const parsed = extractFirstValidJSON(src);
    if (parsed !== null) return parsed;
  }

  try { return JSON.parse(stripTrailingCommas(trimmed)); } catch (_) { /* give up */ }
  return null;
}

async function callOpenAI({
  built,
  selectedModel,
  finalSystem,
  userPrompt,
  jsonMode,
  jsonSchema,
  maxTokens,
  temperature,
  reasoningEffort,
}) {
  const format = jsonMode
    ? {
        type: 'json_schema',
        name: jsonSchema?.name || 'agent_response',
        strict: false,
        schema: jsonSchema?.schema || { type: 'object', additionalProperties: true },
      }
    : { type: 'text' };

  const requestBody = {
    model: selectedModel,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: finalSystem }] },
      { role: 'user', content: [{ type: 'input_text', text: userPrompt }] },
    ],
    max_output_tokens: maxTokens,
    text: {
      format,
      verbosity: process.env.OPENAI_VERBOSITY || 'medium',
    },
  };

  const effort = reasoningEffort || process.env.OPENAI_REASONING_EFFORT || process.env.AI_REASONING_EFFORT;
  if (effort) requestBody.reasoning = { effort };
  if (typeof temperature === 'number') requestBody.temperature = temperature;

  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${built.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errJson = await resp.json();
      detail = errJson?.error?.message || JSON.stringify(errJson).slice(0, 500);
    } catch (_) {
      detail = await resp.text();
    }
    throw new Error(`OpenAI ${resp.status}: ${detail}`);
  }

  return resp.json();
}

async function callAnthropic({ built, requestBody }) {
  return built.client.messages.create(requestBody);
}

/**
 * callAI - chamada padronizada ao modelo.
 *
 * @returns {Promise<{ok: boolean, json: any|null, text: string, usage: object, cost: object, error: string|null}>}
 */
async function callAI({
  systemPrompt,
  userPrompt,
  jsonMode = true,
  maxTokens = 1200,
  temperature,
  model,
  provider,
  reasoningEffort,
  jsonSchema,
} = {}) {
  if (!systemPrompt || !userPrompt) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: { usd: 0, brl: 0, inT: 0, outT: 0 },
      error: 'systemPrompt e userPrompt sao obrigatorios',
    };
  }

  const selectedProvider = provider || defaultProvider();
  const selectedModel = model || defaultModel(selectedProvider);
  let built;
  try {
    built = buildClient(selectedProvider);
  } catch (err) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: { usd: 0, brl: 0, inT: 0, outT: 0, provider: selectedProvider, model: selectedModel },
      provider: selectedProvider,
      model: selectedModel,
      error: err.message || 'Falha ao inicializar cliente IA',
    };
  }

  const finalSystem = jsonMode
    ? systemPrompt
      + '\n\nIMPORTANTE: Responda APENAS com JSON valido, sem markdown e sem texto antes ou depois. '
      + 'O JSON deve seguir exatamente o formato pedido pelo prompt do usuario.'
    : systemPrompt;

  try {
    if (selectedProvider === 'openai') {
      const resp = await callOpenAI({
        built,
        selectedModel,
        finalSystem,
        userPrompt,
        jsonMode,
        jsonSchema,
        maxTokens,
        temperature,
        reasoningEffort,
      });
      const text = extractOpenAIText(resp);
      const usage = resp?.usage || null;
      const cost = computeCostBRL(usage, { provider: 'openai', model: selectedModel });

      if (jsonMode) {
        const parsed = tryParseJSON(text);
        if (!parsed || Array.isArray(parsed)) {
          return {
            ok: false,
            json: null,
            text,
            usage,
            cost,
            provider: 'openai',
            model: selectedModel,
            error: Array.isArray(parsed)
              ? 'Resposta da IA veio como array, mas o contrato exige objeto JSON'
              : 'Resposta da IA nao pode ser parseada como JSON',
          };
        }
        return { ok: true, json: parsed, text, usage, cost, provider: 'openai', model: selectedModel, error: null };
      }

      return { ok: true, json: null, text, usage, cost, provider: 'openai', model: selectedModel, error: null };
    }

    const requestBody = {
      model: selectedModel,
      max_tokens: maxTokens,
      system: finalSystem,
      messages: [{ role: 'user', content: userPrompt }],
    };
    if (typeof temperature === 'number') requestBody.temperature = temperature;

    const resp = await callAnthropic({ built, requestBody });
    const text = extractAnthropicText(resp);
    const usage = resp?.usage || null;
    const cost = computeCostBRL(usage, { provider: 'anthropic', model: selectedModel });

    if (jsonMode) {
      const parsed = tryParseJSON(text);
      if (!parsed || Array.isArray(parsed)) {
        return {
          ok: false,
          json: null,
          text,
          usage,
          cost,
          provider: 'anthropic',
          model: selectedModel,
          error: Array.isArray(parsed)
            ? 'Resposta da IA veio como array, mas o contrato exige objeto JSON'
            : 'Resposta da IA nao pode ser parseada como JSON',
        };
      }
      return { ok: true, json: parsed, text, usage, cost, provider: 'anthropic', model: selectedModel, error: null };
    }

    return { ok: true, json: null, text, usage, cost, provider: 'anthropic', model: selectedModel, error: null };
  } catch (err) {
    return {
      ok: false,
      json: null,
      text: '',
      usage: null,
      cost: computeCostBRL(null, { provider: selectedProvider, model: selectedModel }),
      provider: selectedProvider,
      model: selectedModel,
      error: err?.message || 'Erro desconhecido ao chamar IA',
    };
  }
}

module.exports = {
  callAI,
  buildClient,
  defaultModel,
  defaultProvider,
  computeCostBRL,
  tryParseJSON,
};
