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

  const live = reports.buildLiveTaskUpdateText({
    sellerName: 'Elias',
    event: 'fiscalizacao',
    items: [
      { position: 1, title: 'Chegada', status: 'APPROVED' },
      { position: 2, title: 'Reels', status: 'PENDING' },
      { position: 3, title: 'Foto', status: 'SUBMITTED' },
    ],
  });
  assert(live.includes('Elias'));
  assert(live.includes('33%'));
  assert(live.includes('Chegada'));
  assert(live.includes('Reels'));
  assert(live.includes('SEM registro aprovado') || live.includes('sem registro aprovado'));
  assert(live.includes('NÃO é considerada executada') || live.includes('NAO e considerada executada'));
  console.log('OK: mensagens pessoais de entrada e resumo de saída');
  process.exit(0);
}

run();
