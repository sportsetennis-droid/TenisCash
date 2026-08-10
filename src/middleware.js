const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { allocateInternalBarcode } = require('./services/internalBarcode');
const prisma = new PrismaClient();

// Todo produto criado pelo fluxo principal já nasce com o código interno.
// O preenchimento continua sendo idempotente no seed/etiquetas para cobrir
// produtos antigos e importações feitas por clientes Prisma independentes.
prisma.$use(async (params, next) => {
  if (params.model === 'Product' && ['create', 'upsert', 'createMany'].includes(params.action)) {
    const rows = params.action === 'upsert' ? [params.args.create] : (Array.isArray(params.args.data) ? params.args.data : [params.args.data]);
    for (const row of rows) {
      if (!row || row.internalBarcode) continue;
      if (!row.id) row.id = crypto.randomUUID();
      row.internalBarcode = await allocateInternalBarcode(prisma, row.id);
    }
  }
  return next(params);
});

const JWT_SECRET = process.env.JWT_SECRET || 'teniscash-secret-change-in-production';

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  // Token vem do header Authorization OU do query param ?token= (pra links abertos
  // em nova aba — DANFE/impressão; o navegador/impressora não manda header nesses casos).
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = String(req.query.token);
  }
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

// =====================================================================
// Isolamento por loja: garante que conta institucional (role=store) ou
// vendedor (role=seller) so' acesse dados da PRÓPRIA loja. Admin e
// superadmin passam livre. Carrega o operator do banco e expoe
// req.scope = { storeId, isStoreLocked, isSellerLocked }
// =====================================================================
async function storeScope(req, _res, next) {
  if (!req.userId) return next();
  try {
    const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, role: true, storeId: true } });
    req.operator = u;
    req.scope = {
      storeId: u?.storeId || null,
      isStoreLocked: u?.role === 'store',
      isSellerLocked: u?.role === 'seller',
      isAdmin: u?.role === 'admin' || u?.role === 'superadmin' || u?.role === 'manager',
      isManager: u?.role === 'manager',
    };
  } catch (_) {
    req.scope = { storeId: null, isStoreLocked: false, isSellerLocked: false, isAdmin: false };
  }
  next();
}

// Helper pra forçar storeId quando role=store
function enforceStoreId(req, requestedStoreId) {
  if (req.scope?.isStoreLocked) return req.scope.storeId;
  return requestedStoreId || null;
}

module.exports = { authMiddleware, adminMiddleware, storeScope, enforceStoreId, JWT_SECRET, prisma };
