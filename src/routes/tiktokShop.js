// =====================================================================
// Routes: /api/tiktok-shop — OAuth + push de catálogo + status
// =====================================================================
// Espelha src/routes/nuvemshop.js. Admin sob /api/admin/tiktok-shop
// (auth+admin). OAuth callback público (o TikTok bate sem header).
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const tk = require('../services/tiktokShop');
const handlers = require('../services/tiktokShopHandlers');

const router = express.Router();

// ---------- ADMIN (protegido) ----------
const adminRouter = express.Router();
adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

adminRouter.get('/status', async (_req, res) => {
  try {
    const connection = await prisma.tiktokShopConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    res.json({
      configured: tk.isConfigured(),
      connected: !!(connection && connection.status === 'active'),
      connection: connection ? {
        id: connection.id,
        shopId: connection.shopId,
        shopName: connection.shopName,
        region: connection.region,
        sellerName: connection.sellerName,
        status: connection.status,
        accessTokenExpireAt: connection.accessTokenExpireAt,
        createdAt: connection.createdAt,
      } : null,
      authUrl: tk.isConfigured() ? tk.buildAuthUrl('teniscash-admin') : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/sync-logs', async (_req, res) => {
  try {
    const logs = await prisma.tiktokShopSyncLog.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/authorized-shops', async (_req, res) => {
  try {
    const connection = await prisma.tiktokShopConnection.findFirst({ where: { status: 'active' } });
    if (!connection) return res.status(400).json({ error: 'Sem conexão TikTok Shop ativa' });
    const shops = await tk.getAuthorizedShops(connection.accessToken);
    res.json(shops);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/warehouses', async (_req, res) => {
  try {
    const connection = await handlers.getConnection();
    if (!connection) return res.status(400).json({ error: 'Sem conexão TikTok Shop ativa' });
    const wh = await tk.getWarehouses(connection);
    res.json(wh);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve category_id do TikTok pros produtos (rodar ANTES do push)
adminRouter.post('/recommend-categories', async (req, res) => {
  try {
    const { limit, force } = req.body || {};
    const result = await handlers.recommendCategoriesForProducts({
      limit: limit ? parseInt(limit, 10) : 200,
      force: !!force,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUSH em massa: TenisCash → TikTok Shop
adminRouter.post('/push/products', async (req, res) => {
  try {
    const { onlyMissing, limit, withImageOnly, saveMode } = req.body || {};
    const result = await handlers.pushAllProducts({
      onlyMissing: onlyMissing !== false,
      limit: limit ? parseInt(limit, 10) : 1000,
      withImageOnly: withImageOnly !== false,
      saveMode: saveMode || undefined, // AS_DRAFT (default) | LISTING
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/push/products/:id', async (req, res) => {
  try {
    const connection = await handlers.getConnection();
    if (!connection) return res.status(400).json({ error: 'Sem conexão TikTok Shop ativa' });
    const result = await handlers.pushProductToTiktok(req.params.id, connection, {
      saveMode: req.body?.saveMode || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/push/stock/:id', async (req, res) => {
  try {
    const result = await handlers.pushStockAndPrice(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/mappings/products', async (_req, res) => {
  try {
    const list = await prisma.tiktokShopProductMapping.findMany({ orderBy: { lastSyncedAt: 'desc' }, take: 100 });
    res.json({ mappings: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use('/admin/tiktok-shop', adminRouter);

// ---------- OAUTH (público) ----------

// Conveniência: manda o admin direto pro portal de autorização do TikTok
router.get('/tiktok-shop/connect', (_req, res) => {
  const url = tk.buildAuthUrl('teniscash-admin');
  if (!url) return res.status(400).send('TikTok Shop não configurado (falta TIKTOK_SHOP_SERVICE_ID)');
  res.redirect(url);
});

// Callback: o TikTok volta aqui com ?code=AUTH_CODE após o seller aprovar.
router.get('/tiktok-shop/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code ? String(req.query.code) : null;
    if (!code) return res.status(400).send('Faltou ?code');

    const token = await tk.exchangeCode(code);
    const shopsResp = await tk.getAuthorizedShops(token.access_token);
    const shops = (shopsResp && Array.isArray(shopsResp.shops)) ? shopsResp.shops : [];
    if (!shops.length) return res.status(400).send('Token OK mas nenhuma loja autorizada retornada.');

    const accessExpire = token.access_token_expire_in ? new Date(Number(token.access_token_expire_in) * 1000) : null;
    const refreshExpire = token.refresh_token_expire_in ? new Date(Number(token.refresh_token_expire_in) * 1000) : null;

    for (const shop of shops) {
      const data = {
        shopCipher: shop.cipher || null,
        shopName: shop.name || null,
        region: shop.region || null,
        sellerName: token.seller_name || null,
        openId: token.open_id || null,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessTokenExpireAt: accessExpire,
        refreshTokenExpireAt: refreshExpire,
        scope: token.granted_scopes ? JSON.stringify(token.granted_scopes) : null,
        status: 'active',
      };
      const existing = await prisma.tiktokShopConnection.findUnique({ where: { shopId: String(shop.id) } });
      if (existing) {
        await prisma.tiktokShopConnection.update({ where: { id: existing.id }, data });
      } else {
        await prisma.tiktokShopConnection.create({ data: { shopId: String(shop.id), ...data } });
      }
    }

    await prisma.tiktokShopSyncLog.create({
      data: { type: 'oauth', entity: 'connection', status: 'ok', message: `Conectado: ${shops.map((s) => s.name).join(', ')}` },
    });

    res.send(`
      <html><body style="font-family:sans-serif;padding:30px">
        <h1 style="color:#000">✓ TikTok Shop conectado!</h1>
        <p>Loja(s): ${shops.map((s) => `${s.name} (${s.region})`).join(', ')}</p>
        <p>Agora rode <code>recommend-categories</code> e depois <code>push/products</code>.</p>
        <p><a href="/admin.html">Voltar ao admin</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('[tiktok/oauth] erro:', err);
    res.status(500).send('Erro OAuth TikTok: ' + err.message);
  }
});

module.exports = router;
