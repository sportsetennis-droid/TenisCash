// =====================================================================
// Club — Rating Glicko-2 por atleta/time, por esporte e formato.
// ---------------------------------------------------------------------
// Fonte da verdade = HISTÓRICO (jogos FINALIZADOS de torneio + desafios
// 1x1 JOGADOS). O rating é sempre RECALCULADO a partir dele, então rodar
// de novo dá o mesmo resultado (idempotente) e mudar/corrigir um placar
// antigo se reflete no próximo recálculo.
//
// Regras (documentadas, sem chute):
//  - Período de rating = SEMANA (seg→dom, horário de Fortaleza). Todos os
//    jogos da semana são processados juntos (Glicko-2 por período).
//  - Pools separados: SINGLES (1x1), DOUBLES (dupla 2x2) e TEAM (esporte
//    coletivo: rating do TIME pelo nome do clube + esporte).
//  - Dupla: cada atleta é atualizado com o PRÓPRIO rating/RD/σ contra o
//    adversário "composto" (média dos 2 ratings, RD quadrático médio).
//  - W.O. NÃO entra (não houve jogo). Empate = 0,5. Mata-mata decidido
//    nos pênaltis = 0,5 pros dois (tempo normal empatado), padrão Elo do
//    futebol.
//  - O rating antigo (AthleteRating.rating, Elo 0–7) segue intacto como
//    LEGADO pras telas que já o usam.
// Exibição: nível 0–7 (estilo Playtomic) + confiabilidade 0–100%.
// RD alto (> 110) = nível PROVISÓRIO.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const glicko = require('./glicko2');

let prisma = new PrismaClient();
function setPrisma(p) { prisma = p; } // testes

const TEAM_SPORTS = new Set(['FUTSAL', 'SOCCER', 'VOLLEY', 'BASKETBALL', 'HANDBALL']);
const FORMATS = ['SINGLES', 'DOUBLES', 'TEAM'];
const PROVISIONAL_RD = 110;
const MIN_RD = 50; // RD "teto de confiança" pra escala de confiabilidade
const LEVEL_BASE = 900; // rating que vale nível 0
const LEVEL_STEP = 200; // pontos Glicko por nível → 1500 = 3,0 · 2300 = 7,0
const DAY = 86400000;
const TZ_OFFSET_MS = 3 * 3600000; // America/Fortaleza = UTC-3 fixo (sem horário de verão)

// ---------------------------------------------------------------- utils
function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Índice da semana (seg→dom) em Fortaleza. 1970-01-01 foi quinta.
function periodIndex(date) {
  const t = new Date(date).getTime() - TZ_OFFSET_MS;
  const day = Math.floor(t / DAY);
  return Math.floor((day + 3) / 7);
}
function periodStart(idx) { return new Date((idx * 7 - 3) * DAY + TZ_OFFSET_MS); }

function level(rating) {
  const l = (rating - LEVEL_BASE) / LEVEL_STEP;
  return Math.round(Math.max(0, Math.min(7, l)) * 100) / 100;
}
function reliability(rd) {
  const pct = ((glicko.DEFAULT_RD - rd) / (glicko.DEFAULT_RD - MIN_RD)) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)));
}
function isProvisional(rd) { return rd > PROVISIONAL_RD; }

// RD que vale HOJE (inclui semanas paradas desde o último período jogado)
function currentRd(row, now = new Date()) {
  if (row.lastPeriod == null) return row.rd;
  const idle = periodIndex(now) - row.lastPeriod - 1;
  return glicko.inflateRd(row.rd, row.volatility, idle);
}

function present(row, now = new Date()) {
  const rd = currentRd(row, now);
  return {
    rating: Math.round(row.rating * 100) / 100,
    rd: Math.round(rd * 100) / 100,
    volatility: Math.round(row.volatility * 1e6) / 1e6,
    level: level(row.rating),
    reliability: reliability(rd),
    provisional: isProvisional(rd),
    matches: row.matches,
    wins: row.wins,
    draws: row.draws,
    losses: row.losses,
  };
}

// ------------------------------------------------------- coleta eventos
/**
 * Eventos de rating (histórico) de um esporte (ou todos).
 * Cada evento: { id, source, sport, format, time, period, a:[subj], b:[subj],
 *                score (do lado A: 1|0.5|0), tournamentId, categoryId,
 *                categoryName, categoryGender, stage }
 * subj = { type:'USER'|'TEAM', key, userId?, teamName? }
 */
async function collectEvents({ sport } = {}) {
  const events = [];
  const matches = await prisma.tournamentMatch.findMany({
    where: {
      status: 'FINISHED',
      homeEntryId: { not: null },
      awayEntryId: { not: null },
      ...(sport ? { tournament: { sport } } : {}),
    },
    select: {
      id: true, stage: true, scheduledAt: true, updatedAt: true,
      homeScore: true, awayScore: true, winnerEntryId: true,
      homeEntryId: true, awayEntryId: true, decidedByPenalties: true,
      tournamentId: true, categoryId: true,
      tournament: { select: { sport: true, isDoubles: true } },
      category: { select: { name: true, gender: true } },
      homeEntry: { select: { name: true, status: true, members: { select: { userId: true } } } },
      awayEntry: { select: { name: true, status: true, members: { select: { userId: true } } } },
    },
  });
  for (const m of matches) {
    // Liga F3: jogo de RACHA (times sorteados no dia) não entra no rating — os "times"
    // mudam a cada dia e virariam clubes-fantasma no ranking de equipes.
    if (m.stage === 'PICKUP') continue;
    const sp = m.tournament.sport;
    let format;
    let a;
    let b;
    if (TEAM_SPORTS.has(sp)) {
      format = 'TEAM';
      a = [{ type: 'TEAM', key: normName(m.homeEntry.name), teamName: m.homeEntry.name }];
      b = [{ type: 'TEAM', key: normName(m.awayEntry.name), teamName: m.awayEntry.name }];
      if (!a[0].key || !b[0].key || a[0].key === b[0].key) continue;
    } else {
      const hu = [...new Set(m.homeEntry.members.map((x) => x.userId))];
      const au = [...new Set(m.awayEntry.members.map((x) => x.userId))];
      if (!hu.length || !au.length || hu.length !== au.length || hu.length > 2) continue;
      if (hu.some((u) => au.includes(u))) continue;
      format = hu.length === 1 ? 'SINGLES' : 'DOUBLES';
      a = hu.map((u) => ({ type: 'USER', key: u, userId: u }));
      b = au.map((u) => ({ type: 'USER', key: u, userId: u }));
    }
    let score;
    if (m.decidedByPenalties) score = 0.5;
    else if (m.winnerEntryId === m.homeEntryId) score = 1;
    else if (m.winnerEntryId === m.awayEntryId) score = 0;
    else if (m.winnerEntryId == null && m.homeScore != null && m.homeScore === m.awayScore) score = 0.5;
    else continue;
    const time = m.scheduledAt || m.updatedAt;
    events.push({
      id: m.id, source: 'MATCH', sport: sp, format, time, period: periodIndex(time), a, b, score,
      tournamentId: m.tournamentId, categoryId: m.categoryId,
      categoryName: m.category ? m.category.name : null,
      categoryGender: m.category ? m.category.gender : null,
      stage: m.stage,
    });
  }

  const challenges = await prisma.playChallenge.findMany({
    where: { status: 'PLAYED', winnerId: { not: null }, ...(sport ? { sport } : {}) },
    select: { id: true, sport: true, challengerId: true, challengedId: true, winnerId: true, updatedAt: true, proposedAt: true },
  });
  for (const c of challenges) {
    if (!c.challengerId || !c.challengedId || c.challengerId === c.challengedId) continue;
    if (c.winnerId !== c.challengerId && c.winnerId !== c.challengedId) continue;
    // Esporte coletivo também tem desafio 1x1 (rating individual SINGLES).
    const time = c.updatedAt;
    events.push({
      id: c.id, source: 'CHALLENGE', sport: c.sport, format: 'SINGLES', time, period: periodIndex(time),
      a: [{ type: 'USER', key: c.challengerId, userId: c.challengerId }],
      b: [{ type: 'USER', key: c.challengedId, userId: c.challengedId }],
      score: c.winnerId === c.challengerId ? 1 : 0,
      tournamentId: null, categoryId: null, categoryName: null, categoryGender: null, stage: null,
    });
  }
  // ordem determinística (idempotência)
  events.sort((x, y) => (new Date(x.time) - new Date(y.time)) || String(x.id).localeCompare(String(y.id)));
  return events;
}

// ------------------------------------------------------------ cálculo
/**
 * Processa os eventos de UM pool (sport+format) período a período.
 * Retorna Map key → estado.
 */
function computePool(events, opts = {}) {
  const states = new Map();
  const get = (s) => {
    let st = states.get(s.key);
    if (!st) {
      st = {
        subjectType: s.type, subjectKey: s.key, userId: s.userId || null, teamName: s.teamName || null,
        rating: glicko.DEFAULT_RATING, rd: glicko.DEFAULT_RD, volatility: glicko.DEFAULT_VOL,
        matches: 0, wins: 0, draws: 0, losses: 0, lastPeriod: null, lastMatchAt: null,
      };
      states.set(s.key, st);
    }
    if (s.teamName) st.teamName = s.teamName; // nome mais recente
    return st;
  };
  const byPeriod = new Map();
  for (const ev of events) {
    if (!byPeriod.has(ev.period)) byPeriod.set(ev.period, []);
    byPeriod.get(ev.period).push(ev);
  }
  const periods = [...byPeriod.keys()].sort((a, b) => a - b);
  for (const p of periods) {
    const evs = byPeriod.get(p);
    // 1) estado PRÉ-período (com RD inflado pelas semanas paradas)
    const pre = new Map();
    for (const ev of evs) {
      for (const s of [...ev.a, ...ev.b]) {
        if (pre.has(s.key)) continue;
        const st = get(s);
        const idle = st.lastPeriod == null ? 0 : p - st.lastPeriod - 1;
        pre.set(s.key, { rating: st.rating, rd: glicko.inflateRd(st.rd, st.volatility, idle), vol: st.volatility });
      }
    }
    // 2) resultados por sujeito (contra adversário composto, valores pré-período)
    const results = new Map();
    const push = (key, r) => { if (!results.has(key)) results.set(key, []); results.get(key).push(r); };
    for (const ev of evs) {
      const oppB = glicko.composite(ev.b.map((s) => pre.get(s.key)));
      const oppA = glicko.composite(ev.a.map((s) => pre.get(s.key)));
      for (const s of ev.a) push(s.key, { rating: oppB.rating, rd: oppB.rd, score: ev.score });
      for (const s of ev.b) push(s.key, { rating: oppA.rating, rd: oppA.rd, score: 1 - ev.score });
      for (const s of ev.a) tally(get(s), ev.score, ev.time);
      for (const s of ev.b) tally(get(s), 1 - ev.score, ev.time);
    }
    // 3) atualiza
    for (const [key, list] of results) {
      const st = states.get(key);
      const nu = glicko.updatePlayer(pre.get(key), list, { tau: opts.tau });
      st.rating = nu.rating;
      st.rd = nu.rd;
      st.volatility = nu.vol;
      st.lastPeriod = p;
    }
  }
  return states;
}

function tally(st, score, time) {
  st.matches += 1;
  if (score === 1) st.wins += 1;
  else if (score === 0) st.losses += 1;
  else st.draws += 1;
  if (!st.lastMatchAt || new Date(time) > st.lastMatchAt) st.lastMatchAt = new Date(time);
}

const r6 = (x) => Math.round(x * 1e6) / 1e6;

async function persistPool(sport, format, states) {
  const existing = await prisma.glickoRating.findMany({ where: { sport, format } });
  const byKey = new Map(existing.map((r) => [r.subjectType + '|' + r.subjectKey, r]));
  let written = 0;
  let removed = 0;
  for (const st of states.values()) {
    const k = st.subjectType + '|' + st.subjectKey;
    const old = byKey.get(k);
    byKey.delete(k);
    const data = {
      userId: st.userId, teamName: st.teamName,
      rating: r6(st.rating), rd: r6(st.rd), volatility: r6(st.volatility),
      matches: st.matches, wins: st.wins, draws: st.draws, losses: st.losses,
      lastPeriod: st.lastPeriod, lastMatchAt: st.lastMatchAt,
    };
    if (old) {
      const same = old.rating === data.rating && old.rd === data.rd && old.volatility === data.volatility &&
        old.matches === data.matches && old.wins === data.wins && old.draws === data.draws &&
        old.losses === data.losses && old.lastPeriod === data.lastPeriod && old.teamName === data.teamName &&
        String(old.lastMatchAt && old.lastMatchAt.getTime()) === String(data.lastMatchAt && data.lastMatchAt.getTime());
      if (same) continue;
      await prisma.glickoRating.update({ where: { id: old.id }, data });
    } else {
      await prisma.glickoRating.create({ data: { sport, format, subjectType: st.subjectType, subjectKey: st.subjectKey, ...data } });
    }
    written += 1;
  }
  // sujeitos que sumiram do histórico (placar desfeito etc.) saem do ranking
  for (const old of byKey.values()) {
    await prisma.glickoRating.delete({ where: { id: old.id } }).catch(() => {});
    removed += 1;
  }
  return { written, removed, subjects: states.size };
}

// Fila por esporte: nunca dois recálculos do mesmo esporte ao mesmo tempo.
const queues = new Map();
function recomputeSport(sport, opts) {
  const key = sport || '*';
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doRecompute(sport, opts));
  queues.set(key, run);
  run.finally(() => { if (queues.get(key) === run) queues.delete(key); }).catch(() => {});
  return run;
}

async function doRecompute(sport, opts = {}) {
  const events = await collectEvents({ sport });
  const pools = new Map();
  for (const ev of events) {
    const k = ev.sport + '|' + ev.format;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push(ev);
  }
  // pools que já existem no banco mas ficaram sem evento também são limpos
  const existing = await prisma.glickoRating.groupBy({
    by: ['sport', 'format'],
    where: sport ? { sport } : {},
  });
  for (const e of existing) { const k = e.sport + '|' + e.format; if (!pools.has(k)) pools.set(k, []); }
  const out = [];
  for (const [k, evs] of pools) {
    const [sp, format] = k.split('|');
    const states = computePool(evs, opts);
    const r = await persistPool(sp, format, states);
    out.push({ sport: sp, format, events: evs.length, ...r });
  }
  return { ok: true, pools: out, events: events.length };
}

// Gancho chamado pelo motor quando um resultado entra. Nunca derruba o fluxo.
async function onResult(sport) {
  if (!sport) return null;
  try { return await recomputeSport(sport); } catch (e) {
    console.error('[clubRating] recálculo falhou:', e.message);
    return null;
  }
}

// Boot: esporte com jogo ENCERRADO e NENHUM rating gravado → recalcula do histórico.
// Idempotente (o recálculo sempre reconstrói do zero); não mexe em esporte que já tem rating.
// Resolve o ranking vazio depois do deploy sem precisar de botão nem token de admin.
async function bootstrapEmpty() {
  try {
    const comJogo = await prisma.tournament.findMany({
      where: { matches: { some: { status: 'FINISHED', homeEntryId: { not: null }, awayEntryId: { not: null } } } },
      select: { sport: true }, distinct: ['sport'],
    });
    const feitos = [];
    for (const { sport } of comJogo) {
      if (!sport) continue;
      const ja = await prisma.glickoRating.count({ where: { sport } });
      if (ja > 0) continue;
      const r = await recomputeSport(sport);
      feitos.push(sport + ':' + (r && r.events));
    }
    if (feitos.length) console.log('[clubRating] ranking gerado do histórico no boot: ' + feitos.join(', '));
    return feitos;
  } catch (e) {
    console.error('[clubRating] bootstrap falhou:', e.message);
    return [];
  }
}
// Níveis de um atleta (todos os esportes/formatos) + posição no pool
async function athleteLevels(userId, now = new Date()) {
  const rows = await prisma.glickoRating.findMany({ where: { subjectType: 'USER', subjectKey: userId } });
  const out = [];
  for (const r of rows) {
    const better = await prisma.glickoRating.count({
      where: { sport: r.sport, format: r.format, subjectType: 'USER', rating: { gt: r.rating } },
    });
    const total = await prisma.glickoRating.count({ where: { sport: r.sport, format: r.format, subjectType: 'USER' } });
    out.push({ sport: r.sport, format: r.format, position: better + 1, of: total, ...present(r, now) });
  }
  out.sort((a, b) => b.level - a.level || b.matches - a.matches);
  return out;
}

module.exports = {
  setPrisma,
  TEAM_SPORTS, FORMATS, PROVISIONAL_RD,
  normName, periodIndex, periodStart, level, reliability, isProvisional, currentRd, present,
  collectEvents, computePool, recomputeSport, onResult, athleteLevels, bootstrapEmpty,
};
