'use strict';
// Contracheque — ponta a ponta com Postgres real (banco descartável do CI/local).
// Cobre: acesso por perfil, isolamento, prévia, correção de ponto, revisar → aprovar →
// fechar (PDF salvo, WhatsApp), dados congelados/reprodutíveis, reabertura com versão,
// pagamento, exportações, link assinado e auditoria.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/')) throw Error('Somente banco local isolado.');
process.env.DATABASE_URL = url;
process.env.PAYROLL_WHATSAPP = 'on';
process.env.MEU_PAGAMENTO = '1'; // a tela do vendedor está desativada por padrão (dono, 19/11/2026)

const mw = require('../src/middleware');
const db = mw.prisma;
const { OWNER_RECORD_KEY } = require('../src/services/rankingOwner');
const { createPayrollRouter } = require('../src/routes/payroll');
const cal = require('../src/services/payroll/calendar');
const pcrypto = require('../src/services/payroll/crypto');
const notify = require('../src/services/payroll/notify');

const sent = [];
const sender = {
  text: async (phone, msg) => { sent.push({ kind: 'text', phone, msg }); return { ok: true }; },
  document: async (phone, link, name, caption) => { sent.push({ kind: 'doc', phone, link, name, caption }); return { ok: true }; },
};
const app = express();
app.use(express.json({ limit: '3mb' }));
const router = createPayrollRouter({ prisma: db, sender });
app.use('/api/payroll', router);

const C = '2026-10';
const at = (day, t) => cal.localTimeToDate(day, t);
const day44 = (userId, storeId, d, exit = '17:20') => [
  { userId, storeId, type: 'entry', timestamp: at(d, '09:00') }, { userId, storeId, type: 'break_start', timestamp: at(d, '12:00') },
  { userId, storeId, type: 'break_end', timestamp: at(d, '13:00') }, { userId, storeId, type: 'exit', timestamp: at(d, exit) },
];

(async () => {
  await router.ensureSchema();
  await createPayrollRouterAgainTwice();
  // Este teste exercita o caminho 'sem valor vigente' (pendência → dono cadastra). A semente da CCT JP
  // (vigente desde 07/2026, gravada pelo dono em 18/11/2026) é tirada só neste banco de teste.
  await db.payrollParam.deleteMany({ where: { validFrom: '2026-07-01' } });
  const u = randomUUID().slice(0, 8);
  const issuerA = await db.fiscalIssuer.create({ data: { cnpj: '9' + Date.now().toString().slice(-13), companyName: 'Empresa A Teste LTDA', fantasyName: 'A Teste', city: 'João Pessoa', state: 'PB' } });
  const issuerB = await db.fiscalIssuer.create({ data: { cnpj: '8' + Date.now().toString().slice(-13), companyName: 'Empresa B Teste LTDA' } });
  const storeA = await db.store.create({ data: { code: 'PA-' + u, name: 'Loja A', fiscalIssuerId: issuerA.id } });
  const storeA2 = await db.store.create({ data: { code: 'PA2-' + u, name: 'Loja A2', fiscalIssuerId: issuerA.id } });
  const storeB = await db.store.create({ data: { code: 'PB-' + u, name: 'Loja B', fiscalIssuerId: issuerB.id } });
  const users = {};
  for (const [k, role, storeId] of [['owner', 'superadmin', null], ['admin', 'admin', null], ['manager', 'manager', storeA.id], ['seller', 'seller', storeA.id], ['sellerB', 'seller', storeB.id]]) {
    users[k] = await db.user.create({ data: { name: 'Folha ' + k + ' Silva', role, phone: '8399' + Math.floor(1e6 + Math.random() * 8e6), pin: 'x', storeId, storeIds: storeId ? [storeId] : [] } });
  }
  const prevOwner = await db.config.findUnique({ where: { key: OWNER_RECORD_KEY } });
  await db.config.upsert({ where: { key: OWNER_RECORD_KEY }, create: { id: OWNER_RECORD_KEY, key: OWNER_RECORD_KEY, value: JSON.stringify({ userId: users.owner.id, evidenceId: 't' }) }, update: { value: JSON.stringify({ userId: users.owner.id, evidenceId: 't' }) } });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/payroll';
  const call = async (path, { method, body, who = 'admin', raw = false } = {}) => {
    const r = await fetch(base + path, { method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(who ? { Authorization: 'Bearer ' + jwt.sign({ userId: users[who].id }, mw.JWT_SECRET, { expiresIn: '5m' }) } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = text; }
    return { status: r.status, data };
  };
  let step = 0; const ok = (name) => console.log(`ok ${++step} - ${name}`);

  try {
    // Acesso
    assert.equal((await call('/me/preview', { who: null })).status, 401);
    assert.equal((await call('/admin/overview', { who: 'seller' })).status, 403);
    assert.equal((await call('/admin/me', { who: 'owner' })).data.isOwner, true);
    assert.equal((await call('/admin/me', { who: 'admin' })).data.isOwner, false);
    ok('acesso por perfil (funcionário não entra na administração; só o dono é dono)');

    // Cadastro de contrato: só o dono grava; CPF protegido
    const profileBody = { contractType: 'MENSALISTA', admissionDate: '2025-03-01', baseSalaryCents: 200000, weeklyMinutes: 2640, workDaysPerWeek: 6,
      jobTitle: 'Vendedor', storeId: storeA.id, issuerId: issuerA.id, cpf: '123.456.789-09', registration: 'V9' + u, vtOptIn: true };
    assert.equal((await call('/admin/profiles/' + users.seller.id, { method: 'PUT', body: profileBody, who: 'manager' })).status, 403);
    const prof = await call('/admin/profiles/' + users.seller.id, { method: 'PUT', body: profileBody, who: 'owner' });
    assert.equal(prof.status, 200, JSON.stringify(prof.data));
    assert.equal(prof.data.profile.cpfMasked, '***.***.*89-09'); assert.ok(!('cpfEnc' in prof.data.profile));
    const stored = await db.payrollEmployeeProfile.findUnique({ where: { userId: users.seller.id } });
    assert.notEqual(stored.cpfEnc, '12345678909'); assert.equal(pcrypto.decrypt(stored.cpfEnc), '12345678909');
    await call('/admin/profiles/' + users.sellerB.id, { method: 'PUT', who: 'owner', body: { ...profileBody, storeId: storeB.id, issuerId: issuerB.id, cpf: undefined, registration: 'B9' + u } });
    ok('cadastro de contrato só pelo dono; CPF criptografado e mascarado');

    // Isolamento: gerente da loja A não vê o vendedor da loja B
    assert.equal((await call('/admin/employees/' + users.sellerB.id + '/preview?competence=' + C, { who: 'manager' })).status, 403);
    const ov = await call('/admin/overview?competence=' + C, { who: 'manager' });
    assert.ok(ov.data.rows.some((r) => r.userId === users.seller.id)); assert.ok(!ov.data.rows.some((r) => r.userId === users.sellerB.id));
    const ovIssuer = await call('/admin/overview?competence=' + C + '&issuerId=' + issuerB.id);
    assert.ok(ovIssuer.data.rows.every((r) => r.issuerId === issuerB.id)); assert.ok(ovIssuer.data.rows.some((r) => r.userId === users.sellerB.id));
    ok('isolamento entre lojas e empresas');

    // Dados do mês: ponto (com 1 dia incompleto e 1 domingo), vendas, lançamentos
    const work = cal.monthDays(C).filter((d) => cal.weekdayOf(d) !== 0 && d !== '2026-10-12');
    const punches = work.flatMap((d) => (d === '2026-10-07' ? day44(users.seller.id, storeA.id, d).slice(0, 3) : day44(users.seller.id, d === '2026-10-09' ? storeA2.id : storeA.id, d)));
    punches.push(...day44(users.seller.id, storeA.id, '2026-10-18'));
    await db.clockIn.createMany({ data: punches });
    const sale = (status, total, items, storeId = storeA.id) => db.sale.create({ data: { sellerId: users.seller.id, storeId, totalAmount: total, status, createdAt: at('2026-10-10', '15:00'),
      items: { create: items.map((i) => ({ productName: i.n, brand: i.b, category: i.c, size: '40', quantity: 1, unitPrice: i.v, totalPrice: i.v })) } } });
    await sale('completed', 15000, [{ n: 'Tênis X', b: 'Nike', c: 'Tênis', v: 15000 }]);
    await sale('completed', 7000, [{ n: 'Camisa S&T Dry', b: 'Sports & Tennis', c: 'Roupa', v: 6000 }, { n: 'Meia', b: 'Lupo', c: 'Meia', v: 1000 }], storeA2.id);
    await sale('canceled', 9000, [{ n: 'Tênis Y', b: 'Adidas', c: 'Tênis', v: 9000 }]);
    // Regra de comissão de outubro (a semente vale a partir de nov): pelo dono, com vigência
    const ruleBody = { name: 'Regra outubro teste', validFrom: '2026-10-01', validTo: '2026-10-31', config: { tierMode: 'ALL', tiers: [{ aboveCents: 0, pct: 1 }, { aboveCents: 2000000, pct: 2 }],
      special: [{ name: 'Camisas S&T', aboveCents: 500000, pct: 4, match: { brands: ['sportstennis', 'sportsandtennis', 'sportsetennis'], categories: ['roupa'] } }],
      confirmedStatuses: ['completed'], pendingStatuses: ['pending', 'pending_payment'], canceledStatuses: ['canceled', 'cancelled'] } };
    assert.equal((await call('/admin/commission-rules', { body: ruleBody, who: 'admin' })).status, 403);
    assert.equal((await call('/admin/commission-rules', { body: ruleBody, who: 'owner' })).status, 201);
    // Adiantamento (gerente lança), passagem (benefício), domingo pago antes
    const adv = await call('/admin/entries', { who: 'manager', body: { userId: users.seller.id, kind: 'ADIANTAMENTO', date: '2026-10-20', amountCents: 50000, description: 'Vale dia 20' } });
    assert.equal(adv.status, 201, JSON.stringify(adv.data));
    await call('/admin/entries', { who: 'manager', body: { userId: users.seller.id, kind: 'PASSAGEM', date: '2026-10-01', amountCents: 18000 } });
    await call('/admin/entries', { who: 'manager', body: { userId: users.seller.id, kind: 'DOMINGO_PAGO', date: '2026-10-19', amountCents: 8000, referenceDate: '2026-10-18' } });
    assert.equal((await call('/admin/entries', { who: 'manager', body: { userId: users.sellerB.id, kind: 'ADIANTAMENTO', date: '2026-10-20', amountCents: 100 } })).status, 403);
    await call('/admin/day-marks', { who: 'manager', body: { userId: users.seller.id, kind: 'FOLGA_COMPENSATORIA', date: '2026-10-21', refDate: '2026-10-18' } });
    ok('lançamentos e marcações com escopo da loja');

    // Prévia do funcionário
    const pv = await call('/me/preview?competence=' + C, { who: 'seller' });
    assert.equal(pv.status, 200, JSON.stringify(pv.data));
    assert.match(pv.data.notice, /mês encerrado/, 'mês passado: não chama de prévia do mês atual');
    const pvNow = await call('/me/preview', { who: 'seller' });
    assert.match(pvNow.data.notice, /Prévia do mês atual. Este valor ainda não é o contracheque oficial/);
    const r = pv.data.result;
    assert.equal(r.commission.confirmed.totalCents, 2200000); assert.equal(r.commission.canceled.count, 1);
    assert.equal(r.time.totals.sundaysWorked, 1);
    assert.ok(r.pendencies.some((p) => p.code === 'PONTO_INCOMPLETO')); assert.ok(r.pendencies.some((p) => p.code === 'PARAM_DOMINGO_TRABALHADO'));
    ok('prévia do funcionário com ponto, comissão (cancelada fora) e pendências');

    // Correção de ponto: funcionário pede, gerente aprova → batida nova (original intocada)
    const corr = await call('/me/clock-corrections', { who: 'seller', body: { date: '2026-10-07', type: 'exit', claimedTime: '17:20', justification: 'Esqueci de bater a saída', attachment: 'data:image/png;base64,iVBORw0KGgo=' } });
    assert.equal(corr.status, 201, JSON.stringify(corr.data));
    const before = await db.clockIn.count({ where: { userId: users.seller.id } });
    assert.equal((await call('/admin/clock-corrections/' + corr.data.correction.id + '/approve', { who: 'manager', body: { note: 'conferido com a câmera' } })).status, 200);
    assert.equal(await db.clockIn.count({ where: { userId: users.seller.id } }), before + 1);
    const created = await db.clockIn.findFirst({ where: { correctionId: corr.data.correction.id } });
    assert.equal(created.source, 'correcao');
    ok('correção de ponto aprovada vira batida nova com origem "correcao"');

    // Revisar: domingo sem valor vigente → COM_PENDENCIAS; dono cadastra o valor → EM_CONFERENCIA
    let rv = await call('/admin/payslips/review', { body: { userId: users.seller.id, competence: C } });
    assert.equal(rv.status, 200, JSON.stringify(rv.data)); assert.equal(rv.data.payslip.status, 'COM_PENDENCIAS');
    assert.equal((await call('/admin/payslips/' + rv.data.payslip.id + '/approve', { who: 'owner', body: {} })).status, 409);
    for (const key of ['DOMINGO_TRABALHADO', 'FERIADO_TRABALHADO']) {
      const pr = await call('/admin/params', { who: 'owner', body: { key, validFrom: '2026-10-01', value: { mode: 'FIXED', amountCents: 8000, compensatoryDayOff: true }, source: 'Teste: valor fixo' } });
      assert.equal(pr.status, 201, JSON.stringify(pr.data));
    }
    rv = await call('/admin/payslips/review', { body: { userId: users.seller.id, competence: C } });
    assert.equal(rv.data.payslip.status, 'EM_CONFERENCIA', JSON.stringify(rv.data.payslip.result.pendencies));
    const id1 = rv.data.payslip.id;
    ok('conferência bloqueia com pendência e libera depois do parâmetro');

    assert.equal((await call('/admin/payslips/' + id1 + '/approve', { who: 'admin', body: {} })).status, 403);
    assert.equal((await call('/admin/payslips/' + id1 + '/approve', { who: 'owner', body: {} })).status, 200);
    // Dado mudou depois da aprovação → não fecha com cálculo diferente
    const late = await call('/admin/entries', { who: 'manager', body: { userId: users.seller.id, kind: 'VALE_ALIMENTACAO', date: '2026-10-25', amountCents: 2000 } });
    assert.equal((await call('/admin/payslips/' + id1 + '/close', { who: 'owner', body: {} })).status, 409);
    await db.payrollEntry.update({ where: { id: late.data.entry.id }, data: { status: 'CANCELADO' } });
    await call('/admin/payslips/review', { body: { userId: users.seller.id, competence: C } });
    await call('/admin/payslips/' + id1 + '/approve', { who: 'owner', body: {} });
    assert.equal((await call('/admin/payslips/' + id1 + '/close', { who: 'admin', body: {} })).status, 403);
    const closed = await call('/admin/payslips/' + id1 + '/close', { who: 'owner', body: { paymentDate: '2026-11-05' } });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.equal(closed.data.payslip.status, 'FECHADO');
    ok('só o dono aprova/fecha; dado alterado após conferência bloqueia o fechamento');

    // Números do fechamento
    const slip = await db.payslip.findUnique({ where: { id: id1 } });
    const res = slip.result;
    const code = (c) => res.items.filter((i) => i.code === c).reduce((s, i) => s + i.cents, 0);
    assert.equal(code('SALARIO'), 200000);
    assert.equal(code('COMISSAO'), 32000, 'R$ 16.000 fora as camisas × 2%');
    assert.equal(code('COMISSAO_ESPECIAL'), 24000, 'camisas S&T R$ 6.000 × 4%');
    assert.equal(code('DOMINGO'), 8000); assert.equal(code('DOMINGO_PAGO'), 8000);
    assert.equal(code('ADIANTAMENTO'), 50000); assert.equal(code('VALE_TRANSPORTE'), 12000, '6% de 2.000 limitado ao custo 180');
    assert.equal(res.totals.netCents, res.totals.grossCents - res.totals.deductionsCents);
    assert.equal(slip.netCents, res.totals.netCents);
    ok('fechamento: salário, comissão geral + especial, domingo devido/antecipado, vale, VT');

    // PDF salvo, igual ao que o funcionário baixa; WhatsApp automático
    const file = await db.payslipFile.findUnique({ where: { payslipId: id1 } });
    assert.ok(file && file.sizeBytes > 1000);
    await new Promise((r) => setTimeout(r, 300));
    const doc = sent.find((s) => s.kind === 'doc');
    assert.ok(doc && doc.phone === users.seller.phone && /api\/payroll\/file\//.test(doc.link), JSON.stringify(sent));
    assert.match(doc.caption, /contracheque de 10\/2026/);
    ok('PDF salvo no banco e aviso automático pelo WhatsApp');

    // Funcionário: histórico, PDF, CSV, JSON, ciência; outro funcionário não acessa
    const mine = await call('/me/payslips', { who: 'seller' });
    assert.equal(mine.data.payslips.length, 1);
    const pdf = await call('/me/payslips/' + id1 + '/pdf', { who: 'seller', raw: true });
    assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(pcrypto.sha256(pdf.buf), file.sha256);
    assert.equal((await call('/me/payslips/' + id1 + '/pdf', { who: 'sellerB', raw: true })).status, 404);
    assert.equal((await call('/me/payslips/' + id1, { who: 'sellerB' })).status, 404);
    const csv = await call('/me/payslips/' + id1 + '/export?format=csv', { who: 'seller' });
    assert.match(csv.data, new RegExp('LIQUIDO";"";"";"' + (res.totals.netCents / 100).toFixed(2).replace('.', ',')));
    const json = await call('/me/payslips/' + id1 + '/export?format=json', { who: 'seller' });
    assert.equal(json.data.result.totals.netCents, res.totals.netCents);
    const ack = await call('/me/payslips/' + id1 + '/ack', { who: 'seller', body: {} });
    assert.equal(ack.status, 200); assert.match(ack.data.note, /não substitui o comprovante/);
    assert.equal((await db.payslip.findUnique({ where: { id: id1 } })).status, 'FECHADO', 'ciência não marca como pago');
    ok('funcionário vê só o próprio: PDF idêntico ao salvo, CSV/JSON com o mesmo líquido, ciência ≠ pagamento');

    // Link assinado
    const token = doc.link.split('/file/')[1];
    assert.equal((await call('/file/' + token, { who: null, raw: true })).status, 200);
    assert.equal((await call('/file/' + token.slice(0, -2) + 'xx', { who: null, raw: true })).status, 404);
    assert.equal((await call('/file/' + pcrypto.signLink(id1, Date.now() - 1000), { who: null, raw: true })).status, 404);
    ok('link assinado do PDF: válido abre, adulterado ou vencido não');

    // Congelado e reprodutível; competência fechada não aceita lançamento
    assert.equal((await call('/admin/payslips/' + id1 + '/recompute')).data.reproducible, true);
    await db.clockIn.createMany({ data: day44(users.seller.id, storeA.id, '2026-10-25') });
    assert.equal((await call('/admin/payslips/' + id1 + '/recompute')).data.reproducible, true, 'batida nova não altera o fechado');
    assert.equal((await call('/admin/entries', { who: 'manager', body: { userId: users.seller.id, kind: 'ADIANTAMENTO', date: '2026-10-28', amountCents: 100 } })).status, 409);
    assert.equal((await call('/admin/payslips/review', { body: { userId: users.seller.id, competence: C } })).status, 409);
    ok('fechado congelado e reprodutível; competência fechada travada');

    // Reabrir → versão 2; fechar v2 → v1 CORRIGIDO; pagar
    assert.equal((await call('/admin/payslips/' + id1 + '/reopen', { who: 'owner', body: {} })).status, 400);
    const ro = await call('/admin/payslips/' + id1 + '/reopen', { who: 'owner', body: { reason: 'Domingo 25/10 trabalhado faltou' } });
    assert.equal(ro.status, 200); assert.equal(ro.data.payslip.version, 2);
    assert.equal((await db.payslip.findUnique({ where: { id: id1 } })).status, 'REABERTO');
    await call('/admin/day-marks', { who: 'manager', body: { userId: users.seller.id, kind: 'FOLGA_COMPENSATORIA', date: '2026-10-28', refDate: '2026-10-25' } });
    const rv2 = await call('/admin/payslips/review', { body: { userId: users.seller.id, competence: C } });
    assert.equal(rv2.data.payslip.id, ro.data.payslip.id);
    await call('/admin/payslips/' + rv2.data.payslip.id + '/approve', { who: 'owner', body: {} });
    const c2 = await call('/admin/payslips/' + rv2.data.payslip.id + '/close', { who: 'owner', body: {} });
    assert.equal(c2.status, 200, JSON.stringify(c2.data));
    const v1 = await db.payslip.findUnique({ where: { id: id1 } });
    assert.equal(v1.status, 'CORRIGIDO'); assert.equal(v1.netCents, slip.netCents, 'versão anterior preservada');
    assert.equal(c2.data.payslip.grossCents - v1.grossCents, 8000, 'diferença bruta = domingo 25/10');
    assert.equal((await call('/admin/payslips/' + c2.data.payslip.id + '/pay', { who: 'owner', body: {} })).status, 400);
    const paid = await call('/admin/payslips/' + c2.data.payslip.id + '/pay', { who: 'owner', body: { paymentRef: 'PIX E2E-123' } });
    assert.equal(paid.data.payslip.status, 'PAGO');
    assert.equal((await call('/me/payslips', { who: 'seller' })).data.payslips.length, 2);
    ok('reabertura gera versão nova, anterior preservada como CORRIGIDO; pagamento com comprovante');

    // Auditoria
    const logs = await db.payrollAuditLog.findMany({ where: { subjectUserId: users.seller.id } });
    const actions = new Set(logs.map((l) => l.action));
    for (const a of ['CREATE', 'REVIEW_CREATE', 'APPROVE', 'CLOSE', 'REOPEN', 'PAY', 'VIEW', 'EXPORT_PDF', 'EXPORT_CSV', 'ACKNOWLEDGE', 'WHATSAPP_SENT', 'REQUEST', 'DOWNLOAD_SIGNED_LINK', 'SUPERSEDED'])
      assert.ok(actions.has(a), 'auditoria sem ' + a);
    assert.equal((await call('/admin/audit?userId=' + users.seller.id, { who: 'admin' })).status, 403);
    assert.ok((await call('/admin/audit?userId=' + users.seller.id, { who: 'owner' })).data.logs.length > 10);
    ok('auditoria de alteração, fechamento, reabertura, pagamento, visualização, exportação e envio');

    // Prévia semanal pelo WhatsApp (mock): só quem tem cadastro e telefone
    sent.length = 0;
    const weekly = await notify.sendWeeklyPreviews(db, { sender, nowMs: Date.parse('2026-11-16T12:00:00Z') });
    assert.ok(weekly.sent >= 2); assert.ok(sent.every((s) => /PRÉVIA/.test(s.msg)));
    ok('prévia semanal pelo WhatsApp avisa que é provisória');

    console.log(`PASS payroll http: ${step} etapas`);
  } finally {
    server.close();
    if (prevOwner) await db.config.update({ where: { key: OWNER_RECORD_KEY }, data: { value: prevOwner.value } });
    await db.$disconnect();
  }
})().catch((err) => { console.error(err); process.exit(1); });

async function createPayrollRouterAgainTwice() {
  // Schema + sementes rodam de novo sem erro nem duplicar (idempotente).
  const r2 = createPayrollRouter({ prisma: db, sender });
  await r2.ensureSchema();
  const inss = await db.payrollParam.count({ where: { key: 'INSS_EMPREGADO', validFrom: '2026-01-01', issuerId: null, storeId: null } });
  assert.equal(inss, 1);
}
