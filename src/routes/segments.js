// =====================================================================
// Routes: /api/segments — APEX segmentos (ranking + Local Legend)
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const segments = require('../services/apexSegments');

const router = express.Router();
router.use(authMiddleware);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[segments]', e);
  res.status(e.status || 500).json({ error: e.message || 'erro interno' });
});

// cria a partir de um trecho de atividade do próprio atleta
router.post('/', wrap(async (req, res) => {
  const { activityId, startIdx, endIdx, name } = req.body || {};
  const r = await segments.createSegmentFromActivity(req.userId, String(activityId || ''), { name, startIdx, endIdx });
  if (!r.ok) return res.status(r.status || 400).json({ error: r.error, segmentId: r.segmentId });
  res.status(201).json(r);
}));

// lista (opcional: perto de lat/lng, por esporte, meus)
router.get('/', wrap(async (req, res) => {
  const where = { verificationState: { not: 'rejected' } };
  if (req.query.sport) where.sportType = String(req.query.sport);
  if (req.query.mine === '1') where.creatorId = req.userId;
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const d = Math.min(Number(req.query.radiusKm) || 10, 50) / 111;
    where.startLat = { gte: lat - d, lte: lat + d };
    where.startLng = { gte: lng - d, lte: lng + d };
  }
  const list = await prisma.segment.findMany({
    where, orderBy: { createdAt: 'desc' }, take: 100,
    select: { id: true, name: true, sportType: true, distanceM: true, elevationGainM: true, polyline: true, createdAt: true, creatorId: true, _count: { select: { efforts: true } } },
  });
  res.json({ segments: list });
}));

router.get('/:id', wrap(async (req, res) => {
  const seg = await prisma.segment.findUnique({ where: { id: req.params.id } });
  if (!seg || seg.verificationState === 'rejected') return res.status(404).json({ error: 'segmento não encontrado' });
  const period = req.query.period === 'month' ? 'month' : 'all';
  const sex = ['M', 'F'].includes(req.query.sex) ? req.query.sex : null;
  const [board, legend, mine] = await Promise.all([
    segments.leaderboard(seg.id, { period, sex }),
    segments.localLegend(seg.id),
    prisma.segmentEffort.findMany({ where: { segmentId: seg.id, athleteId: req.userId }, orderBy: { elapsedMs: 'asc' }, take: 20, select: { id: true, elapsedMs: true, startedAt: true, activityId: true, flaggedFraud: true } }),
  ]);
  const { geomHash, ...pub } = seg;
  res.json({ segment: { ...pub, isCreator: seg.creatorId === req.userId }, period, sex, leaderboard: board, localLegend: legend, myEfforts: mine });
}));

router.patch('/:id', wrap(async (req, res) => {
  const seg = await prisma.segment.findUnique({ where: { id: req.params.id } });
  if (!seg || seg.creatorId !== req.userId) return res.status(404).json({ error: 'segmento não encontrado' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (name.length < 3) return res.status(400).json({ error: 'nome inválido' });
  res.json({ ok: true, segment: await prisma.segment.update({ where: { id: seg.id }, data: { name } }) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const seg = await prisma.segment.findUnique({ where: { id: req.params.id } });
  if (!seg || seg.creatorId !== req.userId) return res.status(404).json({ error: 'segmento não encontrado' });
  await prisma.$transaction([
    prisma.segmentEffort.deleteMany({ where: { segmentId: seg.id } }),
    prisma.segment.delete({ where: { id: seg.id } }),
  ]);
  res.json({ ok: true });
}));

module.exports = router;
