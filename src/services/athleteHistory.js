// =====================================================================
// Liga Aberta F2 — HISTÓRICO ÚNICO DO ATLETA entre ligas
// ---------------------------------------------------------------------
// Junta as duas formas de um atleta jogar:
//   - EntryMember      (tênis, beach tennis, padel: o atleta É a inscrição)
//   - RosterPlayer.userId (futsal, society, vôlei: nome do elenco reivindicado/ligado à conta)
// e conta, só em jogos ENCERRADOS (status FINISHED ou WALKOVER):
//   jogos, vitórias, empates, derrotas, gols/pontos a favor e contra,
//   gols, assistências, amarelos, vermelhos (MatchEvent pelo playerId do elenco),
//   títulos (campeão da categoria: winnerEntryId da FINAL ou líder dos pontos corridos
//   encerrados — mesma regra de tournamentFormats.categoryChampion)
// por esporte e por temporada (ano em America/Fortaleza).
//
// VISIBILIDADE:
//   - o próprio atleta vê todos os torneios dele (menos os arquivados)
//   - qualquer outro: só os que aparecem em LISTA para ele (público e não arquivado;
//     não listado/privado só se ele for membro do torneio ou admin global)
//   - sem viewer (página pública/arte): só PÚBLICO e não arquivado
// Só LÊ. Nunca grava.
// =====================================================================

const { prisma } = require('../middleware');
const F = require('./tournamentFormats');
const ftz = require('./fortalezaTime');

// Encerrado = FINISHED ou WALKOVER (W.O. conta jogo e vitória/derrota, como no resto do sistema)
const GAME_STATUSES = ['FINISHED', 'WALKOVER'];

function seasonOf(date) {
  if (!date) return null;
  return ftz.partsOf(new Date(date)).year;
}

// Escudo em data URI vira a rota pública do escudo (não embute imagem no histórico/página)
function logoRef(e) {
  if (!e || !e.logoUrl) return null;
  return String(e.logoUrl).startsWith('data:') ? '/api/public/entries/' + e.id + '/logo' : e.logoUrl;
}

function zero() {
  return { games: 0, wins: 0, draws: 0, losses: 0, scoreFor: 0, scoreAgainst: 0, goals: 0, assists: 0, yellow: 0, red: 0, titles: 0 };
}
function add(acc, k, n = 1) { acc[k] = (acc[k] || 0) + n; }

// viewer: { userId, userRole } | null
async function visibleTournamentIds(userId, tournaments, viewer) {
  const access = require('./tournamentAccess');
  const self = !!(viewer && viewer.userId && viewer.userId === userId);
  const out = new Set();
  for (const t of tournaments) {
    if (t.archivedAt) continue;
    // Liga F6: suspenso pela moderação só conta para o dono e o admin global
    if (t.suspendedAt && !(viewer && (require('./tournamentRoles').isGlobalAdmin(viewer.userRole) || (viewer.userId && viewer.userId === t.ownerId)))) continue;
    if (self) { out.add(t.id); continue; }
    if (!viewer || !viewer.userId) { if (access.normalizeVisibility(t.visibility) === 'public') out.add(t.id); continue; }
    if (await access.canSeeListed(viewer, t)) out.add(t.id);
  }
  return out;
}

async function history(userId, { viewer = null } = {}) {
  const uid = String(userId);
  const [members, roster] = await Promise.all([
    prisma.entryMember.findMany({ where: { userId: uid }, select: { entryId: true } }),
    prisma.rosterPlayer.findMany({ where: { userId: uid }, select: { id: true, entryId: true, role: true, name: true, number: true } }),
  ]);
  // entries em que o atleta JOGA (comissão técnica não conta jogo — conta cartão)
  const playEntryIds = new Set(members.map((m) => m.entryId));
  roster.filter((r) => (r.role || 'PLAYER') === 'PLAYER').forEach((r) => playEntryIds.add(r.entryId));
  const allEntryIds = new Set([...playEntryIds, ...roster.map((r) => r.entryId)]);
  const empty = { userId: uid, totals: zero(), bySport: [], bySeason: [], tournaments: [], titles: [], seasons: [] };
  if (!allEntryIds.size) return empty;

  const entries = await prisma.tournamentEntry.findMany({
    where: { id: { in: [...allEntryIds] } },
    select: { id: true, name: true, logoUrl: true, tournamentId: true, categoryId: true },
  });
  const tIds = [...new Set(entries.map((e) => e.tournamentId))];
  const tournaments = await prisma.tournament.findMany({
    where: { id: { in: tIds } },
    select: { id: true, name: true, slug: true, sport: true, visibility: true, archivedAt: true, suspendedAt: true, ownerId: true, startDate: true, status: true, seriesName: true, edition: true },
  });
  const visible = await visibleTournamentIds(uid, tournaments, viewer);
  const tById = new Map(tournaments.filter((t) => visible.has(t.id)).map((t) => [t.id, t]));
  const myEntries = entries.filter((e) => tById.has(e.tournamentId));
  if (!myEntries.length) return empty;
  const eById = new Map(myEntries.map((e) => [e.id, e]));
  const playIds = myEntries.filter((e) => playEntryIds.has(e.id)).map((e) => e.id);

  // nome/escudo do clube (Liga F2) — saída apenas
  await require('./clubIdentity').brand(myEntries);

  const totals = zero();
  const bySport = new Map();
  const bySeason = new Map();
  const byT = new Map();
  const bucket = (map, key, extra) => { if (!map.has(key)) map.set(key, { ...extra, ...zero() }); return map.get(key); };
  const tBucket = (tid) => {
    if (!byT.has(tid)) {
      const t = tById.get(tid);
      const ents = myEntries.filter((e) => e.tournamentId === tid);
      byT.set(tid, {
        tournamentId: tid, name: t.name, slug: t.slug, sport: t.sport, status: t.status,
        visibility: t.visibility || 'public', season: seasonOf(t.startDate), lastAt: null,
        teams: [...new Map(ents.map((e) => [e.name, { name: e.name, logoUrl: logoRef(e), clubSlug: e.clubSlug || null }])).values()],
        ...zero(),
      });
    }
    return byT.get(tid);
  };
  myEntries.forEach((e) => tBucket(e.tournamentId));
  const touch = (tid, sport, season, k, n = 1) => {
    add(totals, k, n);
    add(bucket(bySport, sport, { sport }), k, n);
    if (season != null) add(bucket(bySeason, season, { season }), k, n);
    add(tBucket(tid), k, n);
  };

  // ---- jogos encerrados
  const matches = playIds.length ? await prisma.tournamentMatch.findMany({
    where: { status: { in: GAME_STATUSES }, OR: [{ homeEntryId: { in: playIds } }, { awayEntryId: { in: playIds } }] },
    select: { id: true, tournamentId: true, categoryId: true, homeEntryId: true, awayEntryId: true, homeScore: true, awayScore: true, winnerEntryId: true, scheduledAt: true, updatedAt: true },
  }) : [];
  const playSet = new Set(playIds);
  const matchSeason = new Map();
  for (const m of matches) {
    const t = tById.get(m.tournamentId);
    if (!t) continue;
    const mine = playSet.has(m.homeEntryId) ? m.homeEntryId : m.awayEntryId;
    const isHome = mine === m.homeEntryId;
    const when = m.scheduledAt || m.updatedAt;
    const season = seasonOf(when);
    matchSeason.set(m.id, season);
    const tb = tBucket(m.tournamentId);
    if (!tb.lastAt || when > tb.lastAt) tb.lastAt = when;
    if (tb.season == null) tb.season = season;
    touch(m.tournamentId, t.sport, season, 'games');
    const my = isHome ? m.homeScore : m.awayScore;
    const op = isHome ? m.awayScore : m.homeScore;
    touch(m.tournamentId, t.sport, season, 'scoreFor', my || 0);
    touch(m.tournamentId, t.sport, season, 'scoreAgainst', op || 0);
    let res;
    if (m.winnerEntryId) res = m.winnerEntryId === mine ? 'wins' : 'losses';
    else if (my != null && op != null) res = my > op ? 'wins' : my < op ? 'losses' : 'draws';
    else res = 'draws';
    touch(m.tournamentId, t.sport, season, res);
  }

  // ---- súmula (gols, assistências, cartões) dos nomes do elenco ligados à conta
  const myRoster = roster.filter((r) => eById.has(r.entryId));
  if (myRoster.length) {
    const finishedIds = await prisma.tournamentMatch.findMany({
      where: { status: { in: GAME_STATUSES }, tournamentId: { in: [...tById.keys()] }, OR: [{ homeEntryId: { in: myRoster.map((r) => r.entryId) } }, { awayEntryId: { in: myRoster.map((r) => r.entryId) } }] },
      select: { id: true, tournamentId: true, scheduledAt: true, updatedAt: true },
    });
    const mInfo = new Map(finishedIds.map((m) => [m.id, m]));
    if (mInfo.size) {
      const evs = await prisma.matchEvent.findMany({
        where: { playerId: { in: myRoster.map((r) => r.id) }, matchId: { in: [...mInfo.keys()] }, type: { in: ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'PT1', 'PT2', 'PT3'] } },
        select: { type: true, matchId: true },
      });
      // Liga F3: no basquete os "gols" são os pontos das cestas (PT1/PT2/PT3 = 1/2/3)
      const key = { GOAL: 'goals', ASSIST: 'assists', YELLOW: 'yellow', RED: 'red', PT1: 'goals', PT2: 'goals', PT3: 'goals' };
      const val = { PT1: 1, PT2: 2, PT3: 3 };
      for (const ev of evs) {
        const m = mInfo.get(ev.matchId);
        const t = tById.get(m.tournamentId);
        const season = matchSeason.has(m.id) ? matchSeason.get(m.id) : seasonOf(m.scheduledAt || m.updatedAt);
        touch(m.tournamentId, t.sport, season, key[ev.type], val[ev.type] || 1);
      }
    }
  }

  // ---- títulos (campeão da categoria)
  const titles = [];
  const catIds = [...new Set(myEntries.filter((e) => playSet.has(e.id)).map((e) => e.categoryId))];
  if (catIds.length) {
    const [cats, catMatches, catStandings] = await Promise.all([
      prisma.tournamentCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true, tournamentId: true, formatConfig: true } }),
      prisma.tournamentMatch.findMany({ where: { categoryId: { in: catIds } }, select: { categoryId: true, stage: true, status: true, round: true, homeEntryId: true, awayEntryId: true, winnerEntryId: true, scheduledAt: true, updatedAt: true } }),
      prisma.tournamentStanding.findMany({ where: { categoryId: { in: catIds } }, select: { categoryId: true, entryId: true, rank: true } }),
    ]);
    for (const c of cats) {
      const ms = catMatches.filter((m) => m.categoryId === c.id);
      if (!ms.length) continue;
      const cfg = c.formatConfig && typeof c.formatConfig === 'object' ? c.formatConfig : {};
      const champ = F.categoryChampion(ms, catStandings.filter((s) => s.categoryId === c.id), { swissRounds: Number(cfg.rounds) || null });
      if (!champ || !champ.championId || !playSet.has(champ.championId)) continue;
      const t = tById.get(c.tournamentId);
      const last = ms.reduce((a, m) => { const w = m.scheduledAt || m.updatedAt; return !a || (w && w > a) ? w : a; }, null);
      const season = seasonOf(last) || seasonOf(t.startDate);
      const e = eById.get(champ.championId);
      touch(c.tournamentId, t.sport, season, 'titles');
      titles.push({ tournamentId: t.id, tournament: t.name, slug: t.slug, sport: t.sport, category: c.name, season, team: e ? e.name : null, decidedBy: champ.source });
    }
  }

  const sortSeason = (a, b) => (b.season || 0) - (a.season || 0);
  const tournamentsOut = [...byT.values()]
    .map((x) => ({ ...x, lastAt: x.lastAt ? new Date(x.lastAt).toISOString() : null }))
    .sort((a, b) => sortSeason(a, b) || String(b.lastAt || '').localeCompare(String(a.lastAt || '')) || a.name.localeCompare(b.name));
  totals.tournaments = tournamentsOut.length;
  return {
    userId: uid,
    totals,
    bySport: [...bySport.values()].sort((a, b) => b.games - a.games || a.sport.localeCompare(b.sport)),
    bySeason: [...bySeason.values()].sort(sortSeason),
    seasons: [...bySeason.keys()].sort((a, b) => b - a),
    tournaments: tournamentsOut,
    titles: titles.sort(sortSeason),
    includesNonPublic: tournamentsOut.some((t) => t.visibility !== 'public'),
  };
}

module.exports = { history, seasonOf };
