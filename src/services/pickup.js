// =====================================================================
// Liga Aberta F3 — MODO RACHA (torneio com formato PICKUP)
// ---------------------------------------------------------------------
// Racha recorrente: o organizador tem a lista de JOGADORES do racha
// (PickupPlayer). Em cada dia (PickupSession, dia em America/Fortaleza):
//   1. lista de presença — cada jogador confirma/desconfirma pelo link
//      (logado) ou o organizador marca;
//   2. sorteio de times EQUILIBRADO por nível — nível = Glicko-2 do esporte
//      quando houver (mesma escala 0–7 do Club), senão o nível informado
//      pelo organizador (sem nenhum dos dois: 3, marcado como "padrão").
//      Determinístico pela SEMENTE registrada (mesma semente + mesma lista =
//      mesmos times) e mostra a soma de nível de cada time;
//   3. placar rápido (+1 / −1 por time, com o autor do gol opcional);
//   4. artilharia acumulada da TEMPORADA (ano em America/Fortaleza) a partir
//      dos MatchEvent GOAL dos jogos encerrados.
// Os times sorteados viram inscrições do dia (TournamentEntry) com elenco
// (RosterPlayer com o userId do jogador, quando ele tem conta) — assim os
// jogos e gols do racha entram no histórico do atleta (athleteHistory).
// Jogo de racha (stage PICKUP) NÃO entra no rating Glicko (times mudam todo dia).
// Permissão: tudo via roles.can() (organizar = MANAGE_TOURNAMENT; placar =
// RESULT do jogo; presença própria = SELF).
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');
const ftz = require('./fortalezaTime');
const { seasonOf } = require('./athleteHistory');

class PickupError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || null; } }
const fail = (status, msg, extra) => { throw new PickupError(status, msg, extra); };

const DEFAULT_LEVEL = 3;
const TEAM_NAMES = ['Time A', 'Time B', 'Time C', 'Time D', 'Time E', 'Time F', 'Time G', 'Time H'];
const LEVEL_BASE = 900; // mesma escala do clubRating (1500 = 3,0)
const LEVEL_STEP = 200;

// ------------------------------------------------------------- utils
function dayKeyOf(date = new Date()) {
  const p = ftz.partsOf(date);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function validDayKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  return Math.abs(dt.getTime() - Date.now()) <= 370 * 24 * 3600 * 1000;
}
function dayOrFail(dayKey) {
  if (dayKey === undefined || dayKey === null || dayKey === '') return dayKeyOf();
  if (!validDayKey(String(dayKey))) fail(400, 'dia inválido (AAAA-MM-DD, até 1 ano antes ou depois)');
  return String(dayKey);
}
const isCode = (e, code) => e && e.code === code;
function glickoLevel(rating) {
  const l = (Number(rating) - LEVEL_BASE) / LEVEL_STEP;
  return Math.round(Math.max(0, Math.min(7, l)) * 100) / 100;
}
function clampLevel(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 7) fail(400, 'nível inválido (0 a 7)');
  return Math.round(n * 10) / 10;
}

// PRNG determinístico a partir da semente (texto).
function seedInt(seed) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  return h.readUInt32BE(0);
}
function mulberry32(a) {
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(list, seed) {
  const a = list.slice();
  const rnd = mulberry32(seedInt(seed));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------- sorteio equilibrado
// players: [{ id, level }]. Devolve [{ index, ids:[], levelSum }] (somas em décimos exatos).
// 2 times e até 20 jogadores: busca EXATA (menor diferença possível de soma de nível);
// mais times/jogadores: distribuição em serpentina + trocas que diminuem a diferença.
// Empates entre soluções: vence a primeira na ordem embaralhada pela semente (determinístico).
function balancedTeams(players, teamCount, seed) {
  const k = Math.max(2, Math.min(TEAM_NAMES.length, Number(teamCount) || 2));
  if (players.length < k) fail(400, `confirme pelo menos ${k} jogadores para sortear ${k} times`);
  const order = seededShuffle(players.map((p) => ({ id: p.id, w: Math.round(Number(p.level) * 10) })), seed);
  const n = order.length;
  let groups;
  if (k === 2 && n <= 20) {
    const total = order.reduce((s, p) => s + p.w, 0);
    const size = Math.floor(n / 2);
    let best = null;
    let bestDiff = Infinity;
    const pick = [];
    const rec = (start, sum) => {
      if (bestDiff === 0) return;
      if (pick.length === size) {
        const diff = Math.abs(total - 2 * sum);
        if (diff < bestDiff) { bestDiff = diff; best = pick.slice(); }
        return;
      }
      for (let i = start; i <= n - (size - pick.length); i++) {
        pick.push(i);
        rec(i + 1, sum + order[i].w);
        pick.pop();
        if (bestDiff === 0) return;
      }
    };
    rec(0, 0);
    const inA = new Set(best);
    groups = [order.filter((_, i) => inA.has(i)), order.filter((_, i) => !inA.has(i))];
  } else {
    const sorted = order.map((p, i) => ({ ...p, i })).sort((a, b) => b.w - a.w || a.i - b.i);
    groups = Array.from({ length: k }, () => []);
    sorted.forEach((p, idx) => {
      const round = Math.floor(idx / k);
      const pos = idx % k;
      groups[round % 2 === 0 ? pos : k - 1 - pos].push(p);
    });
    const sumOf = (g) => g.reduce((s, p) => s + p.w, 0);
    const spread = () => { const s = groups.map(sumOf); return Math.max(...s) - Math.min(...s); };
    for (let iter = 0; iter < 500; iter++) {
      const cur = spread();
      let bestMove = null;
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
        for (let x = 0; x < groups[a].length; x++) for (let y = 0; y < groups[b].length; y++) {
          const pa = groups[a][x]; const pb = groups[b][y];
          if (pa.w === pb.w) continue;
          groups[a][x] = pb; groups[b][y] = pa;
          const s = spread();
          groups[a][x] = pa; groups[b][y] = pb;
          if (s < cur && (!bestMove || s < bestMove.s)) bestMove = { a, b, x, y, s };
        }
      }
      if (!bestMove) break;
      const { a, b, x, y } = bestMove;
      [groups[a][x], groups[b][y]] = [groups[b][y], groups[a][x]];
    }
  }
  return groups.map((g, index) => ({ index, ids: g.map((p) => p.id), levelSum: g.reduce((s, p) => s + p.w, 0) / 10 }));
}

// --------------------------------------------------------- leitura
async function loadPickupTournament(idOrSlug) {
  const key = String(idOrSlug || '');
  const t = await prisma.tournament.findFirst({ where: { OR: [{ id: key }, { slug: key }] } });
  if (!t || t.archivedAt) return null;
  return t; // F6: suspenso — a rota já passou por access (dono/admin) e o router.param barra escrita
}
function ensurePickup(t) {
  if (!t) fail(404, 'não encontrado');
  if (t.format !== 'PICKUP') fail(400, 'este campeonato não é um racha');
}

async function firstCategory(t) {
  let cat = await prisma.tournamentCategory.findFirst({ where: { tournamentId: t.id }, orderBy: { id: 'asc' } });
  if (!cat) cat = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Geral' } });
  return cat;
}

async function sessionFor(t, dayKey, { create = true } = {}) {
  const dk = dayOrFail(dayKey);
  let s = await prisma.pickupSession.findUnique({ where: { tournamentId_dayKey: { tournamentId: t.id, dayKey: dk } } });
  if (!s && create) {
    const cat = await firstCategory(t);
    try {
      s = await prisma.pickupSession.create({ data: { tournamentId: t.id, categoryId: cat.id, dayKey: dk } });
    } catch (e) { // corrida: outro pedido criou o mesmo dia
      s = await prisma.pickupSession.findUnique({ where: { tournamentId_dayKey: { tournamentId: t.id, dayKey: dk } } });
    }
  }
  return s;
}

// Nível de cada jogador: Glicko do esporte (conta ligada) > nível do organizador > 3 (padrão).
async function levelsFor(t, players) {
  const userIds = players.map((p) => p.userId).filter(Boolean);
  const gl = userIds.length
    ? await prisma.glickoRating.findMany({ where: { sport: t.sport, subjectType: 'USER', userId: { in: userIds }, matches: { gt: 0 } }, orderBy: { matches: 'desc' } }).catch(() => [])
    : [];
  const byUser = {};
  gl.forEach((g) => { if (!byUser[g.userId]) byUser[g.userId] = g; });
  return players.map((p) => {
    const g = p.userId && byUser[p.userId];
    if (g) return { ...p, levelUsed: glickoLevel(g.rating), levelSource: 'glicko' };
    if (p.level != null) return { ...p, levelUsed: p.level, levelSource: 'organizador' };
    return { ...p, levelUsed: DEFAULT_LEVEL, levelSource: 'padrão' };
  });
}

async function view(t, viewer, dayKey) {
  ensurePickup(t);
  // Leitura (pública) NUNCA grava: sem sessão do dia ainda, devolve uma vazia.
  const s = (await sessionFor(t, dayKey, { create: false })) || { id: null, dayKey: dayOrFail(dayKey), status: 'OPEN', seed: null, teamCount: 2, drawnAt: null, teams: null };
  const [players, att, games] = await Promise.all([
    prisma.pickupPlayer.findMany({ where: { tournamentId: t.id, active: true }, orderBy: [{ name: 'asc' }] }),
    s.id ? prisma.pickupAttendance.findMany({ where: { sessionId: s.id } }) : [],
    prisma.tournamentMatch.findMany({ where: { tournamentId: t.id, stage: 'PICKUP', round: { gte: 0 } }, orderBy: [{ createdAt: 'asc' }] }),
  ]);
  const st = Object.fromEntries(att.map((a) => [a.playerId, a.status]));
  const withLv = await levelsFor(t, players);
  const teams = Array.isArray(s.teams) ? s.teams : [];
  const entryIds = new Set(teams.map((x) => x.entryId));
  const dayGames = games.filter((g) => entryIds.has(g.homeEntryId) || entryIds.has(g.awayEntryId));
  const ev = dayGames.length
    ? await prisma.matchEvent.findMany({ where: { matchId: { in: dayGames.map((g) => g.id) }, type: 'GOAL' }, orderBy: { createdAt: 'asc' } })
    : [];
  const teamName = Object.fromEntries(teams.map((x) => [x.entryId, x.name]));
  const rpName = {};
  teams.forEach((x) => (x.players || []).forEach((p) => { rpName[p.rosterPlayerId] = p.name; }));
  const v = viewer || {};
  const manage = v.userId ? await roles.can(v.userId, v.userRole, t.id, 'MANAGE_TOURNAMENT') : false;
  // placar/encerrar: organização ou arbitragem do torneio (o backend confere RESULT por jogo)
  const score = manage || (v.userId ? await roles.can(v.userId, v.userRole, t.id, 'REFEREE') : false);
  const mine = v.userId ? players.find((p) => p.userId === v.userId) : null;
  return {
    tournament: { id: t.id, slug: t.slug, name: t.name, sport: t.sport, visibility: t.visibility || 'public' },
    session: { id: s.id, dayKey: s.dayKey, status: s.status, seed: s.seed, teamCount: s.teamCount, drawnAt: s.drawnAt, teams },
    players: withLv.map((p) => ({ id: p.id, name: p.name, hasAccount: !!p.userId, level: p.level, levelUsed: p.levelUsed, levelSource: p.levelSource, status: st[p.id] || null })),
    confirmed: withLv.filter((p) => st[p.id] === 'IN').length,
    games: dayGames.map((g) => {
      const gev = ev.filter((e) => e.matchId === g.id);
      const h = gev.filter((e) => e.entryId === g.homeEntryId).length;
      const a = gev.filter((e) => e.entryId === g.awayEntryId).length;
      return {
        id: g.id, status: g.status, home: teamName[g.homeEntryId] || '', away: teamName[g.awayEntryId] || '',
        homeEntryId: g.homeEntryId, awayEntryId: g.awayEntryId,
        homeScore: g.status === 'FINISHED' ? g.homeScore : h, awayScore: g.status === 'FINISHED' ? g.awayScore : a,
        goals: gev.map((e) => ({ id: e.id, side: e.entryId === g.homeEntryId ? 'home' : 'away', player: e.playerId ? rpName[e.playerId] || null : null })),
      };
    }),
    me: { loggedIn: !!v.userId, playerId: mine ? mine.id : null, status: mine ? st[mine.id] || null : null, canManage: manage, canScore: score },
  };
}

// --------------------------------------------------------- escrita
async function requireManage(actor, t) {
  if (!(await roles.can(actor.userId, actor.userRole, t.id, 'MANAGE_TOURNAMENT'))) fail(403, 'só a organização do racha faz isso');
}

async function addPlayers(t, actor, { names, level }) {
  ensurePickup(t);
  await requireManage(actor, t);
  const list = (Array.isArray(names) ? names : String(names || '').split(/\r?\n/)).map((n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean);
  if (!list.length) fail(400, 'informe o nome do jogador');
  if (list.length > 64) fail(400, 'máximo de 64 jogadores por vez');
  const lv = clampLevel(level);
  const existing = await prisma.pickupPlayer.findMany({ where: { tournamentId: t.id }, select: { name: true } });
  const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const have = new Set(existing.map((p) => norm(p.name)));
  const created = [];
  for (const n of list) {
    if (have.has(norm(n))) continue;
    have.add(norm(n));
    created.push(await prisma.pickupPlayer.create({ data: { tournamentId: t.id, name: n, level: lv } }));
  }
  return { ok: true, created: created.length, players: created.map((p) => ({ id: p.id, name: p.name, level: p.level })) };
}

async function updatePlayer(actor, playerId, body) {
  const p = await prisma.pickupPlayer.findUnique({ where: { id: String(playerId) } });
  if (!p) fail(404, 'jogador não encontrado');
  const t = await loadPickupTournament(p.tournamentId);
  ensurePickup(t);
  await requireManage(actor, t);
  const data = {};
  if (body.name !== undefined) { const n = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80); if (!n) fail(400, 'nome vazio'); data.name = n; }
  if (body.level !== undefined) data.level = clampLevel(body.level);
  if (body.active !== undefined) data.active = !!body.active;
  const up = await prisma.pickupPlayer.update({ where: { id: p.id }, data });
  return { ok: true, player: { id: up.id, name: up.name, level: up.level, active: up.active } };
}

// Presença: { confirm:true|false, playerId? }. Sem playerId = a própria conta (cria o jogador
// do racha com o nome da conta, se ainda não existe). Com playerId de outro = organização.
async function setAttendance(t, actor, body, dayKey) {
  ensurePickup(t);
  if (!actor.userId) fail(401, 'entre na sua conta para confirmar presença');
  const s = await sessionFor(t, dayKey);
  if (s.status === 'CLOSED') fail(409, 'a lista deste dia já foi fechada');
  const confirm = body.confirm === true || body.confirm === 'true';
  let player;
  if (body.playerId) {
    player = await prisma.pickupPlayer.findFirst({ where: { id: String(body.playerId), tournamentId: t.id } });
    if (!player) fail(404, 'jogador não encontrado');
    const self = player.userId && player.userId === actor.userId;
    if (!self) await requireManage(actor, t);
  } else {
    if (!(await roles.can(actor.userId, actor.userRole, t.id, 'SELF', { targetUserId: actor.userId }))) fail(403, 'sem permissão');
    player = await prisma.pickupPlayer.findFirst({ where: { tournamentId: t.id, userId: actor.userId } });
    if (!player) {
      const me = await prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
      try {
        player = await prisma.pickupPlayer.create({ data: { tournamentId: t.id, userId: actor.userId, name: String((me && me.name) || 'Atleta').slice(0, 80) } });
      } catch (_) { player = await prisma.pickupPlayer.findFirst({ where: { tournamentId: t.id, userId: actor.userId } }); }
    }
    if (!player.active) await prisma.pickupPlayer.update({ where: { id: player.id }, data: { active: true } });
  }
  const status = confirm ? 'IN' : 'OUT';
  const up = () => prisma.pickupAttendance.upsert({
    where: { sessionId_playerId: { sessionId: s.id, playerId: player.id } },
    update: { status, byUserId: actor.userId },
    create: { sessionId: s.id, playerId: player.id, status, byUserId: actor.userId },
  });
  try { await up(); } catch (e) { if (isCode(e, 'P2002')) await up(); else throw e; } // corrida: o outro criou, aqui atualiza
  return { ok: true, sessionId: s.id, dayKey: s.dayKey, playerId: player.id, status };
}

// Sorteio. body: { teamCount=2, seed? }. Sem semente: gera uma e REGISTRA (auditável).
async function draw(t, actor, body, dayKey) {
  ensurePickup(t);
  await requireManage(actor, t);
  const s = await sessionFor(t, dayKey);
  const att = await prisma.pickupAttendance.findMany({ where: { sessionId: s.id, status: 'IN' } });
  const players = await prisma.pickupPlayer.findMany({ where: { tournamentId: t.id, active: true, id: { in: att.map((a) => a.playerId) } } });
  const withLv = await levelsFor(t, players);
  const seed = body && body.seed ? String(body.seed).slice(0, 64) : crypto.randomBytes(6).toString('hex');
  const teamCount = Math.max(2, Math.min(TEAM_NAMES.length, Number(body && body.teamCount) || s.teamCount || 2));
  // Ordem estável antes do embaralhamento pela semente (id) — mesma lista + mesma semente = mesmo sorteio.
  const base = withLv.slice().sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => ({ id: p.id, level: p.levelUsed }));
  const groups = balancedTeams(base, teamCount, seed);
  const byId = Object.fromEntries(withLv.map((p) => [p.id, p]));
  const [, mm, dd] = s.dayKey.split('-');
  let prevEntryIds = [];
  const teams = await prisma.$transaction(async (tx) => {
    // trava a sessão: dois sorteios (ou sorteio × novo jogo) ao mesmo tempo esperam um pelo outro
    await tx.$queryRaw`SELECT "id" FROM "PickupSession" WHERE "id" = ${s.id} FOR UPDATE`;
    const cur = await tx.pickupSession.findUnique({ where: { id: s.id }, select: { teams: true } });
    prevEntryIds = (Array.isArray(cur.teams) ? cur.teams : []).map((x) => x.entryId).filter(Boolean);
    if (prevEntryIds.length) {
      const played = await tx.tournamentMatch.count({ where: { tournamentId: t.id, OR: [{ homeEntryId: { in: prevEntryIds } }, { awayEntryId: { in: prevEntryIds } }] } });
      if (played) fail(409, 'já tem jogo com os times deste dia — o sorteio não pode ser refeito');
    }
    if (prevEntryIds.length) {
      await tx.rosterPlayer.deleteMany({ where: { entryId: { in: prevEntryIds } } });
      await tx.tournamentEntry.deleteMany({ where: { id: { in: prevEntryIds } } });
    }
    const out = [];
    for (const g of groups) {
      const name = TEAM_NAMES[g.index];
      const entry = await tx.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: s.categoryId, name: `${name} · ${dd}/${mm}`, status: 'CONFIRMED' } });
      const ps = [];
      for (const pid of g.ids) {
        const p = byId[pid];
        const rp = await tx.rosterPlayer.create({ data: { entryId: entry.id, name: p.name, userId: p.userId || null, role: 'PLAYER' } });
        ps.push({ playerId: p.id, rosterPlayerId: rp.id, name: p.name, level: p.levelUsed, levelSource: p.levelSource });
      }
      out.push({ index: g.index, name, entryId: entry.id, levelSum: g.levelSum, players: ps });
    }
    await tx.pickupSession.update({ where: { id: s.id }, data: { status: 'DRAWN', seed, teamCount, teams: out, drawnAt: new Date(), drawnBy: actor.userId } });
    return out;
  });
  const sums = teams.map((x) => x.levelSum);
  await audit.record({ tournamentId: t.id, userId: actor.userId, action: 'pickup.draw', entity: 'PickupSession', entityId: s.id, after: { dayKey: s.dayKey, seed, teamCount, players: base.length, levelSums: sums, redraw: prevEntryIds.length > 0 } });
  return { ok: true, sessionId: s.id, dayKey: s.dayKey, seed, teamCount, teams, levelDiff: Math.round((Math.max(...sums) - Math.min(...sums)) * 10) / 10 };
}

// Novo jogo do dia entre dois times sorteados. body: { home, away } (índice do time).
async function createGame(t, actor, body, dayKey) {
  ensurePickup(t);
  await requireManage(actor, t);
  const s = await sessionFor(t, dayKey, { create: false });
  if (!s) fail(409, 'sorteie os times antes de criar o jogo');
  const { m, h, a } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "PickupSession" WHERE "id" = ${s.id} FOR UPDATE`;
    const cur = await tx.pickupSession.findUnique({ where: { id: s.id }, select: { teams: true, categoryId: true } });
    const teams = Array.isArray(cur.teams) ? cur.teams : [];
    if (!teams.length) fail(409, 'sorteie os times antes de criar o jogo');
    const hh = teams.find((x) => x.index === Number(body.home));
    const aa = teams.find((x) => x.index === Number(body.away));
    if (!hh || !aa || hh.entryId === aa.entryId) fail(400, 'escolha dois times diferentes do sorteio');
    const n = await tx.tournamentMatch.count({ where: { tournamentId: t.id, stage: 'PICKUP' } });
    const mm = await tx.tournamentMatch.create({
      data: { tournamentId: t.id, categoryId: cur.categoryId, stage: 'PICKUP', round: n + 1, ordering: 0, homeEntryId: hh.entryId, awayEntryId: aa.entryId, status: 'LIVE', scheduledAt: new Date() },
    });
    return { m: mm, h: hh, a: aa };
  });
  return { ok: true, game: { id: m.id, home: h.name, away: a.name, homeEntryId: h.entryId, awayEntryId: a.entryId, status: m.status } };
}

async function loadGame(matchId) {
  const m = await prisma.tournamentMatch.findUnique({ where: { id: String(matchId) } });
  if (!m || m.stage !== 'PICKUP') fail(404, 'jogo não encontrado');
  const t = await loadPickupTournament(m.tournamentId);
  ensurePickup(t);
  return { m, t };
}

// Placar rápido: { side:'home'|'away', delta:+1|-1, playerId? (RosterPlayer do time) }.
async function score(actor, matchId, body) {
  const { m, t } = await loadGame(matchId);
  if (!(await roles.can(actor.userId, actor.userRole, t.id, 'RESULT', { matchId: m.id }))) fail(403, 'só a organização ou a arbitragem marca o placar');
  if (m.status === 'FINISHED') fail(409, 'jogo encerrado');
  const side = body.side === 'away' ? 'away' : body.side === 'home' ? 'home' : null;
  if (!side) fail(400, 'informe o time (home ou away)');
  const entryId = side === 'home' ? m.homeEntryId : m.awayEntryId;
  const delta = Number(body.delta) === -1 ? -1 : 1;
  if (delta === 1) {
    let playerId = null;
    if (body.playerId) {
      const rp = await prisma.rosterPlayer.findFirst({ where: { id: String(body.playerId), entryId }, select: { id: true } });
      if (!rp) fail(400, 'jogador não é deste time');
      playerId = rp.id;
    }
    await prisma.matchEvent.create({ data: { matchId: m.id, entryId, playerId, type: 'GOAL', minute: null, period: 1 } });
  } else {
    const last = await prisma.matchEvent.findFirst({ where: { matchId: m.id, entryId, type: 'GOAL' }, orderBy: { createdAt: 'desc' } });
    if (last) await prisma.matchEvent.delete({ where: { id: last.id } }).catch((e) => { if (!isCode(e, 'P2025')) throw e; });
  }
  const goals = await prisma.matchEvent.findMany({ where: { matchId: m.id, type: 'GOAL' }, select: { entryId: true } });
  return { ok: true, homeScore: goals.filter((g) => g.entryId === m.homeEntryId).length, awayScore: goals.filter((g) => g.entryId === m.awayEntryId).length };
}

// Encerra o jogo: placar = gols lançados. Não passa pelo motor de tabela (racha não tem
// classificação) nem pelo rating; o jogo encerrado entra no histórico dos atletas.
async function finishGame(actor, matchId) {
  const { m, t } = await loadGame(matchId);
  if (!(await roles.can(actor.userId, actor.userRole, t.id, 'RESULT', { matchId: m.id }))) fail(403, 'só a organização ou a arbitragem encerra o jogo');
  if (m.status === 'FINISHED') fail(409, 'jogo já encerrado');
  const goals = await prisma.matchEvent.findMany({ where: { matchId: m.id, type: 'GOAL' }, select: { entryId: true } });
  const hs = goals.filter((g) => g.entryId === m.homeEntryId).length;
  const as = goals.filter((g) => g.entryId === m.awayEntryId).length;
  const winnerEntryId = hs > as ? m.homeEntryId : as > hs ? m.awayEntryId : null;
  const up = await prisma.tournamentMatch.update({ where: { id: m.id }, data: { homeScore: hs, awayScore: as, winnerEntryId, status: 'FINISHED' } });
  await audit.record({ tournamentId: t.id, userId: actor.userId, action: 'result.set', entity: 'TournamentMatch', entityId: m.id, before: audit.matchSnap ? audit.matchSnap(m) : null, after: audit.matchSnap ? audit.matchSnap(up) : { homeScore: hs, awayScore: as } });
  return { ok: true, homeScore: hs, awayScore: as, winnerEntryId };
}

// Artilharia da temporada (ano em America/Fortaleza). Agrega por jogador do racha.
async function seasonScorers(t, season) {
  ensurePickup(t);
  const year = Number(season) || seasonOf(new Date());
  const matches = await prisma.tournamentMatch.findMany({ where: { tournamentId: t.id, stage: 'PICKUP', status: 'FINISHED' }, select: { id: true, scheduledAt: true, createdAt: true, homeEntryId: true, awayEntryId: true } });
  const inSeason = matches.filter((m) => seasonOf(m.scheduledAt || m.createdAt) === year);
  const sessions = await prisma.pickupSession.findMany({ where: { tournamentId: t.id }, select: { teams: true } });
  const rpToPlayer = {};
  const entryPlayers = {};
  sessions.forEach((s) => (Array.isArray(s.teams) ? s.teams : []).forEach((tm) => (tm.players || []).forEach((p) => {
    rpToPlayer[p.rosterPlayerId] = p.playerId;
    (entryPlayers[tm.entryId] = entryPlayers[tm.entryId] || []).push(p.playerId);
  })));
  const players = await prisma.pickupPlayer.findMany({ where: { tournamentId: t.id }, select: { id: true, name: true, userId: true } });
  const pById = Object.fromEntries(players.map((p) => [p.id, p]));
  const agg = {};
  const row = (pid) => (agg[pid] = agg[pid] || { playerId: pid, name: (pById[pid] || {}).name || '?', hasAccount: !!(pById[pid] || {}).userId, goals: 0, games: 0 });
  inSeason.forEach((m) => [m.homeEntryId, m.awayEntryId].forEach((eid) => (entryPlayers[eid] || []).forEach((pid) => { row(pid).games += 1; })));
  const ev = inSeason.length
    ? await prisma.matchEvent.findMany({ where: { matchId: { in: inSeason.map((m) => m.id) }, type: 'GOAL', playerId: { not: null } }, select: { playerId: true } })
    : [];
  ev.forEach((e) => { const pid = rpToPlayer[e.playerId]; if (pid) row(pid).goals += 1; });
  const rows = Object.values(agg).sort((a, b) => b.goals - a.goals || a.games - b.games || a.name.localeCompare(b.name) || String(a.playerId).localeCompare(String(b.playerId)));
  return { season: year, games: inSeason.length, scorers: rows.filter((r) => r.goals > 0), players: rows };
}

module.exports = {
  PickupError, DEFAULT_LEVEL, dayKeyOf, glickoLevel, balancedTeams, seededShuffle,
  loadPickupTournament, view, addPlayers, updatePlayer, setAttendance, draw, createGame, score, finishGame, seasonScorers,
};
