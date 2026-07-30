const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const radio = require('../services/storeRadio');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

function storeIdFrom(req) {
  return req.params.storeId || req.query.storeId || req.body?.storeId || null;
}

router.get('/config', async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        radioConfig: true,
        _count: { select: { radioAnnouncements: true } },
      },
    });
    const counts = await prisma.radioAnnouncement.groupBy({ by: ['storeId', 'status'], _count: { _all: true } }).catch(() => []);
    const countMap = new Map();
    for (const row of counts) countMap.set(`${row.storeId || 'none'}:${row.status}`, row._count._all);
    res.json({
      ok: true,
      defaultTemplate: radio.DEFAULT_TEMPLATE,
      stores: stores.map((store) => ({
        ...store,
        queue: {
          queued: countMap.get(`${store.id}:QUEUED`) || 0,
          playing: countMap.get(`${store.id}:PLAYING`) || 0,
          played: countMap.get(`${store.id}:PLAYED`) || 0,
          failed: countMap.get(`${store.id}:FAILED`) || 0,
        },
      })),
    });
  } catch (error) {
    console.error('[store-radio] config:', error);
    res.status(500).json({ error: 'Não foi possível carregar a configuração da rádio.' });
  }
});

router.patch('/config/:storeId', async (req, res) => {
  try {
    const storeId = storeIdFrom(req);
    const store = await prisma.store.findUnique({ where: { id: String(storeId || '') }, select: { id: true, name: true } });
    if (!store) return res.status(404).json({ error: 'Loja não encontrada.' });
    const config = await radio.ensureConfig(store.id, {
      enabled: req.body?.enabled,
      volume: req.body?.volume,
      language: req.body?.language,
      voiceName: req.body?.voiceName,
      announcementTemplate: req.body?.announcementTemplate,
    });
    res.json({ ok: true, store, config });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Não foi possível salvar a rádio.' });
  }
});

router.post('/test', async (req, res) => {
  try {
    const announcement = await radio.queueTestAnnouncement({ storeId: req.body?.storeId, message: req.body?.message });
    res.json({ ok: true, announcement });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Não foi possível criar o teste.' });
  }
});

// O player da máquina da loja chama este endpoint a cada poucos segundos.
// A reivindicação atômica impede que duas abas reproduzam a mesma fala.
router.get('/next', async (req, res) => {
  try {
    const storeId = req.query.storeId ? String(req.query.storeId) : null;
    if (!storeId) return res.json({ ok: true, announcement: null, reason: 'store_required' });
    const config = await radio.getConfig(storeId);
    if (!config?.enabled) return res.json({ ok: true, announcement: null, enabled: false });
    const announcement = await radio.claimNext(storeId);
    res.json({ ok: true, enabled: true, config: { volume: config.volume, language: config.language, voiceName: config.voiceName }, announcement });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível consultar a fila.' });
  }
});

router.post('/:id/complete', async (req, res) => {
  try {
    const result = await radio.complete(req.params.id);
    res.json({ ok: true, updated: result.count > 0 });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível confirmar a reprodução.' });
  }
});

router.post('/:id/fail', async (req, res) => {
  try {
    const result = await radio.fail(req.params.id, req.body?.error);
    res.json({ ok: true, updated: result.count > 0 });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível registrar a falha.' });
  }
});

router.get('/history', async (req, res) => {
  try {
    const storeId = req.query.storeId ? String(req.query.storeId) : undefined;
    const rows = await prisma.radioAnnouncement.findMany({
      where: storeId ? { storeId } : {},
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(Number(req.query.limit || 30), 1), 100),
      select: { id: true, source: true, message: true, status: true, attempts: true, error: true, createdAt: true, playedAt: true, saleId: true },
    });
    res.json({ ok: true, announcements: rows });
  } catch (error) {
    res.status(500).json({ error: 'Não foi possível carregar o histórico.' });
  }
});

module.exports = router;
