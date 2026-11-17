// =====================================================================
// Routes: /api/activities — APEX (app de atividade do Club, estilo Strava)
// ---------------------------------------------------------------------
// TUDO autenticado. O dono é SEMPRE req.userId (authMiddleware) — nunca
// userId do body. Outro atleta só LÊ atividade pública (ou "seguidores",
// se segue), com a zona de privacidade aplicada e sem os pontos crus.
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const ingest = require('../services/activityIngest');
const geo = require('../services/apexGeo');
const rewards = require('../services/apexRewards');
const beacon = require('../services/apexBeacon');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const CONSENT_SCOPES = new Set(['location_history', 'live_tracking', 'health_data']);
const CONSENT_VERSION = 'apex-2026-11';

function fail(res, r) { return res.status(r.status || 400).json({ error: r.error, ...(r.activityId ? { activityId: r.activityId } : {}), ...(r.consentScope ? { consentScope: r.consentScope } : {}) }); }
function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (e && e.status) return res.status(e.status).json({ error: e.message });
    console.error('[activities]', e);
    res.status(500).json({ error: e.message || 'erro interno' });
  });
}

async function zonesOf(userId) {
  return prisma.activityPrivacyZone.findMany({ where: { userId }, select: { lat: true, lng: true, radiusM: true } });
}
async function follows(followerId, followeeId) {
  if (!followerId || !followeeId) return false;
  return !!(await prisma.athleteFollow.findUnique({ where: { followerId_followeeId: { followerId, followeeId } } }));
}
async function canView(act, viewerId) {
  if (!act || act.processingState === 'recording') return false;
  if (act.userId === viewerId) return true;
  if (act.visibility === 'public') return true;
  if (act.visibility === 'followers') return follows(viewerId, act.userId);
  return false;
}
// polyline público: pontos dentro da zona de privacidade somem
function publicPolyline(act, zones) {
  if (!act.summaryPolyline) return null;
  if (!zones.length) return act.summaryPolyline;
  const pts = geo.densify(geo.decodePolyline(act.summaryPolyline), 20).map(([lat, lng]) => ({ lat, lng }));
  const vis = geo.applyPrivacyZones(pts, zones);
  return vis.length >= 2 ? geo.encodePolyline(geo.simplifyTo(vis.map((p) => [p.lat, p.lng]), 600)) : null;
}

const LIST_SELECT = {
  id: true, userId: true, title: true, sportType: true, startedAt: true, elapsedTimeS: true, movingTimeS: true,
  distanceM: true, avgHeartRate: true, avgPace: true, elevationGainM: true, calories: true, summaryPolyline: true,
  visibility: true, processingState: true, deviceSource: true,
};

// ------------------------------------------------------------ resumo/badges
router.get('/me/summary', wrap(async (req, res) => {
  const uid = req.userId;
  const now = new Date();
  const sum = async (since) => {
    const a = await prisma.activity.aggregate({
      where: { userId: uid, processingState: 'done', startedAt: { gte: since } },
      _sum: { distanceM: true, movingTimeS: true, elevationGainM: true }, _count: { _all: true },
    });
    return { count: a._count._all, distanceM: a._sum.distanceM || 0, movingTimeS: a._sum.movingTimeS || 0, elevationGainM: a._sum.elevationGainM || 0 };
  };
  const weekStart = new Date(now.getTime() - 7 * 86400e3);
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 3));
  const r = await rewards.userSummary(uid);
  res.json({
    week: await sum(weekStart), month: await sum(rewards.monthStartUtc(now)), year: await sum(yearStart),
    xp: r.xp, level: r.level, nextLevelXp: r.nextLevelXp, cashbackTotal: r.cashbackTotal, badges: r.badges.slice(0, 12),
  });
}));

router.get('/me/badges', wrap(async (req, res) => {
  const r = await rewards.userSummary(req.userId);
  res.json({ ...r, catalog: Object.entries(rewards.BADGES).map(([key, v]) => ({ key, ...v })) });
}));

// --------------------------------------------------------- consentimento
router.get('/consent', wrap(async (req, res) => {
  const rows = await prisma.consent.findMany({ where: { userId: req.userId, scope: { in: [...CONSENT_SCOPES] } }, orderBy: { grantedAt: 'desc' } });
  const state = {};
  for (const r of rows) if (!(r.scope in state)) state[r.scope] = r.granted && !r.revokedAt;
  res.json({ consents: state, version: CONSENT_VERSION });
}));
router.post('/consent', wrap(async (req, res) => {
  const scope = String(req.body?.scope || '');
  if (!CONSENT_SCOPES.has(scope)) return res.status(400).json({ error: 'escopo inválido' });
  const granted = req.body?.granted !== false;
  if (!granted) await prisma.consent.updateMany({ where: { userId: req.userId, scope, revokedAt: null }, data: { revokedAt: new Date() } });
  const row = await prisma.consent.create({ data: { userId: req.userId, scope, granted, version: CONSENT_VERSION, revokedAt: granted ? null : new Date() } });
  res.status(201).json({ ok: true, consent: row });
}));

// ---------------------------------------------------- zona de privacidade
router.get('/privacy-zones', wrap(async (req, res) => {
  res.json({ zones: await prisma.activityPrivacyZone.findMany({ where: { userId: req.userId }, orderBy: { createdAt: 'asc' } }) });
}));
router.post('/privacy-zones', wrap(async (req, res) => {
  const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
  const radiusM = Math.round(Number(req.body?.radiusM) || 300);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'coordenada inválida' });
  if (radiusM < 100 || radiusM > 2000) return res.status(400).json({ error: 'raio entre 100 e 2000 m' });
  if ((await prisma.activityPrivacyZone.count({ where: { userId: req.userId } })) >= 5) return res.status(400).json({ error: 'máximo de 5 zonas' });
  const z = await prisma.activityPrivacyZone.create({ data: { userId: req.userId, lat, lng, radiusM, label: req.body?.label ? String(req.body.label).slice(0, 40) : 'Casa' } });
  res.status(201).json({ zone: z });
}));
router.delete('/privacy-zones/:id', wrap(async (req, res) => {
  const r = await prisma.activityPrivacyZone.deleteMany({ where: { id: req.params.id, userId: req.userId } });
  res.status(r.count ? 200 : 404).json({ ok: r.count > 0 });
}));

// ------------------------------------------------ contatos de segurança
router.get('/safety-contacts', wrap(async (req, res) => res.json({ contacts: await beacon.listContacts(req.userId), max: beacon.MAX_CONTACTS })));
router.post('/safety-contacts', wrap(async (req, res) => res.status(201).json({ contact: await beacon.addContact(req.userId, req.body || {}) })));
router.delete('/safety-contacts/:id', wrap(async (req, res) => {
  const r = await beacon.removeContact(req.userId, req.params.id);
  res.status(r.ok ? 200 : 404).json(r);
}));

// ------------------------------------------------------------- Beacon
router.post('/beacon/start', wrap(async (req, res) => res.status(201).json(await beacon.start(req.userId, { sportType: req.body?.sportType }))));
router.post('/beacon/:sessionId/position', wrap(async (req, res) => res.json(await beacon.position(req.userId, req.params.sessionId, req.body?.points))));
router.post('/beacon/:sessionId/stop', wrap(async (req, res) => res.json(await beacon.stop(req.userId, req.params.sessionId))));

// ------------------------------------------------------------- seguir
router.post('/follow/:userId', wrap(async (req, res) => {
  const target = String(req.params.userId);
  if (target === req.userId) return res.status(400).json({ error: 'não dá pra seguir a si mesmo' });
  const u = await prisma.user.findUnique({ where: { id: target }, select: { id: true } });
  if (!u) return res.status(404).json({ error: 'atleta não encontrado' });
  await prisma.athleteFollow.upsert({
    where: { followerId_followeeId: { followerId: req.userId, followeeId: target } },
    create: { followerId: req.userId, followeeId: target }, update: {},
  });
  res.json({ ok: true, following: true });
}));
router.delete('/follow/:userId', wrap(async (req, res) => {
  await prisma.athleteFollow.deleteMany({ where: { followerId: req.userId, followeeId: String(req.params.userId) } });
  res.json({ ok: true, following: false });
}));

// ------------------------------------------------- admin: cashback por badge
router.get('/admin/rewards', adminMiddleware, wrap(async (_req, res) => {
  res.json({ config: await rewards.getConfig(), badges: rewards.BADGES, note: 'amountPerBadge=0 = cashback desligado' });
}));
router.put('/admin/rewards', adminMiddleware, wrap(async (req, res) => {
  try { res.json({ ok: true, config: await rewards.setConfig(req.body || {}, req.userId) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// ------------------------------------------------------- import arquivo
router.post('/import', (req, res, next) => upload.single('file')(req, res, (err) => {
  if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'arquivo maior que 25 MB' : err.message });
  next();
}), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'envie o arquivo no campo "file"' });
  const r = await ingest.importActivityFile(req.userId, req.file.buffer, req.file.originalname, {
    sportType: req.body?.sportType, title: req.body?.title, visibility: req.body?.visibility,
  });
  if (!r.ok) return fail(res, r);
  res.status(201).json(r);
}));

// ------------------------------------------------------------ CRUD
router.post('/', wrap(async (req, res) => {
  const body = { ...(req.body || {}) };
  delete body.userId; // o dono é o do token, sempre
  const r = await ingest.ingestActivity(req.userId, body);
  if (!r.ok) return fail(res, r);
  res.status(r.duplicate ? 200 : 201).json(r);
}));

// lista: minhas (padrão) ou de outro atleta (?userId=), só as que posso ver
router.get('/', wrap(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const owner = req.query.userId ? String(req.query.userId) : req.userId;
  const where = { userId: owner, processingState: 'done' };
  if (owner !== req.userId) {
    where.visibility = (await follows(req.userId, owner)) ? { in: ['public', 'followers'] } : 'public';
  }
  if (req.query.before) where.startedAt = { lt: new Date(req.query.before) };
  const list = await prisma.activity.findMany({ where, orderBy: { startedAt: 'desc' }, take: limit, select: LIST_SELECT });
  if (owner !== req.userId) {
    const zones = await zonesOf(owner);
    for (const a of list) a.summaryPolyline = publicPolyline(a, zones);
  }
  res.json({ activities: list });
}));

router.get('/:id', wrap(async (req, res) => {
  const act = await prisma.activity.findUnique({
    where: { id: req.params.id },
    include: { laps: true, photos: true, segmentEfforts: { include: { segment: { select: { id: true, name: true, distanceM: true } } }, orderBy: { startedAt: 'asc' } } },
  });
  if (!(await canView(act, req.userId))) return res.status(404).json({ error: 'não encontrada' });
  const isOwner = act.userId === req.userId;
  const points = geo.streamsToPoints(act.streams);
  const analysis = { splits: geo.splitsPerKm(points), chart: geo.chartSeries(points) };
  const { streams, clientId, ...rest } = act;
  const out = { ...rest, isOwner, analysis };
  // PR do atleta em cada segmento
  out.segmentEfforts = await Promise.all(act.segmentEfforts.filter((e) => !e.flaggedFraud).map(async (e) => {
    const best = await prisma.segmentEffort.findFirst({ where: { segmentId: e.segmentId, athleteId: act.userId, flaggedFraud: false }, orderBy: { elapsedMs: 'asc' }, select: { id: true } });
    return { id: e.id, segmentId: e.segmentId, segmentName: e.segment?.name, distanceM: e.segment?.distanceM, elapsedMs: e.elapsedMs, startedAt: e.startedAt, isPR: best?.id === e.id };
  }));
  if (isOwner) {
    // trilha reduzida com índice original → o dono escolhe início/fim do segmento
    const cum = geo.cumulative(points);
    const step = Math.max(1, Math.ceil(points.length / 1500));
    out.track = [];
    for (let i = 0; i < points.length; i += step) out.track.push([points[i].lat, points[i].lng, i, Math.round(cum[i])]);
    if (points.length && out.track[out.track.length - 1][2] !== points.length - 1) {
      const i = points.length - 1; out.track.push([points[i].lat, points[i].lng, i, Math.round(cum[i])]);
    }
  } else {
    out.summaryPolyline = publicPolyline(act, await zonesOf(act.userId));
    const u = await prisma.user.findUnique({ where: { id: act.userId }, select: { name: true, username: true } });
    out.athlete = { name: (u?.name || 'Atleta').split(' ').slice(0, 2).join(' '), username: u?.username || null };
    out.following = await follows(req.userId, act.userId);
  }
  res.json(out);
}));

router.patch('/:id', wrap(async (req, res) => {
  const act = await prisma.activity.findFirst({ where: { id: req.params.id, userId: req.userId } });
  if (!act) return res.status(404).json({ error: 'não encontrada' });
  const data = {};
  if (req.body?.title !== undefined) data.title = String(req.body.title).trim().slice(0, 120) || act.title;
  if (req.body?.description !== undefined) data.description = String(req.body.description).slice(0, 2000) || null;
  if (req.body?.visibility !== undefined) {
    if (!ingest.VISIBILITIES.has(req.body.visibility)) return res.status(400).json({ error: 'visibilidade inválida' });
    data.visibility = req.body.visibility;
  }
  const up = await prisma.activity.update({ where: { id: act.id }, data, select: LIST_SELECT });
  res.json({ ok: true, activity: up });
}));

router.delete('/:id', wrap(async (req, res) => {
  const r = await ingest.deleteActivity(req.userId, req.params.id);
  if (!r.ok) return fail(res, r);
  res.json(r);
}));

module.exports = router;
