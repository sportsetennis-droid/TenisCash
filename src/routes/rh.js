// /api/rh — RH completo (recrutamento, férias, documentos, admissão/desligamento, avaliação, ficha).
//   /api/rh/public/*  → página pública de vagas (sem login; candidatura com limite por IP)
//   /api/rh/me/*      → "Meu RH" do vendedor (link pessoal assinado ?k= ou login do app)
//   /api/rh/admin/*   → painel do RH (login de administração)
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const rh = require('../services/rh');
const store = require('../services/rh/store');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: store.MAX_BYTES, files: 1 } });
const applyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas candidaturas deste aparelho. Tente mais tarde.' } });

const send = (res, p) => p.then((data) => res.json(data)).catch((e) => {
  if (!e.status) console.error('[rh]', e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro no RH. Tente de novo.', ...(e.needsConfirm ? { needsConfirm: true } : {}) });
});
function withFile(field) {
  return (req, res, next) => upload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais (máx. 8 MB).' : 'Arquivo inválido.' });
    next();
  });
}
function sendFile(res, file, name, mime) {
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });
  res.set('Content-Type', mime || 'application/octet-stream');
  res.set('Content-Disposition', 'inline; filename="' + String(name || 'arquivo').replace(/["\r\n]/g, '') + '"');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
}

// ───────── Público: vagas ─────────
router.get('/public/jobs', (req, res) => send(res, rh.listJobs(prisma, { publicOnly: true }).then((rows) => rows.map(rh.publicJob))));
router.get('/public/jobs/:slug', async (req, res) => {
  try {
    const j = await rh.getJob(prisma, req.params.slug);
    if (!j || j.status !== 'ABERTA') return res.status(404).json({ error: 'Vaga não encontrada ou encerrada.' });
    res.json(rh.publicJob(j));
  } catch (e) { res.status(500).json({ error: 'Erro ao abrir a vaga.' }); }
});
router.post('/public/jobs/:slug/apply', applyLimiter, withFile('resume'), (req, res) => send(res, rh.apply(prisma, req.params.slug, req.body || {}, req.file)));

// Entrevista por escrito (link único que o candidato recebe ao se candidatar).
const interviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'Muitas tentativas. Tente daqui a pouco.' } });
router.get('/public/interview/:token', interviewLimiter, (req, res) => send(res, rh.getInterview(prisma, req.params.token)));
router.post('/public/interview/:token', interviewLimiter, (req, res) => send(res, rh.saveInterview(prisma, req.params.token, req.body || {})));

// ───────── Meu RH (vendedor) ─────────
function identifySelf(req, res, next) {
  const loadSelf = async () => {
    try {
      const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, name: true, role: true, active: true } });
      if (!u || !u.active || u.role !== 'seller') return res.status(403).json({ error: 'O Meu RH é para a equipe.' });
      req.self = u; next();
    } catch (e) { res.status(500).json({ error: 'Erro ao abrir o Meu RH.' }); }
  };
  const k = req.query.k || req.get('x-rh-key');
  if (k) {
    const userId = rh.userFromLink(k);
    if (!userId) return res.status(401).json({ error: 'Este link venceu. Peça um novo ou entre pelo app TenisCash.' });
    req.userId = userId; req.viaLink = true;
    return loadSelf();
  }
  return authMiddleware(req, res, loadSelf); // sem token, o authMiddleware já responde 401
}
const me = express.Router();
me.use(identifySelf);
me.get('/', (req, res) => send(res, (async () => {
  const [vacation, docs, reviews] = await Promise.all([
    rh.vacationBalance(prisma, req.self.id), rh.listDocuments(prisma, req.self.id),
    (async () => { await rh.ensureSchema(prisma); return prisma.$queryRaw`SELECT r."id", r."selfScores", r."selfComment", r."selfDoneAt", y."name" AS "cycleName", y."status" AS "cycleStatus"
      FROM "HrReview" r JOIN "HrReviewCycle" y ON y."id"=r."cycleId" WHERE r."userId"=${req.self.id} ORDER BY y."createdAt" DESC LIMIT 5`; })(),
  ]);
  return { name: req.self.name, vacation, documents: docs, reviews, criteria: rh.REVIEW_CRITERIA, docTypes: rh.DOC_TYPES };
})()));
me.post('/vacations/check', (req, res) => send(res, rh.validateVacation(prisma, req.self.id, req.body || {}).then((v) => ({ errors: v.errors, warnings: v.warnings, endDate: v.endDate }))));
me.post('/vacations', (req, res) => send(res, rh.requestVacation(prisma, req.self.id, req.body || {}, { bySelf: true })));
me.post('/vacations/:id/cancel', (req, res) => send(res, rh.cancelVacation(prisma, req.params.id, req.self.id, { bySelfUserId: req.self.id })));
me.post('/documents', withFile('file'), (req, res) => send(res, rh.addDocument(prisma, req.self.id, req.body || {}, req.file, { bySelf: true })));
me.get('/documents/:id/file', async (req, res) => {
  const d = await rh.getDocumentFile(prisma, req.params.id).catch(() => null);
  if (!d || d.userId !== req.self.id) return res.status(404).json({ error: 'Documento não encontrado.' });
  sendFile(res, d.path, d.originalName, d.mimeType);
});
me.post('/reviews/:id/self', (req, res) => send(res, rh.saveReview(prisma, req.params.id, req.body || {}, req.self.id, { self: true, selfUserId: req.self.id })));
router.use('/me', me);

// ───────── Admin ─────────
const admin = express.Router();
// Dados de RH (salário, documentos, currículos): só dono/administração, não gerente.
admin.use(authMiddleware, adminMiddleware, (req, res, next) => (['admin', 'superadmin'].includes(req.userRole) ? next() : res.status(403).json({ error: 'RH restrito ao dono e à administração.' })));
admin.get('/dashboard', (req, res) => send(res, rh.dashboard(prisma)));
admin.get('/meta', async (req, res) => send(res, (async () => ({
  screeningTemplates: Object.fromEntries(Object.entries(rh.screening.TEMPLATES).map(([k, t]) => [k, { label: t.label, cutoffPct: t.cutoffPct, max: rh.screening.maxScore(t.screening), maxBy: rh.screening.maxByProfile(rh.screening.normalize(t.screening)), open: t.open, text: rh.screening.toText(t.screening) }])),
  stages: rh.STAGES, docTypes: rh.DOC_TYPES, requiredDocs: rh.REQUIRED_DOCS, checklists: rh.CHECKLISTS, criteria: rh.REVIEW_CRITERIA,
  stores: await prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
}))()));
// recrutamento
admin.get('/jobs', (req, res) => send(res, rh.listJobs(prisma)));
admin.post('/jobs', (req, res) => send(res, rh.saveJob(prisma, req.body || {}, req.userId)));
admin.put('/jobs/:id', (req, res) => send(res, rh.saveJob(prisma, req.body || {}, req.userId, req.params.id)));
admin.get('/candidates', (req, res) => send(res, rh.listCandidates(prisma, { jobId: req.query.jobId || null, stage: req.query.stage || null, q: req.query.q || null })));
admin.get('/candidates/:id', (req, res) => send(res, rh.getCandidate(prisma, req.params.id).then((c) => { if (!c) throw Object.assign(new Error('Candidato não encontrado.'), { status: 404 }); return c; })));
admin.get('/candidates/:id/resume', async (req, res) => {
  const c = await rh.getCandidate(prisma, req.params.id).catch(() => null);
  if (!c || !c.resumeFile) return res.status(404).json({ error: 'Sem currículo anexado.' });
  sendFile(res, store.resolve(c.resumeFile), c.resumeName, c.resumeMime);
});
admin.post('/candidates/:id/scorecard', (req, res) => send(res, rh.saveScorecard(prisma, req.params.id, req.body || {}, req.userId)));
admin.post('/candidates/:id/move', (req, res) => send(res, rh.moveCandidate(prisma, req.params.id, req.body || {}, req.userId)));
admin.delete('/candidates/:id', (req, res) => send(res, rh.deleteCandidate(prisma, req.params.id, req.userId)));
admin.post('/candidates/:id/hire', (req, res) => send(res, rh.hire(prisma, req.params.id, req.body || {}, req.userId)));
// equipe e ficha
admin.get('/team', (req, res) => send(res, rh.team(prisma)));
admin.get('/employees/:id', (req, res) => send(res, rh.employeeFile(prisma, req.params.id)));
admin.post('/employees/:id/link', (req, res) => send(res, Promise.resolve({ link: rh.signedLink(req.params.id, (req.protocol + '://' + req.get('host'))) })));
// férias
admin.get('/vacations', (req, res) => send(res, rh.listVacations(prisma, { status: req.query.status || null })));
admin.post('/employees/:id/vacations', (req, res) => send(res, rh.requestVacation(prisma, req.params.id, req.body || {}, { bySelf: false, actorId: req.userId })));
admin.post('/vacations/:id/decide', (req, res) => send(res, rh.decideVacation(prisma, req.params.id, !!(req.body || {}).approve, req.userId, (req.body || {}).note)));
admin.post('/vacations/:id/cancel', (req, res) => send(res, rh.cancelVacation(prisma, req.params.id, req.userId)));
admin.post('/employees/:id/vacation-right', (req, res) => send(res, rh.adjustVacationRight(prisma, req.params.id, (req.body || {}).periodStart, (req.body || {}).rightDays, (req.body || {}).reason, req.userId)));
// documentos
admin.get('/documents/expiring', (req, res) => send(res, rh.expiringDocuments(prisma)));
admin.post('/employees/:id/documents', withFile('file'), (req, res) => send(res, rh.addDocument(prisma, req.params.id, req.body || {}, req.file, { actorId: req.userId })));
admin.get('/documents/:id/file', async (req, res) => {
  const d = await rh.getDocumentFile(prisma, req.params.id).catch(() => null);
  if (!d) return res.status(404).json({ error: 'Documento não encontrado.' });
  sendFile(res, d.path, d.originalName, d.mimeType);
});
admin.delete('/documents/:id', (req, res) => send(res, rh.removeDocument(prisma, req.params.id, req.userId)));
// admissão / desligamento
admin.get('/checklists', (req, res) => send(res, rh.listChecklists(prisma, { status: req.query.status || null })));
admin.post('/employees/:id/checklists', (req, res) => send(res, rh.startChecklist(prisma, req.params.id, (req.body || {}).kind, req.userId, (req.body || {}).dueDate)));
admin.post('/employees/:id/offboarding', (req, res) => send(res, rh.startOffboarding(prisma, req.params.id, req.body || {}, req.userId)));
admin.post('/checklists/:id/items/:i', (req, res) => send(res, rh.toggleChecklistItem(prisma, req.params.id, req.params.i, !!(req.body || {}).done, req.userId)));
// avaliação
admin.get('/cycles', (req, res) => send(res, rh.listCycles(prisma)));
admin.post('/cycles', (req, res) => send(res, rh.createCycle(prisma, req.body || {}, req.userId)));
admin.get('/cycles/:id', (req, res) => send(res, rh.cycleDetail(prisma, req.params.id)));
admin.post('/cycles/:id/close', (req, res) => send(res, rh.closeCycle(prisma, req.params.id, req.userId)));
admin.put('/reviews/:id', (req, res) => send(res, rh.saveReview(prisma, req.params.id, req.body || {}, req.userId)));
router.use('/admin', admin);

module.exports = router;
