const assert = require('assert');
const {
  checkpointToMinutes,
  formatMinutes,
  buildTaskReportSchedule,
  scheduleDeadlineState,
  classifyProductionDay,
  splitWhatsAppText,
} = require('../src/services/taskComplianceReport');

function item(position, phase, status, title = `${phase} ${position}`) {
  return { position, phase, status, title };
}

function run() {
  const shift = { scheduleStart: '08:00', scheduleEnd: '18:00' };
  const dailySchedule = buildTaskReportSchedule([
    shift,
    { scheduleStart: '09:00', scheduleEnd: '17:00' },
  ]);
  assert.strictEqual(dailySchedule.openingMinutes, 8 * 60, 'deve usar a primeira escala como abertura real');
  assert.strictEqual(dailySchedule.closingMinutes, 18 * 60, 'deve alcançar o fechamento da última escala');
  assert.deepStrictEqual(
    dailySchedule.slots.map(formatMinutes),
    ['09:00', '12:00', '15:00', '18:00'],
    'primeiro relatório deve sair +1h e os demais a cada 3h',
  );
  assert.deepStrictEqual(
    buildTaskReportSchedule([{ scheduleStart: '09:30', scheduleEnd: '20:00' }]).slots.map(formatMinutes),
    ['10:30', '13:30', '16:30', '19:30', '22:30'],
    'minutos da escala devem ser preservados sem arredondamento',
  );
  assert.strictEqual(buildTaskReportSchedule([{ scheduleStart: null, scheduleEnd: null }]).scheduleKnown, false);
  const observedOpeningSchedule = buildTaskReportSchedule([], { openingMinutes: 8 * 60 });
  assert.strictEqual(observedOpeningSchedule.scheduleKnown, true, 'primeiro ponto deve provar a abertura sem estimativa');
  assert.deepStrictEqual(
    observedOpeningSchedule.slots.map(formatMinutes),
    ['09:00', '12:00', '15:00', '18:00', '21:00'],
    'sem fechamento cadastrado, os ciclos devem permanecer dentro do mesmo dia',
  );
  assert.strictEqual(checkpointToMinutes('09:30'), 570);
  assert.strictEqual(checkpointToMinutes(13), 780, 'número pequeno mantém compatibilidade como hora');
  assert.strictEqual(checkpointToMinutes(570), 570, 'número grande representa minuto do dia');

  assert.deepStrictEqual(
    [...scheduleDeadlineState(shift, '09:00').duePhases],
    ['ARRIVAL'],
    'primeira conferência deve cobrar somente a chegada',
  );
  assert.deepStrictEqual(
    [...scheduleDeadlineState(shift, '12:00').duePhases],
    ['ARRIVAL', 'FIRST_TURN'],
    'três horas depois deve vencer o primeiro turno',
  );
  assert.deepStrictEqual(
    [...scheduleDeadlineState(shift, '15:00').duePhases],
    ['ARRIVAL', 'FIRST_TURN', 'SECOND_TURN'],
    'mais três horas depois deve vencer o segundo turno',
  );
  const entryOnly = scheduleDeadlineState({ scheduleStart: '08:00', scheduleEnd: null }, '21:00');
  assert.strictEqual(entryOnly.scheduleKnown, true);
  assert.strictEqual(entryOnly.endKnown, false);
  assert.deepStrictEqual(
    [...entryOnly.duePhases],
    ['ARRIVAL', 'FIRST_TURN', 'SECOND_TURN'],
    'sem horário de saída, a saída não pode ser acusada automaticamente',
  );
  assert.deepStrictEqual(
    [...scheduleDeadlineState(shift, 13).duePhases],
    ['ARRIVAL', 'FIRST_TURN'],
    '13h deve cobrar chegada e primeiro turno em uma escala 08h-18h',
  );
  assert.deepStrictEqual(
    [...scheduleDeadlineState(shift, 18).duePhases],
    ['ARRIVAL', 'FIRST_TURN', 'SECOND_TURN', 'EXIT'],
    '18h deve cobrar todas as etapas quando a escala terminou',
  );

  const classified = classifyProductionDay({
    ...shift,
    status: 'OPEN',
    items: [
      item(1, 'ARRIVAL', 'APPROVED', 'Story de chegada'),
      item(2, 'FIRST_TURN', 'SUBMITTED', 'Reels do primeiro turno'),
      item(3, 'FIRST_TURN', 'PENDING', 'Foto do primeiro turno'),
      item(4, 'SECOND_TURN', 'PENDING', 'Reels do segundo turno'),
      item(5, 'EXIT', 'REJECTED', 'Story de saída'),
      item(6, 'ARRIVAL', 'EXCUSED', 'Foto da bolsa'),
    ],
  }, 13);
  assert.deepStrictEqual(classified.approved.map((row) => row.title), ['Story de chegada']);
  assert.deepStrictEqual(classified.awaitingReview.map((row) => row.title), ['Reels do primeiro turno']);
  assert.deepStrictEqual(classified.noncompliant.map((row) => row.title), ['Foto do primeiro turno']);
  assert.deepStrictEqual(classified.correctionInTime.map((row) => row.title), ['Story de saída']);
  assert.deepStrictEqual(classified.notDue.map((row) => row.title), ['Reels do segundo turno']);
  assert.deepStrictEqual(classified.excused.map((row) => row.title), ['Foto da bolsa']);

  const missingSchedule = classifyProductionDay({
    status: 'OPEN',
    scheduleStart: null,
    scheduleEnd: null,
    items: [item(1, 'ARRIVAL', 'PENDING')],
  }, 21);
  assert.strictEqual(missingSchedule.noncompliant.length, 0, 'sem escala o sistema não deve estimar descumprimento');
  assert.strictEqual(missingSchedule.notDue.length, 1);

  const humanClosed = classifyProductionDay({
    status: 'NONCOMPLIANT',
    scheduleStart: null,
    scheduleEnd: null,
    items: [
      item(1, 'EXIT', 'REJECTED'),
      item(2, 'EXIT', 'SUBMITTED'),
    ],
  }, 13);
  assert.strictEqual(humanClosed.noncompliant.length, 2, 'decisão humana de não conformidade deve prevalecer');

  const submittedAfterDeadline = classifyProductionDay({
    ...shift,
    status: 'SUBMITTED',
    items: [item(1, 'EXIT', 'SUBMITTED')],
  }, 21);
  assert.strictEqual(submittedAfterDeadline.awaitingReview.length, 1, 'envio nunca deve virar aprovado sem fiscalização');
  assert.strictEqual(submittedAfterDeadline.noncompliant.length, 0);

  const chunks = splitWhatsAppText('linha curta\n'.repeat(1000), 500);
  assert(chunks.length > 1);
  assert(chunks.every((chunk) => chunk.length <= 500), 'nenhuma parte pode ultrapassar o limite');

  console.log('OK: relatório de cumprimento usa prazo da escala e aprovação humana');
}

run();
