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
const discipline = require('./tournamentDiscipline');

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

  // Suspensos PARA ESTE JOGO (calculado dos jogos encerrados) + liberações auditadas.
  // Nunca derruba a súmula: se der erro, segue sem a informação.
  let suspensions = [];
  let overrides = [];
  try {
    const r = await discipline.suspensionsForMatch(matchId);
    suspensions = Object.values(r.byPlayer).map((x) => ({
      playerId: x.playerId, entryId: x.entryId, name: x.name, reasonText: x.reasonText, gamesRemaining: x.gamesRemaining,
    }));
    overrides = await discipline.overridesForMatch(matchId);
  } catch (e) {
    console.error('[matchSheet] suspensões:', e.message);
  }
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
      lineup: match.lineup || null,
    },
    home, away, events,
    suspensions, overrides,
    liveScore: { home: hid ? count(hid, 'GOAL') : 0, away: aid ? count(aid, 'GOAL') : 0 },
    fouls: { home: hid ? count(hid, 'FOUL') : 0, away: aid ? count(aid, 'FOUL') : 0 },
  };
}

// ctx: { userId, canOverride } — canOverride = árbitro do jogo / coordenador
async function addEvent(matchId, body = {}, ctx = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, homeEntryId: true, awayEntryId: true, status: true },
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
    // SUSPENSÃO: atleta suspenso não pode ter evento no jogo, salvo liberação
    // explícita do árbitro/coordenador com motivo (fica auditado).
    const g = await discipline.guardPlayer(matchId, playerId, {
      override: body.overrideSuspension === true || body.overrideSuspension === 'true',
      reason: body.overrideReason,
      canOverride: !!ctx.canOverride,
      userId: ctx.userId || null,
      action: 'EVENT',
      eventType: type,
      entryId,
    });
    if (!g.ok) return g;
  }
  const event = await prisma.matchEvent.create({
    data: {
      matchId, entryId, playerId, type,
      minute: body.minute != null && body.minute !== '' ? Number(body.minute) : null,
      period: body.period != null && body.period !== '' ? Number(body.period) : null,
      note: body.note ? String(body.note).slice(0, 200) : null,
    },
  });
  // AO VIVO: o 1º lance da súmula põe o jogo no ar (SCHEDULED → LIVE).
  // Jogo encerrado/W.O./cancelado NÃO volta pra ao vivo.
  let wentLive = false;
  if (match.status === 'SCHEDULED') {
    const r = await prisma.tournamentMatch.updateMany({ where: { id: matchId, status: 'SCHEDULED' }, data: { status: 'LIVE' } });
    wentLive = r.count > 0;
  }
  return { ok: true, event, wentLive };
}

// Escalação do jogo (por time). Atleta suspenso fica BLOQUEADO; árbitro/coordenador
// pode liberar com motivo (auditado). body: { entryId, playerIds:[], overrideSuspension, overrideReason }
async function setLineup(matchId, body = {}, ctx = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    select: { id: true, homeEntryId: true, awayEntryId: true, lineup: true },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  const entryId = String(body.entryId || '');
  if (![match.homeEntryId, match.awayEntryId].includes(entryId)) return { ok: false, error: 'time não é desta partida' };
  const wanted = [...new Set((Array.isArray(body.playerIds) ? body.playerIds : []).map(String))];
  const roster = await prisma.rosterPlayer.findMany({ where: { entryId, id: { in: wanted } }, select: { id: true } });
  if (roster.length !== wanted.length) return { ok: false, error: 'jogador não é deste time' };
  const current = (match.lineup && typeof match.lineup === 'object' ? match.lineup : {})[entryId] || [];
  const added = wanted.filter((id) => !current.includes(id));
  const blocked = [];
  const over = body.overrideSuspension === true || body.overrideSuspension === 'true';
  for (const pid of added) {
    const g = await discipline.guardPlayer(matchId, pid, {
      override: over, reason: body.overrideReason, canOverride: !!ctx.canOverride,
      userId: ctx.userId || null, action: 'LINEUP', entryId,
    });
    if (!g.ok) blocked.push(g);
  }
  if (blocked.length) {
    const b = blocked[0];
    return { ok: false, code: b.code, error: b.error, suspension: b.suspension, blocked: blocked.map((x) => x.suspension && x.suspension.playerId) };
  }
  const lineup = { ...(match.lineup && typeof match.lineup === 'object' ? match.lineup : {}), [entryId]: wanted };
  await prisma.tournamentMatch.update({ where: { id: matchId }, data: { lineup } });
  return { ok: true, lineup };
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
  const isKnockout = !engine.isLeagueStage(match.stage);
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
// opts.scope:
//   'official' (padrão) → SÓ jogos ENCERRADOS (FINISHED/WALKOVER). É o ranking oficial.
//   'live'              → oficial + jogos em andamento/não fechados; cada linha traz
//                         live (o que veio de jogo não encerrado) e partial:true.
async function playerStats(tournamentId, opts = {}) {
  const where = { tournamentId };
  if (opts.categoryId) where.categoryId = opts.categoryId;
  const scope = opts.scope === 'live' ? 'live' : 'official';
  const matches = await prisma.tournamentMatch.findMany({
    where,
    select: { id: true, status: true, homeEntryId: true, awayEntryId: true },
  });
  if (!matches.length) return [];
  const isDone = (m) => m.status === 'FINISHED' || m.status === 'WALKOVER';
  const doneIds = new Set(matches.filter(isDone).map((m) => m.id));
  const matchIds = scope === 'live'
    ? matches.filter((m) => m.status !== 'CANCELED').map((m) => m.id)
    : [...doneIds];
  if (!matchIds.length) return [];

  // Jogos disputados por time (entry) = partidas encerradas (FINISHED/WALKOVER).
  // Serve pra coluna "J" e pra média (gols por jogo) do ranking.
  const gamesByEntry = {};
  for (const m of matches) {
    if (!isDone(m)) continue;
    if (m.homeEntryId) gamesByEntry[m.homeEntryId] = (gamesByEntry[m.homeEntryId] || 0) + 1;
    if (m.awayEntryId) gamesByEntry[m.awayEntryId] = (gamesByEntry[m.awayEntryId] || 0) + 1;
  }

  let types;
  if (opts.kind === 'assists') types = ['ASSIST'];
  else if (opts.kind === 'cards') types = ['YELLOW', 'RED'];
  else types = ['GOAL'];

  const events = await prisma.matchEvent.findMany({
    where: { matchId: { in: matchIds }, type: { in: types }, playerId: { not: null } },
    select: { playerId: true, type: true, matchId: true },
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

  const FIELD = { GOAL: 'goals', ASSIST: 'assists', YELLOW: 'yellow', RED: 'red' };
  const agg = {};
  for (const ev of events) {
    const p = pById[ev.playerId];
    if (!p) continue;
    const k = ev.playerId;
    agg[k] = agg[k] || {
      playerId: k, name: p.name, number: p.number, entryId: p.entryId, team: teamById[p.entryId] || '',
      games: gamesByEntry[p.entryId] || 0, goals: 0, assists: 0, yellow: 0, red: 0, total: 0,
    };
    const f = FIELD[ev.type];
    if (f) agg[k][f] += 1;
    agg[k].total += 1;
    if (scope === 'live' && !doneIds.has(ev.matchId)) {
      agg[k].live = agg[k].live || { goals: 0, assists: 0, yellow: 0, red: 0, total: 0 };
      if (f) agg[k].live[f] += 1;
      agg[k].live.total += 1;
      agg[k].partial = true;
    }
  }
  const rows = Object.values(agg);
  // Média por jogo do time (artilheiro/assistência) — só com o OFICIAL. Null quando o time ainda não encerrou jogo.
  for (const r of rows) {
    const main = opts.kind === 'assists' ? r.assists : opts.kind === 'cards' ? r.total : r.goals;
    const liveMain = r.live ? (opts.kind === 'assists' ? r.live.assists : opts.kind === 'cards' ? r.live.total : r.live.goals) : 0;
    r.avg = r.games > 0 ? Math.round(((main - liveMain) / r.games) * 100) / 100 : null;
    if (scope === 'live') r.partial = !!r.partial;
  }
  const key = opts.kind === 'assists' ? 'assists' : opts.kind === 'cards' ? 'total' : 'goals';
  rows.sort((a, b) => b[key] - a[key] || String(a.name).localeCompare(String(b.name)));
  return rows;
}

module.exports = { buildSheet, addEvent, deleteEvent, finalizeMatch, setOfficials, setLineup, playerStats };
