// =====================================================================
// Routes: /api/coach — APEX COACH (coach IA do app esportivo)
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../../../middleware');
const coach = require('../../../services/aiCoach');

const router = express.Router();
router.use(authMiddleware);

router.get('/status', (_req, res) => {
  res.json({ configured: coach.isConfigured() });
});

// POST /api/coach/briefing — briefing diário
router.post('/briefing', async (req, res) => {
  try {
    const r = await coach.dailyBriefing(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coach/post-workout — análise pós-treino
router.post('/post-workout', async (req, res) => {
  try {
    const r = await coach.postWorkoutAnalysis(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/coach/chat — chat conversacional
router.post('/chat', async (req, res) => {
  try {
    const r = await coach.chat(req.body || {});
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
