// =====================================================================
// Testes: fuso de Fortaleza no agendamento + lembrete ~3h antes (PR #148)
//   DATABASE_URL=postgresql://postgres@localhost:55432/<descartavel> node scripts/test-activity-reminders.js
// Roda igual com o servidor em UTC (Railway) ou em -03 (rode com TZ=UTC também).
// Prova: "19:00" digitado = 19:00 em João Pessoa; lembrete 1x só; NUNCA WhatsApp.
// =====================================================================
const URL = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(URL)) { console.error('recusado: só banco local descartável'); process.exit(2); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 't';
process.env.WA_BRIDGE_KEY = 'teste-ponte'; // se o lembrete mandasse WhatsApp, cairia na fila
const assert = require('assert');
const ftz = require('../src/services/fortalezaTime');

let pass = 0, fail = 0;
async function t(nome, fn) {
  try { await fn(); pass++; console.log('  ok  ', nome); } catch (e) { fail++; console.log('  FALHA', nome, '\n       ', e.message); }
}

(async () => {
  await t('parseLocal: "19:00" sem fuso é hora de João Pessoa (22:00 UTC)', () => {
    assert.strictEqual(ftz.parseLocal('2026-11-20T19:00').toISOString(), '2026-11-20T22:00:00.000Z');
    assert.strictEqual(ftz.parseLocal('2026-11-20T19:00:00.000Z').toISOString(), '2026-11-20T19:00:00.000Z', 'com Z respeita');
    assert.strictEqual(ftz.parseLocal(''), null);
    assert.strictEqual(ftz.parseLocal('lixo'), null);
  });
  await t('wallClock / partsOf / fmtTime no relógio de João Pessoa', () => {
    const d = ftz.wallClock(2026, 10, 20, 19, 0);
    assert.strictEqual(d.toISOString(), '2026-11-20T22:00:00.000Z');
    const p = ftz.partsOf(d);
    assert.deepStrictEqual([p.day, p.hh, p.mm], [20, 19, 0]);
    assert.strictEqual(ftz.fmtTime(d), '19:00');
  });

  const { prisma } = require('../src/middleware');
  const rem = require('../src/services/activityReminders');
  const training = require('../src/services/trainingSession');
  const sfx = Date.now().toString(36);
  const dono = await prisma.user.create({ data: { name: 'Org ' + sfx, phone: 'o' + sfx, pin: 'x', role: 'admin' } });
  const atleta = await prisma.user.create({ data: { name: 'Atleta ' + sfx, phone: 'a' + sfx, pin: 'x' } });
  const tor = await prisma.tournament.create({ data: { slug: 'rem-' + sfx, name: 'Rem ' + sfx, sport: 'FUTSAL', ownerId: dono.id } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: tor.id, name: 'Livre' } });
  const e1 = await prisma.tournamentEntry.create({ data: { tournamentId: tor.id, categoryId: cat.id, name: 'Casa ' + sfx, status: 'CONFIRMED' } });
  const e2 = await prisma.tournamentEntry.create({ data: { tournamentId: tor.id, categoryId: cat.id, name: 'Fora ' + sfx, status: 'CONFIRMED' } });
  await prisma.entryMember.create({ data: { entryId: e1.id, userId: atleta.id } });

  await t('treino recorrente "19:00" cai às 19:00 de João Pessoa em todas as semanas', async () => {
    const r = await training.createRecurring({ tournamentId: tor.id, entryId: e1.id, createdByUserId: dono.id, title: 'Treino', weekdays: [1, 3], time: '19:00', weeks: 3 });
    const lista = r.sessions || (r.ok && r.data && r.data.sessions) || [];
    assert.ok(lista.length >= 4, 'sessões: ' + lista.length + ' ' + JSON.stringify(r).slice(0, 200));
    for (const s of lista) {
      const p = ftz.partsOf(new Date(s.scheduledAt));
      assert.deepStrictEqual([p.hh, p.mm], [19, 0], 'horário ' + new Date(s.scheduledAt).toISOString());
      assert.ok([1, 3].includes(p.weekday), 'dia da semana ' + p.weekday);
    }
  });

  const agora = new Date();
  const jogo = await prisma.tournamentMatch.create({ data: { tournamentId: tor.id, categoryId: cat.id, round: 1, stage: 'LEAGUE', homeEntryId: e1.id, awayEntryId: e2.id, status: 'SCHEDULED', scheduledAt: new Date(agora.getTime() + 2 * 3600 * 1000) } });
  const longe = await prisma.tournamentMatch.create({ data: { tournamentId: tor.id, categoryId: cat.id, round: 2, stage: 'LEAGUE', homeEntryId: e1.id, awayEntryId: e2.id, status: 'SCHEDULED', scheduledAt: new Date(agora.getTime() + 8 * 3600 * 1000) } });
  const filaAntes = await prisma.whatsAppOutbox.count().catch(() => 0);

  await t('lembrete: jogo em 2h avisa o atleta; jogo em 8h ainda não', async () => {
    await rem.runActivityReminders(agora);
    const n = await prisma.appNotification.findMany({ where: { userId: atleta.id, type: 'schedule' } });
    assert.strictEqual(n.length, 1, 'avisos: ' + n.length);
    assert.match(n[0].title, /^Jogo hoje às|^Jogo amanhã às/);
    assert.ok((await prisma.tournamentMatch.findUnique({ where: { id: jogo.id } })).reminderSentAt);
    assert.strictEqual((await prisma.tournamentMatch.findUnique({ where: { id: longe.id } })).reminderSentAt, null);
  });
  await t('lembrete não repete (2ª rodada não manda de novo)', async () => {
    await rem.runActivityReminders(agora);
    assert.strictEqual(await prisma.appNotification.count({ where: { userId: atleta.id, type: 'schedule' } }), 1);
  });
  await t('lembrete NUNCA vai pro WhatsApp (mesmo com ponte configurada)', async () => {
    const depois = await prisma.whatsAppOutbox.count().catch(() => 0);
    assert.strictEqual(depois, filaAntes);
  });
  await t('texto do horário usa o relógio de João Pessoa', () => {
    const now = ftz.wallClock(2026, 10, 20, 10, 0);
    assert.strictEqual(rem.whenText(ftz.wallClock(2026, 10, 20, 19, 0), now), 'hoje às 19:00');
    assert.strictEqual(rem.whenText(ftz.wallClock(2026, 10, 21, 8, 0), now), 'amanhã às 08:00');
  });

  console.log(`\n${pass} ok, ${fail} falha(s)`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); process.exit(1); });
