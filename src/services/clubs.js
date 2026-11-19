// =====================================================================
// Club — CLUBE PERMANENTE (fora de torneio).
// ---------------------------------------------------------------------
// Clube com escudo, cores, esportes e membros (dono / técnico / atleta).
// Entrada por CONVITE: link/código do clube (entra direto) ou convite
// nominal (fica PENDING até o atleta aceitar).
// Ligação com torneios = VÍNCULO EXPLÍCITO feito pelo dono do clube
// (ClubTournamentLink: torneio + NOME EXATO da inscrição). Nada de casar
// por nome parecido: sem vínculo, o clube não "adota" jogo nenhum.
// Treinos: reaproveita TrainingSession (torneio + clubName) dos vínculos.
// Nunca mexe em estoque, fiscal ou TenisCash.
// =====================================================================

const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

let prisma = new PrismaClient();
function setPrisma(p) { prisma = p; }

const ROLES = ['owner', 'coach', 'athlete'];
const ROLE_LABEL = { owner: 'Dono', coach: 'Técnico', athlete: 'Atleta' };
const CLUB_SPORTS = new Set([
  'TENNIS', 'BEACH_TENNIS', 'PADEL', 'FUTSAL', 'SOCCER', 'VOLLEY', 'BASKETBALL',
  'HANDBALL', 'TABLE_TENNIS', 'RUNNING', 'OTHER',
]);
const PRIVACY = new Set(['public', 'private', 'invite_only']);
const ADMIN_ROLES = new Set(['admin', 'superadmin', 'manager']);

class ClubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new ClubError(status, msg); };

function normRole(r) {
  const x = String(r || '').toLowerCase();
  if (x === 'owner') return 'owner';
  if (x === 'coach' || x === 'admin' || x === 'tecnico' || x === 'técnico') return 'coach';
  return 'athlete'; // member (legado) | athlete
}

function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'clube';
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I/L
function newCode(len = 8) {
  const b = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return out;
}

function cleanCrest(v) {
  if (v === null || v === '') return null;
  const s = String(v).trim();
  if (/^https:\/\/[^\s"'<>]{4,500}$/i.test(s)) return s;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
    if (s.length > 400000) fail(400, 'escudo muito grande (máx. ~300 KB)');
    return s;
  }
  fail(400, 'escudo inválido (use https:// ou imagem PNG/JPEG/WEBP)');
}
function cleanColor(v) {
  if (v === null || v === '') return null;
  const s = String(v).trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) fail(400, 'cor inválida (use #RRGGBB)');
  return s.toUpperCase();
}
function cleanSports(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) { const s = String(x || '').toUpperCase(); if (CLUB_SPORTS.has(s) && !out.includes(s)) out.push(s); }
  return out;
}
function cleanText(v, max) { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

async function uniqueSlug(base, exceptId) {
  let slug = base;
  for (let i = 2; i < 200; i++) {
    const hit = await prisma.club.findFirst({ where: { slug }, select: { id: true } });
    if (!hit || hit.id === exceptId) return slug;
    slug = (base.slice(0, 55) + '-' + i);
  }
  return base + '-' + newCode(4).toLowerCase();
}
async function uniqueCode() {
  for (let i = 0; i < 20; i++) {
    const c = newCode();
    const hit = await prisma.club.findFirst({ where: { inviteCode: c }, select: { id: true } });
    if (!hit) return c;
  }
  fail(500, 'não foi possível gerar o código');
}

// -------------------------------------------------------------- acesso
async function loadClub(idOrSlug) {
  const c = await prisma.club.findFirst({ where: { OR: [{ id: String(idOrSlug) }, { slug: String(idOrSlug) }] } });
  if (!c) fail(404, 'clube não encontrado');
  return c;
}
async function membershipOf(clubId, userId) {
  if (!userId) return null;
  return prisma.clubMembership.findUnique({ where: { clubId_userId: { clubId, userId } } });
}
async function roleOf(club, userId, userRole) {
  const m = await membershipOf(club.id, userId);
  const r = m && m.status === 'ACTIVE' ? normRole(m.role) : null;
  if (club.ownerId === userId) return 'owner';
  if (!r && ADMIN_ROLES.has(userRole)) return 'admin';
  return r;
}
async function requireRole(club, ctx, allowed) {
  const r = await roleOf(club, ctx.userId, ctx.userRole);
  if (r === 'admin') return r;
  if (!r || !allowed.includes(r)) fail(403, allowed.includes('coach') ? 'só o dono ou o técnico do clube' : 'só o dono do clube');
  return r;
}

// ------------------------------------------------------------- criação
async function createClub(ctx, b = {}) {
  const name = cleanText(b.name, 80);
  if (!name || name.length < 2) fail(400, 'nome do clube é obrigatório');
  const sports = cleanSports(b.sports);
  const privacyLevel = PRIVACY.has(b.privacyLevel) ? b.privacyLevel : 'public';
  const club = await prisma.club.create({
    data: {
      ownerId: ctx.userId,
      name,
      description: cleanText(b.description, 2000),
      city: cleanText(b.city, 80),
      state: cleanText(b.state, 2),
      privacyLevel,
      sportScope: sports.length === 1 ? sports[0].toLowerCase() : (sports.length ? 'multi' : null),
      sports,
      crestUrl: b.crestUrl !== undefined ? cleanCrest(b.crestUrl) : null,
      primaryColor: b.primaryColor !== undefined ? cleanColor(b.primaryColor) : '#EA5128',
      secondaryColor: b.secondaryColor !== undefined ? cleanColor(b.secondaryColor) : '#FFFFFF',
      slug: await uniqueSlug(slugify(b.slug || name)),
      inviteCode: await uniqueCode(),
      memberships: { create: { userId: ctx.userId, role: 'owner', status: 'ACTIVE' } },
    },
  });
  return club;
}

async function updateClub(ctx, idOrSlug, b = {}) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner']);
  const data = {};
  if (b.name !== undefined) { const n = cleanText(b.name, 80); if (!n || n.length < 2) fail(400, 'nome inválido'); data.name = n; }
  if (b.description !== undefined) data.description = cleanText(b.description, 2000);
  if (b.city !== undefined) data.city = cleanText(b.city, 80);
  if (b.state !== undefined) data.state = cleanText(b.state, 2);
  if (b.crestUrl !== undefined) data.crestUrl = cleanCrest(b.crestUrl);
  if (b.primaryColor !== undefined) data.primaryColor = cleanColor(b.primaryColor);
  if (b.secondaryColor !== undefined) data.secondaryColor = cleanColor(b.secondaryColor);
  if (b.sports !== undefined) {
    data.sports = cleanSports(b.sports);
    data.sportScope = data.sports.length === 1 ? data.sports[0].toLowerCase() : (data.sports.length ? 'multi' : null);
  }
  if (b.privacyLevel !== undefined) { if (!PRIVACY.has(b.privacyLevel)) fail(400, 'privacidade inválida'); data.privacyLevel = b.privacyLevel; }
  if (b.slug !== undefined) data.slug = await uniqueSlug(slugify(b.slug), club.id);
  return prisma.club.update({ where: { id: club.id }, data });
}

// -------------------------------------------------------------- convite
async function inviteInfo(ctx, idOrSlug, { regenerate = false } = {}) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner', 'coach']);
  let code = club.inviteCode;
  if (!code || regenerate) {
    code = await uniqueCode();
    await prisma.club.update({ where: { id: club.id }, data: { inviteCode: code } });
  }
  return { code, path: '/clube/' + club.slug + '?convite=' + code };
}

async function joinByCode(ctx, code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) fail(400, 'código do convite é obrigatório');
  const club = await prisma.club.findFirst({ where: { inviteCode: c } });
  if (!club) fail(404, 'convite inválido ou expirado');
  const m = await membershipOf(club.id, ctx.userId);
  let membership;
  if (m && m.status === 'ACTIVE') membership = m;
  else if (m) membership = await prisma.clubMembership.update({ where: { id: m.id }, data: { status: 'ACTIVE', joinedAt: new Date() } });
  else membership = await prisma.clubMembership.create({ data: { clubId: club.id, userId: ctx.userId, role: 'athlete', status: 'ACTIVE' } });
  if (!m || m.status !== 'ACTIVE') {
    try {
      const me = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      await require('./notify').notifyMany(await managerIds(club.id), {
        type: 'club', title: 'Novo atleta no clube', body: `${(me && me.name) || 'Um atleta'} entrou no ${club.name} pelo convite.`, link: '/clube/' + club.slug,
      }, ctx.userId);
    } catch (_) {}
  }
  return { club: { id: club.id, slug: club.slug, name: club.name }, membership };
}

async function inviteUser(ctx, idOrSlug, { userId, username, role } = {}) {
  const club = await loadClub(idOrSlug);
  const myRole = await requireRole(club, ctx, ['owner', 'coach']);
  const engine = require('./tournamentEngine');
  const target = await engine.resolveUserId(userId || username);
  if (!target) fail(404, 'atleta não encontrado');
  let r = normRole(role || 'athlete');
  if (r === 'owner') fail(400, 'o dono é um só — use a troca de papel');
  if (r === 'coach' && myRole === 'coach') fail(403, 'só o dono convida técnico');
  const m = await membershipOf(club.id, target);
  if (m && m.status === 'ACTIVE') fail(409, 'já é membro do clube');
  const data = { role: r, status: 'PENDING', invitedByUserId: ctx.userId };
  const membership = m
    ? await prisma.clubMembership.update({ where: { id: m.id }, data })
    : await prisma.clubMembership.create({ data: { clubId: club.id, userId: target, ...data } });
  try {
    await require('./notify').notify(target, {
      type: 'club_invite', title: 'Convite de clube', body: `O ${club.name} te convidou como ${ROLE_LABEL[r].toLowerCase()}. Aceite na página do clube.`, link: '/clube/' + club.slug,
    });
  } catch (_) {}
  return membership;
}

async function respondInvite(ctx, idOrSlug, action) {
  const club = await loadClub(idOrSlug);
  const m = await membershipOf(club.id, ctx.userId);
  if (!m || m.status !== 'PENDING') fail(404, 'nenhum convite pendente');
  if (action !== 'accept' && action !== 'decline') fail(400, 'action inválida (accept|decline)');
  const membership = await prisma.clubMembership.update({
    where: { id: m.id },
    data: action === 'accept' ? { status: 'ACTIVE', joinedAt: new Date() } : { status: 'DECLINED' },
  });
  if (action === 'accept') {
    try {
      await require('./notify').notifyMany(await managerIds(club.id), {
        type: 'club', title: 'Convite aceito', body: `Novo membro no ${club.name}.`, link: '/clube/' + club.slug,
      }, ctx.userId);
    } catch (_) {}
  }
  return membership;
}

async function managerIds(clubId) {
  const ms = await prisma.clubMembership.findMany({ where: { clubId, status: 'ACTIVE', role: { in: ['owner', 'coach', 'admin'] } }, select: { userId: true } });
  return ms.map((m) => m.userId);
}

async function setRole(ctx, idOrSlug, targetUserId, role) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner']);
  const r = normRole(role);
  if (!ROLES.includes(String(role || '').toLowerCase()) && !['member', 'admin'].includes(String(role || '').toLowerCase())) fail(400, 'papel inválido (owner|coach|athlete)');
  const m = await membershipOf(club.id, targetUserId);
  if (!m || m.status !== 'ACTIVE') fail(404, 'membro não encontrado');
  if (r === 'owner') {
    // Transferência de dono: o antigo vira técnico. Clube tem UM dono.
    await prisma.$transaction([
      prisma.clubMembership.updateMany({ where: { clubId: club.id, role: 'owner', userId: { not: targetUserId } }, data: { role: 'coach' } }),
      prisma.clubMembership.update({ where: { id: m.id }, data: { role: 'owner' } }),
      prisma.club.update({ where: { id: club.id }, data: { ownerId: targetUserId } }),
    ]);
    return prisma.clubMembership.findUnique({ where: { id: m.id } });
  }
  if (targetUserId === club.ownerId) fail(409, 'o dono não pode perder o papel sem passar o clube pra outro membro');
  return prisma.clubMembership.update({ where: { id: m.id }, data: { role: r } });
}

async function removeMember(ctx, idOrSlug, targetUserId) {
  const club = await loadClub(idOrSlug);
  if (targetUserId === club.ownerId) fail(409, 'o dono não sai sem passar o clube pra outro membro');
  if (targetUserId !== ctx.userId) {
    const myRole = await requireRole(club, ctx, ['owner', 'coach']);
    const m = await membershipOf(club.id, targetUserId);
    if (myRole === 'coach' && m && normRole(m.role) !== 'athlete') fail(403, 'técnico só remove atleta');
  }
  const r = await prisma.clubMembership.deleteMany({ where: { clubId: club.id, userId: targetUserId } });
  if (!r.count) fail(404, 'membro não encontrado');
  return { removed: r.count };
}

// --------------------------------------------------------------- torneio
async function addLink(ctx, idOrSlug, { tournamentId, entryName } = {}) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner']);
  const name = String(entryName || '');
  if (!tournamentId || !name) fail(400, 'informe o torneio e a inscrição');
  const entry = await prisma.tournamentEntry.findFirst({ where: { tournamentId: String(tournamentId), name }, select: { id: true } });
  if (!entry) fail(404, 'inscrição com esse nome exato não existe nesse torneio');
  return prisma.clubTournamentLink.upsert({
    where: { clubId_tournamentId_entryName: { clubId: club.id, tournamentId: String(tournamentId), entryName: name } },
    update: {},
    create: { clubId: club.id, tournamentId: String(tournamentId), entryName: name, createdByUserId: ctx.userId },
  });
}
async function removeLink(ctx, idOrSlug, linkId) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner']);
  const r = await prisma.clubTournamentLink.deleteMany({ where: { id: String(linkId), clubId: club.id } });
  if (!r.count) fail(404, 'vínculo não encontrado');
  return { removed: r.count };
}
async function entryOptions(ctx, idOrSlug, tournamentId) {
  const club = await loadClub(idOrSlug);
  await requireRole(club, ctx, ['owner']);
  const es = await prisma.tournamentEntry.findMany({ where: { tournamentId: String(tournamentId) }, select: { name: true }, orderBy: { name: 'asc' } });
  return [...new Set(es.map((e) => e.name))];
}

// ------------------------------------------------------------ leitura
async function myClubs(userId) {
  const ms = await prisma.clubMembership.findMany({
    where: { userId, status: { in: ['ACTIVE', 'PENDING'] } },
    include: { club: { select: { id: true, slug: true, name: true, crestUrl: true, primaryColor: true, secondaryColor: true, sports: true, city: true } } },
    orderBy: { joinedAt: 'desc' },
  });
  return ms.map((m) => ({ ...m.club, role: normRole(m.role), status: m.status }));
}

async function publicView(idOrSlug, viewer = {}) {
  const club = await loadClub(idOrSlug);
  const viewerRole = viewer.userId ? await roleOf(club, viewer.userId, viewer.userRole) : null;
  const myMembership = viewer.userId ? await membershipOf(club.id, viewer.userId) : null;
  const isMember = !!viewerRole && viewerRole !== 'admin';
  const canSeeMembers = club.privacyLevel !== 'private' || isMember || viewerRole === 'admin';

  const memberships = await prisma.clubMembership.findMany({
    where: { clubId: club.id, status: 'ACTIVE' },
    include: { user: { select: { id: true, name: true, username: true } } },
    orderBy: { joinedAt: 'asc' },
  });
  const ids = memberships.map((m) => m.userId);
  const [profiles, ratings, medals] = await Promise.all([
    prisma.athleteProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, username: true, avatarUrl: true } }),
    prisma.glickoRating.findMany({ where: { subjectType: 'USER', subjectKey: { in: ids } } }),
    prisma.medal.findMany({
      where: { userId: { in: ids }, status: 'ACTIVE' },
      select: { serial: true, userId: true, recipientName: true, sport: true, eventName: true, categoryName: true, tier: true, placement: true, achievement: true, issuedAt: true },
      orderBy: { issuedAt: 'desc' },
      take: 40,
    }),
  ]);
  const pm = new Map(profiles.map((p) => [p.userId, p]));
  const rating = require('./clubRating');
  const best = new Map();
  for (const r of ratings) {
    const p = rating.present(r);
    const cur = best.get(r.subjectKey);
    if (!cur || p.level > cur.level) best.set(r.subjectKey, { sport: r.sport, format: r.format, level: p.level, reliability: p.reliability, provisional: p.provisional });
  }
  const order = { owner: 0, coach: 1, athlete: 2 };
  const members = memberships.map((m) => {
    const p = pm.get(m.userId) || {};
    return {
      userId: m.userId, name: m.user.name, username: m.user.username || p.username || null, avatarUrl: p.avatarUrl || null,
      role: normRole(m.role), roleLabel: ROLE_LABEL[normRole(m.role)], joinedAt: m.joinedAt, level: best.get(m.userId) || null,
    };
  }).sort((a, b) => order[a.role] - order[b.role] || String(a.name).localeCompare(String(b.name)));

  // Vínculos explícitos → próximos jogos + treinos
  const links = await prisma.clubTournamentLink.findMany({ where: { clubId: club.id }, orderBy: { createdAt: 'asc' } });
  const tids = [...new Set(links.map((l) => l.tournamentId))];
  const tournaments = tids.length ? await prisma.tournament.findMany({ where: { id: { in: tids } }, select: { id: true, name: true, slug: true, sport: true, status: true } }) : [];
  const tmap = new Map(tournaments.map((t) => [t.id, t]));
  const pairs = new Set(links.map((l) => l.tournamentId + '|' + l.entryName));
  let upcoming = [];
  let trainings = [];
  if (links.length) {
    const since = new Date(Date.now() - 3 * 3600000);
    const ms = await prisma.tournamentMatch.findMany({
      where: {
        tournamentId: { in: tids },
        status: { in: ['SCHEDULED', 'LIVE'] },
        OR: [{ scheduledAt: null }, { scheduledAt: { gte: since } }],
      },
      select: {
        id: true, tournamentId: true, stage: true, round: true, scheduledAt: true, location: true, status: true,
        homeScore: true, awayScore: true,
        category: { select: { name: true } },
        homeEntry: { select: { name: true, logoUrl: true } },
        awayEntry: { select: { name: true, logoUrl: true } },
      },
    });
    upcoming = ms
      .filter((m) => (m.homeEntry && pairs.has(m.tournamentId + '|' + m.homeEntry.name)) || (m.awayEntry && pairs.has(m.tournamentId + '|' + m.awayEntry.name)))
      .sort((a, b) => (a.scheduledAt ? a.scheduledAt.getTime() : Infinity) - (b.scheduledAt ? b.scheduledAt.getTime() : Infinity))
      .slice(0, 20)
      .map((m) => ({
        id: m.id, tournament: tmap.get(m.tournamentId) ? tmap.get(m.tournamentId).name : null, slug: tmap.get(m.tournamentId) ? tmap.get(m.tournamentId).slug : null,
        category: m.category ? m.category.name : null, stage: m.stage, round: m.round, scheduledAt: m.scheduledAt, location: m.location, status: m.status,
        home: m.homeEntry ? m.homeEntry.name : null, away: m.awayEntry ? m.awayEntry.name : null,
        homeLogo: m.homeEntry ? m.homeEntry.logoUrl : null, awayLogo: m.awayEntry ? m.awayEntry.logoUrl : null,
        homeScore: m.homeScore, awayScore: m.awayScore,
      }));
    const ts = await prisma.trainingSession.findMany({
      where: { tournamentId: { in: tids }, status: 'SCHEDULED', OR: [{ scheduledAt: null }, { scheduledAt: { gte: since } }] },
      select: { id: true, tournamentId: true, clubName: true, title: true, focus: true, scheduledAt: true, location: true },
      orderBy: { scheduledAt: 'asc' },
      take: 50,
    });
    trainings = ts.filter((t) => pairs.has(t.tournamentId + '|' + t.clubName)).slice(0, 12)
      .map((t) => ({ ...t, tournament: tmap.get(t.tournamentId) ? tmap.get(t.tournamentId).name : null }));
  }

  return {
    club: {
      id: club.id, slug: club.slug, name: club.name, description: club.description, crestUrl: club.crestUrl,
      primaryColor: club.primaryColor || '#EA5128', secondaryColor: club.secondaryColor || '#FFFFFF',
      sports: club.sports || [], city: club.city, state: club.state, privacyLevel: club.privacyLevel,
      membersCount: members.length, createdAt: club.createdAt,
    },
    members: canSeeMembers ? members : [],
    membersHidden: !canSeeMembers,
    medals: canSeeMembers ? medals : [],
    upcoming,
    trainings: isMember || viewerRole === 'admin' ? trainings : [],
    links: links.map((l) => ({ id: l.id, tournamentId: l.tournamentId, tournament: tmap.get(l.tournamentId) ? tmap.get(l.tournamentId).name : null, slug: tmap.get(l.tournamentId) ? tmap.get(l.tournamentId).slug : null, entryName: l.entryName })),
    viewer: viewer.userId ? { userId: viewer.userId, role: viewerRole, status: myMembership ? myMembership.status : null, pendingRole: myMembership && myMembership.status === 'PENDING' ? normRole(myMembership.role) : null } : null,
  };
}

module.exports = {
  setPrisma, ClubError, ROLES, ROLE_LABEL, CLUB_SPORTS,
  slugify, newCode, normRole,
  createClub, updateClub, inviteInfo, joinByCode, inviteUser, respondInvite, setRole, removeMember,
  addLink, removeLink, entryOptions, myClubs, publicView, loadClub, roleOf,
};
