const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { authMiddleware, storeScope, enforceStoreId, prisma } = require('../middleware');
const pagbank = require('../services/pagbank');
const equipeReports = require('../services/equipeReports');
const { SaleStockError, planSaleProductSize, applyStoreStockDelta } = require('../services/storeStockLedger');
const relationshipCommission = require('../services/relationshipCommission');
const commissionEvidenceStore = require('../services/commissionEvidenceStore');

const router = express.Router();

function normalizeSellerReportedSize(value) {
  return String(value == null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(',', '.')
    .replace(/\s+/g, '')
    .slice(0, 20) || null;
}

const commissionEvidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024, files: 7 },
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime))$/i.test(file.mimetype);
    cb(ok ? null : new Error('Envie foto JPG/PNG/WebP ou video MP4/WebM/MOV.'), ok);
  },
});

function sellerOnly(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor / loja' });
  }
  next();
}

function commissionReviewerOnly(req, res, next) {
  if (!['admin', 'superadmin', 'manager', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao fiscalizador de comissoes' });
  }
  next();
}

function canReviewRelationshipJourney(req, journey) {
  if (!journey || journey.sellerId === req.userId) return false;
  if (req.scope?.isStoreLocked) return journey.storeId === req.scope.storeId;
  return ['admin', 'superadmin', 'manager', 'store'].includes(req.userRole);
}

function relationshipScopeWhere(req, requestedSellerId) {
  const where = {};
  if (req.userRole === 'seller') where.sellerId = req.userId;
  else if (requestedSellerId) where.sellerId = String(requestedSellerId);
  if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
  return where;
}

function canViewRelationshipJourney(req, journey) {
  if (!journey) return false;
  if (req.userRole === 'seller') return journey.sellerId === req.userId;
  if (req.scope?.isStoreLocked) return journey.storeId === req.scope.storeId;
  return ['admin', 'superadmin', 'manager', 'store'].includes(req.userRole);
}

function normalizeSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

async function addCommissionEvidenceIntegrityChecks(savedFile, { sellerId, expectedMediaType, batchHashes }) {
  const duplicateInBatch = batchHashes.has(savedFile.sha256);
  const prior = duplicateInBatch ? null : await prisma.sellerCommissionEvidence.findFirst({
    where: { sha256: savedFile.sha256, stage: { journey: { sellerId } } },
    select: { id: true, createdAt: true },
  });
  const exactDuplicateDetected = duplicateInBatch || !!prior;
  batchHashes.add(savedFile.sha256);
  return {
    ...savedFile,
    automatedStatus: exactDuplicateDetected ? 'FLAGGED_DUPLICATE' : 'TECHNICALLY_VALID',
    automatedChecks: {
      checkedAt: new Date().toISOString(),
      hashCaptured: true,
      exactDuplicateDetected,
      duplicateEvidenceId: prior?.id || null,
      expectedMediaType: expectedMediaType || null,
      mediaTypeMatches: !expectedMediaType || savedFile.mediaType === expectedMediaType,
      fileNonEmpty: savedFile.bytes > 0,
      visualContentChecked: false,
      humanReviewRequired: true,
    },
  };
}

function parseRelationshipMoneySearch(value) {
  const raw = String(value || '').trim().replace(/^r\$\s*/i, '');
  if (!/^\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?$|^\d+(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? relationshipCommission.round2(amount) : null;
}

function addRelationshipSearch(where, rawQuery) {
  const terms = String(rawQuery || '').replace(/r\$\s*/ig, '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return;
  where.AND = terms.map((term) => {
    const amount = parseRelationshipMoneySearch(term);
    const OR = [
      { customerName: { contains: term, mode: 'insensitive' } },
      { sale: { items: { some: { OR: [
        { productName: { contains: term, mode: 'insensitive' } },
        { brand: { contains: term, mode: 'insensitive' } },
        { size: { contains: term, mode: 'insensitive' } },
      ] } } } },
      { stages: { some: { OR: [
        { publicationUrl: { contains: term, mode: 'insensitive' } },
        { evidenceUrl: { contains: term, mode: 'insensitive' } },
      ] } } },
    ];
    if (amount !== null) OR.push({ baseAmount: { gte: amount - 0.004, lte: amount + 0.004 } });
    return { OR };
  });
}

function relationshipJourneyView(journey, { detail = false, canRegister = false } = {}) {
  const availability = relationshipCommission.stageAvailability(journey, journey.stages || []);
  const next = availability.find((item) => !item.completed && item.stage?.status !== 'REVERSED') || null;
  const base = {
    journeyId: journey.id, // interno para abrir o card; nunca exibido como organizacao da venda
    customer: { name: journey.customerName, phone: journey.customerPhone || null },
    seller: journey.seller ? { name: journey.seller.name } : null,
    saleDate: journey.sale.createdAt,
    paidAmount: journey.baseAmount,
    items: journey.sale.items.map((item) => ({
      name: item.productName,
      brand: item.brand,
      size: item.size,
      quantity: item.quantity,
      amount: item.totalPrice,
    })),
    cycleNumber: journey.cycleNumber,
    purchasePosition: journey.purchasePosition,
    currentPct: journey.currentPct,
    earnedAmount: journey.earnedAmount,
    reversedAmount: journey.reversedAmount,
    payableAmount: journey.status === 'CANCELED' ? 0 : relationshipCommission.round2(journey.earnedAmount),
    status: journey.status,
    progress: {
      approved: availability.filter((item) => item.stage?.status === 'COMPLETED').length,
      awaitingReview: availability.filter((item) => item.stage?.status === 'SUBMITTED').length,
      returned: availability.filter((item) => item.stage?.status === 'REJECTED').length,
      total: availability.length,
    },
    nextStage: next ? {
      key: next.key,
      title: next.title,
      targetPct: next.targetPct,
      available: next.available && canRegister,
      earliestAt: next.earliestAt,
      waitingReason: next.waitingReason,
    } : null,
    referral: journey.referralCode ? {
      code: journey.referralCode.code,
      status: journey.referralCode.status,
      convertedAt: journey.referralCode.convertedAt || null,
    } : null,
  };
  if (detail) {
    base.stages = availability.map((item) => ({
      key: item.key,
      title: item.title,
      targetPct: item.targetPct,
      status: item.stage?.status || 'PENDING',
      available: item.available && canRegister,
      earliestAt: item.earliestAt,
      waitingReason: item.waitingReason,
      note: item.stage?.note || null,
      publicationUrl: item.stage?.publicationUrl || null,
      evidenceUrl: item.stage?.evidenceUrl || null,
      customerInteracted: item.stage?.customerInteracted || false,
      consentConfirmed: item.stage?.consentConfirmed || false,
      amount: item.stage?.amount || 0,
      submittedAt: item.stage?.submittedAt || null,
      reviewedAt: item.stage?.reviewedAt || null,
      reviewNote: item.stage?.reviewNote || null,
      completedAt: item.stage?.completedAt || null,
      reversedAt: item.stage?.reversedAt || null,
      requirements: {
        media: item.media || null,
        publication: !!item.publication,
        interaction: !!item.interaction,
        consent: !!item.consent,
        referral: !!item.referral,
      },
      evidence: (item.stage?.evidence || []).map((evidence) => ({
        evidenceId: evidence.id,
        name: evidence.originalName,
        mediaType: evidence.mediaType,
        mimeType: evidence.mimeType,
        bytes: evidence.bytes,
        automatedStatus: evidence.automatedStatus,
        automatedChecks: evidence.automatedChecks || null,
      })),
    }));
  }
  return base;
}

// Aplica scope em todas as rotas do seller
router.use(authMiddleware, storeScope);

function recifeDayBounds(now = new Date()) {
  // Recife é UTC-3 (sem DST)
  const offsetMin = -180;
  const local = new Date(now.getTime() + offsetMin * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startLocalUtc = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
  const startUtc = new Date(startLocalUtc.getTime() - offsetMin * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function recifeMonthBounds(periodYYYYMM) {
  const [yStr, mStr] = String(periodYYYYMM || '').split('-');
  const y = parseInt(yStr, 10);
  const m1 = parseInt(mStr, 10);
  if (!y || !m1 || m1 < 1 || m1 > 12) return null;

  const offsetMin = -180;
  const startLocalUtc = new Date(Date.UTC(y, m1 - 1, 1, 0, 0, 0, 0));
  const startUtc = new Date(startLocalUtc.getTime() - offsetMin * 60 * 1000);

  const endLocalUtc = new Date(Date.UTC(y, m1, 1, 0, 0, 0, 0));
  const endUtc = new Date(endLocalUtc.getTime() - offsetMin * 60 * 1000);
  return { startUtc, endUtc };
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function summarizeToday(clockIns, now = new Date()) {
  const items = (clockIns || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const entry = items.find(x => x.type === 'entry');
  const exit = items.find(x => x.type === 'exit');
  const effectiveEnd = exit ? new Date(exit.timestamp) : now;

  let breakMinutes = 0;
  let lastBreakStart = null;
  for (const it of items) {
    if (it.type === 'break_start') lastBreakStart = new Date(it.timestamp);
    if (it.type === 'break_end' && lastBreakStart) {
      breakMinutes += Math.max(0, (new Date(it.timestamp) - lastBreakStart) / 60000);
      lastBreakStart = null;
    }
  }
  if (lastBreakStart) {
    breakMinutes += Math.max(0, (effectiveEnd - lastBreakStart) / 60000);
  }

  let workedMinutes = 0;
  if (entry) {
    workedMinutes = Math.max(0, (effectiveEnd - new Date(entry.timestamp)) / 60000 - breakMinutes);
  }

  const lastType = items.length ? items[items.length - 1].type : null;
  const inBreak = lastType === 'break_start';
  const hasEntry = !!entry;
  const hasExit = !!exit;

  let allowedNext = [];
  if (!hasEntry) allowedNext = ['entry'];
  else if (hasEntry && !hasExit) {
    if (inBreak) allowedNext = ['break_end', 'exit'];
    else allowedNext = ['break_start', 'exit'];
  }

  return {
    points: items.map(i => ({
      id: i.id,
      type: i.type,
      timestamp: i.timestamp,
    })),
    summary: {
      hasEntry,
      hasExit,
      inBreak,
      lastType,
      workedMinutes: Math.round(workedMinutes),
      breakMinutes: Math.round(breakMinutes),
      allowedNext,
    },
  };
}

// =====================================================================
// BATER PONTO COMO VENDEDOR (a partir do PDV institucional)
// Operador escolhe o vendedor, vendedor digita PIN pessoal pra confirmar
// =====================================================================
router.post('/clockin-as', sellerOnly, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { vendorId, pin, type, latitude, longitude, note } = req.body || {};
    let { storeId } = req.body || {};
    if (req.scope?.isStoreLocked) storeId = req.scope.storeId;

    if (!vendorId) return res.status(400).json({ error: 'Selecione o vendedor' });
    if (!pin) return res.status(400).json({ error: 'Vendedor precisa digitar PIN' });

    const allowed = new Set(['entry', 'break_start', 'break_end', 'exit']);
    if (!type || !allowed.has(type)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'GPS obrigatório' });
    }

    const vendor = await prisma.user.findUnique({
      where: { id: vendorId },
      include: { store: true },
    });
    if (!vendor || !vendor.active) return res.status(404).json({ error: 'Vendedor não encontrado' });
    if (vendor.role !== 'seller') return res.status(400).json({ error: 'Selecionado não é vendedor' });
    // Lock: PDV institucional só bate ponto de vendedor da PRÓPRIA loja
    if (req.scope?.isStoreLocked && vendor.storeId !== req.scope.storeId) {
      return res.status(403).json({ error: 'Vendedor não pertence a esta loja' });
    }

    // Confere PIN do vendedor (não do operador logado)
    const ok = await bcrypt.compare(pin, vendor.pin || '');
    if (!ok) return res.status(401).json({ error: 'PIN incorreto' });

    const finalStoreId = storeId || vendor.storeId;

    // Estado anterior do dia
    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const today = await prisma.clockIn.findMany({
      where: { userId: vendor.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    const summary = summarizeToday(today, now).summary;
    if (!summary.allowedNext.includes(type)) {
      return res.status(400).json({ error: `Ação "${type}" não permitida agora. Disponível: ${summary.allowedNext.join(', ')}` });
    }

    const created = await prisma.clockIn.create({
      data: {
        userId: vendor.id,
        storeId: finalStoreId,
        type,
        latitude,
        longitude,
        note: note || null,
      },
    });

    // Avisa o grupo da empresa em tempo real (fire-and-forget, nunca derruba a rota)
    equipeReports.notifyClockEvent({
      userId: vendor.id,
      userName: vendor.name,
      storeId: finalStoreId,
      type,
      at: created.timestamp,
    }).catch(() => {});

    res.json({
      ok: true,
      clockInId: created.id,
      vendor: { id: vendor.id, name: vendor.name },
      type,
      at: created.timestamp,
    });
  } catch (err) {
    console.error('Erro clockin-as:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// RELATÓRIO DE VENDAS PRO GRUPO — preview (não envia) e envio manual
// =====================================================================
function adminOnly(req, res, next) {
  if (!['admin', 'superadmin'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Restrito a admin' });
  }
  next();
}

// Conferir o texto do relatório sem enviar nada. ?checkpoint=13|18|21
router.get('/reports/sales/preview', adminOnly, async (req, res) => {
  try {
    const cp = parseInt(req.query.checkpoint, 10);
    const hour = [13, 18, 21].includes(cp) ? cp : 13;
    const text = await equipeReports.buildSalesReport(hour);
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Enviar AGORA pro grupo (precisa WHATSAPP_GROUP_JID configurado). body: { checkpoint }
router.post('/reports/sales/send', adminOnly, async (req, res) => {
  try {
    const cp = parseInt((req.body || {}).checkpoint, 10);
    const hour = [13, 18, 21].includes(cp) ? cp : 13;
    const out = await equipeReports.sendSalesReport(hour);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PRESENÇA — quem está na loja agora (lê o ponto). Preview (não envia) e envio manual.
router.get('/reports/presence/preview', adminOnly, async (req, res) => {
  try {
    const text = await equipeReports.buildPresenceReport();
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/reports/presence/send', adminOnly, async (req, res) => {
  try {
    const out = await equipeReports.sendPresenceReport();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// TAREFAS — cumprimento por vendedor, conforme aprovação e prazo real da escala.
router.get('/reports/tasks/preview', adminOnly, async (req, res) => {
  try {
    const text = await equipeReports.buildTaskComplianceReport(req.query.checkpoint);
    res.type('text/plain; charset=utf-8').send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.post('/reports/tasks/send', adminOnly, async (req, res) => {
  try {
    const out = await equipeReports.sendTaskComplianceReport((req.body || {}).checkpoint);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PONTO DO DIA — opcionalmente de um vendedor específico (PDV usa)
// =====================================================================
router.get('/clockin/today-of', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const vendorId = req.query.vendorId;
    if (!vendorId) return res.status(400).json({ error: 'vendorId obrigatório' });

    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const items = await prisma.clockIn.findMany({
      where: { userId: vendorId, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    res.json(summarizeToday(items, now));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clockin', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const { type, storeId, latitude, longitude, note } = req.body || {};
    const allowed = new Set(['entry', 'break_start', 'break_end', 'exit']);
    if (!type || !allowed.has(type)) {
      return res.status(400).json({ error: 'Tipo inválido. Use: entry, break_start, break_end, exit' });
    }

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        storeId: true,
        role: true,
        active: true,
        store: { select: { id: true, code: true, name: true, latitude: true, longitude: true } },
      },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const resolvedStoreId = storeId || u.storeId;
    if (!resolvedStoreId) return res.status(400).json({ error: 'Vendedor sem loja vinculada (storeId)' });

    const store = u.store || await prisma.store.findUnique({
      where: { id: resolvedStoreId },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
    });
    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
    if (typeof store.latitude !== 'number' || typeof store.longitude !== 'number') {
      return res.status(400).json({ error: 'Loja sem coordenadas configuradas' });
    }

    const distM = haversineMeters(latitude, longitude, store.latitude, store.longitude);
    if (distM > 150) {
      return res.status(403).json({ error: `Você está a ${Math.round(distM)}m da loja. Bata o ponto quando estiver dentro do raio de 150m.` });
    }

    // Validação de sequência (dia Recife)
    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const today = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    const state = summarizeToday(today, now).summary;
    if (!state.allowedNext.includes(type)) {
      return res.status(400).json({ error: `Batida inválida neste momento. Próximos permitidos: ${state.allowedNext.join(', ') || 'nenhum'}` });
    }

    const clockIn = await prisma.clockIn.create({
      data: {
        userId: u.id,
        storeId: resolvedStoreId,
        type,
        latitude,
        longitude,
        note: note ? String(note).slice(0, 280) : null,
      },
    });

    // Avisa o grupo da empresa em tempo real (fire-and-forget, nunca derruba a rota)
    equipeReports.notifyClockEvent({
      userId: u.id,
      storeId: resolvedStoreId,
      storeName: store?.name,
      type,
      at: clockIn.timestamp,
    }).catch(() => {});

    res.json({ success: true, clockIn });
  } catch (err) {
    console.error('Erro clockin:', err);
    res.status(500).json({ error: 'Erro ao registrar ponto' });
  }
});

router.get('/clockin/today', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, active: true, storeId: true },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const items = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });

    res.json(summarizeToday(items, now));
  } catch (err) {
    console.error('Erro clockin/today:', err);
    res.status(500).json({ error: 'Erro ao buscar ponto do dia' });
  }
});

router.get('/clockin/me', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, active: true },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const period = req.query.period;
    const bounds = recifeMonthBounds(period);
    if (!bounds) return res.status(400).json({ error: 'Informe period=YYYY-MM' });

    const items = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: bounds.startUtc, lt: bounds.endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });

    // Agrupa por dia local Recife (YYYY-MM-DD)
    const offsetMin = -180;
    const byDay = new Map();
    for (const it of items) {
      const local = new Date(new Date(it.timestamp).getTime() + offsetMin * 60000);
      const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(it);
    }

    const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, points]) => {
      const summary = summarizeToday(points, new Date()).summary;
      return { date, points: points.map(p => ({ id: p.id, type: p.type, timestamp: p.timestamp })), summary };
    });

    res.json({ period, days });
  } catch (err) {
    console.error('Erro clockin/me:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// =====================================================================
// VENDEDORES DA LOJA — pra escolher quem atendeu o cliente no PDV
// =====================================================================
router.get('/store-sellers', sellerOnly, async (req, res) => {
  try {
    const storeId = req.query.storeId;
    if (!storeId) return res.status(400).json({ error: 'storeId é obrigatório' });

    // Inclui o vendedor multi-loja: aparece na loja PRINCIPAL (storeId) E nas adicionais (storeIds).
    const sellers = await prisma.user.findMany({
      where: { role: 'seller', active: true, OR: [{ storeId }, { storeIds: { has: storeId } }] },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, employeeCode: true },
    });
    res.json({ sellers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// LISTA LOJAS — pra escolher onde está trabalhando hoje
// =====================================================================
router.get('/stores', sellerOnly, async (req, res) => {
  try {
    const where = { active: true };
    // VENDEDOR (role=seller) só acessa as lojas vinculadas ao cadastro dele (storeId + storeIds).
    // Admin/gerente/conta-de-loja continuam vendo todas.
    if (req.userRole === 'seller') {
      const me = await prisma.user.findUnique({ where: { id: req.userId }, select: { storeId: true, storeIds: true } });
      const ids = [...new Set([...((me && me.storeIds) || []), ...(me && me.storeId ? [me.storeId] : [])])];
      where.id = { in: ids.length ? ids : ['__none__'] };
    }
    const stores = await prisma.store.findMany({
      where,
      orderBy: { code: 'asc' },
      select: { id: true, name: true, code: true, city: true, mall: true, latitude: true, longitude: true },
    });
    res.json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// DASHBOARD DO VENDEDOR — KPIs do dia/mês
// =====================================================================
router.get('/dashboard', sellerOnly, async (req, res) => {
  try {
    const operator = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { store: true },
    });
    const { startUtc: todayStart, endUtc: todayEnd } = recifeDayBounds(new Date());
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Escopo: se logado é STORE (PDV), agrega VENDAS da PRÓPRIA loja.
    const isStoreAccount = operator?.role === 'store';
    // VENDAS: forçamos sempre a loja do operador (cada loja vê só as suas vendas)
    const storeId = isStoreAccount ? operator.storeId : (req.query.storeId || operator?.storeId);

    const baseWhere = isStoreAccount
      ? { storeId, status: { not: 'canceled' } } // dados da loja inteira (sem canceladas)
      : { sellerId: operator.id, status: { not: 'canceled' } }; // dados do vendedor pessoal (sem canceladas)

    const [salesToday, salesMonth, topSellersToday] = await Promise.all([
      prisma.sale.aggregate({
        _sum: { totalAmount: true, tcEarned: true },
        _count: { _all: true },
        where: { ...baseWhere, createdAt: { gte: todayStart, lt: todayEnd } },
      }),
      prisma.sale.aggregate({
        _sum: { totalAmount: true, tcEarned: true },
        _count: { _all: true },
        where: { ...baseWhere, createdAt: { gte: monthStart } },
      }),
      isStoreAccount ? prisma.sale.groupBy({
        by: ['sellerId'],
        _sum: { totalAmount: true },
        _count: { _all: true },
        where: { storeId, status: { not: 'canceled' }, createdAt: { gte: todayStart, lt: todayEnd } },
        orderBy: { _sum: { totalAmount: 'desc' } },
        take: 5,
      }) : Promise.resolve([]),
    ]);

    // Resolve nomes dos top vendedores do dia
    let topSellers = [];
    if (topSellersToday.length) {
      const ids = topSellersToday.map(t => t.sellerId);
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const userMap = new Map(users.map(u => [u.id, u.name]));
      topSellers = topSellersToday.map(t => ({
        sellerId: t.sellerId,
        name: userMap.get(t.sellerId) || '?',
        salesCount: t._count._all,
        salesAmount: t._sum.totalAmount || 0,
      }));
    }

    res.json({
      operator: {
        id: operator?.id,
        name: operator?.name,
        role: operator?.role,
        store: operator?.store ? { id: operator.store.id, name: operator.store.name, code: operator.store.code } : null,
      },
      scope: isStoreAccount ? 'store' : 'seller',
      today: {
        salesCount: salesToday._count._all || 0,
        salesAmount: salesToday._sum.totalAmount || 0,
        cashbackGiven: salesToday._sum.tcEarned || 0,
      },
      month: {
        salesCount: salesMonth._count._all || 0,
        salesAmount: salesMonth._sum.totalAmount || 0,
        cashbackGiven: salesMonth._sum.tcEarned || 0,
      },
      topSellersToday: topSellers,
    });
  } catch (err) {
    console.error('Erro dashboard:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// =====================================================================
// REGISTRAR VENDA — vendedor fecha venda + cliente ganha cashback
// =====================================================================
// Dedup de venda por chave de idempotência (anti duplo-clique / re-envio do mesmo carrinho). TTL 15min, em memória.
const _recentSaleKeys = new Map();
router.post('/sale', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const operatorId = req.userId; // quem operou o PDV (loja ou vendedor)
    const { customerPhone, items, paymentMethod, tcUsed, note, storeId, vendorId } = req.body || {};
    const rawReferralCode = String(req.body?.referralCode || '').trim();
    const referralCode = rawReferralCode ? rawReferralCode.toUpperCase() : null;
    if (rawReferralCode && (!/^[A-Za-z0-9_-]{1,32}$/.test(rawReferralCode) || referralCode.length > 32)) {
      return res.status(400).json({ error: 'Codigo de indicacao invalido. Confira o codigo exato.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos 1 item' });
    }

    // ANTI-DUPLICAÇÃO: se o MESMO carrinho (idemKey) já virou venda há <15min, devolve a existente
    // em vez de criar outra. Cobre duplo-clique e re-clique quando o operador acha que "não foi".
    const idemKey = req.body.idemKey ? String(req.body.idemKey).slice(0, 80) : null;
    if (idemKey) {
      const prev = _recentSaleKeys.get(idemKey);
      if (prev && Date.now() - prev.at < 15 * 60 * 1000) {
        const existing = await prisma.sale.findUnique({ where: { id: prev.saleId } }).catch(() => null);
        if (existing) {
          console.log('[sale] DUPLICATA BLOQUEADA (idemKey)', idemKey, '->', existing.id);
          return res.json({ ok: true, saleId: existing.id, id: existing.id, totalAmount: existing.totalAmount, tcEarned: existing.tcEarned, commissionsCreated: 0, duplicate: true });
        }
      }
    }

    const operator = await prisma.user.findUnique({
      where: { id: operatorId },
      include: { store: true },
    });
    if (!operator) return res.status(404).json({ error: 'Operador não encontrado' });

    // Vendedor da comissão: vem do frontend (PDV institucional escolhe quem atendeu).
    // Se NÃO veio (login pessoal de vendedor antigo), assume o próprio logado.
    // Vendedor OPCIONAL: se não escolher, a venda fecha atribuída ao operador logado (sem comissão de vendedor).
    const sellerId = vendorId || (operator.role === 'seller' ? operator.id : operatorId);
    const seller = await prisma.user.findUnique({ where: { id: sellerId } });
    if (!seller || !seller.active) return res.status(400).json({ error: 'Operador inválido' });
    // valida perfil de vendedor só quando um vendedor foi EXPLICITAMENTE escolhido
    if (vendorId && seller.role !== 'seller' && seller.role !== 'admin') return res.status(400).json({ error: 'Vendedor deve ter perfil de seller' });

    // Loja ativa: enviada pelo frontend. Fallback: loja do operador.
    // Lock: conta institucional sempre vende NA PRÓPRIA loja
    let activeStoreId = storeId || operator.storeId;
    if (req.scope?.isStoreLocked) activeStoreId = req.scope.storeId;
    if (!activeStoreId) return res.status(400).json({ error: 'Selecione a loja antes de finalizar a venda.' });
    if (activeStoreId) {
      const exists = await prisma.store.findUnique({ where: { id: activeStoreId } });
      if (!exists || !exists.active) return res.status(400).json({ error: 'Loja inválida ou inativa' });
    }
    // Vendedor escolhido precisa ser DA loja ativa (anti tunneling)
    if (vendorId && req.scope?.isStoreLocked && seller.storeId && seller.storeId !== activeStoreId) {
      return res.status(403).json({ error: 'Vendedor escolhido não pertence a esta loja' });
    }

    // Busca produtos pra montar SaleItems
    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { sizes: true },
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    let totalAmount = 0;
    const saleItemsData = items.map(item => {
      const p = productMap.get(item.productId);
      if (!p) throw new SaleStockError(`Produto ${item.productId} não encontrado`);
      const qty = parseInt(item.quantity || 1, 10);
      const unit = parseFloat(item.unitPrice || p.promoPrice || p.price);
      if (!Number.isInteger(qty) || qty < 1) throw new SaleStockError(`Quantidade inválida para ${p.name}.`);
      if (!Number.isFinite(unit) || unit < 0) throw new SaleStockError(`Preço inválido para ${p.name}.`);
      const sellerReportedSize = normalizeSellerReportedSize(item.sellerSize);
      if (!sellerReportedSize) {
        throw new SaleStockError(`Digite manualmente o tamanho de ${p.name} ao escolher o produto.`);
      }
      const sizePlan = planSaleProductSize(p, item);
      const productSize = sizePlan.productSize;
      const needsNewProductSize = sizePlan.needsNewProductSize;
      const total = unit * qty;
      totalAmount += total;
      return {
        productId: p.id,
        productSizeId: productSize?.id || null,
        productName: p.name,
        brand: p.brand || 'SEM MARCA',
        category: p.category || null,
        size: sellerReportedSize || productSize?.size || sizePlan.requestedSize || String(item.size || '').trim() || null,
        quantity: qty,
        unitPrice: unit,
        totalPrice: total,
        unitCost: p.costPrice > 0 ? p.costPrice : null,
        _needsNewProductSize: needsNewProductSize,
        _orphanBarcode: item.isNewBarcode && item.barcode ? String(item.barcode).trim() : null,
        _sellerReportedSize: sellerReportedSize,
      };
    });

    // Códigos de barras ÓRFÃOS bipados na venda (bipou, não reconheceu, o vendedor achou o produto
    // e informou o tamanho) → vincular DEPOIS da venda pra ensinar o sistema a reconhecer o código.
    const barcodeLinks = (items || [])
      .filter((i) => i.isNewBarcode && i.barcode && i.size && i.productId)
      .map((i) => ({ productId: i.productId, size: String(i.size).trim(), barcode: String(i.barcode).trim() }));

    // Desconto em R$ na venda (sem limite). Reduz os itens proporcionalmente pro cupom bater
    // (vProd = soma dos itens, vDesc=0 no agente). Só roda se desconto>0 — venda sem desconto = idêntica a hoje.
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const originalSubtotal = round2(totalAmount); // subtotal ANTES do desconto — base do teto de 10% do TenisCash
    let discountApplied = 0;
    const rawDiscount = round2(req.body.discount);
    if (rawDiscount > 0 && totalAmount > 0) {
      discountApplied = Math.min(rawDiscount, round2(totalAmount));
      const target = round2(totalAmount - discountApplied);
      const factor = target / totalAmount;
      let acc = 0;
      saleItemsData.forEach((it, idx) => {
        if (idx < saleItemsData.length - 1) { it.totalPrice = round2(it.totalPrice * factor); acc = round2(acc + it.totalPrice); }
        else { it.totalPrice = round2(target - acc); } // último item absorve o arredondamento
        it.unitPrice = it.quantity ? it.totalPrice / it.quantity : it.totalPrice; // vUnCom aceita mais decimais
      });
      totalAmount = target;
    }

    // Cliente (opcional): busca por telefone
    let customer = null;
    if (customerPhone) {
      customer = await prisma.user.findUnique({ where: { phone: String(customerPhone) } });
    }

    let referralContext = null;
    if (referralCode) {
      const referral = await prisma.sellerReferralCode.findUnique({
        where: { code: referralCode },
        include: {
          originJourney: {
            include: {
              sale: { select: { createdAt: true, status: true } },
              stages: { orderBy: { position: 'asc' } },
            },
          },
        },
      });
      if (!referral || referral.status !== 'ACTIVE' || referral.referredSaleId) {
        return res.status(400).json({ error: 'Codigo de indicacao invalido ou ja utilizado.' });
      }
      if (!customer) return res.status(400).json({ error: 'Selecione o cadastro da pessoa indicada antes de usar o codigo.' });
      if (customer.id === referral.originCustomerUserId) return res.status(400).json({ error: 'O cliente nao pode usar a propria indicacao.' });
      if (sellerId !== referral.sellerId) return res.status(400).json({ error: 'A indicacao pertence a outro vendedor.' });
      if (referral.originStoreId && activeStoreId !== referral.originStoreId) return res.status(400).json({ error: 'A indicacao pertence a outra loja.' });
      const step = relationshipCommission.stageAvailability(referral.originJourney, referral.originJourney.stages)
        .find((item) => item.key === 'REFERRAL_CONVERTED');
      if (!step?.available) return res.status(409).json({ error: step?.waitingReason || 'A etapa de indicacao ainda nao esta disponivel.' });
      referralContext = { referral, stageId: step.stage.id };
    }

    // TenisCash usado como desconto (consome saldo do cliente).
    // TETO: 10% do valor ORIGINAL da compra. Desconto na venda NÃO aumenta esse teto (regra do dono 2026-06-19).
    const maxTcUse = round2(originalSubtotal * 0.10);
    const tcConsumed = customer && tcUsed > 0 ? Math.min(parseFloat(tcUsed) || 0, customer.balance || 0, maxTcUse, totalAmount) : 0;

    // Cashback ganho: 100% do valor pago vira TenisCash (regra do dono 2026-06-19: "comprou 100, ganha 100").
    const tcEarned = customer ? round2(totalAmount - tcConsumed) : 0;

    // Transação atômica: cria venda + items + atualiza saldo do cliente
    let result;
    try {
    result = await prisma.$transaction(async (tx) => {
      // Resolve também o caso de um código novo apontando para uma numeração nova.
      for (const it of saleItemsData) {
        if (it._needsNewProductSize) {
          const ps = await tx.productSize.upsert({
            where: { productId_size: { productId: it.productId, size: it.size } },
            update: { sizeConfirmedAt: new Date() },
            create: { productId: it.productId, size: it.size, stock: 0, sizeConfirmedAt: new Date() },
          });
          it.productSizeId = ps.id;
          it.size = ps.size;
        }
        if (!it.productSizeId) throw new SaleStockError(`Tamanho não identificado para ${it.productName}.`);

        // Loja pode registrar o tamanho real de qualquer marca durante a venda. Isso nunca
        // bloqueia: a venda sempre guarda o valor informado. A variante técnica só
        // é confirmada quando o tamanho ainda não foi confirmado e não existe outra
        // variante do mesmo card com o mesmo tamanho.
        if (it._sellerReportedSize) {
          const current = await tx.productSize.findUnique({
            where: { id: it.productSizeId },
            select: { id: true, productId: true, size: true, sizeConfirmedAt: true },
          });
          if (current && !current.sizeConfirmedAt) {
            const clash = await tx.productSize.findFirst({
              where: { productId: current.productId, size: it._sellerReportedSize, id: { not: current.id } },
              select: { id: true },
            });
            if (!clash) {
              await tx.productSize.update({
                where: { id: current.id },
                data: { size: it._sellerReportedSize, sizeConfirmedAt: new Date() },
              });
              await tx.stocktakeBipe.updateMany({
                where: { productSizeId: current.id },
                data: { productSize: it._sellerReportedSize },
              });
            }
          }
        }

        if (it._orphanBarcode) {
          const owner = await tx.productSize.findFirst({ where: { barcode: it._orphanBarcode }, select: { id: true } });
          if (!owner) {
            const target = await tx.productSize.findUnique({ where: { id: it.productSizeId }, select: { barcode: true } });
            if (target && !target.barcode) {
              await tx.productSize.update({ where: { id: it.productSizeId }, data: { barcode: it._orphanBarcode } });
            }
          }
        }
      }

      const persistedItems = saleItemsData.map(({ _needsNewProductSize, _orphanBarcode, _sellerReportedSize, ...item }) => item);
      const sale = await tx.sale.create({
        data: {
          sellerId,
          customerUserId: customer?.id || null,
          storeId: activeStoreId,
          totalAmount,
          discount: discountApplied,
          tcUsed: tcConsumed,
          tcEarned,
          paymentMethod: paymentMethod || 'unknown',
          status: 'completed',
          note: note || null,
          referralCode,
          idemKey: idemKey || null,
          items: { create: persistedItems },
        },
        include: { items: true },
      });

      // Venda + baixa + razão são atômicos. Se o item ainda não foi bipado nesta loja,
      // a localização nasce negativa para deixar a divergência visível e conciliável.
      for (const it of sale.items) {
        await applyStoreStockDelta(tx, {
          storeId: activeStoreId,
          productSizeId: it.productSizeId,
          saleId: sale.id,
          saleItemId: it.id,
          quantity: -it.quantity,
          type: 'sale',
          source: 'seller_api',
          metadata: { idemKey: idemKey || null },
        });
      }
      // NÃO mexe em ProductSize.stock (= COMPRADO, total fixo da NFe de entrada).

      // Atualiza saldo do cliente (deduz tcUsed, soma tcEarned)
      if (customer) {
        await tx.user.update({
          where: { id: customer.id },
          data: { balance: { increment: tcEarned - tcConsumed } },
        });
        await tx.transaction.create({
          data: {
            type: 'sale',
            amount: tcEarned - tcConsumed,
            description: `Venda #${sale.id.slice(0, 8)} — ${seller.name}`,
            receiverId: customer.id,
            balanceAfter: (customer.balance || 0) + (tcEarned - tcConsumed),
            metadata: JSON.stringify({ saleId: sale.id, tcUsed: tcConsumed, tcEarned }),
          },
        });
      }

      // Calcula comissão por marca
      const itemsByBrand = new Map();
      for (const it of saleItemsData) {
        itemsByBrand.set(it.brand, (itemsByBrand.get(it.brand) || 0) + it.totalPrice);
      }
      const brandCommissions = vendorId ? await tx.brandCommission.findMany({
        where: { brand: { in: [...itemsByBrand.keys()] }, active: true },
      }) : []; // sem vendedor escolhido => sem comissão de vendedor
      const commissionsData = [];
      for (const bc of brandCommissions) {
        const brandSale = itemsByBrand.get(bc.brand) || 0;
        if (brandSale > 0) {
          commissionsData.push({
            saleId: sale.id,
            sellerId,
            brand: bc.brand,
            saleAmount: brandSale,
            pct: bc.commissionPct,
            amount: Math.round(brandSale * bc.commissionPct / 100 * 100) / 100,
          });
        }
      }
      if (commissionsData.length) {
        await tx.saleCommission.createMany({ data: commissionsData });
      }

      // Ciclo de relacionamento: somente com cliente e vendedor identificados.
      // Fica separado da comissao antiga por marca ate o dono decidir a substituicao.
      const relationshipSellerSelected = !!vendorId || operator.role === 'seller';
      const relationshipJourney = relationshipSellerSelected && customer
        ? await relationshipCommission.createJourneyForSale(tx, {
          sale,
          sellerId,
          customer,
          storeId: activeStoreId,
        })
        : null;

      let referralAttribution = null;
      if (referralContext) {
        const claimedCode = await tx.sellerReferralCode.updateMany({
          where: { id: referralContext.referral.id, status: 'ACTIVE', referredSaleId: null },
          data: { status: 'RESERVED', referredSaleId: sale.id, convertedAt: null },
        });
        if (claimedCode.count !== 1) throw new SaleStockError('O codigo de indicacao ja foi usado em outra venda.');
        referralAttribution = { code: referralCode, stageId: referralContext.stageId, reserved: true };
      }

      return { sale, commissionsCount: commissionsData.length, relationshipJourney, referralAttribution };
    });
    } catch (e) {
      // TRAVA DURÁVEL anti-duplicação: se 2 requisições com o MESMO idemKey correrem juntas, ou
      // re-clique após restart (que limpa o Map em memória), o índice único do banco barra a 2ª
      // (P2002) → a transação inteira faz rollback (sem estoque/cashback/comissão dobrados) e a
      // gente devolve a venda JÁ criada em vez de duplicar.
      if (e && e.code === 'P2002' && idemKey) {
        const existing = await prisma.sale.findUnique({ where: { idemKey } }).catch(() => null);
        if (existing) {
          console.log('[sale] DUPLICATA BLOQUEADA (DB idemKey)', idemKey, '->', existing.id);
          return res.json({ ok: true, saleId: existing.id, id: existing.id, totalAmount: existing.totalAmount, tcEarned: existing.tcEarned, commissionsCreated: 0, duplicate: true });
        }
      }
      throw e;
    }

    // Registra a chave de idempotência (bloqueia duplicação no re-clique do mesmo carrinho)
    if (idemKey) {
      _recentSaleKeys.set(idemKey, { saleId: result.sale.id, at: Date.now() });
      if (_recentSaleKeys.size > 2000) { const cut = Date.now() - 15 * 60 * 1000; for (const [k, v] of _recentSaleKeys) if (v.at < cut) _recentSaleKeys.delete(k); }
    }

    // A variante/código já foi resolvida dentro da venda. Aqui apenas reconhece capturas antigas.
    for (const lk of barcodeLinks) {
      try {
        await prisma.stocktakeBipe.updateMany({ where: { barcode: lk.barcode, found: false }, data: { found: true } });
      } catch (e) { console.error('[sale] reconhecer barcode órfão', lk.barcode, e.message); }
    }

    // ===== Bot "TenisCash" avisa cliente do cashback =====
    if (customer && (tcEarned - tcConsumed) > 0) {
      try {
        const sysMsg = require('../services/systemMessenger');
        sysMsg.notifyCashbackEarned(customer.id, tcEarned - tcConsumed, result.sale.id).catch(() => {});
      } catch (e) { /* ignora */ }
    }

    // ===== EMISSÃO AUTOMÁTICA DE NFCe =====
    // Tenta emitir cupom fiscal automaticamente se a loja tem FiscalIssuer
    // com CSC cadastrado. Se faltar dados ou der erro fiscal, a venda é
    // SALVA mesmo assim — operador pode emitir manualmente depois pela tela.
    let fiscalResult = null;
    try {
      const store = activeStoreId ? await prisma.store.findUnique({
        where: { id: activeStoreId },
        include: { fiscalIssuer: true },
      }) : null;

      const useAgentAuto = store?.fiscalAgentEnabled && store?.fiscalAgentUrl && store?.fiscalAgentToken;
      const pixQr = paymentMethod === 'pix' && store?.pagbankEnabled && pagbank.isConfigured(store);
      if (pixQr) {
        // PIX-QR PagBank: gera o QR na conta DESTA loja e NÃO emite agora.
        // O webhook /api/pagbank/webhook emite o cupom quando o pagamento cair.
        try {
          const webhookUrl = (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br') + '/api/pagbank/webhook';
          const pix = await pagbank.createPixOrder(store, {
            amountCents: Math.round(totalAmount * 100),
            saleId: result.sale.id,
            customerName: customer?.name || null,
            customerTaxId: customer?.cpf || null,
            notificationUrl: webhookUrl,
          });
          await prisma.sale.update({ where: { id: result.sale.id }, data: { pagbankOrderId: pix.orderId, status: 'pending_payment' } });
          fiscalResult = { pixPending: true, orderId: pix.orderId, qrText: pix.qrText, qrPngUrl: pix.qrPngUrl, expiration: pix.expiration };
        } catch (e) {
          console.error('[PIX-QR] erro ao gerar QR:', e.message);
          fiscalResult = { ok: false, pixError: true, error: 'Falha ao gerar QR PagBank: ' + e.message };
        }
      } else if (store?.fiscalIssuer?.csc && !req.body.skipFiscal && useAgentAuto) {
        const issuer = store.fiscalIssuer;
        const tPagMap = { cash: '01', credit_card: '03', debit_card: '04', pix: '17', other: '99' };
        const tPag = tPagMap[paymentMethod] || '99';
        // Pra cartão sem cAut, pula a emissão automática (operador digita depois)
        const isCard = tPag === '03' || tPag === '04';
        // CONFORMIDADE FISCAL: PIX manual (sem confirmação de pagamento) NÃO pode auto-emitir.
        // A NFC-e só pode sair APÓS o pagamento confirmado. PIX com confirmação (cardAuthCode/e2e do TEF) emite normal.
        const isPixManual = (tPag === '17') && !req.body.cardAuthCode;
        // DEFAULT da adquirente = PagBank/PagSeguro (pinpad físico das lojas).
        // Sem isso o detPag sai com CNPJ zerado. Só aplica em cartão.
        const acquirerKey = isCard ? (req.body.acquirerKey || 'PAGSEGURO') : req.body.acquirerKey;
        // IDEMPOTÊNCIA — não auto-emite se a venda já tem cupom (autorizado ou em andamento).
        // Evita dupla emissão quando o auto-emit e a rota manual disparam pra mesma venda (bug LOJA03 2026-06-04).
        const existingNfce = await prisma.fiscalDocument.findFirst({ where: { saleId: result.sale.id, docType: 'NFCE', status: { in: ['authorized', 'processing'] } } });
        // NSU ÚNICO: um código de comprovante (cartão/PIX) só pode gerar UM cupom (1 transação = 1 nota).
        const _nsu = req.body.cardAuthCode ? String(req.body.cardAuthCode).trim() : '';
        const _nsuDup = (_nsu && _nsu !== '000000') ? await prisma.fiscalDocument.findFirst({ where: { issuerId: issuer.id, paymentAuthCode: _nsu, docType: 'NFCE', status: { in: ['authorized', 'processing'] }, saleId: { not: result.sale.id } } }) : null;
        // SEFAZ-PB: NFC-e >= R$500 exige CPF/CNPJ do consumidor (rejeição 'valor total
        // superior ao permitido p/ destinatário não identificado').
        const _docCli = String(req.body.customerCpf || '').replace(/\D/g, '');
        const _docCliOk = _docCli.length === 11 || _docCli.length === 14;
        if (existingNfce) {
          fiscalResult = { ok: existingNfce.status === 'authorized', alreadyEmitted: true, number: existingNfce.number, message: 'Venda já tem cupom #' + existingNfce.number };
        } else if (_nsuDup) {
          fiscalResult = { ok: false, error: 'NSU/código ' + _nsu + ' já foi usado no cupom #' + _nsuDup.number + '. Cada transação de cartão/PIX gera UM cupom — passe de novo na maquininha pra um código novo.' };
        } else if (Number(totalAmount) >= 500 && !_docCliOk) {
          fiscalResult = { ok: false, needsCpf: true, error: 'Venda de R$ ' + Number(totalAmount).toFixed(2) + ': a SEFAZ exige CPF/CNPJ do cliente na nota a partir de R$ 500. Abra a venda na lista e emita com o CPF.' };
        } else if ((!isCard && !isPixManual) || req.body.cardAuthCode) {
          // Número robusto: nunca abaixo do maior doc já existente (evita unique-constraint travado)
          const maxDoc = await prisma.fiscalDocument.aggregate({ where: { issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1 }, _max: { number: true } });
          const nNF = Math.max(issuer.nfceNextNumber || 1, (maxDoc._max.number || 0) + 1);
          const fiscalDoc = await prisma.fiscalDocument.create({
            data: {
              issuerId: issuer.id,
              docType: 'NFCE',
              serie: issuer.nfceSerie || 1,
              number: nNF,
              status: 'processing',
              totalValue: totalAmount,
              saleId: result.sale.id,
              productIds: saleItemsData.map(i => i.productId),
              emittedById: operatorId,
              paymentMethod: tPag,
              paymentBrand: req.body.cardBrand || null,
              paymentAcquirer: acquirerKey || null,
              paymentAuthCode: req.body.cardAuthCode || null,
              paymentTpIntegra: req.body.tpIntegra || (isCard ? 2 : null),
            },
          });

          // Pega produtos completos pra ter NCM
          const fullProducts = await prisma.product.findMany({
            where: { id: { in: saleItemsData.map(i => i.productId) } },
          });
          const productById = Object.fromEntries(fullProducts.map(p => [p.id, p]));
          const fiscalItems = saleItemsData.map(si => {
            const p = productById[si.productId] || {};
            return {
              sku: p.sku || si.productId,
              name: si.productName,
              ncm: (p.ncm && /^\d{8}$/.test(p.ncm)) ? p.ncm : '64041100',
              cfop: '5102', // NFC-e ao consumidor é venda interna — força 5102 (cadastro pode ter CFOP de compra/interestadual)
              unidade: p.unidade || 'UN',
              qty: si.quantity,
              unitPrice: si.unitPrice,
            };
          });

          // Emite pelo Fiscal Agent da loja (o PFX fica NA loja; o central no Railway não tem o certificado)
          const agentClient = require('../services/fiscalAgentClient');
          const r = await agentClient.emitNFCe(store, {
            issuer,
            items: fiscalItems,
            payment: {
              tPag, valor: totalAmount,
              acquirerKey,
              tBand: req.body.cardBrand,
              cAut: req.body.cardAuthCode,
              tpIntegra: req.body.tpIntegra || 2,
            },
            customer: _docCliOk ? { cpfCnpj: _docCli, name: req.body.customerCpfName || null } : undefined,
            nNF,
          });
          if (_docCliOk) await prisma.fiscalDocument.update({ where: { id: fiscalDoc.id }, data: { recipientCnpjCpf: _docCli } }).catch(() => {});

          if (r.ok) {
            await prisma.fiscalDocument.update({
              where: { id: fiscalDoc.id },
              data: { status: 'authorized', accessKey: r.accessKey, protocol: r.protocol, xmlContent: r.xmlSigned, response: { status: r.status, motivo: r.motivo } },
            });
            await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data: { nfceNextNumber: nNF + 1 } });
            // Cupom NÃO vai mais sozinho pro WhatsApp — o vendedor envia pelo botão "📲 Enviar" (decisão do dono 2026-06-19).
          } else if (r.accessKey) {
            // Rejeitada PELA SEFAZ (tem chave) — mantém pra auditoria
            await prisma.fiscalDocument.update({
              where: { id: fiscalDoc.id },
              data: { status: 'rejected', accessKey: r.accessKey, rejectReason: r.motivo || 'Rejeitada', response: { status: r.status, motivo: r.motivo } },
            });
          } else {
            // Falhou ANTES da SEFAZ (agente/rede) — APAGA o doc pra liberar o número (sem fantasma travando)
            await prisma.fiscalDocument.delete({ where: { id: fiscalDoc.id } }).catch(() => {});
          }

          fiscalResult = {
            ok: r.ok,
            documentId: fiscalDoc.id,
            accessKey: r.accessKey,
            protocol: r.protocol,
            error: r.ok ? null : (r.error || r.motivo),
          };
        } else {
          const reason = isPixManual
            ? 'PIX sem confirmação de pagamento — emitir o cupom só DEPOIS que o PIX cair'
            : 'Cartão sem código autorização — emitir manualmente após digitar cAut';
          fiscalResult = { skipped: true, reason };
          // Marca a venda como pendente de pagamento (não fica "completed" sem cupom).
          if (isPixManual) {
            await prisma.sale.update({ where: { id: result.sale.id }, data: { status: 'pending_payment' } }).catch(() => {});
          }
        }
      } else {
        fiscalResult = { skipped: true, reason: !store?.fiscalIssuer ? 'Loja sem emissor fiscal' : !store?.fiscalIssuer?.csc ? 'Sem CSC cadastrado' : 'Loja sem Fiscal Agent — emitir manualmente pela tela' };
      }
    } catch (err) {
      console.error('[NFCe auto] erro:', err.message);
      fiscalResult = { ok: false, error: err.message };
    }

    const persistedSale = await prisma.sale.findUnique({ where: { id: result.sale.id }, select: { status: true } });
    if (persistedSale?.status === 'pending_payment') {
      await relationshipCommission.markJourneyPaymentPending(prisma, result.sale.id).catch(() => {});
    }
    if (persistedSale?.status === 'completed' && result.referralAttribution?.reserved) {
      result.referralAttribution = await relationshipCommission.submitReservedReferralAfterPayment(prisma, result.sale.id);
    }

    res.json({
      ok: true,
      saleId: result.sale.id,
      id: result.sale.id,
      totalAmount,
      tcUsed: tcConsumed,
      tcEarned,
      commissionsCreated: result.commissionsCount,
      relationshipCommissionCreated: !!result.relationshipJourney,
      referralSubmittedForReview: !!result.referralAttribution?.submitted,
      referralReservedPendingPayment: !!result.referralAttribution?.reserved && persistedSale?.status === 'pending_payment',
      customer: customer ? { id: customer.id, name: customer.name, newBalance: (customer.balance || 0) + (tcEarned - tcConsumed) } : null,
      fiscal: fiscalResult,
    });
  } catch (err) {
    console.error('Erro registrar venda:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// =====================================================================
// HISTÓRICO DE VENDAS — com filtros (vendedor, datas)
// LOCK por loja: cada loja só vê as próprias vendas
// =====================================================================
router.get('/sales', sellerOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { sellerId, from, to, q } = req.query;

    const where = {};
    // VENDAS travadas por loja (regra do dono)
    if (req.scope?.isStoreLocked) where.storeId = req.scope.storeId;
    else if (req.query.storeId) where.storeId = req.query.storeId;

    if (sellerId) where.sellerId = sellerId;
    if (req.scope?.isSellerLocked) where.sellerId = req.userId; // vendedor pessoal só vê próprias

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from + 'T00:00:00-03:00');
      if (to) where.createdAt.lt = new Date(to + 'T23:59:59-03:00');
    }

    const sales = await prisma.sale.findMany({
      where,
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Filtro full-text simples no client da lista
    let filtered = sales;
    if (q && q.length >= 2) {
      const qLower = q.toLowerCase();
      filtered = sales.filter(s =>
        s.items.some(i =>
          (i.productName || '').toLowerCase().includes(qLower) ||
          (i.brand || '').toLowerCase().includes(qLower)
        ) ||
        (s.note || '').toLowerCase().includes(qLower) ||
        s.id.toLowerCase().includes(qLower)
      );
    }

    // Enriquecer com nome do vendedor
    const sellerIds = [...new Set(filtered.map(s => s.sellerId))];
    const sellersDb = await prisma.user.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, employeeCode: true },
    });
    const sMap = new Map(sellersDb.map(s => [s.id, s]));

    const enriched = filtered.map(s => ({
      ...s,
      sellerName: sMap.get(s.sellerId)?.name || '?',
      sellerCode: sMap.get(s.sellerId)?.employeeCode || null,
    }));

    // Status fiscal por venda (cupom emitido #N / falhou / sem cupom) — pro PDV emitir depois + 2a via
    const _fiscalDocs = await prisma.fiscalDocument.findMany({
      where: { saleId: { in: enriched.map(s => s.id) }, docType: 'NFCE' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, saleId: true, status: true, number: true, accessKey: true },
    });
    const _docBySale = new Map();
    for (const d of _fiscalDocs) if (!_docBySale.has(d.saleId)) _docBySale.set(d.saleId, d);
    for (const s of enriched) s.fiscal = _docBySale.get(s.id) || null;

    // Telefone do cliente (pra pré-preencher o envio do cupom no WhatsApp)
    const _clientIds = [...new Set(enriched.map(s => s.clientId).filter(Boolean))];
    if (_clientIds.length) {
      const _clients = await prisma.sellerClient.findMany({ where: { id: { in: _clientIds } }, select: { id: true, phone: true, name: true } });
      const _cMap = new Map(_clients.map(c => [c.id, c]));
      for (const s of enriched) { const c = s.clientId ? _cMap.get(s.clientId) : null; s.clientPhone = c?.phone || null; s.clientName = c?.name || null; }
    }

    // Totais — vendas CANCELADAS não contam (ficam na lista, mas fora dos KPIs)
    const _ativas = enriched.filter((s) => s.status !== 'canceled');
    const totals = {
      count: _ativas.length,
      totalAmount: _ativas.reduce((sum, s) => sum + (s.totalAmount || 0), 0),
      tcEarned: _ativas.reduce((sum, s) => sum + (s.tcEarned || 0), 0),
      tcUsed: _ativas.reduce((sum, s) => sum + (s.tcUsed || 0), 0),
    };

    res.json({ sales: enriched, totals });
  } catch (err) {
    console.error('Erro /sales:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// RANKING DE VENDAS — por vendedor, com filtros loja + periodo
// =====================================================================
// Retorna ranking ordenado por valor de vendas. Cada linha tem:
//   sellerId, name, storeName, salesCount, salesAmount, commissionAmount
// Filtros:
//   storeId — UUID da loja, ou "all" pra todas
//   period  — "today" | "yesterday" | "month" | "last_month" | "custom"
//   from    — YYYY-MM-DD (se period=custom)
//   to      — YYYY-MM-DD (se period=custom)
// =====================================================================
router.get('/rankings', sellerOnly, async (req, res) => {
  try {
    const storeId = req.query.storeId && req.query.storeId !== 'all' ? req.query.storeId : null;
    const period = req.query.period || 'month';

    // Resolve range de datas
    const now = new Date();
    let startUtc, endUtc;
    if (period === 'today') {
      const r = recifeDayBounds(now); startUtc = r.startUtc; endUtc = r.endUtc;
    } else if (period === 'yesterday') {
      const r = recifeDayBounds(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      startUtc = r.startUtc; endUtc = r.endUtc;
    } else if (period === 'month') {
      startUtc = new Date(now.getFullYear(), now.getMonth(), 1);
      endUtc = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else if (period === 'last_month') {
      startUtc = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endUtc = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === 'custom') {
      if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'Informe from e to no formato YYYY-MM-DD' });
      startUtc = new Date(req.query.from + 'T00:00:00-03:00');
      endUtc = new Date(req.query.to + 'T23:59:59-03:00');
    } else {
      return res.status(400).json({ error: 'period inválido' });
    }

    // Filtro de vendas (canceladas não entram no ranking)
    const saleWhere = { createdAt: { gte: startUtc, lt: endUtc }, status: { not: 'canceled' } };
    if (storeId) saleWhere.storeId = storeId;

    // Agrega vendas por vendedor
    const salesAgg = await prisma.sale.groupBy({
      by: ['sellerId'],
      _sum: { totalAmount: true, tcEarned: true, tcUsed: true },
      _count: { _all: true },
      where: saleWhere,
      orderBy: { _sum: { totalAmount: 'desc' } },
    });

    // Agrega comissões por vendedor (mesmo periodo)
    const commWhere = { createdAt: { gte: startUtc, lt: endUtc } };
    if (storeId) {
      // Comissões não têm storeId, mas todas vêm de Sales — filtra via saleId in sales of store
      const saleIds = (await prisma.sale.findMany({ where: { storeId }, select: { id: true } })).map(s => s.id);
      commWhere.saleId = { in: saleIds.length ? saleIds : ['__none__'] };
    }
    const commAgg = await prisma.saleCommission.groupBy({
      by: ['sellerId'],
      _sum: { amount: true },
      where: commWhere,
    });
    const commBySeller = new Map(commAgg.map(c => [c.sellerId, c._sum.amount || 0]));

    // Nomes + loja dos vendedores
    const sellerIds = salesAgg.map(s => s.sellerId);
    const sellers = await prisma.user.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, employeeCode: true, store: { select: { id: true, name: true, code: true } } },
    });
    const sellerMap = new Map(sellers.map(s => [s.id, s]));

    const ranking = salesAgg.map((s, i) => {
      const u = sellerMap.get(s.sellerId);
      return {
        position: i + 1,
        sellerId: s.sellerId,
        name: u?.name || '(removido)',
        employeeCode: u?.employeeCode || null,
        store: u?.store ? { id: u.store.id, name: u.store.name, code: u.store.code } : null,
        salesCount: s._count._all || 0,
        salesAmount: Math.round((s._sum.totalAmount || 0) * 100) / 100,
        cashbackGiven: Math.round((s._sum.tcEarned || 0) * 100) / 100,
        commissionAmount: Math.round((commBySeller.get(s.sellerId) || 0) * 100) / 100,
      };
    });

    // Totais
    const totals = {
      salesCount: ranking.reduce((sum, r) => sum + r.salesCount, 0),
      salesAmount: Math.round(ranking.reduce((sum, r) => sum + r.salesAmount, 0) * 100) / 100,
      cashbackGiven: Math.round(ranking.reduce((sum, r) => sum + r.cashbackGiven, 0) * 100) / 100,
      commissionAmount: Math.round(ranking.reduce((sum, r) => sum + r.commissionAmount, 0) * 100) / 100,
      sellersCount: ranking.length,
    };

    res.json({
      period,
      from: startUtc.toISOString(),
      to: endUtc.toISOString(),
      storeId: storeId || 'all',
      ranking,
      totals,
    });
  } catch (err) {
    console.error('Erro rankings:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// MINHAS COMISSÕES — histórico de comissões
// =====================================================================
router.get('/commissions', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const status = req.query.status; // pending | paid | all
    const where = { sellerId: req.userId };
    if (status && status !== 'all') where.status = status;
    const commissions = await prisma.saleCommission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { sale: { select: { totalAmount: true, createdAt: true } } },
    });
    res.json({ commissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ESTOQUE ENTRE LOJAS — vendedor consulta disponibilidade em outras unidades
// =====================================================================
// Estoque de um produto em TODAS as lojas (matriz tamanho × loja)
router.get('/inventory/check', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ error: 'productId é obrigatório' });

    const [sizes, stores] = await Promise.all([
      prisma.productSize.findMany({
        where: { productId },
        orderBy: { size: 'asc' },
        include: {
          storeStocks: { include: { store: { select: { id: true, name: true, code: true } } } },
        },
      }),
      prisma.store.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, name: true, code: true } }),
    ]);

    const result = sizes.map(s => {
      const byStore = {};
      stores.forEach(st => { byStore[st.id] = 0; });
      s.storeStocks.forEach(ss => { byStore[ss.storeId] = ss.stock; });
      return {
        size: s.size,
        barcode: s.barcode,
        stocksByStore: byStore,
        totalStock: Object.values(byStore).reduce((a, b) => a + b, 0),
      };
    });

    res.json({
      productId,
      stores,
      sizes: result,
      totalStock: result.reduce((sum, s) => sum + s.totalStock, 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Busca PRODUTOS com estoque em uma loja específica
router.get('/inventory/by-store', sellerOnly, async (req, res) => {
  try {
    const storeId = req.query.storeId;
    const q = (req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    if (!storeId) return res.status(400).json({ error: 'storeId é obrigatório' });

    // Acha productSizeIds com stock > 0 nessa loja
    const stocks = await prisma.storeStock.findMany({
      where: { storeId, stock: { gt: 0 } },
      select: { productSizeId: true, stock: true },
      take: 5000, // limite de segurança
    });

    if (!stocks.length) return res.json({ products: [], totalSkus: 0 });

    // Pega os ProductSize → resolve produto
    const sizes = await prisma.productSize.findMany({
      where: { id: { in: stocks.map(s => s.productSizeId) } },
      include: {
        product: {
          select: { id: true, sku: true, name: true, brand: true, category: true, price: true, promoPrice: true, imageUrl: true, active: true },
        },
      },
    });

    // Agrupa por produto, calcula estoque total no escopo da loja
    const byProduct = new Map();
    sizes.forEach(s => {
      if (!s.product || !s.product.active) return;
      if (q) {
        const hay = `${s.product.name} ${s.product.brand} ${s.product.sku}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return;
      }
      const stockHere = stocks.find(x => x.productSizeId === s.id)?.stock || 0;
      const cur = byProduct.get(s.product.id) || { ...s.product, sizes: [], totalStock: 0 };
      cur.sizes.push({ size: s.size, barcode: s.barcode, stock: stockHere });
      cur.totalStock += stockHere;
      byProduct.set(s.product.id, cur);
    });

    const products = [...byProduct.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit);

    res.json({ products, totalSkus: stocks.length, count: products.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// BUSCA CLIENTE TenisCash por telefone (autocomplete pro PDV)
// =====================================================================
// =====================================================================
// CADASTRO RÁPIDO DE CLIENTE — pelo CRM/PDV (sem fluxo SMS completo)
// =====================================================================
// PIN inicial = últimos 4 dígitos do telefone. Cliente troca depois.
// Se sellerId vier, ja vincula na carteira do vendedor.
// =====================================================================
router.post('/customer/quick-register', sellerOnly, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { name, phone, cpf, email, sellerId, notes } = req.body || {};
    let { storeId } = req.body || {};
    if (req.scope?.isStoreLocked) storeId = req.scope.storeId;
    // Lock: vendedor escolhido tem que ser DA loja
    if (req.scope?.isStoreLocked && sellerId) {
      const v = await prisma.user.findUnique({ where: { id: sellerId }, select: { storeId: true } });
      if (v && v.storeId !== req.scope.storeId) {
        return res.status(403).json({ error: 'Vendedor não pertence a esta loja' });
      }
    }

    if (!name || !phone) return res.status(400).json({ error: 'Nome e telefone obrigatórios' });
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 10) return res.status(400).json({ error: 'Telefone inválido' });
    const cleanCpf = cpf ? String(cpf).replace(/\D/g, '') : null;
    if (cleanCpf && cleanCpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });

    // Já existe?
    const existing = await prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (existing) {
      // Se ja existe E quer atribuir a um vendedor, ainda permite
      if (sellerId) {
        const existingAssign = await prisma.sellerCustomerAssignment.findFirst({
          where: { sellerId, customerId: existing.id },
        });
        if (existingAssign) {
          await prisma.sellerCustomerAssignment.update({
            where: { id: existingAssign.id },
            data: { storeId: storeId || existingAssign.storeId, notes: notes || existingAssign.notes },
          });
        } else {
          await prisma.sellerCustomerAssignment.create({
            data: { sellerId, customerId: existing.id, storeId: storeId || null, relationshipStatus: 'NEW_LEAD', priority: 'MEDIUM', notes: notes || null },
          });
        }
      }
      return res.json({
        ok: true,
        existing: true,
        user: { id: existing.id, name: existing.name, phone: existing.phone, balance: existing.balance },
        pinHint: 'Cliente já cadastrado — usar PIN que ele já tem',
      });
    }

    // PIN inicial: últimos 4 dígitos do telefone
    const initialPin = cleanPhone.slice(-4);
    const hashedPin = await bcrypt.hash(initialPin, 10);

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        phone: cleanPhone,
        email: email || null,
        cpf: cleanCpf,
        pin: hashedPin,
        role: 'user',
        active: true,
        profileComplete: false,
        lgpdAccepted: false,
      },
    });

    // Se vendedor informado, ja cria a relacao na carteira
    let assignment = null;
    if (sellerId) {
      try {
        assignment = await prisma.sellerCustomerAssignment.create({
          data: {
            sellerId,
            customerId: user.id,
            storeId: storeId || null,
            relationshipStatus: 'NEW_LEAD',
            priority: 'MEDIUM',
            notes: notes || null,
          },
        });
      } catch (e) { /* ignora duplicidade */ }
    }

    res.json({
      ok: true,
      existing: false,
      user: { id: user.id, name: user.name, phone: user.phone, balance: 0 },
      assignment,
      pinHint: `PIN inicial: ${initialPin} (últimos 4 do telefone). Avise o cliente pra trocar.`,
    });
  } catch (err) {
    console.error('Erro quick-register:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/customer/lookup', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    const cpf = String(req.query.cpf || '').replace(/\D/g, '');
    const select = { id: true, name: true, phone: true, balance: true, profileComplete: true, cpf: true };
    let customer = null;
    if (cpf.length === 11) {
      customer = await prisma.user.findUnique({ where: { cpf }, select });
    } else if (phone.length >= 10) {
      customer = await prisma.user.findUnique({ where: { phone }, select });
    }
    res.json({ customer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Busca UNIVERSAL do cliente pelo PDV: nome, CPF, e-mail OU celular (os 4 interligados).
// Qualquer um acha o cadastro. CPF/celular/e-mail são únicos → 0/1 resultado; nome pode trazer vários.
router.get('/customer/search', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 3) return res.json({ customers: [] });
    const digits = q.replace(/\D/g, '');
    const select = { id: true, name: true, phone: true, email: true, balance: true, cpf: true };
    const OR = [];
    if (digits.length >= 10) {
      // 11 dígitos é ambíguo (celular OU CPF) → casa os dois; 10 = telefone fixo/parcial
      OR.push({ phone: digits });
      if (digits.length === 11) OR.push({ cpf: digits });
    } else if (digits.length >= 3 && !/[a-zA-Z@]/.test(q)) {
      OR.push({ phone: { startsWith: digits } });
      OR.push({ cpf: { startsWith: digits } });
    }
    if (q.includes('@')) OR.push({ email: { contains: q, mode: 'insensitive' } });
    if (/[a-zA-Z]/.test(q)) OR.push({ name: { contains: q, mode: 'insensitive' } });
    if (!OR.length) return res.json({ customers: [] });
    const customers = await prisma.user.findMany({ where: { OR }, select, take: 8, orderBy: { name: 'asc' } });
    res.json({ customers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// CICLOS DE COMISSAO POR RELACIONAMENTO
// Organizacao visivel: nome do cliente + valor pago + itens. IDs ficam internos.
// =====================================================================

router.get('/relationship-commission', sellerOnly, async (req, res) => {
  try {
    const where = relationshipScopeWhere(req, req.query.sellerId);
    const status = String(req.query.status || '').trim().toUpperCase();
    if (['ACTIVE', 'COMPLETED', 'CANCELED', 'PENDING_PAYMENT'].includes(status)) where.status = status;
    addRelationshipSearch(where, req.query.q);
    const paidStatuses = ['ACTIVE', 'COMPLETED'].includes(status)
      ? [status]
      : status
        ? []
        : ['ACTIVE', 'COMPLETED'];
    const monetaryWhere = { ...where, status: { in: paidStatuses } };

    const [journeys, aggregate, monetaryAggregate, active, completed] = await Promise.all([
      prisma.sellerCommissionJourney.findMany({
        where,
        include: {
          seller: { select: { name: true } },
          sale: { select: { createdAt: true, status: true, items: { select: { productName: true, brand: true, size: true, quantity: true, totalPrice: true } } } },
          stages: { orderBy: { position: 'asc' } },
          referralCode: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 300,
      }),
      prisma.sellerCommissionJourney.aggregate({ where, _count: { _all: true } }),
      prisma.sellerCommissionJourney.aggregate({ where: monetaryWhere, _sum: { baseAmount: true, earnedAmount: true } }),
      status && status !== 'ACTIVE' ? Promise.resolve(0) : prisma.sellerCommissionJourney.count({ where: { ...where, status: 'ACTIVE' } }),
      status && status !== 'COMPLETED' ? Promise.resolve(0) : prisma.sellerCommissionJourney.count({ where: { ...where, status: 'COMPLETED' } }),
    ]);

    const cards = journeys.map((journey) => relationshipJourneyView(journey, {
      canRegister: req.userRole === 'seller' && journey.sellerId === req.userId,
    }));
    const totals = {
      count: aggregate._count._all || 0,
      active,
      completed,
      paidAmount: relationshipCommission.round2(monetaryAggregate._sum.baseAmount || 0),
      commission: relationshipCommission.round2(monetaryAggregate._sum.earnedAmount || 0),
    };

    res.json({ cards, totals, organization: ['customer.name', 'paidAmount', 'items'] });
  } catch (err) {
    console.error('[relationship-commission/list]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/relationship-commission/referral-candidates', sellerOnly, async (req, res) => {
  try {
    const journeyId = String(req.query.journeyId || '');
    const origin = await prisma.sellerCommissionJourney.findUnique({ where: { id: journeyId } });
    if (!canViewRelationshipJourney(req, origin)) return res.status(404).json({ error: 'Ciclo nao encontrado' });
    if (origin.sellerId !== req.userId) return res.status(403).json({ error: 'Somente o vendedor responsavel pode registrar a indicacao' });
    if (origin.purchasePosition !== 2) return res.status(400).json({ error: 'Indicacao pertence a segunda venda do ciclo' });

    const candidates = await prisma.sellerCommissionJourney.findMany({
      where: {
        ...(origin.storeId ? { storeId: origin.storeId } : { sellerId: origin.sellerId }),
        customerUserId: { not: origin.customerUserId },
        status: { in: ['ACTIVE', 'COMPLETED'] },
        sale: { status: 'completed', createdAt: { gte: origin.startedAt } },
      },
      include: {
        sale: { select: { id: true, createdAt: true, status: true, items: { select: { productName: true, brand: true, size: true, quantity: true, totalPrice: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const alreadyUsed = new Set((await prisma.sellerCommissionStage.findMany({
      where: { referredSaleId: { not: null }, status: { in: ['SUBMITTED', 'COMPLETED'] } },
      select: { referredSaleId: true },
    })).map((row) => row.referredSaleId));
    const query = normalizeSearch(req.query.q);
    const filtered = candidates.filter((candidate) => {
      if (alreadyUsed.has(candidate.saleId)) return false;
      if (!query) return true;
      const items = candidate.sale.items.map((item) => `${item.productName} ${item.brand} ${item.size || ''}`).join(' ');
      const money = `${candidate.baseAmount} ${Number(candidate.baseAmount).toFixed(2).replace('.', ',')}`;
      return normalizeSearch(`${candidate.customerName} ${items} ${money}`).includes(query);
    });
    res.json({
      candidates: filtered.map((candidate) => ({
        journeyId: candidate.id,
        customerName: candidate.customerName,
        paidAmount: candidate.baseAmount,
        saleDate: candidate.sale.createdAt,
        items: candidate.sale.items.map((item) => ({ name: item.productName, brand: item.brand, size: item.size, quantity: item.quantity })),
      })),
    });
  } catch (err) {
    console.error('[relationship-commission/referral-candidates]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/relationship-commission/:journeyId/referral-code', sellerOnly, async (req, res) => {
  try {
    const journey = await prisma.sellerCommissionJourney.findUnique({
      where: { id: String(req.params.journeyId || '') },
      include: {
        sale: { select: { createdAt: true, status: true } },
        stages: { orderBy: { position: 'asc' } },
        referralCode: true,
      },
    });
    if (!journey || !canViewRelationshipJourney(req, journey)) return res.status(404).json({ error: 'Ciclo nao encontrado' });
    if (req.userRole !== 'seller' || journey.sellerId !== req.userId) return res.status(403).json({ error: 'Somente o vendedor responsavel pode gerar a indicacao' });
    if (journey.purchasePosition !== 2 || journey.status !== 'ACTIVE' || journey.sale.status !== 'completed') {
      return res.status(409).json({ error: 'O codigo pertence a segunda venda ativa do ciclo' });
    }
    const referralStep = relationshipCommission.stageAvailability(journey, journey.stages)
      .find((item) => item.key === 'REFERRAL_CONVERTED');
    if (!referralStep?.available) return res.status(409).json({ error: referralStep?.waitingReason || 'Conclua as etapas anteriores antes de gerar a indicacao' });

    let referral = journey.referralCode;
    if (!referral) {
      for (let attempt = 0; attempt < 8 && !referral; attempt += 1) {
        const code = `STI${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
        try {
          referral = await prisma.sellerReferralCode.create({
            data: {
              code,
              originJourneyId: journey.id,
              sellerId: journey.sellerId,
              originCustomerUserId: journey.customerUserId,
              originStoreId: journey.storeId || null,
            },
          });
        } catch (err) {
          if (err.code !== 'P2002') throw err;
          referral = await prisma.sellerReferralCode.findUnique({ where: { originJourneyId: journey.id } });
        }
      }
    }
    if (!referral) throw new Error('Nao foi possivel gerar um codigo unico');
    if (referral.status !== 'ACTIVE') return res.status(409).json({ error: 'Este codigo ja foi utilizado em uma compra' });

    const shareText = `Indicacao Sports & Tennis: apresente o codigo ${referral.code} no caixa antes de finalizar a compra.`;
    const qrDataUrl = await QRCode.toDataURL(referral.code, { width: 420, margin: 2, errorCorrectionLevel: 'M' });
    res.json({ referral: { code: referral.code, status: referral.status, shareText, qrDataUrl } });
  } catch (err) {
    console.error('[relationship-commission/referral-code]', err);
    res.status(/etapa|codigo|ciclo|vendedor|compra/i.test(err.message) ? 409 : 500).json({ error: err.message });
  }
});

router.get('/relationship-commission/evidence/:evidenceId', sellerOnly, async (req, res) => {
  try {
    const evidence = await prisma.sellerCommissionEvidence.findUnique({
      where: { id: String(req.params.evidenceId) },
      include: { stage: { include: { journey: true } } },
    });
    if (!evidence || !canViewRelationshipJourney(req, evidence.stage.journey)) return res.status(404).json({ error: 'Evidencia nao encontrada' });
    const filePath = commissionEvidenceStore.resolve(evidence.storedName);
    if (!filePath) return res.status(404).json({ error: 'Arquivo da evidencia nao encontrado' });
    res.setHeader('Content-Type', evidence.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(evidence.originalName)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[relationship-commission/evidence]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/relationship-commission/review-queue', commissionReviewerOnly, async (req, res) => {
  try {
    const where = { status: 'SUBMITTED' };
    if (req.scope?.isStoreLocked) where.journey = { storeId: req.scope.storeId };
    else if (req.query.storeId) where.journey = { storeId: String(req.query.storeId) };

    const stages = await prisma.sellerCommissionStage.findMany({
      where,
      include: {
        evidence: { orderBy: { createdAt: 'asc' } },
        journey: {
          include: {
            seller: { select: { name: true } },
            sale: { select: { createdAt: true, status: true, items: { select: { productName: true, brand: true, size: true, quantity: true, totalPrice: true } } } },
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
      take: 300,
    });

    const reviewable = stages.filter((stage) => canReviewRelationshipJourney(req, stage.journey));
    res.json({
      count: reviewable.length,
      submissions: reviewable.map((stage) => ({
        stageId: stage.id,
        journeyId: stage.journeyId,
        title: stage.title,
        targetPct: stage.targetPct,
        note: stage.note,
        publicationUrl: stage.publicationUrl,
        evidenceUrl: stage.evidenceUrl,
        customerInteracted: stage.customerInteracted,
        consentConfirmed: stage.consentConfirmed,
        submittedAt: stage.submittedAt,
        customerName: stage.journey.customerName,
        sellerName: stage.journey.seller.name,
        paidAmount: stage.journey.baseAmount,
        saleDate: stage.journey.sale.createdAt,
        items: stage.journey.sale.items.map((item) => ({ name: item.productName, brand: item.brand, size: item.size, quantity: item.quantity })),
        evidence: stage.evidence.map((item) => ({
          evidenceId: item.id,
          name: item.originalName,
          mediaType: item.mediaType,
          automatedStatus: item.automatedStatus,
          automatedChecks: item.automatedChecks || null,
        })),
      })),
    });
  } catch (err) {
    console.error('[relationship-commission/review-queue]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/relationship-commission/stages/:stageId/review', commissionReviewerOnly, async (req, res) => {
  try {
    const stageId = String(req.params.stageId || '');
    const decision = String(req.body?.decision || '').trim().toUpperCase();
    const reviewNote = String(req.body?.reviewNote || '').trim().slice(0, 2000);
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ error: 'Decisao invalida' });
    if (decision === 'REJECT' && !reviewNote) return res.status(400).json({ error: 'Informe o que o vendedor precisa corrigir' });

    const initial = await prisma.sellerCommissionStage.findUnique({ where: { id: stageId }, include: { journey: true } });
    if (!initial || !canReviewRelationshipJourney(req, initial.journey)) return res.status(404).json({ error: 'Etapa enviada nao encontrada' });
    if (initial.status !== 'SUBMITTED') return res.status(409).json({ error: 'Esta etapa ja foi fiscalizada ou retirada' });

    if (decision === 'REJECT') {
      const rejected = await prisma.sellerCommissionStage.updateMany({
        where: { id: stageId, status: 'SUBMITTED' },
        data: {
          status: 'REJECTED',
          reviewedById: req.userId,
          reviewedAt: new Date(),
          reviewNote,
          referredSaleId: null,
        },
      });
      if (rejected.count !== 1) return res.status(409).json({ error: 'Esta etapa ja foi fiscalizada' });
      if (initial.referredSaleId) {
        await prisma.sellerReferralCode.updateMany({
          where: { referredSaleId: initial.referredSaleId },
          data: { status: 'ACTIVE', referredSaleId: null, convertedAt: null },
        });
      }
      return res.json({ ok: true, decision: 'REJECTED' });
    }

    const approved = await prisma.$transaction(async (tx) => {
      const stage = await tx.sellerCommissionStage.findUnique({
        where: { id: stageId },
        include: {
          referredSale: { select: { id: true, status: true } },
          journey: { include: { sale: { select: { createdAt: true, status: true } }, stages: { orderBy: { position: 'asc' } } } },
        },
      });
      if (!stage || stage.status !== 'SUBMITTED') throw new Error('Esta etapa ja foi fiscalizada');
      if (!canReviewRelationshipJourney(req, stage.journey)) throw new Error('Fiscalizador sem acesso a esta loja');
      if (stage.journey.status !== 'ACTIVE' || stage.journey.sale.status !== 'completed') throw new Error('A venda nao esta ativa e paga');
      if (stage.journey.stages.some((item) => item.position < stage.position && item.status !== 'COMPLETED')) {
        throw new Error('Existe etapa anterior ainda nao aprovada');
      }

      const rule = relationshipCommission.ruleForStage(stage.journey.purchasePosition, stage.key);
      if (!rule || rule.automatic) throw new Error('Etapa invalida para fiscalizacao');
      if (rule.referral && stage.referredSale?.status !== 'completed') throw new Error('A compra indicada nao esta mais paga');
      const deltaPct = relationshipCommission.round2(rule.targetPct - stage.journey.currentPct);
      if (!(deltaPct > 0)) throw new Error('Percentual desta etapa ja foi alcancado');
      const amount = relationshipCommission.amountAtPct(stage.journey.baseAmount, deltaPct);
      const now = new Date();
      const finalStage = stage.position === stage.journey.stages.length - 1;
      const claimed = await tx.sellerCommissionStage.updateMany({
        where: { id: stage.id, status: 'SUBMITTED' },
        data: {
          status: 'COMPLETED',
          deltaPct,
          amount,
          completedAt: now,
          reviewedById: req.userId,
          reviewedAt: now,
          reviewNote: reviewNote || 'Aprovado pela fiscalizacao',
        },
      });
      if (claimed.count !== 1) throw new Error('Esta etapa ja foi fiscalizada');
      await tx.sellerCommissionJourney.update({
        where: { id: stage.journeyId },
        data: {
          currentPct: rule.targetPct,
          earnedAmount: { increment: amount },
          status: finalStage ? 'COMPLETED' : 'ACTIVE',
          completedAt: finalStage ? now : null,
        },
      });
      if (rule.interaction) {
        await tx.customerInteraction.create({ data: {
          customerId: stage.journey.customerUserId,
          sellerId: stage.journey.sellerId,
          storeId: stage.journey.storeId,
          channel: stage.interactionChannel || 'OTHER',
          interactionType: 'POST_SALE',
          summary: stage.note,
          result: 'CUSTOMER_INTERACTED_APPROVED',
        } });
      }
      return { amount, targetPct: rule.targetPct, finalStage };
    });

    res.json({ ok: true, decision: 'APPROVED', addedAmount: approved.amount, currentPct: approved.targetPct, cycleCompleted: approved.finalStage });
  } catch (err) {
    const clientError = /etapa|Etapa|Fiscalizador|venda|compra|Percentual|percentual/i.test(err.message);
    console.error('[relationship-commission/review]', err);
    res.status(clientError ? 409 : 500).json({ error: err.message });
  }
});

router.get('/relationship-commission/:journeyId', sellerOnly, async (req, res) => {
  try {
    const journey = await prisma.sellerCommissionJourney.findUnique({
      where: { id: String(req.params.journeyId) },
      include: {
        seller: { select: { name: true } },
        sale: { select: { createdAt: true, status: true, items: { select: { productName: true, brand: true, size: true, quantity: true, totalPrice: true } } } },
        stages: { orderBy: { position: 'asc' }, include: { evidence: { orderBy: { createdAt: 'asc' } } } },
        referralCode: true,
      },
    });
    if (!canViewRelationshipJourney(req, journey)) return res.status(404).json({ error: 'Ciclo nao encontrado' });
    res.json({ card: relationshipJourneyView(journey, {
      detail: true,
      canRegister: req.userRole === 'seller' && journey.sellerId === req.userId,
    }) });
  } catch (err) {
    console.error('[relationship-commission/detail]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/relationship-commission/:journeyId/stages/:stageKey', sellerOnly,
  (req, res, next) => commissionEvidenceUpload.array('files', 7)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo acima de 80 MB' });
    return res.status(400).json({ error: err.message });
  }),
  async (req, res) => {
    const savedFiles = [];
    try {
      const journeyId = String(req.params.journeyId || '');
      const stageKey = String(req.params.stageKey || '').toUpperCase();
      const journey = await prisma.sellerCommissionJourney.findUnique({
        where: { id: journeyId },
        include: { sale: { select: { id: true, createdAt: true, status: true } }, stages: { orderBy: { position: 'asc' } } },
      });
      if (!journey || !canViewRelationshipJourney(req, journey)) return res.status(404).json({ error: 'Ciclo nao encontrado' });
      if (journey.sellerId !== req.userId) return res.status(403).json({ error: 'Outro vendedor nao pode concluir esta etapa' });
      if (journey.status !== 'ACTIVE') return res.status(409).json({ error: 'Este ciclo nao esta ativo' });
      if (journey.sale.status !== 'completed') return res.status(409).json({ error: 'A venda ainda nao esta confirmada como paga' });

      const rule = relationshipCommission.ruleForStage(journey.purchasePosition, stageKey);
      if (!rule || rule.automatic) return res.status(400).json({ error: 'Etapa invalida para esta venda' });
      const availability = relationshipCommission.stageAvailability(journey, journey.stages);
      const available = availability.find((item) => item.key === stageKey);
      if (!available?.available) return res.status(409).json({ error: available?.waitingReason || 'Etapa indisponivel' });

      const note = String(req.body.note || '').trim().slice(0, 4000);
      const publicationUrl = String(req.body.publicationUrl || '').trim().slice(0, 1000);
      const evidenceUrl = String(req.body.evidenceUrl || '').trim().slice(0, 1000);
      const customerInteracted = String(req.body.customerInteracted || '').toLowerCase() === 'true';
      const consentConfirmed = String(req.body.consentConfirmed || '').toLowerCase() === 'true';
      if (!note) return res.status(400).json({ error: 'Escreva o que foi realizado nesta etapa' });
      if (rule.publication && !/^https?:\/\//i.test(publicationUrl)) return res.status(400).json({ error: 'Informe o link da publicacao no perfil da loja' });
      if (evidenceUrl && !/^https?:\/\//i.test(evidenceUrl)) return res.status(400).json({ error: 'O link da evidencia precisa comecar com http:// ou https://' });
      if (rule.interaction && !customerInteracted) return res.status(400).json({ error: 'O cliente precisa ter interagido no pos-venda' });
      if (rule.consent && !consentConfirmed) return res.status(400).json({ error: 'Confirme a autorizacao do cliente para uso de imagem e voz' });

      const files = req.files || [];
      const photos = files.filter((file) => file.mimetype.startsWith('image/'));
      const videos = files.filter((file) => file.mimetype.startsWith('video/'));
      if (photos.length > 5) return res.status(400).json({ error: 'Envie no maximo 5 fotos por etapa' });
      if (videos.length > 2) return res.status(400).json({ error: 'Envie no maximo 2 videos por etapa' });
      if (photos.some((file) => file.size > 15 * 1024 * 1024)) return res.status(413).json({ error: 'Foto acima de 15 MB' });
      const hasEvidenceLink = /^https?:\/\//i.test(evidenceUrl || publicationUrl);
      if (rule.media === 'photo' && !photos.length && !hasEvidenceLink) return res.status(400).json({ error: 'Envie uma foto ou informe um link como evidencia' });
      if (rule.media === 'video' && !videos.length && !hasEvidenceLink) return res.status(400).json({ error: 'Envie um video ou informe um link como evidencia' });

      let referredSale = null;
      if (rule.referral) {
        const referredJourneyId = String(req.body.referredJourneyId || '');
        const referredJourney = await prisma.sellerCommissionJourney.findUnique({ where: { id: referredJourneyId }, include: { sale: { select: { id: true, status: true, createdAt: true } } } });
        const sameSalesScope = journey.storeId
          ? referredJourney?.storeId === journey.storeId
          : referredJourney?.sellerId === journey.sellerId;
        if (!referredJourney || !sameSalesScope || referredJourney.customerUserId === journey.customerUserId) {
          return res.status(400).json({ error: 'Selecione a compra valida da pessoa indicada' });
        }
        if (referredJourney.sale.status !== 'completed' || referredJourney.sale.createdAt < journey.sale.createdAt) {
          return res.status(400).json({ error: 'A compra indicada precisa estar paga e ser posterior a esta venda' });
        }
        const used = await prisma.sellerCommissionStage.findFirst({ where: { referredSaleId: referredJourney.sale.id, status: { in: ['SUBMITTED', 'COMPLETED'] } } });
        if (used) return res.status(409).json({ error: 'Esta compra indicada ja encerrou outro ciclo' });
        referredSale = referredJourney.sale;
      }

      const batchHashes = new Set();
      for (const file of files) {
        const saved = commissionEvidenceStore.save(file);
        savedFiles.push(saved);
        Object.assign(saved, await addCommissionEvidenceIntegrityChecks(saved, {
          sellerId: journey.sellerId,
          expectedMediaType: rule.media || null,
          batchHashes,
        }));
      }

      await prisma.$transaction(async (tx) => {
        const fresh = await tx.sellerCommissionJourney.findUnique({ where: { id: journeyId }, include: { sale: { select: { createdAt: true, status: true } }, stages: { orderBy: { position: 'asc' } } } });
        const freshAvailability = relationshipCommission.stageAvailability(fresh, fresh.stages);
        const freshStage = freshAvailability.find((item) => item.key === stageKey);
        if (!freshStage?.available) throw new Error(freshStage?.waitingReason || 'Etapa ja registrada');
        const now = new Date();

        const claimed = await tx.sellerCommissionStage.updateMany({
          where: { id: freshStage.stage.id, status: { in: ['PENDING', 'REJECTED'] } },
          data: {
            status: 'SUBMITTED', note,
            publicationUrl: publicationUrl || null,
            evidenceUrl: evidenceUrl || null,
            customerInteracted, consentConfirmed,
            interactionChannel: String(req.body.channel || 'OTHER').toUpperCase().slice(0, 30),
            completedById: req.userId,
            completedAt: null,
            submittedAt: now,
            reviewedById: null,
            reviewedAt: null,
            reviewNote: null,
            referredSaleId: referredSale?.id || null,
            reversedAt: null, reversalReason: null,
          },
        });
        if (claimed.count !== 1) throw new Error('Etapa ja registrada por outra solicitacao');
        if (savedFiles.length) {
          await tx.sellerCommissionEvidence.createMany({
            data: savedFiles.map((file) => ({ ...file, stageId: freshStage.stage.id })),
          });
        }
      });

      res.json({ ok: true, status: 'SUBMITTED', message: 'Etapa enviada para fiscalizacao. A comissao so aumenta depois da aprovacao.' });
    } catch (err) {
      for (const file of savedFiles) commissionEvidenceStore.remove(file.storedName);
      const duplicateReferral = err.code === 'P2002';
      const clientError = duplicateReferral || /Etapa|etapa|Percentual|percentual|vendedor|venda|cliente|compra|publicacao|interagido|autorizacao/i.test(err.message);
      console.error('[relationship-commission/stage]', err);
      res.status(clientError ? 409 : 500).json({ error: duplicateReferral ? 'Esta compra indicada ja encerrou outro ciclo' : err.message });
    }
  }
);

// =====================================================================
// CANCELAR VENDA (registrada, SEM cupom emitido) — estorna estoque, cashback e comissões.
// Trava: se a venda já tem cupom autorizado/emitindo, NÃO cancela aqui (aí é cancelar o cupom na SEFAZ).
// =====================================================================
router.post('/sale/:id/cancel', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const saleId = String(req.params.id || '');
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: 'Informe o motivo do cancelamento.' });

    const sale = await prisma.sale.findUnique({ where: { id: saleId }, include: { items: true } });
    if (!sale) return res.status(404).json({ error: 'Venda não encontrada.' });
    if (sale.status === 'canceled') return res.status(400).json({ error: 'Venda já está cancelada.' });

    // TRAVA: cupom autorizado/emitindo → não dá pra cancelar a venda aqui (cancele o CUPOM na SEFAZ).
    const cupom = await prisma.fiscalDocument.findFirst({
      where: { saleId, docType: 'NFCE', status: { in: ['authorized', 'processing'] } },
      select: { number: true, status: true },
    });
    if (cupom) return res.status(409).json({ hasCupom: true, error: 'Esta venda já tem cupom' + (cupom.number ? ' #' + cupom.number : '') + ' (' + cupom.status + '). Cancele o CUPOM na SEFAZ — não dá pra cancelar a venda por aqui.' });

    const operatorId = req.userId;
    const result = await prisma.$transaction(async (tx) => {
      // 1) DEVOLVE o estoque (StoreStock) por tamanho — espelha a baixa feita na venda.
      let stockBack = 0;
      if (sale.storeId) {
        for (const it of sale.items) {
          if (!(it.quantity > 0)) continue;
          let productSizeId = it.productSizeId;
          if (!productSizeId && it.size && it.productId) {
            const legacySize = await tx.productSize.findFirst({ where: { productId: it.productId, size: it.size }, select: { id: true } });
            productSizeId = legacySize?.id || null;
          }
          if (!productSizeId) continue;
          const recordedDebit = await tx.storeStockMovement.findFirst({ where: { saleItemId: it.id, type: 'sale' }, select: { id: true } });
          if (!recordedDebit) {
            // Venda antiga: conserva a regra anterior e só estorna quando a localização existe.
            const legacyRow = await tx.storeStock.findUnique({ where: { storeId_productSizeId: { storeId: sale.storeId, productSizeId } }, select: { id: true } });
            if (!legacyRow) continue;
          }
          await applyStoreStockDelta(tx, {
            storeId: sale.storeId,
            productSizeId,
            saleId,
            saleItemId: it.id,
            quantity: it.quantity,
            type: 'sale_cancel',
            source: 'seller_cancel_api',
            reason,
            metadata: { canceledBy: operatorId },
          });
          stockBack += it.quantity;
        }
      }

      // 2) ESTORNA o cashback/saldo do cliente — acha a transação 'sale' desta venda (receiver + valor líquido).
      let balanceReversed = 0;
      const saleTxn = await tx.transaction.findFirst({ where: { type: 'sale', metadata: { contains: saleId } } });
      if (saleTxn && saleTxn.receiverId && saleTxn.amount) {
        const u = await tx.user.findUnique({ where: { id: saleTxn.receiverId }, select: { id: true, balance: true } });
        if (u) {
          const novo = Math.max(0, Math.round(((u.balance || 0) - saleTxn.amount) * 100) / 100);
          await tx.user.update({ where: { id: u.id }, data: { balance: novo } });
          await tx.transaction.create({
            data: {
              type: 'sale_canceled',
              amount: -saleTxn.amount,
              description: `Estorno venda #${saleId.slice(0, 8)} (cancelada)`,
              receiverId: u.id,
              balanceAfter: novo,
              metadata: JSON.stringify({ saleId, canceledBy: operatorId, reason }),
            },
          });
          balanceReversed = saleTxn.amount;
        }
      }

      // 3) REMOVE as comissões da venda (não entram no pagamento dos vendedores).
      const delComm = await tx.saleCommission.deleteMany({ where: { saleId } });

      // 4) Marca a venda CANCELADA + guarda o motivo no note.
      await tx.sale.update({
        where: { id: saleId },
        data: { status: 'canceled', note: 'CANCELADA (' + reason + ')' + (sale.note ? ' | ' + sale.note : '') },
      });

      // Mantem o historico do ciclo e registra estorno; nunca apaga evidencias.
      const relationshipReversal = await relationshipCommission.cancelJourneyForSale(tx, saleId, reason);

      return { stockBack, balanceReversed, commissionsRemoved: delComm.count, ...relationshipReversal };
    });

    console.log('[sale cancel]', JSON.stringify({ saleId, by: operatorId, reason, ...result }));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Erro cancelar venda:', err);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;

