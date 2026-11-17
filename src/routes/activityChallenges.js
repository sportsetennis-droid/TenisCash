// =====================================================================
// Routes: /api/activity-challenges — desafios do app de atividade
// ---------------------------------------------------------------------
// Oficial (admin cria, público) e de grupo (qualquer atleta cria, privado,
// entra por link de convite). Ranking por progresso no período.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const ch = require('../services/apexChallenges');

const router = express.Router();
router.use(authMiddleware);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  if (!e.status && !/inválid|obrigatóri|período|limite|meta/i.test(e.message || '')) console.error('[activity-challenges]', e);
  res.status(e.status || 400).json({ error: e.message || 'erro' });
});

router.get('/', wrap(async (req, res) => res.json({ challenges: await ch.listFor(req.userId) })));

router.post('/official', adminMiddleware, wrap(async (req, res) => {
  const c = await ch.createOfficial(req.body || {});
  await prisma.adminAction.create({ data: { adminId: req.userId, action: 'apex_challenge_create', description: `Desafio oficial APEX: ${c.name} (${c.id})` } }).catch(() => {});
  res.status(201).json({ challenge: c });
}));

router.post('/group', wrap(async (req, res) => {
  const c = await ch.createGroup(req.userId, req.body || {});
  res.status(201).json({ challenge: c, invitePath: `/atividade.html#/desafio/${c.inviteCode}` });
}));

// prévia do convite (precisa estar logado, mas não precisa ser membro)
router.get('/invite/:code', wrap(async (req, res) => {
  const c = await prisma.challenge.findUnique({ where: { inviteCode: String(req.params.code) } });
  if (!c) return res.status(404).json({ error: 'convite inválido' });
  const n = await prisma.challengeParticipation.count({ where: { challengeId: c.id } });
  res.json({ challenge: { id: c.id, name: c.name, description: c.description, ruleType: c.ruleType, ruleConfig: c.ruleConfig, startsAt: c.startsAt, endsAt: c.endsAt }, participants: n });
}));
router.post('/invite/:code/join', wrap(async (req, res) => {
  const r = await ch.joinByCode(req.userId, req.params.code);
  res.json({ ok: true, challengeId: r.challenge.id });
}));

router.post('/:id/join', wrap(async (req, res) => {
  const c = await prisma.challenge.findUnique({ where: { id: req.params.id } });
  if (!c || c.kind === 'group') return res.status(404).json({ error: 'desafio não encontrado' }); // grupo só por convite
  await ch.join(req.userId, c.id);
  res.json({ ok: true });
}));

router.post('/:id/leave', wrap(async (req, res) => {
  await prisma.challengeParticipation.deleteMany({ where: { challengeId: req.params.id, userId: req.userId } });
  res.json({ ok: true });
}));

router.get('/:id', wrap(async (req, res) => {
  const c = await prisma.challenge.findUnique({ where: { id: req.params.id } });
  if (!(await ch.canSee(req.userId, c))) return res.status(404).json({ error: 'desafio não encontrado' });
  const me = await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: c.id, userId: req.userId } } });
  res.json({
    challenge: { ...c, inviteCode: me || c.ownerId === req.userId ? c.inviteCode : null, isOwner: c.ownerId === req.userId },
    me, ranking: await ch.ranking(c),
  });
}));

module.exports = router;
