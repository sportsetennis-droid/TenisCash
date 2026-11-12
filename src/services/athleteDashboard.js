// =====================================================================
// PAINEL DO ATLETA (Club Sports & Tennis) — tudo que é MEU, em todos os
// torneios/clubes de uma vez: times, convites, próximos jogos oficiais,
// próximos treinos oficiais e a produção somada dos treinos.
// Só LÊ. Reaproveita as regras de trainingSession (forUser/prontuario).
// =====================================================================
const { prisma } = require('../middleware');
const training = require('./trainingSession');

const DAY = 24 * 3600000;

async function dashboard(userId) {
  const uid = String(userId);

  // 1) Vínculos com times (ACTIVE + convites PENDING) e papéis/fundador
  const mems = await prisma.teamMembership.findMany({
    where: { userId: uid, status: { in: ['ACTIVE', 'PENDING'] } },
    orderBy: { createdAt: 'desc' },
  });
  const roleRows = await prisma.tournamentRole.findMany({ where: { userId: uid }, select: { tournamentId: true, role: true, entryId: true } });
  const owned = await prisma.tournament.findMany({ where: { ownerId: uid }, select: { id: true } });

  const ids = [...new Set(mems.map((m) => m.tournamentId).concat(roleRows.map((r) => r.tournamentId), owned.map((o) => o.id)))];
  const ts = ids.length ? await prisma.tournament.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true, sport: true, status: true, ownerId: true } }) : [];
  const tById = Object.fromEntries(ts.map((t) => [t.id, t]));

  // Times ativos (clube = nome, único por torneio)
  const active = mems.filter((m) => m.status === 'ACTIVE');
  const clubsByT = {};
  active.forEach((m) => { (clubsByT[m.tournamentId] = clubsByT[m.tournamentId] || new Set()).add(m.clubName); });

  const teams = [];
  for (const [tid, set] of Object.entries(clubsByT)) {
    for (const clubName of set) {
      const ent = await prisma.tournamentEntry.findFirst({ where: { tournamentId: tid, name: clubName }, select: { id: true, logoUrl: true } }).catch(() => null);
      teams.push({ tournamentId: tid, tournament: tById[tid] ? tById[tid].name : '', clubName, entryId: ent ? ent.id : null, logoUrl: ent ? ent.logoUrl : null });
    }
  }

  const invites = mems
    .filter((m) => m.status === 'PENDING' && m.initiatedBy === 'TEAM')
    .map((m) => ({ id: m.id, tournamentId: m.tournamentId, tournament: tById[m.tournamentId] ? tById[m.tournamentId].name : '', clubName: m.clubName }));

  // 2) Próximos jogos oficiais dos meus times
  const now = Date.now();
  const games = [];
  for (const [tid, set] of Object.entries(clubsByT)) {
    const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId: tid, name: { in: [...set] } }, select: { id: true } });
    const eids = entries.map((e) => e.id);
    if (!eids.length) continue;
    const ms = await prisma.tournamentMatch.findMany({
      where: {
        tournamentId: tid,
        status: { in: ['SCHEDULED', 'LIVE'] },
        OR: [{ homeEntryId: { in: eids } }, { awayEntryId: { in: eids } }],
      },
      include: {
        homeEntry: { select: { name: true, logoUrl: true } },
        awayEntry: { select: { name: true, logoUrl: true } },
        category: { select: { name: true } },
      },
      orderBy: [{ scheduledAt: 'asc' }],
      take: 20,
    });
    ms.forEach((m) => {
      if (m.status === 'SCHEDULED' && m.scheduledAt && new Date(m.scheduledAt).getTime() < now - 6 * 3600000) return; // passou e não foi fechado
      games.push({
        id: m.id, tournamentId: tid, tournament: tById[tid] ? tById[tid].name : '', slug: tById[tid] ? tById[tid].slug : null,
        category: m.category ? m.category.name : '', stage: m.stage, status: m.status,
        scheduledAt: m.scheduledAt, location: m.location,
        home: m.homeEntry ? m.homeEntry.name : (m.homeSourceLabel || 'A definir'),
        away: m.awayEntry ? m.awayEntry.name : (m.awaySourceLabel || 'A definir'),
        homeLogo: m.homeEntry ? m.homeEntry.logoUrl : null, awayLogo: m.awayEntry ? m.awayEntry.logoUrl : null,
        homeScore: m.homeScore, awayScore: m.awayScore,
      });
    });
  }
  games.sort((a, b) => new Date(a.scheduledAt || now + 365 * DAY) - new Date(b.scheduledAt || now + 365 * DAY));

  // 3) Próximos treinos oficiais + produção somada (todos os torneios)
  const trainings = [];
  const prod = { treinos: 0, marcados: 0, presencas: 0, faltas: 0, gols: 0, passes: 0, _effSum: 0, _effN: 0, _ratSum: 0, _ratN: 0 };
  const byTournament = [];
  for (const tid of Object.keys(clubsByT)) {
    const fu = await training.forUser(tid, uid).catch(() => ({ upcoming: [] }));
    (fu.upcoming || []).forEach((s) => trainings.push({ ...s, tournament: tById[tid] ? tById[tid].name : '' }));
    const p = await training.prontuario(tid, uid).catch(() => null);
    if (p && p.summary) {
      const s = p.summary;
      prod.treinos += s.treinos || 0; prod.marcados += s.marcados || 0; prod.presencas += s.presencas || 0; prod.faltas += s.faltas || 0;
      prod.gols += s.gols || 0; prod.passes += s.passes || 0;
      if (s.eficienciaMedia != null) { prod._effSum += s.eficienciaMedia; prod._effN++; }
      if (s.notaMedia != null) { prod._ratSum += s.notaMedia; prod._ratN++; }
      byTournament.push({ tournamentId: tid, tournament: tById[tid] ? tById[tid].name : '', summary: s, evaluation: p.evaluation && p.evaluation.latest ? { overall: p.evaluation.latest.overall, count: p.evaluation.count } : null });
    }
  }
  trainings.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
  const production = {
    treinos: prod.treinos, presencas: prod.presencas, faltas: prod.faltas,
    presencaPct: prod.marcados ? Math.round((prod.presencas / prod.marcados) * 100) : null,
    gols: prod.gols, passes: prod.passes,
    eficienciaMedia: prod._effN ? Math.round(prod._effSum / prod._effN) : null,
    notaMedia: prod._ratN ? Math.round((prod._ratSum / prod._ratN) * 10) / 10 : null,
    byTournament,
  };

  // 4) Produção em JOGOS OFICIAIS (súmula) — só nomes do elenco ligados à conta
  production.games = await gameProduction(uid, tById).catch((e) => { console.error('[dashboard] gameProduction', e.message); return null; });

  // Torneios em que atuo (papel/fundador/time)
  const rolesByT = {};
  roleRows.forEach((r) => { (rolesByT[r.tournamentId] = rolesByT[r.tournamentId] || []).push({ role: r.role, entryId: r.entryId }); });
  const tournaments = ts.map((t) => ({
    ...t,
    myRoles: (t.ownerId === uid ? [{ role: 'FOUNDER' }] : []).concat(rolesByT[t.id] || []),
    myClubs: clubsByT[t.id] ? [...clubsByT[t.id]] : [],
  }));

  return { tournaments, teams, invites, games: games.slice(0, 10), trainings: trainings.slice(0, 10), production };
}

// Gols/assistências/cartões da súmula + jogos (V/E/D) dos times em que o atleta
// está no elenco COM a conta ligada (RosterPlayer.userId). Só jogos encerrados.
async function gameProduction(uid, tById) {
  const zero = { jogos: 0, vitorias: 0, empates: 0, derrotas: 0, gols: 0, assistencias: 0, amarelos: 0, vermelhos: 0, linked: 0, byTournament: [] };
  const players = await prisma.rosterPlayer.findMany({ where: { userId: uid }, select: { id: true, entryId: true } });
  if (!players.length) return zero;
  const entryIds = [...new Set(players.map((p) => p.entryId))];
  const entries = await prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, tournamentId: true } });
  const tOfEntry = Object.fromEntries(entries.map((e) => [e.id, e.tournamentId]));
  const out = { ...zero, linked: players.length, byTournament: [] };
  const per = {};
  const bucket = (tid) => (per[tid] = per[tid] || { tournamentId: tid, tournament: (tById[tid] && tById[tid].name) || '', jogos: 0, gols: 0, assistencias: 0, amarelos: 0, vermelhos: 0 });

  const matches = await prisma.tournamentMatch.findMany({
    where: { status: { in: ['FINISHED', 'WALKOVER'] }, OR: [{ homeEntryId: { in: entryIds } }, { awayEntryId: { in: entryIds } }] },
    select: { id: true, tournamentId: true, homeEntryId: true, awayEntryId: true, homeScore: true, awayScore: true, winnerEntryId: true },
  });
  for (const m of matches) {
    const mine = entryIds.includes(m.homeEntryId) ? m.homeEntryId : m.awayEntryId;
    out.jogos++; bucket(m.tournamentId).jogos++;
    if (m.winnerEntryId) { if (m.winnerEntryId === mine) out.vitorias++; else out.derrotas++; }
    else if (m.homeScore != null && m.awayScore != null && m.homeScore === m.awayScore) out.empates++;
    else if (m.homeScore != null && m.awayScore != null) {
      const my = mine === m.homeEntryId ? m.homeScore : m.awayScore;
      const op = mine === m.homeEntryId ? m.awayScore : m.homeScore;
      if (my > op) out.vitorias++; else if (my < op) out.derrotas++; else out.empates++;
    }
  }
  const doneIds = matches.map((m) => m.id);
  if (doneIds.length) {
    const evs = await prisma.matchEvent.findMany({
      where: { playerId: { in: players.map((p) => p.id) }, matchId: { in: doneIds }, type: { in: ['GOAL', 'ASSIST', 'YELLOW', 'RED'] } },
      select: { type: true, entryId: true },
    });
    const key = { GOAL: 'gols', ASSIST: 'assistencias', YELLOW: 'amarelos', RED: 'vermelhos' };
    for (const e of evs) {
      const k = key[e.type]; out[k]++;
      const tid = tOfEntry[e.entryId]; if (tid) bucket(tid)[k]++;
    }
  }
  out.byTournament = Object.values(per);
  return out;
}

module.exports = { dashboard, gameProduction };
