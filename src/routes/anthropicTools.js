// =====================================================================
// Routes: /api/admin/anthropic-tools — diagnóstico e ações das novas
// capacidades (Batch, Files, Computer Use, Slack).
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const visionBatch = require('../services/visionBatchValidator');
const files = require('../services/anthropicFiles');
const computer = require('../services/computerUse');
const slack = require('../services/slackNotifier');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// ============ DIAGNOSE ============
router.get('/status', (_req, res) => {
  res.json({
    visionBatch: visionBatch.isConfigured(),
    filesApi: files.isConfigured(),
    computerUse: computer.isConfigured(),
    slack: slack.isConfigured(),
  });
});

// ============ BATCH ============
// Submete um batch de pontuação de imagens. Retorna batchId.
router.post('/batch/submit', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items vazio' });
    const r = await visionBatch.submitBatch(items);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/batch/:id/status', async (req, res) => {
  const r = await visionBatch.getBatchStatus(req.params.id);
  res.json(r);
});

router.get('/batch/:id/results', async (req, res) => {
  const r = await visionBatch.fetchBatchResults(req.params.id);
  res.json(r);
});

router.post('/batch/:id/cancel', async (req, res) => {
  const r = await visionBatch.cancelBatch(req.params.id);
  res.json(r);
});

// ============ FILES ============
router.get('/files', async (_req, res) => {
  const r = await files.listFiles();
  res.json(r);
});

router.post('/files/chat', async (req, res) => {
  try {
    const { fileId, prompt } = req.body || {};
    if (!fileId || !prompt) return res.status(400).json({ error: 'fileId e prompt obrigatórios' });
    const r = await files.chatWithFile(fileId, prompt);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/files/:id', async (req, res) => {
  const r = await files.deleteFile(req.params.id);
  res.json(r);
});

// ============ SLACK ============
router.post('/slack/test', async (_req, res) => {
  const r = await slack.send('🎾 Teste do TenisCash — Slack conectado!', { iconEmoji: ':tennis:', username: 'TenisCash' });
  res.json(r);
});

router.post('/slack/notify', async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text obrigatório' });
  const r = await slack.send(text);
  res.json(r);
});

module.exports = router;
