// =====================================================================
// /api/clubs — CLUBE PERMANENTE (fora de torneio). Ver src/services/clubs.js
// Público: GET /:slug (página do clube). O resto exige login.
// =====================================================================

const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, JWT_SECRET } = require('../middleware');
const clubs = require('../services/clubs');
const { limits, onlyWhen } = require('../services/ligaRateLimit');
const hasCrest = (req) => !!(req.body && Object.prototype.hasOwnProperty.call(req.body, 'crestUrl'));

const router = express.Router();

function ctx(req) { return { userId: req.userId, userRole: req.userRole }; }
function send(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[clubs]', err);
  res.status(status).json({ error: (err && err.message) || 'erro' });
}
const wrap = (fn, code = 200) => async (req, res) => {
  try { res.status(code).json(await fn(req, res)); } catch (e) { send(res, e); }
};

// Login opcional (só pra saber o papel de quem olha a página pública)
async function viewerOf(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return {};
  try {
    const d = jwt.verify(h.slice(7), JWT_SECRET);
    if (!d || typeof d.userId !== 'string') return {};
    const u = await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true, role: true, active: true } });
    return u && u.active === true ? { userId: u.id, userRole: u.role } : {};
  } catch (_) { return {}; }
}

router.post('/', authMiddleware, limits.club, onlyWhen(hasCrest, limits.upload), wrap((req) => clubs.createClub(ctx(req), req.body || {}), 201));
router.get('/mine', authMiddleware, wrap(async (req) => ({ clubs: await clubs.myClubs(req.userId) })));
router.post('/join', authMiddleware, wrap((req) => clubs.joinByCode(ctx(req), (req.body || {}).code)));

router.get('/:idOrSlug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await clubs.publicView(req.params.idOrSlug, await viewerOf(req)));
  } catch (e) { send(res, e); }
});
router.patch('/:idOrSlug', authMiddleware, onlyWhen(hasCrest, limits.upload), wrap((req) => clubs.updateClub(ctx(req), req.params.idOrSlug, req.body || {})));

router.get('/:idOrSlug/invite', authMiddleware, wrap((req) => clubs.inviteInfo(ctx(req), req.params.idOrSlug)));
router.post('/:idOrSlug/invite-code', authMiddleware, wrap((req) => clubs.inviteInfo(ctx(req), req.params.idOrSlug, { regenerate: true })));
router.post('/:idOrSlug/invite', authMiddleware, wrap((req) => clubs.inviteUser(ctx(req), req.params.idOrSlug, req.body || {}), 201));
router.post('/:idOrSlug/respond', authMiddleware, wrap((req) => clubs.respondInvite(ctx(req), req.params.idOrSlug, (req.body || {}).action)));

router.patch('/:idOrSlug/members/:userId', authMiddleware, wrap((req) => clubs.setRole(ctx(req), req.params.idOrSlug, req.params.userId, (req.body || {}).role)));
router.delete('/:idOrSlug/members/:userId', authMiddleware, wrap((req) => clubs.removeMember(ctx(req), req.params.idOrSlug, req.params.userId)));

router.get('/:idOrSlug/entry-options', authMiddleware, wrap(async (req) => ({ entries: await clubs.entryOptions(ctx(req), req.params.idOrSlug, req.query.tournamentId) })));
router.post('/:idOrSlug/links', authMiddleware, wrap((req) => clubs.addLink(ctx(req), req.params.idOrSlug, req.body || {}), 201));
router.delete('/:idOrSlug/links/:linkId', authMiddleware, wrap((req) => clubs.removeLink(ctx(req), req.params.idOrSlug, req.params.linkId)));

module.exports = router;
