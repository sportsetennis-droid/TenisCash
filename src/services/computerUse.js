// =====================================================================
// Computer Use — Claude controla um browser/SO virtual pra automatizar
// tarefas que NÃO têm API (ex: editar tema visual da Nuvemshop).
// =====================================================================
// Requer beta header: anthropic-beta: computer-use-2025-04-29
// Usa o tool 'computer' do modelo Claude Sonnet 4 ou Opus.
// =====================================================================
// IMPORTANTE: pra executar de verdade as ações do Claude (mover mouse,
// clicar, digitar), precisa de um ambiente onde os comandos são
// rodados — tipicamente uma VM ou docker rodando o agent loop.
// Esse wrapper SÓ DECIDE as ações; quem executa é separado.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_COMPUTER_MODEL || 'claude-sonnet-4-5-20251029';

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function _client() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': 'computer-use-2025-04-29' },
  });
}

/**
 * Inicia uma sessão Computer Use. Devolve a próxima ação que o Claude
 * quer fazer (clique, digitação, screenshot etc).
 * Quem executa as ações é o caller (ex: Playwright, Puppeteer, etc).
 *
 * @param {Object} opts
 * @param {string} opts.task          - descrição da tarefa em PT-BR
 * @param {Array}  [opts.history]     - mensagens anteriores (pra continuar sessão)
 * @param {Object} [opts.displaySize] - { width, height }, default 1280x800
 */
async function nextAction({ task, history = [], displaySize = { width: 1280, height: 800 } }) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  try {
    const client = _client();
    const messages = history.length
      ? history
      : [{ role: 'user', content: task }];

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools: [
        {
          type: 'computer_20250124',
          name: 'computer',
          display_width_px: displaySize.width,
          display_height_px: displaySize.height,
          display_number: 1,
        },
      ],
      messages,
    });

    // Extrai a próxima ação do Claude
    const toolUse = (resp.content || []).find((b) => b.type === 'tool_use' && b.name === 'computer');
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

    return {
      ok: true,
      action: toolUse ? toolUse.input : null,
      toolUseId: toolUse?.id || null,
      reasoning: text,
      stopReason: resp.stop_reason,
      usage: resp.usage,
      raw: resp.content,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Submete resultado de uma ação (geralmente um screenshot depois do clique)
 * e pega a próxima ação.
 */
async function submitToolResult({ history, toolUseId, screenshotBase64, output }) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const newHistory = [
    ...history,
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: screenshotBase64
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 } }]
            : (output || 'done'),
        },
      ],
    },
  ];
  return nextAction({ task: '', history: newHistory });
}

module.exports = { isConfigured, nextAction, submitToolResult };
