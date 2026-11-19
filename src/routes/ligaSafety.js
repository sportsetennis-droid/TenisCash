// =====================================================================
// /api/liga — Liga Aberta F6: denúncia, fila de moderação, privacidade e menores
// ---------------------------------------------------------------------
// Permissão SEMPRE por roles.can() (ações globais REPORT / MODERATE / PRIVACY_SELF).
// Menores: rotas do responsável só existem com LIGA_MINORS ligado (senão 404 "indisponível").
// Nada aqui envia mensagem a ninguém nem mexe em dinheiro.
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../middleware');
const { limits } = require('../services/ligaRateLimit');
const moderation = require('../services/ligaModeration');
const privacy = require('../services/ligaPrivacy');
const minors = require('../services/ligaMinors');

const router = express.Router();

function send(res, e) {
  const st = e && Number.isInteger(e.status) ? e.status : 500;
  if (st >= 500) { console.error('[liga F6]', e); return res.status(500).json({ error: 'erro interno' }); }
  return res.status(st).json({ ...((e && e.extra) || {}), ...(e && e.code ? { code: e.code } : {}), error: e.message });
}
const wrap = (fn, code = 200) => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); const out = await fn(req, res); if (!res.headersSent) res.status(code).json(out); } catch (e) { send(res, e); }
};

// --------------------------------------------------------------- denúncia
router.get('/report-reasons', (req, res) => res.json({ reasons: moderation.REASONS, targets: moderation.TARGETS }));
router.post('/reports', authMiddleware, limits.report, wrap((req) => moderation.createReport(req, req.body || {}), 201));

// --------------------------------------------------------------- fila (admin global)
const M = '/moderation';
router.get(M + '/queue', authMiddleware, wrap((req) => moderation.queue(req, { status: req.query.status, limit: req.query.limit, cursor: req.query.cursor })));
router.get(M + '/log', authMiddleware, wrap((req) => moderation.moderationLog(req, { limit: req.query.limit, cursor: req.query.cursor })));
router.post(M + '/reports/:reportId/dismiss', authMiddleware, wrap((req) => moderation.dismiss(req, req.params.reportId)));
router.post(M + '/reports/:reportId/hide-post', authMiddleware, wrap((req) => moderation.hidePost(req, { reportId: req.params.reportId, confirm: (req.body || {}).confirm })));
router.post(M + '/posts/:postId/unhide', authMiddleware, wrap((req) => moderation.hidePost(req, { postId: req.params.postId, hide: false })));
router.post(M + '/reports/:reportId/hide-image', authMiddleware, wrap((req) => moderation.hideImage(req, { reportId: req.params.reportId, confirm: (req.body || {}).confirm })));
router.post(M + '/tournaments/:tid/suspend', authMiddleware, wrap((req) => {
  const b = req.body || {};
  return moderation.setTournamentSuspended(req, req.params.tid, { suspend: true, reason: b.reason, reportId: b.reportId, confirm: b.confirm });
}));
router.post(M + '/tournaments/:tid/unsuspend', authMiddleware, wrap((req) => moderation.setTournamentSuspended(req, req.params.tid, { suspend: false })));
router.post(M + '/organizers/suspend', authMiddleware, wrap((req) => {
  const b = req.body || {};
  return moderation.setOrganizerSuspended(req, { userId: b.userId, reportId: b.reportId, suspend: true, reason: b.reason, confirm: b.confirm });
}));
router.post(M + '/organizers/:userId/unsuspend', authMiddleware, wrap((req) => moderation.setOrganizerSuspended(req, { userId: req.params.userId, suspend: false })));
router.get(M + '/privacy-requests', authMiddleware, wrap((req) => privacy.listRequests(req, { status: req.query.status, limit: req.query.limit })));
router.post(M + '/privacy-requests/:id/close', authMiddleware, wrap((req) => privacy.closeRequest(req, req.params.id, req.body || {})));

// --------------------------------------------------------------- privacidade (o próprio)
router.get('/privacy/summary', authMiddleware, wrap(async (req) => {
  const ties = await privacy.loginTies(req.userId);
  return { confirmPhrase: privacy.CONFIRM_PHRASE, loginWillBeKept: ties.length > 0, keptBecause: ties };
}));
router.get('/privacy/export', authMiddleware, limits.privacyExport, async (req, res) => {
  try {
    const data = await privacy.exportData(req.userId);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Disposition', 'attachment; filename="meus-dados-club.json"');
    res.type('application/json').send(JSON.stringify(data, null, 2));
  } catch (e) { send(res, e); }
});
router.post('/privacy/delete', authMiddleware, limits.privacyDelete, wrap((req) => privacy.eraseSportData(req.userId, { confirm: (req.body || {}).confirm })));

// --------------------------------------------------------------- menores (DESLIGADO por padrão)
router.get('/minors/status', (req, res) => res.json({ enabled: minors.enabled() }));
// Gate ANTES do login: desligado = 404 "indisponível" para todo mundo (nada é coletado)
const minorsGate = (req, res, next) => (minors.enabled() ? next() : res.status(404).json({ error: 'indisponível', code: 'MINORS_DISABLED' }));
router.get('/minors/consent', minorsGate, wrap(() => minors.consentInfo()));
router.get('/minors/mine', minorsGate, authMiddleware, wrap((req) => minors.listMine(req.userId).then((items) => ({ items }))));
router.post('/minors', minorsGate, authMiddleware, wrap((req) => minors.createMinor(req.userId, req.body || {}), 201));
router.post('/minors/:id/revoke', minorsGate, authMiddleware, wrap((req) => minors.revokeMinor(req.userId, req.params.id)));
router.post('/minors/:id/roster', minorsGate, authMiddleware, wrap((req) => minors.linkRoster({ userId: req.userId, userRole: req.userRole }, req.params.id, (req.body || {}).playerId)));

module.exports = router;
