// =====================================================================
// APEX — Súmula digital de futsal
// ---------------------------------------------------------------------
// Elenco por time (RosterPlayer) + eventos do jogo (MatchEvent):
// GOAL, ASSIST, YELLOW, RED (por jogador) · FOUL (falta acumulada),
// TIMEOUT (por time). Finalizar conta os gols → placar via engine
// (atualiza classificação e avanço de chave). Estatística agrega por
// jogador = artilharia, assistências, cartões (ranking da temporada).
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const engine = require('./tournamentEngine');

const PLAYER_EVENTS = ['GOAL', 'ASSIST', 'YELLOW', 'RED'];
const ALL_EVENTS = ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT'];

// Monta a súmula completa de uma partida: elenco dos 2 times + eventos + placar.
async function buildSheet(matchId) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    include: {
      homeEntry: { select: { id: true, name: true } },
      awayEntry: { select: { id: true, name: true } },
    },
  });
  if (!match) return null;

  const sideData = async (entry) => {
    if (!entry) return { entry: null, roster: [] };
    const roster = await prisma.rosterPlayer.findMany({
      where: { entryId: entry.id },
      orderBy: [{ number: 'asc' }, { name: 'asc' }],
    });
    return { entry, roster };
  };
  const [home, away] = await Promise.all([sideData(match.homeEntry), sideData(match.awayEntry)]);
  const events = await prisma.matchEvent.findMany({ where: { matchId }, orderBy: { createdAt: 'asc' } });

  const count = (entryId, type) => events.filter((e) => e.entryId === entryId && e.type === type).length;
  const hid = match.homeEntryId;
  const aid = match.awayEntryId;
  return {
    match: {
      id: match.id, status: match.status, stage: match.stage, groupName: match.groupName,
      scheduledAt: match.scheduledAt, location: match.location,
      homeScore: match.homeScore, awayScore: match.awayScore, winnerEntryId: match.winnerEntryId,
      referee1: match.referee1, referee2: match.referee2, referee3: match.referee3,
      scorer: match.scorer, timekeeper: match.timekeeper,
      homePenalties: match.homePenalties, awayPenalties: match.awayPenalties,
      decidedByPenalties: match.decidedByPenalties,
      tournamentId: match.tournamentId, categoryId: match.categoryId,
    },
    home, away, events,
    liveScore: { home: hid ? count(hid, 'GOAL') : 0, away: aid ? count(aid, 'GOAL') : 0 },
    fouls: { home: hid ? count(hid, 'FOUL') : 0, away: aid ? count(aid, 'FOUL') : 0 },
  };
}

async function addEvent(matchId, body = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, homeEntryId: true, awayEntryId: true },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  const type = String(body.type || '').toUpperCase();
  if (!ALL_EVENTS.includes(type)) return { ok: false, error: 'tipo de evento inválido' };
  const entryId = String(body.entryId || '');
  if (![match.homeEntryId, match.awayEntryId].includes(entryId)) {
    return { ok: false, error: 'time não é desta partida' };
  }
  let playerId = null;
  if (PLAYER_EVENTS.includes(type)) {
    if (!body.playerId) return { ok: false, error: 'informe o jogador' };
    const p = await prisma.rosterPlayer.findFirst({ where: { id: String(body.playerId), entryId }, select: { id: true } });
    if (!p) return { ok: false, error: 'jogador não é deste time' };
    playerId = p.id;
  }
  const event = await prisma.matchEvent.create({
    data: {
      matchId, entryId, playerId, type,
      minute: body.minute != null && body.minute !== '' ? Number(body.minute) : null,
      period: body.period != null && body.period !== '' ? Number(body.period) : null,
      note: body.note ? String(body.note).slice(0, 200) : null,
    },
  });
  return { ok: true, event };
}

async function deleteEvent(eventId) {
  await prisma.matchEvent.delete({ where: { id: eventId } }).catch(() => {});
  return { ok: true };
}

// Grava a arbitragem da súmula (árbitro 1/2, mesa). Não finaliza.
async function setOfficials(matchId, body = {}) {
  const clean = (v) => (v == null || v === '' ? null : String(v).slice(0, 120));
  const data = {};
  if ('referee1' in body) data.referee1 = clean(body.referee1);
  if ('referee2' in body) data.referee2 = clean(body.referee2);
  if ('referee3' in body) data.referee3 = clean(body.referee3);
  if ('scorer' in body) data.scorer = clean(body.scorer);
  if ('timekeeper' in body) data.timekeeper = clean(body.timekeeper);
  if (!Object.keys(data).length) return { ok: false, error: 'nada pra gravar' };
  const match = await prisma.tournamentMatch.update({ where: { id: matchId }, data }).catch(() => null);
  if (!match) return { ok: false, error: 'partida não encontrada' };
  return { ok: true, match: { id: match.id, referee1: match.referee1, referee2: match.referee2, referee3: match.referee3, scorer: match.scorer, timekeeper: match.timekeeper } };
}

// Fecha a súmula: conta os gols (eventos GOAL) e aplica o placar pelo engine
// (vira FINISHED, recalcula classificação e avança a chave). Se vier empate no
// mata-mata, o desempate por PÊNALTIS define o vencedor (sem contar como gol).
async function finalizeMatch(matchId, opts = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, homeEntryId: true, awayEntryId: true, stage: true },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  if (!match.homeEntryId || !match.awayEntryId) return { ok: false, error: 'partida sem os dois times definidos' };

  // Arbitragem opcional junto do fechamento
  await setOfficials(matchId, opts).catch(() => {});

  const goals = await prisma.matchEvent.findMany({ where: { matchId, type: 'GOAL' }, select: { entryId: true } });
  const hs = goals.filter((g) => g.entryId === match.homeEntryId).length;
  const as = goals.filter((g) => g.entryId === match.awayEntryId).length;

  // Pênaltis (desempate) — só valem quando o tempo normal empatou.
  const hasPk = opts.homePenalties != null && opts.homePenalties !== '' && opts.awayPenalties != null && opts.awayPenalties !== '';
  const hp = hasPk ? Number(opts.homePenalties) : null;
  const ap = hasPk ? Number(opts.awayPenalties) : null;
  // Pênaltis só decidem no mata-mata; em liga/grupo o empate é legítimo (1 ponto).
  const isKnockout = !['LEAGUE', 'GROUP'].includes(match.stage);
  let winnerEntryId = null;
  let decidedByPenalties = false;
  if (hasPk && isKnockout && hs === as && hp !== ap) {
    winnerEntryId = hp > ap ? match.homeEntryId : match.awayEntryId;
    decidedByPenalties = true;
  }

  const res = await engine.applyMatchResult(matchId, { homeScore: hs, awayScore: as, winnerEntryId });
  if (!res.ok) return res;

  // Persiste o placar de pênaltis pra súmula (não altera gols/classificação).
  if (hasPk) {
    await prisma.tournamentMatch.update({
      where: { id: matchId },
      data: { homePenalties: hp, awayPenalties: ap, decidedByPenalties },
    }).catch(() => {});
  }
  return { ...res, homePenalties: hp, awayPenalties: ap, decidedByPenalties };
}

// Ranking de jogadores de um torneio (ou categoria): artilharia/assistências/cartões.
async function playerStats(tournamentId, opts = {}) {
  const where = { tournamentId };
  if (opts.categoryId) where.categoryId = opts.categoryId;
  const matches = await prisma.tournamentMatch.findMany({
    where,
    select: { id: true, status: true, homeEntryId: true, awayEntryId: true },
  });
  const matchIds = matches.map((m) => m.id);
  if (!matchIds.length) return [];

  // Jogos disputados por time (entry) = partidas encerradas (FINISHED/WALKOVER).
  // Serve pra coluna "J" e pra média (gols por jogo) do ranking.
  const gamesByEntry = {};
  for (const m of matches) {
    if (m.status !== 'FINISHED' && m.status !== 'WALKOVER') continue;
    if (m.homeEntryId) gamesByEntry[m.homeEntryId] = (gamesByEntry[m.homeEntryId] || 0) + 1;
    if (m.awayEntryId) gamesByEntry[m.awayEntryId] = (gamesByEntry[m.awayEntryId] || 0) + 1;
  }

  let types;
  if (opts.kind === 'assists') types = ['ASSIST'];
  else if (opts.kind === 'cards') types = ['YELLOW', 'RED'];
  else types = ['GOAL'];

  const events = await prisma.matchEvent.findMany({
    where: { matchId: { in: matchIds }, type: { in: types }, playerId: { not: null } },
    select: { playerId: true, type: true },
  });
  if (!events.length) return [];

  const pids = [...new Set(events.map((e) => e.playerId))];
  const players = await prisma.rosterPlayer.findMany({
    where: { id: { in: pids } },
    select: { id: true, name: true, number: true, entryId: true },
  });
  const pById = Object.fromEntries(players.map((p) => [p.id, p]));
  const entryIds = [...new Set(players.map((p) => p.entryId))];
  const entries = await prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, name: true } });
  const teamById = Object.fromEntries(entries.map((e) => [e.id, e.name]));

  const agg = {};
  for (const ev of events) {
    const p = pById[ev.playerId];
    if (!p) continue;
    const k = ev.playerId;
    agg[k] = agg[k] || { playerId: k, name: p.name, number: p.number, entryId: p.entryId, team: teamById[p.entryId] || '', games: gamesByEntry[p.entryId] || 0, goals: 0, assists: 0, yellow: 0, red: 0, total: 0 };
    if (ev.type === 'GOAL') agg[k].goals += 1;
    else if (ev.type === 'ASSIST') agg[k].assists += 1;
    else if (ev.type === 'YELLOW') agg[k].yellow += 1;
    else if (ev.type === 'RED') agg[k].red += 1;
    agg[k].total += 1;
  }
  const rows = Object.values(agg);
  // Média por jogo do time (artilheiro/assistência). Null quando o time ainda não encerrou jogo.
  for (const r of rows) {
    const main = opts.kind === 'assists' ? r.assists : opts.kind === 'cards' ? r.total : r.goals;
    r.avg = r.games > 0 ? Math.round((main / r.games) * 100) / 100 : null;
  }
  const key = opts.kind === 'assists' ? 'assists' : opts.kind === 'cards' ? 'total' : 'goals';
  rows.sort((a, b) => b[key] - a[key] || String(a.name).localeCompare(String(b.name)));
  return rows;
}

module.exports = { buildSheet, addEvent, deleteEvent, finalizeMatch, setOfficials, playerStats };
