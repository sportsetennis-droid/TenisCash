// =====================================================================
// Routes: /api/measurement — Body scan + size recommendation
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');
const bodyMeasurement = require('../services/bodyMeasurement');
const sizeRec = require('../services/sizeRecommendation');

const prisma = new PrismaClient();
const router = express.Router();

// POST /api/measurement/scan — processa keypoints e cria BodyScan
router.post('/scan', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const payload = { ...req.body, userId };
    const r = await bodyMeasurement.processBodyScan(payload);
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json(r);
  } catch (err) {
    console.error('[measurement/scan]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/measurement/me — último scan do usuário autenticado
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });
    const r = await bodyMeasurement.getLatestScan(userId);
    if (!r.ok) return res.status(404).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/measurement/scans — lista histórico de scans
router.get('/scans', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const scans = await prisma.bodyScan.findMany({
      where: { userId },
      orderBy: { capturedAt: 'desc' },
      take: 20,
      select: {
        id: true, capturedAt: true, heightCm: true, weightKg: true,
        confidence: true, source: true,
        measurements: { select: { measureType: true, valueCm: true } },
      },
    });
    res.json({ scans });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/measurement/recommend?productId=X[&scanId=Y][&fitProfile=regular]
router.get('/recommend', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const { productId, fitProfile } = req.query;
    let { scanId } = req.query;
    if (!productId) return res.status(400).json({ error: 'productId obrigatório' });

    if (!scanId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { lastScanId: true },
      });
      scanId = user?.lastScanId;
    }

    if (!scanId) {
      return res.status(404).json({
        ok: false,
        error: 'usuário ainda não fez body scan',
        needsScan: true,
      });
    }

    // Confirma que o scan pertence ao usuário
    const scan = await prisma.bodyScan.findFirst({
      where: { id: scanId, userId },
      select: { id: true },
    });
    if (!scan) return res.status(403).json({ error: 'scan não pertence ao usuário' });

    const r = await sizeRec.recommendSize({
      scanId,
      productId,
      fitProfile: fitProfile || 'regular',
    });
    if (!r.ok) return res.status(r.needsSizeChart ? 404 : 400).json(r);
    res.json(r);
  } catch (err) {
    console.error('[measurement/recommend]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/measurement/feedback — cliente reporta como vestiu
// Body: { recommendationId, actualBoughtSize?, fitFeedback: "perfect"|"tight"|"loose"|"returned" }
router.post('/feedback', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const { recommendationId, actualBoughtSize, fitFeedback } = req.body || {};
    if (!recommendationId) return res.status(400).json({ error: 'recommendationId obrigatório' });

    // Confirma ownership
    const rec = await prisma.sizeRecommendation.findFirst({
      where: { id: recommendationId, userId },
      select: { id: true },
    });
    if (!rec) return res.status(403).json({ error: 'recomendação não pertence ao usuário' });

    const r = await sizeRec.recordFeedback({ recommendationId, actualBoughtSize, fitFeedback });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/measurement/scan/:id — usuário deleta scan (LGPD)
router.delete('/scan/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const scan = await prisma.bodyScan.findFirst({
      where: { id: req.params.id, userId },
      select: { id: true },
    });
    if (!scan) return res.status(404).json({ error: 'scan não encontrado' });

    await prisma.bodyScan.delete({ where: { id: scan.id } });
    // Limpa cache no User se era o último
    await prisma.user.updateMany({
      where: { id: userId, lastScanId: scan.id },
      data: { lastScanId: null, lastScanAt: null },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
