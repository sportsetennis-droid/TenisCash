// Teste do questionário com nota, roteiro de entrevista e role-play (RH).
// Uso: DATABASE_URL=postgres local de teste  →  node scripts/test-rh-questionario.js
// Nunca rodar apontando para produção: cria e apaga vagas e candidatos de teste.
const assert = require('assert');
const { PrismaClient } = require('@prisma/client');
const rh = require('../src/services/rh');
const scr = require('../src/services/rh/screening');
const seedJobs = require('../src/services/rh/seedJobs');

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '')) { console.error('Só roda em banco local de teste.'); process.exit(2); }
const prisma = new PrismaClient();
let n = 0;
const ok = (name) => { n++; console.log('  ✓', name); };
const fails = async (fn, status, re) => { try { await fn(); } catch (e) { assert.strictEqual(e.status, status, e.message); if (re) assert.match(e.message, re); return; } assert.fail('devia falhar com ' + status); };
const throwsSync = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('devia dar erro'); };
// melhor resposta = alternativa com mais pontos (MC) ou que não reprova (ELIM)
const best = (list) => Object.fromEntries(list.map((q) => [q.id, q.type === 'MC' ? q.options.reduce((bi, o, i, a) => (o.points > a[bi].points ? i : bi), 0) : q.options.findIndex((o) => o.ok)]));

(async () => {
  // ── modelos
  for (const [k, t] of Object.entries(scr.TEMPLATES)) {
    const norm = scr.normalize(t.screening);
    assert.deepStrictEqual(scr.normalize(scr.toText(norm)).map((q) => q.options), norm.map((q) => q.options), k);
    assert.ok(t.cutoff <= scr.maxScore(norm));
    assert.ok(!/estado civil|\bfilhos?\b|gravid|religi|\bidade\b|quantos anos/i.test(JSON.stringify(t)), k + ': pergunta proibida');
  }
  assert.strictEqual(scr.maxScore(scr.TEMPLATES.VENDEDOR.screening), 35); assert.strictEqual(scr.TEMPLATES.VENDEDOR.cutoff, 24);
  ok('modelos Vendedor (35 pts, corte 24), Logística e Supervisor: texto ida e volta igual, sem pergunta proibida');
  throwsSync(() => scr.normalize('ELIM: Pode sábado?\n- Sim\n- Às vezes'), /\(reprova\)/);
  throwsSync(() => scr.normalize('ELIM: Pode sábado?\n- Não (reprova)\n- Nunca (reprova)'), /não reprova/);
  throwsSync(() => scr.normalize('MC: Experiência\n- Nenhuma\n- Muita = 3'), /= pontos/);
  throwsSync(() => scr.normalize('Experiência?\n- a = 1'), /ELIM:/);
  throwsSync(() => scr.normalize('MC: X\n- a = 1'), /2 a 6/);
  throwsSync(() => scr.normalize('MC: X\n- a = 11\n- b = 0'), /0 a 10/);
  throwsSync(() => scr.normalize('ELIM: Pode sábado?\n- Sim = 3\n- Não (reprova)'), /ELIM não tem pontos/);
  throwsSync(() => scr.normalize('MC: X\n- a (reprova) = 1\n- b = 0'), /só vale em pergunta ELIM/);
  ok('questionário mal escrito: erro claro com a linha');
  const v1 = scr.normalize('MC: A\n- x = 1\n- y = 0\n\nMC: B\n- x = 1\n- y = 0');
  const v2 = scr.normalize('MC: NOVA\n- x = 1\n- y = 0\n\nMC: A\n- x = 1\n- y = 0\n\nMC: B\n- x = 1\n- y = 0', v1);
  assert.deepStrictEqual(v2.map((q) => q.id), ['q3', 'q1', 'q2']); ok('pergunta nova no topo não rouba o id das antigas (resposta não muda de pergunta)');

  // ── vaga semeada
  await rh.ensureSchema(prisma);
  const job = await rh.getJob(prisma, seedJobs.SLUG);
  assert.strictEqual(job.screening.length, scr.TEMPLATES.VENDEDOR.screening.length); assert.strictEqual(job.cutoff, 24);
  assert.ok(!job.questions.some((q) => /disponibilidade|pratica ou acompanha/i.test(q))); ok('vaga Bessa/Pirâmide já entra com o modelo Vendedor e sem perguntas repetidas');
  const pub = rh.publicJob(job);
  assert.strictEqual(pub.screening.length, job.screening.length);
  assert.ok(!/points|"ok"|ELIM|"MC"|reprova/.test(JSON.stringify(pub.screening)), 'vazou resposta'); ok('página pública recebe só perguntas e alternativas (sem pontos nem "reprova")');

  // ── candidatura
  const base = (extra) => ({ name: 'Candidato Questionário', phone: '83977770001', consent: 'true', storeChoices: JSON.stringify([job.storeOptions[0]]), ...extra });
  const all = best(job.screening);
  const missing = { ...all }; delete missing.M5;
  await fails(() => rh.apply(prisma, job.slug, base({ screening: JSON.stringify(missing) }), null), 400, /pergunta 7 do questionário/); ok('sem responder tudo não envia (diz qual pergunta)');
  await fails(() => rh.apply(prisma, job.slug, base({ screening: JSON.stringify({ ...all, M1: 9 }) }), null), 400, /questionário/); ok('alternativa inexistente não vale');
  await rh.apply(prisma, job.slug, base({ screening: JSON.stringify(all), score: 999, eliminated: 'false', talentPool: 'true', referredBy: '  Lio da Tambaú ' }), null);
  const zero = Object.fromEntries(job.screening.map((q) => [q.id, q.type === 'ELIM' ? q.options.findIndex((o) => o.ok) : q.options.findIndex((o) => o.points === 0)]));
  await rh.apply(prisma, job.slug, base({ phone: '83977770002', name: 'Candidato Fraco', screening: JSON.stringify(zero) }), null);
  const elimAns = { ...all, E1: job.screening[0].options.findIndex((o) => !o.ok) };
  await rh.apply(prisma, job.slug, base({ phone: '83977770003', name: 'Candidato Sem Domingo', screening: JSON.stringify(elimAns) }), null);
  const list = await rh.listCandidates(prisma, { jobId: job.id });
  const top = list.find((c) => c.phone === '83977770001'), low = list.find((c) => c.phone === '83977770002'), el = list.find((c) => c.phone === '83977770003');
  assert.strictEqual(top.score, 35); assert.strictEqual(top.scoreMax, 35); assert.strictEqual(top.eliminated, false); assert.strictEqual(top.cutoff, 24); assert.strictEqual(top.cutoffAt, 24);
  ok('nota calculada no servidor: 35/35 (o "score" que o navegador mandar é ignorado)');
  assert.strictEqual(low.score, 0); assert.strictEqual(low.eliminated, false); ok('respostas fracas: 0/35');
  assert.strictEqual(el.eliminated, true); assert.strictEqual(el.stage, 'NOVO'); assert.strictEqual(el.score, 35);
  ok('eliminatória só marca: continua em "Novo" para revisão humana (LGPD art. 20)');
  assert.strictEqual(top.talentPool, true); assert.strictEqual(top.referredBy, 'Lio da Tambaú'); assert.strictEqual(low.talentPool, false); ok('banco de talentos e indicação gravados');
  assert.strictEqual(top.screening, undefined); assert.strictEqual(top.scorecard, undefined); assert.ok(top.evalSummary); ok('lista do funil leve: sem respostas completas, com resumo');
  const det = await rh.getCandidate(prisma, el.id);
  assert.ok(det.events.some((e) => e.kind === 'TRIAGEM' && /Revisar antes de reprovar/.test(e.note)));
  assert.strictEqual(det.screening.E1.elim, true); assert.strictEqual(det.screening.M4.points, 3); assert.match(det.screening.M4.a, /rotina/);
  ok('ficha mostra cada resposta com pontos e registra a eliminatória no histórico');

  // ── roteiro + role-play
  assert.strictEqual(det.guide.length, 12); assert.strictEqual(det.roleplay.criteria.length, 9); ok('vendedor: roteiro com 12 perguntas e role-play com 9 critérios');
  const iv = Object.fromEntries(det.guide.map((g, i) => [g.k, (i % 5) + 1]));
  iv.cliente = 9; iv.inventado = 5;
  const rpGood = Object.fromEntries(det.roleplay.criteria.map((c) => [c.k, 4]));
  let r = await rh.saveScorecard(prisma, el.id, { interview: iv, roleplay: rpGood, notes: 'Disse que corre 3x por semana.' }, null);
  assert.strictEqual(r.scorecard.interview.cliente, undefined); assert.strictEqual(r.scorecard.interview.inventado, undefined);
  assert.strictEqual(r.evalSummary.interviewDone, 11); assert.strictEqual(r.evalSummary.roleplayAvg, 4); assert.strictEqual(r.evalSummary.roleplayOk, true);
  ok('nota fora de 1–5 ou pergunta que não existe é descartada; role-play 4,0 passa');
  r = await rh.saveScorecard(prisma, el.id, { interview: iv, roleplay: { ...rpGood, honestidade: 1, postura: 5, fechamento: 5 } }, null);
  assert.ok(r.evalSummary.roleplayAvg >= 3.5); assert.strictEqual(r.evalSummary.roleplayOk, false); ok('nota 1 em Honestidade reprova o role-play mesmo com média boa');
  r = await rh.saveScorecard(prisma, el.id, { interview: {}, roleplay: { abordagem: 5 } }, null);
  assert.strictEqual(r.evalSummary.roleplayOk, null); ok('role-play incompleto não dá veredito');
  assert.ok(r.events.filter((e) => e.kind === 'AVALIACAO').length === 3); ok('cada avaliação salva entra no histórico');

  // ── vaga nova pelo painel (texto) + cargo Logística
  const t = scr.TEMPLATES.LOGISTICA;
  const lj = await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', screeningText: scr.toText(t.screening), cutoff: '12' }, null);
  assert.strictEqual(lj.screening.length, t.screening.length); assert.strictEqual(lj.cutoff, 12);
  assert.deepStrictEqual(lj.screening.map((q) => q.id), t.screening.map((q) => q.id)); // texto do modelo mantém os ids E1, M1…
  const adminRow = (await rh.listJobs(prisma)).find((j) => j.id === lj.id);
  assert.strictEqual(adminRow.screeningMax, 18); assert.ok(adminRow.screeningText.startsWith('ELIM: ')); ok('painel cria vaga pelo texto do modelo Logística (18 pts, corte 12)');
  await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', status: 'ABERTA' }, null, lj.id);
  assert.strictEqual((await rh.getJob(prisma, lj.id)).screening.length, t.screening.length); ok('salvar a vaga sem mexer no questionário não apaga o questionário');
  await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', screeningText: '', cutoff: '' }, null, lj.id);
  const cleared = await rh.getJob(prisma, lj.id); assert.deepStrictEqual(cleared.screening, []); assert.strictEqual(cleared.cutoff, null); ok('apagar o texto tira o questionário');
  await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', screeningText: scr.toText(t.screening), cutoff: 12 }, null, lj.id);
  await rh.apply(prisma, lj.slug, { name: 'Estoquista Teste', phone: '83977770009', consent: 'true', screening: JSON.stringify(best((await rh.getJob(prisma, lj.id)).screening)) }, null);
  const ec = (await rh.listCandidates(prisma, { jobId: lj.id }))[0];
  assert.strictEqual(ec.score, 18);
  const ed = await rh.saveScorecard(prisma, ec.id, { interview: { conferencia: 5 }, roleplay: { abordagem: 5 } }, null);
  assert.strictEqual(ed.guide.length, 8); assert.strictEqual(ed.roleplay, null); assert.deepStrictEqual(ed.scorecard.roleplay, {}); ok('logística: roteiro próprio (8 perguntas), sem role-play de venda');

  // ── semente não pisa no que o dono editou
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"=${JSON.stringify(scr.normalize('ELIM: Do dono?\n- Sim\n- Não (reprova)'))}::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  assert.strictEqual((await rh.getJob(prisma, job.id)).screening[0].text, 'Do dono?'); ok('questionário editado pelo dono nunca é trocado pela semente');
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"='[]'::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  assert.deepStrictEqual((await rh.getJob(prisma, job.id)).screening, []); ok('dono apagou o questionário: a semente não põe de volta');
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"='[]'::jsonb, "cutoff"=NULL, "screeningSeeded"=false, "questions"=${JSON.stringify(seedJobs.QUESTIONS_V1)}::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  const re = await rh.getJob(prisma, job.id);
  assert.strictEqual(re.screening.length, 14); assert.strictEqual(re.cutoff, 24); assert.deepStrictEqual(re.questions, seedJobs.JOB.questions); ok('vaga já no ar sem questionário recebe o modelo (caso de produção)');

  // limpeza
  await prisma.$executeRaw`DELETE FROM "HrCandidateEvent" WHERE "candidateId" IN (SELECT "id" FROM "HrCandidate" WHERE "phone" LIKE '8397777000%')`;
  await prisma.$executeRaw`DELETE FROM "HrCandidate" WHERE "phone" LIKE '8397777000%'`;
  await prisma.$executeRaw`DELETE FROM "HrJob" WHERE "id"=${lj.id}`;
  console.log('\n' + n + ' testes passaram.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FALHOU:', e); await prisma.$disconnect(); process.exit(1); });
