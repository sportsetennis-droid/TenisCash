// Rotas do painel "Classificação de Card" (orquestrador de agentes).
// Tudo admin. Painel ao vivo consome /status (estado + contadores) e /events (log incremental).
const express = require('express');
const router = express.Router();
const { authMiddleware, adminMiddleware } = require('../middleware');
const orch = require('../services/classificationOrchestrator');

router.use(authMiddleware, adminMiddleware);

router.get('/brands', async (req, res) => {
  try { res.json({ brands: await orch.listBrands() }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/start', async (req, res) => {
  try { const { brand } = req.body || {}; res.json(await orch.start(brand || null)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/pause', (req, res) => { try { res.json(orch.pause()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/resume', (req, res) => { try { res.json(orch.resume()); } catch (e) { res.status(500).json({ error: e.message }); } });
router.post('/stop', async (req, res) => { try { res.json(await orch.stop()); } catch (e) { res.status(500).json({ error: e.message }); } });

router.get('/status', async (req, res) => {
  try { res.json(await orch.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/events', async (req, res) => {
  try { res.json({ events: await orch.events(req.query.since || null) }); } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
