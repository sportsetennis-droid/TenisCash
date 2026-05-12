// =====================================================================
// Routes: /api/admin/recommendations — AiRecommendation por regras
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { runAllRules } = require('../services/recommendationEngine');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.post('/run', async (_req, res) => {
  try {
    const result = await runAllRules();
    res.json(result);
  } catch (err) {
    console.error('[recommendations/run] erro:', err);
    res.status(500).json({ error: 'Erro ao rodar motor de regras', detail: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status, type, priority } = req.query;
    const where = {
      ...(status ? { status } : { status: { in: ['OPEN', 'IN_REVIEW'] } }),
      ...(type ? { type } : {}),
      ...(priority ? { priority } : {}),
    };
    const list = await prisma.aiRecommendation.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    res.json({ recommendations: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar recomendações' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.status === 'RESOLVED') data.resolvedAt = new Date();
    const rec = await prisma.aiRecommendation.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ recommendation: rec });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar recomendação' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.aiRecommendation.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

module.exports = router;
