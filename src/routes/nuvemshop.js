// =====================================================================
// Routes: /api/nuvemshop — OAuth + webhook + sync status
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const ns = require('../services/nuvemshop');

const router = express.Router();

// ROTAS ADMIN (protegidas)
const adminRouter = express.Router();
adminRouter.use(authMiddleware);
adminRouter.use(adminMiddleware);

adminRouter.get('/status', async (_req, res) => {
  try {
    const configured = ns.isConfigured();
    const connection = await prisma.nuvemshopConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    res.json({
      configured,
      connected: !!connection,
      connection: connection
        ? {
            id: connection.id,
            nuvemshopUserId: connection.nuvemshopUserId,
            scope: connection.scope,
            status: connection.status,
            createdAt: connection.createdAt,
          }
        : null,
      authUrl: configured ? ns.buildAuthUrl('teniscash-admin') : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao consultar Nuvemshop' });
  }
});

adminRouter.get('/sync-logs', async (_req, res) => {
  try {
    const logs = await prisma.nuvemshopSyncLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar logs' });
  }
});

adminRouter.get('/webhook-events', async (_req, res) => {
  try {
    const events = await prisma.nuvemshopWebhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({ events });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar eventos' });
  }
});

router.use('/admin/nuvemshop', adminRouter);

// OAUTH CALLBACK (público, sem auth — Nuvemshop bate aqui após login)
router.get('/nuvemshop/oauth/callback', async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) return res.status(400).send('Faltou ?code');
    const tokenData = await ns.exchangeCode(String(code));
    const userId = String(tokenData.user_id);

    const existing = await prisma.nuvemshopConnection.findUnique({ where: { nuvemshopUserId: userId } });
    if (existing) {
      await prisma.nuvemshopConnection.update({
        where: { id: existing.id },
        data: {
          accessToken: tokenData.access_token,
          scope: tokenData.scope,
          status: 'active',
        },
      });
    } else {
      await prisma.nuvemshopConnection.create({
        data: {
          nuvemshopUserId: userId,
          accessToken: tokenData.access_token,
          scope: tokenData.scope || null,
          status: 'active',
        },
      });
    }

    await prisma.nuvemshopSyncLog.create({
      data: { type: 'oauth', entity: 'connection', status: 'ok', message: `Conta ${userId} conectada` },
    });

    res.send(`
      <html><body style="font-family:sans-serif;padding:30px">
        <h1 style="color:#FF6D00">✓ Nuvemshop conectado!</h1>
        <p>Conta ${userId} vinculada ao TenisCash.</p>
        <p><a href="/admin.html">Voltar ao admin</a></p>
      </body></html>
    `);
  } catch (err) {
    console.error('[nuvemshop/oauth] erro:', err);
    res.status(500).send('Erro OAuth: ' + err.message);
  }
});

// WEBHOOK público — Nuvemshop bate aqui
router.post('/webhooks/nuvemshop', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const payload = req.body || {};
    const event = payload.event || req.headers['x-linkedstore-hmac-sha256'] ? payload.event : payload.event;
    const resourceId = payload.id || payload.order_id || payload.product_id || null;

    const stored = await prisma.nuvemshopWebhookEvent.create({
      data: {
        event: String(event || 'unknown'),
        nuvemshopResourceId: resourceId ? String(resourceId) : null,
        payload,
        processed: false,
      },
    });

    // Responde rápido (Nuvemshop espera 200 em <10s); processamento real é assíncrono
    res.status(200).json({ ok: true, id: stored.id });

    // Processamento simplificado em background (fire-and-forget)
    setImmediate(() => processWebhook(stored.id).catch((e) => console.error('[webhook process] erro:', e)));
  } catch (err) {
    console.error('[webhook] erro:', err);
    res.status(200).json({ ok: false, error: err.message });
  }
});

async function processWebhook(eventId) {
  const evt = await prisma.nuvemshopWebhookEvent.findUnique({ where: { id: eventId } });
  if (!evt || evt.processed) return;
  try {
    // TODO: implementar handlers por tipo (order/paid, product/updated, etc.)
    // Por enquanto só marca como processado e cria log
    await prisma.nuvemshopSyncLog.create({
      data: {
        type: 'webhook',
        entity: evt.event.split('/')[0] || 'unknown',
        status: 'ok',
        message: 'Webhook recebido (processamento detalhado pendente)',
        payload: evt.payload,
      },
    });
    await prisma.nuvemshopWebhookEvent.update({
      where: { id: eventId },
      data: { processed: true, processedAt: new Date() },
    });
  } catch (err) {
    await prisma.nuvemshopWebhookEvent.update({
      where: { id: eventId },
      data: { error: err.message },
    });
  }
}

module.exports = router;
