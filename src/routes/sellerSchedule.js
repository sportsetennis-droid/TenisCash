// Escala mensal pessoal do vendedor. Somente meses publicados ficam visíveis.

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

function requireSeller(req, res, next) {
  if (req.userRole !== 'seller') return res.status(403).json({ error: 'Acesso restrito ao vendedor.' });
  next();
}

function localMonth(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Fortaleza', year: 'numeric', month: '2-digit' }).slice(0, 7);
}

function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
}

router.get('/months/:month?', requireSeller, async (req, res) => {
  try {
    const month = req.params.month || localMonth();
    if (!validMonth(month)) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const schedule = await prisma.sellerMonthlySchedule.findFirst({
      where: { month, status: 'PUBLISHED', shifts: { some: { sellerId: req.userId } } },
      select: {
        id: true,
        month: true,
        version: true,
        publishedAt: true,
        shifts: {
          where: { sellerId: req.userId },
          orderBy: [{ workDate: 'asc' }, { startTime: 'asc' }],
          select: { id: true, workDate: true, startTime: true, endTime: true, note: true, store: { select: { id: true, code: true, name: true, address: true, mall: true } } },
        },
        receipts: {
          where: { sellerId: req.userId },
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true, version: true, notifiedAt: true, viewedAt: true, acknowledgedAt: true },
        },
      },
    });
    if (!schedule) return res.json({ schedule: null, month });
    const receipt = schedule.receipts[0] || null;
    if (receipt && receipt.version === schedule.version && !receipt.viewedAt) {
      await prisma.sellerMonthlyScheduleReceipt.update({ where: { id: receipt.id }, data: { viewedAt: new Date() } });
      receipt.viewedAt = new Date();
    }
    res.json({ schedule: { ...schedule, receipt, receipts: undefined }, month });
  } catch (err) { console.error('[seller/schedule:get]', err); res.status(500).json({ error: err.message }); }
});

router.post('/months/:month/acknowledge', requireSeller, async (req, res) => {
  try {
    if (!validMonth(req.params.month)) return res.status(400).json({ error: 'Mês inválido. Use YYYY-MM.' });
    const schedule = await prisma.sellerMonthlySchedule.findFirst({
      where: { month: req.params.month, status: 'PUBLISHED', shifts: { some: { sellerId: req.userId } } },
      select: { id: true, version: true },
    });
    if (!schedule) return res.status(404).json({ error: 'Escala publicada não encontrada para você neste mês.' });
    const receipt = await prisma.sellerMonthlyScheduleReceipt.update({
      where: { scheduleId_sellerId_version: { scheduleId: schedule.id, sellerId: req.userId, version: schedule.version } },
      data: { viewedAt: new Date(), acknowledgedAt: new Date() },
    });
    res.json({ receipt });
  } catch (err) { console.error('[seller/schedule:ack]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
