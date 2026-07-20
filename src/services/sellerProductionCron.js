// Cria o checklist dos vendedores escalados no inicio de cada dia.
// Nao reprova, pune ou fecha dias automaticamente.

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const production = require('./sellerProduction');

const prisma = new PrismaClient();
const TZ = 'America/Fortaleza';

function localYmd(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

function dayBounds(ymd) {
  const start = new Date(`${ymd}T03:00:00.000Z`);
  return { start, end: new Date(start.getTime() + 86400000) };
}

async function ensureScheduledProductionDays(date = new Date()) {
  const ymd = localYmd(date);
  const { start, end } = dayBounds(ymd);
  const weekday = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const [schedules, absences] = await Promise.all([
    prisma.sellerSchedule.findMany({
      where: { active: true, weekday, seller: { role: 'seller', active: true }, store: { active: true } },
      orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }],
      select: { sellerId: true, storeId: true, startTime: true, endTime: true },
    }),
    prisma.agendaActivity.findMany({
      where: {
        type: { in: ['folga', 'ferias', 'feriado'] },
        date: { lt: end },
        OR: [{ endDate: null, date: { gte: start } }, { endDate: { gte: start } }],
      },
      select: { type: true, sellerId: true, storeId: true },
    }),
  ]);

  const createdForSeller = new Set();
  let created = 0;
  let skipped = 0;
  for (const schedule of schedules) {
    if (createdForSeller.has(schedule.sellerId)) { skipped += 1; continue; }
    const absent = absences.some((activity) => {
      const sellerMatches = !activity.sellerId || activity.sellerId === schedule.sellerId;
      const storeMatches = !activity.storeId || activity.storeId === schedule.storeId;
      return sellerMatches && storeMatches;
    });
    if (absent) { skipped += 1; continue; }
    createdForSeller.add(schedule.sellerId);
    const existing = await prisma.sellerProductionDay.findUnique({ where: { sellerId_workDate: { sellerId: schedule.sellerId, workDate: start } }, select: { id: true } });
    if (existing) continue;
    await prisma.sellerProductionDay.create({
      data: {
        sellerId: schedule.sellerId,
        storeId: schedule.storeId,
        workDate: start,
        policyVersion: production.POLICY_VERSION,
        incentivePct: production.INCENTIVE_PCT,
        scheduleStart: schedule.startTime,
        scheduleEnd: schedule.endTime,
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
    });
    created += 1;
  }
  console.log(`[sellerProductionCron] ${ymd}: ${created} checklist(s) criado(s), ${skipped} escala(s) ignorada(s)`);
  return { ymd, created, skipped };
}

function startSellerProductionCron() {
  cron.schedule('5 0 * * *', () => ensureScheduledProductionDays().catch((err) => console.error('[sellerProductionCron] falha:', err.message)), { timezone: TZ });
  console.log(`[sellerProductionCron] agendado: 00:05 (timezone ${TZ})`);
  ensureScheduledProductionDays().catch((err) => console.error('[sellerProductionCron] startup falhou:', err.message));
}

module.exports = { startSellerProductionCron, ensureScheduledProductionDays, localYmd, dayBounds };
