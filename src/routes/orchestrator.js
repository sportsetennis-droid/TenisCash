// =====================================================================
// Routes: /api/admin/orchestrator — Central IA Sports & Tennis
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware');
const retail = require('../services/retailOrchestrator');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/status', (_req, res) => {
  res.json({ configured: retail.isConfigured() });
});

// Recebe demanda → devolve plano operacional
router.post('/demand', async (req, res) => {
  try {
    const { demand } = req.body || {};
    if (!demand) return res.status(400).json({ error: 'demand é obrigatório' });
    const r = await retail.orchestrate(demand, { includeContext: true });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
