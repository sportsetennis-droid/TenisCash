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

// dia (YYYY-MM-DD) -> janela UTC [00:00, +24h) no fuso de João Pessoa (UTC-3)
function dayWindow(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, 3, 0, 0));
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}
function ymdOf(dt) { return dt.toISOString().slice(0, 10); }

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
    const [shifts, clockins, sales, acts] = await Promise.all([
      prisma.sellerSchedule.findMany({
        where: shiftWhere,
        include: { seller: { select: { id: true, name: true, employeeCode: true } }, store: { select: { id: true, code: true, name: true } } },
      }),
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
      const scheduled = shifts.filter((sh) => sh.weekday === weekday).map((sh) => {
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
