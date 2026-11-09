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

// Pode executar `action` neste torneio? opts: { entryId, matchId }
// actions: MANAGE_TOURNAMENT | ASSIGN_ROLES | MANAGE_TEAM | SET_LINEUP | REFEREE | VIEW
async function can(userId, userRole, tournamentId, action, opts = {}) {
  if (isGlobalAdmin(userRole)) return true;
  if (!userId) return false;
  const roles = await rolesFor(userId, tournamentId);
  const isFounder = roles.some((r) => r.role === 'FOUNDER');
  const isCoord = isFounder || roles.some((r) => r.role === 'COORDINATOR');
  const teamAdminOf = (eid) => roles.some((r) => r.role === 'TEAM_ADMIN' && r.entryId === eid);
  const coachOf = (eid) => roles.some((r) => r.role === 'COACH' && r.entryId === eid);
  const isReferee = roles.some((r) => r.role === 'REFEREE');

  switch (action) {
    case 'VIEW':
      return true;
    case 'MANAGE_TOURNAMENT':
    case 'ASSIGN_ROLES':
      return isCoord; // fundador ou coordenador
    case 'MANAGE_TEAM':
      return isCoord || teamAdminOf(opts.entryId);
    case 'SET_LINEUP':
      return isCoord || teamAdminOf(opts.entryId) || coachOf(opts.entryId);
    case 'REFEREE': {
      if (isCoord) return true;
      if (!isReferee) return false;
      if (!opts.matchId) return true;
      // Árbitro nomeado pro jogo manda; se ninguém foi nomeado, qualquer árbitro do torneio pode.
      const mine = await prisma.matchOfficial.findFirst({ where: { matchId: opts.matchId, userId } });
      if (mine) return true;
      const total = await prisma.matchOfficial.count({ where: { matchId: opts.matchId } });
      return total === 0;
    }
    default:
      return false;
  }
}

// Resolve um usuário por id | username(@handle) | telefone.
async function resolveUser({ userId, username, phone }) {
  if (userId) return prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, name: true, phone: true, username: true } });
  if (username) {
    const h = String(username).replace(/^@/, '').trim();
    if (h) return prisma.user.findFirst({ where: { username: { equals: h, mode: 'insensitive' } }, select: { id: true, name: true, phone: true, username: true } });
  }
  if (phone) {
    const p = String(phone).replace(/\D/g, '');
    if (p) return prisma.user.findUnique({ where: { phone: p }, select: { id: true, name: true, phone: true, username: true } });
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

// "Meus papéis" neste torneio + o que posso fazer (pra UI rotear).
async function myRoles(userId, userRole, tournamentId) {
  const roles = await rolesFor(userId, tournamentId);
  const admin = isGlobalAdmin(userRole);
  const caps = {
    manageTournament: admin || (await can(userId, userRole, tournamentId, 'MANAGE_TOURNAMENT')),
    assignRoles: admin || (await can(userId, userRole, tournamentId, 'ASSIGN_ROLES')),
    referee: admin || (await can(userId, userRole, tournamentId, 'REFEREE')),
  };
  const teams = roles.filter((r) => TEAM_SCOPED.includes(r.role) && r.entryId);
  return { roles: roles.map((r) => ({ role: r.role, roleLabel: ROLE_LABEL[r.role] || r.role, entryId: r.entryId })), caps, teams, isGlobalAdmin: admin };
}

module.exports = {
  ROLES, ROLE_LABEL, TEAM_SCOPED, OFFICIAL_ROLES, isGlobalAdmin,
  rolesFor, can, resolveUser, assignRole, removeRole, listRoles, myRoles,
};
