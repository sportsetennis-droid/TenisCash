// =====================================================================
// LOOP DE MARKETING — ciclo fechado, cérebro = AGENTE CLAUDE (Opus).
// =====================================================================
// O dono pediu (2026-06-16): "engenharia de loop pra cuidar do marketing",
// escopo = CONTEÚDO ORGÂNICO, cérebro = agente Claude total (decide e aprende).
//
// Estações:  1 PAUTA (runBrain) -> 2 CRIA -> 3 CHECA -> 4 APROVA (você) ->
//            5 PUBLICA -> 6 MEDE (recordMetrics) -> APRENDE (runLearn) -> volta pra 1.
// A seta 6->1 é o que fecha o loop: o que performou ontem decide a pauta de hoje.
//
// Estado vive no Config (SEM migração de schema): key 'marketing_loop_state'
//   { posts:[{...,metrics}], learnings:'', learningsDetail:{top,evitar}, ... }
// A pauta enriquecida do brain vai em key 'marketing_loop_slate' (não mexe no
// 'daily_slate' que a Agência atual já consome).
//
// REGRAS DURAS herdadas: SÓ FATO; NUNCA inventar tecnologia/benefício de produto
// (vem do dado real do catálogo, senão vai em fato_a_verificar); skin nunca repete.
// =====================================================================
const { prisma } = require('../middleware');
const { callAI } = require('../ai/ai-client');
const { LOJAS } = require('./dailySlate');

const BRAIN_MODEL = process.env.MARKETING_BRAIN_MODEL || 'claude-opus-4-8';
const FALLBACK_MODEL = 'claude-sonnet-4-6'; // se o opus não estiver liberado na conta de prod
const STATE_KEY = 'marketing_loop_state';
const SLATE_KEY = 'marketing_loop_slate';
// Grid de vozes da marca (ElevenLabs). A OFICIAL o dono escolhe; até lá o brain rotaciona.
const VOICES = ['Brian', 'George', 'Daniel', 'Liam', 'Sarah', 'Charlotte', 'Aria'];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function brl(v) { return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function cleanName(brand, name) {
  return (String(brand || '') + ' ' + String(name || ''))
    .replace(/REF:.*?-\s*/, '').replace(/\bCHUTEIRA\b/i, '').replace(/\b\d{2}\/\d{2}\b/g, '')
    .replace(/[\s-]*\b\d{4,}\b\s*$/, '').replace(/\s+/g, ' ').trim();
}
// specs REAIS do produto (pra "destrinchar" sem inventar). Só o que está no catálogo.
function realSpecs(p) {
  const ai = p.aiContext && typeof p.aiContext === 'object' ? p.aiContext : {};
  return String(p.shortDescription || ai.description || ai.specs || ai.tech || '').slice(0, 160).trim();
}

// Chama a IA do cérebro SEMPRE no Anthropic (prod tem OPENAI_API_KEY → o
// defaultProvider seria 'openai' e mandaria o modelo claude pro endpoint errado
// = 0 itens silenciosos). Fallback de modelo se o opus não estiver na conta.
async function callBrain(sys, up, maxTokens) {
  let r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens, model: BRAIN_MODEL, provider: 'anthropic' });
  if (!r.ok || !r.json) {
    r = await callAI({ systemPrompt: sys, userPrompt: up, jsonMode: true, maxTokens, model: FALLBACK_MODEL, provider: 'anthropic' });
  }
  return r;
}

// ---------------------------------------------------------------------
// Estado do loop (Config JSON)
// ---------------------------------------------------------------------
async function getLoopState() {
  const row = await prisma.config.findUnique({ where: { key: STATE_KEY } });
  const base = { posts: [], learnings: '', learningsDetail: { top: [], evitar: [] }, learningsUpdatedAt: null, lastBrainAt: null };
  if (!row) return base;
  try { return Object.assign(base, JSON.parse(row.value)); } catch { return base; }
}
async function saveLoopState(state) {
  await prisma.config.upsert({
    where: { key: STATE_KEY },
    create: { id: STATE_KEY, key: STATE_KEY, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
  return state;
}

// ---------------------------------------------------------------------
// Estoque REAL por loja, COM specs (pra grounding anti-alucinação)
// ---------------------------------------------------------------------
async function topStockRich(lojaName) {
  const store = await prisma.store.findFirst({ where: { name: { contains: lojaName }, active: true }, select: { id: true } });
  if (!store) return [];
  return prisma.$queryRawUnsafe(`
    SELECT p.id, p.brand, p.name, p.price, p."imageUrl", p."shortDescription", p."aiContext"
    FROM "StoreStock" ss
    JOIN "ProductSize" psz ON psz.id = ss."productSizeId"
    JOIN "Product" p ON p.id = psz."productId"
    WHERE ss."storeId" = $1 AND ss.stock > 0 AND p.active = true AND p."imageUrl" IS NOT NULL AND p.price > 0
    GROUP BY p.id HAVING SUM(ss.stock) >= 2 ORDER BY SUM(ss.stock) DESC LIMIT 14`, store.id);
}

// ---------------------------------------------------------------------
// ESTAÇÃO 1 — PAUTA: o cérebro decide lendo o APRENDIZADO + estoque real
// ---------------------------------------------------------------------
async function brainDecideLoja(l, stock, state, hoje, ctx) {
  const sys = `Você é o CÉREBRO de marketing da Sports & Tennis — a melhor IA decidindo a pauta pra CRESCER ALCANCE orgânico no Instagram/TikTok, respeitando o DNA da conta. `
    + `REGRAS DURAS: SÓ FATO (preço/spec não confirmado vai em "fato_a_verificar", a copy não crava). `
    + `NUNCA invente tecnologia/benefício de produto — use SOMENTE as specs reais passadas; o que não vier, vai em fato_a_verificar. `
    + `Cada post tem uma SKIN visual DIFERENTE (nunca repete). Alcance orgânico vem de emoção/gancho de 1,5s/conteúdo que dá vontade de SALVAR e ENVIAR — não de anúncio de produto seco.`;
  const aprend = state.learnings
    ? `APRENDIZADO REAL (priorize o que já cresceu, evite o que morreu):\n${state.learnings}`
      + ((state.learningsDetail && state.learningsDetail.evitar && state.learningsDetail.evitar.length) ? `\nEVITAR: ${state.learningsDetail.evitar.join('; ')}` : '')
    : 'Ainda SEM histórico de performance — comece variado (voz/skin/formato/horário diferentes) e marque tudo pra medir.';
  const lista = stock.map((s, i) => {
    const sp = realSpecs(s);
    return `${i + 1}. ${cleanName(s.brand, s.name)} — ${brl(s.price)}${sp ? ` | specs reais: ${sp}` : ' | (sem specs no catálogo — NÃO invente)'}`;
  }).join('\n');
  const up = `Conta ${l.handle} [DNA: ${l.dna}]. Data ${hoje}.${ctx ? ` Contexto de hoje: ${ctx}.` : ''}
${aprend}

Estoque REAL da loja (idx exato, nome, preço, specs conhecidas):
${lista}

Monte de 3 a 4 posts pra hoje pra crescer alcance. Para CADA post decida:
- idx (produto exato do estoque) OU tema sem produto (idx 0)
- gancho (frase de 1,5–3s que prende)
- pra_quem (público/ocasião)
- resolve (benefício REAL — só do que as specs dizem; nada inventado)
- voz (uma de: ${VOICES.join(', ')})
- skin (conceito visual ÚNICO, diferente dos outros)
- formato (reel | story | carrossel)
- horario (HH:MM — melhor janela segundo o aprendizado)
- porque (1 linha: por que essa decisão, citando o aprendizado quando houver)
- fato_a_verificar (lista do que precisa conferir antes de publicar)
JSON: {"posts":[{"idx":N,"gancho":"","pra_quem":"","resolve":"","voz":"","skin":"","formato":"reel","horario":"18:00","porque":"","fato_a_verificar":[]}]}`;
  let r = await callBrain(sys, up, 2400);
  let posts = r.ok && r.json ? (r.json.posts || []) : [];
  if (!posts.length && r.ok && r.json) { // veio ok mas vazio — retry 1x
    r = await callBrain(sys, up, 2400);
    posts = r.ok && r.json ? (r.json.posts || []) : [];
  }
  if (!r.ok) throw new Error('IA falhou: ' + (r.error || 'sem resposta') + ' (provider=' + (r.provider || '?') + ' model=' + (r.model || '?') + ')');
  const seen = new Set();
  return posts.slice(0, 4).map((p) => {
    let s = Number(p.idx) > 0 ? stock[Number(p.idx) - 1] : null;
    if (s && seen.has(s.id)) return null;
    if (s) seen.add(s.id);
    return {
      tipo: s ? 'produto' : 'tema',
      produtoId: s ? s.id : null,
      produto: s ? cleanName(s.brand, s.name) : null,
      preco: s ? brl(s.price) : null,
      imageUrl: s ? s.imageUrl : null,
      specs: s ? realSpecs(s) : '',
      gancho: p.gancho || '', pra_quem: p.pra_quem || '', resolve: p.resolve || '',
      voz: p.voz || '', skin: p.skin || '', formato: p.formato || 'reel', horario: p.horario || '',
      porque: p.porque || '', fato_a_verificar: p.fato_a_verificar || [],
    };
  }).filter(Boolean);
}

async function runBrain({ date, ctx } = {}) {
  const hoje = date || new Date().toISOString().slice(0, 10);
  const state = await getLoopState();
  const slate = { data: hoje, generatedAt: new Date().toISOString(), brain: BRAIN_MODEL, usouAprendizado: !!state.learnings, itens: [], errors: [] };
  for (const l of LOJAS) {
    try {
      const stock = await topStockRich(l.loja);
      if (!stock.length) { slate.errors.push(`${l.handle}: sem estoque elegível`); continue; }
      const itens = await brainDecideLoja(l, stock, state, hoje, ctx);
      itens.forEach((it) => slate.itens.push({ conta: l.handle, loja: l.loja, palette: l.palette, ...it }));
    } catch (e) {
      slate.errors.push(`${l.handle}: ${e.message}`);
    }
  }
  slate.total = slate.itens.length;
  await prisma.config.upsert({
    where: { key: SLATE_KEY },
    create: { id: SLATE_KEY, key: SLATE_KEY, value: JSON.stringify(slate) },
    update: { value: JSON.stringify(slate) },
  });
  state.lastBrainAt = slate.generatedAt;
  await saveLoopState(state);
  return slate;
}

// ---------------------------------------------------------------------
// ESTAÇÃO 4/5 — registra um post PUBLICADO (pra medir depois)
// ---------------------------------------------------------------------
async function recordPublishedPost(post) {
  const state = await getLoopState();
  const id = post.id || ('p_' + Date.now() + '_' + Math.floor(state.posts.length));
  const rec = {
    id,
    conta: post.conta || null, loja: post.loja || null,
    tipo: post.tipo || 'produto', tema: post.tema || null,
    produtoId: post.produtoId || null, produto: post.produto || null,
    voz: post.voz || null, skin: post.skin || null, formato: post.formato || 'reel',
    horario: post.horario || null, igMediaId: post.igMediaId || null, caption: post.caption || null,
    publishedAt: post.publishedAt || new Date().toISOString(),
    metrics: null,
  };
  state.posts.unshift(rec);
  state.posts = state.posts.slice(0, 500); // cap
  await saveLoopState(state);
  return rec;
}

// ---------------------------------------------------------------------
// ESTAÇÃO 6 — MEDE: intake de métricas (manual hoje; IG API quando liberar)
// ---------------------------------------------------------------------
async function recordMetrics({ postId, plays, reach, likes, saves, shares, comments, source }) {
  const state = await getLoopState();
  const p = state.posts.find((x) => x.id === postId || x.igMediaId === postId);
  if (!p) throw new Error('post não encontrado: ' + postId);
  p.metrics = {
    plays: num(plays), reach: num(reach), likes: num(likes),
    saves: num(saves), shares: num(shares), comments: num(comments),
    source: source || 'manual', collectedAt: new Date().toISOString(),
  };
  await saveLoopState(state);
  return p;
}

// ---------------------------------------------------------------------
// ESTAÇÃO 6 -> 1 — APRENDE: lê posts medidos e atualiza o aprendizado
// ---------------------------------------------------------------------
async function runLearn() {
  const state = await getLoopState();
  const measured = state.posts.filter((p) => p.metrics);
  if (measured.length < 3) {
    return { ok: false, reason: `poucos posts medidos (${measured.length}); precisa de ao menos 3 com métrica`, learnings: state.learnings };
  }
  const rows = measured.slice(0, 80).map((p) => `- ${p.conta || '?'} | ${p.tipo}${p.tema ? (' ' + p.tema) : (p.produto ? (' ' + p.produto) : '')} | voz:${p.voz || '-'} | skin:${p.skin || '-'} | fmt:${p.formato} | hora:${p.horario || '-'} => plays:${p.metrics.plays} alcance:${p.metrics.reach} saves:${p.metrics.saves} shares:${p.metrics.shares} likes:${p.metrics.likes}`).join('\n');
  const sys = 'Você é o cérebro de performance de conteúdo da Sports & Tennis. Aprende com DADOS REAIS o que cresce ALCANCE orgânico no IG/TikTok. SÓ conclua o que os dados sustentam — nunca invente. Saves e shares (envios no DM) são o sinal nº1 de alcance; taxa de conclusão também conta muito. Anúncio de produto seco morre no orgânico.';
  const up = `APRENDIZADO ATUAL:\n${state.learnings || '(vazio)'}\n\nPOSTS MEDIDOS (reais):\n${rows}\n\nAtualize o APRENDIZADO: o que está crescendo alcance e o que está morrendo — por conta/tema/voz/skin/formato/horário. Específico e acionável (ex: "voz Daniel + corrida + 18h rende 3x saves"; "anúncio de preço no master morre"). JSON: {"learnings":"texto curto e acionável em bullets","top_padroes":["..."],"evitar":["..."]}`;
  const r = await callBrain(sys, up, 1600);
  if (r.ok && r.json && r.json.learnings) {
    state.learnings = r.json.learnings;
    state.learningsDetail = { top: r.json.top_padroes || [], evitar: r.json.evitar || [] };
    state.learningsUpdatedAt = new Date().toISOString();
    await saveLoopState(state);
  }
  return { ok: true, learnings: state.learnings, detail: state.learningsDetail, measuredCount: measured.length };
}

async function getLoopSlate() {
  const row = await prisma.config.findUnique({ where: { key: SLATE_KEY } });
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

module.exports = {
  runBrain, runLearn, recordPublishedPost, recordMetrics,
  getLoopState, saveLoopState, getLoopSlate,
  STATE_KEY, SLATE_KEY, VOICES, BRAIN_MODEL,
};
