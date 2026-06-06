// =====================================================================
// Motor de Catálogo — agentes que revisam o produto e montam um PLANO.
// =====================================================================
// Para cada produto roda 5 agentes (imagem, estoque, referência, mercado,
// classificação), calcula prontidão e grava o plano em aiContext.catalogPlan.
// O dono aprova → o motor executa (classificar / repreçar / juntar / publicar).
// Tudo server-side (usa Serper/Vision/Claude — chaves só no Railway).
// =====================================================================

const { prisma } = require('../middleware');
const serperWeb = require('./serperWebSearch');
const vision = require('./visionValidator');
const { callAI } = require('../ai/ai-client');
const { classifyByRules } = require('./catalogRules');

const ENGINE_V = 2;
// Por padrão o motor roda GRÁTIS (sem Vision/Serper/Claude). IA só se opts.useVision/useMarket.

function parseCtx(p) {
  try { return p.aiContext ? (typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext) : {}; }
  catch (_) { return {}; }
}
function nImagesOf(p) {
  let extra = 0;
  try { const arr = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : p.imageUrls; if (Array.isArray(arr)) extra = arr.length; } catch (_) {}
  return (p.imageUrl ? 1 : 0) + extra;
}
function isClassified(p, ctx) {
  const cl = (ctx.classification || {});
  return !!(p.category && p.category !== 'A CLASSIFICAR' && p.subcategory && cl.modality && cl.tier);
}

// ---- Agente ESTOQUE: comprado (NFe) vs localizado (bipe) ----
async function stockAgent(productId) {
  const sizes = await prisma.productSize.findMany({ where: { productId }, select: { id: true, stock: true } });
  const comprado = sizes.reduce((s, x) => s + (x.stock || 0), 0);
  const sizeIds = sizes.map((s) => s.id);
  let localizado = 0;
  if (sizeIds.length) {
    const ss = await prisma.storeStock.aggregate({ where: { productSizeId: { in: sizeIds } }, _sum: { stock: true } });
    localizado = ss._sum.stock || 0;
  }
  const pct = comprado > 0 ? Math.round((localizado / comprado) * 100) : 0;
  return { comprado, localizado, pct, gate: comprado > 0 && pct >= 80 };
}

// ---- Agente IMAGEM: tem foto? bate com o produto? >=6 fotos? ----
async function imageAgent(p, ctx, useVision = false) {
  const nImages = nImagesOf(p);
  const out = { hasImage: !!p.imageUrl, nImages, need6: nImages < 6, validated: false, visionScore: null, correct: null, reason: null };
  if (useVision && p.imageUrl && vision.isConfigured()) {
    try {
      const r = await vision.scoreImageMatch(p.imageUrl, { name: p.name, brand: p.brand, color: ctx.color, category: p.category });
      if (r && r.ok) { out.validated = true; out.visionScore = r.score; out.correct = r.score >= 7 && r.isCorrectProduct; out.reason = r.reason; }
    } catch (e) { out.reason = 'vision err: ' + e.message; }
  }
  out.ok = out.hasImage && (!out.validated || out.correct) && !out.need6;
  return out;
}

// ---- Agente REFERÊNCIA: cards do mesmo modelo separados (pra juntar) ----
async function refAgent(_p, _ctx) {
  // Agrupamento por MODELO desativado (dono: unificação só por REFERÊNCIA, 1 ref = 1 card).
  // Não sugere mais "juntar cards do mesmo modelo".
  return { modelGroup: null, siblingCount: 0, siblings: [], suggestMerge: false };
}

// ---- Agente MERCADO/PREÇO: pesquisa quanto vende + estratégia ----
async function marketAgent(p, useMarket = false) {
  const cost = p.costPrice || null; const ourPrice = p.price || null;
  const marginPct = (ourPrice && cost) ? Math.round(((ourPrice - cost) / ourPrice) * 100) : null;
  const out = { searched: false, sources: [], marketLow: null, marketHigh: null, ourPrice, costPrice: cost, marginPct, suggestedPrice: null, note: marginPct != null ? ('margem ' + marginPct + '%') : null };
  if (!useMarket || !serperWeb.isConfigured()) return out; // grátis: só margem do custo da NFe
  const q = [p.brand, (p.name || '').replace(/^REF:\s*[A-Z0-9]+\s*-\s*/i, '').slice(0, 50), 'preço'].filter(Boolean).join(' ');
  let results = [];
  try { const w = await serperWeb.searchWeb(q, { count: 6 }); if (w.ok) results = w.results || []; out.searched = true; } catch (_) {}
  out.sources = results.slice(0, 5).map((r) => ({ title: (r.title || '').slice(0, 80), url: r.url }));
  if (results.length && callAI) {
    try {
      const r = await callAI({
        systemPrompt: 'Você é analista de pricing de uma loja esportiva. A partir dos títulos de busca (lojas concorrentes), estime a FAIXA de preço de mercado em R$ e sugira um preço competitivo. Retorne SÓ JSON: {"marketLow":num,"marketHigh":num,"suggested":num,"note":"frase curta"}',
        userPrompt: `Produto: ${p.brand || ''} ${p.name || ''}\nNosso preço atual: R$ ${p.price || '?'}\nCusto: R$ ${p.costPrice || '?'}\nResultados de busca:\n${results.slice(0, 6).map((r) => '- ' + (r.title || '')).join('\n')}\nRetorne só o JSON.`,
        jsonMode: true, maxTokens: 200,
      });
      if (r && r.ok && r.json) { out.marketLow = r.json.marketLow ?? null; out.marketHigh = r.json.marketHigh ?? null; out.suggestedPrice = r.json.suggested ?? null; out.note = r.json.note || null; }
    } catch (_) {}
  }
  return out;
}

// ---- Agente CLASSIFICAÇÃO: SUGERE as 4 (não aplica — dono aprova) ----
const CAT = ['Calçados', 'Vestuário', 'Acessórios'];
const GEN = ['Homem', 'Mulher', 'Menino', 'Menina', 'Unissex'];
async function classifyAgent(p, ctx, alreadyClassified) {
  if (alreadyClassified) return { needed: false, suggestion: null };
  const c = classifyByRules(p); // REGRAS — zero IA, zero custo
  return { needed: true, suggestion: c.suggestion, source: 'rules', confidence: c.confidence, reason: c.reason };
}

// ---- ORQUESTRADOR: roda os 5 agentes e monta o plano de 1 produto ----
async function analyzeProduct(productId, opts = {}) {
  const p = await prisma.product.findUnique({ where: { id: productId } });
  if (!p) throw new Error('produto não encontrado');
  const ctx = parseCtx(p);
  const classified = isClassified(p, ctx);

  const [stock, image, ref, market, classif] = await Promise.all([
    stockAgent(p.id),
    imageAgent(p, ctx, opts.useVision),
    refAgent(p, ctx),
    marketAgent(p, opts.useMarket),
    classifyAgent(p, ctx, classified),
  ]);

  // prontidão (gate do dono: classif + imagem ok + estoque>=80%)
  const ready = classified && image.hasImage && stock.gate;
  let score = 0;
  score += classified ? 40 : (classif.suggestion ? 15 : 0);
  score += image.hasImage ? (image.need6 ? 18 : 30) : 0;
  score += stock.gate ? 30 : Math.round((stock.pct / 100) * 30);

  // ações recomendadas
  const actions = [];
  if (!classified) actions.push(classif.suggestion ? 'aprovar classificação sugerida' : 'classificar (manual)');
  if (!image.hasImage) actions.push('buscar imagem');
  else if (image.correct === false) actions.push('TROCAR imagem (Vision diz que está errada)');
  if (image.need6) actions.push(`buscar +${6 - image.nImages} fotos (tem ${image.nImages})`);
  if (!stock.gate) actions.push(`bipar estoque (localizado ${stock.pct}%)`);
  if (ref.suggestMerge) actions.push(`juntar ${ref.siblingCount} card(s) do mesmo modelo`);
  if (market.suggestedPrice && market.ourPrice && Math.abs(market.suggestedPrice - market.ourPrice) / market.ourPrice > 0.1) actions.push(`rever preço (atual R$${market.ourPrice} · mercado ~R$${market.suggestedPrice})`);
  if (ready) actions.unshift('PUBLICAR no Nuvemshop');

  const plan = {
    v: ENGINE_V, at: new Date().toISOString(),
    score: Math.min(100, score), ready,
    image, stock, ref, market,
    classification: { classified, suggestion: classif.suggestion, suggestionSource: classif.source || 'rules', confidence: classif.confidence },
    actions,
    status: 'draft',
  };

  ctx.catalogPlan = plan;
  await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
  return { productId: p.id, name: p.name, brand: p.brand, plan };
}

// ---- runBatch: pega N produtos prioritários e analisa ----
// mode: 'quase' (perto de pronto: tem imagem, falta classif/estoque) | 'sem-imagem' | 'all'
async function runBatch({ limit = 8, mode = 'quase', part = 0, of = 1 } = {}) {
  let where = `pr.active=true`;
  if (mode === 'quase') where += ` AND pr."imageUrl" IS NOT NULL`;
  else if (mode === 'sem-imagem') where += ` AND pr."imageUrl" IS NULL`;
  const ofN = Math.max(1, Number(of) || 1), partN = Math.max(0, Number(part) || 0);
  if (ofN > 1) where += ` AND (abs(hashtext(pr.id)) % ${ofN}) = ${partN}`; // partição p/ rodar paralelo sem colidir
  // prioriza quem ainda não tem plano OU plano antigo
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pr.id FROM "Product" pr
     WHERE ${where} AND (pr."aiContext"->'catalogPlan'->>'v' IS NULL OR (pr."aiContext"->'catalogPlan'->>'v')::int < ${ENGINE_V})
     ORDER BY pr.id LIMIT ${Math.min(30, Math.max(1, limit))}`);
  const results = [];
  for (const r of rows) {
    try { results.push(await analyzeProduct(r.id)); }
    catch (e) { results.push({ productId: r.id, error: e.message }); }
  }
  const ready = results.filter((x) => x.plan && x.plan.ready).length;
  return { processed: results.length, ready, results };
}

module.exports = { analyzeProduct, runBatch, stockAgent, imageAgent, marketAgent, classifyAgent, refAgent, ENGINE_V };
