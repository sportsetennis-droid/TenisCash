const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

// LISTAR PROMOS ATIVAS
router.get('/', authMiddleware, async (req, res) => {
  try {
    const promos = await prisma.promo.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const formatted = promos.map(p => ({
      id: p.id,
      title: p.title,
      description: p.description,
      percentage: p.percentage,
      scope: p.scope,
      scopeValue: p.scopeValue,
      active: p.active && (!p.endsAt || new Date(p.endsAt) > now),
      endsAt: p.endsAt,
    }));

    res.json({ promos: formatted });
  } catch (err) {
    console.error('Erro ao buscar promos:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// REGRAS DE ABATIMENTO POR MARCA
router.get('/brands', authMiddleware, async (req, res) => {
  try {
    const rules = await prisma.brandRule.findMany({
      where: { active: true },
      orderBy: { brand: 'asc' },
    });

    res.json({ brands: rules });
  } catch (err) {
    console.error('Erro ao buscar regras:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
