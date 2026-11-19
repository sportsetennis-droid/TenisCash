// =====================================================================
// Liga Aberta F3 — LINK DO TIME para o próprio time preencher o elenco
// ---------------------------------------------------------------------
// Diferente do convite por VAGA da F2 (rosterInvite, uso único, uma vaga já
// criada): aqui o organizador / admin do time gera UM link do TIME; cada
// pessoa que abre entra (ou cria conta) e se adiciona ao elenco daquele time
// — vira RosterPlayer com userId e papel PLAYER. Vale para várias pessoas até
// vencer ou ser revogado. Respeita o limite do elenco da categoria
// (gameRules.maxRoster), se houver. No banco só o hash do token. Auditado.
// O sistema NÃO envia nada: devolve link + texto pronto de WhatsApp.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const { publicBaseUrl } = require('../config/publicUrl');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');
const gameRules = require('./tournamentRules');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

class TeamInviteError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || null; } }
const fail = (status, msg, extra) => { throw new TeamInviteError(status, msg, extra); };

function hashToken(token) { return crypto.createHash('sha256').update('team-invite:' + String(token)).digest('hex'); }
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function validTokenShape(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(token); }

async function loadEntry(db, entryId) {
  const e = await db.tournamentEntry.findUnique({ where: { id: String(entryId) }, select: { id: true, name: true, tournamentId: true, categoryId: true, _count: { select: { members: true } } } });
  if (!e) fail(404, 'time não encontrado');
  return e;
}
async function rulesOfEntry(db, entry) {
  const [cat, t] = await Promise.all([
    db.tournamentCategory.findUnique({ where: { id: entry.categoryId } }),
    db.tournament.findUnique({ where: { id: entry.tournamentId }, select: { sport: true } }),
  ]);
  return gameRules.resolveRules(cat, t && t.sport);
}

// Gera o link do time (revoga o anterior ainda ativo). Coordenação ou admin do PRÓPRIO time.
async function createInvite({ entryId, userId, userRole, days, public: isPublic = false }) {
  const entry = await loadEntry(prisma, entryId);
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
    fail(403, 'só a organização ou o administrador deste time gera o link do time');
  }
  if (entry._count.members > 0) fail(400, 'link do time é para inscrição de TIME (esta inscrição é de atleta/dupla)');
  const t = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { name: true, archivedAt: true } });
  if (!t || t.archivedAt) fail(404, 'time não encontrado');
  const d = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, MAX_DAYS));
  const token = newToken();
  const expiresAt = new Date(Date.now() + d * 24 * 3600 * 1000);
  const now = new Date();
  const [revoked] = await prisma.$transaction([
    prisma.teamInvite.updateMany({ where: { entryId: entry.id, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } }),
    prisma.teamInvite.updateMany({ where: { entryId: entry.id, publicToken: { not: null } }, data: { publicToken: null } }),
    prisma.teamInvite.create({ data: { tokenHash: hashToken(token), entryId: entry.id, tournamentId: entry.tournamentId, createdByUserId: userId, expiresAt, publicToken: isPublic ? token : null } }),
  ]);
  const club = await require('./clubIdentity').clubOfEntry(entry.id);
  const teamName = club ? club.name : entry.name;
  const url = publicBaseUrl() + '/convite-time/' + token;
  const whatsappText = `Bora completar o elenco do ${teamName} em "${t.name}"! `
    + `Toque no link, entre com a sua conta e você entra no time — seus jogos e gols vão pro seu histórico: ${url}`;
  await audit.record({ tournamentId: entry.tournamentId, userId, action: 'team.invite.create', entity: 'TournamentEntry', entityId: entry.id, after: { expiresAt, days: d, revokedPrevious: revoked.count } });
  return { ok: true, token, url, expiresAt, days: d, public: !!isPublic, whatsappText, whatsappUrl: 'https://wa.me/?text=' + encodeURIComponent(whatsappText), team: { id: entry.id, name: teamName } };
}

// Liga Aberta F4 — "Entrar neste time" na página pública. O time ESCOLHE mostrar o link
// ativo: com public:true, quem tem permissão manda o token do link ativo (o servidor confere
// pelo hash e guarda o token SÓ deste link público, para a página poder abrir); public:false
// esconde. Gerar um link novo ou revogar também esconde o anterior.
async function setPublic({ entryId, userId, userRole, token, public: isPublic }) {
  const entry = await loadEntry(prisma, entryId);
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
    fail(403, 'só a organização ou o administrador deste time decide se o link aparece na página');
  }
  if (!isPublic) {
    const r = await prisma.teamInvite.updateMany({ where: { entryId: entry.id, publicToken: { not: null } }, data: { publicToken: null } });
    await audit.record({ tournamentId: entry.tournamentId, userId, action: 'team.invite.public', entity: 'TournamentEntry', entityId: entry.id, after: { public: false, cleared: r.count } });
    return { ok: true, public: false };
  }
  if (!validTokenShape(token)) fail(400, 'informe o link ativo do time');
  const inv = await prisma.teamInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!inv || inv.entryId !== entry.id) fail(404, 'link não encontrado para este time');
  if (statusOf(inv) !== 'valid') fail(410, 'este link não está mais ativo — gere um novo', { status: statusOf(inv) });
  await prisma.$transaction([
    prisma.teamInvite.updateMany({ where: { entryId: entry.id, publicToken: { not: null }, NOT: { id: inv.id } }, data: { publicToken: null } }),
    prisma.teamInvite.update({ where: { id: inv.id }, data: { publicToken: token } }),
  ]);
  await audit.record({ tournamentId: entry.tournamentId, userId, action: 'team.invite.public', entity: 'TournamentEntry', entityId: entry.id, after: { public: true, expiresAt: inv.expiresAt } });
  return { ok: true, public: true, url: publicBaseUrl() + '/convite-time/' + token, expiresAt: inv.expiresAt };
}

// O link PÚBLICO ativo deste time (permissão MANAGE_TEAM) → { active: {...} | null }. Só lê.
async function currentPublic({ entryId, userId, userRole }) {
  const entry = await loadEntry(prisma, entryId);
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
    fail(403, 'só a organização ou o administrador deste time vê o link do time');
  }
  const inv = await prisma.teamInvite.findFirst({
    where: { entryId: entry.id, publicToken: { not: null }, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!inv || hashToken(inv.publicToken) !== inv.tokenHash) return { active: null };
  const t = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { name: true } });
  const club = await require('./clubIdentity').clubOfEntry(entry.id);
  const teamName = club ? club.name : entry.name;
  const url = publicBaseUrl() + '/convite-time/' + inv.publicToken;
  const whatsappText = `Bora completar o elenco do ${teamName} em "${t ? t.name : 'campeonato'}"! `
    + `Toque no link, entre com a sua conta e você entra no time — seus jogos e gols vão pro seu histórico: ${url}`;
  return { active: { token: inv.publicToken, url, expiresAt: inv.expiresAt, public: true, whatsappText, whatsappUrl: 'https://wa.me/?text=' + encodeURIComponent(whatsappText), team: { id: entry.id, name: teamName } } };
}

// Links públicos ativos do torneio → { [entryId]: { url, expiresAt, full } }. Só lê.
async function publicJoinLinks(tournamentId) {
  const now = new Date();
  const list = await prisma.teamInvite.findMany({
    where: { tournamentId: String(tournamentId), publicToken: { not: null }, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { entryId: true, publicToken: true, expiresAt: true, tokenHash: true },
  });
  const out = {};
  for (const inv of list) {
    if (out[inv.entryId] || hashToken(inv.publicToken) !== inv.tokenHash) continue;
    const entry = await prisma.tournamentEntry.findUnique({ where: { id: inv.entryId }, select: { id: true, tournamentId: true, categoryId: true } });
    if (!entry) continue;
    const rules = await rulesOfEntry(prisma, entry);
    const n = rules.maxRoster ? await prisma.rosterPlayer.count({ where: { entryId: entry.id, role: 'PLAYER' } }) : 0;
    out[inv.entryId] = { url: '/convite-time/' + inv.publicToken, expiresAt: inv.expiresAt, full: !!(rules.maxRoster && n >= rules.maxRoster) };
  }
  return out;
}

// Revoga o link ativo do time.
async function revokeInvite({ entryId, userId, userRole }) {
  const entry = await loadEntry(prisma, entryId);
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TEAM', { entryId: entry.id }))) {
    fail(403, 'só a organização ou o administrador deste time revoga o link');
  }
  const r = await prisma.teamInvite.updateMany({ where: { entryId: entry.id, revokedAt: null }, data: { revokedAt: new Date(), publicToken: null } });
  await audit.record({ tournamentId: entry.tournamentId, userId, action: 'team.invite.revoke', entity: 'TournamentEntry', entityId: entry.id, after: { revoked: r.count } });
  return { ok: true, revoked: r.count };
}

function statusOf(inv, now = new Date()) {
  if (inv.revokedAt) return 'revoked';
  if (inv.expiresAt < now) return 'expired';
  return 'valid';
}

// Estado público do link (sem login).
async function inviteInfo(token) {
  if (!validTokenShape(token)) return { status: 'invalid' };
  const inv = await prisma.teamInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!inv) return { status: 'invalid' };
  const entry = await prisma.tournamentEntry.findUnique({ where: { id: inv.entryId }, select: { id: true, name: true, logoUrl: true, tournamentId: true, categoryId: true } });
  const t = entry ? await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { name: true, slug: true, sport: true, visibility: true, archivedAt: true, suspendedAt: true } }) : null;
  if (!entry || !t || t.archivedAt || t.suspendedAt) return { status: 'invalid' }; // F6: suspenso = inválido
  await require('./clubIdentity').brand(entry);
  const rules = await rulesOfEntry(prisma, entry);
  const rosterCount = await prisma.rosterPlayer.count({ where: { entryId: entry.id, role: 'PLAYER' } });
  let status = statusOf(inv);
  if (status === 'valid' && rules.maxRoster && rosterCount >= rules.maxRoster) status = 'full';
  return {
    status, expiresAt: inv.expiresAt, rosterCount, maxRoster: rules.maxRoster || null,
    team: {
      name: entry.name,
      logoUrl: entry.logoUrl && !String(entry.logoUrl).startsWith('data:') ? entry.logoUrl : (entry.logoUrl && (t.visibility || 'public') === 'public' ? '/api/public/entries/' + entry.id + '/logo' : null),
      primaryColor: entry.primaryColor || null,
    },
    tournament: { name: t.name, slug: (t.visibility || 'public') === 'public' ? t.slug : null, sport: t.sport },
  };
}

// Entra no elenco pelo link (usuário logado). Trava a linha do time (limite do elenco sem corrida).
async function join(token, { userId }) {
  if (!userId) fail(401, 'entre na sua conta para entrar no time');
  if (!validTokenShape(token)) fail(404, 'link inválido');
  const me = await prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, active: true, name: true } });
  if (!me || !me.active) fail(403, 'conta inativa');
  const tokenHash = hashToken(token);
  const out = await prisma.$transaction(async (tx) => {
    const inv = await tx.teamInvite.findUnique({ where: { tokenHash } });
    if (!inv) fail(404, 'link inválido');
    const st = statusOf(inv);
    if (st === 'revoked') fail(410, 'este link foi desativado — peça o link novo ao time', { status: 'revoked' });
    if (st === 'expired') fail(410, 'link vencido — peça um novo ao time', { status: 'expired' });
    const t = await tx.tournament.findUnique({ where: { id: inv.tournamentId }, select: { id: true, archivedAt: true, suspendedAt: true } });
    if (!t || t.archivedAt || t.suspendedAt) fail(404, 'link inválido');
    await tx.$queryRaw`SELECT "id" FROM "TournamentEntry" WHERE "id" = ${inv.entryId} FOR UPDATE`;
    const entry = await loadEntry(tx, inv.entryId);
    if (await require('./ligaMinors').userDeclaredMinor(me.id)) fail(403, require('./ligaMinors').MINOR_JOIN_MSG); // Liga F6
    const already = await tx.rosterPlayer.findFirst({ where: { entryId: entry.id, userId: me.id }, select: { id: true, name: true } });
    if (already) fail(409, 'você já está no elenco deste time', { status: 'member', playerId: already.id });
    const rules = await rulesOfEntry(tx, entry);
    if (rules.maxRoster) {
      const n = await tx.rosterPlayer.count({ where: { entryId: entry.id, role: 'PLAYER' } });
      if (n >= rules.maxRoster) fail(409, `elenco completo (máximo de ${rules.maxRoster} jogadores nesta categoria)`, { status: 'full' });
    }
    const player = await tx.rosterPlayer.create({ data: { entryId: entry.id, name: String(me.name || 'Atleta').slice(0, 80), userId: me.id, role: 'PLAYER' } });
    await tx.teamInvite.update({ where: { id: inv.id }, data: { uses: { increment: 1 }, lastUsedAt: new Date() } });
    const prevTm = await tx.teamMembership.findUnique({ where: { tournamentId_clubName_userId: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id } }, select: { status: true } });
    await tx.teamMembership.upsert({
      where: { tournamentId_clubName_userId: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id } },
      update: { status: 'ACTIVE', respondedAt: new Date() },
      create: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id, status: 'ACTIVE', initiatedBy: 'TEAM', invitedByUserId: inv.createdByUserId, respondedAt: new Date() },
    });
    return { player, entry, inviteId: inv.id, membershipCreated: !prevTm || prevTm.status !== 'ACTIVE' };
  });
  await roles.assignRole(out.entry.tournamentId, { userId: me.id, role: 'PLAYER', entryId: out.entry.id }).catch(() => {});
  await audit.record({ tournamentId: out.entry.tournamentId, userId: me.id, action: 'roster.join', entity: 'RosterPlayer', entityId: out.player.id, after: { entryId: out.entry.id, userId: me.id, teamInviteId: out.inviteId, membershipCreated: out.membershipCreated } });
  return { ok: true, playerId: out.player.id, entryId: out.entry.id, tournamentId: out.entry.tournamentId, name: out.player.name };
}

module.exports = { TeamInviteError, createInvite, revokeInvite, setPublic, currentPublic, publicJoinLinks, inviteInfo, join, hashToken, DEFAULT_DAYS };
