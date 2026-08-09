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
// repo é PÚBLICO, o antigo fallback hardcoded era o mesmo que não ter segredo.
//
// SOLUÇÃO ZERO-TOQUE (não depende de setar env no Railway, NUNCA trava o boot):
//   1. Se JWT_SECRET (env) existe e é forte → usa (melhor prática).
//   2. Senão → gera um aleatório forte e PERSISTE no banco (tabela SystemSecret).
//      Fica estável entre restarts (sessões não caem), fora do repo, e ninguém
//      precisa mexer em nada. Resolvido no boot por ensureJwtSecret().
//   3. Se o banco falhar → efêmero por processo (avisa) — o app SEMPRE sobe.
const WEAK_JWT_SECRETS = new Set([
  'teniscash-secret-change-in-production',
  'teniscash-prod-secret-trocar-agora',
]);
function _envSecretOk(s) { return !!(s && s.length >= 16 && !WEAK_JWT_SECRETS.has(s)); }
let _jwtSecret = _envSecretOk(process.env.JWT_SECRET) ? process.env.JWT_SECRET : null;

// Chamado UMA vez no boot (index.js), antes de aceitar requisições.
async function ensureJwtSecret() {
  if (_jwtSecret) return _jwtSecret;
  try {
    const key = 'jwt_secret';
    let row = await prisma.systemSecret.findUnique({ where: { key } });
    if (!row) {
      const value = crypto.randomBytes(48).toString('base64url');
      row = await prisma.systemSecret.upsert({ where: { key }, update: {}, create: { key, value } });
    }
    _jwtSecret = row.value;
    console.log('[segurança] JWT_SECRET auto-gerido pelo banco (sem env, estável entre restarts).');
  } catch (e) {
    _jwtSecret = 'ephemeral-' + crypto.randomBytes(24).toString('hex');
    console.warn('[segurança] JWT do banco indisponível (' + e.message + ') — segredo efêmero por ora; o app subiu mesmo assim.');
  }
  return _jwtSecret;
}
function getJwtSecret() {
  return _jwtSecret || (_envSecretOk(process.env.JWT_SECRET) ? process.env.JWT_SECRET : 'boot-not-ready');
}

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
    const decoded = jwt.verify(token, getJwtSecret());
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

// JWT_SECRET export mantido por compatibilidade, mas prefira getJwtSecret()
// (o valor real pode ser resolvido do banco no boot). Consumidores que assinam/
// verificam token DEVEM usar getJwtSecret() no momento do uso.
module.exports = { authMiddleware, adminMiddleware, storeScope, enforceStoreId, getJwtSecret, ensureJwtSecret, prisma };
