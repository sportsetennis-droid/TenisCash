'use strict';

// Contas a pagar por loja — regras puras (sem banco). Centavos inteiros, fuso de Fortaleza.

const { toCents, allocateCents } = require('./money');
const { FinValidationError, parseDate } = require('./finCatalog');

const FREQUENCIES = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, YEARLY: 12 };
const PAYMENT_METHODS = ['BOLETO', 'PIX', 'DEBITO_AUTOMATICO', 'TRANSFERENCIA', 'DINHEIRO', 'CARTAO', 'OUTRO'];
const DAY_MS = 86400000;

// Categoria do cadastro antigo (OperatingExpense) → conta do plano. O que não tem
// correspondência clara vai pra "A classificar" (não adivinha).
const LEGACY_CATEGORY_NATURE = {
  folha: '05.01', aluguel: '06.01', energia: '06.03', agua: '06.04', internet: '07.01',
  software: '07.02', marketing: '04.04', manutencao: '06.05',
};

function fail(msg) { throw new FinValidationError(msg); }

function text(value, label, { required = true, max = 200 } = {}) {
  const s = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  if (!s) { if (required) fail(label + ' é obrigatório'); return null; }
  if (s.length > max) fail(label + ' muito longo (máx. ' + max + ')');
  return s;
}

// ---------------- datas / competência ----------------

// Data de hoje em Fortaleza, como meia-noite local (03:00 UTC).
function todayFortaleza(now = new Date()) {
  const local = new Date(now.getTime() - 3 * 3600000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 3, 0, 0));
}

function competenceOf(date) {
  const local = new Date(new Date(date).getTime() - 3 * 3600000);
  return local.getUTCFullYear() + '-' + String(local.getUTCMonth() + 1).padStart(2, '0');
}

function parseCompetence(value, label = 'Mês') {
  const m = String(value || '').match(/^(\d{4})-(\d{2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) fail(label + ' no formato AAAA-MM');
  return m[1] + '-' + m[2];
}

function addMonths(comp, n) {
  const [y, m] = comp.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return Math.floor(idx / 12) + '-' + String((idx % 12) + 1).padStart(2, '0');
}

function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb * 12 + mb) - (ya * 12 + ma);
}

// Vencimento no mês: dia 31 em mês curto vira o último dia.
function dueDateFor(comp, day) {
  const [y, m] = comp.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(day, last), 3, 0, 0));
}

function isoDay(date) {
  return new Date(new Date(date).getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

// ---------------- despesas fixas ----------------

function recurringAppliesTo(rec, comp) {
  if (!rec || !rec.active || !rec.dueDay) return false;
  if (comp < rec.startCompetence) return false;
  if (rec.endCompetence && comp > rec.endCompetence) return false;
  const step = FREQUENCIES[rec.frequency] || 1;
  return monthsBetween(rec.startCompetence, comp) % step === 0;
}

// Contas do mês que ainda não existem (existingKeys = Set de "recurringId|competência").
function planRecurringTitles(recurrings, comp, existingKeys = new Set()) {
  const out = [];
  for (const r of recurrings || []) {
    if (!recurringAppliesTo(r, comp)) continue;
    if (existingKeys.has(r.id + '|' + comp)) continue;
    out.push({
      kind: 'PAYABLE', storeId: r.storeId || null, natureId: r.natureId, recurringId: r.id, competence: comp,
      description: r.description, payee: r.payee || null, amountCents: r.amountCents,
      amountConfirmed: !r.variableAmount, dueDate: dueDateFor(comp, r.dueDay), paymentMethod: r.paymentMethod || null,
    });
  }
  return out;
}

function validateRecurring(input, { partial = false } = {}) {
  const has = (k) => input[k] !== undefined;
  const d = {};
  if (!partial || has('storeId')) d.storeId = input.storeId ? String(input.storeId) : null;
  if (!partial || has('natureId')) d.natureId = text(input.natureId, 'Conta do plano', { max: 60 });
  if (!partial || has('description')) d.description = text(input.description, 'Descrição');
  if (!partial || has('payee')) d.payee = text(input.payee, 'Favorecido', { required: false });
  if (!partial || has('amount') || has('amountCents')) {
    d.amountCents = has('amountCents') ? Math.trunc(Number(input.amountCents)) : toCents(input.amount);
    if (!Number.isInteger(d.amountCents) || d.amountCents <= 0) fail('Informe o valor');
  }
  if (!partial || has('variableAmount')) d.variableAmount = !!input.variableAmount;
  if (!partial || has('dueDay')) {
    if (input.dueDay == null || input.dueDay === '') d.dueDay = null;
    else {
      d.dueDay = Number(input.dueDay);
      if (!Number.isInteger(d.dueDay) || d.dueDay < 1 || d.dueDay > 31) fail('Dia do vencimento entre 1 e 31');
    }
    if (!partial && !d.dueDay) fail('Informe o dia do vencimento');
  }
  if (!partial || has('frequency')) {
    d.frequency = String(input.frequency || 'MONTHLY').toUpperCase();
    if (!FREQUENCIES[d.frequency]) fail('Frequência inválida');
  }
  if (!partial || has('startCompetence')) d.startCompetence = parseCompetence(input.startCompetence, 'Mês de início');
  if (!partial || has('endCompetence')) d.endCompetence = input.endCompetence ? parseCompetence(input.endCompetence, 'Mês final') : null;
  if (d.startCompetence && d.endCompetence && d.endCompetence < d.startCompetence) fail('Mês final antes do início');
  if (!partial || has('paymentMethod')) d.paymentMethod = paymentMethod(input.paymentMethod);
  if (!partial || has('notes')) d.notes = text(input.notes, 'Observação', { required: false, max: 500 });
  if (partial && !Object.keys(d).length) fail('Nada para alterar');
  return d;
}

function paymentMethod(v) {
  if (v == null || v === '') return null;
  const s = String(v).toUpperCase();
  if (!PAYMENT_METHODS.includes(s)) fail('Forma de pagamento inválida');
  return s;
}

// ---------------- títulos ----------------

function balanceCents(t) {
  return Math.max(0, t.amountCents - t.paidPrincipalCents - t.discountCents);
}

function statusFor(t) {
  if (t.canceledAt) return 'CANCELED';
  const settled = t.paidPrincipalCents + t.discountCents;
  if (settled > 0 && balanceCents(t) === 0) return 'PAID';
  if (t.paidPrincipalCents > 0) return 'PARTIAL';
  return 'OPEN';
}

// Situação pra tela: vencida / vence hoje entram por cima do status.
function situation(t, today = todayFortaleza()) {
  const st = t.status || statusFor(t);
  if (st === 'PAID' || st === 'CANCELED') return st;
  const due = new Date(t.dueDate).getTime();
  if (due < today.getTime()) return 'OVERDUE';
  if (due < today.getTime() + DAY_MS) return 'DUE_TODAY';
  return st;
}

// Avulsa ou parcelada: N parcelas mensais, centavo que sobra vai na 1ª.
function planTitleCreate(input) {
  const amountCents = input.amountCents !== undefined ? Math.trunc(Number(input.amountCents)) : toCents(input.amount);
  if (!Number.isInteger(amountCents) || amountCents <= 0) fail('Informe o valor');
  const firstDue = parseDate(input.dueDate, 'Vencimento');
  if (!firstDue) fail('Informe o vencimento');
  const n = input.installments == null || input.installments === '' ? 1 : Number(input.installments);
  if (!Number.isInteger(n) || n < 1 || n > 60) fail('Parcelas entre 1 e 60');
  const base = {
    kind: 'PAYABLE',
    storeId: input.storeId ? String(input.storeId) : null,
    natureId: text(input.natureId, 'Conta do plano', { max: 60 }),
    description: text(input.description, 'Descrição'),
    payee: text(input.payee, 'Favorecido', { required: false }),
    documentNumber: text(input.documentNumber, 'Número do documento', { required: false, max: 60 }),
    paymentMethod: paymentMethod(input.paymentMethod),
    barcode: text(input.barcode, 'Código de barras', { required: false, max: 120 }),
    pixKey: text(input.pixKey, 'Chave PIX', { required: false, max: 120 }),
    notes: text(input.notes, 'Observação', { required: false, max: 500 }),
  };
  const parts = allocateCents(amountCents, Array(n).fill(1));
  const day = Number(isoDay(firstDue).slice(8, 10));
  const comp0 = competenceOf(firstDue);
  return parts.map((cents, i) => {
    const comp = addMonths(comp0, i);
    return {
      ...base,
      competence: input.competence && n === 1 ? parseCompetence(input.competence) : comp,
      amountCents: cents,
      dueDate: i === 0 ? firstDue : dueDateFor(comp, day),
      installment: n > 1 ? i + 1 : null,
      installments: n > 1 ? n : null,
      description: n > 1 ? base.description + ' (' + (i + 1) + '/' + n + ')' : base.description,
    };
  });
}

// Edição: só enquanto não tem baixa. Mudar o valor confirma o valor (despesa variável).
function validateTitleUpdate(input, title) {
  if (title.canceledAt) fail('Conta cancelada não pode ser alterada');
  if (title.paidPrincipalCents !== 0 || title.discountCents !== 0) fail('Conta com pagamento não pode ser alterada; estorne o pagamento antes');
  const has = (k) => input[k] !== undefined;
  const d = {};
  if (has('amount') || has('amountCents')) {
    d.amountCents = has('amountCents') ? Math.trunc(Number(input.amountCents)) : toCents(input.amount);
    if (!Number.isInteger(d.amountCents) || d.amountCents <= 0) fail('Informe o valor');
    d.amountConfirmed = true;
  }
  if (has('confirmAmount') && input.confirmAmount) d.amountConfirmed = true;
  if (has('dueDate')) { d.dueDate = parseDate(input.dueDate, 'Vencimento'); if (!d.dueDate) fail('Informe o vencimento'); }
  if (has('description')) d.description = text(input.description, 'Descrição');
  if (has('payee')) d.payee = text(input.payee, 'Favorecido', { required: false });
  if (has('natureId')) d.natureId = text(input.natureId, 'Conta do plano', { max: 60 });
  if (has('storeId')) d.storeId = input.storeId ? String(input.storeId) : null;
  if (has('documentNumber')) d.documentNumber = text(input.documentNumber, 'Número do documento', { required: false, max: 60 });
  if (has('paymentMethod')) d.paymentMethod = paymentMethod(input.paymentMethod);
  if (has('barcode')) d.barcode = text(input.barcode, 'Código de barras', { required: false, max: 120 });
  if (has('pixKey')) d.pixKey = text(input.pixKey, 'Chave PIX', { required: false, max: 120 });
  if (has('notes')) d.notes = text(input.notes, 'Observação', { required: false, max: 500 });
  if (!Object.keys(d).length) fail('Nada para alterar');
  return d;
}

function cents(v, label) {
  if (v == null || v === '') return 0;
  const c = toCents(v);
  if (c < 0) fail(label + ' não pode ser negativo');
  return c;
}

// Pagamento (baixa). Sem valor informado = paga o saldo inteiro.
function planSettlement(input, title, today = todayFortaleza()) {
  if (title.canceledAt) fail('Conta cancelada');
  const balance = balanceCents(title);
  if (balance <= 0) fail('Conta já está paga');
  const principalCents = input.amount == null || input.amount === '' ? balance : toCents(input.amount);
  if (!(principalCents > 0)) fail('Informe o valor pago');
  const discountCents = cents(input.discount, 'Desconto');
  const interestCents = cents(input.interest, 'Juros');
  const fineCents = cents(input.fine, 'Multa');
  if (principalCents + discountCents > balance) fail('Valor pago + desconto passa do saldo da conta');
  const paidAt = parseDate(input.paidAt, 'Data do pagamento') || today;
  if (paidAt.getTime() > today.getTime() + DAY_MS) fail('Data do pagamento no futuro');
  return {
    principalCents, discountCents, interestCents, fineCents,
    totalCents: principalCents + interestCents + fineCents,
    paidAt,
    accountId: input.accountId ? String(input.accountId) : null,
    method: paymentMethod(input.method) || title.paymentMethod || null,
    note: text(input.note, 'Observação', { required: false, max: 500 }),
  };
}

// Totais do título depois de aplicar uma baixa (ou estorno, com sinal negativo).
function applySettlement(title, s, sign = 1) {
  const next = {
    paidPrincipalCents: title.paidPrincipalCents + sign * s.principalCents,
    discountCents: title.discountCents + sign * s.discountCents,
    interestCents: title.interestCents + sign * s.interestCents,
    fineCents: title.fineCents + sign * s.fineCents,
  };
  if (next.paidPrincipalCents < 0 || next.discountCents < 0) fail('Estorno maior que o pago');
  next.status = statusFor({ ...title, ...next });
  return next;
}

// Painel: vencidas, hoje, próximos 7 dias, a pagar no mês, pago no mês.
function summarize(titles, settlements, today = todayFortaleza()) {
  const t0 = today.getTime();
  const comp = competenceOf(today);
  const out = {
    overdue: { count: 0, cents: 0 }, today: { count: 0, cents: 0 }, next7: { count: 0, cents: 0 },
    monthOpen: { count: 0, cents: 0 }, paidMonth: { count: 0, cents: 0 },
    pendingApproval: { count: 0, cents: 0 }, unconfirmed: { count: 0 },
  };
  for (const t of titles || []) {
    const st = t.status || statusFor(t);
    if (st === 'PAID' || st === 'CANCELED') continue;
    const bal = balanceCents(t);
    const due = new Date(t.dueDate).getTime();
    if (due < t0) { out.overdue.count++; out.overdue.cents += bal; }
    else if (due < t0 + DAY_MS) { out.today.count++; out.today.cents += bal; }
    else if (due < t0 + 8 * DAY_MS) { out.next7.count++; out.next7.cents += bal; }
    if (competenceOf(t.dueDate) === comp) { out.monthOpen.count++; out.monthOpen.cents += bal; }
    if (t.approvalStatus !== 'APPROVED') { out.pendingApproval.count++; out.pendingApproval.cents += bal; }
    if (t.amountConfirmed === false) out.unconfirmed.count++;
  }
  for (const s of settlements || []) {
    if (competenceOf(s.paidAt) !== comp) continue;
    out.paidMonth.cents += s.totalCents;
    if (!s.reversalOfId) out.paidMonth.count++;
  }
  return out;
}

module.exports = {
  FREQUENCIES, PAYMENT_METHODS, LEGACY_CATEGORY_NATURE,
  todayFortaleza, competenceOf, parseCompetence, addMonths, monthsBetween, dueDateFor, isoDay,
  recurringAppliesTo, planRecurringTitles, validateRecurring,
  balanceCents, statusFor, situation, planTitleCreate, validateTitleUpdate, planSettlement, applySettlement, summarize,
};
