// =====================================================================
// Liga Aberta F2 — CONVITE para o jogador REIVINDICAR a vaga do elenco
// ---------------------------------------------------------------------
// Fluxo:
//  1. coordenação / admin do time / treinador gera o convite de UMA vaga
//     (RosterPlayer): token aleatório (32 bytes), validade (padrão 7 dias),
//     uso único. No banco fica só o HASH do token.
//  2. o sistema devolve o link /convite-elenco/<token> e um texto pronto de
//     WhatsApp — quem MANDA é o organizador (o sistema não envia nada sozinho).
//  3. o jogador abre o link, entra ou cria conta e reivindica:
//     RosterPlayer.userId = ele (+ vínculo ATIVO com o time e papel PLAYER).
//     A partir daí os gols/assistências/cartões dele (MatchEvent.playerId)
//     entram no histórico pessoal (athleteHistory).
//  4. desvincular: só o próprio atleta ou a coordenação (fundador/coordenador/
//     admin global) — auditado em TournamentAudit.
// =====================================================================

const crypto = require('crypto');
const { prisma } = require('../middleware');
const { publicBaseUrl } = require('../config/publicUrl');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

class InviteError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || null; } }
const fail = (status, msg, extra) => { throw new InviteError(status, msg, extra); };

function hashToken(token) {
  return crypto.createHash('sha256').update('roster-invite:' + String(token)).digest('hex');
}
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function validTokenShape(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(token); }

function baseUrl() { return publicBaseUrl(); }

// Gera (ou regenera) o convite de uma vaga. Convites anteriores ainda não usados são revogados.
async function createInvite({ playerId, userId, userRole, days }) {
  const p = await prisma.rosterPlayer.findUnique({ where: { id: String(playerId) }, select: { id: true, entryId: true, name: true, number: true, userId: true } });
  if (!p) fail(404, 'jogador não encontrado');
  const entry = await prisma.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { id: true, name: true, tournamentId: true } });
  if (!entry) fail(404, 'time não encontrado');
  if (!(await roles.can(userId, userRole, entry.tournamentId, 'SET_LINEUP', { entryId: entry.id }))) {
    fail(403, 'sem permissão (coordenação, admin ou treinador do time)');
  }
  if (p.userId) fail(409, 'esta vaga já foi reivindicada por uma conta');
  const t = await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { name: true, slug: true } });
  const d = Math.max(1, Math.min(Number(days) || DEFAULT_DAYS, MAX_DAYS));
  const token = newToken();
  const expiresAt = new Date(Date.now() + d * 24 * 3600 * 1000);
  await prisma.$transaction([
    prisma.rosterInvite.updateMany({ where: { rosterPlayerId: p.id, usedAt: null, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.rosterInvite.create({ data: { tokenHash: hashToken(token), rosterPlayerId: p.id, entryId: entry.id, tournamentId: entry.tournamentId, createdByUserId: userId, expiresAt } }),
  ]);
  const club = await require('./clubIdentity').clubOfEntry(entry.id);
  const teamName = club ? club.name : entry.name;
  const url = baseUrl() + '/convite-elenco/' + token;
  const whatsappText = `Fala, ${p.name}! Você está no elenco do ${teamName} em "${t ? t.name : 'campeonato'}". `
    + `Toque no link para entrar com a sua conta e guardar seus jogos, gols e títulos no seu histórico: ${url}`;
  await audit.record({ tournamentId: entry.tournamentId, userId, action: 'roster.invite', entity: 'RosterPlayer', entityId: p.id, after: { expiresAt, days: d } });
  return {
    ok: true, token, url, expiresAt, days: d,
    whatsappText, whatsappUrl: 'https://wa.me/?text=' + encodeURIComponent(whatsappText),
    player: { id: p.id, name: p.name, number: p.number },
  };
}

// Estado do convite (público, sem login): o que o jogador vê ao abrir o link.
async function inviteInfo(token) {
  if (!validTokenShape(token)) return { status: 'invalid' };
  const inv = await prisma.rosterInvite.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!inv) return { status: 'invalid' };
  const p = await prisma.rosterPlayer.findUnique({ where: { id: inv.rosterPlayerId }, select: { id: true, name: true, number: true, userId: true, entryId: true } });
  const entry = p ? await prisma.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { id: true, name: true, logoUrl: true, tournamentId: true } }) : null;
  const t = entry ? await prisma.tournament.findUnique({ where: { id: entry.tournamentId }, select: { name: true, slug: true, sport: true, visibility: true, archivedAt: true } }) : null;
  if (!p || !entry || !t || t.archivedAt) return { status: 'invalid' };
  await require('./clubIdentity').brand(entry);
  let status = 'valid';
  if (inv.usedAt) status = 'used';
  else if (inv.revokedAt) status = 'revoked';
  else if (inv.expiresAt < new Date()) status = 'expired';
  else if (p.userId) status = 'used';
  return {
    status, expiresAt: inv.expiresAt,
    player: { name: p.name, number: p.number },
    // torneio público: escudo pela rota pública; privado/não listado: escudo só se for link https (a rota pública daria 404)
    team: { name: entry.name, logoUrl: entry.logoUrl && !String(entry.logoUrl).startsWith('data:') ? entry.logoUrl : (entry.logoUrl && (t.visibility || 'public') === 'public' ? '/api/public/entries/' + entry.id + '/logo' : null), primaryColor: entry.primaryColor || null },
    tournament: { name: t.name, slug: t.visibility === 'public' ? t.slug : null, sport: t.sport },
  };
}

// Reivindica a vaga (usuário logado). Uso único, atômico.
async function claim(token, { userId }) {
  if (!userId) fail(401, 'entre na sua conta para reivindicar a vaga');
  if (!validTokenShape(token)) fail(404, 'convite inválido');
  const me = await prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, active: true, name: true } });
  if (!me || !me.active) fail(403, 'conta inativa');
  const tokenHash = hashToken(token);
  const out = await prisma.$transaction(async (tx) => {
    const inv = await tx.rosterInvite.findUnique({ where: { tokenHash } });
    if (!inv) fail(404, 'convite inválido');
    if (inv.usedAt) fail(410, 'este convite já foi usado', { status: 'used' });
    if (inv.revokedAt) fail(410, 'este convite foi substituído por um novo — peça o link atualizado', { status: 'revoked' });
    if (inv.expiresAt < new Date()) fail(410, 'convite expirado — peça um novo ao organizador', { status: 'expired' });
    const t = await tx.tournament.findUnique({ where: { id: inv.tournamentId }, select: { id: true, archivedAt: true } });
    if (!t || t.archivedAt) fail(404, 'convite inválido');
    const p = await tx.rosterPlayer.findUnique({ where: { id: inv.rosterPlayerId }, select: { id: true, entryId: true, userId: true, name: true } });
    if (!p) fail(404, 'a vaga não existe mais');
    if (p.userId) fail(409, 'esta vaga já foi reivindicada', { status: 'used' });
    const dup = await tx.rosterPlayer.findFirst({ where: { entryId: p.entryId, userId: me.id, NOT: { id: p.id } }, select: { name: true } });
    if (dup) fail(409, 'sua conta já está ligada a "' + dup.name + '" neste time');
    // uso único: marca o convite primeiro (corrida = só um passa)
    const used = await tx.rosterInvite.updateMany({ where: { id: inv.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date(), usedByUserId: me.id } });
    if (used.count !== 1) fail(410, 'este convite já foi usado', { status: 'used' });
    const linked = await tx.rosterPlayer.updateMany({ where: { id: p.id, userId: null }, data: { userId: me.id } });
    if (linked.count !== 1) fail(409, 'esta vaga já foi reivindicada', { status: 'used' });
    const entry = await tx.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { id: true, name: true, tournamentId: true } });
    // vínculo ATIVO com o time (o time convidou, o atleta aceitou). Guarda se NASCEU aqui
    // (pra desvincular desfazer só o que o convite criou).
    const prevTm = await tx.teamMembership.findUnique({ where: { tournamentId_clubName_userId: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id } }, select: { status: true } });
    const prevRole = await tx.tournamentRole.findFirst({ where: { tournamentId: entry.tournamentId, userId: me.id, role: 'PLAYER' }, select: { id: true } });
    await tx.teamMembership.upsert({
      where: { tournamentId_clubName_userId: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id } },
      update: { status: 'ACTIVE', respondedAt: new Date() },
      create: { tournamentId: entry.tournamentId, clubName: entry.name, userId: me.id, status: 'ACTIVE', initiatedBy: 'TEAM', invitedByUserId: inv.createdByUserId, respondedAt: new Date() },
    });
    return { player: p, entry, inviteId: inv.id, membershipCreated: !prevTm || prevTm.status !== 'ACTIVE', roleCreated: !prevRole };
  });
  await roles.assignRole(out.entry.tournamentId, { userId: me.id, role: 'PLAYER', entryId: out.entry.id }).catch(() => {});
  await audit.record({ tournamentId: out.entry.tournamentId, userId: me.id, action: 'roster.claim', entity: 'RosterPlayer', entityId: out.player.id, before: { userId: null }, after: { userId: me.id, inviteId: out.inviteId, membershipCreated: out.membershipCreated, roleCreated: out.roleCreated } });
  return { ok: true, playerId: out.player.id, entryId: out.entry.id, tournamentId: out.entry.tournamentId, name: out.player.name };
}

// Desvincula a conta de uma vaga: o próprio atleta ou a coordenação. Auditado.
async function unlink({ playerId, userId, userRole, reason }) {
  const p = await prisma.rosterPlayer.findUnique({ where: { id: String(playerId) }, select: { id: true, entryId: true, userId: true, name: true } });
  if (!p) fail(404, 'jogador não encontrado');
  const entry = await prisma.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { tournamentId: true } });
  if (!entry) fail(404, 'jogador não encontrado');
  if (!p.userId) return { ok: true, already: true };
  const self = p.userId === userId;
  if (!self && !(await roles.can(userId, userRole, entry.tournamentId, 'MANAGE_TOURNAMENT'))) {
    fail(403, 'só o próprio atleta ou a coordenação do campeonato desvincula a conta');
  }
  const r = await prisma.rosterPlayer.updateMany({ where: { id: p.id, userId: p.userId }, data: { userId: null } });
  // Desfaz o que o CONVITE criou (vínculo ativo e papel PLAYER), se a pessoa não tem
  // outra vaga ligada no mesmo clube deste torneio. O que já existia antes fica.
  const reverted = { membership: false, role: false };
  try {
    const claimAudit = await prisma.tournamentAudit.findFirst({ where: { tournamentId: entry.tournamentId, action: 'roster.claim', entityId: p.id }, orderBy: { createdAt: 'desc' } });
    const a = claimAudit && claimAudit.after;
    if (a && a.userId === p.userId) {
      const ent = await prisma.tournamentEntry.findUnique({ where: { id: p.entryId }, select: { name: true } });
      const club = await prisma.tournamentEntry.findMany({ where: { tournamentId: entry.tournamentId, name: ent.name }, select: { id: true } });
      const other = await prisma.rosterPlayer.findFirst({ where: { userId: p.userId, entryId: { in: club.map((e) => e.id) } }, select: { id: true } });
      if (!other) {
        if (a.membershipCreated) reverted.membership = (await prisma.teamMembership.updateMany({ where: { tournamentId: entry.tournamentId, clubName: ent.name, userId: p.userId, status: 'ACTIVE' }, data: { status: 'REMOVED', respondedAt: new Date() } })).count > 0;
        if (a.roleCreated) reverted.role = (await prisma.tournamentRole.deleteMany({ where: { tournamentId: entry.tournamentId, userId: p.userId, role: 'PLAYER', entryId: { in: club.map((e) => e.id) } } })).count > 0;
      }
    }
  } catch (e) { console.error('[rosterInvite] desfazer vínculo do convite', e.message); }
  await audit.record({ tournamentId: entry.tournamentId, userId, action: 'roster.unlink', entity: 'RosterPlayer', entityId: p.id, before: { userId: p.userId }, after: { userId: null, by: self ? 'self' : 'coordination', reason: reason ? String(reason).slice(0, 200) : null, reverted } });
  return { ok: true, unlinked: r.count, reverted };
}

module.exports = { InviteError, createInvite, inviteInfo, claim, unlink, hashToken, DEFAULT_DAYS };
