// Busca de produto para vendedor/loja/admin.
//   GET /api/search/products?q=asics nimbu   → tolerante a erro (pg_trgm) ou LIKE
//   GET /api/search/catalog-snapshot         → catálogo compacto p/ busca offline (ETag)
// Só leitura. Estoque = físico localizado (Σ StoreStock). Sem custo.
const express = require('express');
const crypto = require('crypto');
const { authMiddleware, prisma } = require('../middleware');
const { searchProducts, buildCatalogSnapshot } = require('../services/productSearch');

const router = express.Router();
const STAFF_ROLES = new Set(['seller', 'store', 'admin', 'superadmin', 'manager']);

function requireStaff(req, res, next) {
  if (!STAFF_ROLES.has(req.userRole)) return res.status(403).json({ error: 'Acesso restrito à equipe da loja.' });
  next();
}

router.use(authMiddleware, requireStaff);

router.get('/products', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const q = String(req.query.q || '');
    const result = await searchProducts(prisma, q, { limit: req.query.limit });
    res.json({ q: q.trim(), mode: result.mode, total: result.products.length, products: result.products });
  } catch (e) {
    console.error('[search/products]', e.message);
    res.status(500).json({ error: 'Não foi possível buscar agora.' });
  }
});

// O snapshot é igual pra toda a equipe; monta 1x a cada 60s no máximo.
let snapshotCache = null; // { at, etag, body }
const SNAPSHOT_TTL_MS = 60 * 1000;

async function currentSnapshot() {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.at < SNAPSHOT_TTL_MS) return snapshotCache;
  const data = await buildCatalogSnapshot(prisma);
  const productsJson = JSON.stringify(data);
  // ETag pelo CONTEÚDO (não pelo horário): catálogo igual = mesmo ETag = 304.
  const etag = '"cat1-' + crypto.createHash('sha1').update(productsJson).digest('base64url') + '"';
  const body = JSON.stringify({ ...data, generatedAt: new Date().toISOString(), etag });
  snapshotCache = { at: now, etag, body, count: data.products.length };
  return snapshotCache;
}

router.get('/catalog-snapshot', async (req, res) => {
  try {
    const snap = await currentSnapshot();
    res.set('ETag', snap.etag);
    res.set('Cache-Control', 'private, no-cache');
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(snap.etag)) {
      return res.status(304).end();
    }
    res.type('application/json').send(snap.body);
  } catch (e) {
    console.error('[search/catalog-snapshot]', e.message);
    res.status(500).json({ error: 'Não foi possível montar o catálogo offline.' });
  }
});

router._resetSnapshotCache = () => { snapshotCache = null; };

module.exports = router;
