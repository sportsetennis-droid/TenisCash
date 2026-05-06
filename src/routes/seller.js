const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

function sellerOnly(req, res, next) {
  if (req.userRole !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
  }
  next();
}

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
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
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
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
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
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
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

module.exports = router;

