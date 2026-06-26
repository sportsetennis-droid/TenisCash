const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware');
const { getHotLeads } = require('../services/aiAttendant');

const router = express.Router();

// GET /api/admin/leads/hot?minScore=3
// Retorna leads ativos da janela de conversa (30min) com intenção >= minScore
router.get('/hot', authMiddleware, adminMiddleware, (req, res) => {
  const minScore = parseInt(req.query.minScore) || 3;
  const leads = getHotLeads(minScore);
  res.json({ leads, total: leads.length, minScore });
});

module.exports = router;
