const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { allocateInternalBarcode } = require('./services/internalBarcode');
const { isAdminRole, isDesignRole, isDesignRequestAllowed } = require('./services/designAccess');
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

const verifiedIdentity = Symbol('verifiedIdentity');

function requestToken(req) {
  const authHeader = req.headers.authorization;
  // Token vem do header Authorization OU do query param ?token= (pra links abertos
  // em nova aba — DANFE/impressão; o navegador/impressora não manda header nesses casos).
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = String(req.query.token);
  }
  return token;
}

// Some public/optional-auth routers historically decoded JWT claims themselves.
// Run before /api routers so an old admin token cannot bypass Design isolation.
// Non-JWT integration/webhook tokens remain the responsibility of their routes.
function designIsolationMiddleware(req, res, next) {
  const token = requestToken(req);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded?.userId !== 'string' || !decoded.userId.trim()) return next();
  } catch (_) {
    return next();
  }
  return authMiddleware(req, res, next);
}

async function authMiddleware(req, res, next) {
  const token = requestToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }

  let identity = req[verifiedIdentity];
  if (!identity || identity.token !== token) {
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      if (typeof decoded?.userId !== 'string' || !decoded.userId.trim()) throw new Error('identity');
    } catch (_) {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    let user;
    try {
      // The database is authoritative. A demotion or deactivation takes effect
      // on the next request even if the client still has a 30-day admin JWT.
      user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, role: true, active: true, storeId: true, storeIds: true },
      });
    } catch (_) {
      return res.status(503).json({ error: 'Não foi possível validar o acesso. Tente novamente.' });
    }
    if (!user || user.active !== true) {
      return res.status(401).json({ error: 'Conta inativa ou indisponível' });
    }
    identity = { token, user };
    // Reused only within this request: /api/admin and the product router both
    // authenticate. There is deliberately no cross-request role cache.
    req[verifiedIdentity] = identity;
  }
  req.userId = identity.user.id;
  req.userRole = identity.user.role;
  req.authUser = identity.user;
  if (isDesignRole(req.userRole) && !isDesignRequestAllowed(req)) {
    return res.status(403).json({ error: 'Este perfil tem acesso somente aos módulos de produtos autorizados' });
  }
  return next();
}

function adminMiddleware(req, res, next) {
  if (!isAdminRole(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

function productAdminMiddleware(req, res, next) {
  if (isAdminRole(req.userRole) || isDesignRequestAllowed(req)) return next();
  return res.status(403).json({ error: 'Acesso restrito à administração de produtos' });
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

module.exports = { authMiddleware, designIsolationMiddleware, adminMiddleware, productAdminMiddleware, storeScope, enforceStoreId, JWT_SECRET, prisma };
