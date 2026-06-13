// =====================================================================
// BRASIL-INTEL — orquestrador de inteligência de mídia internacional
// =====================================================================
// Cria 1 agente-tema por FRONT (país/região). Cada agente usa a BUSCA WEB
// nativa do Claude pra achar o que falam do Brasil na Copa naquele país,
// com foco no que a imprensa BR não valoriza. Depois um agente sintetizador
// (Opus) dedupe, ranqueia o "ouro gringo" e gera o briefing + pautas.
//
// Usa a chave ANTHROPIC_API_KEY (já no .env). Sem Serper, sem navegador.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { tryParseJSON } = require('../ai-client');
const { FRONTS } = require('./fronts');

const SCOUT_MODEL = process.env.INTEL_SCOUT_MODEL || 'claude-sonnet-4-6';
const SYNTH_MODEL = process.env.INTEL_SYNTH_MODEL || 'claude-opus-4-8';
const WEB_SEARCH_TOOL = { type: 'web_search_20260209', name: 'web_search', max_uses: 6 };

function client() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const e = new Error('ANTHROPIC_API_KEY não configurada');
    e.code = 'NO_API_KEY';
    throw e;
  }
  return new Anthropic({ apiKey });
}

function textOf(msg) {
  return (msg?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// roda uma chamada com web_search server-side, continuando em pause_turn
async function runWithSearch(c, { model, system, userText, maxTokens = 3500, maxHops = 4 }) {
  const messages = [{ role: 'user', content: userText }];
  let last = null;
  for (let hop = 0; hop < maxHops; hop++) {
    last = await c.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools: [WEB_SEARCH_TOOL],
      messages,
    });
    if (last.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: last.content });
      continue; // servidor retoma a busca
    }
    break;
  }
  return last;
}

const SCOUT_SYSTEM = (front, hoje) => `Você é um analista de inteligência de mídia esportiva de uma marca brasileira (Sports & Tennis, de João Pessoa/PB). Hoje é ${hoje}, em plena Copa do Mundo 2026.

Sua FRENTE: ${front.label} (idioma ${front.lang}). Veículos típicos: ${front.outlets.join(', ')}.
Foco: ${front.focus}.

MISSÃO: usando a busca web, encontre o que a imprensa/torcida DESTE país está dizendo AGORA sobre o Brasil / a Seleção Brasileira na Copa — priorizando ângulos, elogios, análises, provocações ou curiosidades que a IMPRENSA BRASILEIRA NÃO está valorizando. É de fora que vêm as grandes sacadas.

REGRAS DURAS:
- SÓ FATO COM FONTE. Toda descoberta precisa de uma URL real e datada. Se não achar fonte, NÃO inclua.
- Traduza/explique o ângulo estrangeiro em PORTUGUÊS claro.
- Prefira o RECENTE (últimos dias / Copa 2026). Ignore matéria velha.
- Nada de inventar manchete. Cite o veículo real.

Faça de 3 a 6 buscas e retorne SOMENTE um array JSON (sem markdown, sem texto antes/depois), cada item:
{
 "manchete_original": "título/ângulo como saiu lá fora",
 "veiculo": "nome do veículo",
 "url": "link real",
 "data": "AAAA-MM-DD ou aprox",
 "idioma": "${front.lang}",
 "angulo_pt": "o que estão dizendo, explicado em português",
 "por_que_subvalorizado": "por que a mídia BR não está dando bola pra isso",
 "forca": 1-10,
 "ideia_post": "ideia curta de post pro @sportsetennis usando esse ângulo (voz: O Reinado é da Massa)"
}
Se não achar nada relevante, retorne [].`;

async function scoutFront(c, front, hoje) {
  try {
    const msg = await runWithSearch(c, {
      model: SCOUT_MODEL,
      system: SCOUT_SYSTEM(front, hoje),
      userText: `Pesquise agora o que ${front.label} está falando sobre o Brasil na Copa do Mundo 2026. Retorne o array JSON.`,
    });
    const parsed = tryParseJSON(textOf(msg));
    const items = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.itens) ? parsed.itens : []);
    return { front: front.id, label: front.label, ok: true, items, usage: msg?.usage || null };
  } catch (err) {
    return { front: front.id, label: front.label, ok: false, items: [], error: err.message };
  }
}

// pool de concorrência simples
async function pool(items, size, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const SYNTH_SYSTEM = (hoje) => `Você é o editor-chefe de inteligência da Sports & Tennis (@sportsetennis), em plena Copa do Mundo 2026 (hoje ${hoje}). Recebeu achados de agentes que vasculharam a imprensa estrangeira sobre o Brasil.

Sua tarefa: produzir um BRIEFING DIÁRIO em português, afiado e acionável, que vire pauta. Regras:
- SÓ FATO COM FONTE — mantenha a URL em cada item. Descarte o que vier sem fonte.
- Priorize o "OURO GRINGO": ângulos fortes que a mídia BR não está explorando.
- Dedupe (o mesmo assunto vindo de vários países vira 1 item com as fontes juntas).
- Voz da marca quando sugerir post: "O Reinado é da Massa" (futebol do povo brasileiro), verde-e-amarelo, sem citar FIFA como promo, sem clipe de transmissão.

Formato de saída (markdown):
# 🌍 BRASIL VISTO DE FORA — Briefing ${hoje}
## 🏆 TOP 5 OURO GRINGO (o que o Brasil não está vendo)
(para cada: título forte · o que é · por que importa · fonte(s) com link · ideia de post)
## 🌎 Por frente (resumo de 1-2 linhas por país com link)
## 🎯 3 pautas prontas pra hoje (post + legenda curta)
## ⚠️ Conferir antes de publicar (claims que precisam de 2ª fonte)`;

async function synthesize(c, allItems, hoje) {
  const payload = JSON.stringify(allItems, null, 1).slice(0, 120000);
  const msg = await c.messages.create({
    model: SYNTH_MODEL,
    max_tokens: 8000,
    system: SYNTH_SYSTEM(hoje),
    messages: [{ role: 'user', content: `Achados dos agentes (JSON):\n\n${payload}\n\nProduza o briefing.` }],
  });
  return { text: textOf(msg), usage: msg?.usage || null };
}

async function runBrasilIntel({ fronts = FRONTS, concurrency = 4, hoje = null } = {}) {
  const c = client();
  const today = hoje || new Date().toISOString().slice(0, 10);
  const t0 = Date.now();

  const scouted = await pool(fronts, concurrency, (f) => scoutFront(c, f, today));
  const allItems = [];
  for (const s of scouted) {
    for (const it of s.items) allItems.push({ ...it, _front: s.label });
  }

  let briefing = '# 🌍 BRASIL VISTO DE FORA\n\n(Nenhum achado com fonte hoje.)';
  let synthUsage = null;
  if (allItems.length) {
    const syn = await synthesize(c, allItems, today);
    briefing = syn.text;
    synthUsage = syn.usage;
  }

  return {
    date: today,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    fronts: scouted.map((s) => ({ front: s.front, label: s.label, ok: s.ok, found: s.items.length, error: s.error || null })),
    totalItems: allItems.length,
    items: allItems,
    briefing,
    usage: { synth: synthUsage },
  };
}

module.exports = { runBrasilIntel, scoutFront, FRONTS };
