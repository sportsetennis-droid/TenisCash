// =====================================================================
// /api/marketing-config — endpoints CRUD pras configs editáveis IA
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const cfg = require('../services/marketingConfig');

const router = express.Router();
router.use(authMiddleware);

function requireAdmin(req, res, next) {
  prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } })
    .then((u) => {
      if (!u || !['admin', 'superadmin', 'manager'].includes(u.role)) {
        return res.status(403).json({ error: 'apenas admin' });
      }
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}
router.use(requireAdmin);

// ============== BRAND SCENES ==============
router.get('/brand-scenes', async (_req, res) => {
  try {
    const current = await cfg.getBrandScenes();
    res.json({ value: current, default: cfg.DEFAULT_BRAND_SCENES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/brand-scenes', async (req, res) => {
  try {
    const v = req.body?.value;
    if (!v || typeof v !== 'object') return res.status(400).json({ error: 'value obrigatório (objeto marca→cenário)' });
    const saved = await cfg.setBrandScenes(v);
    res.json({ value: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============== MODALITY SCENES ==============
router.get('/modality-scenes', async (_req, res) => {
  try {
    const current = await cfg.getModalityScenes();
    res.json({ value: current, default: cfg.DEFAULT_MODALITY_SCENES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/modality-scenes', async (req, res) => {
  try {
    const v = req.body?.value;
    if (!v || typeof v !== 'object') return res.status(400).json({ error: 'value obrigatório' });
    const saved = await cfg.setModalityScenes(v);
    res.json({ value: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============== SCENE HINTS (variações automáticas) ==============
router.get('/scene-hints', async (_req, res) => {
  try {
    const current = await cfg.getSceneHints();
    res.json({ value: current, default: cfg.DEFAULT_SCENE_HINTS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/scene-hints', async (req, res) => {
  try {
    const v = req.body?.value;
    if (!Array.isArray(v)) return res.status(400).json({ error: 'value obrigatório (array de strings)' });
    const saved = await cfg.setSceneHints(v);
    res.json({ value: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============== PROVIDER PROMPTS ==============
router.get('/provider-prompts', async (_req, res) => {
  try {
    const current = await cfg.getProviderPrompts();
    res.json({ value: current, default: cfg.DEFAULT_PROVIDER_PROMPTS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/provider-prompts', async (req, res) => {
  try {
    const v = req.body?.value;
    if (!v || typeof v !== 'object') return res.status(400).json({ error: 'value obrigatório' });
    const saved = await cfg.setProviderPrompts(v);
    res.json({ value: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============== PERSONA BR + BRAND VOICE ==============
router.get('/persona-br', async (_req, res) => {
  res.json({ value: await cfg.getPersonaBr(), default: cfg.DEFAULT_PERSONA_BR });
});
router.put('/persona-br', async (req, res) => {
  try {
    const v = req.body?.value;
    if (typeof v !== 'string') return res.status(400).json({ error: 'value string obrigatório' });
    res.json({ value: await cfg.setPersonaBr(v) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/brand-voice', async (_req, res) => {
  res.json({ value: await cfg.getBrandVoice(), default: cfg.DEFAULT_BRAND_VOICE });
});
router.put('/brand-voice', async (req, res) => {
  try {
    const v = req.body?.value;
    if (typeof v !== 'string') return res.status(400).json({ error: 'value string obrigatório' });
    res.json({ value: await cfg.setBrandVoice(v) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============== AGENTES (Central IA — .claude/agents/*.md) ==============
router.get('/agents', (_req, res) => {
  res.json({ agents: cfg.listAgents() });
});
router.get('/agents/:name', (req, res) => {
  try {
    res.json({ name: req.params.name, content: cfg.readAgent(req.params.name) });
  } catch (e) { res.status(404).json({ error: e.message }); }
});
router.put('/agents/:name', (req, res) => {
  try {
    const content = req.body?.content;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content string obrigatório' });
    if (content.length > 200_000) return res.status(400).json({ error: 'conteúdo muito grande (>200KB)' });
    res.json(cfg.writeAgent(req.params.name, content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
