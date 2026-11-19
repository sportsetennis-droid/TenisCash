// =====================================================================
// Liga Aberta F2 — JUNTAR PERFIS DUPLICADOS do mesmo atleta
// ---------------------------------------------------------------------
// NUNCA automático e NUNCA por nome. Só o próprio atleta, logado, pede:
//   1. start: informa o OUTRO perfil (telefone, @ ou link de convite de elenco
//      que o outro perfil usou) e escolhe como provar que é dele:
//        CODE     → código de 6 dígitos no WhatsApp do OUTRO perfil (mesmo canal,
//                   mesmo HMAC e mesmos limites do cadastro da F0 — AthleteSignupCode)
//        PASSWORD → senha do outro perfil ("login nos dois")
//   2. confirm: código ou senha → tudo numa TRANSAÇÃO:
//        RosterPlayer.userId, EntryMember, TournamentRole, Tournament.ownerId,
//        MatchOfficial, TeamMembership, ClubMembership/Club.ownerId, PlayChallenge,
//        AthleteRating (soma ponderada por esporte) e GlickoRating (apaga a do
//        perfil antigo e RECALCULA o esporte do histórico depois da transação).
//      Medalhas (Medal) NÃO mudam de titular: a credencial é assinada e o modelo
//      não tem transferência → ficam listadas no relatório.
//      O perfil antigo é DESATIVADO (active=false), nunca apagado.
//   Bloqueios: perfil antigo com saldo TenisCash/comissão (dinheiro não se mexe
//   aqui), conta de equipe/admin, conta inativa, o mesmo perfil.
// Auditoria: ProfileMergeRequest.report + TournamentAudit (profile.merge) em cada
// torneio afetado.
// =====================================================================

const bcrypt = require('bcryptjs');
const { prisma } = require('../middleware');
const signupCode = require('./athleteSignupCode');

const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODES_PER_PHONE_HOUR = 5;
// Teto PRÓPRIO de códigos de junção por dia (não deixa a junção gastar o teto do cadastro)
function mergeDailyMax() {
  const n = Number(process.env.PROFILE_MERGE_DAILY_MAX);
  return process.env.PROFILE_MERGE_DAILY_MAX != null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
}
// Antes da prova, a resposta é a MESMA para "não existe", "é conta de equipe", "tem saldo"
// e "está inativo" (não vira consulta de telefone → dados da pessoa).
const GENERIC = 'não foi possível iniciar a junção com esse perfil — confira o dado informado ou fale com a loja';

class MergeError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new MergeError(status, msg); };

function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 4 ? '•••• ' + d.slice(-4) : '••••';
}

// Acha o OUTRO perfil por telefone, @ ou token de convite de elenco.
async function resolveOther({ phone, username, inviteToken }) {
  const sel = { id: true, name: true, phone: true, active: true, role: true, balance: true, partnerBalance: true, pin: true, username: true };
  if (inviteToken) {
    const ri = require('./rosterInvite');
    const inv = await prisma.rosterInvite.findUnique({ where: { tokenHash: ri.hashToken(String(inviteToken).trim()) } });
    if (!inv || !inv.usedByUserId) return null;
    return prisma.user.findUnique({ where: { id: inv.usedByUserId }, select: sel });
  }
  if (username) {
    const h = String(username).replace(/^@/, '').replace(/^.*\/atleta\//, '').trim();
    if (!h) return null;
    const u = await prisma.user.findFirst({ where: { username: { equals: h, mode: 'insensitive' } }, select: sel });
    if (u) return u;
    const ap = await prisma.athleteProfile.findFirst({ where: { username: { equals: h, mode: 'insensitive' } }, select: { userId: true } });
    return ap ? prisma.user.findUnique({ where: { id: ap.userId }, select: sel }) : null;
  }
  if (phone) {
    const variants = signupCode.phoneVariants(phone);
    if (!variants.length) return null;
    return prisma.user.findFirst({ where: { phone: { in: variants } }, select: sel });
  }
  return null;
}

function precheck(me, other, { generic = false } = {}) {
  if (!me || !me.active) fail(403, 'sua conta está inativa');
  if (other && other.id === me.id) fail(400, 'esse é o seu próprio perfil');
  if (generic) {
    const blocked = !other || !other.active || (other.role || 'user') !== 'user' || Number(other.balance || 0) !== 0 || Number(other.partnerBalance || 0) !== 0;
    if (blocked) fail(400, GENERIC);
    return;
  }
  if (!other) fail(404, 'não achei esse perfil');
  if (!other.active) fail(409, 'esse perfil já está desativado');
  if ((other.role || 'user') !== 'user') fail(409, 'esse perfil é de equipe/administração — a junção é só entre perfis de atleta');
  if (Number(other.balance || 0) !== 0 || Number(other.partnerBalance || 0) !== 0) {
    fail(409, 'o outro perfil tem saldo TenisCash — resolva o saldo com a loja antes de juntar (aqui não se mexe em dinheiro)');
  }
}

async function start({ userId, phone, username, inviteToken, method }) {
  const me = await prisma.user.findUnique({ where: { id: String(userId) }, select: { id: true, active: true } });
  const other = await resolveOther({ phone, username, inviteToken });
  precheck(me, other, { generic: true });
  const m = String(method || 'CODE').toUpperCase() === 'PASSWORD' ? 'PASSWORD' : 'CODE';
  let sentTo = null;
  if (m === 'CODE') {
    const p = signupCode.normalizePhone(other.phone);
    if (!p) fail(409, 'o outro perfil não tem um WhatsApp válido — use a senha dele');
    // mesmo limite por telefone do cadastro (5 códigos/hora)
    const recent = await prisma.athleteSignupCode.count({ where: { phone: p, createdAt: { gte: new Date(Date.now() - 3600 * 1000) } } });
    if (recent >= CODES_PER_PHONE_HOUR) fail(429, 'muitos códigos pedidos para este WhatsApp. Tente de novo em 1 hora.');
    const today = await prisma.profileMergeRequest.count({ where: { method: 'CODE', createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
    if (today >= mergeDailyMax()) fail(429, 'limite diário de junções por código atingido. Use a senha do outro perfil ou tente amanhã.');
    const r = await signupCode.startSignup(p);
    if (!r.ok) fail(r.status || 503, r.error);
    sentTo = maskPhone(p);
  }
  await prisma.profileMergeRequest.updateMany({ where: { userId: me.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
  const reqRow = await prisma.profileMergeRequest.create({
    data: { userId: me.id, otherUserId: other.id, method: m, expiresAt: new Date(Date.now() + REQUEST_TTL_MS) },
  });
  // sem nome/@ do outro perfil antes da prova (LGPD)
  return { ok: true, requestId: reqRow.id, method: m, sentTo, expiresInSeconds: REQUEST_TTL_MS / 1000 };
}

// ---------------------------------------------------------------------
// A fusão em si (dentro da transação). Devolve o relatório.
// ---------------------------------------------------------------------
async function mergeInTx(tx, keepId, oldId) {
  const rep = { from: oldId, to: keepId, moved: {}, removedDuplicates: {}, medalsNotMoved: [], sports: [], tournaments: [] };
  const tids = new Set();

  // Elenco (o que dá o histórico de gols/cartões)
  const rp = await tx.rosterPlayer.findMany({ where: { userId: oldId }, select: { id: true, entryId: true } });
  if (rp.length) {
    const es = await tx.tournamentEntry.findMany({ where: { id: { in: rp.map((r) => r.entryId) } }, select: { tournamentId: true } });
    es.forEach((e) => tids.add(e.tournamentId));
  }
  rep.moved.rosterPlayers = (await tx.rosterPlayer.updateMany({ where: { userId: oldId }, data: { userId: keepId } })).count;

  // Inscrições de atleta (EntryMember @@unique[entryId,userId])
  const ems = await tx.entryMember.findMany({ where: { userId: oldId }, select: { id: true, entryId: true, entry: { select: { tournamentId: true } } } });
  let emMoved = 0; let emDup = 0;
  for (const em of ems) {
    tids.add(em.entry.tournamentId);
    const has = await tx.entryMember.findFirst({ where: { entryId: em.entryId, userId: keepId }, select: { id: true } });
    if (has) { await tx.entryMember.delete({ where: { id: em.id } }); emDup++; } else { await tx.entryMember.update({ where: { id: em.id }, data: { userId: keepId } }); emMoved++; }
  }
  rep.moved.entryMembers = emMoved; rep.removedDuplicates.entryMembers = emDup;

  // Papéis de torneio (sem unique no banco: deduplica por torneio+papel+time)
  const trs = await tx.tournamentRole.findMany({ where: { userId: oldId } });
  let trMoved = 0; let trDup = 0;
  for (const r of trs) {
    tids.add(r.tournamentId);
    const has = await tx.tournamentRole.findFirst({ where: { tournamentId: r.tournamentId, userId: keepId, role: r.role, entryId: r.entryId }, select: { id: true } });
    if (has) { await tx.tournamentRole.delete({ where: { id: r.id } }); trDup++; } else { await tx.tournamentRole.update({ where: { id: r.id }, data: { userId: keepId } }); trMoved++; }
  }
  rep.moved.tournamentRoles = trMoved; rep.removedDuplicates.tournamentRoles = trDup;
  const owned = await tx.tournament.findMany({ where: { ownerId: oldId }, select: { id: true } });
  owned.forEach((t) => tids.add(t.id));
  rep.moved.tournamentsOwned = (await tx.tournament.updateMany({ where: { ownerId: oldId }, data: { ownerId: keepId } })).count;

  // Escala de arbitragem
  const mos = await tx.matchOfficial.findMany({ where: { userId: oldId } });
  let moMoved = 0; let moDup = 0;
  for (const o of mos) {
    const has = await tx.matchOfficial.findFirst({ where: { matchId: o.matchId, userId: keepId, role: o.role }, select: { id: true } });
    if (has) { await tx.matchOfficial.delete({ where: { id: o.id } }); moDup++; } else { await tx.matchOfficial.update({ where: { id: o.id }, data: { userId: keepId } }); moMoved++; }
  }
  rep.moved.matchOfficials = moMoved; rep.removedDuplicates.matchOfficials = moDup;

  // Vínculo com time (TeamMembership @@unique[tournamentId,clubName,userId])
  const tms = await tx.teamMembership.findMany({ where: { userId: oldId } });
  let tmMoved = 0; let tmDup = 0;
  for (const m of tms) {
    tids.add(m.tournamentId);
    const has = await tx.teamMembership.findFirst({ where: { tournamentId: m.tournamentId, clubName: m.clubName, userId: keepId } });
    if (has) {
      if (has.status !== 'ACTIVE' && m.status === 'ACTIVE') await tx.teamMembership.update({ where: { id: has.id }, data: { status: 'ACTIVE', respondedAt: m.respondedAt || new Date() } });
      await tx.teamMembership.delete({ where: { id: m.id } }); tmDup++;
    } else { await tx.teamMembership.update({ where: { id: m.id }, data: { userId: keepId } }); tmMoved++; }
  }
  rep.moved.teamMemberships = tmMoved; rep.removedDuplicates.teamMemberships = tmDup;

  // Clube permanente (ClubMembership @@unique[clubId,userId]) + dono do clube
  const cms = await tx.clubMembership.findMany({ where: { userId: oldId } });
  let cmMoved = 0; let cmDup = 0;
  for (const m of cms) {
    const has = await tx.clubMembership.findUnique({ where: { clubId_userId: { clubId: m.clubId, userId: keepId } } });
    if (has) {
      const rank = { owner: 0, coach: 1, admin: 1, athlete: 2, member: 2 };
      const better = (rank[m.role] ?? 3) < (rank[has.role] ?? 3) ? m.role : has.role;
      await tx.clubMembership.update({ where: { id: has.id }, data: { role: better, status: has.status === 'ACTIVE' || m.status === 'ACTIVE' ? 'ACTIVE' : has.status } });
      await tx.clubMembership.delete({ where: { id: m.id } }); cmDup++;
    } else { await tx.clubMembership.update({ where: { id: m.id }, data: { userId: keepId } }); cmMoved++; }
  }
  rep.moved.clubMemberships = cmMoved; rep.removedDuplicates.clubMemberships = cmDup;
  rep.moved.clubsOwned = (await tx.club.updateMany({ where: { ownerId: oldId }, data: { ownerId: keepId } })).count;

  // Desafios 1x1 (entram no rating e no card) — não cria desafio contra si mesmo
  const chs = await tx.playChallenge.findMany({ where: { OR: [{ challengerId: oldId }, { challengedId: oldId }] }, select: { id: true, challengerId: true, challengedId: true, winnerId: true, sport: true } });
  let chMoved = 0; const chSelf = [];
  for (const c of chs) {
    const ch = c.challengerId === oldId ? keepId : c.challengerId;
    const cd = c.challengedId === oldId ? keepId : c.challengedId;
    if (ch === cd) { chSelf.push(c.id); continue; }
    await tx.playChallenge.update({ where: { id: c.id }, data: { challengerId: ch, challengedId: cd, winnerId: c.winnerId === oldId ? keepId : c.winnerId } });
    chMoved++;
    if (c.sport) rep.sports.push(c.sport);
  }
  rep.moved.challenges = chMoved;
  if (chSelf.length) rep.challengesKeptOnOldProfile = chSelf;

  // Rating legado 0–7 (incremental, sem histórico pra recalcular): soma ponderada por jogos
  const oldR = await tx.athleteRating.findMany({ where: { userId: oldId } });
  let arMoved = 0; let arMerged = 0;
  for (const r of oldR) {
    rep.sports.push(r.sport);
    const k = await tx.athleteRating.findUnique({ where: { userId_sport: { userId: keepId, sport: r.sport } } });
    if (!k) { await tx.athleteRating.update({ where: { id: r.id }, data: { userId: keepId } }); arMoved++; continue; }
    const n = (k.matchesCount || 0) + (r.matchesCount || 0);
    const rating = n ? ((k.rating * (k.matchesCount || 0)) + (r.rating * (r.matchesCount || 0))) / n : k.rating;
    const last = [k.lastMatchAt, r.lastMatchAt].filter(Boolean).sort((a, b) => b - a)[0] || null;
    await tx.athleteRating.update({ where: { id: k.id }, data: { rating, matchesCount: n, wins: k.wins + r.wins, losses: k.losses + r.losses, lastMatchAt: last } });
    await tx.athleteRating.delete({ where: { id: r.id } });
    arMerged++;
  }
  rep.moved.athleteRatings = arMoved; rep.removedDuplicates.athleteRatingsMerged = arMerged;

  // Glicko-2: some a do perfil antigo; o esporte é recalculado do histórico depois
  const gl = await tx.glickoRating.findMany({ where: { subjectType: 'USER', subjectKey: oldId }, select: { sport: true } });
  gl.forEach((g) => rep.sports.push(g.sport));
  rep.removedDuplicates.glickoRatings = (await tx.glickoRating.deleteMany({ where: { subjectType: 'USER', subjectKey: oldId } })).count;

  // Medalhas: credencial assinada, modelo sem transferência → só relatório
  const medals = await tx.medal.findMany({ where: { userId: oldId }, select: { serial: true, eventName: true, categoryName: true, status: true } });
  rep.medalsNotMoved = medals.map((m) => ({ ...m, reason: 'credencial assinada e sem transferência de titular — reemitir no perfil novo, se for o caso' }));

  // Esportes dos torneios afetados (pro recálculo do Glicko)
  if (tids.size) {
    const ts = await tx.tournament.findMany({ where: { id: { in: [...tids] } }, select: { id: true, sport: true } });
    ts.forEach((t) => { if (t.sport) rep.sports.push(t.sport); });
  }
  rep.sports = [...new Set(rep.sports.filter(Boolean))];
  rep.tournaments = [...tids];

  // Perfil antigo: desativado (nunca apagado)
  await tx.user.update({ where: { id: oldId }, data: { active: false } });
  rep.oldProfileDeactivated = true;
  return rep;
}

async function confirm({ userId, requestId, code, password }) {
  const req = await prisma.profileMergeRequest.findUnique({ where: { id: String(requestId || '') } });
  if (!req || req.userId !== userId || req.status !== 'PENDING') fail(404, 'pedido de junção não encontrado — comece de novo');
  if (req.expiresAt < new Date()) {
    await prisma.profileMergeRequest.update({ where: { id: req.id }, data: { status: 'CANCELED' } });
    fail(410, 'o pedido expirou — comece de novo');
  }
  const me = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, active: true } });
  const other = await prisma.user.findUnique({ where: { id: req.otherUserId }, select: { id: true, name: true, phone: true, active: true, role: true, balance: true, partnerBalance: true, pin: true, username: true } });
  precheck(me, other, { generic: true }); // antes da prova: resposta genérica

  let codeRowId = null;
  if (req.method === 'CODE') {
    const p = signupCode.normalizePhone(other.phone);
    const v = await signupCode.checkSignupCode(p, code);
    if (!v.ok) fail(v.status || 400, v.error);
    codeRowId = v.rowId;
  } else {
    const okPass = password && other.pin ? await bcrypt.compare(String(password), other.pin).catch(() => false) : false;
    if (!okPass) fail(400, 'senha do outro perfil incorreta');
  }

  const report = await prisma.$transaction(async (tx) => {
    // pedido consumido 1x (corrida = só um passa)
    const took = await tx.profileMergeRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'DONE', doneAt: new Date() } });
    if (took.count !== 1) fail(409, 'este pedido já foi usado');
    // confere de novo DENTRO da transação (duas junções simultâneas contra o mesmo perfil)
    const fresh = await tx.user.findUnique({ where: { id: other.id }, select: { id: true, active: true, role: true, balance: true, partnerBalance: true } });
    precheck(me, fresh);
    if (codeRowId && !(await signupCode.markSignupCodeUsed(tx, codeRowId))) fail(400, 'código já usado — peça um novo');
    const rep = await mergeInTx(tx, me.id, other.id);
    rep.method = req.method;
    await tx.profileMergeRequest.update({ where: { id: req.id }, data: { report: JSON.parse(JSON.stringify(rep)) } });
    return rep;
  }, { timeout: 60000 });

  // Glicko-2: recalcula os esportes afetados (fora da transação, como no resultado do jogo)
  const clubRating = require('./clubRating');
  for (const sp of report.sports) { await clubRating.onResult(sp); }
  const audit = require('./tournamentAudit');
  for (const tid of report.tournaments) {
    await audit.record({ tournamentId: tid, userId: me.id, action: 'profile.merge', entity: 'User', entityId: other.id, before: { userId: other.id }, after: { userId: me.id, requestId: req.id } });
  }
  return { ok: true, requestId: req.id, report };
}

module.exports = { MergeError, start, confirm, resolveOther, mergeInTx, maskPhone };
