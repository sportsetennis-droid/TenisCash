// =====================================================================
// Routes: /api/activities — APEX SPORT (app esportivo unificado)
// =====================================================================
// Ingestão de atividades vindas do app mobile (iOS / Android / Wear).
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../middleware');
const ingest = require('../services/activityIngest');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const router = express.Router();

// POST /api/activities — registra atividade do app (autenticado)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id || req.body?.userId;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const payload = { ...req.body, userId };
    const streams = req.body?.streams || {};
    const r = await ingest.ingestActivity(payload, streams);
    if (!r.ok) return res.status(400).json(r);
    res.status(201).json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activities — lista atividades do usuário autenticado
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'não autenticado' });

    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const list = await prisma.activity.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      select: {
        id: true, sportType: true, startedAt: true, elapsedTimeS: true,
        movingTimeS: true, distanceM: true, avgHeartRate: true, avgPace: true,
        elevationGainM: true, calories: true, summaryPolyline: true,
        visibility: true, processingState: true,
      },
    });
    res.json({ activities: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/activities/:id — detalhe
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const userId = req.user?.id;
    const activity = await prisma.activity.findFirst({
      where: { id: req.params.id, userId },
      include: { laps: true, photos: true },
    });
    if (!activity) return res.status(404).json({ error: 'não encontrada' });
    res.json(activity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
