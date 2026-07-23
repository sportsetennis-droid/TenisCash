// Cria o checklist dos vendedores escalados e acompanha pendencias durante o dia.
// A fiscalizacao automatica acontece no envio da atividade; este robo lembra o
// que falta e deixa para revisao humana somente as excecoes tecnicas.

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

function localMinutes(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
  return (hour * 60) + minute;
}

function parseScheduleMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return (hour * 60) + minute;
}

function reminderKinds(day, now = new Date()) {
  const start = parseScheduleMinutes(day.scheduleStart);
  let end = parseScheduleMinutes(day.scheduleEnd);
  if (start === null || end === null) return ['DAY_START'];
  if (end <= start) end += 1440;
  let current = localMinutes(now);
  if (current < start && end > 1440) current += 1440;
  if (current < start) return [];
  const kinds = ['DAY_START'];
  const midpoint = start + Math.floor((end - start) / 2);
  if (current >= midpoint) kinds.push('MID_SHIFT');
  if (current >= end) kinds.push('SHIFT_END');
  return kinds;
}

function reminderCopy(kind, progress) {
  const toRegister = (progress.pending || 0) + (progress.rejected || 0);
  const awaiting = progress.submitted || 0;
  if (kind === 'DAY_START') {
    return {
      title: 'Robô de atividades — checklist de hoje',
      content: `Seu checklist diário está disponível no TenisCash. São ${progress.total || 0} atividades. Registre cada uma com foto/print ou link e acompanhe a aprovação.`,
    };
  }
  if (kind === 'MID_SHIFT') {
    return {
      title: 'Robô de atividades — acompanhamento do turno',
      content: `Até agora, faltam ${toRegister} atividade(s) para registrar ou corrigir e ${awaiting} aguardam fiscalização. Abra Produção diária para conferir exatamente o que falta.`,
    };
  }
  return {
    title: 'Robô de atividades — conferência do fim do turno',
    content: `O turno chegou ao horário final com ${toRegister} atividade(s) ainda sem registro/correção e ${awaiting} aguardando fiscalização. O robô não aplica penalidade; a empresa fará a conferência humana.`,
  };
}

async function findRobotSender() {
  return prisma.user.findFirst({
    where: { active: true, role: { in: ['superadmin', 'admin'] } },
    orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
}

async function sendReminder(day, kind, progress, senderId) {
  const copy = reminderCopy(kind, progress);
  try {
    await prisma.$transaction(async (tx) => {
      const reminder = await tx.sellerProductionReminder.create({
        data: {
          dayId: day.id,
          sellerId: day.sellerId,
          storeId: day.storeId,
          kind,
          pendingCount: (progress.pending || 0) + (progress.rejected || 0),
        },
      });
      const message = await tx.message.create({
        data: {
          fromId: senderId,
          toId: day.sellerId,
          type: 'announcement',
          title: copy.title,
          content: copy.content,
          priority: kind === 'SHIFT_END' ? 'high' : 'normal',
        },
      });
      await tx.sellerProductionReminder.update({ where: { id: reminder.id }, data: { messageId: message.id } });
    });
    return true;
  } catch (err) {
    if (err?.code === 'P2002') return false;
    throw err;
  }
}

async function ensureScheduledProductionDays(date = new Date()) {
  const ymd = localYmd(date);
  const { start, end } = dayBounds(ymd);
  const weekday = new Date(`${ymd}T12:00:00.000Z`).getUTCDay();
  const publishedMonth = await prisma.sellerMonthlySchedule.findFirst({
    where: { month: ymd.slice(0, 7), status: 'PUBLISHED' },
    select: { id: true, version: true },
  });
  const [schedules, absences] = await Promise.all([
    publishedMonth
      ? prisma.sellerMonthlyShift.findMany({
        where: { scheduleId: publishedMonth.id, workDate: { gte: start, lt: end }, seller: { role: 'seller', active: true }, store: { active: true } },
        orderBy: [{ startTime: 'asc' }, { createdAt: 'asc' }],
        select: { sellerId: true, storeId: true, startTime: true, endTime: true },
      })
      : prisma.sellerSchedule.findMany({
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
    const existing = await prisma.sellerProductionDay.findUnique({ where: { sellerId_workDate: { sellerId: schedule.sellerId, workDate: start } }, select: { id: true, status: true, policyVersion: true } });
    if (existing) {
      if (!['APPROVED', 'NONCOMPLIANT', 'EXCUSED'].includes(existing.status)) {
        await prisma.$transaction([
          prisma.sellerProductionItem.createMany({
            data: production.RULES.map((rule) => ({
              dayId: existing.id,
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
            where: { dayId: existing.id, ruleKey: rule.key },
            data: {
              phase: rule.phase,
              position: rule.position,
              title: rule.title,
              mediaType: rule.mediaType,
              targetDurationSec: rule.targetDurationSec || null,
              requiredProducts: rule.requiredProducts || 0,
            },
          })),
          prisma.sellerProductionDay.update({ where: { id: existing.id }, data: { policyVersion: production.POLICY_VERSION } }),
        ]);
      }
      continue;
    }
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
  const source = publishedMonth ? `mensal v${publishedMonth.version}` : 'fixa semanal';
  console.log(`[sellerProductionCron] ${ymd}: ${created} checklist(s) criado(s), ${skipped} escala(s) ignorada(s), fonte ${source}`);
  return { ymd, created, skipped, source };
}

async function monitorSellerProduction(date = new Date()) {
  await ensureScheduledProductionDays(date);
  const { start, end } = dayBounds(localYmd(date));
  const sender = await findRobotSender();
  if (!sender) return { checked: 0, sent: 0, reason: 'no_admin_sender' };
  const days = await prisma.sellerProductionDay.findMany({
    where: { workDate: { gte: start, lt: end }, status: { notIn: ['APPROVED', 'NONCOMPLIANT', 'EXCUSED'] } },
    include: { items: { select: { status: true } }, reminders: { select: { kind: true } } },
  });
  let sent = 0;
  for (const day of days) {
    const progress = production.dayProgress(day.items);
    const existing = new Set(day.reminders.map((row) => row.kind));
    for (const kind of reminderKinds(day, date)) {
      if (existing.has(kind)) continue;
      if (kind !== 'DAY_START' && progress.complete) continue;
      if (await sendReminder(day, kind, progress, sender.id)) sent += 1;
    }
  }
  console.log(`[sellerProductionCron] monitor: ${days.length} dia(s), ${sent} lembrete(s)`);
  return { checked: days.length, sent };
}

function startSellerProductionCron() {
  cron.schedule('5 0 * * *', () => ensureScheduledProductionDays().catch((err) => console.error('[sellerProductionCron] criacao falhou:', err.message)), { timezone: TZ });
  cron.schedule('*/15 * * * *', () => monitorSellerProduction().catch((err) => console.error('[sellerProductionCron] monitor falhou:', err.message)), { timezone: TZ });
  console.log(`[sellerProductionCron] agendado: checklist 00:05 + monitor a cada 15 min (timezone ${TZ})`);
  monitorSellerProduction().catch((err) => console.error('[sellerProductionCron] startup falhou:', err.message));
}

module.exports = {
  startSellerProductionCron,
  ensureScheduledProductionDays,
  monitorSellerProduction,
  reminderKinds,
  reminderCopy,
  localYmd,
  dayBounds,
};
