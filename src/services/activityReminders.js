// =====================================================================
// APEX — Lembrete automático de TREINO e JOGO (push grátis no celular)
// ---------------------------------------------------------------------
// A cada 10 min procura treinos e jogos marcados que começam nas próximas
// LEAD_HOURS horas e ainda não foram lembrados, e avisa os atletas pelo
// notify() (sininho + push). Marca reminderSentAt ANTES de enviar
// (updateMany condicional) — duas instâncias nunca lembram em dobro.
//
// Treino: atletas ativos do clube, menos quem respondeu "Não vou".
// Jogo: membros das inscrições (EntryMember) + atletas ativos do clube
// (TeamMembership) dos dois lados.
//
// Custo zero: só push/in-app. WhatsApp só se WA_AUTO_NOTIFY=1 (ver notify.js).
// Desligar: DISABLE_ACTIVITY_REMINDERS=1.
// =====================================================================

const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { notifyMany } = require('./notify');
const ftz = require('./fortalezaTime');

const LEAD_HOURS = 3;
let running = false;

async function clubActiveUserIds(tournamentId, clubName) {
  if (!clubName) return [];
  const rows = await prisma.teamMembership.findMany({ where: { tournamentId, clubName, status: 'ACTIVE' }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

// Reserva o item: só quem conseguir marcar reminderSentAt envia.
async function claim(model, id) {
  const r = await prisma[model].updateMany({ where: { id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
  return r.count === 1;
}

// "hoje às 19:00" · "amanhã às 08:00" · "dia 12/11 às 19:00" (relógio de João Pessoa)
function whenText(date, now = new Date()) {
  const n = ftz.partsOf(now);
  const a = ftz.partsOf(new Date(date));
  const hora = ftz.fmtTime(date);
  const dayKey = (p) => Date.UTC(p.year, p.month, p.day);
  const diffDays = Math.round((dayKey(a) - dayKey(n)) / 86400000);
  if (diffDays === 0) return `hoje às ${hora}`;
  if (diffDays === 1) return `amanhã às ${hora}`;
  return `dia ${String(a.day).padStart(2, '0')}/${String(a.month + 1).padStart(2, '0')} às ${hora}`;
}

async function remindTrainings(from, to, now = from) {
  const sessions = await prisma.trainingSession.findMany({
    where: { status: 'SCHEDULED', reminderSentAt: null, scheduledAt: { gte: from, lte: to } },
    take: 200,
  });
  let sent = 0;
  for (const s of sessions) {
    if (!(await claim('trainingSession', s.id))) continue;
    const members = await clubActiveUserIds(s.tournamentId, s.clubName);
    const declined = await prisma.trainingAttendance.findMany({ where: { sessionId: s.id, rsvp: 'DECLINED' }, select: { userId: true } });
    const skip = new Set(declined.map((d) => d.userId));
    const ids = members.filter((u) => !skip.has(u));
    const onde = s.location ? ` em ${s.location}` : '';
    await notifyMany(ids, {
      type: 'training',
      title: `Treino ${whenText(s.scheduledAt, now)}`,
      body: `${s.clubName}: ${s.title}${onde}. Confirme presença no app.`,
      link: `/torneios.html#t/${s.tournamentId}`,
    });
    sent += ids.length;
  }
  return { items: sessions.length, sent };
}

async function remindMatches(from, to, now = from) {
  const matches = await prisma.tournamentMatch.findMany({
    where: { status: 'SCHEDULED', reminderSentAt: null, scheduledAt: { gte: from, lte: to }, homeEntryId: { not: null }, awayEntryId: { not: null } },
    include: { homeEntry: { select: { id: true, name: true } }, awayEntry: { select: { id: true, name: true } } },
    take: 200,
  });
  let sent = 0;
  for (const m of matches) {
    if (!(await claim('tournamentMatch', m.id))) continue;
    const entryIds = [m.homeEntryId, m.awayEntryId];
    const members = await prisma.entryMember.findMany({ where: { entryId: { in: entryIds } }, select: { userId: true } });
    const ids = [
      ...members.map((x) => x.userId),
      ...(await clubActiveUserIds(m.tournamentId, m.homeEntry && m.homeEntry.name)),
      ...(await clubActiveUserIds(m.tournamentId, m.awayEntry && m.awayEntry.name)),
    ];
    const onde = m.location ? ` em ${m.location}` : '';
    await notifyMany(ids, {
      type: 'schedule',
      title: `Jogo ${whenText(m.scheduledAt, now)}`,
      body: `${(m.homeEntry && m.homeEntry.name) || 'A definir'} × ${(m.awayEntry && m.awayEntry.name) || 'A definir'}${onde}.`,
      link: `/torneios.html#t/${m.tournamentId}`,
    });
    sent += new Set(ids).size;
  }
  return { items: matches.length, sent };
}

async function runActivityReminders(now = new Date()) {
  if (running) return { skipped: true };
  running = true;
  try {
    const to = new Date(now.getTime() + LEAD_HOURS * 3600 * 1000);
    const trainings = await remindTrainings(now, to);
    const matches = await remindMatches(now, to);
    if (trainings.items || matches.items) {
      console.log(`[activityReminders] treinos=${trainings.items} (${trainings.sent} avisos) jogos=${matches.items} (${matches.sent} avisos)`);
    }
    return { trainings, matches };
  } catch (e) {
    console.error('[activityReminders] erro:', e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

function startActivityReminders() {
  if (process.env.DISABLE_ACTIVITY_REMINDERS === '1') {
    console.log('[activityReminders] desativado (DISABLE_ACTIVITY_REMINDERS=1)');
    return;
  }
  cron.schedule('*/10 * * * *', () => { runActivityReminders(); }, { timezone: ftz.TZ });
  console.log(`[activityReminders] ativo — lembrete de treino/jogo ${LEAD_HOURS}h antes, a cada 10 min`);
}

module.exports = { startActivityReminders, runActivityReminders, whenText, LEAD_HOURS };
