// =====================================================================
// MEDALHAS DIGITAIS — regras de negócio (Club Sports & Tennis)
// ---------------------------------------------------------------------
// Regras (inquebráveis):
//  1. Só existe medalha com resultado CONFIRMADO pelo organizador: a
//     emissão parte do resultado oficial do torneio (final encerrada /
//     liga encerrada) ou de lista oficial do emissor. Nada autodeclarado:
//     não existe endpoint pro atleta criar medalha.
//  2. Intransferível: não existe endpoint de transferência nem venda; a
//     credencial carrega o hash do CPF do dono (sal secreto).
//  3. Raridade SÓ por mérito (tier + títulos raros), nunca por compra.
//  4. Revogação só pelo emissor, com motivo, e o histórico é público.
// =====================================================================
const crypto = require('crypto');
const QRCode = require('qrcode');
const { prisma } = require('../middleware');
const mc = require('./medalCrypto');
const Tpl = require('../../public/medalhas/medal-template.js');

const BASE = () => (process.env.MEDAL_BASE_URL || 'https://clubsportsetennis.com.br').replace(/\/+$/, '');
const TIERS = ['GOLD', 'SILVER', 'BRONZE', 'FINISHER', 'SPECIAL'];
const ACHIEVEMENTS = ['PLACEMENT', 'TOP_SCORER', 'MVP', 'RECORD'];
const DISTINCTIONS = ['UNBEATEN', 'STATE_CHAMPION', 'NATIONAL_CHAMPION', 'RECORD'];
const ISSUER_KINDS = ['ORGANIZER', 'SCHOOL', 'FEDERATION', 'CLUB'];
const REVOKE_REASONS = { APPEAL: 'Recurso', DOPING: 'Doping', RESULT_ERROR: 'Erro no resultado', OTHER: 'Outro motivo' };
const isGlobalAdmin = (role) => ['admin', 'superadmin', 'manager'].includes(role);

class MedalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function slugify(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'emissor';
}
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const validCpf = (s) => onlyDigits(s).length === 11;

// ---------------- emissores ----------------
async function createIssuer({ ownerUserId, name, kind, signatoryName, url, logoUrl }) {
  if (!name || String(name).trim().length < 3) throw new MedalError(400, 'Informe o nome do emissor (organização, escola ou federação).');
  kind = ISSUER_KINDS.includes(kind) ? kind : 'ORGANIZER';
  let slug = slugify(name);
  if (await prisma.medalIssuer.findUnique({ where: { slug } })) slug = slug + '-' + crypto.randomBytes(2).toString('hex');
  const keys = mc.generateIssuerKeys();
  return prisma.medalIssuer.create({
    data: {
      slug, name: String(name).trim().slice(0, 120), kind, ownerUserId,
      signatoryName: signatoryName ? String(signatoryName).trim().slice(0, 80) : null,
      url: url && /^https:\/\//.test(url) ? url : null,
      logoUrl: logoUrl && /^(https:\/\/|data:image\/)/.test(logoUrl) ? logoUrl : null,
      did: keys.did, publicJwk: keys.publicJwk, privateKeySealed: keys.privateKeySealed,
    },
  });
}
const publicIssuer = (i) => i && ({ id: i.id, slug: i.slug, name: i.name, kind: i.kind, signatoryName: i.signatoryName, url: i.url, logoUrl: i.logoUrl, did: i.did });

async function assertIssuerOwner(issuerId, user) {
  const iss = await prisma.medalIssuer.findUnique({ where: { id: issuerId } });
  if (!iss) throw new MedalError(404, 'Emissor não encontrado.');
  if (iss.ownerUserId !== user.id && !isGlobalAdmin(user.role)) throw new MedalError(403, 'Só o responsável pelo emissor pode fazer isso.');
  return iss;
}

// ---------------- templates (identidade por evento) ----------------
async function saveTemplate(user, { id, issuerId, tournamentId, name, sport, circuit, design: input }) {
  await assertIssuerOwner(issuerId, user);
  if (!name) throw new MedalError(400, 'Informe o nome do evento.');
  sport = Tpl.SPORTS[sport] ? sport : 'GENERIC';
  const design = Tpl.generate(Object.assign({}, input || {}, { name, sport }));
  if (input && input.crestImage && String(input.crestImage).length > 400000) throw new MedalError(400, 'Escudo muito grande (máx. ~300 KB).');
  const data = { issuerId, tournamentId: tournamentId || null, name: String(name).slice(0, 120), sport, circuit: circuit ? String(circuit).slice(0, 80) : null, design };
  if (id) {
    const cur = await prisma.medalTemplate.findUnique({ where: { id } });
    if (!cur || cur.issuerId !== issuerId) throw new MedalError(404, 'Template não encontrado.');
    // template já usado em medalha emitida: muda só a versão (as medalhas antigas guardam o design delas na credencial)
    return prisma.medalTemplate.update({ where: { id }, data: Object.assign(data, { version: cur.version + 1 }) });
  }
  return prisma.medalTemplate.create({ data });
}

// ---------------- resultado oficial → pódio ----------------
const DONE = ['FINISHED', 'WALKOVER'];
async function categoryResult(cat) {
  const matches = await prisma.tournamentMatch.findMany({ where: { categoryId: cat.id } });
  const entries = await prisma.tournamentEntry.findMany({ where: { categoryId: cat.id, status: 'CONFIRMED' }, include: { members: true } });
  const standings = await prisma.tournamentStanding.findMany({ where: { categoryId: cat.id } });
  const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
  const out = { confirmed: false, reason: null, places: [] }; // places: [{entryId, placement, tier, edition:{n,total}}]
  // Dupla eliminação: se houve "reset" da grande final, ele é que decide o campeão.
  const reset = matches.find((m) => m.stage === 'FINAL_RESET' && DONE.includes(m.status) && m.winnerEntryId);
  const final = reset || matches.find((m) => m.stage === 'FINAL');
  const knockout = matches.filter((m) => !['LEAGUE', 'GROUP'].includes(m.stage));
  const N = entries.length;
  if (!N) { out.reason = 'Categoria sem inscritos confirmados.'; return out; }
  const resetPending = matches.find((m) => m.stage === 'FINAL_RESET' && !DONE.includes(m.status) && m.status !== 'CANCELED' && m.homeEntryId);
  if (resetPending) { out.reason = 'O reset da grande final (dupla eliminação) ainda não foi jogado.'; return out; }

  let podium = [];
  if (final) {
    if (!DONE.includes(final.status) || !final.winnerEntryId) { out.reason = 'A final ainda não foi encerrada pelo organizador.'; return out; }
    const runner = final.homeEntryId === final.winnerEntryId ? final.awayEntryId : final.homeEntryId;
    podium.push({ entryId: final.winnerEntryId, placement: 1, tier: 'GOLD', total: 1 });
    if (runner) podium.push({ entryId: runner, placement: 2, tier: 'SILVER', total: 1 });
    const third = matches.find((m) => m.stage === 'THIRD');
    if (third) {
      if (!DONE.includes(third.status) || !third.winnerEntryId) { out.reason = 'A disputa de 3º lugar ainda não foi encerrada.'; return out; }
      podium.push({ entryId: third.winnerEntryId, placement: 3, tier: 'BRONZE', total: 1 });
    } else {
      const semis = matches.filter((m) => m.stage === 'SEMI' && DONE.includes(m.status) && m.winnerEntryId);
      const losers = semis.map((m) => (m.homeEntryId === m.winnerEntryId ? m.awayEntryId : m.homeEntryId)).filter(Boolean);
      losers.forEach((id) => podium.push({ entryId: id, placement: 3, tier: 'BRONZE', total: losers.length }));
    }
  } else if (!knockout.length) {
    const pending = matches.filter((m) => !DONE.includes(m.status) && m.status !== 'CANCELED');
    if (!matches.length || pending.length) { out.reason = 'Ainda há jogos sem resultado oficial nesta categoria.'; return out; }
    const ranked = standings.slice().sort((a, b) => (a.rank || 99) - (b.rank || 99) || b.points - a.points || (b.scoreFor - b.scoreAgainst) - (a.scoreFor - a.scoreAgainst));
    ['GOLD', 'SILVER', 'BRONZE'].forEach((tier, i) => { if (ranked[i]) podium.push({ entryId: ranked[i].entryId, placement: i + 1, tier, total: 1 }); });
  } else {
    out.reason = 'Mata-mata sem final cadastrada.'; return out;
  }

  // demais = concluintes, numerados pela posição final (classificação) — "47 de 312"
  const inPodium = new Set(podium.map((p) => p.entryId));
  const st = Object.fromEntries(standings.map((s) => [s.entryId, s]));
  const rest = entries.filter((e) => !inPodium.has(e.id)).sort((a, b) => {
    const sa = st[a.id] || {}, sb = st[b.id] || {};
    return (sa.rank || 999) - (sb.rank || 999) || (sb.points || 0) - (sa.points || 0) || a.name.localeCompare(b.name);
  });
  const podiumSlots = podium.length;
  podium.forEach((p) => out.places.push({ entryId: p.entryId, placement: p.placement, tier: p.tier, edition: { n: p.tier === 'BRONZE' && p.total > 1 ? podium.filter((x) => x.tier === 'BRONZE').indexOf(p) + 1 : 1, total: p.total } }));
  rest.forEach((e, i) => out.places.push({ entryId: e.id, placement: podiumSlots + i + 1, tier: 'FINISHER', edition: { n: podiumSlots + i + 1, total: N } }));

  // campeão invicto: nenhuma derrota em jogo oficial
  const champ = podium[0] && podium[0].entryId;
  if (champ) {
    const played = matches.filter((m) => DONE.includes(m.status) && (m.homeEntryId === champ || m.awayEntryId === champ));
    const lost = played.some((m) => m.winnerEntryId && m.winnerEntryId !== champ);
    const drew = played.some((m) => !m.winnerEntryId && m.homeScore != null && m.homeScore === m.awayScore && ['LEAGUE', 'GROUP'].includes(m.stage));
    out.unbeaten = played.length >= 2 && !lost && !drew;
  }
  // súmula do jogo decisivo de cada medalhista (placar do ponto de vista dele + adversário)
  const decisive = (entryId, tier) => {
    const pick = tier === 'BRONZE'
      ? matches.find((m) => m.stage === 'THIRD' && (m.homeEntryId === entryId || m.awayEntryId === entryId)) || matches.find((m) => m.stage === 'SEMI' && (m.homeEntryId === entryId || m.awayEntryId === entryId))
      : matches.find((m) => m.stage === 'FINAL' && (m.homeEntryId === entryId || m.awayEntryId === entryId));
    if (!pick) return null;
    const home = pick.homeEntryId === entryId;
    const oppId = home ? pick.awayEntryId : pick.homeEntryId;
    const mine = home ? pick.homeScore : pick.awayScore, theirs = home ? pick.awayScore : pick.homeScore;
    const stageName = { FINAL: 'Final', THIRD: 'Disputa de 3º lugar', SEMI: 'Semifinal' }[pick.stage];
    return {
      score: pick.status === 'WALKOVER' ? 'W.O.' : (mine != null && theirs != null ? mine + ' x ' + theirs : null),
      opponent: oppId && byId[oppId] ? byId[oppId].name : null,
      note: stageName + (pick.decidedByPenalties ? ' (decidido nos pênaltis)' : ''),
      location: pick.location || null,
    };
  };
  out.places.forEach((p) => { if (p.tier !== 'FINISHER') p.result = decisive(p.entryId, p.tier); });
  out.confirmed = true;
  out.byId = byId;
  out.matches = matches;
  return out;
}

// Atletas premiados de uma inscrição: membros com conta (dupla/individual) + elenco ligado à conta (time).
async function recipientsOf(entry) {
  const ids = new Set((entry.members || []).map((m) => m.userId));
  const roster = await prisma.rosterPlayer.findMany({ where: { entryId: entry.id, userId: { not: null } } }).catch(() => []);
  roster.filter((r) => (r.role || 'PLAYER') === 'PLAYER').forEach((r) => ids.add(r.userId));
  if (!ids.size) return [];
  return prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, cpf: true, birthDate: true } });
}
// Liga F7: conta que declara menor de 18 não recebe medalha (a credencial carrega nome + hash
// do CPF; com LIGA_MINORS desligado nenhum dado de menor é coletado — mesma regra da F6).
const isMinorAccount = (u) => !!(u && require('./ligaMinors').declaresMinor(u.birthDate));

async function topScorers(categoryId, matches, db = prisma) {
  const ids = matches.filter((m) => DONE.includes(m.status)).map((m) => m.id);
  if (!ids.length) return [];
  // Liga F4: artilharia em PONTOS — gol = 1; basquete: cestas de 1/2/3 (mesma conta do histórico)
  const { PLAYER_POINT_VALUES, PLAYER_POINT_TYPES } = require('./tournamentRules');
  const rows = await db.matchEvent.groupBy({ by: ['playerId', 'type'], where: { matchId: { in: ids }, type: { in: PLAYER_POINT_TYPES }, playerId: { not: null } }, _count: { _all: true } }).catch(() => []);
  const byPlayer = new Map();
  for (const r of rows) byPlayer.set(r.playerId, (byPlayer.get(r.playerId) || 0) + r._count._all * (PLAYER_POINT_VALUES[r.type] || 1));
  const goals = [...byPlayer.entries()].map(([playerId, pts]) => ({ playerId, pts }));
  if (!goals.length) return [];
  const max = Math.max(...goals.map((g) => g.pts));
  const top = goals.filter((g) => g.pts === max);
  const players = await db.rosterPlayer.findMany({ where: { id: { in: top.map((t) => t.playerId) } } });
  return players.map((p) => ({ playerId: p.id, userId: p.userId, name: p.name, entryId: p.entryId, goals: max }));
}

// ---------------- prévia e emissão a partir do torneio ----------------
async function tournamentContext(tournamentId, user) {
  const roles = require('./tournamentRoles');
  const t = await prisma.tournament.findUnique({ where: { id: tournamentId }, include: { categories: true } });
  if (!t) throw new MedalError(404, 'Torneio não encontrado.');
  if (!(await roles.can(user.id, user.role, tournamentId, 'MANAGE_TOURNAMENT'))) throw new MedalError(403, 'Só o organizador (fundador/coordenador) emite as medalhas deste torneio.');
  const issuer = await prisma.medalIssuer.findFirst({ where: { ownerUserId: t.ownerId }, orderBy: { createdAt: 'asc' } });
  const template = issuer ? await prisma.medalTemplate.findFirst({ where: { tournamentId, issuerId: issuer.id }, orderBy: { updatedAt: 'desc' } }) : null;
  return { t, issuer, template };
}

async function previewTournament(tournamentId, user) {
  const { t, issuer, template } = await tournamentContext(tournamentId, user);
  const cats = [];
  for (const cat of t.categories) {
    const r = await categoryResult(cat);
    const c = { categoryId: cat.id, name: cat.name, gender: cat.gender, confirmed: r.confirmed, reason: r.reason, unbeaten: !!r.unbeaten, medals: [], blocked: [] };
    if (r.confirmed) {
      for (const p of r.places) {
        const e = r.byId[p.entryId];
        const people = e ? await recipientsOf(e) : [];
        if (!people.length) c.blocked.push({ entry: e ? e.name : p.entryId, reason: 'Inscrição sem atleta com conta no Club' });
        for (const u of people) {
          const already = await prisma.medal.findFirst({ where: { tournamentId, categoryId: cat.id, userId: u.id, achievement: 'PLACEMENT' }, select: { serial: true } });
          if (isMinorAccount(u)) { c.blocked.push({ entry: e.name, athlete: u.name, reason: 'Atleta menor de 18 anos (medalha só com o fluxo do responsável)' }); continue; }
          if (!validCpf(u.cpf)) { c.blocked.push({ entry: e.name, athlete: u.name, reason: 'Atleta sem CPF no cadastro (a medalha é presa ao CPF)' }); continue; }
          c.medals.push({ userId: u.id, athlete: u.name, entryId: e.id, entry: e.name, tier: p.tier, placement: p.placement, edition: p.edition, achievement: 'PLACEMENT', distinctions: p.placement === 1 && r.unbeaten ? ['UNBEATEN'] : [], result: p.result || null, issued: already ? already.serial : null });
        }
      }
      const rulesMod = require('./tournamentRules');
      const unit = rulesMod.scoreUnit(rulesMod.resolveRules(cat, t.sport)); // basquete: pontos; futsal: gols
      for (const s of await topScorers(cat.id, r.matches)) {
        if (!s.userId) { c.blocked.push({ athlete: s.name, reason: 'Artilheiro sem conta ligada no elenco' }); continue; }
        const u = await prisma.user.findUnique({ where: { id: s.userId }, select: { id: true, name: true, cpf: true, birthDate: true } });
        if (isMinorAccount(u)) { c.blocked.push({ athlete: s.name, reason: 'Atleta menor de 18 anos (medalha só com o fluxo do responsável)' }); continue; }
        if (!u || !validCpf(u.cpf)) { c.blocked.push({ athlete: s.name, reason: 'Artilheiro sem CPF no cadastro' }); continue; }
        const already = await prisma.medal.findFirst({ where: { tournamentId, categoryId: cat.id, userId: u.id, achievement: 'TOP_SCORER' }, select: { serial: true } });
        c.medals.push({ userId: u.id, athlete: u.name, entryId: s.entryId, tier: 'SPECIAL', placement: null, edition: { n: 1, total: 1 }, achievement: 'TOP_SCORER', distinctions: [], goals: s.goals, goalsText: rulesMod.plural(s.goals, unit), issued: already ? already.serial : null });
      }
    }
    cats.push(c);
  }
  return { tournament: { id: t.id, name: t.name, sport: t.sport, status: t.status, city: t.city, state: t.state, startDate: t.startDate, endDate: t.endDate }, issuer: publicIssuer(issuer), template, categories: cats };
}

// opts: { categoryIds?, distinctions: { [userId]: ['STATE_CHAMPION'] }, mvp: { [categoryId]: userId }, location }
async function issueTournament(tournamentId, user, opts = {}) {
  const pv = await previewTournament(tournamentId, user);
  const { t, issuer } = await tournamentContext(tournamentId, user);
  if (!issuer) throw new MedalError(409, 'Cadastre o emissor (nome da organização que assina) antes de emitir.');
  let template = pv.template;
  if (!template) {
    // sem template salvo: gera a identidade padrão do evento (organizador já autorizado acima)
    const sport = Tpl.SPORTS[t.sport] ? t.sport : 'GENERIC';
    template = await prisma.medalTemplate.create({ data: { issuerId: issuer.id, tournamentId, name: t.name, sport, design: Tpl.generate({ name: t.name, sport }) } });
  }
  const extra = opts.distinctions || {};
  const issued = [], skipped = [];
  for (const c of pv.categories) {
    if (opts.categoryIds && !opts.categoryIds.includes(c.categoryId)) continue;
    if (!c.confirmed) { skipped.push({ category: c.name, reason: c.reason }); continue; }
    const list = c.medals.slice();
    const mvpUser = opts.mvp && opts.mvp[c.categoryId];
    if (mvpUser) {
      const u = await prisma.user.findUnique({ where: { id: mvpUser }, select: { id: true, name: true, cpf: true, birthDate: true } });
      const inCat = c.medals.some((m) => m.userId === mvpUser);
      if (u && validCpf(u.cpf) && inCat && !isMinorAccount(u)) list.push({ userId: u.id, athlete: u.name, tier: 'SPECIAL', placement: null, edition: { n: 1, total: 1 }, achievement: 'MVP', distinctions: [] });
    }
    for (const m of list) {
      if (m.issued) { skipped.push({ athlete: m.athlete, reason: 'já emitida (' + m.issued + ')' }); continue; }
      const dist = [...new Set([...(m.distinctions || []), ...((extra[m.userId] || []).filter((d) => DISTINCTIONS.includes(d) && (d !== 'STATE_CHAMPION' && d !== 'NATIONAL_CHAMPION' || m.placement === 1)))])];
      try {
        const medal = await issueOne({
          issuer, template, actor: user, userId: m.userId, tournamentId, categoryId: c.categoryId, entryId: m.entryId || null,
          sport: t.sport, eventName: t.name, categoryName: c.name, gender: c.gender, achievement: m.achievement, tier: m.tier,
          placement: m.placement, distinctions: dist, edition: m.edition,
          eventDate: t.endDate || t.startDate || new Date(), location: opts.location || [t.city, t.state].filter(Boolean).join('/') || null,
          result: m.goals ? { score: m.goalsText || (m.goals + ' gols'), note: 'Artilharia oficial da categoria' } : (m.result ? { score: m.result.score, opponent: m.result.opponent, note: m.result.note } : null),
        });
        issued.push({ serial: medal.serial, athlete: m.athlete, tier: medal.tier, achievement: medal.achievement });
      } catch (e) {
        if (e.code === 'P2002') skipped.push({ athlete: m.athlete, reason: 'já emitida' });
        else throw e;
      }
    }
  }
  return { issued, skipped };
}

// Emissão manual por lista OFICIAL do emissor (corrida, jogos escolares, federação).
// recipients: [{ username | cpf, tier, placement, achievement, edition:{n,total}, distinctions, result:{score,opponent,time,note} }]
async function issueManual(user, { issuerId, templateId, categoryName, gender, eventDate, location, recipients }) {
  const issuer = await assertIssuerOwner(issuerId, user);
  const template = await prisma.medalTemplate.findUnique({ where: { id: templateId } });
  if (!template || template.issuerId !== issuerId) throw new MedalError(404, 'Template do evento não encontrado.');
  if (!Array.isArray(recipients) || !recipients.length) throw new MedalError(400, 'Lista de premiados vazia.');
  if (recipients.length > 2000) throw new MedalError(400, 'Máximo de 2.000 por lote.');
  const engine = require('./tournamentEngine');
  const issued = [], skipped = [];
  for (const r of recipients) {
    let uid = null;
    if (r.cpf && validCpf(r.cpf)) { const u = await prisma.user.findUnique({ where: { cpf: onlyDigits(r.cpf) }, select: { id: true } }); uid = u && u.id; }
    if (!uid && r.username) uid = await engine.resolveUserId(r.username);
    if (!uid) { skipped.push({ who: r.username || 'cpf ***' + onlyDigits(r.cpf).slice(-3), reason: 'atleta não encontrado no Club' }); continue; }
    const u = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, name: true, cpf: true, birthDate: true } });
    if (isMinorAccount(u)) { skipped.push({ who: u.name, reason: 'menor de 18 anos (medalha só com o fluxo do responsável)' }); continue; }
    if (!validCpf(u.cpf)) { skipped.push({ who: u.name, reason: 'sem CPF no cadastro' }); continue; }
    const tier = TIERS.includes(r.tier) ? r.tier : 'FINISHER';
    const achievement = ACHIEVEMENTS.includes(r.achievement) ? r.achievement : 'PLACEMENT';
    const dup = await prisma.medal.findFirst({ where: { templateId, userId: uid, achievement, categoryName: categoryName || null }, select: { serial: true } });
    if (dup) { skipped.push({ who: u.name, reason: 'já emitida (' + dup.serial + ')' }); continue; }
    const ed = r.edition && r.edition.n && r.edition.total ? { n: +r.edition.n, total: +r.edition.total } : { n: 1, total: 1 };
    const medal = await issueOne({
      issuer, template, actor: user, userId: uid, sport: template.sport, eventName: template.name, categoryName: categoryName || null, gender,
      achievement, tier, placement: r.placement ? +r.placement : null,
      distinctions: (r.distinctions || []).filter((d) => DISTINCTIONS.includes(d)), edition: ed,
      eventDate: eventDate ? new Date(eventDate) : new Date(), location: location || null, result: r.result || null,
    });
    issued.push({ serial: medal.serial, athlete: u.name, tier });
  }
  return { issued, skipped };
}

// ---------------- credencial OB 3.0 ----------------
function buildCredential(m, issuer, template) {
  const base = BASE();
  const achId = base + '/medalhas/conquista/' + template.id + '/' + m.achievement.toLowerCase() + '-' + m.tier.toLowerCase();
  const card = require('../../public/medalhas/medal-card.js');
  const label = card.placementLabel({ achievement: m.achievement, tier: m.tier, placement: m.placement, gender: m.gender });
  return {
    '@context': ['https://www.w3.org/ns/credentials/v2', 'https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json', base + '/ns/medalha/v1'],
    id: m.credentialId,
    type: ['VerifiableCredential', 'OpenBadgeCredential'],
    name: label + ' — ' + m.eventName + (m.categoryName ? ' (' + m.categoryName + ')' : ''),
    issuer: Object.assign({ id: issuer.did, type: ['Profile'], name: issuer.name }, issuer.url ? { url: issuer.url } : {}),
    validFrom: m.issuedAt.toISOString(),
    credentialSubject: {
      type: ['AchievementSubject'],
      identifier: [
        { type: 'IdentityObject', identityType: 'nationalIdentityNumber', hashed: true, identityHash: m.identityHash },
        { type: 'IdentityObject', identityType: 'name', hashed: false, identityHash: m.recipientName },
      ],
      achievement: {
        id: achId,
        type: ['Achievement'],
        achievementType: 'Award',
        name: label + ' — ' + m.eventName,
        description: 'Medalha oficial do Club Sports & Tennis, emitida e assinada por ' + issuer.name + ' com base no resultado oficial.',
        criteria: { narrative: m.achievement === 'PLACEMENT' ? (m.tier === 'FINISHER' ? 'Concluiu a competição.' : 'Terminou em ' + m.placement + 'º lugar na classificação oficial.') : label + ' da categoria, conforme súmula oficial.' },
        tag: [Tpl.SPORTS[m.sport] || m.sport].concat(template.circuit ? [template.circuit] : []),
        resultDescription: [{ id: achId + '#colocacao', type: ['ResultDescription'], name: 'Colocação', resultType: 'RawScore' }],
      },
      result: m.placement ? [{ type: ['Result'], resultDescription: achId + '#colocacao', value: String(m.placement) }] : [],
    },
    credentialStatus: { id: base + '/api/medals/status/' + issuer.id, type: '1EdTechRevocationList' },
    // Extensão própria (contexto /ns/medalha/v1, termo opaco @json).
    medal: {
      serial: m.serial,
      tier: m.tier,
      achievement: m.achievement,
      distinctions: m.distinctions,
      rarity: card.isRare(m) ? 'RARE' : m.tier,
      edition: { number: m.editionNumber, total: m.editionTotal },
      series: m.series,
      sport: m.sport,
      event: { name: m.eventName, category: m.categoryName, date: m.eventDate ? m.eventDate.toISOString().slice(0, 10) : null, location: m.result && m.result.location || m.location || null, gender: m.gender || null },
      result: m.result || null,
      organizer: { name: issuer.name, signatory: issuer.signatoryName || null, kind: issuer.kind },
      template: { id: template.id, version: template.version, circuit: template.circuit || null, design: template.design },
    },
  };
}

async function nextSerial() {
  const rows = await prisma.$queryRawUnsafe('SELECT nextval(\'"MedalSerialSeq"\')::int AS n');
  return 'CST-' + new Date().getFullYear() + '-' + String(rows[0].n).padStart(6, '0');
}

async function issueOne(o) {
  const user = await prisma.user.findUnique({ where: { id: o.userId }, select: { id: true, name: true, cpf: true } });
  if (!user || !validCpf(user.cpf)) throw new MedalError(400, 'Atleta sem CPF — a medalha é presa ao CPF.');
  const salt = mc.newIdentitySalt();
  const serial = await nextSerial();
  const m = {
    serial, credentialId: 'urn:uuid:' + crypto.randomUUID(), issuedAt: new Date(),
    userId: user.id, recipientName: user.name, identitySalt: salt, identityHash: mc.identityHash(user.cpf, salt),
    issuerId: o.issuer.id, templateId: o.template.id, tournamentId: o.tournamentId || null, categoryId: o.categoryId || null, entryId: o.entryId || null,
    sport: o.sport, eventName: o.eventName, categoryName: o.categoryName || null, gender: o.gender || null,
    series: o.template.circuit ? 'circuit:' + slugify(o.template.circuit) + (o.categoryName ? ':' + slugify(o.categoryName) : '') : 'event:' + o.template.id + (o.categoryName ? ':' + slugify(o.categoryName) : ''),
    achievement: o.achievement || 'PLACEMENT', tier: o.tier, placement: o.placement || null, distinctions: o.distinctions || [],
    editionNumber: o.edition.n, editionTotal: o.edition.total,
    eventDate: o.eventDate ? new Date(o.eventDate) : null, location: o.location || null,
    result: Object.assign({}, o.result || {}, o.location ? { location: o.location } : {}, o.gender ? { gender: o.gender } : {}),
  };
  const credential = buildCredential(m, o.issuer, o.template);
  const jwt = mc.signCredentialJwt(credential, o.issuer);
  const check = mc.verifyCredentialJwt(jwt);
  if (!check.valid) throw new Error('falha ao assinar a medalha: ' + check.error);
  return prisma.$transaction(async (tx) => {
    const medal = await tx.medal.create({
      data: {
        serial: m.serial, credentialId: m.credentialId, userId: m.userId, issuerId: m.issuerId, templateId: m.templateId,
        tournamentId: m.tournamentId, categoryId: m.categoryId, entryId: m.entryId, sport: m.sport, series: m.series,
        eventName: m.eventName, categoryName: m.categoryName, achievement: m.achievement, tier: m.tier, placement: m.placement,
        distinctions: m.distinctions, editionNumber: m.editionNumber, editionTotal: m.editionTotal, recipientName: m.recipientName,
        identitySalt: m.identitySalt, identityHash: m.identityHash, result: m.result, eventDate: m.eventDate,
        credentialJwt: jwt, verificationCode: mc.verificationCode(jwt), issuedByUserId: o.actor.id, issuedAt: m.issuedAt,
      },
    });
    await tx.medalStatusEvent.create({ data: { medalId: medal.id, action: 'ISSUED', actorUserId: o.actor.id, note: 'Emitida com base no resultado oficial' } });
    return medal;
  });
}

// ---------------- revogação ----------------
async function setStatus(serial, user, { action, reason, note }) {
  const medal = await prisma.medal.findUnique({ where: { serial } });
  if (!medal) throw new MedalError(404, 'Medalha não encontrada.');
  await assertIssuerOwner(medal.issuerId, user);
  if (action === 'REVOKED') {
    if (medal.status === 'REVOKED') throw new MedalError(409, 'Medalha já está revogada.');
    if (!REVOKE_REASONS[reason]) throw new MedalError(400, 'Motivo obrigatório: ' + Object.keys(REVOKE_REASONS).join(', '));
    if (!note || String(note).trim().length < 5) throw new MedalError(400, 'Descreva a decisão (ex.: número do processo do recurso).');
  } else if (medal.status !== 'REVOKED') throw new MedalError(409, 'Medalha não está revogada.');
  return prisma.$transaction(async (tx) => {
    const upd = await tx.medal.update({ where: { id: medal.id }, data: action === 'REVOKED' ? { status: 'REVOKED', revokedAt: new Date() } : { status: 'ACTIVE', revokedAt: null } });
    await tx.medalStatusEvent.create({ data: { medalId: medal.id, action, reason: action === 'REVOKED' ? reason : null, note: String(note || '').slice(0, 300) || null, actorUserId: user.id } });
    return upd;
  });
}

async function history(medalId) {
  const ev = await prisma.medalStatusEvent.findMany({ where: { medalId }, orderBy: { createdAt: 'asc' } });
  return ev.map((e) => ({ action: e.action, reason: e.reason, reasonLabel: REVOKE_REASONS[e.reason] || null, note: e.note, at: e.createdAt }));
}

// Lista pública de revogação do emissor (1EdTechRevocationList).
async function statusList(issuerId, credentialId) {
  const issuer = await prisma.medalIssuer.findUnique({ where: { id: issuerId } });
  if (!issuer) throw new MedalError(404, 'Emissor não encontrado.');
  const revoked = await prisma.medal.findMany({ where: { issuerId, status: 'REVOKED' }, select: { id: true, credentialId: true, revokedAt: true } });
  const lastEv = revoked.length ? await prisma.medalStatusEvent.findMany({ where: { medalId: { in: revoked.map((r) => r.id) }, action: 'REVOKED' }, orderBy: { createdAt: 'desc' } }) : [];
  const reasonOf = {};
  lastEv.forEach((e) => { if (!reasonOf[e.medalId]) reasonOf[e.medalId] = e; });
  const out = {
    type: '1EdTechRevocationList', issuer: issuer.did, issuerName: issuer.name, updatedAt: new Date().toISOString(),
    revokedCredentials: revoked.map((r) => ({ id: r.credentialId, revokedAt: r.revokedAt, reason: reasonOf[r.id] ? REVOKE_REASONS[reasonOf[r.id].reason] : null, revocationReason: reasonOf[r.id] ? reasonOf[r.id].note : null })),
  };
  if (credentialId) {
    const m = await prisma.medal.findUnique({ where: { credentialId } });
    if (m && m.issuerId === issuerId) out.history = await history(m.id);
  }
  return out;
}

// ---------------- leitura pública ----------------
async function qrOf(text) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = q.modules.size;
  let bits = '';
  for (let i = 0; i < n * n; i++) bits += q.modules.data[i] ? '1' : '0';
  return { size: n, bits };
}

async function viewOf(medal, { template, issuer, username } = {}) {
  template = template || (await prisma.medalTemplate.findUnique({ where: { id: medal.templateId } }));
  issuer = issuer || (await prisma.medalIssuer.findUnique({ where: { id: medal.issuerId } }));
  // O design MOSTRADO é o que foi assinado na credencial (template pode mudar depois).
  let design = template && template.design;
  try { const p = mc.verifyCredentialJwt(medal.credentialJwt).payload; if (p && p.medal && p.medal.template && p.medal.template.design) design = p.medal.template.design; } catch (_) { /* usa o atual */ }
  const r = medal.result || {};
  const verifyUrl = BASE() + '/v/' + medal.serial;
  return {
    serial: medal.serial, credentialId: medal.credentialId, status: medal.status, revokedAt: medal.revokedAt,
    tier: medal.tier, achievement: medal.achievement, distinctions: medal.distinctions || [], placement: medal.placement,
    edition: { n: medal.editionNumber, total: medal.editionTotal }, gender: r.gender || null,
    athlete: { name: medal.recipientName, username: username || null },
    event: { name: medal.eventName, category: medal.categoryName, sport: medal.sport, circuit: template && template.circuit, date: medal.eventDate, location: r.location || null, tournamentId: medal.tournamentId },
    series: medal.series,
    result: { score: r.score || null, opponent: r.opponent || null, time: r.time || null, note: r.note || null },
    organizer: { name: issuer && issuer.name, signatory: issuer && issuer.signatoryName, kind: issuer && issuer.kind, did: issuer && issuer.did },
    verificationCode: medal.verificationCode, verifyUrl, qr: await qrOf(verifyUrl),
    design, issuedAt: medal.issuedAt, credentialJwt: medal.credentialJwt,
  };
}

async function bySerial(serial) {
  const medal = await prisma.medal.findUnique({ where: { serial: String(serial).toUpperCase() } });
  if (!medal) throw new MedalError(404, 'Medalha não encontrada.');
  const prof = await prisma.athleteProfile.findUnique({ where: { userId: medal.userId }, select: { username: true } }).catch(() => null);
  const v = await viewOf(medal, { username: prof && prof.username });
  v.history = await history(medal.id);
  return v;
}

// Estante pública: só medalhas válidas (as revogadas saem da estante, mas continuam verificáveis com o histórico).
async function shelf(handle) {
  const engine = require('./tournamentEngine');
  const userId = await engine.resolveUserId(handle);
  if (!userId) throw new MedalError(404, 'Atleta não encontrado.');
  const [user, prof, medals] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, city: true, state: true } }),
    prisma.athleteProfile.findUnique({ where: { userId }, select: { username: true, avatarUrl: true, bio: true } }).catch(() => null),
    prisma.medal.findMany({ where: { userId, status: 'ACTIVE' }, orderBy: { issuedAt: 'desc' } }),
  ]);
  const tplIds = [...new Set(medals.map((m) => m.templateId))], issIds = [...new Set(medals.map((m) => m.issuerId))];
  const [tpls, isss] = await Promise.all([
    prisma.medalTemplate.findMany({ where: { id: { in: tplIds } } }),
    prisma.medalIssuer.findMany({ where: { id: { in: issIds } } }),
  ]);
  const T = Object.fromEntries(tpls.map((t) => [t.id, t])), I = Object.fromEntries(isss.map((i) => [i.id, i]));
  const views = [];
  for (const m of medals) views.push(await viewOf(m, { template: T[m.templateId], issuer: I[m.issuerId], username: prof && prof.username }));
  return { athlete: { name: user && user.name, username: prof && prof.username, avatarUrl: prof && prof.avatarUrl, bio: prof && prof.bio, city: user && user.city, state: user && user.state }, medals: views };
}

// Carteira do PRÓPRIO atleta: inclui o código de titularidade (sal) — prova de que a medalha é dele.
async function wallet(userId) {
  const medals = await prisma.medal.findMany({ where: { userId }, orderBy: { issuedAt: 'desc' } });
  const out = [];
  for (const m of medals) { const v = await viewOf(m); v.ownershipCode = m.identitySalt; out.push(v); }
  return out;
}

// Contexto JSON-LD da extensão (termo "medal" opaco).
function jsonLdContext() {
  return { '@context': { '@version': 1.1, medal: { '@id': BASE() + '/ns/medalha#medal', '@type': '@json' } } };
}

module.exports = {
  MedalError, REVOKE_REASONS, TIERS, ACHIEVEMENTS, DISTINCTIONS, ISSUER_KINDS,
  createIssuer, publicIssuer, assertIssuerOwner, saveTemplate,
  categoryResult, topScorers, previewTournament, issueTournament, issueManual, issueOne, buildCredential,
  setStatus, statusList, history, viewOf, bySerial, shelf, wallet, jsonLdContext, qrOf, BASE,
};
