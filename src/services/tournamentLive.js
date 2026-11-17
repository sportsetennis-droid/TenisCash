// =====================================================================
// APEX — AO VIVO dos torneios (SSE público, sem dependência nova)
// ---------------------------------------------------------------------
// Canal: GET /api/tournaments/:id/live  (text/event-stream)
// Cada mensagem é `data: {type, ...}` com type =
//   hello | start | event | event_removed | update | end
// O payload de jogo traz placar AO VIVO calculado dos MatchEvent (GOAL),
// cartões e o lance a lance (gol/cartão com nome do jogador e minuto).
//
// Single-instance no Railway → registry em memória basta (mesmo padrão do
// liveBus.js). Postgres continua sendo a fonte da verdade; o SSE é só o
// "empurrão" em tempo real. Se rodar em réplicas, trocar por Redis pub/sub.
//
// ⚠️ O app usa `compression`: o header `Cache-Control: no-transform` faz o
// compression PULAR esta resposta (ele respeita no-transform) e ainda assim
// chamamos res.flush() quando existir — senão o gzip seguraria os eventos.
// =====================================================================

const { prisma } = require('../middleware');

const MAX_PER_TOURNAMENT = 3000; // teto de conexões abertas por torneio
const HEARTBEAT_MS = 20000;
const clients = new Map(); // tournamentId -> Set<res>

const TIMELINE_TYPES = ['GOAL', 'YELLOW', 'RED'];

function flush(res) {
  try { if (typeof res.flush === 'function') res.flush(); } catch (_) { /* ignore */ }
}

function write(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    flush(res);
    return true;
  } catch (_) {
    return false;
  }
}

function connectionCount(tournamentId) {
  const s = clients.get(tournamentId);
  return s ? s.size : 0;
}

// Abre o stream e registra a conexão. Retorna false se recusou (lotado).
function subscribe(tournamentId, req, res) {
  let set = clients.get(tournamentId);
  if (set && set.size >= MAX_PER_TOURNAMENT) {
    res.status(503).set('Retry-After', '30').json({ error: 'muitas conexões ao vivo — use o modo de atualização automática' });
    return false;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch (_) { /* ignore */ } }
  res.write('retry: 4000\n\n');
  res.write(': conectado\n\n');
  flush(res);

  if (!set) { set = new Set(); clients.set(tournamentId, set); }
  set.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); flush(res); } catch (_) { /* fechou */ }
  }, HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(ping);
    const s = clients.get(tournamentId);
    if (s) {
      s.delete(res);
      if (!s.size) clients.delete(tournamentId);
    }
  };
  res.on('close', cleanup);
  if (req && typeof req.on === 'function') req.on('close', cleanup);
  return true;
}

function publish(tournamentId, payload) {
  const set = clients.get(tournamentId);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const res of set) if (write(res, payload)) n++;
  return n;
}

// --------------------------------------------------------------------
// Placar ao vivo + lance a lance a partir dos MatchEvent
// --------------------------------------------------------------------

// Para uma lista de partidas: { [matchId]: { liveScore, cards, timeline[] } }
async function liveDataFor(matches) {
  const ids = (matches || []).map((m) => m.id).filter(Boolean);
  if (!ids.length) return {};
  const events = await prisma.matchEvent.findMany({
    where: { matchId: { in: ids }, type: { in: TIMELINE_TYPES } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, matchId: true, entryId: true, playerId: true, type: true, minute: true, period: true, createdAt: true },
  });
  const pids = [...new Set(events.map((e) => e.playerId).filter(Boolean))];
  const players = pids.length
    ? await prisma.rosterPlayer.findMany({ where: { id: { in: pids } }, select: { id: true, name: true, number: true } })
    : [];
  const pById = Object.fromEntries(players.map((p) => [p.id, p]));
  const byMatch = {};
  for (const m of matches) {
    byMatch[m.id] = {
      liveScore: { home: 0, away: 0 },
      cards: { home: { yellow: 0, red: 0 }, away: { yellow: 0, red: 0 } },
      timeline: [],
    };
  }
  const mById = Object.fromEntries(matches.map((m) => [m.id, m]));
  for (const e of events) {
    const m = mById[e.matchId];
    const d = byMatch[e.matchId];
    if (!m || !d) continue;
    const side = e.entryId === m.homeEntryId ? 'home' : e.entryId === m.awayEntryId ? 'away' : null;
    if (!side) continue;
    if (e.type === 'GOAL') d.liveScore[side] += 1;
    else if (e.type === 'YELLOW') d.cards[side].yellow += 1;
    else if (e.type === 'RED') d.cards[side].red += 1;
    const p = e.playerId ? pById[e.playerId] : null;
    d.timeline.push({
      id: e.id, type: e.type, side, minute: e.minute, period: e.period,
      player: p ? p.name : null, number: p ? p.number : null,
    });
  }
  return byMatch;
}

// Anexa liveScore/cards/timeline nas partidas (mutável) — usado nas rotas públicas.
async function attachLive(matches) {
  const data = await liveDataFor(matches);
  for (const m of matches) {
    const d = data[m.id];
    if (!d) continue;
    m.timeline = d.timeline;
    m.cards = d.cards;
    if (m.status === 'LIVE' || d.timeline.length) m.liveScore = d.liveScore;
  }
  return matches;
}

// Retrato completo de uma partida pro SSE.
async function matchSnapshot(matchId) {
  const m = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: {
      id: true, tournamentId: true, categoryId: true, status: true, stage: true, groupName: true, round: true,
      scheduledAt: true, location: true, homeEntryId: true, awayEntryId: true,
      homeScore: true, awayScore: true, winnerEntryId: true,
      homePenalties: true, awayPenalties: true, decidedByPenalties: true, liveState: true,
      homeEntry: { select: { id: true, name: true } },
      awayEntry: { select: { id: true, name: true } },
    },
  });
  if (!m) return null;
  const d = (await liveDataFor([m]))[m.id];
  return { ...m, liveScore: d.liveScore, cards: d.cards, timeline: d.timeline };
}

// Emite a atualização de um jogo pra todos que assistem o torneio. Nunca lança.
async function emitMatch(matchId, type, extra = {}) {
  try {
    const snap = await matchSnapshot(matchId);
    if (!snap) return 0;
    let last = null;
    if (extra.eventId) last = snap.timeline.find((t) => t.id === extra.eventId) || null;
    return publish(snap.tournamentId, { type, at: new Date().toISOString(), match: snap, last, ...extra });
  } catch (e) {
    console.error('[tournamentLive] emit', e.message);
    return 0;
  }
}

module.exports = { subscribe, publish, emitMatch, matchSnapshot, liveDataFor, attachLive, connectionCount };
