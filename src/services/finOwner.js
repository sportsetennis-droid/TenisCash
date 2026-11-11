'use strict';

// Só o DONO (titular registrado em Config, ver rankingOwner.js) libera pagamento.
// Nunca deduzir o dono pelo papel: contas de automação também são superadmin.

const { getRankingOwner } = require('./rankingOwner');

async function isFinOwner(prisma, req) {
  if (!req || req.userRole !== 'superadmin' || !req.userId) return false;
  const owner = await getRankingOwner(prisma);
  return !!owner && owner.id === req.userId;
}

function requireFinOwner(prisma) {
  return async function finOwnerOnly(req, res, next) {
    try {
      if (await isFinOwner(prisma, req)) return next();
      return res.status(403).json({ error: 'Somente o dono pode fazer esta operação' });
    } catch (_) {
      return res.status(503).json({ error: 'Não foi possível validar o dono' });
    }
  };
}

module.exports = { isFinOwner, requireFinOwner };
