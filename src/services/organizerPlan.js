// =====================================================================
// Liga Aberta F5 — LIMITES POR PLANO do organizador (SEM PREÇO)
// ---------------------------------------------------------------------
// Plano "free" para todo organizador (sem linha em OrganizerSubscription).
// F7: planos pagos POR TAMANHO no catálogo (PAID_TIERS/env/tabela), sem preço; só o admin
// global atribui (assignPlan → OrganizerPlanLog).
// Limites do free = padrão generoso do código < variável de ambiente < linha
// "free" na tabela OrganizerPlan (coluna limits). Planos pagos = outras linhas
// de OrganizerPlan; o preço (priceCents) NUNCA é definido aqui — decisão do dono.
//
// Limites (por organizador = dono do torneio, Tournament.ownerId):
//   activeTournaments        torneios ativos (não arquivados, status DRAFT/OPEN/ONGOING)
//   categoriesPerTournament  categorias por torneio
//   teamsPerCategory         inscrições por categoria
//   postsPerMonth            avisos no mural por mês (todos os torneios do dono)
//   imagesPerMonth           imagens enviadas por mês (MediaObject.source='upload' do usuário)
// "Mês" = mês corrente em America/Fortaleza.
//
// Quem NÃO tem limite: admin global e equipe (role admin/superadmin/manager) —
// como quem age OU como dono do torneio; torneio da lista de exclusão (Master Cup).
// Sem retroatividade: só NOVAS criações são conferidas; os limites por torneio
// (categorias, times) só valem para torneio criado a partir de LIGA_PLAN_START
// (padrão 2026-11-20 00:00 de Fortaleza). Nada existente é bloqueado.
// Resposta de bloqueio: 402 { error: 'Limite do plano grátis: ...', code: 'PLAN_LIMIT', ... }.
// =====================================================================

const { prisma } = require('../middleware');
const clubIdentity = require('./clubIdentity');

let db = prisma;
function setPrisma(p) { db = p; }

const STAFF_ROLES = new Set(['admin', 'superadmin', 'manager']);
const isStaffRole = (r) => STAFF_ROLES.has(String(r || ''));

const DEFAULT_FREE = Object.freeze({
  activeTournaments: 20,
  categoriesPerTournament: 20,
  teamsPerCategory: 64,
  postsPerMonth: 300,
  imagesPerMonth: 300,
});
const ENV_OF = {
  activeTournaments: 'LIGA_FREE_ACTIVE_TOURNAMENTS',
  categoriesPerTournament: 'LIGA_FREE_CATEGORIES_PER_TOURNAMENT',
  teamsPerCategory: 'LIGA_FREE_TEAMS_PER_CATEGORY',
  postsPerMonth: 'LIGA_FREE_POSTS_PER_MONTH',
  imagesPerMonth: 'LIGA_FREE_IMAGES_PER_MONTH',
};
const LABEL = {
  activeTournaments: (n) => `até ${n} torneios ativos ao mesmo tempo`,
  categoriesPerTournament: (n) => `até ${n} categorias por torneio`,
  teamsPerCategory: (n) => `até ${n} times por categoria`,
  postsPerMonth: (n) => `até ${n} avisos no mural por mês`,
  imagesPerMonth: (n) => `até ${n} imagens enviadas por mês`,
};
const ACTIVE_STATUSES = ['DRAFT', 'OPEN', 'ONGOING'];

function planStart() {
  const v = process.env.LIGA_PLAN_START;
  const d = v ? new Date(v) : new Date('2026-11-20T03:00:00Z');
  return Number.isNaN(d.getTime()) ? new Date('2026-11-20T03:00:00Z') : d;
}

function cleanLimits(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of Object.keys(DEFAULT_FREE)) {
    if (obj[k] === null) { out[k] = null; continue; } // null = sem limite
    const n = Math.floor(Number(obj[k]));
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}
function envFree() {
  const out = {};
  for (const [k, env] of Object.entries(ENV_OF)) {
    const raw = process.env[env];
    if (raw == null || raw === '') continue;
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------
// Liga Aberta F7 — PLANOS PAGOS POR TAMANHO (estrutura pronta, SEM PREÇO).
// Os planos pagos diferem só pelo TAMANHO (limites). Preço, cobrança, cartão e Pix NÃO
// existem aqui (decisão do dono; checkout fora do escopo). Limites padrão abaixo são
// PROVISÓRIOS (configuração, não preço) e o dono troca sem deploy:
//   1) env LIGA_PLANS_JSON = {"medio":{"name":"Médio","limits":{"teamsPerCategory":200}}, ...}
//   2) linha na tabela OrganizerPlan (key, name, limits, active) — vence o env.
// Plano pago só passa a valer quando o admin global atribui (assignPlan, com registro).
// ---------------------------------------------------------------------
const PAID_TIERS = Object.freeze({
  pequeno: { name: 'Pequeno', order: 1, limits: { activeTournaments: 40, categoriesPerTournament: 30, teamsPerCategory: 96, postsPerMonth: 600, imagesPerMonth: 600 } },
  medio: { name: 'Médio', order: 2, limits: { activeTournaments: 80, categoriesPerTournament: 50, teamsPerCategory: 128, postsPerMonth: 1500, imagesPerMonth: 1500 } },
  grande: { name: 'Grande', order: 3, limits: { activeTournaments: 200, categoriesPerTournament: 100, teamsPerCategory: 256, postsPerMonth: 5000, imagesPerMonth: 5000 } },
});
const KEY_RX = /^[a-z][a-z0-9-]{1,30}$/;

function envPlans() {
  const raw = process.env.LIGA_PLANS_JSON;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (!KEY_RX.test(k) || !v || typeof v !== 'object') continue;
      out[k] = { name: typeof v.name === 'string' && v.name.trim() ? v.name.trim().slice(0, 40) : null, limits: cleanLimits(v.limits), active: v.active !== false };
    }
    return out;
  } catch (_) { console.error('[organizerPlan] LIGA_PLANS_JSON inválido — ignorado'); return {}; }
}

/** Catálogo de planos (sem preço): free + pagos por tamanho (código < env < tabela). */
async function catalog() {
  const env = envPlans();
  const keys = new Set(['free', ...Object.keys(PAID_TIERS), ...Object.keys(env)]);
  let rows = [];
  try { rows = await db.organizerPlan.findMany(); } catch (_) { rows = []; }
  const byKey = new Map(rows.map((r) => [r.key, r]));
  rows.forEach((r) => { if (r.key && String(r.key).length <= 40) keys.add(r.key); }); // linha da tabela vale como antes (F5)
  const out = [];
  for (const key of keys) {
    const code = key === 'free' ? { name: 'Grátis', order: 0, limits: { ...DEFAULT_FREE, ...envFree() } } : PAID_TIERS[key] || { name: key, order: 50, limits: { ...DEFAULT_FREE } };
    const e = env[key] || {};
    const row = byKey.get(key);
    const active = key === 'free' ? true : row ? !!row.active : e.active !== false;
    out.push({
      key,
      name: (row && row.name) || e.name || code.name,
      order: code.order,
      paid: key !== 'free',
      active,
      limits: { ...code.limits, ...(e.limits || {}), ...cleanLimits(row && row.limits) },
    });
  }
  return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** Plano do organizador: { key, name, priceCents (sempre o que está na tabela; nulo por padrão), limits }. */
async function planFor(userId) {
  let key = 'free';
  try {
    const sub = userId ? await db.organizerSubscription.findUnique({ where: { userId: String(userId) } }) : null;
    if (sub && sub.planKey) key = sub.planKey;
  } catch (_) { /* tabela ainda não existe: free */ }
  const cat = await catalog();
  let p = cat.find((x) => x.key === key && x.active);
  if (!p) { key = 'free'; p = cat.find((x) => x.key === 'free'); }
  let row = null;
  try { row = await db.organizerPlan.findUnique({ where: { key } }); } catch (_) { row = null; }
  return {
    key,
    name: p.name,
    priceCents: row && row.priceCents != null ? row.priceCents : null,
    limits: p.limits,
  };
}

// Admin global troca o plano de um organizador (ação global PLAN_ADMIN). Registro em
// OrganizerPlanLog. Não mexe em preço nem cobra nada. target: { userId | username | phone }.
class PlanError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; } }
async function assignPlan({ actorId, actorRole, target = {}, planKey, note }) {
  const roles = require('./tournamentRoles');
  if (!(await roles.can(actorId, actorRole, null, 'PLAN_ADMIN'))) throw new PlanError(403, 'só o administrador do sistema troca o plano de um organizador');
  const key = String(planKey || '').trim();
  const cat = await catalog();
  const p = cat.find((x) => x.key === key);
  if (!p) throw new PlanError(400, 'plano inexistente');
  if (!p.active) throw new PlanError(400, 'plano desativado');
  const u = await roles.resolveUser({ userId: target.userId, username: target.username, phone: target.phone });
  if (!u) throw new PlanError(404, 'organizador não encontrado');
  const cleanNote = note == null ? null : String(note).trim().slice(0, 300) || null;
  const out = await db.$transaction(async (tx) => {
    // de/para lido DENTRO da transação, com trava por organizador (dois admins ao mesmo tempo)
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${'liga-plan:' + u.id}))) AS l`;
    const prev = await tx.organizerSubscription.findUnique({ where: { userId: u.id } });
    const raw = prev && prev.planKey ? prev.planKey : 'free';
    const fromPlan = cat.some((x) => x.key === raw && x.active) ? raw : 'free'; // plano desativado = vale o grátis
    if (raw === key) return { unchanged: true, fromPlan }; // assinatura já aponta pra esse plano
    if (key === 'free') await tx.organizerSubscription.deleteMany({ where: { userId: u.id } }); // sem linha = free
    else await tx.organizerSubscription.upsert({ where: { userId: u.id }, create: { userId: u.id, planKey: key }, update: { planKey: key } });
    await tx.organizerPlanLog.create({ data: { userId: u.id, fromPlan, toPlan: key, actorId: String(actorId), note: cleanNote } });
    return { unchanged: false, fromPlan };
  });
  if (out.unchanged) return { ok: true, unchanged: true, user: { id: u.id, name: u.name, username: u.username || null }, plan: { key: p.key, name: p.name, limits: p.limits } };
  return { ok: true, user: { id: u.id, name: u.name, username: u.username || null }, from: out.fromPlan, plan: { key: p.key, name: p.name, limits: p.limits } };
}

async function planLog(userId, { limit = 20 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));
  try { return await db.organizerPlanLog.findMany({ where: userId ? { userId: String(userId) } : {}, orderBy: { createdAt: 'desc' }, take: n }); } catch (_) { return []; }
}

// "Fale com a gente para ampliar": só um link https configurado pelo dono (nada de envio).
function contactUrl() {
  const v = String(process.env.LIGA_PLAN_CONTACT_URL || '').trim();
  return /^https:\/\/[^\s<>"']+$/.test(v) ? v : null;
}

function monthStart(now = new Date()) {
  const l = new Date(now.getTime() - 3 * 3600 * 1000); // Fortaleza UTC-3 fixo
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) + 3 * 3600 * 1000);
}

async function roleOf(userId) {
  if (!userId) return null;
  const u = await db.user.findUnique({ where: { id: String(userId) }, select: { role: true } }).catch(() => null);
  return u ? u.role : null;
}

// ------------------------------------------------------------------ uso
async function usage(userId, kind, ctx = {}) {
  switch (kind) {
    case 'activeTournaments':
      // sem retroatividade: só conta torneio criado a partir de LIGA_PLAN_START (racha/torneio
      // antigo parado em ONGOING não trava ninguém); torneio da lista de exclusão não conta
      return db.tournament.count({ where: { ownerId: String(userId), archivedAt: null, status: { in: ACTIVE_STATUSES }, createdAt: { gte: planStart() }, slug: { notIn: [...clubIdentity.excludedSlugs()] } } });
    case 'categoriesPerTournament':
      return db.tournamentCategory.count({ where: { tournamentId: ctx.tournamentId } });
    case 'teamsPerCategory':
      return db.tournamentEntry.count({ where: { categoryId: ctx.categoryId, status: { notIn: ['REJECTED', 'CANCELED', 'WITHDRAWN', 'REMOVED'] } } });
    case 'postsPerMonth':
      return db.tournamentPost.count({ where: { createdAt: { gte: monthStart() }, tournament: { ownerId: String(userId) } } });
    case 'imagesPerMonth':
      try { return await db.mediaObject.count({ where: { ownerUserId: String(userId), source: 'upload', createdAt: { gte: monthStart() } } }); } catch (_) { return 0; }
    default:
      return 0;
  }
}

function blocked(plan, kind, limit, used) {
  const free = plan.key === 'free';
  return {
    status: 402,
    body: {
      error: `${free ? 'Limite do plano grátis' : 'Limite do seu plano'}: ${LABEL[kind](limit)}.`,
      code: 'PLAN_LIMIT', kind, limit, used, plan: plan.key,
    },
  };
}

/**
 * Confere UMA nova criação.
 * kind: 'tournament' | 'category' | 'team' | 'post' | 'image'
 * ctx: { actorId, actorRole, tournament?: {id, ownerId, slug, createdAt}, categoryId?, adding?: n }
 * Retorna null (pode) ou { status, body } (bloqueado).
 */
async function check(kind, ctx = {}) {
  if (isStaffRole(ctx.actorRole)) return null;
  const t = ctx.tournament || null;
  if (t && clubIdentity.isExcludedSlug(t.slug)) return null;
  const ownerId = kind === 'tournament' || kind === 'image' ? ctx.actorId : (t && t.ownerId) || ctx.actorId;
  if (!ownerId) return null;
  if (ownerId !== ctx.actorId && isStaffRole(await roleOf(ownerId))) return null;
  // sem retroatividade: limite por torneio só para torneio novo
  if ((kind === 'category' || kind === 'team') && t && t.createdAt && new Date(t.createdAt) < planStart()) return null;
  const plan = await planFor(ownerId);
  const map = { tournament: 'activeTournaments', category: 'categoriesPerTournament', team: 'teamsPerCategory', post: 'postsPerMonth', image: 'imagesPerMonth' };
  const lk = map[kind];
  if (!lk) return null;
  const limit = plan.limits[lk];
  if (limit == null) return null;
  const adding = Math.max(1, Math.floor(Number(ctx.adding) || 1));
  const used = await usage(ownerId, lk, { tournamentId: t && t.id, categoryId: ctx.categoryId });
  if (used + adding > limit) return blocked(plan, lk, limit, used);
  return null;
}

/** Atalho para rota: confere e responde 402. true = pode seguir. */
async function guard(res, kind, ctx) {
  const r = await module.exports.check(kind, ctx); // via exports: o teste de sabotagem troca o check
  if (!r) return true;
  res.status(r.status).json(r.body);
  return false;
}

/** Painel "meu plano": uso × limite. */
async function summary(userId, userRole) {
  const plan = await planFor(userId);
  const unlimited = isStaffRole(userRole);
  const [active, posts, images] = await Promise.all([
    usage(userId, 'activeTournaments'),
    usage(userId, 'postsPerMonth'),
    usage(userId, 'imagesPerMonth'),
  ]);
  const ts = await db.tournament.findMany({
    where: { ownerId: String(userId), archivedAt: null, status: { in: ACTIVE_STATUSES } },
    select: { id: true, name: true, slug: true, createdAt: true, categories: { select: { id: true, name: true, _count: { select: { entries: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const start = planStart();
  return {
    plan: { key: plan.key, name: plan.name, priceCents: plan.priceCents },
    unlimited,
    limits: plan.limits,
    usage: { activeTournaments: active, postsPerMonth: posts, imagesPerMonth: images },
    monthStart: monthStart().toISOString(),
    tournaments: ts.map((t) => ({
      id: t.id, name: t.name, slug: t.slug,
      grandfathered: new Date(t.createdAt) < start || clubIdentity.isExcludedSlug(t.slug),
      categories: t.categories.length,
      maxTeamsInCategory: t.categories.reduce((m, c) => Math.max(m, c._count.entries), 0),
    })),
    labels: Object.fromEntries(Object.entries(plan.limits).map(([k, v]) => [k, v == null ? 'sem limite' : LABEL[k](v)])),
    // Liga F7: planos por tamanho (sem preço, sem checkout) + "Fale com a gente para ampliar"
    catalog: (await catalog()).filter((p) => p.active).map((p) => ({ key: p.key, name: p.name, paid: p.paid, current: p.key === plan.key, limits: p.limits })),
    contactUrl: contactUrl(),
  };
}

module.exports = { DEFAULT_FREE, PAID_TIERS, isStaffRole, planFor, planStart, monthStart, usage, check, guard, summary, catalog, assignPlan, planLog, contactUrl, PlanError, setPrisma };
