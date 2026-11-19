// =====================================================================
// APEX — Contas e PAPÉIS do torneio (genérico pra TODO torneio)
// ---------------------------------------------------------------------
// Cada pessoa é um User (login por telefone+senha, auth já existente).
// O PAPEL dela num torneio vive em TournamentRole (não é o User.role global).
// Papéis: FOUNDER, COORDINATOR, TEAM_ADMIN, COACH, REFEREE, PLAYER.
// O que cada um alimenta:
//  - FOUNDER (fundador): cria torneio, regras, categorias, prêmio, nomeia coordenador.
//  - COORDINATOR (coordenador técnico): tabela, grupos, nomeia arbitragem, resultados, mural.
//  - TEAM_ADMIN (admin do time): inscrição, elenco, escudo, confirma presença — do PRÓPRIO time.
//  - COACH (treinador): escalação (titular/banco), comissão técnica, súmula de treino — do PRÓPRIO time.
//  - REFEREE (arbitragem): súmula do jogo (gols/assist/cartões/faltas/pênaltis), placar, finaliza.
//  - PLAYER (jogador): perfil, foto, presença; recebe estatística.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ROLES = ['FOUNDER', 'COORDINATOR', 'TEAM_ADMIN', 'COACH', 'REFEREE', 'PLAYER'];
const ROLE_LABEL = {
  FOUNDER: 'Fundador do campeonato',
  COORDINATOR: 'Coordenador técnico',
  TEAM_ADMIN: 'Administrador do time',
  COACH: 'Treinador',
  REFEREE: 'Arbitragem',
  PLAYER: 'Jogador',
};
const TEAM_SCOPED = ['TEAM_ADMIN', 'COACH', 'PLAYER']; // papéis que precisam de entryId (time)
const OFFICIAL_ROLES = ['REF1', 'REF2', 'REF3', 'SCORER', 'TIMEKEEPER']; // nomeação por jogo

const isGlobalAdmin = (userRole) => ['admin', 'superadmin', 'manager'].includes(userRole);

// Todos os papéis de um usuário num torneio (+ fundador implícito pelo ownerId).
async function rolesFor(userId, tournamentId) {
  if (!userId) return [];
  const [t, rows] = await Promise.all([
    prisma.tournament.findUnique({ where: { id: tournamentId }, select: { ownerId: true } }),
    prisma.tournamentRole.findMany({ where: { tournamentId, userId }, select: { id: true, role: true, entryId: true } }),
  ]);
  const roles = rows.slice();
  if (t && t.ownerId === userId && !roles.some((r) => r.role === 'FOUNDER')) {
    roles.push({ id: null, role: 'FOUNDER', entryId: null });
  }
  return roles;
}

// ---------------------------------------------------------------------
// MATRIZ DE PERMISSÃO (Liga Aberta F1) — can() é a ÚNICA porta de escrita.
//   FOUNDER      tudo, inclusive excluir/arquivar, restaurar, transferir e dinheiro
//   COORDINATOR  tudo menos excluir/arquivar, restaurar, transferir e dinheiro
//   REFEREE      súmula, resultado e ao vivo SÓ dos jogos em que está escalado
//                (jogo sem ninguém escalado = só fundador/coordenador)
//   TEAM_ADMIN   elenco, logo e treinos do PRÓPRIO time · COACH: elenco/treinos
//   PLAYER       o próprio perfil
//   admin global (admin/superadmin/manager) passa em tudo.
// Torneio ARQUIVADO: nenhuma escrita (só restaurar e ler a auditoria).
// ---------------------------------------------------------------------
const ACTIONS = [
  'VIEW', 'MANAGE_TOURNAMENT', 'ASSIGN_ROLES', 'ASSIGN_LEAD_ROLES', 'MANAGE_TEAM', 'SET_LINEUP', 'TRAIN',
  'REFEREE', 'RESULT', 'LIVE', 'CORRECT_RESULT', 'POST', 'VIEW_AUDIT',
  'MONEY', 'DELETE_TOURNAMENT', 'RESTORE', 'TRANSFER', 'REGENERATE_FORCE', 'SELF',
];
const FOUNDER_ONLY = new Set(['ASSIGN_LEAD_ROLES', 'MONEY', 'DELETE_TOURNAMENT', 'RESTORE', 'TRANSFER', 'REGENERATE_FORCE']);
const COORD = new Set(['MANAGE_TOURNAMENT', 'ASSIGN_ROLES', 'CORRECT_RESULT', 'POST', 'VIEW_AUDIT']);
const MATCH_SCOPED = new Set(['REFEREE', 'RESULT', 'LIVE']);
const ARCHIVED_OK = new Set(['VIEW', 'RESTORE', 'VIEW_AUDIT']);

// ESCALA DE ARBITRAGEM (Liga F1 — flag EXPLÍCITA Tournament.requireRefereeAssignment):
//  - jogo COM escala de árbitro (MatchOfficial REF1/REF2/REF3) → só quem está escalado
//    nele (+ fundador/coordenador/admin)
//  - jogo SEM escala de árbitro:
//      flag false (padrão, comportamento antigo) → qualquer REFEREE do torneio
//      flag true → só fundador/coordenador/admin
// Escalar só a mesa (SCORER/TIMEKEEPER) não transforma o jogo em "com escala".
const REF_OFFICIAL_ROLES = ['REF1', 'REF2', 'REF3'];
async function matchHasRefereeAssigned(matchId) {
  const one = await prisma.matchOfficial.findFirst({ where: { matchId: String(matchId), role: { in: REF_OFFICIAL_ROLES } }, select: { id: true } });
  return !!one;
}

// Árbitro está ESCALADO (MatchOfficial) neste jogo?
async function isNominated(userId, matchId) {
  if (!userId || !matchId) return false;
  const mine = await prisma.matchOfficial.findFirst({ where: { matchId: String(matchId), userId }, select: { id: true } });
  return !!mine;
}

// Pode executar `action` neste torneio? opts: { entryId, matchId, targetUserId }
async function can(userId, userRole, tournamentId, action, opts = {}) {
  if (!tournamentId) return false;
  const t = await prisma.tournament.findUnique({ where: { id: String(tournamentId) }, select: { id: true, ownerId: true, archivedAt: true, requireRefereeAssignment: true } });
  if (!t) return false;
  if (t.archivedAt && !ARCHIVED_OK.has(action)) return false;
  if (action === 'VIEW') return true;
  if (isGlobalAdmin(userRole)) return ACTIONS.includes(action);
  if (!userId) return false;
  if (action === 'SELF') return !!opts.targetUserId && opts.targetUserId === userId;
  const rows = await prisma.tournamentRole.findMany({ where: { tournamentId: t.id, userId }, select: { role: true, entryId: true } });
  const isFounder = t.ownerId === userId || rows.some((r) => r.role === 'FOUNDER');
  const isCoord = isFounder || rows.some((r) => r.role === 'COORDINATOR');
  const teamAdminOf = (eid) => !!eid && rows.some((r) => r.role === 'TEAM_ADMIN' && r.entryId === eid);
  const coachOf = (eid) => !!eid && rows.some((r) => r.role === 'COACH' && r.entryId === eid);
  const isReferee = rows.some((r) => r.role === 'REFEREE');

  // Transferir: só o DONO atual (ownerId) — fundador nomeado não transfere o torneio.
  if (action === 'TRANSFER') return t.ownerId === userId;
  if (FOUNDER_ONLY.has(action)) return isFounder;
  if (COORD.has(action)) return isCoord;
  switch (action) {
    case 'MANAGE_TEAM':
      return isCoord || teamAdminOf(opts.entryId);
    case 'SET_LINEUP':
    case 'TRAIN': // elenco/treino: coordenação OU admin/treinador do PRÓPRIO time
      return isCoord || teamAdminOf(opts.entryId) || coachOf(opts.entryId);
    case 'REFEREE':
    case 'RESULT':
    case 'LIVE': {
      if (isCoord) return true;
      if (!isReferee) return false;
      // Sem jogo (mesa de check-in do torneio): basta ser arbitragem do torneio.
      if (!opts.matchId) return action === 'REFEREE';
      // Com jogo: o escalado manda; jogo sem escala de árbitro segue a flag do torneio.
      const m = await prisma.tournamentMatch.findUnique({ where: { id: String(opts.matchId) }, select: { tournamentId: true } });
      if (!m || m.tournamentId !== t.id) return false;
      if (await isNominated(userId, opts.matchId)) return true;
      if (await matchHasRefereeAssigned(opts.matchId)) return false;
      return !t.requireRefereeAssignment;
    }
    default:
      return false;
  }
}

// Resolve um usuário por id | username(@handle) | telefone.
async function resolveUser({ userId, username, phone }) {
  // Liga F1: só conta ATIVA pode receber papel/escala/torneio transferido.
  const sel = { id: true, name: true, phone: true, username: true };
  if (userId) return prisma.user.findFirst({ where: { id: String(userId), active: true }, select: sel });
  if (username) {
    const h = String(username).replace(/^@/, '').trim();
    if (h) return prisma.user.findFirst({ where: { username: { equals: h, mode: 'insensitive' }, active: true }, select: sel });
  }
  if (phone) {
    const p = String(phone).replace(/\D/g, '');
    if (p) return prisma.user.findFirst({ where: { phone: p, active: true }, select: sel });
  }
  return null;
}

// Nomeia um papel. Valida role e escopo (time) obrigatório onde cabe.
// TIME = CLUBE ÚNICO: papel de time (admin/treinador/jogador) vale pra TODAS as
// categorias do mesmo clube (mesmo nome) — nomeia uma vez, cobre o clube inteiro.
async function assignRole(tournamentId, { userId, role, entryId }) {
  const r = String(role || '').toUpperCase();
  if (!ROLES.includes(r)) return { ok: false, error: 'papel inválido' };
  if (TEAM_SCOPED.includes(r) && !entryId) return { ok: false, error: 'este papel precisa de um time (entryId)' };

  // papel de torneio (sem time)
  if (!TEAM_SCOPED.includes(r)) {
    const existing = await prisma.tournamentRole.findFirst({ where: { tournamentId, userId, role: r, entryId: null } });
    if (existing) return { ok: true, role: existing, already: true };
    const created = await prisma.tournamentRole.create({ data: { tournamentId, userId, role: r, entryId: null } });
    return { ok: true, role: created };
  }

  // papel de time → replica em todas as inscrições do mesmo CLUBE (mesmo nome)
  const entry = await prisma.tournamentEntry.findFirst({ where: { id: String(entryId), tournamentId }, select: { id: true, name: true } });
  if (!entry) return { ok: false, error: 'time não encontrado neste torneio' };
  const clubEntries = await prisma.tournamentEntry.findMany({ where: { tournamentId, name: entry.name }, select: { id: true } });
  const rolesOut = [];
  for (const e of clubEntries) {
    const existing = await prisma.tournamentRole.findFirst({ where: { tournamentId, userId, role: r, entryId: e.id } });
    rolesOut.push(existing || (await prisma.tournamentRole.create({ data: { tournamentId, userId, role: r, entryId: e.id } })));
  }
  return { ok: true, role: rolesOut[0], roles: rolesOut, count: rolesOut.length, club: entry.name };
}

async function removeRole(tournamentId, roleId) {
  const row = await prisma.tournamentRole.findFirst({ where: { id: roleId, tournamentId } });
  if (!row) return { ok: true, removed: 0 };
  // papel de time → remove em TODAS as categorias do mesmo clube (clube único)
  if (TEAM_SCOPED.includes(row.role) && row.entryId) {
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: row.entryId }, select: { name: true } });
    if (entry) {
      const club = await prisma.tournamentEntry.findMany({ where: { tournamentId, name: entry.name }, select: { id: true } });
      const r = await prisma.tournamentRole.deleteMany({ where: { tournamentId, userId: row.userId, role: row.role, entryId: { in: club.map((c) => c.id) } } });
      return { ok: true, removed: r.count };
    }
  }
  await prisma.tournamentRole.delete({ where: { id: roleId } }).catch(() => {});
  return { ok: true, removed: 1 };
}

// Lista papéis do torneio com nome/telefone do usuário e nome do time.
async function listRoles(tournamentId) {
  const rows = await prisma.tournamentRole.findMany({ where: { tournamentId }, orderBy: { createdAt: 'asc' } });
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { ownerId: true } });
  const userIds = [...new Set(rows.map((r) => r.userId).concat(t && t.ownerId ? [t.ownerId] : []))];
  const entryIds = [...new Set(rows.map((r) => r.entryId).filter(Boolean))];
  const [users, entries] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true, username: true } }),
    prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, name: true } }),
  ]);
  const uById = Object.fromEntries(users.map((u) => [u.id, u]));
  const eById = Object.fromEntries(entries.map((e) => [e.id, e]));
  const out = rows.map((r) => ({
    id: r.id, role: r.role, roleLabel: ROLE_LABEL[r.role] || r.role,
    user: uById[r.userId] || { id: r.userId }, entry: r.entryId ? (eById[r.entryId] || { id: r.entryId }) : null,
    createdAt: r.createdAt,
  }));
  // fundador implícito (ownerId) aparece na lista mesmo sem linha
  if (t && t.ownerId && !rows.some((r) => r.role === 'FOUNDER' && r.userId === t.ownerId)) {
    out.unshift({ id: null, role: 'FOUNDER', roleLabel: ROLE_LABEL.FOUNDER, user: uById[t.ownerId] || { id: t.ownerId }, entry: null, implicit: true });
  }
  return out;
}

// ---------------------------------------------------------------------
// Resolvers de contexto (pra checar permissão a partir de entry/partida/jogador/evento)
// ---------------------------------------------------------------------
async function entryContext(entryId) {
  if (!entryId) return null;
  return prisma.tournamentEntry.findUnique({ where: { id: String(entryId) }, select: { id: true, tournamentId: true, name: true, categoryId: true } });
}
async function matchContext(matchId) {
  if (!matchId) return null;
  return prisma.tournamentMatch.findUnique({ where: { id: String(matchId) }, select: { id: true, tournamentId: true, homeEntryId: true, awayEntryId: true } });
}
async function playerContext(playerId) {
  if (!playerId) return null;
  const p = await prisma.rosterPlayer.findUnique({ where: { id: String(playerId) }, select: { id: true, entryId: true } });
  if (!p) return null;
  return { player: p, entry: await entryContext(p.entryId) };
}
async function eventContext(eventId) {
  if (!eventId) return null;
  const ev = await prisma.matchEvent.findUnique({ where: { id: String(eventId) }, select: { id: true, matchId: true } });
  if (!ev) return null;
  return { event: ev, match: await matchContext(ev.matchId) };
}

// Jogos que EU devo apitar neste torneio (pra tela da arbitragem).
// Coordenador/fundador/admin → todos. Árbitro → os jogos em que foi escalado + os jogos
// sem escala de árbitro quando o torneio NÃO exige escala (flag requireRefereeAssignment).
async function tournamentRequiresAssignment(tournamentId) {
  const t = await prisma.tournament.findUnique({ where: { id: String(tournamentId) }, select: { requireRefereeAssignment: true } });
  return !!(t && t.requireRefereeAssignment);
}
async function myMatches(userId, userRole, tournamentId) {
  const rs = await rolesFor(userId, tournamentId);
  const admin = isGlobalAdmin(userRole);
  const isCoord = admin || rs.some((r) => r.role === 'FOUNDER' || r.role === 'COORDINATOR');
  const isRef = rs.some((r) => r.role === 'REFEREE');
  if (!isCoord && !isRef) return [];
  const matches = await prisma.tournamentMatch.findMany({
    where: { tournamentId },
    orderBy: [{ scheduledAt: 'asc' }, { round: 'asc' }, { ordering: 'asc' }],
    select: {
      id: true, tournamentId: true, categoryId: true, stage: true, round: true, groupName: true,
      homeEntryId: true, awayEntryId: true, homeSourceLabel: true, awaySourceLabel: true,
      scheduledAt: true, location: true, homeScore: true, awayScore: true, status: true,
    },
  });
  if (!matches.length) return [];
  const officials = await prisma.matchOfficial.findMany({ where: { matchId: { in: matches.map((m) => m.id) } }, select: { matchId: true, userId: true, role: true } });
  const nominatedMine = {}; const hasRef = {};
  officials.forEach((o) => { if (REF_OFFICIAL_ROLES.includes(o.role)) hasRef[o.matchId] = true; if (o.userId === userId) nominatedMine[o.matchId] = true; });
  const requireAssign = await tournamentRequiresAssignment(tournamentId);
  const entryIds = [...new Set(matches.flatMap((m) => [m.homeEntryId, m.awayEntryId]).filter(Boolean))];
  const catIds = [...new Set(matches.map((m) => m.categoryId).filter(Boolean))];
  const [entries, cats] = await Promise.all([
    prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, name: true } }),
    prisma.tournamentCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } }),
  ]);
  const eById = Object.fromEntries(entries.map((e) => [e.id, e.name]));
  const cById = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const out = [];
  for (const m of matches) {
    const nominated = !!nominatedMine[m.id];
    // árbitro vê os jogos dele + (flag desligada) os jogos sem escala de árbitro
    if (!isCoord && !nominated && (hasRef[m.id] || requireAssign)) continue;
    out.push({
      id: m.id, tournamentId: m.tournamentId, categoryId: m.categoryId, category: cById[m.categoryId] || '',
      stage: m.stage, round: m.round, groupName: m.groupName, status: m.status,
      scheduledAt: m.scheduledAt, location: m.location, homeScore: m.homeScore, awayScore: m.awayScore,
      home: m.homeEntryId ? (eById[m.homeEntryId] || '') : (m.homeSourceLabel || 'A definir'),
      away: m.awayEntryId ? (eById[m.awayEntryId] || '') : (m.awaySourceLabel || 'A definir'),
      nominated,
    });
  }
  return out;
}

// Meu(s) time(s) neste torneio (pra tela do admin do time / treinador): clube com
// suas inscrições por categoria + contagem de elenco. Clube único = todas as categorias.
async function myTeam(userId, userRole, tournamentId) {
  const rs = await rolesFor(userId, tournamentId);
  const teamEntryIds = rs.filter((r) => (r.role === 'TEAM_ADMIN' || r.role === 'COACH') && r.entryId).map((r) => r.entryId);
  if (!teamEntryIds.length) return { clubs: [] };
  const named = await prisma.tournamentEntry.findMany({ where: { id: { in: teamEntryIds } }, select: { name: true } });
  const clubNames = [...new Set(named.map((e) => e.name))];
  if (!clubNames.length) return { clubs: [] };
  const entries = await prisma.tournamentEntry.findMany({ where: { tournamentId, name: { in: clubNames } }, select: { id: true, name: true, categoryId: true, logoUrl: true } });
  const catIds = [...new Set(entries.map((e) => e.categoryId).filter(Boolean))];
  const cats = await prisma.tournamentCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } });
  const cById = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  let rosterCount = {};
  try {
    const g = await prisma.rosterPlayer.groupBy({ by: ['entryId'], where: { entryId: { in: entries.map((e) => e.id) } }, _count: { _all: true } });
    rosterCount = Object.fromEntries(g.map((r) => [r.entryId, r._count._all]));
  } catch (e) { /* groupBy pode faltar em bases antigas */ }
  const byClub = {};
  entries.forEach((e) => {
    const c = (byClub[e.name] = byClub[e.name] || { name: e.name, logoUrl: null, entries: [] });
    if (e.logoUrl && !c.logoUrl) c.logoUrl = e.logoUrl;
    c.entries.push({ entryId: e.id, category: cById[e.categoryId] || '', categoryId: e.categoryId, roster: rosterCount[e.id] || 0 });
  });
  return { clubs: Object.values(byClub) };
}

// "Meus papéis" neste torneio + o que posso fazer (pra UI rotear).
async function myRoles(userId, userRole, tournamentId) {
  const roles = await rolesFor(userId, tournamentId);
  const admin = isGlobalAdmin(userRole);
  const c = (a) => can(userId, userRole, tournamentId, a);
  const caps = {
    manageTournament: await c('MANAGE_TOURNAMENT'),
    assignRoles: await c('ASSIGN_ROLES'),
    assignLeadRoles: await c('ASSIGN_LEAD_ROLES'),
    referee: await c('REFEREE'),
    post: await c('POST'),
    correctResult: await c('CORRECT_RESULT'),
    viewAudit: await c('VIEW_AUDIT'),
    money: await c('MONEY'),
    archive: await c('DELETE_TOURNAMENT'),
    restore: await c('RESTORE'),
    transfer: await c('TRANSFER'),
    regenerateForce: await c('REGENERATE_FORCE'),
  };
  const teams = roles.filter((r) => TEAM_SCOPED.includes(r.role) && r.entryId);
  const refereeAssignment = (await tournamentRequiresAssignment(tournamentId)) ? 'required' : 'open';
  return { roles: roles.map((r) => ({ role: r.role, roleLabel: ROLE_LABEL[r.role] || r.role, entryId: r.entryId })), caps, teams, isGlobalAdmin: admin, refereeAssignment };
}

module.exports = {
  ROLES, ROLE_LABEL, TEAM_SCOPED, OFFICIAL_ROLES, ACTIONS, isGlobalAdmin,
  rolesFor, can, isNominated, matchHasRefereeAssigned, tournamentRequiresAssignment, REF_OFFICIAL_ROLES, resolveUser, assignRole, removeRole, listRoles, myRoles,
  entryContext, matchContext, playerContext, eventContext, myMatches, myTeam,
};
