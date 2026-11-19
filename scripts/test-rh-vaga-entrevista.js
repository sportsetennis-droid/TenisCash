// Teste da vaga com escolha de loja e entrevista por escrito (RH).
// Uso: DATABASE_URL=postgres de teste  →  node scripts/test-rh-vaga-entrevista.js
// Nunca rodar apontando para produção: cria e apaga candidatos de teste.
const assert = require('assert');
const { PrismaClient } = require('@prisma/client');
const rh = require('../src/services/rh');
const { SLUG, JOB } = require('../src/services/rh/seedJobs');

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Só roda em banco local de teste.'); process.exit(2); }
const prisma = new PrismaClient();
let n = 0;
const ok = (name) => { n++; console.log('  ✓', name); };
const fails = async (fn, status, re) => { try { await fn(); } catch (e) { assert.strictEqual(e.status, status, e.message); if (re) assert.match(e.message, re); return; } assert.fail('devia falhar com ' + status); };
const base = (extra) => ({ name: 'Candidata Teste', phone: '(83) 98888-0001', consent: 'true', answers: JSON.stringify(['a', 'b', 'c', 'd', 'e']), ...extra });

(async () => {
  await rh.ensureSchema(prisma);
  const job = await rh.getJob(prisma, SLUG);
  assert.ok(job, 'vaga semeada'); assert.strictEqual(job.status, 'ABERTA'); ok('vaga entra sozinha, aberta');
  assert.strictEqual(await require('../src/services/rh/seedJobs').seed(prisma), false); ok('semear de novo não duplica');
  assert.strictEqual(job.salaryText, null); assert.strictEqual(job.schedule, null); ok('salário e horário em branco (não inventa)');

  const pub = (await rh.listJobs(prisma, { publicOnly: true })).map(rh.publicJob).find((j) => j.slug === SLUG);
  assert.deepStrictEqual(pub.storeOptions, JOB.storeOptions); assert.strictEqual(pub.interviewCount, JOB.interviewQuestions.length);
  assert.strictEqual(pub.interviewQuestions, undefined); ok('página pública mostra lojas e quantidade de perguntas, não as perguntas da entrevista');

  await fails(() => rh.apply(prisma, SLUG, base({}), null), 400, /qual loja/); ok('sem escolher loja não envia');
  await fails(() => rh.apply(prisma, SLUG, base({ storeChoices: JSON.stringify(['Loja que não existe']) }), null), 400, /qual loja/); ok('loja fora da lista não vale');

  const r1 = await rh.apply(prisma, SLUG, base({ storeChoices: JSON.stringify(JOB.storeOptions) }), null);
  assert.match(r1.interviewToken, /^[a-f0-9]{48}$/); assert.strictEqual(r1.candidateId, undefined); ok('as duas lojas: aceita e devolve o link da entrevista');
  const r2 = await rh.apply(prisma, SLUG, base({ phone: '83988880002', storeChoices: JSON.stringify([JOB.storeOptions[1], 'x']) }), null);
  assert.notStrictEqual(r1.interviewToken, r2.interviewToken); ok('uma loja só: aceita; link diferente por candidato');
  await fails(() => rh.apply(prisma, SLUG, base({ storeChoices: JSON.stringify(JOB.storeOptions) }), null), 409); ok('mesmo WhatsApp não se candidata duas vezes');

  const list = await rh.listCandidates(prisma, { jobId: job.id });
  const c1 = list.find((c) => c.phone === '83988880001'), c2 = list.find((c) => c.phone === '83988880002');
  assert.deepStrictEqual(c1.storeChoices, JOB.storeOptions); assert.deepStrictEqual(c2.storeChoices, [JOB.storeOptions[1]]);
  assert.strictEqual(c1.interviewToken, undefined); ok('lojas escolhidas gravadas; lista não expõe o link');

  await fails(() => rh.getInterview(prisma, 'abc'), 404); await fails(() => rh.getInterview(prisma, 'a'.repeat(48)), 404); ok('link inválido ou inexistente: 404');
  const iv = await rh.getInterview(prisma, r1.interviewToken);
  assert.strictEqual(iv.firstName, 'Candidata'); assert.strictEqual(iv.questions.length, JOB.interviewQuestions.length); assert.strictEqual(iv.done, false);
  assert.deepStrictEqual(Object.keys(iv).sort(), ['answers', 'done', 'firstName', 'job', 'questions']); ok('entrevista abre com as perguntas e só o primeiro nome');

  const total = iv.questions.length;
  const asMap = (fn) => Object.fromEntries(iv.questions.map((q, i) => [q, fn(i)]));
  const partial = asMap((i) => (i < 3 ? 'Resposta ' + (i + 1) : ''));
  await rh.saveInterview(prisma, r1.interviewToken, { answers: partial, finish: false });
  const iv2 = await rh.getInterview(prisma, r1.interviewToken);
  assert.strictEqual(iv2.answers[2], 'Resposta 3'); assert.strictEqual(iv2.answers[3], ''); assert.strictEqual(iv2.done, false); ok('salva pela metade e continua depois');
  await fails(() => rh.saveInterview(prisma, r1.interviewToken, { answers: partial, finish: true }), 400, /pergunta 4/); ok('não envia com pergunta em branco');
  // o dono edita a lista no meio: a resposta continua na pergunta certa e nada some
  await prisma.$executeRaw`UPDATE "HrJob" SET "interviewQuestions"=${JSON.stringify(['Pergunta nova no topo', ...iv.questions])}::jsonb WHERE "id"=${job.id}`;
  await rh.saveInterview(prisma, r1.interviewToken, { answers: { [iv.questions[3]]: 'Resposta 4' }, finish: false });
  const mid = await rh.getInterview(prisma, r1.interviewToken);
  assert.deepStrictEqual(mid.answers.slice(0, 5), ['', 'Resposta 1', 'Resposta 2', 'Resposta 3', 'Resposta 4']); ok('lista editada no meio: respostas não trocam de pergunta nem somem');
  await prisma.$executeRaw`UPDATE "HrJob" SET "interviewQuestions"=${JSON.stringify(iv.questions)}::jsonb WHERE "id"=${job.id}`;
  const lastQ = iv.questions[total - 1]; assert.match(lastQ, /\(opcional\)$/);
  const full = asMap((i) => (i === total - 1 ? '' : 'Resposta completa ' + (i + 1)));
  const fin = await rh.saveInterview(prisma, r1.interviewToken, { answers: full, finish: true }); assert.strictEqual(fin.done, true);
  assert.strictEqual((await rh.getInterview(prisma, r1.interviewToken)).done, true); ok('envia a entrevista completa');
  await fails(() => rh.saveInterview(prisma, r1.interviewToken, { answers: asMap(() => 'outra'), finish: true }), 409); ok('pergunta opcional pode ficar em branco; entrevista enviada não pode ser trocada');

  const det = await rh.getCandidate(prisma, c1.id);
  assert.strictEqual(det.interview[lastQ], ''); assert.strictEqual(det.interview[iv.questions[0]], 'Resposta completa 1'); assert.ok(det.interviewDoneAt);
  assert.ok(det.events.some((e) => e.kind === 'ENTREVISTA_ESCRITA')); ok('painel do RH vê as respostas e o registro no histórico');
  const det2 = await rh.getCandidate(prisma, c2.id);
  assert.strictEqual((await rh.getInterview(prisma, det2.interviewToken)).answers.every((a) => a === ''), true); ok('a entrevista de um candidato não vaza para outro');

  // vaga sem lojas e sem entrevista continua como antes
  const plain = await rh.saveJob(prisma, { title: 'Vaga simples de teste', questions: ['Pergunta'] }, null);
  const r3 = await rh.apply(prisma, plain.slug, base({ phone: '83988880003' }), null);
  assert.strictEqual(r3.interviewToken, null); assert.strictEqual(r3.interviewCount, 0); ok('vaga sem lojas nem entrevista segue igual');
  const edited = await rh.saveJob(prisma, { title: 'Vaga simples de teste', storeOptions: ['A', 'A', ' ', 'B'], interviewQuestions: ['P1', '', 'P2'] }, null, plain.id);
  assert.deepStrictEqual(edited.storeOptions, ['A', 'B']); assert.deepStrictEqual(edited.interviewQuestions, ['P1', 'P2']); ok('painel edita lojas e perguntas (sem vazios nem repetidos)');

  for (const c of [c1, c2]) await rh.deleteCandidate(prisma, c.id, null);
  await prisma.$executeRaw`DELETE FROM "HrCandidate" WHERE "jobId"=${plain.id}`; await prisma.$executeRaw`DELETE FROM "HrJob" WHERE "id"=${plain.id}`;
  console.log('\n' + n + ' testes passaram.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('\nFALHOU:', e); await prisma.$disconnect(); process.exit(1); });
