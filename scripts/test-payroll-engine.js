'use strict';
// Testes do motor do contracheque (sem banco). Cobre os critérios de aceitação do dono.
const assert = require('node:assert/strict');
const { computePayslip, computeSpecialPayslip } = require('../src/services/payroll/engine');
const legal = require('../src/services/payroll/legal');
const { SEED_PARAMS, SEED_HOLIDAYS_2026, SEED_COMMISSION_RULE, resolveParams } = require('../src/services/payroll/params');
const cal = require('../src/services/payroll/calendar');

const PARAMS = SEED_PARAMS.map((p, i) => ({ id: 'p' + i, status: p.status || 'ACTIVE', ...p, ...(p.storeCode ? { storeId: 'store-' + p.storeCode } : {}) }));
const WITH_SUNDAY = PARAMS.map((p) => (p.key === 'DOMINGO_TRABALHADO' || p.key === 'FERIADO_TRABALHADO'
  ? { ...p, status: 'ACTIVE', value: { mode: 'FIXED', amountCents: 8000, compensatoryDayOff: true } } : p));
const RULE = { id: 'r1', ...SEED_COMMISSION_RULE };
const at = (day, time) => cal.localTimeToDate(day, time);
// Dia padrão de 44h/6: 7h20 trabalhadas (09:00–17:20 com 1h de intervalo = 7h20).
function fullDay(day, { entry = '09:00', bs = '12:00', be = '13:00', exit = '17:20', store = 's1' } = {}) {
  return [
    { type: 'entry', timestamp: at(day, entry), storeId: store },
    { type: 'break_start', timestamp: at(day, bs), storeId: store },
    { type: 'break_end', timestamp: at(day, be), storeId: store },
    { type: 'exit', timestamp: at(day, exit), storeId: store },
  ];
}
const competence = '2026-11';
const workdays = cal.monthDays(competence).filter((d) => cal.weekdayOf(d) !== 0 && !SEED_HOLIDAYS_2026.some((h) => h.date === d));
const base = (over = {}) => ({
  competence, provisional: false, nowMs: Date.parse('2026-12-01T12:00:00Z'),
  profile: { userId: 'u1', contractType: 'MENSALISTA', registered: true, admissionDate: '2025-01-10', baseSalaryCents: 200000, weeklyMinutes: 2640, workDaysPerWeek: 6, ...over.profile },
  params: over.params || PARAMS, holidays: SEED_HOLIDAYS_2026, commissionRules: [RULE],
  punches: over.punches || workdays.flatMap((d) => fullDay(d)), marks: over.marks || [], entries: over.entries || [], sales: over.sales || [],
  ...over.rest,
});
const item = (r, code) => r.items.filter((i) => i.code === code).reduce((s, i) => s + i.cents, 0);
const pendCodes = (r) => r.pendencies.map((p) => p.code);
let n = 0; const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

// ── Legal ─────────────────────────────────────────────
const P = resolveParams(PARAMS, { onDay: '2026-11-30' }).params;
test('INSS 2026 progressivo (R$ 3.000)', () => {
  // 1621×7,5% + (2902,84−1621)×9% + (3000−2902,84)×12% = 121,575 + 115,3656 + 11,6592 = 248,60
  assert.equal(legal.inss(300000, P.INSS_EMPREGADO).valueCents, 24860);
});
test('INSS respeita o teto', () => {
  assert.equal(legal.inss(2000000, P.INSS_EMPREGADO).baseCents, 847555);
});
test('IRRF com redutor Lei 15.270 — exemplo oficial R$ 5.900 (INSS 635,60)', () => {
  const r = legal.irrf({ taxableIncomeCents: 590000, inssCents: 63560 }, P.IRRF_MENSAL, P.IRRF_REDUTOR);
  assert.equal(r.tableTaxCents, 53898); assert.equal(r.reductionCents, 19306); assert.equal(r.valueCents, 34592);
});
test('IRRF zerado até R$ 5.000', () => {
  const inss = legal.inss(500000, P.INSS_EMPREGADO).valueCents;
  assert.equal(legal.irrf({ taxableIncomeCents: 500000, inssCents: inss }, P.IRRF_MENSAL, P.IRRF_REDUTOR).valueCents, 0);
});
test('IRRF acima de R$ 7.350 sem redução', () => {
  const r = legal.irrf({ taxableIncomeCents: 800000, inssCents: 90000 }, P.IRRF_MENSAL, P.IRRF_REDUTOR);
  assert.equal(r.reductionCents, 0);
});
test('FGTS 8% (aprendiz 2%) — informativo', () => {
  assert.equal(legal.fgts(200000, P.FGTS).valueCents, 16000);
  assert.equal(legal.fgts(200000, P.FGTS, true).valueCents, 4000);
});
test('Vale-transporte: 6% limitado ao custo', () => {
  assert.equal(legal.valeTransporte(200000, 30000, P.VALE_TRANSPORTE).valueCents, 12000);
  assert.equal(legal.valeTransporte(200000, 5000, P.VALE_TRANSPORTE).valueCents, 5000);
});
test('Parâmetro pendente de validação não é usado', () => {
  const r = resolveParams(PARAMS, { onDay: '2026-06-30' });
  assert.ok(!r.params.DOMINGO_TRABALHADO); assert.ok(r.pending.DOMINGO_TRABALHADO);
});
test('CCT João Pessoa 2026/2027: HE 60%, domingo/feriado R$ 72 + folga, VA R$ 14 (>4h), passagem R$ 11', () => {
  const r = resolveParams(PARAMS, { onDay: '2026-11-30' });
  assert.equal(r.params.HORA_EXTRA.pct, 60); assert.equal(r.params.DOMINGO_TRABALHADO.amountCents, 7200); assert.equal(r.params.FERIADO_TRABALHADO.amountCents, 7200);
  assert.equal(r.params.VALE_ALIMENTACAO_DIA.amountCents, 1200); assert.equal(r.params.VALE_ALIMENTACAO_DIA.minWorkedMinutes, 240); assert.equal(r.params.PASSAGEM_DIA.amountCents, 1100);
  assert.ok(!Object.values(r.params).some((p) => p.pct === 100), '100% não foi gravado');
});
test('Campina Grande (LOJA03): sem hora extra; VA R$ 12 e passagem R$ 11 gerais; feriado pendente', () => {
  const r = resolveParams(PARAMS, { onDay: '2026-11-30', storeId: 'store-LOJA03' });
  assert.ok(r.params.HORA_EXTRA.semHoraExtra && !r.pending.HORA_EXTRA); assert.equal(r.params.VALE_ALIMENTACAO_DIA.amountCents, 1200); assert.ok(!r.params.FERIADO_TRABALHADO && r.pending.FERIADO_TRABALHADO);
  assert.equal(r.params.PASSAGEM_DIA.amountCents, 1100);
});
test('Parâmetro sem vigência na competência não é usado', () => {
  assert.ok(!resolveParams(PARAMS, { onDay: '2025-06-30' }).params.INSS_EMPREGADO);
});

// ── Jornada ───────────────────────────────────────────
test('44h: mês completo sem extra nem falta', () => {
  const r = computePayslip(base());
  assert.equal(r.time.totals.extraMinutes, 0); assert.equal(r.time.totals.missingMinutes, 0);
  assert.equal(item(r, 'SALARIO'), 200000); assert.equal(r.pendencies.filter((p) => p.severity === 'BLOQUEIA').length, 0);
});
test('Domingo trabalhado NÃO soma nas 44h e aparece separado', () => {
  const r = computePayslip(base({ params: WITH_SUNDAY, punches: [...workdays.flatMap((d) => fullDay(d)), ...fullDay('2026-11-08')],
    marks: [{ id: 'm1', kind: 'FOLGA_COMPENSATORIA', date: '2026-11-11', refDate: '2026-11-08' }] }));
  assert.equal(r.time.totals.sundaysWorked, 1);
  assert.equal(r.specialDays.length, 1); assert.equal(r.specialDays[0].compOffStatus, 'FOLGA_UTILIZADA');
  assert.equal(item(r, 'DOMINGO'), 8000);
  // Folga compensatória (quarta 11/11) não trabalhada mas creditada → semana sem falta
  const wk = r.time.weeks.find((w) => w.from === '2026-11-09');
  assert.equal(wk.missingMinutes, 440 - 440, 'trabalhou 7h20 na quarta também nesta simulação');
});
test('Domingo trabalhado sem folga identificada vira alerta', () => {
  const r = computePayslip(base({ params: WITH_SUNDAY, punches: [...workdays.flatMap((d) => fullDay(d)), ...fullDay('2026-11-22')] }));
  assert.ok(pendCodes(r).includes('FOLGA_PENDENTE'));
  assert.equal(r.specialDays[0].compOffStatus, 'FOLGA_PENDENTE');
});
test('Folga compensatória: dia sem ponto NÃO vira folga sozinho; com marcação, credita sem duplicar', () => {
  const punches = [...workdays.filter((d) => d !== '2026-11-25').flatMap((d) => fullDay(d)), ...fullDay('2026-11-22')];
  const semFolga = computePayslip(base({ params: WITH_SUNDAY, punches }));
  assert.ok(semFolga.time.totals.daysWithoutPunch.includes('2026-11-25'));
  const comFolga = computePayslip(base({ params: WITH_SUNDAY, punches, marks: [{ id: 'f', kind: 'FOLGA_COMPENSATORIA', date: '2026-11-25', refDate: '2026-11-22' }] }));
  const wk = comFolga.time.weeks.find((w) => w.from === '2026-11-23');
  assert.equal(wk.balanceMinutes, 0); assert.equal(wk.creditedMinutes, 440);
  assert.equal(comFolga.specialDays[0].compOffStatus, 'FOLGA_UTILIZADA');
});
test('Feriado não trabalhado: reduz a carga da semana e não vira falta', () => {
  // 20/11/2026 é sexta (Consciência Negra) e 15/11 é domingo
  const r = computePayslip(base());
  const wk = r.time.weeks.find((w) => w.from === '2026-11-16');
  assert.equal(wk.expectedMinutes, 440 * 5); assert.equal(wk.missingMinutes, 0);
  assert.ok(!r.time.totals.daysWithoutPunch.includes('2026-11-20'));
});
test('Feriado trabalhado: fora da carga regular, pago à parte uma vez só', () => {
  const r = computePayslip(base({ params: WITH_SUNDAY, punches: [...workdays.flatMap((d) => fullDay(d)), ...fullDay('2026-11-20')],
    marks: [{ id: 'x', kind: 'FOLGA_COMPENSATORIA', date: '2026-11-20', refDate: '2026-11-20' }] }));
  const wk = r.time.weeks.find((w) => w.from === '2026-11-16');
  assert.equal(wk.specialRemovedMinutes, 440); assert.equal(wk.extraMinutes, 0);
  assert.equal(item(r, 'FERIADO'), 8000); assert.equal(wk.creditedMinutes, 0, 'feriado não reduz E abona ao mesmo tempo');
});
test('Atestado não gera saldo negativo', () => {
  const punches = workdays.filter((d) => d !== '2026-11-04').flatMap((d) => fullDay(d));
  const r = computePayslip(base({ punches, marks: [{ id: 'a', kind: 'ATESTADO', date: '2026-11-04' }] }));
  const wk = r.time.weeks.find((w) => w.from === '2026-11-02');
  assert.equal(wk.balanceMinutes, 0); assert.ok(r.time.totals.sickDays.includes('2026-11-04'));
  assert.equal(item(r, 'FALTA'), 0);
});
test('Ponto incompleto vira pendência e não falta/desconto', () => {
  const punches = workdays.flatMap((d) => (d === '2026-11-10' ? fullDay(d).slice(0, 3) : fullDay(d)));
  const r = computePayslip(base({ punches }));
  assert.ok(pendCodes(r).includes('PONTO_INCOMPLETO'));
  assert.equal(item(r, 'FALTA'), 0); assert.ok(r.blocking > 0);
  const day = r.time.days.find((d) => d.date === '2026-11-10');
  assert.equal(day.exit, null, 'não inventa saída');
});
test('Falta de ponto não vira desconto sem conciliação', () => {
  const punches = workdays.filter((d) => d !== '2026-11-12').flatMap((d) => fullDay(d));
  const r = computePayslip(base({ punches }));
  assert.equal(item(r, 'FALTA'), 0); assert.ok(pendCodes(r).includes('SEM_PONTO'));
  const conf = computePayslip(base({ punches, marks: [{ id: 'f', kind: 'FALTA_CONFIRMADA', date: '2026-11-12' }] }));
  assert.equal(item(conf, 'FALTA'), Math.round(200000 / 30)); assert.equal(item(conf, 'FALTA_DSR'), Math.round(200000 / 30));
});
test('Campina Grande sem hora extra: não paga sozinho e vira pendência para conferir o ponto', () => {
  const punches = workdays.flatMap((d) => fullDay(d, d === '2026-11-03' ? { exit: '19:20' } : {}));
  const r = computePayslip(base({ punches, profile: { storeId: 'store-LOJA03' } }));
  assert.equal(item(r, 'HORA_EXTRA'), 0); assert.ok(pendCodes(r).includes('HE_NAO_PREVISTA'));
  const ok = computePayslip(base({ profile: { storeId: 'store-LOJA03' } }));
  assert.ok(!pendCodes(ok).includes('HE_NAO_PREVISTA') && !pendCodes(ok).includes('PARAM_HE'));
});
test('Horas extras pelo saldo semanal (60% — CCT JP 2026/2027)', () => {
  const punches = workdays.flatMap((d) => fullDay(d, d === '2026-11-03' ? { exit: '19:20' } : {}));
  const r = computePayslip(base({ punches }));
  assert.equal(r.time.totals.extraMinutes, 120);
  assert.equal(item(r, 'HORA_EXTRA'), Math.round(2 * Math.round(200000 / 220) * 1.6));
  assert.ok(item(r, 'DSR_VARIAVEIS') > 0);
});
test('Fechamento: hora extra na última semana do mês é confirmada e paga', () => {
  const punches = workdays.flatMap((d) => fullDay(d, d === '2026-11-30' ? { exit: '18:20' } : {}));
  const r = computePayslip(base({ punches }));
  const last = r.time.weeks[r.time.weeks.length - 1];
  assert.equal(last.from, '2026-11-30'); assert.equal(last.provisional, false); assert.equal(last.closed, true);
  assert.equal(r.time.totals.extraConfirmedMinutes, 60); assert.ok(item(r, 'HORA_EXTRA') > 0);
  assert.ok(!pendCodes(r).includes('HE_PENDENTE'));
  const prev = computePayslip(base({ punches, rest: { provisional: true, asOfDay: '2026-11-30', nowMs: Date.parse('2026-11-30T20:00:00Z') } }));
  assert.equal(prev.time.weeks[prev.time.weeks.length - 1].provisional, true, 'na prévia a semana de hoje segue em curso');
});
test('12x36: hora extra só acima do plantão, nunca acima de 8h', () => {
  const shifts = new Map(); const punches = [];
  for (const d of cal.monthDays(competence).filter((_, i) => i % 2 === 0)) {
    shifts.set(d, { start: '07:00', end: '19:00' });
    punches.push({ type: 'entry', timestamp: at(d, '07:00') }, { type: 'break_start', timestamp: at(d, '12:00') }, { type: 'break_end', timestamp: at(d, '13:00') }, { type: 'exit', timestamp: at(d, '20:00') });
  }
  const r = computePayslip(base({ profile: { contractType: 'ESCALA_12X36', weeklyMinutes: 2520, shiftMinutes: 720 }, punches, rest: { shifts } }));
  assert.equal(r.time.weeks.length, 0);
  assert.equal(r.time.totals.extraMinutes, 0, '12h trabalhadas no plantão de 12h = sem extra');
  assert.equal(r.time.totals.sundaysWorked, 0);
});
test('Aprendiz: carga própria, FGTS 2% e alerta sem contrato', () => {
  const r = computePayslip(base({ profile: { contractType: 'APRENDIZ', weeklyMinutes: 1800, baseSalaryCents: 110000 }, punches: workdays.flatMap((d) => fullDay(d, { exit: '15:00' })) }));
  assert.equal(r.time.dailyExpectedMinutes, 300); assert.ok(pendCodes(r).includes('APRENDIZ_CONTRATO'));
  assert.equal(r.bases.fgts.rate, 2);
});
test('Horista: horas × valor + DSR', () => {
  const r = computePayslip(base({ profile: { contractType: 'HORISTA', hourlyRateCents: 1000, baseSalaryCents: null } }));
  const minutes = r.time.totals.registeredMinutes;
  assert.equal(item(r, 'HORAS_NORMAIS'), Math.round(minutes / 60 * 1000)); assert.ok(item(r, 'DSR_HORISTA') > 0);
});
test('Admissão no meio do mês: proporcional pelos dias de vínculo', () => {
  const punches = workdays.filter((d) => d >= '2026-11-16').flatMap((d) => fullDay(d));
  const r = computePayslip(base({ profile: { admissionDate: '2026-11-16' }, punches }));
  assert.equal(item(r, 'SALARIO_PROPORCIONAL'), Math.round(200000 * 15 / 30));
  assert.ok(!r.time.totals.daysWithoutPunch.some((d) => d < '2026-11-16'));
});
test('Desligamento no meio do mês', () => {
  const punches = workdays.filter((d) => d <= '2026-11-10').flatMap((d) => fullDay(d));
  const r = computePayslip(base({ profile: { terminationDate: '2026-11-10' }, punches }));
  assert.equal(item(r, 'SALARIO_PROPORCIONAL'), Math.round(200000 * 10 / 30));
});
test('Sem registro: sem INSS/IRRF/FGTS e com alerta', () => {
  const r = computePayslip(base({ profile: { contractType: 'SEM_REGISTRO', registered: false } }));
  assert.equal(item(r, 'INSS'), 0); assert.equal(r.bases.fgts, null); assert.ok(pendCodes(r).includes('SEM_REGISTRO'));
});

// ── Comissão ──────────────────────────────────────────
const sale = (id, total, status = 'completed', items) => ({ id, status, totalAmount: total, storeId: 's1', createdAt: '2026-11-05T15:00:00Z',
  items: items || [{ productName: 'Tênis', brand: 'Nike', category: 'Tênis', totalPrice: total }] });
test('Comissão abaixo da meta: 1%', () => {
  const r = computePayslip(base({ sales: [sale('a', 10000)] }));
  assert.equal(r.commission.confirmed.generalPct, 1); assert.equal(item(r, 'COMISSAO'), 10000);
  assert.ok(r.commission.confirmed.nextTier.missingCents > 0);
});
test('Comissão acima de R$ 20 mil: 2% sobre tudo', () => {
  const r = computePayslip(base({ sales: [sale('a', 15000), sale('b', 6000)] }));
  assert.equal(r.commission.confirmed.generalPct, 2); assert.equal(item(r, 'COMISSAO'), 42000);
  assert.equal(r.commission.confirmed.nextTier, null);
});
test('Comissão especial: camisas S&T acima de R$ 5 mil → só esses itens 4%', () => {
  const shirts = { productName: 'Camisa Sports & Tennis', brand: 'Sports & Tennis', category: 'Roupa', totalPrice: 6000 };
  const r = computePayslip(base({ sales: [sale('a', 10000, 'completed', [shirts, { productName: 'Tênis', brand: 'Nike', category: 'Tênis', totalPrice: 4000 }])] }));
  assert.equal(item(r, 'COMISSAO_ESPECIAL'), 24000); assert.equal(item(r, 'COMISSAO'), 4000);
  const below = computePayslip(base({ sales: [sale('a', 4000, 'completed', [{ ...shirts, totalPrice: 4000 }])] }));
  assert.equal(item(below, 'COMISSAO_ESPECIAL'), 0); assert.equal(item(below, 'COMISSAO'), 4000);
});
test('Venda cancelada não fica no valor final; pendente fica fora até confirmar', () => {
  const r = computePayslip(base({ sales: [sale('a', 10000), sale('b', 50000, 'canceled'), sale('c', 30000, 'cancelled'), sale('d', 9000, 'pending_payment')] }));
  assert.equal(r.commission.confirmed.totalCents, 1000000); assert.equal(r.commission.canceled.count, 2);
  assert.equal(item(r, 'COMISSAO'), 10000); assert.ok(pendCodes(r).includes('VENDAS_PENDENTES'));
});
test('Funcionário que vende em mais de uma loja soma tudo', () => {
  const r = computePayslip(base({ sales: [sale('a', 12000), { ...sale('b', 9000), storeId: 's2' }] }));
  assert.equal(r.commission.confirmed.totalCents, 2100000); assert.equal(r.commission.confirmed.generalPct, 2);
});

// ── Lançamentos ───────────────────────────────────────
test('Adiantamento descontado uma vez só (mesmo id repetido)', () => {
  const adv = { id: 'e1', kind: 'ADIANTAMENTO', competence, date: '2026-11-15', amountCents: 50000 };
  const r = computePayslip(base({ entries: [adv, adv] }));
  assert.equal(item(r, 'ADIANTAMENTO'), 50000);
});
test('Passagem não é adiantamento; sem opção de VT não desconta', () => {
  const pass = { id: 'e2', kind: 'PASSAGEM', competence, date: '2026-11-03', amountCents: 20000 };
  const r = computePayslip(base({ entries: [pass] }));
  assert.equal(item(r, 'ADIANTAMENTO'), 0); assert.equal(item(r, 'VALE_TRANSPORTE'), 0);
  assert.equal(r.benefits[0].kind, 'PASSAGEM');
});
test('Desconto de vale-transporte com opção: até 6%', () => {
  const r = computePayslip(base({ profile: { vtOptIn: true }, entries: [{ id: 'v', kind: 'VALE_TRANSPORTE', competence, date: '2026-11-01', amountCents: 30000 }] }));
  assert.equal(item(r, 'VALE_TRANSPORTE'), 12000);
});
test('Desconto sem autorização não é descontado', () => {
  const r = computePayslip(base({ entries: [{ id: 'c', kind: 'COMPRA_LOJA', competence, date: '2026-11-07', amountCents: 15000, authorized: false }] }));
  assert.equal(item(r, 'COMPRA_LOJA'), 0); assert.ok(pendCodes(r).includes('DESCONTO_SEM_AUTORIZACAO'));
});
test('Domingo pago antes: aparece devido E antecipado, sobra só a diferença', () => {
  const r = computePayslip(base({ params: WITH_SUNDAY, punches: [...workdays.flatMap((d) => fullDay(d)), ...fullDay('2026-11-08')],
    marks: [{ id: 'm', kind: 'FOLGA_COMPENSATORIA', date: '2026-11-11', refDate: '2026-11-08' }],
    entries: [{ id: 'd', kind: 'DOMINGO_PAGO', competence, date: '2026-11-09', amountCents: 8000, referenceDate: '2026-11-08' }] }));
  assert.equal(item(r, 'DOMINGO'), 8000); assert.equal(item(r, 'DOMINGO_PAGO'), 8000);
  assert.equal(r.specialDays[0].status, 'CONCILIADO');
});
test('Domingo trabalhado com valor ainda não cadastrado: pendência, nada inventado', () => {
  const r = computePayslip(base({ params: PARAMS.filter((p) => !(p.key === 'DOMINGO_TRABALHADO' && p.validFrom === '2026-07-01')), punches: [...workdays.flatMap((d) => fullDay(d)), ...fullDay('2026-11-08')],
    entries: [{ id: 'd', kind: 'DOMINGO_PAGO', competence, date: '2026-11-09', amountCents: 8000, referenceDate: '2026-11-08' }] }));
  assert.equal(item(r, 'DOMINGO'), 0); assert.equal(item(r, 'DOMINGO_PAGO'), 0);
  assert.ok(pendCodes(r).includes('PARAM_DOMINGO_TRABALHADO')); assert.ok(pendCodes(r).includes('ANTECIPADO_SEM_VALOR'));
});
test('Vale-alimentação R$ 14/dia (>4h) e passagem R$ 11/dia saem do ponto; manual vence o automático', () => {
  const punches = workdays.flatMap((d) => fullDay(d));
  const n = new Set(punches.map((p) => new Date(new Date(p.timestamp).getTime() - 3 * 3600000).toISOString().slice(0, 10))).size;
  const r = computePayslip(base({ punches, profile: { vtOptIn: true } }));
  const va = r.benefits.find((b) => b.kind === 'VALE_ALIMENTACAO'), pas = r.benefits.find((b) => b.kind === 'PASSAGEM');
  assert.equal(va.cents, n * 1200); assert.equal(pas.cents, n * 1100);
  assert.equal(item(r, 'VALE_TRANSPORTE'), Math.min(Math.round(200000 * 0.06), n * 1100));
  const noVt = computePayslip(base({ punches }));
  assert.ok(!noVt.benefits.some((b) => b.kind === 'PASSAGEM'), 'sem vale-transporte não gera passagem');
  const manual = computePayslip(base({ punches, entries: [{ id: 'va', kind: 'VALE_ALIMENTACAO', competence, date: '2026-11-05', amountCents: 30000 }] }));
  assert.deepEqual(manual.benefits.filter((b) => b.kind === 'VALE_ALIMENTACAO').map((b) => b.cents), [30000]);
});
test('INSS/IRRF/FGTS no contracheque mensal', () => {
  const r = computePayslip(base({ profile: { baseSalaryCents: 600000 } }));
  assert.equal(item(r, 'INSS'), legal.inss(600000, P.INSS_EMPREGADO).valueCents);
  assert.ok(item(r, 'IRRF') > 0); assert.equal(r.bases.fgts.valueCents, 48000);
  assert.equal(r.totals.netCents, r.totals.grossCents - r.totals.deductionsCents);
});
test('Prévia: provisória, com projeção até o fim do mês', () => {
  const r = computePayslip(base({ rest: { provisional: true, asOfDay: '2026-11-15', nowMs: Date.parse('2026-11-15T23:00:00Z') }, sales: [sale('a', 10000)] }));
  assert.equal(r.provisional, true); assert.ok(r.projection.netCents >= r.totals.netCents);
  assert.ok(r.commission.projection.salesCents > r.commission.confirmed.totalCents);
});
test('Reprodutível: mesmos dados → mesmo resultado', () => {
  assert.deepEqual(computePayslip(base({ sales: [sale('a', 10000)] })), computePayslip(base({ sales: [sale('a', 10000)] })));
});

// ── Férias e 13º ──────────────────────────────────────
test('Férias 30 dias + 1/3', () => {
  const r = computeSpecialPayslip({ kind: 'FERIAS', competence, params: PARAMS, profile: { contractType: 'MENSALISTA', baseSalaryCents: 300000 }, days: 30 });
  assert.equal(r.items.find((i) => i.code === 'FERIAS').cents, 300000); assert.equal(r.items.find((i) => i.code === 'FERIAS_TERCO').cents, 100000);
});
test('13º: 1ª parcela sem INSS; 2ª com INSS e abatendo a 1ª', () => {
  const p1 = computeSpecialPayslip({ kind: 'DECIMO_TERCEIRO_1', competence, params: PARAMS, profile: { contractType: 'MENSALISTA', baseSalaryCents: 240000 }, avos: 12 });
  assert.equal(p1.totals.grossCents, 120000); assert.ok(!p1.items.some((i) => i.code === 'INSS'));
  const p2 = computeSpecialPayslip({ kind: 'DECIMO_TERCEIRO_2', competence: '2026-12', params: PARAMS, profile: { contractType: 'MENSALISTA', baseSalaryCents: 240000 }, avos: 12, firstInstallmentCents: 120000 });
  assert.ok(p2.items.some((i) => i.code === 'INSS')); assert.equal(p2.items.find((i) => i.code === 'DECIMO_TERCEIRO_ADIANT').cents, 120000);
});

console.log(`PASS payroll engine: ${n} testes`);
