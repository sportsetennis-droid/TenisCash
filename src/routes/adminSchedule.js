// =====================================================================
// Routes: /api/admin/schedule — Agenda da equipe (gerente)
// Escala recorrente (vendedor × loja × dia) + atividades, amarrada no
// cadastro REAL do vendedor (User role=seller) e interligada com ponto
// (ClockIn) e vendas (Sale) na view /week.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const ACT_TYPES = ['folga', 'ferias', 'treinamento', 'reuniao', 'feriado', 'meta', 'evento', 'outro'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// dia (YYYY-MM-DD) -> janela UTC [00:00, +24h) no fuso de João Pessoa (UTC-3)
function dayWindow(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}
function ymdOf(dt) { return dt.toISOString().slice(0, 10); }
function monthWindow(month) {
  if (!MONTH_RE.test(String(month || ''))) return null;
  const [year, number] = month.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, number - 1, 1, 3)),
    end: new Date(Date.UTC(year, number, 1, 3)),
  };
}
function workDateFromYmd(ymd) {
  if (!YMD_RE.test(String(ymd || ''))) return null;
  const parsed = new Date(`${ymd}T03:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || ymdOf(parsed) !== ymd ? null : parsed;
}
function validShiftTime(startTime, endTime) {
  return TIME_RE.test(String(startTime || '')) && TIME_RE.test(String(endTime || '')) && startTime < endTime;
}
function monthlyInclude() {
  return {
    shifts: {
      orderBy: [{ workDate: 'asc' }, { startTime: 'asc' }],
      include: {
        seller: { select: { id: true, name: true, employeeCode: true } },
        store: { select: { id: true, code: true, name: true } },
      },
    },
    receipts: { select: { sellerId: true, version: true, notifiedAt: true, viewedAt: true, acknowledgedAt: true } },
  };
}

async function getOrCreateMonthlySchedule(month, userId) {
  const bounds = monthWindow(month);
  if (!bounds) throw Object.assign(new Error('Mês inválido. Use YYYY-MM.'), { statusCode: 400 });
  return prisma.sellerMonthlySchedule.upsert({
    where: { month },
    update: {},
    create: { month, createdById: userId },
  });
}

// =====================================================================
// META — vendedores (cadastro real) + lojas, pros seletores
// =====================================================================
router.get('/meta', async (req, res) => {
  try {
    const [sellers, stores] = await Promise.all([
      prisma.user.findMany({
        where: { role: 'seller', active: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, employeeCode: true, storeId: true, storeIds: true },
      }),
      prisma.store.findMany({ where: { active: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true } }),
    ]);
    res.json({ sellers, stores });
  } catch (err) { console.error('[schedule/meta]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// ESCALA (SellerSchedule) — CRUD
// =====================================================================
router.get('/shifts', async (req, res) => {
  try {
    const { storeId, sellerId } = req.query;
    const where = { active: true, ...(storeId ? { storeId } : {}), ...(sellerId ? { sellerId } : {}) };
    const shifts = await prisma.sellerSchedule.findMany({
      where,
      orderBy: [{ weekday: 'asc' }, { startTime: 'asc' }],
      include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    res.json({ shifts });
  } catch (err) { console.error('[schedule/shifts:list]', err); res.status(500).json({ error: err.message }); }
});

router.post('/shifts', async (req, res) => {
  try {
    const { sellerId, storeId, weekday, startTime, endTime, note } = req.body || {};
    if (!sellerId || !storeId || weekday === undefined || weekday === null) {
      return res.status(400).json({ error: 'sellerId, storeId e weekday são obrigatórios' });
    }
    const wd = Number(weekday);
    if (!(wd >= 0 && wd <= 6)) return res.status(400).json({ error: 'weekday deve ser 0..6' });
    const shift = await prisma.sellerSchedule.create({
      data: { sellerId, storeId, weekday: wd, startTime: startTime || '09:00', endTime: endTime || '18:00', note: note || null },
      include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    res.json({ shift });
  } catch (err) { console.error('[schedule/shifts:create]', err); res.status(500).json({ error: err.message }); }
});

router.put('/shifts/:id', async (req, res) => {
  try {
    const { storeId, weekday, startTime, endTime, note, active } = req.body || {};
    const data = {};
    if (storeId !== undefined) data.storeId = storeId;
    if (weekday !== undefined) { const wd = Number(weekday); if (!(wd >= 0 && wd <= 6)) return res.status(400).json({ error: 'weekday deve ser 0..6' }); data.weekday = wd; }
    if (startTime !== undefined) data.startTime = startTime;
    if (endTime !== undefined) data.endTime = endTime;
    if (note !== undefined) data.note = note;
    if (active !== undefined) data.active = !!active;
    const shift = await prisma.sellerSchedule.update({ where: { id: req.params.id }, data });
    res.json({ shift });
  } catch (err) { console.error('[schedule/shifts:update]', err); res.status(500).json({ error: err.message }); }
});

router.delete('/shifts/:id', async (req, res) => {
  try {
    await prisma.sellerSchedule.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[schedule/shifts:delete]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// ESCALA MENSAL — rascunho por data exata, publicação e recebimento
// =====================================================================
router.get('/months/:month', async (req, res) => {
  try {
    if (!monthWindow(req.params.month)) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const schedule = await prisma.sellerMonthlySchedule.findUnique({ where: { month: req.params.month }, include: monthlyInclude() });
    res.json({ schedule });
  } catch (err) { console.error('[schedule/months:get]', err); res.status(500).json({ error: err.message }); }
});

router.post('/months/:month/entries', async (req, res) => {
  try {
    const month = req.params.month;
    const bounds = monthWindow(month);
    if (!bounds) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const { sellerId, storeId, workDate: workDateRaw, startTime, endTime, note } = req.body || {};
    const workDate = workDateFromYmd(workDateRaw);
    if (!sellerId || !storeId || !workDate) return res.status(400).json({ error: 'Vendedor, loja e data válida são obrigatórios.' });
    if (workDate < bounds.start || workDate >= bounds.end) return res.status(400).json({ error: 'A data precisa pertencer ao mês selecionado.' });
    if (!validShiftTime(startTime, endTime)) return res.status(400).json({ error: 'Informe entrada e saída válidas. A saída deve ser depois da entrada.' });
    const [seller, store, schedule] = await Promise.all([
      prisma.user.findFirst({ where: { id: sellerId, role: 'seller', active: true }, select: { id: true } }),
      prisma.store.findFirst({ where: { id: storeId, active: true }, select: { id: true } }),
      getOrCreateMonthlySchedule(month, req.userId),
    ]);
    if (!seller) return res.status(400).json({ error: 'Vendedor ativo não encontrado.' });
    if (!store) return res.status(400).json({ error: 'Loja ativa não encontrada.' });
    if (schedule.status !== 'DRAFT') return res.status(409).json({ error: 'A escala já foi publicada. Reabra o mês antes de alterar.' });
    const existing = await prisma.sellerMonthlyShift.findUnique({ where: { sellerId_workDate: { sellerId, workDate } }, include: { store: { select: { code: true } } } });
    if (existing) return res.status(409).json({ error: `Este vendedor já está escalado nessa data na loja ${existing.store?.code || 'informada'}.` });
    const shift = await prisma.sellerMonthlyShift.create({
      data: { scheduleId: schedule.id, sellerId, storeId, workDate, startTime, endTime, note: String(note || '').trim() || null },
      include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    res.status(201).json({ shift });
  } catch (err) {
    console.error('[schedule/months:entry:create]', err);
    const status = err.statusCode || (err.code === 'P2002' ? 409 : 500);
    res.status(status).json({ error: status === 409 ? 'Conflito: o vendedor já possui escala nessa data.' : err.message });
  }
});

router.put('/months/:month/entries/:id', async (req, res) => {
  try {
    const bounds = monthWindow(req.params.month);
    if (!bounds) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const current = await prisma.sellerMonthlyShift.findUnique({ where: { id: req.params.id }, include: { schedule: true } });
    if (!current || current.schedule.month !== req.params.month) return res.status(404).json({ error: 'Turno não encontrado neste mês.' });
    if (current.schedule.status !== 'DRAFT') return res.status(409).json({ error: 'Reabra o mês antes de alterar.' });
    const body = req.body || {};
    const workDate = body.workDate === undefined ? current.workDate : workDateFromYmd(body.workDate);
    const startTime = body.startTime === undefined ? current.startTime : body.startTime;
    const endTime = body.endTime === undefined ? current.endTime : body.endTime;
    if (!workDate || workDate < bounds.start || workDate >= bounds.end) return res.status(400).json({ error: 'A data precisa pertencer ao mês selecionado.' });
    if (!validShiftTime(startTime, endTime)) return res.status(400).json({ error: 'Horário inválido.' });
    const shift = await prisma.sellerMonthlyShift.update({
      where: { id: current.id },
      data: {
        ...(body.sellerId !== undefined ? { sellerId: body.sellerId } : {}),
        ...(body.storeId !== undefined ? { storeId: body.storeId } : {}),
        workDate,
        startTime,
        endTime,
        ...(body.note !== undefined ? { note: String(body.note || '').trim() || null } : {}),
      },
    });
    res.json({ shift });
  } catch (err) {
    console.error('[schedule/months:entry:update]', err);
    res.status(err.code === 'P2002' ? 409 : 500).json({ error: err.code === 'P2002' ? 'O vendedor já possui escala nessa data.' : err.message });
  }
});

router.delete('/months/:month/entries/:id', async (req, res) => {
  try {
    const shift = await prisma.sellerMonthlyShift.findUnique({ where: { id: req.params.id }, include: { schedule: true } });
    if (!shift || shift.schedule.month !== req.params.month) return res.status(404).json({ error: 'Turno não encontrado neste mês.' });
    if (shift.schedule.status !== 'DRAFT') return res.status(409).json({ error: 'Reabra o mês antes de excluir.' });
    await prisma.sellerMonthlyShift.delete({ where: { id: shift.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[schedule/months:entry:delete]', err); res.status(500).json({ error: err.message }); }
});

router.post('/months/:month/copy-recurring', async (req, res) => {
  try {
    const month = req.params.month;
    const bounds = monthWindow(month);
    if (!bounds) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const schedule = await getOrCreateMonthlySchedule(month, req.userId);
    if (schedule.status !== 'DRAFT') return res.status(409).json({ error: 'Reabra o mês antes de copiar a escala fixa.' });
    const recurring = await prisma.sellerSchedule.findMany({
      where: { active: true, seller: { role: 'seller', active: true }, store: { active: true } },
      orderBy: [{ sellerId: 'asc' }, { weekday: 'asc' }, { createdAt: 'asc' }],
      select: { sellerId: true, storeId: true, weekday: true, startTime: true, endTime: true },
    });
    const repeated = new Set();
    const seenRecurring = new Set();
    for (const row of recurring) {
      const key = `${row.sellerId}|${row.weekday}`;
      if (seenRecurring.has(key)) repeated.add(key);
      seenRecurring.add(key);
      if (!validShiftTime(row.startTime, row.endTime)) repeated.add(key);
    }
    if (repeated.size) return res.status(409).json({ error: 'A escala fixa contém horário inválido ou mais de uma loja para o mesmo vendedor e dia da semana. Corrija antes de copiar.' });
    const absences = await prisma.agendaActivity.findMany({
      where: { type: { in: ['folga', 'ferias', 'feriado'] }, date: { lt: bounds.end }, OR: [{ endDate: null, date: { gte: bounds.start } }, { endDate: { gte: bounds.start } }] },
      select: { date: true, endDate: true, sellerId: true, storeId: true },
    });
    const data = [];
    for (let date = new Date(bounds.start); date < bounds.end; date = new Date(date.getTime() + 86400000)) {
      const weekday = date.getUTCDay();
      for (const row of recurring.filter((item) => item.weekday === weekday)) {
        const dateYmd = ymdOf(date);
        const absent = absences.some((item) => dateYmd >= ymdOf(item.date) && dateYmd <= ymdOf(item.endDate || item.date) && (!item.sellerId || item.sellerId === row.sellerId) && (!item.storeId || item.storeId === row.storeId));
        if (!absent) data.push({ scheduleId: schedule.id, sellerId: row.sellerId, storeId: row.storeId, workDate: date, startTime: row.startTime, endTime: row.endTime });
      }
    }
    const result = data.length ? await prisma.sellerMonthlyShift.createMany({ data, skipDuplicates: true }) : { count: 0 };
    res.json({ created: result.count, skipped: data.length - result.count });
  } catch (err) { console.error('[schedule/months:copy]', err); res.status(err.statusCode || 500).json({ error: err.message }); }
});

router.post('/months/:month/publish', async (req, res) => {
  try {
    if (!monthWindow(req.params.month)) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const schedule = await prisma.sellerMonthlySchedule.findUnique({ where: { month: req.params.month }, include: monthlyInclude() });
    if (!schedule || !schedule.shifts.length) return res.status(400).json({ error: 'Inclua pelo menos um dia de trabalho antes de publicar.' });
    if (schedule.status === 'PUBLISHED') return res.json({ schedule, alreadyPublished: true });
    const grouped = new Map();
    for (const shift of schedule.shifts) {
      if (!validShiftTime(shift.startTime, shift.endTime)) return res.status(400).json({ error: 'Há um turno com horário inválido. Corrija antes de publicar.' });
      const rows = grouped.get(shift.sellerId) || [];
      rows.push(shift);
      grouped.set(shift.sellerId, rows);
    }
    await prisma.$transaction(async (tx) => {
      await tx.sellerMonthlySchedule.update({ where: { id: schedule.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: req.userId } });
      await tx.sellerMonthlyScheduleReceipt.createMany({
        data: [...grouped.keys()].map((sellerId) => ({ scheduleId: schedule.id, sellerId, version: schedule.version })),
        skipDuplicates: true,
      });
      for (const [sellerId, rows] of grouped.entries()) {
        const first = rows[0].workDate.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
        const last = rows[rows.length - 1].workDate.toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' });
        await tx.message.create({ data: { fromId: req.userId, toId: sellerId, type: 'announcement', title: `Sua escala de ${schedule.month} foi publicada`, content: `Você recebeu ${rows.length} dia(s) de trabalho, de ${first} a ${last}. Abra Minha escala no seu cadastro TenisCash para ver todas as datas, lojas e horários.`, priority: 'normal' } });
      }
    });
    const published = await prisma.sellerMonthlySchedule.findUnique({ where: { id: schedule.id }, include: monthlyInclude() });
    res.json({ schedule: published, notifiedSellers: grouped.size });
  } catch (err) { console.error('[schedule/months:publish]', err); res.status(500).json({ error: err.message }); }
});

router.post('/months/:month/reopen', async (req, res) => {
  try {
    const current = await prisma.sellerMonthlySchedule.findUnique({ where: { month: req.params.month } });
    if (!current) return res.status(404).json({ error: 'Escala mensal não encontrada.' });
    if (current.status === 'DRAFT') return res.json({ schedule: current });
    const schedule = await prisma.sellerMonthlySchedule.update({ where: { id: current.id }, data: { status: 'DRAFT', version: { increment: 1 }, publishedAt: null, publishedById: null } });
    res.json({ schedule });
  } catch (err) { console.error('[schedule/months:reopen]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// ATIVIDADES (AgendaActivity) — CRUD + filtro
// =====================================================================
router.get('/activities', async (req, res) => {
  try {
    const { from, to, type, sellerId, storeId } = req.query;
    const where = {
      ...(type ? { type } : {}),
      ...(sellerId ? { sellerId } : {}),
      ...(storeId ? { storeId } : {}),
    };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(String(from) + 'T00:00:00Z');
      if (to) where.date.lte = new Date(String(to) + 'T23:59:59Z');
    }
    const activities = await prisma.agendaActivity.findMany({
      where,
      orderBy: { date: 'asc' },
      take: 500,
      include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    res.json({ activities, types: ACT_TYPES });
  } catch (err) { console.error('[schedule/activities:list]', err); res.status(500).json({ error: err.message }); }
});

router.post('/activities', async (req, res) => {
  try {
    const { title, type, date, endDate, allDay, startTime, endTime, sellerId, storeId, note } = req.body || {};
    if (!title || !date) return res.status(400).json({ error: 'title e date são obrigatórios' });
    const t = ACT_TYPES.includes(type) ? type : 'evento';
    const activity = await prisma.agendaActivity.create({
      data: {
        title: String(title).trim(),
        type: t,
        date: new Date(String(date) + 'T12:00:00Z'),
        endDate: endDate ? new Date(String(endDate) + 'T12:00:00Z') : null,
        allDay: allDay === undefined ? true : !!allDay,
        startTime: startTime || null,
        endTime: endTime || null,
        sellerId: sellerId || null,
        storeId: storeId || null,
        note: note || null,
      },
      include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
    });
    res.json({ activity });
  } catch (err) { console.error('[schedule/activities:create]', err); res.status(500).json({ error: err.message }); }
});

router.put('/activities/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    if (b.title !== undefined) data.title = String(b.title).trim();
    if (b.type !== undefined) data.type = ACT_TYPES.includes(b.type) ? b.type : 'evento';
    if (b.date !== undefined) data.date = new Date(String(b.date) + 'T12:00:00Z');
    if (b.endDate !== undefined) data.endDate = b.endDate ? new Date(String(b.endDate) + 'T12:00:00Z') : null;
    if (b.allDay !== undefined) data.allDay = !!b.allDay;
    if (b.startTime !== undefined) data.startTime = b.startTime || null;
    if (b.endTime !== undefined) data.endTime = b.endTime || null;
    if (b.sellerId !== undefined) data.sellerId = b.sellerId || null;
    if (b.storeId !== undefined) data.storeId = b.storeId || null;
    if (b.note !== undefined) data.note = b.note || null;
    if (b.done !== undefined) data.done = !!b.done;
    const activity = await prisma.agendaActivity.update({ where: { id: req.params.id }, data });
    res.json({ activity });
  } catch (err) { console.error('[schedule/activities:update]', err); res.status(500).json({ error: err.message }); }
});

router.patch('/activities/:id/toggle', async (req, res) => {
  try {
    const cur = await prisma.agendaActivity.findUnique({ where: { id: req.params.id }, select: { done: true } });
    if (!cur) return res.status(404).json({ error: 'não encontrada' });
    const activity = await prisma.agendaActivity.update({ where: { id: req.params.id }, data: { done: !cur.done } });
    res.json({ activity });
  } catch (err) { console.error('[schedule/activities:toggle]', err); res.status(500).json({ error: err.message }); }
});

router.delete('/activities/:id', async (req, res) => {
  try {
    await prisma.agendaActivity.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { console.error('[schedule/activities:delete]', err); res.status(500).json({ error: err.message }); }
});

// =====================================================================
// WEEK — view interligada: escala × ponto (ClockIn) × vendas (Sale) × atividades
// ?date=YYYY-MM-DD (qualquer dia da semana alvo) &storeId= &sellerId=
// =====================================================================
router.get('/week', async (req, res) => {
  try {
    const q = String(req.query.date || '').trim();
    const storeId = req.query.storeId || null;
    const sellerId = req.query.sellerId || null;
    const base = /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q + 'T12:00:00Z') : new Date(new Date().getTime() - 3 * 3600 * 1000);
    const dow = base.getUTCDay(); // 0=dom..6=sab
    const monday = new Date(base.getTime() + (dow === 0 ? -6 : 1 - dow) * 86400000); // semana começa na segunda
    const days = Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86400000));
    const weekStart = dayWindow(ymdOf(days[0])).start;
    const weekEnd = dayWindow(ymdOf(days[6])).end;

    const shiftWhere = { active: true, ...(storeId ? { storeId } : {}), ...(sellerId ? { sellerId } : {}) };
    const monthKeys = [...new Set(days.map((day) => ymdOf(day).slice(0, 7)))];
    const [shifts, monthlyShifts, publishedMonths, clockins, sales, acts] = await Promise.all([
      prisma.sellerSchedule.findMany({
        where: shiftWhere,
        include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
      }),
      prisma.sellerMonthlyShift.findMany({
        where: { workDate: { gte: weekStart, lt: weekEnd }, schedule: { status: 'PUBLISHED' }, ...(storeId ? { storeId } : {}), ...(sellerId ? { sellerId } : {}) },
        include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
      }),
      prisma.sellerMonthlySchedule.findMany({ where: { month: { in: monthKeys }, status: 'PUBLISHED' }, select: { month: true } }),
      prisma.clockIn.findMany({
        where: { type: 'entry', timestamp: { gte: weekStart, lt: weekEnd }, ...(storeId ? { storeId } : {}), ...(sellerId ? { userId: sellerId } : {}) },
        select: { userId: true, storeId: true, timestamp: true },
      }),
      prisma.sale.findMany({
        where: { createdAt: { gte: weekStart, lt: weekEnd }, status: { not: 'canceled' }, ...(storeId ? { storeId } : {}), ...(sellerId ? { sellerId } : {}) },
        select: { sellerId: true, storeId: true, totalAmount: true, createdAt: true },
      }),
      prisma.agendaActivity.findMany({
        where: {
          date: { lte: weekEnd },
          ...(req.query.type ? { type: req.query.type } : {}),
          ...(storeId ? { OR: [{ storeId }, { storeId: null }] } : {}),
          ...(sellerId ? { OR: [{ sellerId }, { sellerId: null }] } : {}),
        },
        include: { seller: { select: { id: true, name: true } }, store: { select: { id: true, code: true, name: true } } },
        orderBy: { date: 'asc' },
      }),
    ]);

    // índices por dia
    const presentKey = (uid, sid, ymd) => `${uid}|${sid}|${ymd}`;
    const presentSet = new Set();
    clockins.forEach((c) => { presentSet.add(presentKey(c.userId, c.storeId, ymdOf(new Date(c.timestamp.getTime() - 3 * 3600 * 1000)))); });
    const salesAgg = {}; // `${sellerId}|${storeId}|${ymd}` -> {count, revenue}
    sales.forEach((s) => {
      const ymd = ymdOf(new Date(s.createdAt.getTime() - 3 * 3600 * 1000));
      const k = `${s.sellerId}|${s.storeId || ''}|${ymd}`;
      (salesAgg[k] = salesAgg[k] || { count: 0, revenue: 0 });
      salesAgg[k].count += 1; salesAgg[k].revenue += s.totalAmount || 0;
    });

    const out = days.map((d) => {
      const ymd = ymdOf(d);
      const weekday = d.getUTCDay();
      const publishedMonthSet = new Set(publishedMonths.map((row) => row.month));
      const sourceShifts = publishedMonthSet.has(ymd.slice(0, 7))
        ? monthlyShifts.filter((shift) => ymdOf(shift.workDate) === ymd)
        : shifts.filter((shift) => shift.weekday === weekday);
      const scheduled = sourceShifts.map((sh) => {
        const present = presentSet.has(presentKey(sh.sellerId, sh.storeId, ymd));
        const sa = salesAgg[`${sh.sellerId}|${sh.storeId}|${ymd}`] || { count: 0, revenue: 0 };
        return {
          shiftId: sh.id, sellerId: sh.sellerId, sellerName: sh.seller ? sh.seller.name : '?',
          employeeCode: sh.seller ? sh.seller.employeeCode : null,
          storeId: sh.storeId, storeCode: sh.store ? sh.store.code : '?', storeName: sh.store ? sh.store.name : '?',
          startTime: sh.startTime, endTime: sh.endTime,
          present, salesCount: sa.count, revenue: sa.revenue,
        };
      });
      const dayActs = acts.filter((a) => {
        const aStart = ymdOf(a.date);
        const aEnd = a.endDate ? ymdOf(a.endDate) : aStart;
        return ymd >= aStart && ymd <= aEnd;
      }).map((a) => ({ id: a.id, title: a.title, type: a.type, allDay: a.allDay, startTime: a.startTime, endTime: a.endTime, done: a.done, sellerName: a.seller ? a.seller.name : null, storeCode: a.store ? a.store.code : null }));
      return { date: ymd, weekday, scheduled, activities: dayActs };
    });

    res.json({ weekStart: ymdOf(days[0]), weekEnd: ymdOf(days[6]), filteredStoreId: storeId, filteredSellerId: sellerId, days: out });
  } catch (err) { console.error('[schedule/week]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
