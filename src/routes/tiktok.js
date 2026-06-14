// =====================================================================
// Routes: /api/tiktok — OAuth + status + push de produtos pro TikTok Shop
// =====================================================================
// Espelha src/routes/nuvemshop.js. Tudo guardado por tt.isConfigured():
// sem as env vars (TIKTOK_SHOP_APP_KEY/SECRET/REDIRECT_URI), as rotas
// respondem "não configurado" e NADA roda — não quebra o boot nem o app.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const tt = require('../services/tiktokShop');
const sync = require('../services/tiktokShopSync');

const router = express.Router();

// ROTAS ADMIN (protegidas)
const adminRouter = express.Router();
adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

adminRouter.get('/status', async (_req, res) => {
  try {
    const configured = tt.isConfigured();
    const connection = await prisma.tikTokShopConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    res.json({
      configured,
      connected: !!connection,
      connection: connection
        ? {
            id: connection.id,
            shopId: connection.shopId,
            sellerName: connection.sellerName,
            region: connection.region,
            status: connection.status,
            hasShopCipher: !!connection.shopCipher,
            accessExpireAt: connection.accessExpireAt,
            createdAt: connection.createdAt,
          }
        : null,
      authUrl: configured ? tt.buildAuthUrl('teniscash-admin') : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar TikTok Shop: ' + err.message });
  }
});

// Push de UM produto (teste/manual)
adminRouter.post('/push/:productId', async (req, res) => {
  try {
    const connection = await sync.getConnection();
    if (!connection) return res.status(400).json({ error: 'Sem conexão TikTok Shop ativa' });
    const result = await sync.pushProductToTikTok(req.params.productId, connection);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Push em lote
adminRouter.post('/push-all', async (req, res) => {
  try {
    const { onlyMissing = true, limit = 500 } = req.body || {};
    const result = await sync.pushAllToTikTok({ onlyMissing, limit });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.use('/admin/tiktok', adminRouter);

// OAUTH CALLBACK (público — TikTok redireciona aqui após o seller autorizar)
router.get('/tiktok/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code || req.query.auth_code;
    if (!code) return res.status(400).send('Faltou ?code');

    const tokenData = await tt.exchangeCode(String(code));
    const now = Date.now();
    const accessExpireAt = tokenData.access_token_expire_in
      ? new Date(now + Number(tokenData.access_token_expire_in) * 1000) : null;
    const refreshExpireAt = tokenData.refresh_token_expire_in
      ? new Date(now + Number(tokenData.refresh_token_expire_in) * 1000) : null;

    // Descobre a(s) loja(s) autorizada(s) pra pegar shop_cipher
    let shop = null;
    try {
      const shops = await tt.getAuthorizedShops({ accessToken: tokenData.access_token });
      shop = shops[0] || null;
    } catch (e) {
      console.warn('[tiktok/oauth] getAuthorizedShops falhou:', e.message);
    }

    const data = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      accessExpireAt,
      refreshExpireAt,
      scope: tokenData.granted_scopes ? JSON.stringify(tokenData.granted_scopes) : null,
      status: 'active',
      shopId: shop?.id ? String(shop.id) : null,
      shopCipher: shop?.cipher || null,
      sellerName: shop?.name || null,
      region: shop?.region || null,
    };

    const existing = shop?.id
      ? await prisma.tikTokShopConnection.findUnique({ where: { shopId: String(shop.id) } })
      : await prisma.tikTokShopConnection.findFirst({ where: { status: 'active' } });

    if (existing) {
      await prisma.tikTokShopConnection.update({ where: { id: existing.id }, data });
    } else {
      await prisma.tikTokShopConnection.create({ data });
    }

    res.send(`
      <html><body style="font-family:sans-serif;padding:30px">
        <h1 style="color:#E5571E">✓ TikTok Shop conectado!</h1>
        <p>Loja ${shop?.name || shop?.id || '(verifique o cipher)'} vinculada ao TenisCash.</p>
        ${shop?.cipher ? '' : '<p style="color:#c00">⚠️ Não consegui pegar o shop_cipher — confira as permissões do app.</p>'}
        <p><a href="/admin.html">Voltar ao admin</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('[tiktok/oauth] erro:', err);
    res.status(500).send('Erro OAuth TikTok: ' + err.message);
  }
});

module.exports = router;
