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

// JWT_SECRET assina TODOS os tokens de login (inclusive admin). Um segredo
// conhecido = qualquer um forja um token de admin e assume o sistema. Como este
// repo é PÚBLICO, um fallback hardcoded no código é o mesmo que não ter segredo.
// Regra: em produção (Railway) EXIGE um segredo forte e não-conhecido; sem ele,
// o app recusa subir (o healthcheck do Railway mantém a versão anterior no ar,
// então isso NÃO derruba a loja — só bloqueia deploy inseguro). Em dev, usa um
// segredo efêmero por processo e avisa.
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const WEAK_JWT_SECRETS = new Set([
  'teniscash-secret-change-in-production',
  'teniscash-prod-secret-trocar-agora',
]);
const JWT_SECRET = (() => {
  const s = process.env.JWT_SECRET;
  const strong = s && s.length >= 16 && !WEAK_JWT_SECRETS.has(s);
  if (strong) return s;
  if (IS_PROD) {
    console.error('FATAL[segurança]: JWT_SECRET ausente/fraco em produção. Com um segredo conhecido qualquer um forja token de admin. Defina JWT_SECRET (aleatório, ≥16 chars) nas variáveis do Railway. O app não sobe até isso — o healthcheck mantém a versão anterior no ar.');
    process.exit(1);
  }
  console.warn('[segurança] JWT_SECRET ausente/fraco — usando segredo EFÊMERO só de DEV (as sessões caem a cada restart). Defina JWT_SECRET no seu .env.');
  return 'dev-ephemeral-' + require('node:crypto').randomBytes(24).toString('hex');
})();

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
