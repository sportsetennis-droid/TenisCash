'use strict';
// Contas a pagar — rotas /api/fin/payables e /recurring com Postgres real (CI). Banco descartável apenas.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/')) throw Error('Somente banco local isolado.');
process.env.DATABASE_URL = url;

const mw = require('../src/middleware');
const db = mw.prisma;
const { createFinSchemaReadiness } = require('../src/services/finSchema');
const { OWNER_RECORD_KEY } = require('../src/services/rankingOwner');
const P = require('../src/services/finPayables');
const router = require('../src/routes/fin');

const app = express();
app.use(express.json());
app.use('/api/fin', router);

(async () => {
  await createFinSchemaReadiness(db)();
  await createFinSchemaReadiness(db)();

  const u = randomUUID();
  const users = {};
  for (const [key, role] of [['admin', 'admin'], ['owner', 'superadmin']]) {
    users[key] = await db.user.create({ data: { name: 'pay-' + key, role, phone: 'pay-' + key + '-' + u, pin: 'test-only' } });
  }
  const prevOwner = await db.config.findUnique({ where: { key: OWNER_RECORD_KEY } });
  const ownerVal = JSON.stringify({ userId: users.owner.id, evidenceId: 'test-' + u });
  await db.config.upsert({ where: { key: OWNER_RECORD_KEY }, create: { id: OWNER_RECORD_KEY, key: OWNER_RECORD_KEY, value: ownerVal }, update: { value: ownerVal } });
  const store = await db.store.create({ data: { code: 'PAY-' + u.slice(0, 8), name: 'Loja Pagar Teste' } });
  const nat = Object.fromEntries((await db.finNature.findMany({ where: { code: { in: ['06', '06.01', '06.03', '07.99', '01.01'] } } })).map((n) => [n.code, n]));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/fin';
  const call = async (path, { method, body, who = 'admin' } = {}) => {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: 'Bearer ' + jwt.sign({ userId: users[who].id }, mw.JWT_SECRET, { expiresIn: '5m' }), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
  const comp = P.competenceOf(P.todayFortaleza());
  const next = P.addMonths(comp, 1);

  try {
    // ---- despesa fixa gera o mês atual e o próximo, sem duplicar ----
    assert.equal((await call('/recurring', { body: { storeId: store.id, natureId: nat['06'].id, description: 'x', amount: '10', dueDay: 5, startCompetence: comp } })).status, 400, 'grupo não recebe lançamento');
    assert.equal((await call('/recurring', { body: { storeId: store.id, natureId: nat['01.01'].id, description: 'x', amount: '10', dueDay: 5, startCompetence: comp } })).status, 400, 'receita não é despesa');
    const rec = await call('/recurring', { body: { storeId: store.id, natureId: nat['06.01'].id, description: 'Aluguel loja teste', payee: 'Proprietário', amount: '4.500,00', dueDay: 5, startCompetence: comp, paymentMethod: 'BOLETO' } });
    assert.equal(rec.status, 201, JSON.stringify(rec));
    assert.equal(rec.data.generated, 2);
    assert.equal((await call('/recurring/generate', { body: {} })).data.generated, 0, 'rodar de novo não duplica');
    let list = await call('/payables?storeId=' + store.id + '&status=open');
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.titles.map((t) => t.competence).sort(), [comp, next]);
    assert.equal(list.data.totalBalanceCents, 900000);
    const title = list.data.titles.find((t) => t.competence === comp);
    assert.equal(title.store.id, store.id);
    assert.equal(title.nature.code, '06.01');
    assert.equal(title.approvalStatus, 'PENDING');

    // ---- só o dono libera; sem liberação não paga ----
    assert.equal((await call('/payables/' + title.id + '/pay', { body: {} })).status, 403);
    assert.equal((await call('/payables/' + title.id + '/approve', { body: {} })).status, 403);
    assert.equal((await call('/payables/' + title.id + '/approve', { body: {}, who: 'owner' })).data.approved, 1);
    assert.equal((await call('/payables/' + title.id + '/approve', { body: {}, who: 'owner' })).data.approved, 0, 'liberar 2x não muda');

    // ---- pagamento parcial, depois o resto com juros ----
    const p1 = await call('/payables/' + title.id + '/pay', { body: { amount: '2.000,00' } });
    assert.equal(p1.status, 200, JSON.stringify(p1));
    assert.equal(p1.data.title.status, 'PARTIAL');
    const p2 = await call('/payables/' + title.id + '/pay', { body: { amount: '2.500,00', interest: '15,00' } });
    assert.equal(p2.data.title.status, 'PAID');
    assert.equal(p2.data.settlement.totalCents, 251500);
    assert.equal((await call('/payables/' + title.id + '/pay', { body: {} })).status, 400, 'já paga');
    assert.equal((await call('/payables/' + title.id, { method: 'PATCH', body: { amount: '1' } })).status, 400, 'paga não edita');

    // ---- estorno com motivo volta o saldo; não estorna 2x ----
    assert.equal((await call('/payables/settlements/' + p2.data.settlement.id + '/reverse', { body: {} })).status, 400, 'motivo obrigatório');
    const r2 = await call('/payables/settlements/' + p2.data.settlement.id + '/reverse', { body: { reason: 'boleto pago em duplicidade' } });
    assert.equal(r2.status, 200, JSON.stringify(r2));
    assert.equal(r2.data.title.status, 'PARTIAL');
    assert.equal(r2.data.reversal.totalCents, -251500);
    assert.equal((await call('/payables/settlements/' + p2.data.settlement.id + '/reverse', { body: { reason: 'de novo' } })).status, 400);
    assert.equal((await call('/payables/' + title.id + '/cancel', { body: { reason: 'teste' } })).status, 400, 'com pagamento não cancela');
    await call('/payables/settlements/' + p1.data.settlement.id + '/reverse', { body: { reason: 'lançado errado' } });
    const canc = await call('/payables/' + title.id + '/cancel', { body: { reason: 'contrato encerrado' } });
    assert.equal(canc.data.title.status, 'CANCELED');
    const det = await call('/payables/' + title.id);
    assert.equal(det.data.settlements.length, 4);
    assert.deepEqual(det.data.history.map((h) => h.action), ['create', 'approve', 'pay', 'pay', 'reverse', 'reverse', 'cancel']);
    assert.equal(det.data.title.approvedByName, 'pay-owner');

    // ---- dono paga direto (libera junto) ----
    const nextTitle = list.data.titles.find((t) => t.competence === next);
    const op = await call('/payables/' + nextTitle.id + '/pay', { body: {}, who: 'owner' });
    assert.equal(op.status, 200, JSON.stringify(op));
    assert.equal(op.data.title.approvalStatus, 'APPROVED');
    assert.equal(op.data.title.status, 'PAID');

    // ---- variável: confirma o valor antes de pagar ----
    const en = await call('/recurring', { body: { storeId: store.id, natureId: nat['06.03'].id, description: 'Energia loja teste', amount: '800', variableAmount: true, dueDay: 20, startCompetence: comp } });
    assert.equal(en.status, 201);
    const enTitle = (await call('/payables?storeId=' + store.id + '&status=open')).data.titles.find((t) => t.recurringId === en.data.recurring.id && t.competence === comp);
    assert.equal(enTitle.amountConfirmed, false);
    assert.equal((await call('/payables/' + enTitle.id + '/pay', { body: {}, who: 'owner' })).status, 400, 'variável sem valor confirmado não paga');
    const upd = await call('/payables/' + enTitle.id, { method: 'PATCH', body: { amount: '912,37' } });
    assert.equal(upd.data.title.amountCents, 91237);
    assert.equal(upd.data.title.amountConfirmed, true);

    // ---- alterar a fixa atualiza as contas em aberto ----
    const ch = await call('/recurring/' + en.data.recurring.id, { method: 'PATCH', body: { dueDay: 25, applyToOpen: true } });
    assert.equal(ch.status, 200, JSON.stringify(ch));
    assert.equal(ch.data.updatedTitles, 2);
    assert.equal((await call('/recurring/' + en.data.recurring.id + '/deactivate', { body: {} })).status, 400);
    assert.equal((await call('/recurring/' + en.data.recurring.id + '/deactivate', { body: { reason: 'loja mudou de medidor' } })).data.recurring.active, false);

    // ---- avulsa parcelada + painel ----
    const av = await call('/payables', { body: { storeId: store.id, natureId: nat['07.99'].id, description: 'Conserto ar-condicionado', amount: '1.000,00', dueDate: P.isoDay(P.todayFortaleza()), installments: 3 } });
    assert.equal(av.status, 201, JSON.stringify(av));
    assert.deepEqual(av.data.titles.map((t) => t.amountCents), [33334, 33333, 33333]);
    const sum = await call('/payables/summary?storeId=' + store.id, { who: 'owner' });
    assert.equal(sum.status, 200);
    assert.equal(sum.data.isOwner, true);
    assert.ok(sum.data.summary.today.count >= 1, 'parcela de hoje aparece');
    assert.ok(sum.data.summary.pendingApproval.count >= 3);
    assert.ok(sum.data.urgent.some((t) => t.description.startsWith('Conserto')));
    const batch = await call('/payables/approve', { body: { ids: av.data.titles.map((t) => t.id) }, who: 'owner' });
    assert.equal(batch.data.approved, 3);

    // ---- cadastro antigo ----
    const oe = await db.operatingExpense.create({ data: { category: 'energia', description: 'Energia antiga ' + u.slice(0, 4), amount: 650.5, storeId: store.id } });
    const dry = await call('/recurring/import-legacy?dry=1', { body: {} });
    assert.ok(dry.data.plan.some((p) => p.legacyId === oe.id && p.amountCents === 65050 && p.variableAmount && p.dueDay === null));
    const imp = await call('/recurring/import-legacy', { body: {} });
    assert.ok(imp.data.imported >= 1);
    assert.equal((await call('/recurring/import-legacy', { body: {} })).data.imported, 0, 'não importa 2x');
    const legacyRec = await db.finRecurring.findUnique({ where: { legacyId: oe.id } });
    assert.equal(legacyRec.dueDay, null, 'sem dia de vencimento: não inventa');

    const ap1 = await db.accountPayable.create({ data: { description: 'Boleto antigo pago', amount: 300, dueDate: new Date('2026-10-10T03:00:00Z'), paidDate: new Date('2026-10-09T15:00:00Z'), status: 'PAID' } });
    const ap2 = await db.accountPayable.create({ data: { description: 'Boleto antigo aberto', amount: 125.4, dueDate: new Date('2026-12-10T03:00:00Z'), status: 'PENDING', category: 'aluguel' } });
    const dryP = await call('/payables/import-legacy?dry=1', { body: {} });
    assert.ok(dryP.data.toImport >= 2);
    const impP = await call('/payables/import-legacy', { body: {} });
    assert.equal(impP.status, 200, JSON.stringify(impP));
    assert.equal(impP.data.legacyTotalCents, impP.data.importedTotalCents, 'soma igual antes e depois');
    const t1 = await db.finTitle.findUnique({ where: { legacyId: ap1.id } });
    const t2 = await db.finTitle.findUnique({ where: { legacyId: ap2.id } });
    assert.equal(t1.status, 'PAID');
    assert.equal((await db.finSettlement.findMany({ where: { titleId: t1.id } })).length, 1);
    assert.equal(t2.status, 'OPEN');
    assert.equal(t2.amountCents, 12540);
    assert.equal((await call('/payables/import-legacy', { body: {} })).data.imported, 0, 'não importa 2x');

    console.log('PASS fin payables HTTP: fixas geram sem duplicar, só o dono libera, parcial, juros, estorno com motivo, cancelamento, variável confirma valor, parcelada, painel, importação do cadastro antigo');
  } finally {
    await new Promise((r) => server.close(r));
    if (prevOwner) await db.config.update({ where: { key: OWNER_RECORD_KEY }, data: { value: prevOwner.value } });
    else await db.config.delete({ where: { key: OWNER_RECORD_KEY } }).catch(() => {});
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
