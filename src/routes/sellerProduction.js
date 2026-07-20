// =====================================================================
// Producao diaria do vendedor
// Rotas pessoais + fila de fiscalizacao + elegibilidade mensal.
// Nenhuma rota aplica suspensao, demissao ou alteracao de folha.
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, storeScope, prisma } = require('../middleware');
const production = require('../services/sellerProduction');
const evidenceStore = require('../services/productionEvidenceStore');
const { ensureScheduledProductionDays } = require('../services/sellerProductionCron');

const router = express.Router();
router.use(authMiddleware, storeScope);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/i.test(file.mimetype);
    cb(ok ? null : new Error('Envie foto JPG/PNG/WebP ou video MP4/WebM/MOV.'), ok);
  },
});

const submissionUpload = upload.fields([
  { name: 'evidence', maxCount: 6 },
  { name: 'whatsappEvidence', maxCount: 2 },
]);
const privateUpload = upload.array('attachments', 6);

const REVIEWER_ROLES = new Set(['store', 'manager', 'admin', 'superadmin']);
const SELLER_ROLES = new Set(['seller', ...REVIEWER_ROLES]);
const CONDUCT_REVIEWER_ROLES = new Set(['admin', 'superadmin']);
const REQUEST_CATEGORIES = new Set(['SUPPLIES', 'MAINTENANCE', 'PRODUCT', 'EQUIPMENT', 'OTHER']);
const REQUEST_URGENCIES = new Set(['NORMAL', 'HIGH', 'URGENT']);
const REQUEST_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED']);
const CONDUCT_CATEGORIES = new Set(['OFFENSE', 'HARASSMENT', 'DISCRIMINATION', 'THREAT', 'MISCONDUCT', 'OTHER']);
const CONDUCT_STATUSES = new Set(['RECEIVED', 'UNDER_REVIEW', 'CLOSED']);
const DECISIONS = new Set([
  'NO_ACTION',
  'NOTICE',
  'WARNING',
  'SUSPENSION_3_REVIEW',
  'SUSPENSION_5_REVIEW',
  'TERMINATION_REVIEW',
]);

function requireSellerScope(req, res, next) {
  if (!SELLER_ROLES.has(req.userRole)) return res.status(403).json({ error: 'Acesso restrito a vendedores e fiscalizadores.' });
  next();
}

function requireReviewer(req, res, next) {
  if (!REVIEWER_ROLES.has(req.userRole)) return res.status(403).json({ error: 'Acesso restrito ao fiscalizador da producao.' });
  next();
}

function requireConductReviewer(req, res, next) {
  if (!CONDUCT_REVIEWER_ROLES.has(req.userRole)) return res.status(403).json({ error: 'Canal confidencial restrito a administradores autorizados.' });
  next();
}

function localYmd(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza' });
}

function validYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function dateFromYmd(value) {
  if (!validYmd(value)) return null;
  const date = new Date(`${value}T03:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  if (monthNumber < 1 || monthNumber > 12) return null;
  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 3));
  const end = new Date(Date.UTC(year, monthNumber, 1, 3));
  return { start, end };
}

function parseProductRefs(value) {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20);
  const raw = String(value || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20);
  } catch (_) {}
  return raw.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean).slice(0, 20);
}

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function canViewDay(req, day) {
  if (!day) return false;
  if (req.userRole === 'seller') return day.sellerId === req.userId;
  if (req.scope?.isStoreLocked) return day.storeId === req.scope.storeId;
  return REVIEWER_ROLES.has(req.userRole);
}

function canReviewDay(req, day) {
  if (!canViewDay(req, day) || day.sellerId === req.userId) return false;
  return REVIEWER_ROLES.has(req.userRole);
}

function canReviewStore(req, storeId) {
  if (!REVIEWER_ROLES.has(req.userRole)) return false;
  if (req.scope?.isStoreLocked) return storeId === req.scope.storeId;
  return true;
}

function attachmentSummary(entry) {
  return {
    id: entry.id,
    originalName: entry.originalName,
    mimeType: entry.mimeType,
    mediaType: entry.mediaType,
    bytes: entry.bytes,
    createdAt: entry.createdAt,
  };
}

async function savePrivateAttachments(files, parent) {
  const saved = [];
  for (const file of files || []) saved.push(evidenceStore.save(file));
  if (!saved.length) return [];
  try {
    await prisma.sellerPrivateAttachment.createMany({
      data: saved.map((file) => ({ ...file, ...parent })),
    });
    return saved;
  } catch (err) {
    for (const file of saved) evidenceStore.remove(file.storedName);
    throw err;
  }
}

async function notifyCompany({ fromId, storeId, title, content, priority = 'normal', conduct = false }) {
  const roleFilter = conduct ? ['superadmin', 'admin'] : ['superadmin', 'admin', 'manager', 'store'];
  const where = { active: true, role: { in: roleFilter }, id: { not: fromId } };
  if (!conduct && storeId) where.OR = [{ role: { in: ['superadmin', 'admin'] } }, { storeId }, { storeIds: { has: storeId } }];
  const recipient = await prisma.user.findFirst({ where, orderBy: [{ role: 'desc' }, { createdAt: 'asc' }], select: { id: true } });
  if (!recipient) return null;
  return prisma.message.create({ data: { fromId, toId: recipient.id, type: 'request', title, content, priority } });
}

async function resolveSellerAndStore(sellerId, requestedStoreId) {
  const seller = await prisma.user.findUnique({
    where: { id: sellerId },
    select: { id: true, name: true, role: true, active: true, storeId: true, storeIds: true, baseSalary: true },
  });
  if (!seller || !seller.active || seller.role !== 'seller') throw new Error('Vendedor ativo nao encontrado.');
  const allowedStores = new Set([seller.storeId, ...(seller.storeIds || [])].filter(Boolean));
  const storeId = requestedStoreId || seller.storeId || [...allowedStores][0];
  if (!storeId || !allowedStores.has(storeId)) throw new Error('Loja nao vinculada ao vendedor.');
  return { seller, storeId };
}

async function ensureDay({ sellerId, ymd, storeId }) {
  const workDate = dateFromYmd(ymd);
  if (!workDate) throw new Error('Data invalida. Use YYYY-MM-DD.');
  const publishedMonth = await prisma.sellerMonthlySchedule.findFirst({ where: { month: ymd.slice(0, 7), status: 'PUBLISHED' }, select: { id: true } });
  const monthlyShift = publishedMonth ? await prisma.sellerMonthlyShift.findFirst({
    where: { scheduleId: publishedMonth.id, sellerId, workDate },
    select: { storeId: true, startTime: true, endTime: true },
  }) : null;
  if (publishedMonth && !monthlyShift) throw new Error('Voce nao esta escalado para trabalhar nesta data. Confira Minha escala.');
  let resolved;
  if (monthlyShift) {
    const seller = await prisma.user.findFirst({ where: { id: sellerId, role: 'seller', active: true }, select: { id: true, name: true, role: true, active: true, storeId: true, storeIds: true, baseSalary: true } });
    if (!seller) throw new Error('Vendedor ativo nao encontrado.');
    resolved = { seller, storeId: monthlyShift.storeId };
  } else {
    resolved = await resolveSellerAndStore(sellerId, storeId);
  }
  const weekday = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const recurringSchedule = monthlyShift ? null : await prisma.sellerSchedule.findFirst({
    where: { sellerId, storeId: resolved.storeId, weekday, active: true },
    orderBy: { createdAt: 'asc' },
  });
  const schedule = monthlyShift || recurringSchedule;

  const day = await prisma.sellerProductionDay.upsert({
    where: { sellerId_workDate: { sellerId, workDate } },
    update: {},
    create: {
      sellerId,
      storeId: resolved.storeId,
      workDate,
      policyVersion: production.POLICY_VERSION,
      incentivePct: production.INCENTIVE_PCT,
      scheduleStart: schedule?.startTime || null,
      scheduleEnd: schedule?.endTime || null,
      items: {
        create: production.RULES.map((rule) => ({
          ruleKey: rule.key,
          phase: rule.phase,
          position: rule.position,
          title: rule.title,
          mediaType: rule.mediaType,
          targetDurationSec: rule.targetDurationSec || null,
          requiredProducts: rule.requiredProducts || 0,
        })),
      },
    },
    include: {
      seller: { select: { id: true, name: true, employeeCode: true } },
      store: { select: { id: true, name: true, code: true } },
      items: { orderBy: { position: 'asc' }, include: { evidence: true } },
      incident: true,
      reminders: { orderBy: { sentAt: 'asc' } },
    },
  });
  if (!['APPROVED', 'NONCOMPLIANT', 'EXCUSED'].includes(day.status) && (day.policyVersion !== production.POLICY_VERSION || day.items.length < production.RULES.length)) {
    await prisma.$transaction([
      prisma.sellerProductionItem.createMany({
        data: production.RULES.map((rule) => ({
          dayId: day.id,
          ruleKey: rule.key,
          phase: rule.phase,
          position: rule.position,
          title: rule.title,
          mediaType: rule.mediaType,
          targetDurationSec: rule.targetDurationSec || null,
          requiredProducts: rule.requiredProducts || 0,
        })),
        skipDuplicates: true,
      }),
      ...production.RULES.map((rule) => prisma.sellerProductionItem.updateMany({
        where: { dayId: day.id, ruleKey: rule.key },
        data: {
          phase: rule.phase,
          position: rule.position,
          title: rule.title,
          mediaType: rule.mediaType,
          targetDurationSec: rule.targetDurationSec || null,
          requiredProducts: rule.requiredProducts || 0,
        },
      })),
      prisma.sellerProductionDay.update({ where: { id: day.id }, data: { policyVersion: production.POLICY_VERSION } }),
    ]);
    return prisma.sellerProductionDay.findUnique({ where: { id: day.id }, include: dayInclude() });
  }
  return day;
}

function serializeDay(day) {
  const items = (day.items || []).map((item) => {
    const rule = production.ruleForKey(item.ruleKey);
    return {
      ...item,
      internalOnly: !!rule?.internalOnly,
      socialStory: !!rule?.socialStory,
      socialReel: !!rule?.socialReel,
      requirements: production.requiredConfirmations(rule),
      confirmations: production.parseConfirmations(item.requirementsConfirmedJson),
      evidence: (item.evidence || []).map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        originalName: entry.originalName,
        mimeType: entry.mimeType,
        mediaType: entry.mediaType,
        bytes: entry.bytes,
        createdAt: entry.createdAt,
      })),
    };
  });
  return { ...day, items, progress: production.dayProgress(items), reminders: day.reminders || [] };
}

function dayInclude() {
  return {
    seller: { select: { id: true, name: true, employeeCode: true, baseSalary: true } },
    store: { select: { id: true, name: true, code: true } },
    items: { orderBy: { position: 'asc' }, include: { evidence: true } },
    incident: true,
    reminders: { orderBy: { sentAt: 'asc' } },
  };
}

router.get('/policy', requireSellerScope, async (req, res) => {
  try {
    const acceptance = req.userRole === 'seller'
      ? await prisma.sellerProductionPolicyAcceptance.findUnique({ where: { sellerId_policyVersion: { sellerId: req.userId, policyVersion: production.POLICY_VERSION } } })
      : null;
    res.json({
      version: production.POLICY_VERSION,
      digest: production.POLICY_DIGEST,
      acceptedAt: acceptance?.acceptedAt || null,
      incentivePct: production.INCENTIVE_PCT,
      totals: {
        activities: production.RULES.length,
        reels: production.RULES.filter((r) => r.socialReel).length,
        stories: production.RULES.filter((r) => r.socialStory).length,
        internalRecords: production.RULES.filter((r) => r.internalOnly).length,
      },
      rules: production.RULES.map((rule) => ({ ...rule, requirements: production.requiredConfirmations(rule) })),
      legalGuardrail: 'O sistema apura fatos e elegibilidade. Medidas disciplinares e folha exigem decisao humana autorizada.',
      privacyNotice: 'Fotos, prints, solicitacoes e relatos internos nao sao publicados. O acesso fica restrito ao proprio autor e aos perfis autorizados da empresa, com registro de consulta a arquivos privados. A foto externa da bolsa serve somente ao controle de entrada e saida de volumes, sem inspecao do conteudo.',
    });
  } catch (err) {
    console.error('[seller-production/policy]', err);
    res.status(500).json({ error: 'Erro ao carregar as regras.' });
  }
});

router.post('/policy/acknowledge', requireSellerScope, async (req, res) => {
  try {
    if (req.userRole !== 'seller') return res.status(403).json({ error: 'Somente o vendedor pode confirmar o recebimento das regras.' });
    if (!parseBoolean(req.body.confirmed)) return res.status(400).json({ error: 'Confirme que leu e recebeu as regras.' });
    const acceptance = await prisma.sellerProductionPolicyAcceptance.upsert({
      where: { sellerId_policyVersion: { sellerId: req.userId, policyVersion: production.POLICY_VERSION } },
      update: { policyDigest: production.POLICY_DIGEST, acceptedAt: new Date() },
      create: { sellerId: req.userId, policyVersion: production.POLICY_VERSION, policyDigest: production.POLICY_DIGEST },
    });
    res.json({ ok: true, acceptedAt: acceptance.acceptedAt, version: acceptance.policyVersion });
  } catch (err) {
    console.error('[seller-production/policy-acknowledge]', err);
    res.status(500).json({ error: 'Erro ao confirmar o recebimento das regras.' });
  }
});

router.get('/today', requireSellerScope, async (req, res) => {
  try {
    const sellerId = req.userRole === 'seller' ? req.userId : String(req.query.sellerId || '');
    if (!sellerId) return res.status(400).json({ error: 'Informe o vendedor.' });
    const ymd = validYmd(req.query.date) ? String(req.query.date) : localYmd();
    if (req.userRole === 'seller' && ymd !== localYmd()) return res.status(403).json({ error: 'O vendedor so pode abrir o checklist do dia atual.' });
    const requestedStoreId = req.scope?.isStoreLocked ? req.scope.storeId : (req.query.storeId || undefined);
    const day = await ensureDay({ sellerId, ymd, storeId: requestedStoreId });
    if (!canViewDay(req, day)) return res.status(403).json({ error: 'Sem acesso a esta producao.' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ day: serializeDay(day) });
  } catch (err) {
    console.error('[seller-production/today]', err);
    res.status(400).json({ error: err.message || 'Erro ao carregar producao diaria.' });
  }
});

router.get('/days', requireSellerScope, async (req, res) => {
  try {
    const where = {};
    if (req.userRole === 'seller') where.sellerId = req.userId;
    else if (req.query.sellerId) where.sellerId = String(req.query.sellerId);
    if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
    else if (req.query.storeId) where.storeId = String(req.query.storeId);
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.from || req.query.to) {
      where.workDate = {};
      if (req.query.from) {
        const from = dateFromYmd(req.query.from);
        if (!from) return res.status(400).json({ error: 'Data inicial invalida.' });
        where.workDate.gte = from;
      }
      if (req.query.to) {
        const to = dateFromYmd(req.query.to);
        if (!to) return res.status(400).json({ error: 'Data final invalida.' });
        where.workDate.lt = new Date(to.getTime() + 86400000);
      }
    }
    const days = await prisma.sellerProductionDay.findMany({
      where,
      orderBy: { workDate: 'desc' },
      take: Math.min(Number(req.query.limit) || 60, 180),
      include: dayInclude(),
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ days: days.map(serializeDay) });
  } catch (err) {
    console.error('[seller-production/days]', err);
    res.status(500).json({ error: 'Erro ao listar producao.' });
  }
});

router.post('/items/:itemId/submit', requireSellerScope, submissionUpload, async (req, res) => {
  const savedFiles = [];
  try {
    const item = await prisma.sellerProductionItem.findUnique({
      where: { id: req.params.itemId },
      include: { day: true, evidence: true },
    });
    if (!item || item.day.sellerId !== req.userId || req.userRole !== 'seller') {
      return res.status(403).json({ error: 'Somente o vendedor responsavel pode enviar esta atividade.' });
    }
    const acceptance = await prisma.sellerProductionPolicyAcceptance.findUnique({ where: { sellerId_policyVersion: { sellerId: req.userId, policyVersion: production.POLICY_VERSION } }, select: { id: true } });
    if (!acceptance) return res.status(409).json({ error: 'Leia e confirme o recebimento das regras antes de enviar atividades.' });
    if (!['PENDING', 'REJECTED'].includes(item.status)) return res.status(409).json({ error: 'Esta atividade nao esta disponivel para envio.' });
    if (['APPROVED', 'NONCOMPLIANT', 'EXCUSED'].includes(item.day.status)) return res.status(409).json({ error: 'O dia ja foi encerrado.' });

    const rule = production.ruleForKey(item.ruleKey);
    if (!rule) return res.status(400).json({ error: 'Regra da atividade nao encontrada.' });
    const primaryFiles = req.files?.evidence || [];
    const whatsappFiles = req.files?.whatsappEvidence || [];
    const productRefs = parseProductRefs(req.body.productRefs);
    const usedRows = await prisma.sellerProductionItem.findMany({
      where: { dayId: item.dayId, id: { not: item.id }, status: { in: ['SUBMITTED', 'APPROVED'] }, requiredProducts: { gt: 0 } },
      select: { productRefs: true },
    });
    const usedProductRefs = usedRows.flatMap((row) => row.productRefs || []);
    const payload = {
      publicationUrl: req.body.publicationUrl,
      whatsappProofUrl: req.body.whatsappProofUrl,
      durationSeconds: req.body.durationSeconds,
      productRefs,
      requirementsConfirmedJson: req.body.requirementsConfirmedJson,
      noInstagramStoryConfirmed: parseBoolean(req.body.noInstagramStoryConfirmed),
    };
    const errors = production.validateSubmission(rule, payload, {
      evidenceMediaTypes: primaryFiles.map((file) => file.mimetype.startsWith('image/') ? 'photo' : 'video'),
      evidenceKinds: whatsappFiles.length ? ['WHATSAPP_PROOF'] : [],
      usedProductRefs,
    });
    if (errors.length) return res.status(400).json({ error: errors.join(' '), errors });

    for (const file of primaryFiles) savedFiles.push({ kind: 'PRIMARY', ...evidenceStore.save(file) });
    for (const file of whatsappFiles) savedFiles.push({ kind: 'WHATSAPP_PROOF', ...evidenceStore.save(file) });

    await prisma.$transaction(async (tx) => {
      const claimed = await tx.sellerProductionItem.updateMany({
        where: { id: item.id, status: { in: ['PENDING', 'REJECTED'] } },
        data: {
          status: 'SUBMITTED',
          note: String(req.body.note || '').trim().slice(0, 4000) || null,
          publicationUrl: String(req.body.publicationUrl || '').trim().slice(0, 1000) || null,
          whatsappProofUrl: String(req.body.whatsappProofUrl || '').trim().slice(0, 1000) || null,
          durationSeconds: req.body.durationSeconds ? Number(req.body.durationSeconds) : null,
          productRefs,
          requirementsConfirmedJson: JSON.stringify(production.parseConfirmations(req.body.requirementsConfirmedJson)),
          noInstagramStoryConfirmed: parseBoolean(req.body.noInstagramStoryConfirmed),
          submittedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
        },
      });
      if (claimed.count !== 1) throw new Error('Atividade alterada por outra operacao. Atualize a tela.');
      if (savedFiles.length) {
        await tx.sellerProductionEvidence.createMany({ data: savedFiles.map((file) => ({ itemId: item.id, ...file })) });
      }
      await tx.sellerProductionDay.update({ where: { id: item.dayId }, data: { status: 'OPEN', submittedAt: null } });
    });

    const updated = await prisma.sellerProductionDay.findUnique({ where: { id: item.dayId }, include: dayInclude() });
    res.json({ ok: true, day: serializeDay(updated) });
  } catch (err) {
    for (const file of savedFiles) evidenceStore.remove(file.storedName);
    console.error('[seller-production/item-submit]', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar atividade.' });
  }
});

router.post('/days/:dayId/submit', requireSellerScope, async (req, res) => {
  try {
    const day = await prisma.sellerProductionDay.findUnique({ where: { id: req.params.dayId }, include: { items: true } });
    if (!day || req.userRole !== 'seller' || day.sellerId !== req.userId) return res.status(403).json({ error: 'Sem acesso a este dia.' });
    if (!['OPEN', 'CHANGES_REQUIRED'].includes(day.status)) return res.status(409).json({ error: 'Este dia ja foi enviado ou encerrado.' });
    const progress = production.dayProgress(day.items);
    if (progress.pending || progress.rejected) return res.status(400).json({ error: 'Envie ou corrija todas as atividades antes de finalizar o dia.' });
    if (progress.submitted + progress.approved !== progress.total) return res.status(400).json({ error: 'O checklist diario esta incompleto.' });
    const updated = await prisma.sellerProductionDay.update({
      where: { id: day.id },
      data: { status: 'SUBMITTED', sellerNote: String(req.body.note || '').trim().slice(0, 4000) || null, submittedAt: new Date() },
      include: dayInclude(),
    });
    res.json({ ok: true, day: serializeDay(updated) });
  } catch (err) {
    console.error('[seller-production/day-submit]', err);
    res.status(500).json({ error: 'Erro ao enviar o dia para fiscalizacao.' });
  }
});

router.get('/review-queue', requireReviewer, async (req, res) => {
  try {
    await ensureScheduledProductionDays();
    const where = {
      status: { notIn: ['APPROVED', 'NONCOMPLIANT', 'EXCUSED'] },
    };
    if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
    else if (req.query.storeId) where.storeId = String(req.query.storeId);
    if (req.query.sellerId) where.sellerId = String(req.query.sellerId);
    if (req.query.date) {
      const date = dateFromYmd(req.query.date);
      if (!date) return res.status(400).json({ error: 'Data invalida.' });
      where.workDate = date;
    }
    const sellerWhere = { role: 'seller', active: true, schedules: { none: { active: true } } };
    if (req.scope?.isStoreLocked) sellerWhere.OR = [{ storeId: req.scope.storeId }, { storeIds: { has: req.scope.storeId } }];
    const [days, unconfiguredSellers] = await Promise.all([
      prisma.sellerProductionDay.findMany({ where, orderBy: [{ workDate: 'asc' }, { createdAt: 'asc' }], take: 100, include: dayInclude() }),
      prisma.user.findMany({ where: sellerWhere, orderBy: { name: 'asc' }, select: { id: true, name: true, employeeCode: true } }),
    ]);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ days: days.filter((day) => day.sellerId !== req.userId).map(serializeDay), unconfiguredSellers });
  } catch (err) {
    console.error('[seller-production/review-queue]', err);
    res.status(500).json({ error: 'Erro ao carregar fila de fiscalizacao.' });
  }
});

router.post('/items/:itemId/review', requireReviewer, async (req, res) => {
  try {
    const action = String(req.body.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) return res.status(400).json({ error: 'Acao invalida.' });
    const reviewNote = String(req.body.note || '').trim().slice(0, 4000);
    if (action === 'REJECT' && !reviewNote) return res.status(400).json({ error: 'Informe claramente o que precisa ser corrigido.' });
    const item = await prisma.sellerProductionItem.findUnique({ where: { id: req.params.itemId }, include: { day: true } });
    if (!item || !canReviewDay(req, item.day)) return res.status(403).json({ error: 'Sem permissao para fiscalizar esta atividade.' });
    if (item.status !== 'SUBMITTED') return res.status(409).json({ error: 'A atividade nao esta aguardando fiscalizacao.' });

    await prisma.sellerProductionItem.update({
      where: { id: item.id },
      data: {
        status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewedById: req.userId,
        reviewedAt: new Date(),
        reviewNote: reviewNote || 'Atividade conferida e aprovada.',
      },
    });
    const rows = await prisma.sellerProductionItem.findMany({ where: { dayId: item.dayId }, select: { status: true } });
    const progress = production.dayProgress(rows);
    const dayStatus = progress.rejected ? 'CHANGES_REQUIRED' : (progress.complete ? 'SUBMITTED' : 'OPEN');
    const updated = await prisma.sellerProductionDay.update({ where: { id: item.dayId }, data: { status: dayStatus }, include: dayInclude() });
    res.json({ ok: true, day: serializeDay(updated) });
  } catch (err) {
    console.error('[seller-production/item-review]', err);
    res.status(500).json({ error: 'Erro ao fiscalizar atividade.' });
  }
});

router.post('/days/:dayId/finalize', requireReviewer, async (req, res) => {
  try {
    const action = String(req.body.action || '').toUpperCase();
    if (!['APPROVE', 'NONCOMPLIANT', 'EXCUSE'].includes(action)) return res.status(400).json({ error: 'Acao de fechamento invalida.' });
    const note = String(req.body.note || '').trim().slice(0, 4000);
    if (action !== 'APPROVE' && !note) return res.status(400).json({ error: 'Informe o motivo do fechamento.' });
    const day = await prisma.sellerProductionDay.findUnique({ where: { id: req.params.dayId }, include: dayInclude() });
    if (!day || !canReviewDay(req, day)) return res.status(403).json({ error: 'Sem permissao para fechar este dia.' });
    if (['APPROVED', 'NONCOMPLIANT', 'EXCUSED'].includes(day.status)) return res.status(409).json({ error: 'Este dia ja foi encerrado.' });
    const progress = production.dayProgress(day.items);
    if (action === 'APPROVE' && !progress.complete) return res.status(400).json({ error: 'Todas as atividades precisam estar aprovadas antes de aprovar o dia.' });

    const status = action === 'APPROVE' ? 'APPROVED' : (action === 'EXCUSE' ? 'EXCUSED' : 'NONCOMPLIANT');
    await prisma.$transaction(async (tx) => {
      await tx.sellerProductionDay.update({
        where: { id: day.id },
        data: { status, finalNote: note || 'Todas as atividades foram fiscalizadas e aprovadas.', finalizedById: req.userId, finalizedAt: new Date() },
      });
      if (status === 'NONCOMPLIANT') {
        await tx.sellerComplianceIncident.upsert({
          where: { dayId: day.id },
          update: { status: 'AWAITING_RESPONSE', summary: note, decision: null, decisionReason: null, decidedById: null, decidedAt: null },
          create: { dayId: day.id, sellerId: day.sellerId, storeId: day.storeId, status: 'AWAITING_RESPONSE', summary: note, recommendedAction: 'MANUAL_REVIEW' },
        });
        if (!day.incident) {
          await tx.message.create({
            data: {
              fromId: req.userId,
              toId: day.sellerId,
              type: 'announcement',
              title: 'Comunicado de descumprimento — produção diária',
              content: `${note}\n\nAcesse Produção diária no TenisCash para consultar o registro e apresentar sua justificativa.`,
              priority: 'high',
            },
          });
        }
      } else if (day.incident) {
        await tx.sellerComplianceIncident.update({ where: { id: day.incident.id }, data: { status: 'CLOSED_NO_ACTION', decision: 'NO_ACTION', decisionReason: note || 'Dia regularizado ou justificado.', decidedById: req.userId, decidedAt: new Date() } });
      }
    });
    const updated = await prisma.sellerProductionDay.findUnique({ where: { id: day.id }, include: dayInclude() });
    res.json({ ok: true, day: serializeDay(updated) });
  } catch (err) {
    console.error('[seller-production/day-finalize]', err);
    res.status(500).json({ error: 'Erro ao fechar producao diaria.' });
  }
});

router.get('/evidence/:evidenceId', requireSellerScope, async (req, res) => {
  try {
    const evidence = await prisma.sellerProductionEvidence.findUnique({
      where: { id: req.params.evidenceId },
      include: { item: { include: { day: true } } },
    });
    if (!evidence || !canViewDay(req, evidence.item.day)) return res.status(404).json({ error: 'Evidencia nao encontrada.' });
    const filePath = evidenceStore.resolve(evidence.storedName);
    if (!filePath) return res.status(404).json({ error: 'Arquivo nao encontrado.' });
    await prisma.sellerPrivateAccessLog.create({ data: { actorId: req.userId, resourceType: 'PRODUCTION_EVIDENCE', resourceId: evidence.id } });
    res.type(evidence.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[seller-production/evidence]', err);
    res.status(500).json({ error: 'Erro ao abrir evidencia.' });
  }
});

router.get('/monthly-overview', requireReviewer, async (req, res) => {
  try {
    const month = String(req.query.month || localYmd().slice(0, 7));
    const bounds = monthBounds(month);
    if (!bounds) return res.status(400).json({ error: 'Mes invalido. Use YYYY-MM.' });
    const sellerWhere = { role: 'seller', active: true };
    if (req.scope?.isStoreLocked) sellerWhere.OR = [{ storeId: req.scope.storeId }, { storeIds: { has: req.scope.storeId } }];
    const sellers = await prisma.user.findMany({ where: sellerWhere, orderBy: { name: 'asc' }, select: { id: true, name: true, employeeCode: true, baseSalary: true } });
    const days = sellers.length ? await prisma.sellerProductionDay.findMany({ where: { sellerId: { in: sellers.map((seller) => seller.id) }, workDate: { gte: bounds.start, lt: bounds.end } }, select: { sellerId: true, status: true } }) : [];
    const currentMonth = localYmd().slice(0, 7);
    const rows = sellers.map((seller) => {
      const sellerDays = days.filter((day) => day.sellerId === seller.id);
      const summary = production.monthlyEligibility(sellerDays, seller.baseSalary, { periodClosed: month < currentMonth });
      return { sellerId: seller.id, sellerName: seller.name, employeeCode: seller.employeeCode, ...summary };
    });
    res.json({ month, incentivePct: production.INCENTIVE_PCT, rows, payrollWarning: 'Resultado informativo. Nenhum valor e lancado ou retirado da folha automaticamente.' });
  } catch (err) {
    console.error('[seller-production/monthly-overview]', err);
    res.status(500).json({ error: 'Erro ao calcular o fechamento mensal.' });
  }
});

router.get('/months/:month', requireSellerScope, async (req, res) => {
  try {
    const bounds = monthBounds(req.params.month);
    if (!bounds) return res.status(400).json({ error: 'Mes invalido. Use YYYY-MM.' });
    const sellerId = req.userRole === 'seller' ? req.userId : String(req.query.sellerId || '');
    if (!sellerId) return res.status(400).json({ error: 'Informe o vendedor.' });
    const seller = await prisma.user.findUnique({ where: { id: sellerId }, select: { id: true, name: true, baseSalary: true, storeId: true, storeIds: true } });
    if (!seller) return res.status(404).json({ error: 'Vendedor nao encontrado.' });
    if (req.scope?.isStoreLocked && !new Set([seller.storeId, ...(seller.storeIds || [])].filter(Boolean)).has(req.scope.storeId)) return res.status(403).json({ error: 'Vendedor fora da loja.' });
    const days = await prisma.sellerProductionDay.findMany({ where: { sellerId, workDate: { gte: bounds.start, lt: bounds.end } }, orderBy: { workDate: 'asc' }, include: dayInclude() });
    const currentMonth = localYmd().slice(0, 7);
    const summary = production.monthlyEligibility(days, seller.baseSalary, { periodClosed: req.params.month < currentMonth });
    const monthRow = await prisma.sellerProductionMonth.upsert({
      where: { sellerId_month: { sellerId, month: req.params.month } },
      update: { ...summary, baseSalarySnapshot: seller.baseSalary, calculatedAt: new Date() },
      create: { sellerId, month: req.params.month, ...summary, baseSalarySnapshot: seller.baseSalary, calculatedAt: new Date() },
    });
    res.json({ seller, month: monthRow, days: days.map(serializeDay), payrollWarning: 'Elegibilidade informativa. Nenhum valor e lancado na folha automaticamente.' });
  } catch (err) {
    console.error('[seller-production/month]', err);
    res.status(500).json({ error: 'Erro ao calcular fechamento mensal.' });
  }
});

router.get('/incidents/list', requireSellerScope, async (req, res) => {
  try {
    const where = {};
    if (req.userRole === 'seller') where.sellerId = req.userId;
    else if (req.query.sellerId) where.sellerId = String(req.query.sellerId);
    if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
    if (req.query.status) where.status = String(req.query.status);
    const incidents = await prisma.sellerComplianceIncident.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        seller: { select: { id: true, name: true, employeeCode: true } },
        store: { select: { id: true, name: true, code: true } },
        day: { select: { id: true, workDate: true, status: true, finalNote: true } },
      },
    });
    res.json({ incidents });
  } catch (err) {
    console.error('[seller-production/incidents]', err);
    res.status(500).json({ error: 'Erro ao carregar comunicados.' });
  }
});

router.post('/incidents/:incidentId/respond', requireSellerScope, async (req, res) => {
  try {
    const response = String(req.body.response || '').trim().slice(0, 6000);
    if (!response) return res.status(400).json({ error: 'Escreva sua justificativa ou manifestacao.' });
    const incident = await prisma.sellerComplianceIncident.findUnique({ where: { id: req.params.incidentId } });
    if (!incident || req.userRole !== 'seller' || incident.sellerId !== req.userId) return res.status(403).json({ error: 'Sem acesso a este comunicado.' });
    if (!['AWAITING_RESPONSE', 'UNDER_REVIEW'].includes(incident.status)) return res.status(409).json({ error: 'Este comunicado ja foi encerrado.' });
    const updated = await prisma.sellerComplianceIncident.update({ where: { id: incident.id }, data: { sellerResponse: response, respondedAt: new Date(), acknowledgedAt: new Date(), status: 'UNDER_REVIEW' } });
    res.json({ ok: true, incident: updated });
  } catch (err) {
    console.error('[seller-production/incident-response]', err);
    res.status(500).json({ error: 'Erro ao registrar manifestacao.' });
  }
});

router.post('/incidents/:incidentId/decide', requireReviewer, async (req, res) => {
  try {
    const decision = String(req.body.decision || '').toUpperCase();
    const reason = String(req.body.reason || '').trim().slice(0, 6000);
    if (!DECISIONS.has(decision)) return res.status(400).json({ error: 'Decisao invalida.' });
    if (!reason) return res.status(400).json({ error: 'Fundamente a decisao com os fatos analisados.' });
    const incident = await prisma.sellerComplianceIncident.findUnique({ where: { id: req.params.incidentId }, include: { day: true } });
    if (!incident || !canReviewDay(req, incident.day)) return res.status(403).json({ error: 'Sem permissao para analisar este comunicado.' });
    if (incident.decision) return res.status(409).json({ error: 'Este fato ja recebeu uma decisao. A mesma ocorrencia nao pode ser punida novamente.' });
    const needsSellerResponse = ['WARNING', 'SUSPENSION_3_REVIEW', 'SUSPENSION_5_REVIEW', 'TERMINATION_REVIEW'].includes(decision);
    if (needsSellerResponse && !incident.sellerResponse) return res.status(409).json({ error: 'Aguarde e analise a manifestacao do vendedor antes de encaminhar uma medida disciplinar.' });
    const isLegalReview = decision.startsWith('SUSPENSION_') || decision === 'TERMINATION_REVIEW';
    const updated = await prisma.sellerComplianceIncident.update({
      where: { id: incident.id },
      data: {
        decision,
        decisionReason: reason,
        decidedById: req.userId,
        decidedAt: new Date(),
        status: isLegalReview ? 'UNDER_REVIEW' : (decision === 'NO_ACTION' ? 'CLOSED_NO_ACTION' : 'DECIDED'),
      },
    });
    res.json({
      ok: true,
      incident: updated,
      appliedAutomatically: false,
      warning: isLegalReview ? 'A medida nao foi aplicada. Exige validacao trabalhista e ato formal da empresa.' : null,
    });
  } catch (err) {
    console.error('[seller-production/incident-decision]', err);
    res.status(500).json({ error: 'Erro ao registrar decisao.' });
  }
});

// Solicitações diretas de materiais, manutenção, produtos e equipamentos.
router.get('/requests', requireSellerScope, async (req, res) => {
  try {
    const where = {};
    if (req.userRole === 'seller') where.sellerId = req.userId;
    else if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
    if (req.query.status && REQUEST_STATUSES.has(String(req.query.status).toUpperCase())) where.status = String(req.query.status).toUpperCase();
    const requests = await prisma.sellerInternalRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        seller: { select: { id: true, name: true, employeeCode: true } },
        store: { select: { id: true, name: true, code: true } },
        attachments: true,
      },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ requests: requests.map((row) => ({ ...row, attachments: row.attachments.map(attachmentSummary) })) });
  } catch (err) {
    console.error('[seller-production/requests]', err);
    res.status(500).json({ error: 'Erro ao carregar solicitações internas.' });
  }
});

router.post('/requests', requireSellerScope, privateUpload, async (req, res) => {
  let created = null;
  let savedAttachments = [];
  try {
    if (req.userRole !== 'seller') return res.status(403).json({ error: 'Somente o vendedor pode abrir uma solicitação por este canal.' });
    const category = String(req.body.category || '').toUpperCase();
    const urgency = String(req.body.urgency || 'NORMAL').toUpperCase();
    const title = String(req.body.title || '').trim().slice(0, 160);
    const description = String(req.body.description || '').trim().slice(0, 6000);
    if (!REQUEST_CATEGORIES.has(category)) return res.status(400).json({ error: 'Categoria de solicitação inválida.' });
    if (!REQUEST_URGENCIES.has(urgency)) return res.status(400).json({ error: 'Urgência inválida.' });
    if (!title || !description) return res.status(400).json({ error: 'Informe o título e descreva claramente o que precisa.' });
    const resolved = await resolveSellerAndStore(req.userId, req.body.storeId || undefined);
    created = await prisma.sellerInternalRequest.create({
      data: { sellerId: req.userId, storeId: resolved.storeId, category, urgency, title, description },
    });
    savedAttachments = await savePrivateAttachments(req.files, { requestId: created.id });
    await notifyCompany({
      fromId: req.userId,
      storeId: resolved.storeId,
      title: `Solicitação interna — ${title}`,
      content: `O vendedor ${resolved.seller.name} registrou uma solicitação no canal direto do TenisCash. Categoria: ${category}. Consulte o módulo Produção para responder.`,
      priority: urgency === 'URGENT' ? 'urgent' : (urgency === 'HIGH' ? 'high' : 'normal'),
    }).catch((notifyError) => console.error('[seller-production/request-notify]', notifyError.message));
    const request = await prisma.sellerInternalRequest.findUnique({ where: { id: created.id }, include: { attachments: true, store: { select: { id: true, name: true, code: true } } } });
    res.status(201).json({ ok: true, request: { ...request, attachments: request.attachments.map(attachmentSummary) } });
  } catch (err) {
    if (created) await prisma.sellerInternalRequest.delete({ where: { id: created.id } }).catch(() => {});
    for (const file of savedAttachments) evidenceStore.remove(file.storedName);
    console.error('[seller-production/request-create]', err);
    res.status(500).json({ error: err.message || 'Erro ao registrar solicitação.' });
  }
});

router.patch('/requests/:requestId', requireReviewer, async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    const companyResponse = String(req.body.companyResponse || '').trim().slice(0, 6000);
    if (!REQUEST_STATUSES.has(status)) return res.status(400).json({ error: 'Situação inválida.' });
    if (!companyResponse) return res.status(400).json({ error: 'Registre a resposta da empresa.' });
    const request = await prisma.sellerInternalRequest.findUnique({ where: { id: req.params.requestId } });
    if (!request || !canReviewStore(req, request.storeId)) return res.status(403).json({ error: 'Sem acesso a esta solicitação.' });
    const updated = await prisma.sellerInternalRequest.update({
      where: { id: request.id },
      data: { status, companyResponse, reviewedById: req.userId, reviewedAt: new Date() },
    });
    await prisma.message.create({
      data: {
        fromId: req.userId,
        toId: request.sellerId,
        type: 'request',
        title: `Resposta à solicitação — ${request.title}`,
        content: companyResponse,
        status: status === 'RESOLVED' ? 'approved' : (status === 'REJECTED' ? 'rejected' : 'replied'),
      },
    });
    res.json({ ok: true, request: updated });
  } catch (err) {
    console.error('[seller-production/request-review]', err);
    res.status(500).json({ error: 'Erro ao responder solicitação.' });
  }
});

// Canal confidencial para ofensa ou má conduta.
router.get('/conduct-reports', requireSellerScope, async (req, res) => {
  try {
    if (req.userRole !== 'seller' && !CONDUCT_REVIEWER_ROLES.has(req.userRole)) return res.status(403).json({ error: 'Canal confidencial restrito.' });
    const where = req.userRole === 'seller' ? { reporterId: req.userId } : {};
    if (req.query.status && CONDUCT_STATUSES.has(String(req.query.status).toUpperCase())) where.status = String(req.query.status).toUpperCase();
    const reports = await prisma.sellerConductReport.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        reporter: { select: { id: true, name: true, employeeCode: true } },
        store: { select: { id: true, name: true, code: true } },
        attachments: true,
      },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ reports: reports.map((row) => ({ ...row, attachments: row.attachments.map(attachmentSummary) })) });
  } catch (err) {
    console.error('[seller-production/conduct-reports]', err);
    res.status(500).json({ error: 'Erro ao carregar o canal confidencial.' });
  }
});

router.post('/conduct-reports', requireSellerScope, privateUpload, async (req, res) => {
  let created = null;
  let savedAttachments = [];
  try {
    if (req.userRole !== 'seller') return res.status(403).json({ error: 'Somente o próprio vendedor pode registrar um relato por este canal.' });
    const category = String(req.body.category || '').toUpperCase();
    const description = String(req.body.description || '').trim().slice(0, 10000);
    const involvedPerson = String(req.body.involvedPerson || '').trim().slice(0, 200) || null;
    if (!CONDUCT_CATEGORIES.has(category)) return res.status(400).json({ error: 'Categoria de relato inválida.' });
    if (description.length < 10) return res.status(400).json({ error: 'Descreva o ocorrido com informações suficientes para análise.' });
    let occurredAt = null;
    if (req.body.occurredAt) {
      occurredAt = new Date(req.body.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) return res.status(400).json({ error: 'Data do ocorrido inválida.' });
    }
    const resolved = await resolveSellerAndStore(req.userId, req.body.storeId || undefined);
    created = await prisma.sellerConductReport.create({
      data: { reporterId: req.userId, storeId: resolved.storeId, category, description, involvedPerson, occurredAt },
    });
    savedAttachments = await savePrivateAttachments(req.files, { reportId: created.id });
    await notifyCompany({
      fromId: req.userId,
      storeId: resolved.storeId,
      title: 'Novo relato confidencial de conduta',
      content: 'Um novo relato confidencial foi registrado no TenisCash. O conteúdo deve ser consultado exclusivamente por administrador autorizado no módulo Produção.',
      priority: 'high',
      conduct: true,
    }).catch((notifyError) => console.error('[seller-production/conduct-notify]', notifyError.message));
    const report = await prisma.sellerConductReport.findUnique({ where: { id: created.id }, include: { attachments: true } });
    res.status(201).json({ ok: true, report: { ...report, attachments: report.attachments.map(attachmentSummary) } });
  } catch (err) {
    if (created) await prisma.sellerConductReport.delete({ where: { id: created.id } }).catch(() => {});
    for (const file of savedAttachments) evidenceStore.remove(file.storedName);
    console.error('[seller-production/conduct-create]', err);
    res.status(500).json({ error: err.message || 'Erro ao registrar relato confidencial.' });
  }
});

router.patch('/conduct-reports/:reportId', requireConductReviewer, async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    const companyResponse = String(req.body.companyResponse || '').trim().slice(0, 10000);
    if (!CONDUCT_STATUSES.has(status)) return res.status(400).json({ error: 'Situação inválida.' });
    if (!companyResponse) return res.status(400).json({ error: 'Registre a providência ou resposta da empresa.' });
    const report = await prisma.sellerConductReport.findUnique({ where: { id: req.params.reportId } });
    if (!report) return res.status(404).json({ error: 'Relato não encontrado.' });
    const updated = await prisma.sellerConductReport.update({
      where: { id: report.id },
      data: { status, companyResponse, reviewedById: req.userId, reviewedAt: new Date() },
    });
    await prisma.sellerPrivateAccessLog.create({ data: { actorId: req.userId, resourceType: 'CONDUCT_REPORT', resourceId: report.id, action: 'REVIEW' } });
    await prisma.message.create({
      data: {
        fromId: req.userId,
        toId: report.reporterId,
        type: 'announcement',
        title: 'Atualização no seu relato confidencial',
        content: 'A administração registrou uma atualização no relato confidencial. Consulte o canal privado no módulo Produção diária.',
        priority: 'high',
      },
    }).catch((notifyError) => console.error('[seller-production/conduct-response-notify]', notifyError.message));
    res.json({ ok: true, report: updated });
  } catch (err) {
    console.error('[seller-production/conduct-review]', err);
    res.status(500).json({ error: 'Erro ao analisar relato confidencial.' });
  }
});

router.get('/private-attachments/:attachmentId', requireSellerScope, async (req, res) => {
  try {
    const attachment = await prisma.sellerPrivateAttachment.findUnique({
      where: { id: req.params.attachmentId },
      include: { request: true, report: true },
    });
    if (!attachment) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    let allowed = false;
    let resourceType = 'PRIVATE_ATTACHMENT';
    if (attachment.request) {
      allowed = attachment.request.sellerId === req.userId || canReviewStore(req, attachment.request.storeId);
      resourceType = 'REQUEST_ATTACHMENT';
    } else if (attachment.report) {
      allowed = attachment.report.reporterId === req.userId || CONDUCT_REVIEWER_ROLES.has(req.userRole);
      resourceType = 'CONDUCT_ATTACHMENT';
    }
    if (!allowed) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    const filePath = evidenceStore.resolve(attachment.storedName);
    if (!filePath) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    await prisma.sellerPrivateAccessLog.create({ data: { actorId: req.userId, resourceType, resourceId: attachment.id } });
    res.type(attachment.mimeType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[seller-production/private-attachment]', err);
    res.status(500).json({ error: 'Erro ao abrir arquivo privado.' });
  }
});

module.exports = router;
