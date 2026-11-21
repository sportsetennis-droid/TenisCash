// Cliente de IA com reserva (dono 18/11/2026: "assuma a máquina e faça vc").
// Mesma interface do SDK da Anthropic (client.messages.create). Tenta a Anthropic; se ela
// falhar (chave inválida, sem crédito, fora do ar), refaz a MESMA chamada na OpenAI,
// traduzindo texto, imagem e ferramentas (tool_use/tool_result) e devolvendo no formato
// da Anthropic. Assim o agente do vendedor, o gerente e a leitura de foto não param.
// Chave inválida (401/403) fica marcada por 10 min para não gastar tempo tentando de novo.

const Anthropic = require('@anthropic-ai/sdk');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DOWN_MS = 10 * 60 * 1000;
const CREDIT_DOWN_MS = 30 * 60 * 1000;
const state = { anthropicDownUntil: 0, lastAnthropicError: null, lastOpenAIError: null, lastOpenAIErrorAt: null, openaiCalls: 0, anthropicCalls: 0 };

function openaiModel() { return process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini'; }

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: Array.isArray(system) ? system.map((b) => b.text || '').join('\n') : String(system) });
  for (const m of messages || []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // usuário: resultados de ferramenta viram mensagens "tool"; texto/imagem viram conteúdo
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
      } else if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

async function openaiCreate(params) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('sem chave OpenAI');
  const body = {
    model: openaiModel(),
    max_tokens: params.max_tokens || 700,
    messages: toOpenAIMessages(params.system, params.messages),
  };
  if (Array.isArray(params.tools) && params.tools.length) {
    body.tools = params.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  }
  const res = await fetch(OPENAI_URL, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${(j.error && j.error.message) || ''}`.slice(0, 200));
  state.openaiCalls++;
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch (_) {}
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  return {
    content,
    stop_reason: (msg.tool_calls && msg.tool_calls.length) ? 'tool_use' : 'end_turn',
    usage: { input_tokens: (j.usage && j.usage.prompt_tokens) || 0, output_tokens: (j.usage && j.usage.completion_tokens) || 0 },
    provider: 'openai',
  };
}

function isAuthError(e) { const s = Number(e && (e.status || e.statusCode)); return s === 401 || s === 403; }
// Sem crédito (400 "credit balance is too low") não se resolve sozinho em segundos:
// marca a Anthropic como fora por 30 min e vai direto na reserva, sem esperar a recusa a cada mensagem.
function isCreditError(e) { return /credit balance|billing|insufficient.?quota/i.test(String((e && e.message) || '')); }

function resilientClient() {
  const akey = process.env.ANTHROPIC_API_KEY;
  const okey = process.env.OPENAI_API_KEY;
  if (!akey && !okey) return null;
  const anthropic = akey ? new Anthropic({ apiKey: akey }) : null;
  return {
    messages: {
      async create(params) {
        if (anthropic && Date.now() > state.anthropicDownUntil) {
          try {
            const r = await anthropic.messages.create(params);
            state.anthropicCalls++;
            return r;
          } catch (e) {
            state.lastAnthropicError = `${e.status || ''} ${String(e.message || '').slice(0, 120)}`.trim();
            if (!okey) throw e;
            if (isAuthError(e)) state.anthropicDownUntil = Date.now() + DOWN_MS;
            else if (isCreditError(e)) state.anthropicDownUntil = Date.now() + CREDIT_DOWN_MS;
            console.warn('[ia] Anthropic falhou, usando a reserva OpenAI:', state.lastAnthropicError);
          }
        }
        try {
          return await openaiCreate(params);
        } catch (e) {
          // Guarda o motivo para o /api/health mostrar por que a reserva também falhou.
          state.lastOpenAIError = String((e && e.message) || e).slice(0, 200);
          state.lastOpenAIErrorAt = new Date().toISOString();
          throw e;
        }
      },
    },
  };
}

function getAiState() {
  return { anthropic: !!process.env.ANTHROPIC_API_KEY, openaiReserva: !!process.env.OPENAI_API_KEY, anthropicForaAte: state.anthropicDownUntil > Date.now() ? new Date(state.anthropicDownUntil).toISOString() : null, ultimoErroAnthropic: state.lastAnthropicError, ultimoErroOpenAI: state.lastOpenAIError, ultimoErroOpenAIEm: state.lastOpenAIErrorAt, chamadasAnthropic: state.anthropicCalls, chamadasOpenAI: state.openaiCalls };
}

module.exports = { resilientClient, getAiState, toOpenAIMessages };
