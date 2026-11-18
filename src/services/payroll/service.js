'use strict';

// Camada de dados do contracheque: carrega os dados REAIS (ponto, agenda, vendas,
// lançamentos, parâmetros), calcula pelo motor puro e controla o ciclo de fechamento.
// Fechado = congelado (snapshot + result + PDF salvos). Correção = versão nova.

const cal = require('./calendar');
const { computePayslip } = require('./engine');
const { createPayslipPdf } = require('./pdf');
const pcrypto = require('./crypto');

const OPEN_STATUSES = ['EM_CONFERENCIA', 'COM_PENDENCIAS', 'APROVADO'];
const FROZEN_STATUSES = ['FECHADO', 'PAGO'];
const ADMIN_ROLES = ['admin', 'superadmin', 'manager'];

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function plain(v) { return v == null ? null : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))); }
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function publicBase() { return (process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br').replace(/\/+$/, ''); }

async function audit(tx, { entity, entityId, action, subjectUserId = null, before = null, after = null, reason = null, req = null }) {
  return tx.payrollAuditLog.create({ data: {
    entity, entityId: String(entityId), action, subjectUserId,
    actorId: req?.userId || null, actorRole: req?.userRole || null,
    before: plain(before), after: plain(after), reason: reason ? String(reason).slice(0, 1000) : null,
    ip: req ? String(req.headers?.['x-forwarded-for'] || req.ip || '').split(',')[0].trim().slice(0, 64) || null : null,
  } });
}

function profileFromUser(user, profile) {
  // Sem cadastro de contrato: usa só o que o User já tem de real; o resto fica pendente.
  if (profile) return { ...profile, userId: user.id };
  return {
    userId: user.id, contractType: null, registered: true, issuerId: null, storeId: user.storeId || null,
    admissionDate: user.hireDate ? cal.dayKeyOf(user.hireDate) : null,
    baseSalaryCents: user.baseSalary != null ? Math.round(user.baseSalary * 100) : null,
    weeklyMinutes: 2640, workDaysPerWeek: 6, irrfDependents: 0, familyAllowanceChildren: 0, vtOptIn: false,
    registration: user.employeeCode || null, _missingProfile: true,
  };
}

// Junta TODOS os dados de entrada de um funcionário numa competência.
async function loadInput(prisma, userId, competence, { asOfDay = null, nowMs = Date.now() } = {}) {
  if (!cal.isCompetence(competence)) throw httpError(400, 'Competência inválida (use AAAA-MM)');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: {
    id: true, name: true, phone: true, role: true, active: true, storeId: true, storeIds: true, hireDate: true, baseSalary: true, employeeCode: true } });
  if (!user) throw httpError(404, 'Funcionário não encontrado');
  const profileRow = await prisma.payrollEmployeeProfile.findUnique({ where: { userId } });
  const profile = profileFromUser(user, profileRow);
  const storeId = profile.storeId || user.storeId || null;
  const store = storeId ? await prisma.store.findUnique({ where: { id: storeId }, select: { id: true, code: true, name: true, fiscalIssuerId: true } }) : null;
  const issuerId = profile.issuerId || store?.fiscalIssuerId || null;
  profile.issuerId = issuerId; profile.storeId = storeId;
  // Lojas onde domingo é troca pedida pelo colaborador, sem adicional (dono 18/11/2026: Campina Grande).
  const swapStores = String(process.env.PAYROLL_SUNDAY_SWAP_STORES || 'LOJA03').split(',').map((x) => x.trim()).filter(Boolean);
  profile.sundaySwap = !!(store && swapStores.includes(store.code));
  const first = cal.firstDay(competence), last = cal.lastDay(competence);
  const start = cal.dayStartUtc(first), end = cal.dayEndUtc(last);
  const [params, holidays, rules, entries, marks, corrections, punches, agenda, sales, monthly] = await Promise.all([
    prisma.payrollParam.findMany({ orderBy: { validFrom: 'asc' } }),
    prisma.payrollHoliday.findMany({ where: { date: { gte: first, lte: last }, active: true } }),
    prisma.payrollCommissionRule.findMany({ where: { active: true } }),
    prisma.payrollEntry.findMany({ where: { userId, competence } }),
    prisma.payrollDayMark.findMany({ where: { userId, date: { gte: first, lte: last } } }),
    prisma.payrollClockCorrection.findMany({ where: { userId, date: { gte: first, lte: last } } }),
    prisma.clockIn.findMany({ where: { userId, timestamp: { gte: start, lt: end } }, orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true, storeId: true, note: true, source: true } }),
    prisma.agendaActivity.findMany({ where: { type: { in: ['folga', 'ferias', 'feriado'] }, date: { lt: end },
      OR: [{ endDate: null, date: { gte: start } }, { endDate: { gte: start } }] } }).catch(() => []),
    prisma.sale.findMany({ where: { sellerId: userId, createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, totalAmount: true, discount: true, storeId: true, createdAt: true, paymentMethod: true,
        items: { select: { productName: true, brand: true, category: true, quantity: true, totalPrice: true } } } }),
    prisma.sellerMonthlySchedule.findUnique({ where: { month: competence }, select: { id: true, status: true } }).catch(() => null),
  ]);
  // Agenda: folga/férias do próprio funcionário viram marcação; feriado geral/da loja vira feriado.
  const agendaHolidays = [], agendaMarks = [];
  for (const a of agenda) {
    const from = cal.dayKeyOf(a.date), to = a.endDate ? cal.dayKeyOf(a.endDate) : from;
    for (let d = from; d <= to; d = cal.addDays(d, 1)) {
      if (!d.startsWith(competence)) continue;
      if (a.type === 'feriado' && (!a.sellerId || a.sellerId === userId) && (!a.storeId || a.storeId === storeId)) agendaHolidays.push({ date: d, name: a.title || 'Feriado (Agenda)', scope: 'AGENDA', active: true });
      if (a.sellerId === userId && a.type === 'folga') agendaMarks.push({ id: 'agenda:' + a.id + ':' + d, kind: 'FOLGA', date: d, status: 'APROVADO', note: 'Agenda: ' + (a.title || 'folga') });
      if (a.sellerId === userId && a.type === 'ferias') agendaMarks.push({ id: 'agenda:' + a.id + ':' + d, kind: 'FERIAS', date: d, status: 'APROVADO', note: 'Agenda: férias' });
    }
  }
  let shifts = [];
  if (monthly?.status === 'PUBLISHED') {
    const rows = await prisma.sellerMonthlyShift.findMany({ where: { scheduleId: monthly.id, sellerId: userId }, select: { workDate: true, startTime: true, endTime: true } });
    shifts = rows.map((r) => [cal.dayKeyOf(r.workDate), { start: r.startTime, end: r.endTime }]);
  }
  const today = cal.dayKeyOf(nowMs);
  return {
    user, store, profile,
    input: {
      competence, profile: plain(profile), nowMs, asOfDay: asOfDay || (today < last ? today : last),
      params: plain(params), holidays: plain([...holidays, ...agendaHolidays]), commissionRules: plain(rules),
      entries: plain(entries), marks: plain([...marks, ...agendaMarks]), corrections: plain(corrections.map(({ attachment, ...c }) => c)),
      punches: plain(punches), sales: plain(sales), shifts,
    },
  };
}

function runEngine(input, { provisional }) {
  return computePayslip({ ...input, provisional, shifts: new Map(input.shifts || []) });
}

async function preview(prisma, userId, competence, { nowMs = Date.now() } = {}) {
  const loaded = await loadInput(prisma, userId, competence, { nowMs });
  const isCurrent = competence >= cal.competenceOf(nowMs);
  const result = runEngine(loaded.input, { provisional: isCurrent || cal.dayKeyOf(nowMs) <= cal.lastDay(competence) });
  if (loaded.profile._missingProfile) result.pendencies.unshift({ code: 'CADASTRO', severity: 'BLOQUEIA', text: 'Cadastro de contrato do funcionário não preenchido (tipo, admissão, salário, jornada).' });
  result.blocking = result.pendencies.filter((p) => p.severity === 'BLOQUEIA').length;
  return { ...loaded, result };
}

async function companyOf(prisma, issuerId, store) {
  const issuer = issuerId ? await prisma.fiscalIssuer.findUnique({ where: { id: issuerId }, select: {
    id: true, cnpj: true, companyName: true, fantasyName: true, street: true, number: true, neighborhood: true, city: true, state: true, zip: true } }) : null;
  return {
    id: issuer?.id || null, cnpj: issuer?.cnpj ? issuer.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : null,
    companyName: issuer?.companyName || null, fantasyName: issuer?.fantasyName || null,
    address: issuer ? [issuer.street, issuer.number, issuer.neighborhood, issuer.city && `${issuer.city}/${issuer.state || ''}`, issuer.zip].filter(Boolean).join(', ') : null,
    establishment: store ? `${store.code} — ${store.name}` : null,
  };
}

// Revisar: grava/atualiza o rascunho da versão aberta com o cálculo atual.
// Fechamento sempre olha o mês inteiro com o mesmo "agora" (fim do mês): o snapshot
// não depende da hora em que foi revisado e o hash compara só os dados.
const finalOpts = (competence) => ({ asOfDay: cal.lastDay(competence), nowMs: cal.dayEndUtc(cal.lastDay(competence)).getTime() });

async function review(prisma, { userId, competence, req }) {
  const loaded = await loadInput(prisma, userId, competence, finalOpts(competence));
  const result = runEngine(loaded.input, { provisional: false });
  if (loaded.profile._missingProfile) result.pendencies.unshift({ code: 'CADASTRO', severity: 'BLOQUEIA', text: 'Cadastro de contrato do funcionário não preenchido.' });
  result.blocking = result.pendencies.filter((p) => p.severity === 'BLOQUEIA').length;
  const status = result.blocking ? 'COM_PENDENCIAS' : 'EM_CONFERENCIA';
  return prisma.$transaction(async (tx) => {
    const versions = await tx.payslip.findMany({ where: { userId, competence, kind: 'MENSAL' }, orderBy: { version: 'desc' } });
    const open = versions.find((v) => OPEN_STATUSES.includes(v.status));
    if (!open && versions.some((v) => FROZEN_STATUSES.includes(v.status))) throw httpError(409, 'Contracheque já fechado. Para corrigir, reabra (gera nova versão).');
    const data = { snapshot: loaded.input, result: plain(result), status, issuerId: loaded.profile.issuerId, storeId: loaded.profile.storeId,
      grossCents: result.totals.grossCents, deductionsCents: result.totals.deductionsCents, netCents: result.totals.netCents,
      inputHash: pcrypto.sha256(stableStringify(loaded.input)), approvedById: null, approvedAt: null };
    const saved = open
      ? await tx.payslip.update({ where: { id: open.id }, data })
      : await tx.payslip.create({ data: { ...data, userId, competence, kind: 'MENSAL', version: (versions[0]?.version || 0) + 1, createdById: req?.userId || null } });
    await audit(tx, { entity: 'Payslip', entityId: saved.id, action: open ? 'REVIEW_UPDATE' : 'REVIEW_CREATE', subjectUserId: userId,
      before: open ? { status: open.status, netCents: open.netCents } : null, after: { status, netCents: saved.netCents, pendencies: result.pendencies.length }, req });
    return saved;
  });
}

async function approve(prisma, { id, req }) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.payslip.findUnique({ where: { id } });
    if (!p) throw httpError(404, 'Contracheque não encontrado');
    if (p.status !== 'EM_CONFERENCIA') throw httpError(409, p.status === 'COM_PENDENCIAS' ? 'Há pendências que bloqueiam: resolva e revise de novo.' : 'Só aprova contracheque em conferência.');
    const saved = await tx.payslip.update({ where: { id }, data: { status: 'APROVADO', approvedById: req.userId, approvedAt: new Date() } });
    await audit(tx, { entity: 'Payslip', entityId: id, action: 'APPROVE', subjectUserId: p.userId, before: { status: p.status }, after: { status: 'APROVADO' }, req });
    return saved;
  });
}

// Fechar: recalcula com os dados atuais, CONGELA (snapshot + result + hash), gera e
// salva o PDF. Nada é fechado com dado diferente do que foi conferido: se o cálculo
// mudou desde a aprovação, recusa e pede nova revisão.
async function close(prisma, { id, req, paymentDate = null, reason = null, nowMs = Date.now() }) {
  const p = await prisma.payslip.findUnique({ where: { id } });
  if (!p) throw httpError(404, 'Contracheque não encontrado');
  if (p.status !== 'APROVADO') throw httpError(409, 'Só fecha contracheque APROVADO (revisar → aprovar → fechar).');
  if (cal.dayKeyOf(nowMs) <= cal.lastDay(p.competence)) throw httpError(409, 'A competência ainda não terminou.');
  const loaded = await loadInput(prisma, p.userId, p.competence, finalOpts(p.competence));
  const hash = pcrypto.sha256(stableStringify(loaded.input));
  if (hash !== p.inputHash) throw httpError(409, 'Os dados mudaram desde a conferência (ponto, vendas ou lançamentos). Revise de novo antes de fechar.');
  const result = runEngine(loaded.input, { provisional: false });
  if (loaded.profile._missingProfile) throw httpError(409, 'Cadastro de contrato não preenchido.');
  const verifyCode = pcrypto.verifyCode();
  const company = await companyOf(prisma, loaded.profile.issuerId, loaded.store);
  const employee = {
    name: loaded.user.name, registration: loaded.profile.registration || loaded.user.employeeCode, jobTitle: loaded.profile.jobTitle, cbo: loaded.profile.cbo,
    cpfMasked: loaded.profile.cpfLast4 ? pcrypto.maskCpf(loaded.profile.cpfLast4) : null, storeName: loaded.store?.name || null,
    unionName: loaded.profile.unionName, cctRef: loaded.profile.cctRef,
  };
  const closedAt = new Date(nowMs);
  const draft = { ...p, status: 'FECHADO', verifyCode, paymentDate, reason };
  const pdf = await createPayslipPdf({ payslip: draft, result, company, employee, verifyUrl: `${publicBase()}/contracheque/verificar/${verifyCode}`, generatedAt: closedAt });
  return prisma.$transaction(async (tx) => {
    const fresh = await tx.payslip.findUnique({ where: { id } });
    if (fresh.status !== 'APROVADO') throw httpError(409, 'Status mudou durante o fechamento.');
    const saved = await tx.payslip.update({ where: { id }, data: {
      status: 'FECHADO', snapshot: loaded.input, result: plain({ ...result, company, employee }), inputHash: hash, verifyCode,
      grossCents: result.totals.grossCents, deductionsCents: result.totals.deductionsCents, netCents: result.totals.netCents,
      paymentDate, reason, closedById: req.userId, closedAt } });
    await tx.payslipFile.create({ data: { payslipId: id, fileName: `contracheque-${p.competence}-v${p.version}.pdf`, content: pdf, sha256: pcrypto.sha256(pdf), sizeBytes: pdf.length } });
    if (p.supersedesId) {
      await tx.payslip.update({ where: { id: p.supersedesId }, data: { status: 'CORRIGIDO', supersededById: id } });
      await audit(tx, { entity: 'Payslip', entityId: p.supersedesId, action: 'SUPERSEDED', subjectUserId: p.userId, after: { supersededById: id }, req });
    }
    await audit(tx, { entity: 'Payslip', entityId: id, action: 'CLOSE', subjectUserId: p.userId, before: { status: p.status },
      after: { status: 'FECHADO', netCents: saved.netCents, verifyCode, pdfSha256: pcrypto.sha256(pdf) }, reason, req });
    return saved;
  });
}

async function markPaid(prisma, { id, req, paymentRef, paidAt }) {
  if (!paymentRef) throw httpError(400, 'Informe o comprovante/identificador do pagamento.');
  return prisma.$transaction(async (tx) => {
    const p = await tx.payslip.findUnique({ where: { id } });
    if (!p) throw httpError(404, 'Contracheque não encontrado');
    if (p.status !== 'FECHADO') throw httpError(409, 'Só registra pagamento de contracheque FECHADO.');
    const saved = await tx.payslip.update({ where: { id }, data: { status: 'PAGO', paidById: req.userId, paidAt: paidAt ? new Date(paidAt) : new Date(), paymentRef: String(paymentRef).slice(0, 200) } });
    await audit(tx, { entity: 'Payslip', entityId: id, action: 'PAY', subjectUserId: p.userId, before: { status: p.status }, after: { status: 'PAGO', paymentRef: saved.paymentRef }, req });
    return saved;
  });
}

// Reabrir NÃO altera a versão fechada: ela vira REABERTO (preservada) e nasce a versão seguinte.
async function reopen(prisma, { id, req, reason }) {
  if (!reason || String(reason).trim().length < 5) throw httpError(400, 'Motivo da reabertura é obrigatório.');
  return prisma.$transaction(async (tx) => {
    const p = await tx.payslip.findUnique({ where: { id } });
    if (!p) throw httpError(404, 'Contracheque não encontrado');
    if (!FROZEN_STATUSES.includes(p.status)) throw httpError(409, 'Só reabre contracheque fechado ou pago.');
    const latest = await tx.payslip.findFirst({ where: { userId: p.userId, competence: p.competence, kind: p.kind }, orderBy: { version: 'desc' } });
    if (latest.id !== p.id) throw httpError(409, 'Existe versão mais nova desta competência.');
    await tx.payslip.update({ where: { id }, data: { status: 'REABERTO' } });
    const next = await tx.payslip.create({ data: {
      userId: p.userId, issuerId: p.issuerId, storeId: p.storeId, competence: p.competence, kind: p.kind, version: p.version + 1,
      status: 'EM_CONFERENCIA', supersedesId: p.id, reason: String(reason).slice(0, 1000), createdById: req.userId } });
    await audit(tx, { entity: 'Payslip', entityId: id, action: 'REOPEN', subjectUserId: p.userId, before: { status: p.status }, after: { status: 'REABERTO', newVersionId: next.id }, reason, req });
    return next;
  });
}

async function cancel(prisma, { id, req, reason }) {
  if (!reason) throw httpError(400, 'Motivo do cancelamento é obrigatório.');
  return prisma.$transaction(async (tx) => {
    const p = await tx.payslip.findUnique({ where: { id } });
    if (!p) throw httpError(404, 'Contracheque não encontrado');
    if (!OPEN_STATUSES.includes(p.status)) throw httpError(409, 'Contracheque fechado não se cancela: reabra e corrija (gera nova versão).');
    const saved = await tx.payslip.update({ where: { id }, data: { status: 'CANCELADO', reason: String(reason).slice(0, 1000) } });
    await audit(tx, { entity: 'Payslip', entityId: id, action: 'CANCEL', subjectUserId: p.userId, before: { status: p.status }, after: { status: 'CANCELADO' }, reason, req });
    return saved;
  });
}

// Recalcula a partir do snapshot congelado — prova de reprodutibilidade.
function recompute(payslip) {
  const { company, employee, ...stored } = payslip.result || {};
  const again = runEngine(payslip.snapshot, { provisional: false });
  return { equal: stableStringify(plain(again)) === stableStringify(stored), result: again };
}

module.exports = {
  OPEN_STATUSES, FROZEN_STATUSES, ADMIN_ROLES, httpError, audit, loadInput, preview, review, approve, close, markPaid, reopen, cancel,
  recompute, companyOf, stableStringify, publicBase, plain,
};
