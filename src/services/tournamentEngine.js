// =====================================================================
// APEX COMPETIÇÃO — Tournament Engine
// =====================================================================
// Motor de torneios: gera chaveamento (pontos corridos + mata-mata),
// recalcula classificação, aplica resultado de partida (com avanço
// automático na chave) e atualiza o rating do atleta (escala 0-7).
//
// Reutiliza o mesmo Postgres/User do TenisCash. Nada de movimento REAL
// de saldo aqui — premiação/inscrição em TenisCash é fase 2 (gated).
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ---------------------------------------------------------------------
// Utils de chaveamento
// ---------------------------------------------------------------------

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// Ordem padrão de cabeças de chave para um bracket de tamanho `size`
// (potência de 2). Ex.: size 8 → [1,8,4,5,2,7,3,6].
function seedSlots(size) {
  let seeds = [1, 2];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next = [];
    for (const s of seeds) {
      next.push(s);
      next.push(n + 1 - s);
    }
    seeds = next;
  }
  return seeds;
}

// Rótulo da fase do mata-mata pela qtd de partidas na rodada.
function stageLabel(matchesInRound) {
  return (
    { 1: 'FINAL', 2: 'SEMI', 4: 'QUARTER', 8: 'RO16', 16: 'RO32', 32: 'RO64', 64: 'RO128' }[
      matchesInRound
    ] || `R${matchesInRound * 2}`
  );
}

// Método do círculo (round-robin): retorna array de rodadas,
// cada rodada = array de pares [home, away]. `null` = bye (descartado).
function roundRobinRounds(entries) {
  const list = [...entries];
  if (list.length % 2 === 1) list.push(null);
  const n = list.length;
  const rounds = [];
  const fixed = list[0];
  let rotating = list.slice(1);

  for (let r = 0; r < n - 1; r++) {
    const arr = [fixed, ...rotating];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home && away) pairs.push([home, away]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
  }
  return rounds;
}

// ---------------------------------------------------------------------
// Geração de fixtures
// ---------------------------------------------------------------------

/**
 * Gera as partidas de uma categoria a partir dos inscritos CONFIRMED.
 * Idempotente: apaga partidas/standings anteriores e recria.
 */
async function generateFixtures(categoryId) {
  const category = await prisma.tournamentCategory.findUnique({
    where: { id: categoryId },
    include: {
      tournament: true,
      entries: {
        where: { status: 'CONFIRMED' },
        orderBy: [{ seed: 'asc' }, { createdAt: 'asc' }],
      },
    },
  });
  if (!category) return { ok: false, error: 'categoria não encontrada' };

  const entries = category.entries;
  if (entries.length < 2) return { ok: false, error: 'mínimo 2 inscritos confirmados' };

  const format = category.format || category.tournament.format || 'KNOCKOUT';

  // limpa fixtures antigos (idempotente)
  await prisma.tournamentMatch.deleteMany({ where: { categoryId } });
  await prisma.tournamentStanding.deleteMany({ where: { categoryId } });

  if (format === 'ROUND_ROBIN' || format === 'GROUPS') {
    return generateRoundRobin(category, entries, format);
  }
  // KNOCKOUT (e GROUPS_KNOCKOUT cai no mata-mata por ora — fase de grupos é TODO)
  return generateKnockout(category, entries);
}

async function generateRoundRobin(category, entries, format) {
  // GROUPS: agrupa por groupName (default "A"); senão grupo único
  const groups = {};
  if (format === 'GROUPS') {
    for (const e of entries) (groups[e.groupName || 'A'] ||= []).push(e);
  } else {
    groups['_'] = entries;
  }

  const matchesData = [];
  for (const [gName, gEntries] of Object.entries(groups)) {
    if (gEntries.length < 2) continue;
    const rounds = roundRobinRounds(gEntries);
    rounds.forEach((pairs, ri) => {
      pairs.forEach(([home, away], oi) => {
        matchesData.push({
          tournamentId: category.tournamentId,
          categoryId: category.id,
          stage: format === 'GROUPS' ? 'GROUP' : 'LEAGUE',
          round: ri + 1,
          groupName: format === 'GROUPS' ? gName : null,
          ordering: oi,
          homeEntryId: home.id,
          awayEntryId: away.id,
          status: 'SCHEDULED',
        });
      });
    });
  }

  await prisma.tournamentMatch.createMany({ data: matchesData });
  await seedStandings(category, entries);

  return { ok: true, format, matchesCreated: matchesData.length };
}

async function seedStandings(category, entries) {
  await prisma.tournamentStanding.createMany({
    data: entries.map((e) => ({
      tournamentId: category.tournamentId,
      categoryId: category.id,
      entryId: e.id,
      groupName: e.groupName || null,
    })),
    skipDuplicates: true,
  });
}

async function generateKnockout(category, entries) {
  const n = entries.length;
  const size = nextPow2(n);
  const slots = seedSlots(size); // seed numbers em ordem de slot
  const roundsCount = Math.log2(size);

  // seed 1..n na ordem dos entries (já ordenados por seed/createdAt)
  const bySeed = {};
  entries.forEach((e, i) => {
    bySeed[i + 1] = e;
  });

  // Cria as rodadas da FINAL pra trás, guardando a rodada posterior
  // pra linkar nextMatchId/nextSlot das partidas anteriores.
  let laterRound = null;
  const allRounds = {}; // round number -> [matches]

  for (let r = roundsCount; r >= 1; r--) {
    const matchesInRound = size / Math.pow(2, r); // final r=roundsCount → 1
    const thisRound = [];
    for (let m = 0; m < matchesInRound; m++) {
      const isFinal = r === roundsCount;
      const next = isFinal ? null : laterRound[Math.floor(m / 2)];
      const created = await prisma.tournamentMatch.create({
        data: {
          tournamentId: category.tournamentId,
          categoryId: category.id,
          stage: stageLabel(matchesInRound),
          round: r,
          ordering: m,
          status: 'SCHEDULED',
          nextMatchId: next ? next.id : null,
          nextSlot: isFinal ? null : m % 2 === 0 ? 'home' : 'away',
        },
      });
      thisRound.push(created);
    }
    allRounds[r] = thisRound;
    laterRound = thisRound;
  }

  // Preenche a rodada 1 com os inscritos conforme o seeding
  const round1 = allRounds[1];
  for (let m = 0; m < round1.length; m++) {
    const homeEntry = bySeed[slots[2 * m]];
    const awayEntry = bySeed[slots[2 * m + 1]];
    const match = await prisma.tournamentMatch.update({
      where: { id: round1[m].id },
      data: {
        homeEntryId: homeEntry ? homeEntry.id : null,
        awayEntryId: awayEntry ? awayEntry.id : null,
      },
    });
    round1[m] = match;
  }

  // Resolve byes da rodada 1 (um lado vazio → o outro avança)
  for (const m of round1) {
    const hasHome = !!m.homeEntryId;
    const hasAway = !!m.awayEntryId;
    if (hasHome !== hasAway) {
      const winnerId = m.homeEntryId || m.awayEntryId;
      await prisma.tournamentMatch.update({
        where: { id: m.id },
        data: { winnerEntryId: winnerId, status: 'WALKOVER' },
      });
      if (m.nextMatchId) {
        await prisma.tournamentMatch.update({
          where: { id: m.nextMatchId },
          data: m.nextSlot === 'away' ? { awayEntryId: winnerId } : { homeEntryId: winnerId },
        });
      }
    }
  }

  const totalMatches = Object.values(allRounds).reduce((s, arr) => s + arr.length, 0);
  return { ok: true, format: 'KNOCKOUT', bracketSize: size, rounds: roundsCount, matchesCreated: totalMatches };
}

// ---------------------------------------------------------------------
// Resultado de partida + avanço de chave
// ---------------------------------------------------------------------

/**
 * Aplica o resultado de uma partida.
 * result = {
 *   games?: [{ setNumber, homeGames, awayGames, homeTiebreak?, awayTiebreak? }],
 *   homeScore?, awayScore?,   // usado se não vierem games
 *   winnerEntryId?            // força o vencedor (W.O., desempate manual)
 * }
 */
async function applyMatchResult(matchId, result = {}) {
  const match = await prisma.tournamentMatch.findUnique({
    where: { id: matchId },
    include: {
      tournament: true,
      category: true,
      homeEntry: { include: { members: true } },
      awayEntry: { include: { members: true } },
    },
  });
  if (!match) return { ok: false, error: 'partida não encontrada' };
  if (!match.homeEntryId || !match.awayEntryId) {
    return { ok: false, error: 'partida ainda sem os dois inscritos definidos' };
  }

  // Grava sets (se vierem) e conta sets vencidos
  let hs = 0;
  let as = 0;
  if (Array.isArray(result.games) && result.games.length) {
    await prisma.matchGame.deleteMany({ where: { matchId } });
    for (const g of result.games) {
      const homeGames = Number(g.homeGames) || 0;
      const awayGames = Number(g.awayGames) || 0;
      await prisma.matchGame.create({
        data: {
          matchId,
          setNumber: Number(g.setNumber),
          homeGames,
          awayGames,
          homeTiebreak: g.homeTiebreak ?? null,
          awayTiebreak: g.awayTiebreak ?? null,
        },
      });
      if (homeGames > awayGames) hs++;
      else if (awayGames > homeGames) as++;
    }
  } else {
    hs = Number(result.homeScore) || 0;
    as = Number(result.awayScore) || 0;
  }

  let winnerEntryId = result.winnerEntryId || null;
  if (!winnerEntryId) {
    if (hs > as) winnerEntryId = match.homeEntryId;
    else if (as > hs) winnerEntryId = match.awayEntryId;
    // empate (liga) → winnerEntryId fica null
  }

  await prisma.tournamentMatch.update({
    where: { id: matchId },
    data: { homeScore: hs, awayScore: as, winnerEntryId, status: 'FINISHED', liveState: null },
  });

  // Avanço automático na chave
  if (match.nextMatchId && winnerEntryId) {
    await prisma.tournamentMatch.update({
      where: { id: match.nextMatchId },
      data: match.nextSlot === 'away' ? { awayEntryId: winnerEntryId } : { homeEntryId: winnerEntryId },
    });
  }

  // Classificação (liga/grupos)
  if (match.stage === 'LEAGUE' || match.stage === 'GROUP') {
    await recomputeStandings(match.categoryId);
  }

  // Rating do atleta (escala 0-7)
  if (winnerEntryId) {
    await updateRatingsForMatch(match, winnerEntryId);
  }

  return { ok: true, matchId, winnerEntryId, homeScore: hs, awayScore: as };
}

// ---------------------------------------------------------------------
// Classificação (pontos corridos / grupos)
// ---------------------------------------------------------------------

async function recomputeStandings(categoryId) {
  const category = await prisma.tournamentCategory.findUnique({ where: { id: categoryId } });
  if (!category) return [];

  const entries = await prisma.tournamentEntry.findMany({ where: { categoryId } });
  const matches = await prisma.tournamentMatch.findMany({
    where: { categoryId, status: 'FINISHED', stage: { in: ['LEAGUE', 'GROUP'] } },
  });

  const table = {};
  for (const e of entries) {
    table[e.id] = {
      entryId: e.id,
      groupName: e.groupName || null,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      points: 0,
    };
  }

  for (const m of matches) {
    const h = table[m.homeEntryId];
    const a = table[m.awayEntryId];
    if (!h || !a) continue;
    const hs = m.homeScore ?? 0;
    const as = m.awayScore ?? 0;
    h.played++;
    a.played++;
    h.scoreFor += hs;
    h.scoreAgainst += as;
    a.scoreFor += as;
    a.scoreAgainst += hs;
    if (m.winnerEntryId === m.homeEntryId) {
      h.won++;
      a.lost++;
      h.points += category.pointsWin;
      a.points += category.pointsLoss;
    } else if (m.winnerEntryId === m.awayEntryId) {
      a.won++;
      h.lost++;
      a.points += category.pointsWin;
      h.points += category.pointsLoss;
    } else {
      h.drawn++;
      a.drawn++;
      h.points += category.pointsDraw;
      a.points += category.pointsDraw;
    }
  }

  // ordena: pontos → saldo → marcados; rank dentro de cada grupo
  const rows = Object.values(table);
  const byGroup = {};
  for (const r of rows) (byGroup[r.groupName || '_'] ||= []).push(r);
  for (const g of Object.values(byGroup)) {
    g.sort(
      (x, y) =>
        y.points - x.points ||
        y.scoreFor - y.scoreAgainst - (x.scoreFor - x.scoreAgainst) ||
        y.scoreFor - x.scoreFor
    );
    g.forEach((r, i) => {
      r.rank = i + 1;
    });
  }

  for (const r of rows) {
    await prisma.tournamentStanding.upsert({
      where: { entryId: r.entryId },
      create: { tournamentId: category.tournamentId, categoryId, ...r },
      update: {
        groupName: r.groupName,
        played: r.played,
        won: r.won,
        drawn: r.drawn,
        lost: r.lost,
        scoreFor: r.scoreFor,
        scoreAgainst: r.scoreAgainst,
        points: r.points,
        rank: r.rank,
      },
    });
  }

  return rows;
}

// ---------------------------------------------------------------------
// Rating do atleta — Elo adaptado à escala 0-7
// ---------------------------------------------------------------------

async function getOrCreateRatings(userIds, sport) {
  const out = [];
  for (const userId of userIds) {
    let r = await prisma.athleteRating.findUnique({
      where: { userId_sport: { userId, sport } },
    });
    if (!r) r = await prisma.athleteRating.create({ data: { userId, sport } });
    out.push(r);
  }
  return out;
}

async function applyRatingDelta(ratings, delta, won) {
  for (const r of ratings) {
    const nr = Math.max(0, Math.min(7, r.rating + delta));
    await prisma.athleteRating.update({
      where: { id: r.id },
      data: {
        rating: nr,
        matchesCount: { increment: 1 },
        wins: won ? { increment: 1 } : undefined,
        losses: won ? undefined : { increment: 1 },
        lastMatchAt: new Date(),
      },
    });
  }
}

async function updateRatingsForMatch(match, winnerEntryId) {
  const sport = match.tournament.sport;
  const home = match.homeEntry;
  const away = match.awayEntry;
  if (!home || !away) return;

  const homeUsers = home.members.map((m) => m.userId);
  const awayUsers = away.members.map((m) => m.userId);
  if (!homeUsers.length || !awayUsers.length) return;

  const homeRatings = await getOrCreateRatings(homeUsers, sport);
  const awayRatings = await getOrCreateRatings(awayUsers, sport);
  const ra = avg(homeRatings.map((r) => r.rating));
  const rb = avg(awayRatings.map((r) => r.rating));

  const homeWon = winnerEntryId === home.id;
  const scoreA = homeWon ? 1 : 0;
  // escala comprimida: divisor 2 (não 400) porque o range é 0-7
  const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 2));
  const K = 0.15;
  const deltaA = K * (scoreA - expectedA);

  await applyRatingDelta(homeRatings, deltaA, homeWon);
  await applyRatingDelta(awayRatings, -deltaA, !homeWon);
}

/**
 * Rating de um amistoso 1v1 (PlayChallenge). winnerUserId vs loserUserId.
 */
async function rateHeadToHead(winnerUserId, loserUserId, sport) {
  if (!winnerUserId || !loserUserId || winnerUserId === loserUserId) return;
  const [wr] = await getOrCreateRatings([winnerUserId], sport);
  const [lr] = await getOrCreateRatings([loserUserId], sport);
  const expectedW = 1 / (1 + Math.pow(10, (lr.rating - wr.rating) / 2));
  const K = 0.15;
  const delta = K * (1 - expectedW);
  await applyRatingDelta([wr], delta, true);
  await applyRatingDelta([lr], -delta, false);
}

// ---------------------------------------------------------------------
// Identidade + Card do atleta (estilo FIFA) — reusado pelas rotas e páginas
// ---------------------------------------------------------------------

function yearStart() {
  const now = new Date();
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Fortaleza', year: 'numeric' }).format(now)
  );
  return new Date(Date.UTC(year, 0, 1, 3, 0, 0)); // 01/jan 00:00 Fortaleza
}

// Resolve um userId a partir de id, User.username ou AthleteProfile.username
async function resolveUserId(idOrHandle) {
  if (!idOrHandle) return null;
  const handle = String(idOrHandle).replace(/^@/, '');
  const byId = await prisma.user.findUnique({ where: { id: handle }, select: { id: true } });
  if (byId) return byId.id;
  const byUser = await prisma.user.findUnique({ where: { username: handle }, select: { id: true } });
  if (byUser) return byUser.id;
  const byAthlete = await prisma.athleteProfile.findUnique({
    where: { username: handle },
    select: { userId: true },
  });
  return byAthlete ? byAthlete.userId : null;
}

async function buildAthleteCard(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, username: true, city: true, state: true },
  });
  if (!user) return null;

  const profile = await prisma.athleteProfile.findUnique({ where: { userId } });
  const ratings = await prisma.athleteRating.findMany({ where: { userId }, orderBy: { rating: 'desc' } });
  const since = yearStart();

  const [trainingsTotal, trainingsYear] = await Promise.all([
    prisma.activity.count({ where: { userId } }),
    prisma.activity.count({ where: { userId, startedAt: { gte: since } } }),
  ]);

  const myEntries = await prisma.entryMember.findMany({
    where: { userId },
    select: { entryId: true, entry: { select: { tournamentId: true } } },
  });
  const entryIds = myEntries.map((e) => e.entryId);
  const tournamentsCount = new Set(myEntries.map((e) => e.entry.tournamentId)).size;

  let played = 0;
  let wins = 0;
  let setsFor = 0;
  let setsAgainst = 0;
  let playedYear = 0;
  if (entryIds.length) {
    const matches = await prisma.tournamentMatch.findMany({
      where: {
        status: { in: ['FINISHED', 'WALKOVER'] },
        OR: [{ homeEntryId: { in: entryIds } }, { awayEntryId: { in: entryIds } }],
      },
      select: {
        homeEntryId: true,
        awayEntryId: true,
        winnerEntryId: true,
        homeScore: true,
        awayScore: true,
        updatedAt: true,
      },
    });
    for (const m of matches) {
      const isHome = entryIds.includes(m.homeEntryId);
      played++;
      if (m.updatedAt >= since) playedYear++;
      if (entryIds.includes(m.winnerEntryId)) wins++;
      setsFor += (isHome ? m.homeScore : m.awayScore) || 0;
      setsAgainst += (isHome ? m.awayScore : m.homeScore) || 0;
    }
  }

  const challenges = await prisma.playChallenge.findMany({
    where: { status: 'PLAYED', OR: [{ challengerId: userId }, { challengedId: userId }] },
    select: { winnerId: true },
  });
  const challengeWins = challenges.filter((c) => c.winnerId === userId).length;

  const badges = await prisma.badgeEarned.findMany({
    where: { userId },
    orderBy: { earnedAt: 'desc' },
    take: 12,
  });
  const xpAgg = await prisma.badgeEarned.aggregate({ where: { userId }, _sum: { xpAwarded: true } });

  const totalMatches = played + challenges.length;
  const totalWins = wins + challengeWins;

  return {
    user: {
      id: user.id,
      name: user.name,
      username: user.username || profile?.username || null,
      city: user.city,
      state: user.state,
      avatarUrl: profile?.avatarUrl || null,
      bio: profile?.bio || null,
      experienceLevel: profile?.experienceLevel || null,
    },
    ratings: ratings.map((r) => ({
      sport: r.sport,
      rating: Number(r.rating.toFixed(2)),
      matches: r.matchesCount,
      wins: r.wins,
      losses: r.losses,
    })),
    stats: {
      xp: xpAgg._sum.xpAwarded || 0,
      trainings: trainingsTotal,
      trainingsYear,
      tournaments: tournamentsCount,
      matchesPlayed: totalMatches,
      matchesPlayedYear: playedYear,
      wins: totalWins,
      losses: totalMatches - totalWins,
      winRate: totalMatches ? Math.round((totalWins / totalMatches) * 100) : 0,
      setsFor,
      setsAgainst,
      badgeCount: badges.length,
    },
    badges: badges.map((b) => ({ key: b.badgeKey, at: b.earnedAt })),
  };
}

module.exports = {
  generateFixtures,
  applyMatchResult,
  recomputeStandings,
  updateRatingsForMatch,
  rateHeadToHead,
  resolveUserId,
  buildAthleteCard,
  yearStart,
  // utils expostos p/ teste
  seedSlots,
  roundRobinRounds,
  nextPow2,
};
