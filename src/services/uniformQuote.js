// =====================================================================
// Liga Aberta F7 — "Pedir orçamento de uniforme" (Meta Fardamentos)
// ---------------------------------------------------------------------
// Quem gerencia o time (can MANAGE_TEAM: coordenação/fundador/admin global ou o
// administrador do PRÓPRIO time) pede o orçamento; vira um MfLead (source "liga",
// status "novo") com torneio, time, esporte, cores, nº de atletas e o ESCUDO por
// endereço (/media/<sha>.<ext> ou https — nunca base64 no lead).
//  - Nome e telefone: SÓ da conta logada que pediu, e só com o consentimento explícito
//    da tela ("autorizo a Meta Fardamentos a me contatar"). Sem ele = 400.
//  - NÃO envia mensagem: não chama o atendente da Meta Fardamentos nem WhatsApp. A equipe
//    vê o lead no painel dela (/api/mf/leads) e decide o contato.
//  - Sem duplicar: o mesmo time (clube; sem clube = nome no torneio) + a mesma pessoa em
//    24 h devolve o pedido que já existe (trava por chave na transação).
//  - Conta que declara menor de 18 não pede (nada de dado de menor — ligaMinors).
// =====================================================================

const { prisma } = require('../middleware');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');
const clubIdentity = require('./clubIdentity');
const minors = require('./ligaMinors');
const contentFilter = require('./contentFilter');

const DEDUPE_HOURS = 24;
const MAX_ATHLETES = 300;
const SPORT_LABEL = { FUTSAL: 'Futsal', SOCCER: 'Futebol', FOOTBALL: 'Futebol', SOCIETY: 'Society', VOLLEY: 'Vôlei', BEACH_VOLLEY: 'Vôlei de praia', BASKETBALL: 'Basquete', HANDBALL: 'Handebol', TENNIS: 'Tênis', BEACH_TENNIS: 'Beach tennis', PADEL: 'Padel' };

class UniformQuoteError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; } }
const fail = (status, msg, code) => { throw new UniformQuoteError(status, msg, code); };

async function loadEntry(entryId) {
  const e = await prisma.tournamentEntry.findUnique({ where: { id: String(entryId) }, select: { id: true, name: true, tournamentId: true, categoryId: true, logoUrl: true, _count: { select: { members: true } } } });
  if (!e) fail(404, 'time não encontrado');
  const t = await prisma.tournament.findUnique({ where: { id: e.tournamentId }, select: { id: true, name: true, slug: true, sport: true, archivedAt: true, suspendedAt: true } });
  if (!t || t.archivedAt) fail(404, 'time não encontrado');
  return { e, t };
}

// Escudo como ENDEREÇO: /media/... ou https; data URI antigo vira /media (registro idempotente,
// o dado de origem não muda); qualquer outra coisa = sem escudo.
async function crestRef(value) {
  if (!value) return null;
  const v = String(value);
  if (/^\/media\/[0-9a-f]{64}\.(png|jpg|jpeg|webp|gif)$/i.test(v)) return v;
  if (/^https:\/\/[^\s<>"']+$/i.test(v) && v.length <= 600) return v;
  if (/^data:image\//i.test(v)) {
    try {
      const mediaStore = require('./mediaStore');
      const url = await mediaStore.publicUrlFor(v);
      return url && (/^\/media\//.test(url) || /^https:\/\//.test(url)) ? url : null; // S3/R2 ligado: URL https do bucket
    } catch (_) { return null; }
  }
  return null;
}

const HEX = /^#[0-9a-f]{6}$/i;
function cleanColors(raw, club) {
  if (raw == null || raw === '') {
    const cs = [club && club.primaryColor, club && club.secondaryColor].filter((x) => x && HEX.test(x));
    return cs.length ? cs.join(' / ') : null;
  }
  const s = String(raw).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return s || null;
}

async function context(entryId, user) {
  const { e, t } = await loadEntry(entryId);
  if (!(await roles.can(user.id, user.role, t.id, 'MANAGE_TEAM', { entryId: e.id }))) fail(403, 'só a organização ou o administrador deste time pede orçamento de uniforme');
  const club = await clubIdentity.clubOfEntry(e.id);
  const roster = await prisma.rosterPlayer.count({ where: { entryId: e.id, role: 'PLAYER' } }).catch(() => 0);
  return { e, t, club, roster };
}

function dedupeKey(t, e, club) { return club ? 'club:' + club.id : 'team:' + t.id + ':' + clubIdentity.normName(e.name); }

async function recentLead(userId, t, e, club, db = prisma) {
  const since = new Date(Date.now() - DEDUPE_HOURS * 3600 * 1000);
  const where = { source: 'liga', requestedByUserId: String(userId), createdAt: { gte: since } };
  if (club) where.clubId = club.id; else Object.assign(where, { tournamentId: t.id, clubId: null });
  const rows = await db.mfLead.findMany({ where, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, entryId: true, status: true, createdAt: true, athleteCount: true, colors: true, crestUrl: true } });
  if (club) return rows[0] || null;
  // sem clube: mesmo nome de time no torneio (todas as categorias do time)
  if (!rows.length) return null;
  const sameName = await db.tournamentEntry.findMany({ where: { tournamentId: t.id, id: { in: rows.map((r) => r.entryId).filter(Boolean) } }, select: { id: true, name: true } });
  const ok = new Set(sameName.filter((x) => clubIdentity.normName(x.name) === clubIdentity.normName(e.name)).map((x) => x.id));
  return rows.find((r) => ok.has(r.entryId)) || null;
}

const publicLead = (l) => l && ({ id: l.id, status: l.status, createdAt: l.createdAt, athleteCount: l.athleteCount, colors: l.colors, crestUrl: l.crestUrl });

/** Estado para a tela: dados para pré-preencher + pedido recente desta pessoa (se houver). */
async function status(entryId, user) {
  const { e, t, club, roster } = await context(entryId, user);
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { name: true, phone: true } });
  const recent = await recentLead(user.id, t, e, club);
  const phone = me && me.phone ? String(me.phone) : '';
  return {
    team: { entryId: e.id, name: club ? club.name : e.name, crestUrl: await crestRef((club && club.crestUrl) || e.logoUrl), colors: cleanColors(null, club), athleteCount: roster || null },
    tournament: { id: t.id, name: t.name, sport: t.sport },
    contact: { name: me && me.name ? me.name : null, phoneMasked: phone ? phone.slice(0, 4) + '••••' + phone.slice(-2) : null },
    recent: publicLead(recent),
    dedupeHours: DEDUPE_HOURS,
  };
}

/** Cria o pedido (lead). body: { consent:true, colors?, athleteCount?, note? } */
async function request(entryId, user, body = {}) {
  const { e, t, club, roster } = await context(entryId, user);
  if (body.consent !== true) fail(400, 'para pedir o orçamento, marque "autorizo a Meta Fardamentos a me contatar"', 'CONSENT_REQUIRED');
  const me = await prisma.user.findUnique({ where: { id: user.id }, select: { id: true, name: true, phone: true, active: true, birthDate: true } });
  if (!me || !me.active) fail(401, 'entre na sua conta');
  if (minors.declaresMinor(me.birthDate)) fail(403, 'conta de menor de 18 anos não pede orçamento — peça a um responsável maior de idade', 'MINOR');
  let athleteCount = body.athleteCount == null || body.athleteCount === '' ? (roster || null) : Math.floor(Number(body.athleteCount));
  if (athleteCount != null && (!Number.isFinite(athleteCount) || athleteCount < 1 || athleteCount > MAX_ATHLETES)) fail(400, `número de atletas inválido (de 1 a ${MAX_ATHLETES})`);
  if (athleteCount == null) fail(400, 'informe o número de atletas');
  const colors = cleanColors(body.colors, club);
  const note = body.note == null ? null : String(body.note).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300) || null;
  if (!clubIdentity.isExcludedSlug(t.slug)) contentFilter.assertClean([{ field: 'text', value: [colors, note].filter(Boolean) }]);
  const crestUrl = await crestRef((club && club.crestUrl) || e.logoUrl);
  const teamName = club ? club.name : e.name;
  const key = dedupeKey(t, e, club);

  const out = await prisma.$transaction(async (tx) => {
    // trava por (pessoa + time): dois toques ao mesmo tempo não viram 2 pedidos
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext(${'liga-uniforme:' + me.id + ':' + key}))) AS l`;
    const dup = await module.exports.recentLead(me.id, t, e, club, tx); // via exports: teste de sabotagem
    if (dup) return { lead: dup, duplicate: true };
    const resumo = [
      'Pedido de orçamento de uniforme pela Liga (Club Sports & Tennis).',
      `Torneio: ${t.name}`,
      `Time: ${teamName}`,
      `Esporte: ${SPORT_LABEL[t.sport] || t.sport || '—'}`,
      `Cores: ${colors || 'não informadas'}`,
      `Atletas: ${athleteCount}`,
      `Escudo: ${crestUrl || 'sem escudo'}`,
      note ? `Observação: ${note}` : null,
      'Contato autorizado pela própria pessoa na tela da Liga (nada foi enviado automaticamente).',
    ].filter(Boolean).join('\n');
    const lead = await tx.mfLead.create({
      data: {
        name: me.name || null,
        phone: me.phone || null,
        segment: 'liga',
        tipoFardamento: 'Uniforme de time' + (t.sport && SPORT_LABEL[t.sport] ? ' — ' + SPORT_LABEL[t.sport] : ''),
        quantidade: String(athleteCount),
        personalizacao: crestUrl ? 'Escudo do time' : null,
        resumo,
        source: 'liga',
        status: 'novo',
        crestUrl,
        colors,
        athleteCount,
        tournamentId: t.id,
        entryId: e.id,
        clubId: club ? club.id : null,
        requestedByUserId: me.id,
        consentAt: new Date(),
      },
      select: { id: true, entryId: true, status: true, createdAt: true, athleteCount: true, colors: true, crestUrl: true },
    });
    return { lead, duplicate: false };
  });
  if (!out.duplicate) {
    await audit.record({ tournamentId: t.id, userId: me.id, action: 'uniform.quote', entity: 'MfLead', entityId: out.lead.id, after: { entryId: e.id, clubId: club ? club.id : null, athleteCount, colors, crestUrl } });
  }
  return { ok: true, duplicate: out.duplicate, lead: publicLead(out.lead), message: out.duplicate ? `Você já pediu este orçamento nas últimas ${DEDUPE_HOURS} h — a Meta Fardamentos já recebeu.` : 'Pedido enviado para a Meta Fardamentos. A equipe vai falar com você.' };
}

async function leadsOfUser(userId) {
  try { return await prisma.mfLead.findMany({ where: { requestedByUserId: String(userId), source: 'liga' }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, status: true, tournamentId: true, entryId: true, colors: true, athleteCount: true, crestUrl: true, name: true, phone: true, resumo: true, consentAt: true, createdAt: true } }); } catch (_) { return []; }
}

module.exports = { UniformQuoteError, DEDUPE_HOURS, status, request, crestRef, recentLead, leadsOfUser };
