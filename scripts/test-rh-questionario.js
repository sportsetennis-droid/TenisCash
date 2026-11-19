// Teste do questionário com nota por perfil, roteiro de entrevista e role-play (RH).
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
// respostas: melhor (pontos máximos / não reprova) ou pior (0 / não reprova); perfil pela letra
function answers(list, code, mode = 'best') {
  const a = {};
  for (const q of list) {
    if (q.type === 'PERFIL') { if (code) a[q.id] = q.options.findIndex((o) => o.code === code); continue; }
    if (q.type === 'ELIM') { a[q.id] = q.options.findIndex((o) => o.ok); continue; }
    const pts = q.options.map((o) => o.points);
    a[q.id] = pts.indexOf(mode === 'best' ? Math.max(...pts) : Math.min(...pts));
  }
  return a;
}

(async () => {
  // ── modelos
  for (const [k, t] of Object.entries(scr.TEMPLATES)) {
    const norm = scr.normalize(t.screening);
    assert.strictEqual(scr.toText(scr.normalize(scr.toText(norm))), scr.toText(norm), k);
    assert.ok(t.cutoffPct > 0 && t.cutoffPct <= 100);
    assert.ok(!/estado civil|\bfilhos?\b|gravid|religi|\bidade\b|quantos anos|escala|6x1|5x2/i.test(JSON.stringify(t)), k + ': pergunta proibida ou fala de escala');
  }
  assert.deepStrictEqual(scr.maxByProfile(scr.normalize(scr.TEMPLATES.VENDEDOR.screening)), { A: 34, B: 35, C: 41, D: 47 });
  ok('modelo Vendedor com 4 perfis (máx. A 34, B 35, C 41, D 47), corte 70%; sem pergunta proibida nem escala');
  throwsSync(() => scr.normalize('ELIM: Pode sábado?\n- Sim\n- Às vezes'), /\(reprova\)/);
  throwsSync(() => scr.normalize('MC: Experiência\n- Nenhuma\n- Muita = 3'), /= pontos/);
  throwsSync(() => scr.normalize('ELIM: X\n- Sim = 3\n- Não (reprova)'), /ELIM não tem pontos/);
  throwsSync(() => scr.normalize('MC [A]: X\n- a = 1\n- b = 0'), /falta a pergunta PERFIL/);
  throwsSync(() => scr.normalize('PERFIL: Quem é você?\n- Novo [A]\n- Velho [B]\n\nMC [C]: X\n- a = 1\n- b = 0'), /\[C\] não existe/);
  throwsSync(() => scr.normalize('PERFIL: Quem é você?\n- Novo\n- Velho [B]'), /letra do perfil/);
  throwsSync(() => scr.normalize('MC: X\n- a = 1\n- b = 0\n\nPERFIL: Quem?\n- Novo [A]\n- Velho [B]'), /primeira/);
  throwsSync(() => scr.normalize('PERFIL: Quem?\n- Novo [A]\n- Velho [B]\n\nMC [A]: X\n- a = 1\n- b = 0'), /perfil B não tem nenhuma pergunta/);
  ok('questionário mal escrito: erro claro (inclusive perfil errado ou sem pergunta)');
  const v1 = scr.normalize('MC: A\n- x = 1\n- y = 0\n\nMC: B\n- x = 1\n- y = 0');
  const v2 = scr.normalize('MC: NOVA\n- x = 1\n- y = 0\n\nMC: A\n- x = 1\n- y = 0\n\nMC: B\n- x = 1\n- y = 0', v1);
  assert.deepStrictEqual(v2.map((q) => q.id), ['q3', 'q1', 'q2']); ok('pergunta nova no topo não rouba o id das antigas');

  // ── vaga semeada
  await rh.ensureSchema(prisma);
  const job = await rh.getJob(prisma, seedJobs.SLUG);
  assert.strictEqual(job.screening[0].type, 'PERFIL'); assert.strictEqual(job.cutoffPct, 70);
  assert.ok(job.questions.includes(seedJobs.OPEN_RENAME[1]) && !job.questions.includes(seedJobs.OPEN_RENAME[0]));
  ok('vaga Bessa/Pirâmide nasce com perfis; pergunta aberta serve para quem nunca trabalhou');
  const pub = rh.publicJob(job);
  assert.ok(!/points|"ok"|ELIM|"MC"|reprova/.test(JSON.stringify(pub.screening)), 'vazou resposta');
  assert.ok(pub.screening[0].perfil && pub.screening.find((q) => q.id === 'D1').only[0] === 'D');
  ok('página pública: perfis e a que perfil cada pergunta serve, sem pontos nem "reprova"');

  // ── candidatura por perfil
  const base = (phone, extra) => ({ name: 'Candidato ' + phone.slice(-1), phone, consent: 'true', storeChoices: JSON.stringify([job.storeOptions[0]]), ...extra });
  await fails(() => rh.apply(prisma, job.slug, base('83977770001', { screening: JSON.stringify(answers(job.screening, null)) }), null), 400, /pergunta 1 do questionário/);
  ok('sem escolher o perfil não envia');
  const onlyCommonA = answers(job.screening, 'A'); delete onlyCommonA.A2;
  await fails(() => rh.apply(prisma, job.slug, base('83977770001', { screening: JSON.stringify(onlyCommonA) }), null), 400, /questionário/);
  ok('falta pergunta do perfil: não envia');
  const aAns = answers(job.screening.filter((q) => scr.appliesTo(q, 'A') || q.type === 'PERFIL'), 'A');
  await rh.apply(prisma, job.slug, base('83977770001', { screening: JSON.stringify({ ...aAns, D1: 0, M6: 0 }), score: 999, talentPool: 'true', referredBy: ' Lio ' }), null);
  await rh.apply(prisma, job.slug, base('83977770002', { screening: JSON.stringify(answers(job.screening, 'D', 'worst')) }), null);
  await rh.apply(prisma, job.slug, base('83977770003', { screening: JSON.stringify(answers(job.screening, 'D')) }), null);
  await rh.apply(prisma, job.slug, base('83977770004', { screening: JSON.stringify({ ...answers(job.screening, 'B'), E1: 1 }) }), null);
  const list = await rh.listCandidates(prisma, { jobId: job.id });
  const by = (ph) => list.find((c) => c.phone === ph);
  const a1 = by('83977770001'), d0 = by('83977770002'), d1 = by('83977770003'), b1 = by('83977770004');
  assert.strictEqual(a1.score, 34); assert.strictEqual(a1.scoreMax, 34); assert.strictEqual(a1.profile, 'Vai ser o meu primeiro emprego');
  assert.strictEqual(a1.cutoffAt, 24);
  ok('primeiro emprego: 34/34 só nas perguntas dele (respostas de outro perfil são ignoradas); corte 24 = 70%');
  const det1 = await rh.getCandidate(prisma, a1.id);
  assert.ok(!det1.screening.D1 && !det1.screening.M6 && det1.screening.A1 && det1.screening.PERFIL.type === 'PERFIL'); ok('ficha guarda só as perguntas do perfil e o perfil escolhido');
  assert.strictEqual(d1.score, 47); assert.strictEqual(d1.scoreMax, 47); assert.strictEqual(d1.cutoffAt, 33);
  assert.strictEqual(d0.score, 1); assert.strictEqual(d0.scoreMax, 47);
  ok('loja de esporte: 47/47 com as técnicas; respostas fracas 1/47');
  assert.strictEqual(b1.eliminated, true); assert.strictEqual(b1.stage, 'NOVO'); assert.strictEqual(b1.scoreMax, 35); ok('eliminatória só marca para revisar; perfil B tem máx. 35');
  assert.strictEqual(a1.talentPool, true); assert.strictEqual(a1.referredBy, 'Lio'); ok('banco de talentos e indicação gravados');
  assert.strictEqual(a1.screening, undefined); assert.ok(a1.evalSummary); ok('lista do funil leve, com perfil e resumo');

  // ── roteiro + role-play
  const det = await rh.getCandidate(prisma, b1.id);
  assert.strictEqual(det.guide.length, 12); assert.strictEqual(det.roleplay.criteria.length, 9);
  const iv = Object.fromEntries(det.guide.map((g, i) => [g.k, (i % 5) + 1])); iv.cliente = 9;
  const rpGood = Object.fromEntries(det.roleplay.criteria.map((c) => [c.k, 4]));
  let r = await rh.saveScorecard(prisma, b1.id, { interview: iv, roleplay: rpGood }, null);
  assert.strictEqual(r.evalSummary.interviewDone, 11); assert.strictEqual(r.evalSummary.roleplayOk, true);
  r = await rh.saveScorecard(prisma, b1.id, { interview: iv, roleplay: { ...rpGood, honestidade: 1, postura: 5, fechamento: 5 } }, null);
  assert.strictEqual(r.evalSummary.roleplayOk, false);
  ok('roteiro e role-play: nota fora de 1–5 descartada; 1 em Honestidade reprova o role-play');

  const ga = await rh.getCandidate(prisma, a1.id);
  assert.ok(ga.guide.find((g) => g.k === 'meta').q.includes('escola') && !ga.guide.some((g) => /bateu a meta|cliente achou caro/.test(g.q)));
  assert.ok(det.guide.find((g) => g.k === 'meta').q.includes('bateu a meta')); ok('roteiro de primeiro emprego não pede experiência de venda');

  // ── vaga nova pelo painel: corte em %
  const t = scr.TEMPLATES.LOGISTICA;
  const lj = await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', screeningText: scr.toText(t.screening), cutoffPct: '65' }, null);
  assert.strictEqual(lj.cutoffPct, 65); assert.strictEqual(lj.cutoff, null);
  const adminRow = (await rh.listJobs(prisma)).find((j) => j.id === lj.id);
  assert.deepStrictEqual(adminRow.screeningMaxBy, { '': 18 }); ok('painel cria vaga sem perfil, corte 65%');
  await rh.saveJob(prisma, { title: 'Auxiliar de estoque — teste', jobTitle: 'LOGISTICA', status: 'ABERTA' }, null, lj.id);
  const kept = await rh.getJob(prisma, lj.id); assert.strictEqual(kept.screening.length, t.screening.length); assert.strictEqual(kept.cutoffPct, 65); ok('salvar sem mexer no questionário não apaga nada');
  await rh.apply(prisma, lj.slug, { name: 'Estoquista Teste', phone: '83977770009', consent: 'true', screening: JSON.stringify(answers(kept.screening, null)) }, null);
  const ec = (await rh.listCandidates(prisma, { jobId: lj.id }))[0];
  assert.strictEqual(ec.score, 18); assert.strictEqual(ec.cutoffAt, 12); assert.strictEqual(ec.profile, null); ok('vaga sem perfil continua igual (18/18, corte 12)');

  // ── vaga já no ar com o questionário único (V1) vira por perfil; candidatos antigos intactos; edição do dono não é tocada
  const v1Scr = scr.normalize(scr.T_VENDEDOR_V1);
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"=${JSON.stringify(v1Scr)}::jsonb, "cutoffPct"=NULL, "cutoff"=24,
    "questions"=${JSON.stringify(job.questions.map((q) => (q === seedJobs.OPEN_RENAME[1] ? seedJobs.OPEN_RENAME[0] : q)))}::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  const up = await rh.getJob(prisma, job.id);
  assert.strictEqual(up.screening[0].type, 'PERFIL'); assert.strictEqual(up.cutoffPct, 70); assert.strictEqual(up.cutoff, null);
  assert.ok(up.questions.includes(seedJobs.OPEN_RENAME[1])); ok('vaga no ar (questionário único) passa para perfis no próximo boot');
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"=${JSON.stringify(v1Scr)}::jsonb, "cutoffPct"=NULL, "cutoff"=28 WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  assert.strictEqual((await rh.getJob(prisma, job.id)).cutoffPct, 80); ok('corte mexido pelo dono (28 de 35) vira 80%, não é apagado');
  const old = await rh.getCandidate(prisma, d1.id); assert.strictEqual(old.score, 47); ok('quem já se candidatou mantém nota e respostas');
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"=${JSON.stringify(scr.normalize('ELIM: Do dono?\n- Sim\n- Não (reprova)'))}::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  assert.strictEqual((await rh.getJob(prisma, job.id)).screening[0].text, 'Do dono?'); ok('questionário editado pelo dono nunca é trocado');
  await prisma.$executeRaw`UPDATE "HrJob" SET "screening"='[]'::jsonb WHERE "id"=${job.id}`;
  await seedJobs.seed(prisma);
  assert.deepStrictEqual((await rh.getJob(prisma, job.id)).screening, []); ok('dono apagou o questionário: não volta');

  await prisma.$executeRaw`DELETE FROM "HrCandidateEvent" WHERE "candidateId" IN (SELECT "id" FROM "HrCandidate" WHERE "phone" LIKE '8397777000%')`;
  await prisma.$executeRaw`DELETE FROM "HrCandidate" WHERE "phone" LIKE '8397777000%'`;
  await prisma.$executeRaw`DELETE FROM "HrJob" WHERE "id"=${lj.id}`;
  console.log('\n' + n + ' testes passaram.');
  await prisma.$disconnect();
})().catch(async (e) => { console.error('FALHOU:', e); await prisma.$disconnect(); process.exit(1); });
