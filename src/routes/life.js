// =====================================================================
// Life Agent Routes — Assessor Sports & Tennis (cliente/assinante)
// =====================================================================
// Montadas em /api/life
// Todas exigem auth (qualquer role de usuário logado).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { authMiddleware, prisma } = require('../middleware');
const {
  generatePossibilities,
  listUserRecommendations,
} = require('../ai/recommendations/possibility-engine.service');

const router = express.Router();
router.use(authMiddleware);

const possibilityLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `u:${req.userId}`,
  message: { error: 'Muitas requisições. Aguarde um instante.' },
});

// Cria ou atualiza perfil de vida do usuário
router.post('/profile', async (req, res) => {
  try {
    const {
      sportsPracticed,
      sportsWanted,
      goals,
      routine,
      preferences,
      culturalInterests,
      budgetProfile,
      availability,
      energyPattern,
      notes,
    } = req.body || {};

    const data = {
      sportsPracticed: sportsPracticed ?? undefined,
      sportsWanted: sportsWanted ?? undefined,
      goals: goals ?? undefined,
      routine: routine ?? undefined,
      preferences: preferences ?? undefined,
      culturalInterests: culturalInterests ?? undefined,
      budgetProfile: budgetProfile ?? undefined,
      availability: availability ?? undefined,
      energyPattern: energyPattern ?? undefined,
      notes: notes ?? undefined,
    };
    // remove undefined
    Object.keys(data).forEach((k) => data[k] === undefined && delete data[k]);

    const existing = await prisma.userLifeProfile.findUnique({ where: { userId: req.userId } });
    const saved = existing
      ? await prisma.userLifeProfile.update({ where: { userId: req.userId }, data })
      : await prisma.userLifeProfile.create({ data: { userId: req.userId, ...data } });

    res.json({ profile: saved });
  } catch (err) {
    console.error('[life/profile] erro:', err);
    res.status(500).json({ error: 'Erro ao salvar perfil', detail: err.message });
  }
});

// Retorna o perfil atual
router.get('/profile', async (req, res) => {
  try {
    const profile = await prisma.userLifeProfile.findUnique({ where: { userId: req.userId } });
    res.json({ profile });
  } catch (err) {
    console.error('[life/profile GET] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar perfil' });
  }
});

// Registra check-in de humor/energia
router.post('/checkin', async (req, res) => {
  try {
    const { mood, energy, context, note } = req.body || {};
    const checkin = await prisma.userMoodCheckin.create({
      data: {
        userId: req.userId,
        mood: mood || null,
        energy: energy || null,
        context: context || null,
        note: note || null,
      },
    });
    res.json({ checkin });
  } catch (err) {
    console.error('[life/checkin] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar check-in', detail: err.message });
  }
});

// Lista check-ins recentes
router.get('/checkins', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const list = await prisma.userMoodCheckin.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ checkins: list });
  } catch (err) {
    console.error('[life/checkins] erro:', err);
    res.status(500).json({ error: 'Erro ao listar check-ins' });
  }
});

// Gera possibilidades personalizadas (chama Life Assessor + Safety)
router.post('/possibilities', possibilityLimiter, async (req, res) => {
  try {
    const { currentCondition, objective, context } = req.body || {};
    const result = await generatePossibilities({
      userId: req.userId,
      currentCondition: currentCondition || null,
      objective: objective || null,
      context: context || null,
    });
    res.json(result);
  } catch (err) {
    console.error('[life/possibilities] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar possibilidades', detail: err.message });
  }
});

// Registra um treino
router.post('/training-log', async (req, res) => {
  try {
    const { sport, title, durationMin, intensity, location, teacherName, notes } = req.body || {};
    const entry = await prisma.userTrainingLog.create({
      data: {
        userId: req.userId,
        sport: sport || null,
        title: title || null,
        durationMin: typeof durationMin === 'number' ? durationMin : null,
        intensity: intensity || null,
        location: location || null,
        teacherName: teacherName || null,
        notes: notes || null,
      },
    });
    res.json({ log: entry });
  } catch (err) {
    console.error('[life/training-log] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar treino', detail: err.message });
  }
});

// Lista treinos
router.get('/training-logs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const list = await prisma.userTrainingLog.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ logs: list });
  } catch (err) {
    console.error('[life/training-logs] erro:', err);
    res.status(500).json({ error: 'Erro ao listar treinos' });
  }
});

// Lista recomendações anteriores
router.get('/recommendations', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const list = await listUserRecommendations(req.userId, { limit });
    res.json({ recommendations: list });
  } catch (err) {
    console.error('[life/recommendations] erro:', err);
    res.status(500).json({ error: 'Erro ao listar recomendações' });
  }
});

// Lista UserActions do usuário (possibilidades viraram ações pendentes)
router.get('/actions', async (req, res) => {
  try {
    const status = req.query.status || null;
    const list = await prisma.userAction.findMany({
      where: { userId: req.userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ actions: list });
  } catch (err) {
    console.error('[life/actions] erro:', err);
    res.status(500).json({ error: 'Erro ao listar ações' });
  }
});

// Aprova uma UserAction (próprio usuário confirma a possibilidade)
router.post('/actions/:id/approve', async (req, res) => {
  try {
    const action = await prisma.userAction.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!action) return res.status(404).json({ error: 'Ação não encontrada' });
    if (action.status !== 'pending') {
      return res.status(400).json({ error: `Ação está em estado ${action.status}` });
    }
    const updated = await prisma.userAction.update({
      where: { id: action.id },
      data: { status: 'approved', approvedAt: new Date() },
    });
    res.json({ action: updated });
  } catch (err) {
    console.error('[life/actions/approve] erro:', err);
    res.status(500).json({ error: 'Erro ao aprovar ação', detail: err.message });
  }
});

// Cancela uma UserAction
router.post('/actions/:id/cancel', async (req, res) => {
  try {
    const action = await prisma.userAction.findFirst({
      where: { id: req.params.id, userId: req.userId },
    });
    if (!action) return res.status(404).json({ error: 'Ação não encontrada' });
    const updated = await prisma.userAction.update({
      where: { id: action.id },
      data: { status: 'cancelled' },
    });
    res.json({ action: updated });
  } catch (err) {
    console.error('[life/actions/cancel] erro:', err);
    res.status(500).json({ error: 'Erro ao cancelar ação', detail: err.message });
  }
});

module.exports = router;
