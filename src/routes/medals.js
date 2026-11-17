// =====================================================================
// API das MEDALHAS DIGITAIS — /api/medals
// Públicas (sem login): carta por número de série, estante do atleta,
// lista de revogação do emissor. A verificação da ASSINATURA não depende
// destas rotas: acontece no navegador de quem confere (did:key).
// Com login: carteira do atleta (com código de titularidade), emissores,
// templates, prévia/emissão a partir do resultado oficial, revogação.
// NÃO existe rota de transferência, venda ou autodeclaração.
// =====================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const { prisma, authMiddleware } = require('../middleware');
const medals = require('../services/medals');

const router = express.Router();
const actor = (req) => ({ id: req.userId, role: req.userRole });
const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof medals.MedalError) return res.status(e.status).json({ error: e.message });
    console.error('[medals]', req.method, req.originalUrl, e);
    return res.status(500).json({ error: 'Erro ao processar medalhas.' });
  }
};
const noStore = (res) => res.set('Cache-Control', 'no-store');
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });

// ---------------- públicas ----------------
router.get('/serial/:serial', publicLimiter, wrap(async (req, res) => {
  noStore(res);
  res.set('Access-Control-Allow-Origin', '*');
  res.json(await medals.bySerial(req.params.serial));
}));

router.get('/u/:handle', publicLimiter, wrap(async (req, res) => {
  noStore(res);
  res.json(await medals.shelf(req.params.handle));
}));

// Lista de revogação (1EdTechRevocationList) — aberta pra qualquer verificador externo.
router.get('/status/:issuerId', publicLimiter, wrap(async (req, res) => {
  noStore(res);
  res.set('Access-Control-Allow-Origin', '*');
  res.json(await medals.statusList(req.params.issuerId, req.query.id ? String(req.query.id) : null));
}));

// ---------------- atleta ----------------
router.get('/me', authMiddleware, wrap(async (req, res) => {
  noStore(res);
  res.json({ medals: await medals.wallet(req.userId) });
}));

// ---------------- emissor / organizador ----------------
router.get('/my-issuers', authMiddleware, wrap(async (req, res) => {
  const list = await prisma.medalIssuer.findMany({ where: { ownerUserId: req.userId }, orderBy: { createdAt: 'asc' } });
  const tpls = list.length ? await prisma.medalTemplate.findMany({ where: { issuerId: { in: list.map((i) => i.id) } }, orderBy: { updatedAt: 'desc' } }) : [];
  res.json({ issuers: list.map(medals.publicIssuer), templates: tpls });
}));

router.post('/issuers', authMiddleware, wrap(async (req, res) => {
  const b = req.body || {};
  const count = await prisma.medalIssuer.count({ where: { ownerUserId: req.userId } });
  if (count >= 5) return res.status(409).json({ error: 'Limite de 5 emissores por conta.' });
  const iss = await medals.createIssuer({ ownerUserId: req.userId, name: b.name, kind: b.kind, signatoryName: b.signatoryName, url: b.url, logoUrl: b.logoUrl });
  res.status(201).json({ issuer: medals.publicIssuer(iss) });
}));

router.post('/templates', authMiddleware, wrap(async (req, res) => {
  const b = req.body || {};
  const tpl = await medals.saveTemplate(actor(req), { id: b.id, issuerId: b.issuerId, tournamentId: b.tournamentId, name: b.name, sport: b.sport, circuit: b.circuit, design: b.design });
  res.json({ template: tpl });
}));

// Torneios que eu posso emitir (fundador/coordenador ou admin)
router.get('/my-tournaments', authMiddleware, wrap(async (req, res) => {
  const roleRows = await prisma.tournamentRole.findMany({ where: { userId: req.userId, role: { in: ['FOUNDER', 'COORDINATOR'] } }, select: { tournamentId: true } }).catch(() => []);
  const where = ['admin', 'superadmin', 'manager'].includes(req.userRole) ? {} : { OR: [{ ownerId: req.userId }, { id: { in: roleRows.map((r) => r.tournamentId) } }] };
  const ts = await prisma.tournament.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, name: true, sport: true, status: true, slug: true, startDate: true } });
  res.json({ tournaments: ts });
}));

router.get('/tournaments/:id/preview', authMiddleware, wrap(async (req, res) => {
  noStore(res);
  res.json(await medals.previewTournament(req.params.id, actor(req)));
}));

router.post('/tournaments/:id/issue', authMiddleware, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await medals.issueTournament(req.params.id, actor(req), {
    categoryIds: Array.isArray(b.categoryIds) ? b.categoryIds : undefined,
    distinctions: b.distinctions && typeof b.distinctions === 'object' ? b.distinctions : {},
    mvp: b.mvp && typeof b.mvp === 'object' ? b.mvp : {},
    location: b.location ? String(b.location).slice(0, 120) : undefined,
  }));
}));

router.post('/issue-manual', authMiddleware, wrap(async (req, res) => {
  res.json(await medals.issueManual(actor(req), req.body || {}));
}));

router.post('/:serial/revoke', authMiddleware, wrap(async (req, res) => {
  const b = req.body || {};
  const m = await medals.setStatus(String(req.params.serial).toUpperCase(), actor(req), { action: 'REVOKED', reason: b.reason, note: b.note });
  res.json({ serial: m.serial, status: m.status });
}));

router.post('/:serial/reinstate', authMiddleware, wrap(async (req, res) => {
  const b = req.body || {};
  const m = await medals.setStatus(String(req.params.serial).toUpperCase(), actor(req), { action: 'REINSTATED', note: b.note });
  res.json({ serial: m.serial, status: m.status });
}));

module.exports = router;
