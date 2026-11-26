// /api/meustenis — guarda-tênis digital do Club (ver src/services/meusTenis.js).
//   Público: /u/:handle (página de uma pessoa), /explore (vitrine do Club).
//   Com login: /me, busca no catálogo e nos sites de marca, incluir/editar/tirar tênis, curtir.
const express = require('express');
const rateLimit = require('express-rate-limit');
const { authMiddleware, designIsolationMiddleware, prisma } = require('../middleware');
const mt = require('../services/meusTenis');

const router = express.Router();
const send = (res, p) => p.then((d) => res.json(d)).catch((e) => {
  if (!e.status) console.error('[meustenis]', e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Não deu certo agora. Tente de novo.' });
});
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const webLimiter = rateLimit({ windowMs: 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas buscas seguidas. Espere um minuto.' } });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas alterações seguidas. Espere um pouco.' } });
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

// Público (login opcional: se vier token válido, marca o que a pessoa curtiu)
router.get('/u/:handle', publicLimiter, noStore, designIsolationMiddleware, (req, res) =>
  send(res, mt.publicCloset(prisma, req.params.handle, { viewerId: req.userId || null, countView: req.query.v === '1' })));
router.get('/explore', publicLimiter, noStore, (req, res) => send(res, mt.explore(prisma, { limit: req.query.limit })));

// Com login
const auth = express.Router();
auth.use(noStore, authMiddleware);
auth.get('/me', (req, res) => send(res, mt.me(prisma, req.userId)));
auth.put('/me', writeLimiter, (req, res) => send(res, mt.saveProfile(prisma, req.userId, req.body || {})));
auth.post('/me/handle', writeLimiter, (req, res) => send(res, mt.setHandle(prisma, req.userId, (req.body || {}).handle)));
auth.get('/search', (req, res) => send(res, mt.searchCatalog(prisma, req.query.q)));
auth.get('/search/web', webLimiter, (req, res) => send(res, mt.searchWeb(req.query.q)));
const barcodeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitos códigos seguidos. Espere um minuto.' } });
auth.get('/barcode/:code', barcodeLimiter, (req, res) => send(res, mt.ensureSchema(prisma).then(() => mt.lookupBarcode(prisma, req.params.code))));
auth.post('/items', writeLimiter, (req, res) => send(res, mt.addItem(prisma, req.userId, req.body || {})));
auth.post('/items/order', writeLimiter, (req, res) => send(res, mt.reorder(prisma, req.userId, (req.body || {}).ids)));
auth.patch('/items/:id', writeLimiter, (req, res) => send(res, mt.updateItem(prisma, req.userId, req.params.id, req.body || {})));
auth.delete('/items/:id', writeLimiter, (req, res) => send(res, mt.removeItem(prisma, req.userId, req.params.id)));
auth.post('/items/:id/like', writeLimiter, (req, res) => send(res, mt.toggleLike(prisma, req.userId, req.params.id)));
// Ofertas de compra entre pessoas (o Club só conecta; não intermedia pagamento)
const offerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas ofertas seguidas. Tente mais tarde.' } });
auth.post('/items/:id/offers', offerLimiter, (req, res) => send(res, mt.makeOffer(prisma, req.userId, req.params.id, req.body || {})));
auth.get('/me/offers', (req, res) => send(res, mt.myOffers(prisma, req.userId)));
auth.post('/offers/:id', writeLimiter, (req, res) => send(res, mt.answerOffer(prisma, req.userId, req.params.id, (req.body || {}).action)));
router.use(auth);

module.exports = router;
