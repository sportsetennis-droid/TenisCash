const assert = require('assert');
const reports = require('../src/services/equipeReports');

function run() {
  const text = reports.buildPersonalTaskReportText({
    name: 'Elias',
    now: new Date('2026-07-23T15:00:00.000Z'),
    items: [
      { position: 2, title: 'Tarefa pendente', status: 'PENDING' },
      { position: 1, title: 'Tarefa aprovada', status: 'APPROVED' },
      { position: 3, title: 'Aguardando fiscalizacao', status: 'SUBMITTED' },
    ],
  });
  assert(text.includes('Realizadas e aprovadas: 1/3'));
  assert(text.includes('33,3%'));
  assert(text.includes('Tarefa pendente: sem registro aprovado'));
  assert(text.includes('Aguardando fiscalizacao: enviada, aguardando fiscalizacao'));

  const zero = reports.buildPersonalTaskReportText({
    name: 'Elias',
    items: [{ title: 'A', status: 'REJECTED' }],
  });
  assert(zero.includes('0%'));
  assert(zero.includes('A: devolvida para correcao'));

  const noChecklist = reports.buildPersonalTaskReportText({ name: 'Elias', items: [] });
  assert(noChecklist.includes('não calculável'));
  console.log('OK: mensagens pessoais de entrada e resumo de saída');
  process.exit(0);
}

run();
