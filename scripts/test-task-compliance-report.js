const assert = require('assert');
const {
  scheduleDeadlineState,
  classifyProductionDay,
  splitWhatsAppText,
} = require('../src/services/taskComplianceReport');

function item(position, phase, status, title = `${phase} ${position}`) {
  return { position, phase, status, title };
}

function run() {
  const shift = { scheduleStart: '08:00', scheduleEnd: '18:00' };
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
