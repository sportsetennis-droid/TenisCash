// =====================================================================
// APEX — Vínculo ATLETA ↔ TIME (clube) com CONVITE/ACEITE nos dois sentidos.
// ---------------------------------------------------------------------
// Um lado convida, o outro aceita:
//  - ATLETA pede pra entrar num time  → PENDING (initiatedBy=ATHLETE) → o TIME aceita
//  - TIME convida um atleta            → PENDING (initiatedBy=TEAM)    → o ATLETA aceita
// Se os dois lados se cruzam (atleta pediu E time convidou), vira ACTIVE na hora.
// Clube = UM só em várias categorias → o vínculo é por NOME do clube (clubName);
// ao aceitar, o atleta ganha o papel PLAYER (que replica em todas as categorias).
// Genérico pra TODO torneio. Nunca mexe em comprado/estoque/fiscal.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const roles = require('./tournamentRoles');
const { notify, notifyMany } = require('./notify');

// Clubes distintos do torneio (1 por nome), com um entryId representativo + escudo.
async function listTeams(tournamentId) {
  const entries = await prisma.tournamentEntry.findMany({
    where: { tournamentId }, select: { id: true, name: true, logoUrl: true }, orderBy: { name: 'asc' },
  });
  const seen = {}; const out = [];
  for (const e of entries) {
    if (seen[e.name]) { if (e.logoUrl && !seen[e.name].logoUrl) seen[e.name].logoUrl = e.logoUrl; continue; }
    seen[e.name] = { entryId: e.id, name: e.name, logoUrl: e.logoUrl || null };
    out.push(seen[e.name]);
  }
  return out;
}

async function clubOfEntry(entryId, tournamentId) {
  const e = await prisma.tournamentEntry.findFirst({ where: { id: String(entryId), tournamentId }, select: { id: true, name: true } });
  return e ? e.name : null;
}
async function clubEntryIds(tournamentId, clubName) {
  const es = await prisma.tournamentEntry.findMany({ where: { tournamentId, name: clubName }, select: { id: true } });
  return es.map((e) => e.id);
}

// Quem administra um clube (pra notificar / pra saber quem pode aceitar um pedido de atleta):
// admins/treinadores do clube + fundador + coordenadores do torneio.
async function clubManagerIds(tournamentId, clubName) {
  const entryIds = await clubEntryIds(tournamentId, clubName);
  const teamRows = entryIds.length
    ? await prisma.tournamentRole.findMany({ where: { tournamentId, role: { in: ['TEAM_ADMIN', 'COACH'] }, entryId: { in: entryIds } }, select: { userId: true } })
    : [];
  const coordRows = await prisma.tournamentRole.findMany({ where: { tournamentId, role: { in: ['FOUNDER', 'COORDINATOR'] } }, select: { userId: true } });
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, select: { ownerId: true } });
  const ids = new Set([...teamRows, ...coordRows].map((r) => r.userId));
  if (t && t.ownerId) ids.add(t.ownerId);
  return [...ids];
}

// Marca ACTIVE + credencia o atleta como PLAYER do clube (papel replica nas categorias).
async function activate(m) {
  const entryIds = await clubEntryIds(m.tournamentId, m.clubName);
  const anchor = entryIds[0];
  const updated = await prisma.teamMembership.update({ where: { id: m.id }, data: { status: 'ACTIVE', respondedAt: new Date() } });
  if (anchor) await roles.assignRole(m.tournamentId, { userId: m.userId, role: 'PLAYER', entryId: anchor }).catch(() => {});
  return updated;
}

// ATLETA pede pra entrar num time (entryId identifica o clube).
async function requestJoin({ tournamentId, entryId, userId }) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { ok: false, code: 404, error: 'time não encontrado neste torneio' };
  const existing = await prisma.teamMembership.findFirst({ where: { tournamentId, clubName, userId } });
  if (existing && existing.status === 'ACTIVE') return { ok: true, membership: existing, already: true };
  // o time já tinha convidado este atleta → cruzou → ativa
  if (existing && existing.status === 'PENDING' && existing.initiatedBy === 'TEAM') {
    const m = await activate(existing);
    await notifyMany(await clubManagerIds(tournamentId, clubName), { type: 'team', title: 'Atleta entrou no time', body: `Entrou pra ${clubName}.`, link: `/torneios.html#t/${tournamentId}` }, userId);
    return { ok: true, membership: m, activated: true };
  }
  const data = { tournamentId, clubName, userId, status: 'PENDING', initiatedBy: 'ATHLETE', invitedByUserId: userId, respondedAt: null };
  const m = existing
    ? await prisma.teamMembership.update({ where: { id: existing.id }, data })
    : await prisma.teamMembership.create({ data });
  const athlete = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  await notifyMany(await clubManagerIds(tournamentId, clubName), { type: 'team', title: 'Pedido pra entrar no time', body: `${(athlete && athlete.name) || 'Um atleta'} quer entrar no ${clubName}. Aceite ou recuse.`, link: `/torneios.html#t/${tournamentId}` }, userId);
  return { ok: true, membership: m, requested: true };
}

// TIME convida um atleta (quem convida precisa de MANAGE_TEAM — checado na rota).
async function inviteAthlete({ tournamentId, entryId, inviterUserId, invitee }) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { ok: false, code: 404, error: 'time não encontrado neste torneio' };
  const user = await roles.resolveUser(invitee);
  if (!user) return { ok: false, code: 404, error: 'atleta não encontrado (confira o telefone/@)' };
  const existing = await prisma.teamMembership.findFirst({ where: { tournamentId, clubName, userId: user.id } });
  if (existing && existing.status === 'ACTIVE') return { ok: true, membership: existing, already: true, user };
  // o atleta já tinha pedido → cruzou → ativa
  if (existing && existing.status === 'PENDING' && existing.initiatedBy === 'ATHLETE') {
    const m = await activate(existing);
    await notify(user.id, { type: 'team', title: 'Você entrou no time', body: `Agora você joga pelo ${clubName}.`, link: `/torneios.html#t/${tournamentId}` });
    return { ok: true, membership: m, activated: true, user };
  }
  const data = { tournamentId, clubName, userId: user.id, status: 'PENDING', initiatedBy: 'TEAM', invitedByUserId: inviterUserId, respondedAt: null };
  const m = existing
    ? await prisma.teamMembership.update({ where: { id: existing.id }, data })
    : await prisma.teamMembership.create({ data });
  await notify(user.id, { type: 'team', title: 'Convite de time', body: `O ${clubName} te convidou. Aceite no app.`, link: `/torneios.html#t/${tournamentId}` });
  return { ok: true, membership: m, invited: true, user };
}

// O OUTRO LADO responde (accept | decline).
async function respond({ tournamentId, membershipId, userId, userRole, action }) {
  const m = await prisma.teamMembership.findFirst({ where: { id: membershipId, tournamentId } });
  if (!m) return { ok: false, code: 404, error: 'convite não encontrado' };
  if (m.status === 'ACTIVE') return { ok: true, membership: m, already: true };
  if (m.status !== 'PENDING') return { ok: false, code: 409, error: 'convite já respondido' };

  // Quem é o OUTRO lado? Convite do TIME → responde o ATLETA (dono do vínculo).
  // Pedido do ATLETA → responde um GESTOR do clube.
  let allowed = false;
  if (m.initiatedBy === 'TEAM') allowed = m.userId === userId || roles.isGlobalAdmin(userRole);
  else { // ATHLETE
    const entryIds = await clubEntryIds(tournamentId, m.clubName);
    allowed = roles.isGlobalAdmin(userRole);
    for (const eid of entryIds) { if (await roles.can(userId, userRole, tournamentId, 'MANAGE_TEAM', { entryId: eid })) { allowed = true; break; } }
  }
  if (!allowed) return { ok: false, code: 403, error: 'só o outro lado pode responder este convite' };

  if (action === 'accept') {
    const active = await activate(m);
    // avisa o lado que iniciou
    if (m.initiatedBy === 'TEAM') {
      await notify(m.userId, { type: 'team', title: 'Você entrou no time', body: `Agora você joga pelo ${m.clubName}.`, link: `/torneios.html#t/${tournamentId}` });
    } else {
      await notifyMany(await clubManagerIds(tournamentId, m.clubName), { type: 'team', title: 'Atleta aceito no time', body: `Novo atleta no ${m.clubName}.`, link: `/torneios.html#t/${tournamentId}` }, userId);
    }
    return { ok: true, membership: active, accepted: true };
  }
  const declined = await prisma.teamMembership.update({ where: { id: m.id }, data: { status: 'DECLINED', respondedAt: new Date() } });
  return { ok: true, membership: declined, declined: true };
}

// Remove o vínculo (atleta sai, ou gestor tira) + tira o papel PLAYER do clube.
async function removeMembership({ tournamentId, membershipId, userId, userRole }) {
  const m = await prisma.teamMembership.findFirst({ where: { id: membershipId, tournamentId } });
  if (!m) return { ok: true, removed: 0 };
  let allowed = m.userId === userId || roles.isGlobalAdmin(userRole);
  if (!allowed) {
    const entryIds = await clubEntryIds(tournamentId, m.clubName);
    for (const eid of entryIds) { if (await roles.can(userId, userRole, tournamentId, 'MANAGE_TEAM', { entryId: eid })) { allowed = true; break; } }
  }
  if (!allowed) return { ok: false, code: 403, error: 'sem permissão' };
  await prisma.teamMembership.update({ where: { id: m.id }, data: { status: 'REMOVED', respondedAt: new Date() } });
  // tira o papel PLAYER do atleta neste clube
  const entryIds = await clubEntryIds(tournamentId, m.clubName);
  if (entryIds.length) await prisma.tournamentRole.deleteMany({ where: { tournamentId, userId: m.userId, role: 'PLAYER', entryId: { in: entryIds } } }).catch(() => {});
  return { ok: true, removed: 1 };
}

// Lista do CLUBE: atletas ativos + pendências (pra tela do admin do time).
async function listForClub(tournamentId, entryId) {
  const clubName = await clubOfEntry(entryId, tournamentId);
  if (!clubName) return { clubName: null, active: [], pending: [] };
  const rows = await prisma.teamMembership.findMany({ where: { tournamentId, clubName, status: { in: ['ACTIVE', 'PENDING'] } }, orderBy: { createdAt: 'asc' } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true, phone: true, username: true } });
  const uById = Object.fromEntries(users.map((u) => [u.id, u]));
  const map = (r) => ({ id: r.id, status: r.status, initiatedBy: r.initiatedBy, user: uById[r.userId] || { id: r.userId }, createdAt: r.createdAt });
  return {
    clubName,
    active: rows.filter((r) => r.status === 'ACTIVE').map(map),
    pending: rows.filter((r) => r.status === 'PENDING').map(map),
  };
}

// Do ATLETA: meus vínculos ativos + convites de time pendentes (pra aceitar).
async function listForUser(tournamentId, userId) {
  const rows = await prisma.teamMembership.findMany({ where: { tournamentId, userId, status: { in: ['ACTIVE', 'PENDING'] } }, orderBy: { createdAt: 'desc' } });
  return {
    active: rows.filter((r) => r.status === 'ACTIVE').map((r) => ({ id: r.id, clubName: r.clubName })),
    // convites do TIME que o atleta precisa aceitar
    invites: rows.filter((r) => r.status === 'PENDING' && r.initiatedBy === 'TEAM').map((r) => ({ id: r.id, clubName: r.clubName })),
    // pedidos que o atleta fez e aguardam o time
    requested: rows.filter((r) => r.status === 'PENDING' && r.initiatedBy === 'ATHLETE').map((r) => ({ id: r.id, clubName: r.clubName })),
  };
}

module.exports = {
  listTeams, clubOfEntry, requestJoin, inviteAthlete, respond, removeMembership, listForClub, listForUser,
};
