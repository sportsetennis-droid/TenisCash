// =====================================================================
// APEX — Desafios de atividade
// ---------------------------------------------------------------------
// kind=official → criado pelo admin do clube, público, qualquer atleta entra.
// kind=group    → criado por qualquer atleta, privado, entra por link
//                 (/atividade.html#/desafio/<inviteCode>).
// ruleType: distance (meta em m) | time (meta em s de movimento) |
//           frequency (meta em nº de atividades) — tudo dentro do período.
// ruleConfig: { target, sportTypes?: [..], xp?: n }
// O progresso é RECALCULADO das atividades do período (idempotente: apagar
// ou reimportar atividade não duplica). Concluiu → completedAt + badge
// "challenge:<id>".
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');

const RULES = new Set(['distance', 'time', 'frequency']);

function parseInput(body) {
  const name = String(body.name || '').trim().slice(0, 80);
  if (name.length < 3) throw new Error('nome do desafio é obrigatório');
  const ruleType = String(body.ruleType || '');
  if (!RULES.has(ruleType)) throw new Error('ruleType deve ser distance, time ou frequency');
  const target = Number(body.target);
  if (!Number.isFinite(target) || target <= 0) throw new Error('meta (target) inválida');
  const startsAt = new Date(body.startsAt || Date.now());
  const endsAt = new Date(body.endsAt);
  if (isNaN(startsAt) || isNaN(endsAt) || endsAt <= startsAt) throw new Error('período inválido');
  if (endsAt - startsAt > 366 * 86400e3) throw new Error('período máximo de 1 ano');
  const sportTypes = Array.isArray(body.sportTypes) ? body.sportTypes.map(String).slice(0, 10) : [];
  const xp = Math.max(0, Math.min(2000, Number(body.xp) || 150));
  return {
    name, description: body.description ? String(body.description).slice(0, 1000) : null,
    ruleType, ruleConfig: { target, sportTypes, xp }, startsAt, endsAt,
  };
}

async function createOfficial(body) {
  const d = parseInput(body);
  return prisma.challenge.create({ data: { ...d, kind: 'official', visibility: 'public', prizeType: 'badge' } });
}

async function createGroup(userId, body) {
  const d = parseInput(body);
  const open = await prisma.challenge.count({ where: { kind: 'group', ownerId: userId, endsAt: { gt: new Date() } } });
  if (open >= 20) throw new Error('limite de 20 desafios de grupo ativos');
  const inviteCode = crypto.randomBytes(8).toString('base64url');
  const ch = await prisma.challenge.create({
    data: { ...d, kind: 'group', visibility: 'private', ownerId: userId, inviteCode, prizeType: 'badge' },
  });
  await join(userId, ch.id);
  return ch;
}

async function canSee(userId, ch) {
  if (!ch) return false;
  if (ch.kind !== 'group') return true;
  if (ch.ownerId === userId) return true;
  const p = await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: ch.id, userId } } });
  return !!p;
}

async function join(userId, challengeId) {
  const ch = await prisma.challenge.findUnique({ where: { id: challengeId } });
  if (!ch) throw Object.assign(new Error('desafio não encontrado'), { status: 404 });
  if (ch.endsAt < new Date()) throw Object.assign(new Error('desafio encerrado'), { status: 400 });
  const p = await prisma.challengeParticipation.upsert({
    where: { challengeId_userId: { challengeId, userId } },
    create: { challengeId, userId },
    update: {},
  });
  await recompute(userId, ch);
  return p;
}

async function joinByCode(userId, code) {
  const ch = await prisma.challenge.findUnique({ where: { inviteCode: String(code || '') } });
  if (!ch) throw Object.assign(new Error('convite inválido'), { status: 404 });
  return { challenge: ch, participation: await join(userId, ch.id) };
}

function sportFilter(ch) {
  const st = ch.ruleConfig && Array.isArray(ch.ruleConfig.sportTypes) ? ch.ruleConfig.sportTypes : [];
  return st.length ? { sportType: { in: st } } : {};
}

async function progressOf(userId, ch) {
  const where = { userId, processingState: 'done', startedAt: { gte: ch.startsAt, lt: ch.endsAt }, ...sportFilter(ch) };
  if (ch.ruleType === 'frequency') return prisma.activity.count({ where });
  const agg = await prisma.activity.aggregate({ where, _sum: { distanceM: true, movingTimeS: true } });
  return ch.ruleType === 'distance' ? (agg._sum.distanceM || 0) : (agg._sum.movingTimeS || 0);
}

async function recompute(userId, ch) {
  const value = await progressOf(userId, ch);
  const target = Number(ch.ruleConfig?.target) || Infinity;
  const p = await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: ch.id, userId } } });
  if (!p) return null;
  const done = value >= target;
  const data = { progressValue: value };
  if (done && !p.completedAt) data.completedAt = new Date();
  const up = await prisma.challengeParticipation.update({ where: { id: p.id }, data });
  if (done && !p.completedAt) {
    const { awardBadge } = require('./apexRewards');
    await awardBadge(userId, ch.badgeKey || `challenge:${ch.id}`, { metadata: { challengeId: ch.id, challengeName: ch.name } });
  }
  return up;
}

/** Atualiza todos os desafios ativos do atleta que cobrem a data da atividade. */
async function onActivity(userId, activity) {
  const parts = await prisma.challengeParticipation.findMany({
    where: { userId, challenge: { startsAt: { lte: activity.startedAt }, endsAt: { gt: activity.startedAt } } },
    include: { challenge: true },
  });
  const out = [];
  for (const p of parts) out.push(await recompute(userId, p.challenge));
  return out.filter(Boolean);
}

async function ranking(ch, limit = 100) {
  const parts = await prisma.challengeParticipation.findMany({
    where: { challengeId: ch.id },
    orderBy: [{ progressValue: 'desc' }, { completedAt: 'asc' }],
    take: limit,
    include: { user: { select: { id: true, name: true, username: true } } },
  });
  const target = Number(ch.ruleConfig?.target) || 0;
  return parts.map((p, i) => ({
    rank: i + 1, userId: p.userId, name: (p.user?.name || 'Atleta').split(' ').slice(0, 2).join(' '),
    username: p.user?.username || null, progressValue: p.progressValue,
    pct: target ? Math.min(100, Math.round((p.progressValue / target) * 100)) : 0,
    completedAt: p.completedAt,
  }));
}

async function listFor(userId) {
  const now = new Date();
  const mine = await prisma.challengeParticipation.findMany({ where: { userId }, select: { challengeId: true, progressValue: true, completedAt: true } });
  const myIds = mine.map((m) => m.challengeId);
  const list = await prisma.challenge.findMany({
    where: { OR: [{ kind: 'official', endsAt: { gt: new Date(now - 30 * 86400e3) } }, { id: { in: myIds } }] },
    orderBy: { endsAt: 'asc' },
    take: 100,
  });
  const byId = Object.fromEntries(mine.map((m) => [m.challengeId, m]));
  return list.map((c) => ({
    id: c.id, name: c.name, description: c.description, kind: c.kind, ruleType: c.ruleType, ruleConfig: c.ruleConfig,
    startsAt: c.startsAt, endsAt: c.endsAt, isOwner: c.ownerId === userId,
    inviteCode: c.ownerId === userId || byId[c.id] ? c.inviteCode : null,
    joined: !!byId[c.id], progressValue: byId[c.id]?.progressValue || 0, completedAt: byId[c.id]?.completedAt || null,
  }));
}

module.exports = { createOfficial, createGroup, join, joinByCode, canSee, recompute, onActivity, ranking, listFor, parseInput };
