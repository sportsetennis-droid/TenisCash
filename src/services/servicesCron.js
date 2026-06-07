// Cron do módulo de SERVIÇOS (barbearia/salão):
//   - Cobrança automática do clube de assinatura (gera Charge no vencimento)
//   - Lembrete de horário (marca agendamentos das próximas 24h)
// Timezone America/Fortaleza (UTC-3, sem DST) — regra do projeto.
const cron = require('node-cron');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Gera a cobrança das assinaturas vencidas e avança o próximo vencimento.
async function billDueSubscriptions() {
  const now = new Date();
  const due = await prisma.professionalSubscription.findMany({ where: { status: 'active', nextDueDate: { lte: now } }, take: 300 });
  let created = 0;
  for (const s of due) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.charge.create({
          data: { professionalId: s.professionalId, clientId: s.clientId, subscriptionId: s.id, amount: s.amount, description: `Assinatura: ${s.title}`, settlementMode: 'off_platform', method: 'pix', status: 'pending', dueDate: s.nextDueDate },
        });
        const next = new Date(s.nextDueDate);
        if (s.recurrence === 'weekly') next.setDate(next.getDate() + 7);
        else next.setMonth(next.getMonth() + 1);
        await tx.professionalSubscription.update({ where: { id: s.id }, data: { nextDueDate: next } });
      });
      created++;
    } catch (e) { console.error('[servicesCron] billing falhou sub', s.id, e.message); }
  }
  if (created) console.log(`[servicesCron] ${created} cobranca(s) de assinatura geradas`);
  return created;
}

// Marca lembretes dos agendamentos nas próximas 24h.
// TODO(skeleton): envio real via WhatsApp/push exige aprovação humana (regra do projeto).
async function queueReminders() {
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * 3600000);
  const appts = await prisma.serviceAppointment.findMany({ where: { status: { in: ['booked', 'confirmed'] }, reminderSentAt: null, startAt: { gte: now, lte: in24 } }, take: 300 });
  let n = 0;
  for (const a of appts) {
    try { await prisma.serviceAppointment.update({ where: { id: a.id }, data: { reminderSentAt: new Date() } }); n++; } catch (_) {}
  }
  if (n) console.log(`[servicesCron] ${n} lembrete(s) marcados (envio real = TODO)`);
  return n;
}

function startServicesCron() {
  cron.schedule('0 8 * * *', billDueSubscriptions, { timezone: 'America/Fortaleza' }); // 08:00 diário
  cron.schedule('5 * * * *', queueReminders, { timezone: 'America/Fortaleza' }); // hora em hora
  console.log('[servicesCron] iniciado (cobranca assinatura 08:00 + lembretes hora em hora)');
}

module.exports = { startServicesCron, billDueSubscriptions, queueReminders };
