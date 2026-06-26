// =====================================================================
// Intent Rater — SSR-inspired (Semantic Similarity Rating)
// Classifica intenção de compra do cliente em cada turno da conversa.
// Inspirado no paper "LLMs Reproduce Human Purchase Intent via SSR"
// (pymc-labs/semantic-similarity-rating). Adaptação Node.js com Claude.
//
// Escala Likert 1-5:
//   1 = Só curiosidade / olhando
//   2 = Interesse leve
//   3 = Interessado (buscou produto, perguntou tamanho/preço)
//   4 = Quente (perguntou disponibilidade, onde comprar, prazo)
//   5 = Pronto pra comprar (pediu valor final, forma de pagamento, link)
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

// Usa haiku: barato, rápido, só classifica (não atende cliente).
const RATER_MODEL = process.env.INTENT_RATER_MODEL || 'claude-haiku-4-5-20251001';

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Referências SSR por ponto da escala (âncoras semânticas)
const ANCHORS = [
  'O cliente só está olhando, sem produto específico em mente, pergunta genérica.',
  'O cliente tem interesse leve, mencionou uma categoria ou marca mas sem urgência.',
  'O cliente está interessado: perguntou sobre modelo específico, tamanho ou preço.',
  'O cliente está quente: perguntou disponibilidade em loja, como comprar ou prazo.',
  'O cliente está pronto pra comprar: pediu valor final, forma de pagamento ou link direto.',
];

const SYSTEM = `Você classifica intenção de compra de clientes em conversas de WhatsApp de uma loja de tênis.
Leia o histórico e responda EXATAMENTE neste JSON (sem texto fora):
{"score": <1-5>, "signal": "<motivo em até 10 palavras>", "produto": "<produto mencionado ou null>"}

Escala:
1 = ${ANCHORS[0]}
2 = ${ANCHORS[1]}
3 = ${ANCHORS[2]}
4 = ${ANCHORS[3]}
5 = ${ANCHORS[4]}

Seja conservador: só dê 5 se o cliente EXPLICITAMENTE pediu pra comprar.`;

async function rateIntent(messages) {
  const c = client();
  if (!c) return null;

  // Usa só as últimas 6 mensagens pra contexto relevante (barato)
  const recent = messages.slice(-6);
  const conversa = recent
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${String(m.content).slice(0, 200)}`)
    .join('\n');

  try {
    const resp = await c.messages.create({
      model: RATER_MODEL,
      max_tokens: 80,
      system: SYSTEM,
      messages: [{ role: 'user', content: conversa }],
    });
    const raw = (resp.content || []).map((b) => b.text || '').join('').trim();
    const parsed = JSON.parse(raw);
    if (typeof parsed.score !== 'number') return null;
    return {
      score: Math.max(1, Math.min(5, Math.round(parsed.score))),
      signal: parsed.signal || '',
      produto: parsed.produto || null,
    };
  } catch {
    return null;
  }
}

module.exports = { rateIntent, ANCHORS };
