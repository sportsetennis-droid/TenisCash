// =====================================================================
// Liga Aberta F6 — MODERAÇÃO: denúncia, fila de revisão e suspensão
// ---------------------------------------------------------------------
// Denunciar (qualquer conta logada — can REPORT): torneio, time (inscrição), aviso do
// mural e imagem. Motivo de uma lista curta + texto opcional (até 500).
// A mesma pessoa não denuncia o MESMO alvo 2x enquanto a denúncia está em aberto (409).
// Alvo que a pessoa não pode ver = o MESMO 404 de "não existe".
//
// Fila (só admin global — can MODERATE): descartar · ocultar aviso · ocultar imagem
// (campo vira nulo + MediaObject bloqueado → /media 404) · suspender torneio
// (Tournament.suspendedAt: some do público em todas as rotas; dono e admin veem) ·
// suspender organizador (OrganizerSuspension: não cria torneio, can() nega a gestão).
// Toda ação: TournamentAudit (quando é de um torneio) + ModerationLog (global).
// Master Cup (lista de exclusão): denúncia funciona; nada é automático — suspensão e
// ocultação só por ação manual do admin, que precisa confirmar.
// Nada aqui envia mensagem a ninguém.
// =====================================================================

const { prisma } = require('../middleware');
const roles = require('./tournamentRoles');
const audit = require('./tournamentAudit');
const access = require('./tournamentAccess');

const REASONS = {
  OFFENSIVE: 'Ofensivo',
  IMPROPER: 'Impróprio',
  SCAM: 'Golpe ou spam',
  PERSONAL_DATA: 'Dados pessoais expostos',
  OTHER: 'Outro motivo',
};
const TARGETS = ['TOURNAMENT', 'ENTRY', 'POST', 'IMAGE'];
// Imagem: entidade → campos de imagem que existem nela
const IMAGE_FIELDS = {
  tournament: ['bannerUrl'],
  entry: ['logoUrl'],
  post: ['imageUrl'],
  sponsor: ['logoUrl'],
};
const TEXT_MAX = 500;

class ModError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const fail = (status, msg, extra) => { throw new ModError(status, msg, extra); };
const NOT_FOUND = () => fail(404, 'não encontrado');

function mediaSha(url) {
  const m = /^\/media\/([a-f0-9]{64})\.(png|jpg|jpeg|webp|gif)$/.exec(String(url || ''));
  return m ? m[1] : null;
}
function cleanUrl(u) {
  const s = String(u || '').trim();
  if (!s || /^data:/i.test(s)) return null; // data URI não vai pro banco da denúncia
  if (s.length > 500) return null;
  return /^(https:\/\/|\/media\/|\/api\/public\/|\/img\/)/.test(s) ? s : null;
}

// Valor ATUAL do campo de imagem (o que o público vê). Time: escudo do clube (F2) com
// fallback no logo da inscrição.
async function currentImage(entity, entityId, field) {
  const id = String(entityId || '');
  if (entity === 'tournament') return (await prisma.tournament.findUnique({ where: { id }, select: { bannerUrl: true } }) || {}).bannerUrl || null;
  if (entity === 'post') return (await prisma.tournamentPost.findUnique({ where: { id }, select: { imageUrl: true } }) || {}).imageUrl || null;
  if (entity === 'sponsor') return (await prisma.tournamentSponsor.findUnique({ where: { id }, select: { logoUrl: true } }).catch(() => null) || {}).logoUrl || null;
  if (entity === 'entry') {
    const e = await prisma.tournamentEntry.findUnique({ where: { id }, select: { logoUrl: true, clubId: true } });
    if (!e) return null;
    const c = e.clubId ? await prisma.club.findUnique({ where: { id: e.clubId }, select: { crestUrl: true } }) : null;
    return (c && c.crestUrl) || e.logoUrl || null;
  }
  return null;
}

// A ação manual atinge algo da LISTA DE EXCLUSÃO (Master Cup)? (clube compartilhado ou a
// mesma imagem usada lá) → o admin precisa confirmar.
async function touchesExcluded({ tournamentId = null, clubId = null, urls = [] } = {}) {
  const slugs = [...require('./clubIdentity').excludedSlugs()];
  if (!slugs.length) return false;
  const ex = await prisma.tournament.findMany({ where: { slug: { in: slugs } }, select: { id: true, bannerUrl: true } });
  const ids = ex.map((t) => t.id);
  if (!ids.length) return false;
  if (tournamentId && ids.includes(tournamentId)) return true;
  const u = urls.filter(Boolean);
  if (u.length && ex.some((t) => u.includes(t.bannerUrl))) return true;
  const or = [];
  if (clubId) or.push({ clubId });
  if (u.length) or.push({ logoUrl: { in: u } });
  if (or.length && await prisma.tournamentEntry.findFirst({ where: { tournamentId: { in: ids }, OR: or }, select: { id: true } })) return true;
  if (u.length && await prisma.tournamentPost.findFirst({ where: { tournamentId: { in: ids }, imageUrl: { in: u } }, select: { id: true } })) return true;
  if (u.length && await prisma.tournamentSponsor.findFirst({ where: { tournamentId: { in: ids }, logoUrl: { in: u } }, select: { id: true } }).catch(() => null)) return true;
  return false;
}

// --------------------------------------------------------------- alvo → torneio
async function resolveTarget(targetType, targetId, ctx = {}) {
  const id = String(targetId || '').trim();
  if (targetType === 'TOURNAMENT') {
    const t = await prisma.tournament.findFirst({ where: { OR: [{ id }, { slug: id }] }, select: { id: true, slug: true, name: true } });
    if (!t) NOT_FOUND();
    return { targetId: t.id, tournamentId: t.id, label: t.name };
  }
  if (targetType === 'ENTRY') {
    const e = await prisma.tournamentEntry.findUnique({ where: { id }, select: { id: true, tournamentId: true, name: true } });
    if (!e) NOT_FOUND();
    return { targetId: e.id, tournamentId: e.tournamentId, label: e.name };
  }
  if (targetType === 'POST') {
    const p = await prisma.tournamentPost.findUnique({ where: { id }, select: { id: true, tournamentId: true, title: true, body: true, hiddenAt: true } });
    if (!p || p.hiddenAt) NOT_FOUND();
    return { targetId: p.id, tournamentId: p.tournamentId, label: (p.title || p.body || '').slice(0, 80) };
  }
  if (targetType === 'IMAGE') {
    const entity = String(ctx.entity || '').toLowerCase();
    const fields = IMAGE_FIELDS[entity];
    if (!fields) fail(400, 'imagem: diga de onde ela é (torneio, time, aviso ou patrocinador)');
    const field = ctx.field && fields.includes(String(ctx.field)) ? String(ctx.field) : fields[0];
    const eid = String(ctx.entityId || id || '').trim();
    let tournamentId = null;
    if (entity === 'tournament') tournamentId = (await prisma.tournament.findFirst({ where: { OR: [{ id: eid }, { slug: eid }] }, select: { id: true } }) || {}).id;
    else if (entity === 'entry') tournamentId = (await prisma.tournamentEntry.findUnique({ where: { id: eid }, select: { tournamentId: true } }) || {}).tournamentId;
    else if (entity === 'post') { const p = await prisma.tournamentPost.findUnique({ where: { id: eid }, select: { tournamentId: true, hiddenAt: true } }); tournamentId = p && !p.hiddenAt ? p.tournamentId : null; }
    else if (entity === 'sponsor') tournamentId = (await prisma.tournamentSponsor.findUnique({ where: { id: eid }, select: { tournamentId: true } }).catch(() => null) || {}).tournamentId;
    if (!tournamentId) NOT_FOUND();
    const realId = entity === 'tournament' ? tournamentId : eid;
    // a URL vem SEMPRE do servidor (o valor atual do campo) — nunca de quem denuncia
    const url = cleanUrl(await currentImage(entity, realId, field));
    if (!url) fail(400, 'esta imagem não está mais no ar');
    return { targetId: `${entity}:${realId}:${field}`, tournamentId, label: `imagem (${entity})`, context: { entity, entityId: realId, field, url } };
  }
  fail(400, 'tipo de denúncia inválido');
  return null;
}

// --------------------------------------------------------------- denunciar
async function createReport(req, body = {}) {
  const userId = req.userId;
  if (!(await roles.can(userId, req.userRole, null, 'REPORT'))) fail(401, 'entre na sua conta para denunciar');
  const targetType = String(body.targetType || '').toUpperCase();
  if (!TARGETS.includes(targetType)) fail(400, 'tipo de denúncia inválido');
  const reason = String(body.reason || '').toUpperCase();
  if (!REASONS[reason]) fail(400, 'escolha um motivo', { reasons: Object.keys(REASONS) });
  const text = body.text == null ? null : String(body.text).trim().slice(0, TEXT_MAX) || null;
  const tgt = await resolveTarget(targetType, body.targetId, body.context || body);
  // quem não pode ver o torneio recebe o MESMO 404 de "não existe"
  if (!(await access.canSeeTournamentId(req, tgt.tournamentId))) NOT_FOUND();
  const dup = await prisma.contentReport.findFirst({ where: { reporterId: userId, targetType, targetId: tgt.targetId, status: 'OPEN' }, select: { id: true } });
  if (dup) fail(409, 'você já denunciou isto — a moderação vai revisar', { code: 'ALREADY_REPORTED', reportId: dup.id });
  let r;
  try {
    r = await prisma.contentReport.create({
      data: { reporterId: userId, targetType, targetId: tgt.targetId, tournamentId: tgt.tournamentId, context: tgt.context || null, reason, text, status: 'OPEN' },
      select: { id: true, status: true, createdAt: true },
    });
  } catch (e) {
    // índice único parcial (pessoa, alvo) em aberto: duas denúncias iguais ao mesmo tempo
    if (e && e.code === 'P2002') fail(409, 'você já denunciou isto — a moderação vai revisar', { code: 'ALREADY_REPORTED' });
    throw e;
  }
  return { ok: true, report: r, message: 'Denúncia recebida. A moderação vai revisar.' };
}

// --------------------------------------------------------------- fila
async function requireModerator(req) {
  if (!(await roles.can(req.userId, req.userRole, null, 'MODERATE'))) fail(403, 'só a moderação (administrador do sistema)');
}

async function describeTargets(rows) {
  const tIds = [...new Set(rows.map((r) => r.tournamentId).filter(Boolean))];
  const ts = tIds.length ? await prisma.tournament.findMany({ where: { id: { in: tIds } }, select: { id: true, slug: true, name: true, ownerId: true, suspendedAt: true, suspendedReason: true, archivedAt: true, visibility: true } }) : [];
  const tById = new Map(ts.map((t) => [t.id, t]));
  const entryIds = rows.filter((r) => r.targetType === 'ENTRY').map((r) => r.targetId);
  const postIds = rows.filter((r) => r.targetType === 'POST').map((r) => r.targetId);
  const [entries, posts] = await Promise.all([
    entryIds.length ? prisma.tournamentEntry.findMany({ where: { id: { in: entryIds } }, select: { id: true, name: true, logoUrl: true } }) : [],
    postIds.length ? prisma.tournamentPost.findMany({ where: { id: { in: postIds } }, select: { id: true, title: true, body: true, imageUrl: true, hiddenAt: true } }) : [],
  ]);
  const eById = new Map(entries.map((e) => [e.id, e]));
  const pById = new Map(posts.map((p) => [p.id, p]));
  const ownerIds = [...new Set(ts.map((t) => t.ownerId).concat(rows.map((r) => r.reporterId)))];
  const [users, susp] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true, username: true } }),
    prisma.organizerSuspension.findMany({ where: { userId: { in: ownerIds }, liftedAt: null }, select: { userId: true } }).catch(() => []),
  ]);
  const uById = new Map(users.map((u) => [u.id, u]));
  const suspSet = new Set(susp.map((x) => x.userId));
  const excluded = require('./clubIdentity').excludedSlugs();
  return rows.map((r) => {
    const t = tById.get(r.tournamentId) || null;
    let target = null;
    if (r.targetType === 'TOURNAMENT') target = t ? { name: t.name, slug: t.slug } : null;
    else if (r.targetType === 'ENTRY') { const e = eById.get(r.targetId); target = e ? { name: e.name, logoUrl: e.logoUrl && !/^data:/.test(e.logoUrl) ? e.logoUrl : null } : null; }
    else if (r.targetType === 'POST') { const p = pById.get(r.targetId); target = p ? { title: p.title, body: String(p.body || '').slice(0, 300), imageUrl: p.imageUrl, hidden: !!p.hiddenAt } : null; }
    else if (r.targetType === 'IMAGE') target = { ...(r.context || {}), url: r._liveUrl !== undefined ? r._liveUrl : (r.context || {}).url };
    const owner = t ? uById.get(t.ownerId) : null;
    return {
      id: r.id, targetType: r.targetType, targetId: r.targetId, reason: r.reason, reasonLabel: REASONS[r.reason] || r.reason, text: r.text,
      status: r.status, resolution: r.resolution, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt, createdAt: r.createdAt,
      reporter: uById.get(r.reporterId) ? { id: r.reporterId, name: uById.get(r.reporterId).name, username: uById.get(r.reporterId).username } : { id: r.reporterId },
      target,
      tournament: t ? { id: t.id, slug: t.slug, name: t.name, suspended: !!t.suspendedAt, suspendedReason: t.suspendedReason, archived: !!t.archivedAt, visibility: t.visibility, excluded: excluded.has(t.slug) } : null,
      organizer: owner ? { id: owner.id, name: owner.name, username: owner.username, suspended: suspSet.has(owner.id) } : null,
      sameTargetOpen: r._sameOpen || 1,
    };
  });
}

async function queue(req, { status = 'OPEN', limit = 30, cursor = null } = {}) {
  await requireModerator(req);
  const st = ['OPEN', 'DISMISSED', 'ACTIONED', 'ALL'].includes(String(status).toUpperCase()) ? String(status).toUpperCase() : 'OPEN';
  const take = Math.max(1, Math.min(Number(limit) || 30, 100));
  const q = { where: st === 'ALL' ? {} : { status: st }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 };
  if (cursor) {
    if (!(await prisma.contentReport.findUnique({ where: { id: String(cursor) }, select: { id: true } }))) fail(400, 'cursor inválido');
    q.cursor = { id: String(cursor) }; q.skip = 1;
  }
  const rows = await prisma.contentReport.findMany(q);
  const more = rows.length > take;
  const items = more ? rows.slice(0, take) : rows;
  // quantas denúncias em aberto o mesmo alvo tem
  const keys = [...new Set(items.map((r) => r.targetType + '|' + r.targetId))];
  const counts = {};
  for (const k of keys) {
    const [tt, tid] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
    counts[k] = await prisma.contentReport.count({ where: { targetType: tt, targetId: tid, status: 'OPEN' } });
  }
  items.forEach((r) => { r._sameOpen = counts[r.targetType + '|' + r.targetId] || 1; });
  // imagem: o admin vê o que está NO AR agora (lido no servidor), não o que veio na denúncia
  for (const r of items) if (r.targetType === 'IMAGE' && r.context) r._liveUrl = cleanUrl(await currentImage(r.context.entity, r.context.entityId, r.context.field));
  const [openTotal, pendingPrivacy, suspendedTournaments, suspendedOrganizers] = await Promise.all([
    prisma.contentReport.count({ where: { status: 'OPEN' } }),
    prisma.privacyRequest.count({ where: { status: 'PENDING_ADMIN' } }).catch(() => 0),
    prisma.tournament.findMany({ where: { suspendedAt: { not: null } }, select: { id: true, slug: true, name: true, suspendedAt: true, suspendedReason: true }, orderBy: { suspendedAt: 'desc' }, take: 50 }),
    prisma.organizerSuspension.findMany({ where: { liftedAt: null }, orderBy: { suspendedAt: 'desc' }, take: 50 }).catch(() => []),
  ]);
  const ou = suspendedOrganizers.length ? await prisma.user.findMany({ where: { id: { in: suspendedOrganizers.map((s) => s.userId) } }, select: { id: true, name: true, username: true } }) : [];
  const ouById = new Map(ou.map((u) => [u.id, u]));
  return {
    items: await describeTargets(items),
    nextCursor: more ? items[items.length - 1].id : null,
    openTotal, pendingPrivacy, suspendedTournaments,
    suspendedOrganizers: suspendedOrganizers.map((s) => ({ userId: s.userId, name: (ouById.get(s.userId) || {}).name || null, username: (ouById.get(s.userId) || {}).username || null, reason: s.reason, suspendedAt: s.suspendedAt })),
    reasons: REASONS,
  };
}

async function logGlobal({ actorId, action, targetType, targetId, reportId = null, tournamentId = null, before = null, after = null }) {
  try {
    return await prisma.moderationLog.create({ data: { actorId, action, targetType, targetId: String(targetId), reportId, tournamentId, before: before == null ? null : JSON.parse(JSON.stringify(before)), after: after == null ? null : JSON.parse(JSON.stringify(after)) } });
  } catch (e) { console.error('[moderation] log falhou', action, e.message); return null; }
}

// Fecha a denúncia e as outras EM ABERTO do mesmo alvo.
async function closeReports(report, status, resolution, actorId) {
  if (!report) return 0;
  const r = await prisma.contentReport.updateMany({
    where: { OR: [{ id: report.id }, { targetType: report.targetType, targetId: report.targetId, status: 'OPEN' }] },
    data: { status, resolution, reviewedBy: actorId, reviewedAt: new Date() },
  });
  return r.count;
}
async function loadReport(id) {
  const r = await prisma.contentReport.findUnique({ where: { id: String(id || '') } });
  if (!r) fail(404, 'denúncia não encontrada');
  return r;
}

async function dismiss(req, reportId) {
  await requireModerator(req);
  const r = await loadReport(reportId);
  const n = await closeReports(r, 'DISMISSED', 'dismiss', req.userId);
  await logGlobal({ actorId: req.userId, action: 'report.dismiss', targetType: r.targetType, targetId: r.targetId, reportId: r.id, tournamentId: r.tournamentId, after: { closed: n } });
  return { ok: true, closed: n };
}

// Ocultar aviso (por denúncia ou direto pelo id do aviso). Reversível (unhide).
async function hidePost(req, { reportId, postId, hide = true, confirm } = {}) {
  await requireModerator(req);
  const r = reportId ? await loadReport(reportId) : null;
  const pid = postId || (r && r.targetType === 'POST' ? r.targetId : null);
  if (!pid) fail(400, 'esta denúncia não é de um aviso');
  const p = await prisma.tournamentPost.findUnique({ where: { id: String(pid) }, select: { id: true, tournamentId: true, hiddenAt: true } });
  if (!p) fail(404, 'aviso não encontrado');
  if (await touchesExcluded({ tournamentId: p.tournamentId }) && confirm !== true) fail(409, 'aviso de torneio da lista de exclusão (Master Cup): confirme a ação manual', { code: 'CONFIRM_REQUIRED' });
  const data = hide ? { hiddenAt: new Date(), hiddenBy: req.userId } : { hiddenAt: null, hiddenBy: null };
  await prisma.tournamentPost.update({ where: { id: p.id }, data });
  const action = hide ? 'post.hide' : 'post.unhide';
  await audit.record({ tournamentId: p.tournamentId, userId: req.userId, action, entity: 'TournamentPost', entityId: p.id, before: { hiddenAt: p.hiddenAt }, after: { hiddenAt: data.hiddenAt, reportId: r ? r.id : null } });
  await logGlobal({ actorId: req.userId, action, targetType: 'POST', targetId: p.id, reportId: r ? r.id : null, tournamentId: p.tournamentId });
  const closed = hide && r ? await closeReports(r, 'ACTIONED', 'hide_post', req.userId) : 0;
  return { ok: true, postId: p.id, hidden: hide, closed };
}

// Ocultar imagem: o campo vira NULO no alvo (e onde o mesmo escudo se repete no clube) +
// MediaObject bloqueado (/media 404). Só por denúncia de IMAGEM (ou de aviso com imagem).
async function hideImage(req, { reportId, confirm } = {}) {
  await requireModerator(req);
  const r = await loadReport(reportId);
  let ctx = r.context || {};
  if (r.targetType === 'POST') ctx = { entity: 'post', entityId: r.targetId, field: 'imageUrl' };
  if (r.targetType === 'ENTRY') ctx = { entity: 'entry', entityId: r.targetId, field: 'logoUrl' };
  if (r.targetType === 'TOURNAMENT') ctx = { entity: 'tournament', entityId: r.targetId, field: 'bannerUrl' };
  const fields = IMAGE_FIELDS[ctx.entity];
  if (!fields || !fields.includes(ctx.field)) fail(400, 'esta denúncia não aponta uma imagem');
  // Master Cup: o torneio da denúncia, o clube (compartilhado entre torneios) ou a MESMA imagem
  // usada lá → só com confirmação manual do admin
  const cur = await currentImage(ctx.entity, ctx.entityId, ctx.field);
  let urlsHit = [cur];
  let clubHit = null;
  if (ctx.entity === 'entry') {
    const e0 = await prisma.tournamentEntry.findUnique({ where: { id: ctx.entityId }, select: { logoUrl: true, clubId: true } });
    if (e0) { urlsHit.push(e0.logoUrl); clubHit = e0.clubId; }
  }
  urlsHit = urlsHit.filter(Boolean);
  if (confirm !== true && await touchesExcluded({ tournamentId: r.tournamentId, clubId: clubHit, urls: urlsHit })) fail(409, 'esta imagem (ou o clube) também é usada num torneio da lista de exclusão (Master Cup): confirme a ação manual', { code: 'CONFIRM_REQUIRED' });
  const changed = [];
  const blocked = [];
  const blockUrl = async (u) => { const sha = mediaSha(u); if (sha) { const b = await require('./mediaStore').block(sha, 'moderação: denúncia ' + r.id); blocked.push({ sha, blocked: b.blocked }); } };
  if (ctx.entity === 'tournament') {
    const cur = await prisma.tournament.findUnique({ where: { id: ctx.entityId }, select: { bannerUrl: true } });
    if (cur && cur.bannerUrl) { await prisma.tournament.update({ where: { id: ctx.entityId }, data: { bannerUrl: null } }); changed.push('tournament.bannerUrl'); await blockUrl(cur.bannerUrl); }
  } else if (ctx.entity === 'post') {
    const cur = await prisma.tournamentPost.findUnique({ where: { id: ctx.entityId }, select: { imageUrl: true } });
    if (cur && cur.imageUrl) { await prisma.tournamentPost.update({ where: { id: ctx.entityId }, data: { imageUrl: null } }); changed.push('post.imageUrl'); await blockUrl(cur.imageUrl); }
  } else if (ctx.entity === 'sponsor') {
    const cur = await prisma.tournamentSponsor.findUnique({ where: { id: ctx.entityId }, select: { logoUrl: true } });
    if (cur && cur.logoUrl) { await prisma.tournamentSponsor.update({ where: { id: ctx.entityId }, data: { logoUrl: null } }); changed.push('sponsor.logoUrl'); await blockUrl(cur.logoUrl); }
  } else if (ctx.entity === 'entry') {
    const e = await prisma.tournamentEntry.findUnique({ where: { id: ctx.entityId }, select: { id: true, tournamentId: true, name: true, logoUrl: true, clubId: true } });
    if (e) {
      // o escudo exibido é o do clube (F2) com fallback no logo da inscrição
      const club = e.clubId ? await prisma.club.findUnique({ where: { id: e.clubId }, select: { id: true, crestUrl: true } }) : null;
      const shown = (club && club.crestUrl) || e.logoUrl;
      if (club && club.crestUrl) { await prisma.club.update({ where: { id: club.id }, data: { crestUrl: null } }); changed.push('club.crestUrl'); }
      // TIME = CLUBE ÚNICO: o mesmo escudo nas outras categorias do time some junto
      const same = await prisma.tournamentEntry.updateMany({ where: { tournamentId: e.tournamentId, OR: [{ id: e.id }, { name: e.name, logoUrl: e.logoUrl || '__nenhum__' }, ...(e.clubId ? [{ clubId: e.clubId }] : [])], logoUrl: { not: null } }, data: { logoUrl: null } });
      if (same.count) changed.push(`entry.logoUrl×${same.count}`);
      if (shown) await blockUrl(shown);
      if (e.logoUrl && e.logoUrl !== shown) await blockUrl(e.logoUrl);
    }
  }
  // (a URL guardada na denúncia NÃO é usada: só o valor atual do campo, lido acima)
  await audit.record({ tournamentId: r.tournamentId, userId: req.userId, action: 'image.hide', entity: ctx.entity, entityId: ctx.entityId, before: null, after: { field: ctx.field, changed, blocked, reportId: r.id } });
  await logGlobal({ actorId: req.userId, action: 'image.hide', targetType: 'IMAGE', targetId: r.targetId, reportId: r.id, tournamentId: r.tournamentId, after: { changed, blocked } });
  const closed = await closeReports(r, 'ACTIONED', 'hide_image', req.userId);
  return { ok: true, changed, blocked, closed, note: 'Se a imagem ainda aparecer, ela está no cache da borda (Cloudflare): purgar a URL /media.' };
}

// Suspender / reativar torneio (manual, com confirmação).
async function setTournamentSuspended(req, tournamentId, { suspend = true, reason = null, reportId = null, confirm } = {}) {
  await requireModerator(req);
  if (suspend && confirm !== true) fail(409, 'confirme a suspensão do torneio', { code: 'CONFIRM_REQUIRED' });
  const t = await prisma.tournament.findFirst({ where: { OR: [{ id: String(tournamentId || '') }, { slug: String(tournamentId || '') }] }, select: { id: true, slug: true, suspendedAt: true, suspendedReason: true } });
  if (!t) fail(404, 'torneio não encontrado');
  const r = reportId ? await loadReport(reportId) : null;
  const data = suspend
    ? { suspendedAt: t.suspendedAt || new Date(), suspendedReason: reason ? String(reason).slice(0, 300) : (t.suspendedReason || null), suspendedBy: req.userId }
    : { suspendedAt: null, suspendedReason: null, suspendedBy: null };
  await prisma.tournament.update({ where: { id: t.id }, data });
  // ao vivo já aberto cai na hora (reconectar dá 404); ranking de times sem o suspenso
  if (suspend) { try { require('./tournamentLive').closeAll(t.id); } catch (_) { /* sem SSE */ } }
  try { const sp = (await prisma.tournament.findUnique({ where: { id: t.id }, select: { sport: true } }) || {}).sport; if (sp) require('./clubRating').recomputeSport(sp).catch(() => {}); } catch (_) { /* best-effort */ }
  const action = suspend ? 'tournament.suspend' : 'tournament.unsuspend';
  await audit.record({ tournamentId: t.id, userId: req.userId, action, entity: 'Tournament', entityId: t.id, before: { suspendedAt: t.suspendedAt, suspendedReason: t.suspendedReason }, after: { suspendedAt: data.suspendedAt, suspendedReason: data.suspendedReason, reportId: r ? r.id : null } });
  await logGlobal({ actorId: req.userId, action, targetType: 'TOURNAMENT', targetId: t.id, reportId: r ? r.id : null, tournamentId: t.id, after: { reason: data.suspendedReason } });
  let closed = 0;
  if (suspend) {
    if (r) closed += await closeReports(r, 'ACTIONED', 'suspend_tournament', req.userId);
    const c = await prisma.contentReport.updateMany({ where: { targetType: 'TOURNAMENT', targetId: t.id, status: 'OPEN' }, data: { status: 'ACTIONED', resolution: 'suspend_tournament', reviewedBy: req.userId, reviewedAt: new Date() } });
    closed += c.count;
  }
  return { ok: true, tournamentId: t.id, suspended: suspend, closed };
}

// Suspender / reativar ORGANIZADOR (por denúncia de torneio → dono dele; ou userId direto).
async function setOrganizerSuspended(req, { userId, reportId = null, suspend = true, reason = null, confirm } = {}) {
  await requireModerator(req);
  if (suspend && confirm !== true) fail(409, 'confirme a suspensão do organizador', { code: 'CONFIRM_REQUIRED' });
  const r = reportId ? await loadReport(reportId) : null;
  let uid = userId ? String(userId) : null;
  // pela denúncia: só denúncia de TORNEIO aponta o organizador (aviso/time/imagem podem ser de outra pessoa)
  if (!uid && r && r.targetType !== 'TOURNAMENT') fail(400, 'para suspender o organizador, use uma denúncia do torneio dele');
  if (!uid && r && r.tournamentId) uid = (await prisma.tournament.findUnique({ where: { id: r.tournamentId }, select: { ownerId: true } }) || {}).ownerId || null;
  if (!uid) fail(400, 'diga qual organizador');
  const u = await prisma.user.findUnique({ where: { id: uid }, select: { id: true, role: true } });
  if (!u) fail(404, 'organizador não encontrado');
  if (suspend && roles.isGlobalAdmin(u.role)) fail(400, 'administrador do sistema não é suspenso por aqui');
  const prev = await prisma.organizerSuspension.findUnique({ where: { userId: uid } });
  if (suspend) {
    await prisma.organizerSuspension.upsert({
      where: { userId: uid },
      create: { userId: uid, reason: reason ? String(reason).slice(0, 300) : null, suspendedBy: req.userId },
      update: { reason: reason ? String(reason).slice(0, 300) : (prev && prev.reason) || null, suspendedBy: req.userId, suspendedAt: prev && !prev.liftedAt ? prev.suspendedAt : new Date(), liftedAt: null, liftedBy: null },
    });
  } else if (prev && !prev.liftedAt) {
    await prisma.organizerSuspension.update({ where: { userId: uid }, data: { liftedAt: new Date(), liftedBy: req.userId } });
  }
  const action = suspend ? 'organizer.suspend' : 'organizer.unsuspend';
  await logGlobal({ actorId: req.userId, action, targetType: 'USER', targetId: uid, reportId: r ? r.id : null, tournamentId: r ? r.tournamentId : null, before: prev, after: { reason } });
  if (r && r.tournamentId) await audit.record({ tournamentId: r.tournamentId, userId: req.userId, action, entity: 'User', entityId: uid, after: { userId: uid, reportId: r.id } });
  const closed = suspend && r ? await closeReports(r, 'ACTIONED', 'suspend_organizer', req.userId) : 0;
  return { ok: true, userId: uid, suspended: suspend, closed };
}

async function moderationLog(req, { limit = 50, cursor = null } = {}) {
  await requireModerator(req);
  const take = Math.max(1, Math.min(Number(limit) || 50, 100));
  const q = { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: take + 1 };
  if (cursor) {
    if (!(await prisma.moderationLog.findUnique({ where: { id: String(cursor) }, select: { id: true } }))) fail(400, 'cursor inválido');
    q.cursor = { id: String(cursor) }; q.skip = 1;
  }
  const rows = await prisma.moderationLog.findMany(q);
  const more = rows.length > take;
  const items = more ? rows.slice(0, take) : rows;
  return { items, nextCursor: more ? items[items.length - 1].id : null };
}

module.exports = {
  REASONS, TARGETS, IMAGE_FIELDS, ModError,
  createReport, queue, dismiss, hidePost, hideImage, setTournamentSuspended, setOrganizerSuspended, moderationLog, logGlobal, requireModerator,
};
