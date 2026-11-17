// =====================================================================
// /api/club-push — inscrição Web Push do atleta no Club + preferências.
// Chave pública VAPID = a MESMA do varejo (Config "vapid_public" no banco).
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../middleware');
const push = require('../services/clubPush');

const router = express.Router();
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req)); } catch (e) {
    const bad = /inválid/.test((e && e.message) || '');
    if (!bad) console.error('[club-push]', e);
    res.status(bad ? 400 : 500).json({ error: e.message });
  }
};

router.get('/vapid-public-key', async (req, res) => {
  try {
    const key = await require('../services/pushNotifications').getPublicKey();
    if (!key) return res.status(503).json({ error: 'push indisponível' });
    res.json({ publicKey: key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', authMiddleware, wrap((req) => push.status(req.userId)));
router.post('/subscribe', authMiddleware, wrap((req) => push.subscribe(req.userId, req.body || {})));
router.delete('/subscribe', authMiddleware, wrap((req) => push.unsubscribe(req.userId, (req.body || {}).endpoint)));
router.get('/preferences', authMiddleware, wrap((req) => push.getPrefs(req.userId)));
router.put('/preferences', authMiddleware, wrap((req) => push.setPrefs(req.userId, req.body || {})));
router.post('/test', authMiddleware, wrap((req) => push.sendPushNow(req.userId, {
  type: 'info', title: 'Club Sports & Tennis', body: 'Notificações no celular ligadas!', link: '#/avisos',
})));

module.exports = router;
