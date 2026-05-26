// =====================================================================
// Routes: /api/seller/interview — Entrevista Semanal do Vendedor
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const { QUESTIONS, questionsByCategory, categoryLabel, weekBoundsFor, deriveInsights } = require('../services/weeklyInterview');

const router = express.Router();
router.use(authMiddleware);

function requireSeller(req, res, next) {
  if (req.userRole !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
    return res.status(403).json({ error: 'Acesso restrito a vendedores' });
  }
  next();
}

// Lista questões + metadados para o frontend renderizar
router.get('/template', (_req, res) => {
  const groups = questionsByCategory();
  const formatted = Object.keys(groups).map((cat) => ({
    category: cat,
    label: categoryLabel(cat),
    questions: groups[cat],
  }));
  res.json({ groups: formatted, totalQuestions: QUESTIONS.length });
});

// Cria/recupera entrevista da semana atual
router.get('/current', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const { weekStartDate, weekEndDate } = weekBoundsFor();
    let interview = await prisma.sellerWeeklyInterview.findUnique({
      where: { sellerId_weekStartDate: { sellerId, weekStartDate } },
      include: { answers: true },
    });
    if (!interview) {
      interview = await prisma.sellerWeeklyInterview.create({
        data: { sellerId, weekStartDate, weekEndDate, status: 'DRAFT' },
        include: { answers: true },
      });
    }
    res.json({ interview });
  } catch (err) {
    console.error('[interview/current] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar entrevista', detail: err.message });
  }
});

// Lista histórico de entrevistas
router.get('/', requireSeller, async (req, res) => {
  try {
    const sellerId = req.query.sellerId || req.userId;
    const list = await prisma.sellerWeeklyInterview.findMany({
      where: { sellerId },
      orderBy: { weekStartDate: 'desc' },
      take: 30,
    });
    res.json({ interviews: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar entrevistas' });
  }
});

router.get('/:id', requireSeller, async (req, res) => {
  try {
    const interview = await prisma.sellerWeeklyInterview.findUnique({
      where: { id: req.params.id },
      include: { answers: true, insights: true },
    });
    if (!interview) return res.status(404).json({ error: 'Entrevista não encontrada' });
    res.json({ interview });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar entrevista' });
  }
});

// Salva rascunho (substitui respostas)
router.put('/:id/answers', requireSeller, async (req, res) => {
  try {
    const { answers, moodScore, confidenceScore, salesEnergyScore, mainObjective, summary } = req.body || {};
    if (!Array.isArray(answers)) return res.status(400).json({ error: 'answers deve ser array' });

    const interview = await prisma.sellerWeeklyInterview.findUnique({ where: { id: req.params.id } });
    if (!interview) return res.status(404).json({ error: 'Entrevista não encontrada' });

    // Apaga respostas anteriores e cria novas (idempotente)
    await prisma.sellerInterviewAnswer.deleteMany({ where: { interviewId: req.params.id } });

    const questionMap = Object.fromEntries(QUESTIONS.map((q) => [q.key, q]));
    const data = answers
      .filter((a) => a && a.questionKey && questionMap[a.questionKey])
      .map((a) => ({
        interviewId: req.params.id,
        questionKey: a.questionKey,
        questionText: questionMap[a.questionKey].text,
        category: questionMap[a.questionKey].category,
        answerText: a.answerText || null,
      }));
    if (data.length) await prisma.sellerInterviewAnswer.createMany({ data });

    const updated = await prisma.sellerWeeklyInterview.update({
      where: { id: req.params.id },
      data: {
        moodScore: moodScore != null ? parseInt(moodScore, 10) : undefined,
        confidenceScore: confidenceScore != null ? parseInt(confidenceScore, 10) : undefined,
        salesEnergyScore: salesEnergyScore != null ? parseInt(salesEnergyScore, 10) : undefined,
        mainObjective: mainObjective || undefined,
        summary: summary || undefined,
      },
      include: { answers: true },
    });

    res.json({ interview: updated });
  } catch (err) {
    console.error('[interview/answers] erro:', err);
    res.status(500).json({ error: 'Erro ao salvar respostas', detail: err.message });
  }
});

// Envia entrevista — gera insights por regra
router.post('/:id/submit', requireSeller, async (req, res) => {
  try {
    const interview = await prisma.sellerWeeklyInterview.findUnique({
      where: { id: req.params.id },
      include: { answers: true },
    });
    if (!interview) return res.status(404).json({ error: 'Entrevista não encontrada' });
    if (interview.status === 'SUBMITTED' || interview.status === 'REVIEWED') {
      return res.status(400).json({ error: 'Entrevista já enviada' });
    }

    const insights = deriveInsights(interview.answers || []);
    await prisma.sellerInsight.createMany({
      data: insights.map((i) => ({
        sellerId: interview.sellerId,
        storeId: interview.storeId,
        interviewId: interview.id,
        type: i.type,
        title: i.title,
        description: i.description,
        priority: i.priority || 'MEDIUM',
        status: 'OPEN',
      })),
    });

    // Atualiza mood log
    if (interview.moodScore != null) {
      await prisma.sellerMoodLog.create({
        data: {
          sellerId: interview.sellerId,
          storeId: interview.storeId,
          moodScore: interview.moodScore,
          confidenceScore: interview.confidenceScore,
          energyScore: interview.salesEnergyScore,
          notes: interview.summary || null,
        },
      });
    }

    const updated = await prisma.sellerWeeklyInterview.update({
      where: { id: interview.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
      include: { answers: true, insights: true },
    });
    res.json({ interview: updated, insightsCount: insights.length });
  } catch (err) {
    console.error('[interview/submit] erro:', err);
    res.status(500).json({ error: 'Erro ao enviar entrevista', detail: err.message });
  }
});

// Admin: relatório agregado das entrevistas
router.get('/_admin/report', requireSeller, async (req, res) => {
  try {
    if (req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
      return res.status(403).json({ error: 'Acesso restrito a admin' });
    }
    const { weekStartDate } = weekBoundsFor();
    const interviews = await prisma.sellerWeeklyInterview.findMany({
      where: { weekStartDate },
      include: { answers: true, insights: true },
    });
    const submitted = interviews.filter((i) => i.status === 'SUBMITTED' || i.status === 'REVIEWED');
    const pending = interviews.filter((i) => i.status === 'DRAFT');
    const avgMood = submitted.length
      ? submitted.reduce((s, x) => s + (x.moodScore || 0), 0) / submitted.length
      : null;
    const avgConfidence = submitted.length
      ? submitted.reduce((s, x) => s + (x.confidenceScore || 0), 0) / submitted.length
      : null;
    const avgEnergy = submitted.length
      ? submitted.reduce((s, x) => s + (x.salesEnergyScore || 0), 0) / submitted.length
      : null;

    // Conta menções de palavra-chave por categoria
    const allInsights = await prisma.sellerInsight.findMany({
      where: { status: { in: ['OPEN', 'IN_REVIEW'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    res.json({
      weekStartDate,
      counts: {
        submitted: submitted.length,
        pending: pending.length,
        total: interviews.length,
      },
      averages: {
        mood: avgMood,
        confidence: avgConfidence,
        salesEnergy: avgEnergy,
      },
      recentInsights: allInsights,
    });
  } catch (err) {
    console.error('[interview/admin/report] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

module.exports = router;
