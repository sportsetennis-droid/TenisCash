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

// Fecha a súmula: conta os gols (eventos GOAL) e aplica o placar pelo engine
// (vira FINISHED, recalcula classificação e avança a chave).
async function finalizeMatch(matchId) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, homeEntryId: true, awayEntryId: true },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  if (!match.homeEntryId || !match.awayEntryId) return { ok: false, error: 'partida sem os dois times definidos' };
  const goals = await prisma.matchEvent.findMany({ where: { matchId, type: 'GOAL' }, select: { entryId: true } });
  const hs = goals.filter((g) => g.entryId === match.homeEntryId).length;
  const as = goals.filter((g) => g.entryId === match.awayEntryId).length;
  return engine.applyMatchResult(matchId, { homeScore: hs, awayScore: as });
}

// Ranking de jogadores de um torneio (ou categoria): artilharia/assistências/cartões.
async function playerStats(tournamentId, opts = {}) {
  const where = { tournamentId };
  if (opts.categoryId) where.categoryId = opts.categoryId;
  const matches = await prisma.tournamentMatch.findMany({ where, select: { id: true } });
  const matchIds = matches.map((m) => m.id);
  if (!matchIds.length) return [];

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
    agg[k] = agg[k] || { playerId: k, name: p.name, number: p.number, team: teamById[p.entryId] || '', goals: 0, assists: 0, yellow: 0, red: 0, total: 0 };
    if (ev.type === 'GOAL') agg[k].goals += 1;
    else if (ev.type === 'ASSIST') agg[k].assists += 1;
    else if (ev.type === 'YELLOW') agg[k].yellow += 1;
    else if (ev.type === 'RED') agg[k].red += 1;
    agg[k].total += 1;
  }
  const rows = Object.values(agg);
  const key = opts.kind === 'assists' ? 'assists' : opts.kind === 'cards' ? 'total' : 'goals';
  rows.sort((a, b) => b[key] - a[key] || String(a.name).localeCompare(String(b.name)));
  return rows;
}

module.exports = { buildSheet, addEvent, deleteEvent, finalizeMatch, playerStats };
