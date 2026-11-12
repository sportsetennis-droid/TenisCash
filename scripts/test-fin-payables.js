'use strict';

// Contas a pagar — regras puras (sem banco).
const assert = require('assert');
const P = require('../src/services/finPayables');

// ---------- datas / competência (Fortaleza) ----------
const today = P.todayFortaleza(new Date('2026-11-13T02:30:00Z')); // 12/11 23:30 em Fortaleza
assert.strictEqual(today.toISOString(), '2026-11-12T03:00:00.000Z');
assert.strictEqual(P.competenceOf(new Date('2026-12-01T02:00:00Z')), '2026-11', '01/12 02h UTC ainda é novembro em Fortaleza');
assert.strictEqual(P.addMonths('2026-11', 3), '2027-02');
assert.strictEqual(P.addMonths('2026-01', -1), '2025-12');
assert.strictEqual(P.monthsBetween('2026-11', '2027-11'), 12);
assert.strictEqual(P.dueDateFor('2027-02', 31).toISOString(), '2027-02-28T03:00:00.000Z', 'dia 31 em fevereiro vira o último dia');
assert.strictEqual(P.dueDateFor('2028-02', 30).toISOString(), '2028-02-29T03:00:00.000Z');
assert.strictEqual(P.isoDay(P.dueDateFor('2026-11', 10)), '2026-11-10');
assert.throws(() => P.parseCompetence('2026-13'), /AAAA-MM/);

// ---------- despesas fixas ----------
const aluguel = { id: 'r1', active: true, storeId: 's1', natureId: 'n1', description: 'Aluguel Bessa', amountCents: 500000, dueDay: 5, frequency: 'MONTHLY', startCompetence: '2026-11', endCompetence: null };
const iptu = { ...aluguel, id: 'r2', description: 'IPTU', frequency: 'YEARLY', startCompetence: '2026-02', amountCents: 120000, dueDay: 10 };
const energia = { ...aluguel, id: 'r3', description: 'Energia', variableAmount: true, amountCents: 80000, dueDay: 20 };
const semDia = { ...aluguel, id: 'r4', dueDay: null };
const parada = { ...aluguel, id: 'r5', active: false };
const acabou = { ...aluguel, id: 'r6', endCompetence: '2026-11' };
assert.strictEqual(P.recurringAppliesTo(aluguel, '2026-10'), false, 'antes do início');
assert.strictEqual(P.recurringAppliesTo(aluguel, '2026-11'), true);
assert.strictEqual(P.recurringAppliesTo(iptu, '2027-02'), true);
assert.strictEqual(P.recurringAppliesTo(iptu, '2026-11'), false, 'anual só no mês de início');
assert.strictEqual(P.recurringAppliesTo(semDia, '2026-11'), false, 'sem dia de vencimento não gera');
assert.strictEqual(P.recurringAppliesTo(parada, '2026-11'), false);
assert.strictEqual(P.recurringAppliesTo(acabou, '2026-12'), false, 'depois do fim');
let plan = P.planRecurringTitles([aluguel, iptu, energia, semDia, parada], '2026-11');
assert.deepStrictEqual(plan.map((t) => t.recurringId), ['r1', 'r3']);
assert.strictEqual(plan[0].dueDate.toISOString(), '2026-11-05T03:00:00.000Z');
assert.strictEqual(plan[0].amountConfirmed, true);
assert.strictEqual(plan[1].amountConfirmed, false, 'variável nasce pra confirmar o valor');
plan = P.planRecurringTitles([aluguel, energia], '2026-11', new Set(['r1|2026-11']));
assert.deepStrictEqual(plan.map((t) => t.recurringId), ['r3'], 'não duplica conta já gerada');

let rec = P.validateRecurring({ storeId: 's1', natureId: 'n1', description: ' Aluguel ', amount: '5.000,00', dueDay: '5', startCompetence: '2026-11', paymentMethod: 'boleto' });
assert.strictEqual(rec.amountCents, 500000);
assert.strictEqual(rec.description, 'Aluguel');
assert.strictEqual(rec.frequency, 'MONTHLY');
assert.strictEqual(rec.paymentMethod, 'BOLETO');
assert.throws(() => P.validateRecurring({ natureId: 'n1', description: 'x', amount: '10', startCompetence: '2026-11' }), /dia do vencimento/);
assert.throws(() => P.validateRecurring({ natureId: 'n1', description: 'x', amount: '10', dueDay: 32, startCompetence: '2026-11' }), /entre 1 e 31/);
assert.throws(() => P.validateRecurring({ natureId: 'n1', description: 'x', amount: '0', dueDay: 1, startCompetence: '2026-11' }), /valor/);
assert.throws(() => P.validateRecurring({ natureId: 'n1', description: 'x', amount: '1', dueDay: 1, startCompetence: '2026-11', endCompetence: '2026-10' }), /antes do início/);
assert.deepStrictEqual(P.validateRecurring({ dueDay: 10 }, { partial: true }), { dueDay: 10 });

// ---------- avulsa e parcelada ----------
let titles = P.planTitleCreate({ storeId: 's1', natureId: 'n1', description: 'Reforma', amount: '1.000,00', dueDate: '2026-11-30', installments: 3 });
assert.deepStrictEqual(titles.map((t) => t.amountCents), [33334, 33333, 33333]);
assert.strictEqual(titles.reduce((s, t) => s + t.amountCents, 0), 100000, 'parcelas somam o total');
assert.deepStrictEqual(titles.map((t) => P.isoDay(t.dueDate)), ['2026-11-30', '2026-12-30', '2027-01-30']);
assert.deepStrictEqual(titles.map((t) => t.competence), ['2026-11', '2026-12', '2027-01']);
assert.strictEqual(titles[2].description, 'Reforma (3/3)');
titles = P.planTitleCreate({ natureId: 'n1', description: 'Taxa', amount: '50', dueDate: '2027-01-31', installments: 2 });
assert.strictEqual(P.isoDay(titles[1].dueDate), '2027-02-28');
assert.throws(() => P.planTitleCreate({ natureId: 'n1', description: 'x', amount: '10' }), /vencimento/);
assert.throws(() => P.planTitleCreate({ natureId: 'n1', description: 'x', amount: '10', dueDate: '2026-11-01', installments: 0 }), /Parcelas/);

// ---------- saldo, baixa parcial, estorno ----------
const t = { amountCents: 100000, paidPrincipalCents: 0, discountCents: 0, interestCents: 0, fineCents: 0, dueDate: new Date('2026-11-10T03:00:00Z'), approvalStatus: 'APPROVED', paymentMethod: 'BOLETO' };
assert.strictEqual(P.statusFor(t), 'OPEN');
assert.strictEqual(P.situation(t, today), 'OVERDUE');
assert.strictEqual(P.situation({ ...t, dueDate: today }, today), 'DUE_TODAY');
assert.strictEqual(P.situation({ ...t, dueDate: new Date(today.getTime() + 86400000) }, today), 'OPEN');

let s = P.planSettlement({ amount: '400,00', interest: '2,50', fine: '20', paidAt: '2026-11-12' }, t, today);
assert.deepStrictEqual([s.principalCents, s.interestCents, s.fineCents, s.totalCents], [40000, 250, 2000, 42250]);
assert.strictEqual(s.method, 'BOLETO');
let after = P.applySettlement(t, s);
assert.strictEqual(after.status, 'PARTIAL');
assert.strictEqual(P.balanceCents({ ...t, ...after }), 60000);
const t2 = { ...t, ...after };
const s2 = P.planSettlement({ discount: '10,00', amount: '590,00' }, t2, today);
const after2 = P.applySettlement(t2, s2);
assert.strictEqual(after2.status, 'PAID', 'desconto quita o saldo');
assert.throws(() => P.planSettlement({}, { ...t2, ...after2 }, today), /já está paga/);
assert.throws(() => P.planSettlement({ amount: '700' }, t2, today), /passa do saldo/);
assert.throws(() => P.planSettlement({ amount: '10', paidAt: '2026-12-25' }, t2, today), /futuro/);
assert.throws(() => P.planSettlement({ amount: '10', interest: '-1' }, t2, today), /negativo/);
assert.strictEqual(P.planSettlement({}, t, today).principalCents, 100000, 'sem valor = paga o saldo');
// estorno da 2ª baixa volta pra parcial
const back = P.applySettlement({ ...t2, ...after2 }, s2, -1);
assert.strictEqual(back.status, 'PARTIAL');
assert.strictEqual(back.paidPrincipalCents, 40000);
assert.throws(() => P.applySettlement(t, s, -1), /Estorno maior/);
assert.strictEqual(P.statusFor({ ...t, canceledAt: new Date() }), 'CANCELED');

// edição só sem pagamento
assert.deepStrictEqual(P.validateTitleUpdate({ amount: '123,45' }, t), { amountCents: 12345, amountConfirmed: true });
assert.throws(() => P.validateTitleUpdate({ amount: '1' }, t2), /estorne/);

// ---------- painel ----------
const sum = P.summarize([
  { ...t, status: 'OPEN' }, // vencida 1.000
  { ...t, status: 'OPEN', dueDate: today, approvalStatus: 'PENDING' }, // hoje 1.000
  { ...t, status: 'OPEN', dueDate: new Date(today.getTime() + 3 * 86400000), amountConfirmed: false }, // 7 dias
  { ...t, status: 'PAID', paidPrincipalCents: 100000 },
], [{ paidAt: today, totalCents: 42250 }, { paidAt: today, totalCents: -2250, reversalOfId: 'x' }, { paidAt: new Date('2026-10-05T03:00:00Z'), totalCents: 999 }], today);
assert.deepStrictEqual(sum.overdue, { count: 1, cents: 100000 });
assert.deepStrictEqual(sum.today, { count: 1, cents: 100000 });
assert.deepStrictEqual(sum.next7, { count: 1, cents: 100000 });
assert.deepStrictEqual(sum.monthOpen, { count: 3, cents: 300000 });
assert.deepStrictEqual(sum.paidMonth, { count: 1, cents: 40000 }, 'pago no mês desconta estorno e ignora outro mês');
assert.deepStrictEqual(sum.pendingApproval, { count: 1, cents: 100000 });
assert.strictEqual(sum.unconfirmed.count, 1);

console.log('test-fin-payables: ok');
