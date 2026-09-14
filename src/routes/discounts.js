const express = require('express');
const { prisma, authMiddleware } = require('../middleware');
const { getRankingOwner } = require('../services/rankingOwner');
const { inspectDiscounts, disableDiscounts } = require('../services/disableDiscounts');

const router = express.Router();

async function ownerOnly(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  try {
    const owner = await getRankingOwner(prisma);
    if (!owner || owner.id !== req.userId) return res.status(403).json({ error: 'Somente o proprietário pode gerenciar os descontos.' });
    return next();
  } catch {
    return res.status(500).json({ error: 'Não foi possível verificar o proprietário.' });
  }
}

function operation(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Não foi possível concluir a operação de descontos.' });
    }
  };
}

router.get('/', authMiddleware, ownerOnly, operation(async (req, res) => {
  res.json(await inspectDiscounts(prisma, { ownerId: req.userId }));
}));

router.post('/', authMiddleware, ownerOnly, operation(async (req, res) => {
  res.json(await disableDiscounts(prisma, { ownerId: req.userId, reason: req.body?.reason }));
}));

router.get('/remote', authMiddleware, ownerOnly, operation(async (_req, res) => {
  const { inspectRemoteDiscounts } = require('../services/disableNuvemshopDiscounts');
  res.json(await inspectRemoteDiscounts(prisma));
}));

router.post('/remote', authMiddleware, ownerOnly, operation(async (req, res) => {
  const { startRemoteDiscountShutdown } = require('../services/disableNuvemshopDiscounts');
  res.status(202).json(await startRemoteDiscountShutdown(prisma, req.userId));
}));

router.get('/remote/status', authMiddleware, ownerOnly, operation(async (_req, res) => {
  const { getRemoteDiscountShutdownState } = require('../services/disableNuvemshopDiscounts');
  res.json(await getRemoteDiscountShutdownState());
}));

module.exports = router;
