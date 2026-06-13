// =====================================================================
// ORQUESTRADOR "Classificação de Card"
// Esteira: PRODUTO -> [Classificador] -> [Fotógrafo] -> [Designer] ->
//          [Auditor] -> [Publicador Nuvemshop] -> PRONTO
// Cada passo grava AgentEvent (log ao vivo) e atualiza AgentRun (contadores).
// Estado ao vivo (produto atual de cada agente) fica em memória (1 instância).
// Híbrido: roda por marca em lote, com pausar/retomar global.
// =====================================================================
const { PrismaClient } = require('@prisma/client');
const prisma = global._prismaOrch || (global._prismaOrch = new PrismaClient());
const Anthropic = require('@anthropic-ai/sdk');

let curador = null;
try { curador = require('./curationAgent'); } catch (_) {}
let nsHandlers = null;
try { nsHandlers = require('./nuvemshopHandlers'); } catch (_) {}

const AGENTES = ['classificador', 'fotografo', 'designer', 'auditor', 'publicador'];

// Estado em memória (1 processo): produto atual por agente + flags de controle
const STATE = {
  runId: null,
  brand: null,
  running: false,
  paused: false,
  atual: {}, // agente -> { productId, productName, desde }
};
function getState() { return STATE; }

const ctxOf = (p) => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function log(runId, agent, status, message, product) {
  try {
    await prisma.agentEvent.create({ data: { runId, agent, status, message: String(message).slice(0, 900), productId: product ? product.id : null, productName: product ? (product.name || '').slice(0, 90) : null } });
  } catch (_) {}
  if (agent !== 'orquestrador') STATE.atual[agent] = product ? { productId: product.id, productName: (product.name || '').slice(0, 60), status } : null;
}
async function bump(runId, field, by = 1) { try { await prisma.agentRun.update({ where: { id: runId }, data: { [field]: { increment: by } } }); } catch (_) {} }

function isFull(p) { const c = ctxOf(p); const cl = c.classification || {}; return !!(p.category && p.subcategory && cl.modality && cl.tier); }
function temFoto(p) { return !!(p.imageUrl && String(p.imageUrl).length > 10); }

// REGRA DO DONO: só mexe em produto BIPADO **E COM ESTOQUE** (Σ StoreStock > 0) —
// é a garantia de que o estoque está controlado/conferido E existe na loja agora.
// StoreStock só nasce de bipe; >0 cobre os dois (bipado + tem unidade). Zerou (vendeu) sai.
async function bipadoIds() {
  const rows = await prisma.storeStock.findMany({ where: { stock: { gt: 0 } }, select: { productSize: { select: { productId: true } } } });
  return new Set(rows.map((r) => r.productSize && r.productSize.productId).filter(Boolean));
}

// ---- marcas com produtos BIPADOS+COM ESTOQUE faltando classificação (pro seletor) ----
async function listBrands() {
  const bip = await bipadoIds();
  const prods = await prisma.product.findMany({ where: { active: true, id: { in: [...bip] } }, select: { brand: true, category: true, subcategory: true, aiContext: true } });
  const map = {};
  for (const p of prods) {
    const b = (p.brand || '(sem marca)').trim();
    map[b] = map[b] || { brand: b, total: 0, faltam: 0 };
    map[b].total++;
    if (!isFull(p)) map[b].faltam++;
  }
  return Object.values(map).filter((m) => m.faltam > 0).sort((a, b) => b.faltam - a.faltam);
}

// ---- árvore de categorias (caminhos válidos pro classificador) ----
async function caminhosValidos() {
  const nodes = await prisma.categoryNode.findMany({ select: { id: true, name: true, level: true, parentId: true } });
  const by = {}; nodes.forEach((n) => { by[n.id] = n; });
  const nome = (id) => (by[id] ? by[id].name : null);
  const specs = nodes.filter((n) => n.level === 'SPECIALTY');
  const paths = [];
  for (const sp of specs) {
    const mod = by[sp.parentId]; if (!mod) continue;
    const sub = by[mod.parentId]; if (!sub) continue;
    const cat = by[sub.parentId]; if (!cat) continue;
    paths.push({ category: cat.name, subcategory: sub.name, modality: mod.name, specialty: sp.name });
  }
  return paths;
}

// ================= AGENTE 1: CLASSIFICADOR (Claude + árvore) =================
async function agenteClassificador(runId, product, paths) {
  await log(runId, 'classificador', 'trabalhando', 'analisando ' + (product.name || '').slice(0, 50), product);
  if (isFull(product)) { await log(runId, 'classificador', 'skip', 'já classificado nas 4', product); return true; }
  // monta lista compacta de caminhos válidos
  const lista = paths.map((p, i) => i + ') ' + p.category + ' > ' + p.subcategory + ' > ' + p.modality + ' > ' + p.specialty).join('\n');
  let nfeDesc = '';
  try { const it = await prisma.xmlFiscalItem.findFirst({ where: { productId: product.id }, select: { description: true } }); if (it) nfeDesc = it.description || ''; } catch (_) {}
  try {
    const an = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const r = await an.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content:
      'Produto: "' + (product.name || '') + '" | Marca: ' + (product.brand || '') + (nfeDesc ? ' | NFe: ' + nfeDesc.slice(0, 80) : '') +
      '\n\nEscolha o ÚNICO caminho de classificação mais correto desta lista (responda só o NÚMERO):\n' + lista +
      '\n\nSÓ JSON: {"n": número do caminho ou null se nenhum servir}' }] });
    const t = (r.content.find((c) => c.type === 'text') || {}).text || '';
    const m = t.match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : {};
    const idx = (j.n != null) ? parseInt(j.n, 10) : -1;
    if (idx < 0 || !paths[idx]) { await log(runId, 'classificador', 'erro', 'não achou caminho seguro — deixou pro humano', product); return false; }
    const path = paths[idx];
    const ctx = ctxOf(product); ctx.classification = { ...(ctx.classification || {}), category: path.category, subcategory: path.subcategory, modality: path.modality, tier: path.specialty };
    await prisma.product.update({ where: { id: product.id }, data: { category: path.category, subcategory: path.subcategory, aiContext: ctx } });
    product.category = path.category; product.subcategory = path.subcategory; product.aiContext = ctx;
    await log(runId, 'classificador', 'ok', path.category + ' › ' + path.subcategory + ' › ' + path.modality + ' › ' + path.specialty, product);
    await bump(runId, 'classified'); return true;
  } catch (e) { await log(runId, 'classificador', 'erro', String(e.message).slice(0, 80), product); return false; }
}

// ================= AGENTE 2: FOTÓGRAFO (foto oficial via curador) =================
async function agenteFotografo(runId, product) {
  await log(runId, 'fotografo', 'trabalhando', 'buscando foto oficial', product);
  if (temFoto(product) && !ctxOf(product).photoPending) { await log(runId, 'fotografo', 'skip', 'já tem foto', product); return true; }
  if (!curador || !curador.curateProduct) { await log(runId, 'fotografo', 'erro', 'curador indisponível', product); return false; }
  try {
    const rep = await curador.curateProduct(product.id, { skipDescription: true, skipNuvemshop: true, imageCandidates: 8, minScore: 8 });
    const fresh = await prisma.product.findUnique({ where: { id: product.id }, select: { imageUrl: true, imageUrls: true, aiContext: true } });
    product.imageUrl = fresh.imageUrl; product.imageUrls = fresh.imageUrls; product.aiContext = fresh.aiContext;
    if (temFoto(product)) { await log(runId, 'fotografo', 'ok', 'foto oficial aplicada', product); await bump(runId, 'photo'); return true; }
    await log(runId, 'fotografo', 'skip', 'sem foto oficial encontrada', product); return false;
  } catch (e) { await log(runId, 'fotografo', 'erro', String(e.message).slice(0, 80), product); return false; }
}

// ================= AGENTE 3: DESIGNER (handoff — marca "precisa de arte") =================
async function agenteDesigner(runId, product, temFotoOk) {
  if (temFotoOk) return true; // já tem foto, não precisa de arte
  const ctx = ctxOf(product); ctx.precisaArte = true; ctx.precisaArteDesde = new Date().toISOString();
  await prisma.product.update({ where: { id: product.id }, data: { aiContext: ctx } }).catch(() => {});
  await log(runId, 'designer', 'arte', 'sem foto oficial → marcado PRECISA DE ARTE (handoff)', product);
  await bump(runId, 'needsArt'); return false;
}

// ================= AGENTE 4: AUDITOR =================
async function agenteAuditor(runId, product) {
  await log(runId, 'auditor', 'trabalhando', 'conferindo', product);
  const full = isFull(product); const foto = temFoto(product);
  const problemas = [];
  if (!full) problemas.push('classificação incompleta');
  if (!foto) problemas.push('sem foto');
  if (problemas.length) { await log(runId, 'auditor', 'erro', 'reprovado: ' + problemas.join(' + '), product); return false; }
  await log(runId, 'auditor', 'ok', '4 níveis + foto OK', product); await bump(runId, 'audited'); return true;
}

// ================= AGENTE 5: PUBLICADOR NUVEMSHOP =================
async function agentePublicador(runId, product) {
  await log(runId, 'publicador', 'trabalhando', 'subindo pro Nuvemshop', product);
  const preco = product.price || 0;
  if (preco <= 0) { await log(runId, 'publicador', 'skip', 'sem preço de venda — não sobe', product); return false; }
  if (!nsHandlers || !nsHandlers.pushProductToNuvemshop) { await log(runId, 'publicador', 'erro', 'integração Nuvemshop indisponível', product); return false; }
  try {
    const connection = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!connection) { await log(runId, 'publicador', 'erro', 'sem conexão Nuvemshop ativa', product); return false; }
    const res = await nsHandlers.pushProductToNuvemshop(product.id, connection);
    // verifica que subiu (mapping criado)
    const map = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: product.id } }).catch(() => null);
    if (map && map.nuvemshopProductId) { await log(runId, 'publicador', 'ok', 'subiu e vinculou (NS#' + map.nuvemshopProductId + ', ' + (res && res.action || 'ok') + ')', product); await bump(runId, 'published'); return true; }
    await log(runId, 'publicador', 'erro', 'push rodou mas não confirmou vínculo — conferir', product); return false;
  } catch (e) { await log(runId, 'publicador', 'erro', String(e.message).slice(0, 90), product); return false; }
}

// ================= LOOP DA ESTEIRA =================
async function processRun(runId, brand) {
  STATE.runId = runId; STATE.brand = brand; STATE.running = true; STATE.paused = false;
  await log(runId, 'orquestrador', 'info', 'esteira iniciada' + (brand ? ' — marca ' + brand : ''), null);
  const paths = await caminhosValidos();
  if (!paths.length) await log(runId, 'orquestrador', 'erro', 'árvore de categorias vazia — classificação vai falhar', null);
  // REGRA DO DONO: só produto BIPADO E COM ESTOQUE (Σ StoreStock > 0) entra.
  const bip = await bipadoIds();
  await log(runId, 'orquestrador', 'info', 'só produtos BIPADOS E COM ESTOQUE entram — ' + bip.size + ' com estoque localizado no catálogo', null);
  const where = { active: true, id: { in: [...bip] } };
  if (brand && brand !== '(sem marca)') where.brand = { equals: brand, mode: 'insensitive' };
  const produtos = await prisma.product.findMany({ where, select: { id: true, name: true, brand: true, category: true, subcategory: true, price: true, imageUrl: true, imageUrls: true, aiContext: true }, orderBy: { createdAt: 'desc' } });
  const fila = produtos.filter((p) => !isFull(p) || !temFoto(p));
  await prisma.agentRun.update({ where: { id: runId }, data: { total: fila.length } }).catch(() => {});
  await log(runId, 'orquestrador', 'info', fila.length + ' produtos bipados c/ estoque na fila', null);

  for (const product of fila) {
    // pausa
    while (STATE.paused) { await sleep(1500); }
    const run = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } }).catch(() => null);
    if (!run || run.status === 'done') break;
    try {
      await agenteClassificador(runId, product, paths);
      const fotoOk = await agenteFotografo(runId, product);
      await agenteDesigner(runId, product, fotoOk);
      const aud = await agenteAuditor(runId, product);
      if (aud) await agentePublicador(runId, product);
    } catch (e) { await log(runId, 'orquestrador', 'erro', 'falha no produto: ' + String(e.message).slice(0, 60), product); await bump(runId, 'errors'); }
    await bump(runId, 'done');
    AGENTES.forEach((a) => { STATE.atual[a] = null; });
    await sleep(400);
  }
  STATE.running = false; STATE.atual = {};
  await prisma.agentRun.update({ where: { id: runId }, data: { status: 'done', finishedAt: new Date() } }).catch(() => {});
  await log(runId, 'orquestrador', 'ok', 'esteira concluída', null);
}

// ================= CONTROLE =================
async function start(brand) {
  if (STATE.running) return { error: 'já tem uma esteira rodando', runId: STATE.runId };
  const run = await prisma.agentRun.create({ data: { brand: brand || null, status: 'running' } });
  setImmediate(() => processRun(run.id, brand).catch((e) => console.error('[orquestrador]', e.message)));
  return { runId: run.id, brand };
}
function pause() { STATE.paused = true; if (STATE.runId) prisma.agentRun.update({ where: { id: STATE.runId }, data: { status: 'paused' } }).catch(() => {}); return { paused: true }; }
function resume() { STATE.paused = false; if (STATE.runId) prisma.agentRun.update({ where: { id: STATE.runId }, data: { status: 'running' } }).catch(() => {}); return { paused: false }; }
async function stop() { STATE.paused = false; STATE.running = false; if (STATE.runId) await prisma.agentRun.update({ where: { id: STATE.runId }, data: { status: 'done', finishedAt: new Date() } }).catch(() => {}); return { stopped: true }; }

async function status() {
  const run = STATE.runId ? await prisma.agentRun.findUnique({ where: { id: STATE.runId } }).catch(() => null) : null;
  return { state: { running: STATE.running, paused: STATE.paused, brand: STATE.brand, atual: STATE.atual }, run, agentes: AGENTES };
}
async function events(sinceId) {
  const where = {};
  if (sinceId) { const ev = await prisma.agentEvent.findUnique({ where: { id: sinceId }, select: { createdAt: true } }).catch(() => null); if (ev) where.createdAt = { gt: ev.createdAt }; }
  const rows = await prisma.agentEvent.findMany({ where, orderBy: { createdAt: 'asc' }, take: 80 });
  return rows;
}

module.exports = { listBrands, start, pause, resume, stop, status, events, getState, AGENTES };
