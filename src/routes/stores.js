const express = require('express');
const { prisma } = require('../middleware');

const router = express.Router();

// Lista lojas ativas (usado no admin e vendedor)
router.get('/', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, code: true, name: true, dna: true, mall: true, city: true, state: true },
      orderBy: { code: 'asc' },
    });
    res.json({ stores });
  } catch (err) {
    console.error('Erro ao listar lojas:', err);
    res.status(500).json({ error: 'Erro ao listar lojas' });
  }
});

module.exports = router;

