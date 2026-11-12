'use strict';

// =====================================================================
// /api/fin/payables + /api/fin/recurring — contas a pagar por loja
// =====================================================================
// Montado DENTRO de /api/fin (já passa por login + admin + schema pronto).
// Regras: só o DONO libera pagamento; pagar exige conta liberada (o dono, ao
// pagar, libera junto). Nada é apagado: conta cancela com motivo, pagamento
// estorna com motivo (linha nova). Toda escrita grava auditoria na mesma transação.
// =====================================================================

const express = require('express');
const { prisma } = require('../middleware');
const { audit } = require('../services/finAudit');
const { isFinOwner } = require('../services/finOwner');
const catalog = require('../services/finCatalog');
const P = require('../services/finPayables');

const router = express.Router();

function fail(res, err, tag) {
  if (err instanceof catalog.FinValidationError) return res.status(400).json({ error: err.message });
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  if (err && err.code === 'P2025') return res.status(404).json({ error: 'Cadastro não encontrado' });
  console.error('[fin payables ' + tag + ']', err);
  return res.status(500).json({ error: 'Erro interno no contas a pagar' });
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function lookups(db = prisma) {
  const [stores, natures] = await Promise.all([
    db.store.findMany({ select: { id: true, code: true, name: true, active: true }, orderBy: { code: 'asc' } }),
    db.finNature.findMany({ select: { id: true, code: true, name: true, kind: true, analytic: true, active: true }, orderBy: { code: 'asc' } }),
  ]);
  return { stores, natures, storeById: new Map(stores.map((s) => [s.id, s])), natureById: new Map(natures.map((n) => [n.id, n])) };
}

function view(t, lk, today) {
  const s = t.storeId ? lk.storeById.get(t.storeId) : null;
  const n = lk.natureById.get(t.natureId);
  return {
    ...t,
    balanceCents: P.balanceCents(t),
    situation: P.situation(t, today),
    store: s ? { id: s.id, code: s.code, name: s.name } : null,
    nature: n ? { id: n.id, code: n.code, name: n.name } : null,
  };
}

async function assertRefs(tx, { storeId, natureId }) {
  if (storeId) {
    const s = await tx.store.findUnique({ where: { id: storeId }, select: { id: true } });
    if (!s) throw new catalog.FinValidationError('Loja não encontrada');
  }
  if (natureId) {
    const n = await tx.finNature.findUnique({ where: { id: natureId } });
    if (!n) throw new catalog.FinValidationError('Conta do plano não encontrada');
    if (!n.analytic) throw new catalog.FinValidationError('Escolha uma conta que recebe lançamento (não o grupo)');
    if (!n.active) throw new catalog.FinValidationError('Conta do plano desativada');
    if (n.kind === 'RECEITA') throw new catalog.FinValidationError('Conta de receita não serve pra conta a pagar');
  }
}

async function lockTitle(tx, id) {
  await tx.$queryRaw`SELECT "id" FROM "FinTitle" WHERE "id" = ${id} FOR UPDATE`;
  const t = await tx.finTitle.findUnique({ where: { id } });
  if (!t) throw httpError(404, 'Conta não encontrada');
  return t;
}

function storeFilter(q) {
  if (q === 'none') return { storeId: null };
  if (q) return { storeId: String(q) };
  return {};
}

// ----------------------------- Geração das fixas -----------------------------

// Gera (sem duplicar) as contas das despesas fixas para os meses pedidos.
async function generateRecurring(comps, req = null) {
  let created = 0;
  for (const comp of comps) {
    created += await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('fin-recurring-generate'))) AS fin_gen_lock`;
      const recs = await tx.finRecurring.findMany({ where: { active: true, dueDay: { not: null } } });
      if (!recs.length) return 0;
      const existing = await tx.finTitle.findMany({ where: { competence: comp, recurringId: { in: recs.map((r) => r.id) } }, select: { recurringId: true } });
      const plan = P.planRecurringTitles(recs, comp, new Set(existing.map((e) => e.recurringId + '|' + comp)));
      for (const data of plan) {
        const t = await tx.finTitle.create({ data: { ...data, createdById: req?.userId || null } });
        await audit(tx, { entity: 'FinTitle', entityId: t.id, action: 'create', after: t, reason: 'gerada da despesa fixa ' + comp, req });
      }
      return plan.length;
    }, { timeout: 60000, maxWait: 15000 });
  }
  return created;
}

function currentAndNext() {
  const c = P.competenceOf(P.todayFortaleza());
  return [c, P.addMonths(c, 1)];
}

// ----------------------------- Contas a pagar -----------------------------

router.get('/payables/summary', async (req, res) => {
  try {
    const today = P.todayFortaleza();
    const sf = storeFilter(req.query.storeId);
    const monthStart = P.dueDateFor(P.competenceOf(today), 1);
    const [open, setts, lk, isOwner] = await Promise.all([
      prisma.finTitle.findMany({ where: { kind: 'PAYABLE', status: { in: ['OPEN', 'PARTIAL'] }, ...sf } }),
      prisma.finSettlement.findMany({ where: { paidAt: { gte: monthStart } }, select: { titleId: true, paidAt: true, totalCents: true, reversalOfId: true } }),
      lookups(),
      isFinOwner(prisma, req),
    ]);
    let settlements = setts;
    if (req.query.storeId) {
      const ids = new Set((await prisma.finTitle.findMany({ where: { id: { in: setts.map((s) => s.titleId) }, ...sf }, select: { id: true } })).map((t) => t.id));
      settlements = setts.filter((s) => ids.has(s.titleId));
    }
    const summary = P.summarize(open, settlements, today);
    // Por loja (só contas em aberto).
    const byStore = {};
    for (const t of open) {
      const k = t.storeId || 'none';
      byStore[k] = byStore[k] || { storeId: t.storeId, openCents: 0, overdueCents: 0, count: 0 };
      const bal = P.balanceCents(t);
      byStore[k].openCents += bal; byStore[k].count++;
      if (new Date(t.dueDate) < today) byStore[k].overdueCents += bal;
    }
    const urgent = open
      .filter((t) => new Date(t.dueDate).getTime() < today.getTime() + 8 * 86400000 || t.approvalStatus !== 'APPROVED')
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .slice(0, 100)
      .map((t) => view(t, lk, today));
    res.json({
      today: P.isoDay(today), competence: P.competenceOf(today), isOwner, summary,
      byStore: Object.values(byStore).map((b) => ({ ...b, store: b.storeId ? lk.storeById.get(b.storeId) || null : null })),
      urgent,
    });
  } catch (err) { fail(res, err, 'summary'); }
});

router.get('/payables', async (req, res) => {
  try {
    const today = P.todayFortaleza();
    const where = { kind: 'PAYABLE', ...storeFilter(req.query.storeId) };
    const st = String(req.query.status || 'open');
    if (st === 'open') where.status = { in: ['OPEN', 'PARTIAL'] };
    else if (st === 'overdue') { where.status = { in: ['OPEN', 'PARTIAL'] }; where.dueDate = { lt: today }; }
    else if (st === 'pending') { where.status = { in: ['OPEN', 'PARTIAL'] }; where.approvalStatus = 'PENDING'; }
    else if (st === 'paid') where.status = 'PAID';
    else if (st === 'canceled') where.status = 'CANCELED';
    if (req.query.month) {
      const comp = P.parseCompetence(req.query.month);
      const from = P.dueDateFor(comp, 1);
      const to = P.dueDateFor(P.addMonths(comp, 1), 1);
      const prevLt = where.dueDate && where.dueDate.lt;
      where.dueDate = { gte: from, lt: prevLt && prevLt < to ? prevLt : to };
    }
    if (req.query.natureId) where.natureId = String(req.query.natureId);
    if (req.query.q) {
      const q = String(req.query.q).slice(0, 80);
      where.OR = [{ description: { contains: q, mode: 'insensitive' } }, { payee: { contains: q, mode: 'insensitive' } }, { documentNumber: { contains: q } }];
    }
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 1000);
    const [rows, lk] = await Promise.all([
      prisma.finTitle.findMany({ where, orderBy: [{ dueDate: st === 'paid' ? 'desc' : 'asc' }, { createdAt: 'asc' }], take }),
      lookups(),
    ]);
    const titles = rows.map((t) => view(t, lk, today));
    res.json({ titles, totalBalanceCents: titles.reduce((s, t) => s + t.balanceCents, 0), totalAmountCents: titles.reduce((s, t) => s + t.amountCents, 0) });
  } catch (err) { fail(res, err, 'list'); }
});

router.get('/payables/:id', async (req, res) => {
  try {
    const t = await prisma.finTitle.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Conta não encontrada' });
    const [lk, settlements, logs, accounts] = await Promise.all([
      lookups(),
      prisma.finSettlement.findMany({ where: { titleId: t.id }, orderBy: { createdAt: 'asc' } }),
      prisma.finAuditLog.findMany({ where: { entity: 'FinTitle', entityId: t.id }, orderBy: { at: 'asc' } }),
      prisma.finAccount.findMany({ select: { id: true, name: true } }),
    ]);
    const userIds = [...new Set([...logs.map((l) => l.actorId), ...settlements.map((s) => s.createdById), t.approvedById].filter(Boolean))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const nameOf = Object.fromEntries(users.map((u) => [u.id, u.name]));
    const accName = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
    res.json({
      title: { ...view(t, lk, P.todayFortaleza()), approvedByName: nameOf[t.approvedById] || null },
      settlements: settlements.map((s) => ({ ...s, accountName: accName[s.accountId] || null, createdByName: nameOf[s.createdById] || null })),
      history: logs.map((l) => ({ at: l.at, action: l.action, reason: l.reason, actorName: nameOf[l.actorId] || null })),
    });
  } catch (err) { fail(res, err, 'get'); }
});

router.post('/payables', async (req, res) => {
  try {
    const plans = P.planTitleCreate(req.body || {});
    const created = await prisma.$transaction(async (tx) => {
      await assertRefs(tx, plans[0]);
      const groupId = plans.length > 1 ? 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) : null;
      const out = [];
      for (const data of plans) {
        const t = await tx.finTitle.create({ data: { ...data, groupId, createdById: req.userId || null } });
        await audit(tx, { entity: 'FinTitle', entityId: t.id, action: 'create', after: t, req });
        out.push(t);
      }
      return out;
    });
    res.status(201).json({ titles: created });
  } catch (err) { fail(res, err, 'create'); }
});

router.patch('/payables/:id', async (req, res) => {
  try {
    const title = await prisma.$transaction(async (tx) => {
      const before = await lockTitle(tx, req.params.id);
      const data = P.validateTitleUpdate(req.body || {}, before);
      await assertRefs(tx, data);
      // Mudou valor ou vencimento depois de liberada: volta pra liberação do dono.
      const owner = await isFinOwner(prisma, req);
      if (!owner && before.approvalStatus === 'APPROVED' && (data.amountCents !== undefined && data.amountCents !== before.amountCents)) {
        data.approvalStatus = 'PENDING'; data.approvedById = null; data.approvedAt = null;
      }
      const after = await tx.finTitle.update({ where: { id: before.id }, data });
      await audit(tx, { entity: 'FinTitle', entityId: before.id, action: 'update', before, after, req });
      return after;
    });
    res.json({ title });
  } catch (err) { fail(res, err, 'update'); }
});

async function approveIds(req, ids) {
  if (!(await isFinOwner(prisma, req))) throw httpError(403, 'Somente o dono libera pagamento');
  return prisma.$transaction(async (tx) => {
    let n = 0;
    for (const id of ids) {
      const before = await lockTitle(tx, id);
      if (before.canceledAt || before.status === 'PAID' || before.approvalStatus === 'APPROVED') continue;
      const after = await tx.finTitle.update({ where: { id }, data: { approvalStatus: 'APPROVED', approvedById: req.userId, approvedAt: new Date() } });
      await audit(tx, { entity: 'FinTitle', entityId: id, action: 'approve', before, after, req });
      n++;
    }
    return n;
  });
}

router.post('/payables/:id/approve', async (req, res) => {
  try { res.json({ approved: await approveIds(req, [req.params.id]) }); } catch (err) { fail(res, err, 'approve'); }
});

router.post('/payables/approve', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
    if (!ids.length) throw new catalog.FinValidationError('Selecione as contas');
    res.json({ approved: await approveIds(req, ids) });
  } catch (err) { fail(res, err, 'approve:batch'); }
});

router.post('/payables/:id/pay', async (req, res) => {
  try {
    const owner = await isFinOwner(prisma, req);
    const result = await prisma.$transaction(async (tx) => {
      const before = await lockTitle(tx, req.params.id);
      if (before.approvalStatus !== 'APPROVED' && !owner) throw httpError(403, 'Esta conta ainda não foi liberada pelo dono');
      if (before.amountConfirmed === false) throw new catalog.FinValidationError('Confirme o valor desta conta (despesa variável) antes de pagar');
      const s = P.planSettlement(req.body || {}, before);
      if (s.accountId) {
        const acc = await tx.finAccount.findUnique({ where: { id: s.accountId } });
        if (!acc || !acc.active) throw new catalog.FinValidationError('Conta de saída inválida');
      }
      const settlement = await tx.finSettlement.create({ data: { ...s, titleId: before.id, createdById: req.userId || null } });
      const next = P.applySettlement(before, s);
      if (before.approvalStatus !== 'APPROVED') Object.assign(next, { approvalStatus: 'APPROVED', approvedById: req.userId, approvedAt: new Date() });
      const after = await tx.finTitle.update({ where: { id: before.id }, data: next });
      await audit(tx, { entity: 'FinTitle', entityId: before.id, action: 'pay', before, after: { title: after, settlement }, req });
      return { title: after, settlement };
    });
    res.json(result);
  } catch (err) { fail(res, err, 'pay'); }
});

router.post('/payables/settlements/:sid/reverse', async (req, res) => {
  try {
    const reason = catalog.validateReason(req.body?.reason);
    const result = await prisma.$transaction(async (tx) => {
      const orig = await tx.finSettlement.findUnique({ where: { id: req.params.sid } });
      if (!orig) throw httpError(404, 'Pagamento não encontrado');
      if (orig.reversalOfId) throw new catalog.FinValidationError('Isto já é um estorno');
      const before = await lockTitle(tx, orig.titleId);
      const done = await tx.finSettlement.findUnique({ where: { reversalOfId: orig.id } });
      if (done) throw new catalog.FinValidationError('Pagamento já estornado');
      const rev = await tx.finSettlement.create({
        data: {
          titleId: orig.titleId, accountId: orig.accountId, paidAt: P.todayFortaleza(), method: orig.method,
          principalCents: -orig.principalCents, discountCents: -orig.discountCents, interestCents: -orig.interestCents,
          fineCents: -orig.fineCents, totalCents: -orig.totalCents, reversalOfId: orig.id, reason, createdById: req.userId || null,
        },
      });
      await tx.finSettlement.update({ where: { id: orig.id }, data: { reversedAt: new Date() } });
      const after = await tx.finTitle.update({ where: { id: before.id }, data: P.applySettlement(before, orig, -1) });
      await audit(tx, { entity: 'FinTitle', entityId: before.id, action: 'reverse', before, after: { title: after, reversal: rev }, reason, req });
      return { title: after, reversal: rev };
    });
    res.json(result);
  } catch (err) { fail(res, err, 'reverse'); }
});

router.post('/payables/:id/cancel', async (req, res) => {
  try {
    const reason = catalog.validateReason(req.body?.reason);
    const title = await prisma.$transaction(async (tx) => {
      const before = await lockTitle(tx, req.params.id);
      if (before.canceledAt) throw new catalog.FinValidationError('Conta já cancelada');
      if (before.paidPrincipalCents !== 0 || before.discountCents !== 0) throw new catalog.FinValidationError('Conta com pagamento: estorne o pagamento antes de cancelar');
      const after = await tx.finTitle.update({ where: { id: before.id }, data: { status: 'CANCELED', canceledAt: new Date(), canceledReason: reason } });
      await audit(tx, { entity: 'FinTitle', entityId: before.id, action: 'cancel', before, after, reason, req });
      return after;
    });
    res.json({ title });
  } catch (err) { fail(res, err, 'cancel'); }
});

// ----------------------------- Despesas fixas -----------------------------

router.get('/recurring', async (req, res) => {
  try {
    const where = { ...storeFilter(req.query.storeId), ...(req.query.all === '1' ? {} : { active: true }) };
    const [rows, lk] = await Promise.all([
      prisma.finRecurring.findMany({ where, orderBy: [{ storeId: 'asc' }, { dueDay: 'asc' }, { description: 'asc' }] }),
      lookups(),
    ]);
    const recurring = rows.map((r) => ({
      ...r,
      store: r.storeId ? lk.storeById.get(r.storeId) || null : null,
      nature: lk.natureById.get(r.natureId) || null,
    }));
    const monthlyCents = rows.filter((r) => r.active).reduce((s, r) => s + Math.round(r.amountCents / (P.FREQUENCIES[r.frequency] || 1)), 0);
    res.json({ recurring, monthlyCents, missingDueDay: rows.filter((r) => r.active && !r.dueDay).length, stores: lk.stores, natures: lk.natures });
  } catch (err) { fail(res, err, 'recurring:list'); }
});

router.post('/recurring', async (req, res) => {
  try {
    const data = P.validateRecurring(req.body || {});
    const rec = await prisma.$transaction(async (tx) => {
      await assertRefs(tx, data);
      const created = await tx.finRecurring.create({ data: { ...data, createdById: req.userId || null } });
      await audit(tx, { entity: 'FinRecurring', entityId: created.id, action: 'create', after: created, req });
      return created;
    });
    const generated = await generateRecurring(currentAndNext(), req);
    res.status(201).json({ recurring: rec, generated });
  } catch (err) { fail(res, err, 'recurring:create'); }
});

// applyToOpen: atualiza também as contas desta fixa ainda sem pagamento, do mês atual em diante.
router.patch('/recurring/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const data = P.validateRecurring(body, { partial: true });
    const result = await prisma.$transaction(async (tx) => {
      const before = await tx.finRecurring.findUnique({ where: { id: req.params.id } });
      if (!before) throw httpError(404, 'Despesa fixa não encontrada');
      await assertRefs(tx, data);
      const after = await tx.finRecurring.update({ where: { id: before.id }, data });
      await audit(tx, { entity: 'FinRecurring', entityId: before.id, action: 'update', before, after, req });
      let updatedTitles = 0;
      if (body.applyToOpen) {
        const comp = P.competenceOf(P.todayFortaleza());
        const open = await tx.finTitle.findMany({ where: { recurringId: before.id, status: 'OPEN', paidPrincipalCents: 0, discountCents: 0, competence: { gte: comp } } });
        for (const t of open) {
          const upd = {};
          if (data.amountCents !== undefined) { upd.amountCents = data.amountCents; upd.amountConfirmed = !after.variableAmount; }
          if (data.description !== undefined) upd.description = data.description;
          if (data.payee !== undefined) upd.payee = data.payee;
          if (data.natureId !== undefined) upd.natureId = data.natureId;
          if (data.storeId !== undefined) upd.storeId = data.storeId;
          if (data.dueDay) upd.dueDate = P.dueDateFor(t.competence, data.dueDay);
          if (!Object.keys(upd).length) continue;
          const tAfter = await tx.finTitle.update({ where: { id: t.id }, data: upd });
          await audit(tx, { entity: 'FinTitle', entityId: t.id, action: 'update', before: t, after: tAfter, reason: 'despesa fixa alterada', req });
          updatedTitles++;
        }
      }
      return { recurring: after, updatedTitles };
    });
    const generated = await generateRecurring(currentAndNext(), req);
    res.json({ ...result, generated });
  } catch (err) { fail(res, err, 'recurring:update'); }
});

async function setRecurringActive(req, res, active) {
  try {
    const reason = catalog.validateReason(req.body?.reason);
    const rec = await prisma.$transaction(async (tx) => {
      const before = await tx.finRecurring.findUnique({ where: { id: req.params.id } });
      if (!before) throw httpError(404, 'Despesa fixa não encontrada');
      const after = await tx.finRecurring.update({ where: { id: before.id }, data: { active, inactiveReason: active ? null : reason } });
      await audit(tx, { entity: 'FinRecurring', entityId: before.id, action: active ? 'activate' : 'deactivate', before, after, reason, req });
      return after;
    });
    if (active) await generateRecurring(currentAndNext(), req);
    res.json({ recurring: rec });
  } catch (err) { fail(res, err, 'recurring:active'); }
}
router.post('/recurring/:id/deactivate', (req, res) => setRecurringActive(req, res, false));
router.post('/recurring/:id/activate', (req, res) => setRecurringActive(req, res, true));

router.post('/recurring/generate', async (req, res) => {
  try {
    const comps = req.body?.competence ? [P.parseCompetence(req.body.competence)] : currentAndNext();
    res.json({ competences: comps, generated: await generateRecurring(comps, req) });
  } catch (err) { fail(res, err, 'recurring:generate'); }
});

// Traz as despesas mensais do cadastro antigo (OperatingExpense) como despesas fixas.
// O cadastro antigo não tem dia de vencimento: entram SEM dia (não geram conta) até alguém informar.
router.post('/recurring/import-legacy', async (req, res) => {
  try {
    const dry = req.query.dry === '1' || req.body?.dry === true;
    const legacy = await prisma.operatingExpense.findMany({ where: { active: true } });
    const natures = await prisma.finNature.findMany({ select: { id: true, code: true } });
    const byCode = Object.fromEntries(natures.map((n) => [n.code, n.id]));
    const already = new Set((await prisma.finRecurring.findMany({ where: { legacyId: { in: legacy.map((l) => l.id) } }, select: { legacyId: true } })).map((r) => r.legacyId));
    const comp = P.competenceOf(P.todayFortaleza());
    const plan = legacy.filter((l) => !already.has(l.id) && Number(l.amount) > 0).map((l) => {
      const cat = String(l.category || '').toLowerCase();
      const code = P.LEGACY_CATEGORY_NATURE[cat] || '99.99';
      return {
        legacyId: l.id, storeId: l.storeId || null, natureId: byCode[code], description: l.description + (l.collaborator ? ' — ' + l.collaborator : ''),
        payee: l.collaborator || null, amountCents: Math.round(Number(l.amount) * 100), variableAmount: ['energia', 'agua'].includes(cat),
        dueDay: null, frequency: 'MONTHLY', startCompetence: comp, notes: 'Importada do cadastro antigo (categoria: ' + (l.category || '-') + ')',
      };
    }).filter((p) => p.natureId);
    const totalCents = plan.reduce((s, p) => s + p.amountCents, 0);
    if (dry) return res.json({ dry: true, toImport: plan.length, alreadyImported: already.size, totalMonthlyCents: totalCents, plan });
    const created = await prisma.$transaction(async (tx) => {
      let n = 0;
      for (const data of plan) {
        const r = await tx.finRecurring.create({ data: { ...data, createdById: req.userId || null } });
        await audit(tx, { entity: 'FinRecurring', entityId: r.id, action: 'create', after: r, reason: 'importada do cadastro antigo de despesas', req });
        n++;
      }
      return n;
    }, { timeout: 60000 });
    res.json({ imported: created, alreadyImported: already.size, totalMonthlyCents: totalCents, missingDueDay: created });
  } catch (err) { fail(res, err, 'recurring:import'); }
});

// Traz as contas a pagar do cadastro antigo (AccountPayable). Pagas entram como pagas
// (histórico); canceladas entram canceladas; abertas entram abertas, aguardando o dono liberar.
router.post('/payables/import-legacy', async (req, res) => {
  try {
    const dry = req.query.dry === '1' || req.body?.dry === true;
    const legacy = await prisma.accountPayable.findMany({ orderBy: { dueDate: 'asc' } });
    const natures = await prisma.finNature.findMany({ select: { id: true, code: true } });
    const byCode = Object.fromEntries(natures.map((n) => [n.code, n.id]));
    const already = new Set((await prisma.finTitle.findMany({ where: { legacyId: { in: legacy.map((l) => l.id) } }, select: { legacyId: true } })).map((t) => t.legacyId));
    const todo = legacy.filter((l) => !already.has(l.id) && Number(l.amount) > 0);
    const sum = (arr) => arr.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
    const byStatus = {};
    for (const l of todo) { const k = l.status || 'PENDING'; byStatus[k] = byStatus[k] || { count: 0, cents: 0 }; byStatus[k].count++; byStatus[k].cents += Math.round(Number(l.amount) * 100); }
    if (dry) return res.json({ dry: true, toImport: todo.length, alreadyImported: already.size, totalCents: sum(todo), byStatus });
    const imported = await prisma.$transaction(async (tx) => {
      let n = 0;
      for (const l of todo) {
        const cents = Math.round(Number(l.amount) * 100);
        const code = P.LEGACY_CATEGORY_NATURE[String(l.category || '').toLowerCase()] || '99.99';
        const base = {
          kind: 'PAYABLE', storeId: null, natureId: byCode[code], competence: P.competenceOf(l.dueDate), description: l.description,
          amountCents: cents, dueDate: l.dueDate, notes: [l.notes, 'Importada do cadastro antigo' + (l.category ? ' (categoria: ' + l.category + ')' : '')].filter(Boolean).join(' · '),
          legacyId: l.id, createdById: req.userId || null,
        };
        let t;
        if (l.status === 'PAID') {
          t = await tx.finTitle.create({ data: { ...base, status: 'PAID', paidPrincipalCents: cents, approvalStatus: 'APPROVED', approvedAt: l.paidDate || l.updatedAt } });
          await tx.finSettlement.create({ data: { titleId: t.id, paidAt: l.paidDate || l.updatedAt, principalCents: cents, totalCents: cents, note: 'pagamento registrado no cadastro antigo', createdById: req.userId || null } });
        } else if (l.status === 'CANCELLED') {
          t = await tx.finTitle.create({ data: { ...base, status: 'CANCELED', canceledAt: l.updatedAt, canceledReason: 'cancelada no cadastro antigo' } });
        } else {
          t = await tx.finTitle.create({ data: base });
        }
        await audit(tx, { entity: 'FinTitle', entityId: t.id, action: 'create', after: t, reason: 'importada do cadastro antigo de contas a pagar', req });
        n++;
      }
      return n;
    }, { timeout: 120000 });
    const after = await prisma.finTitle.findMany({ where: { legacyId: { in: legacy.map((l) => l.id) } }, select: { amountCents: true } });
    res.json({ imported, alreadyImported: already.size, legacyTotalCents: sum(legacy.filter((l) => Number(l.amount) > 0)), importedTotalCents: after.reduce((s, t) => s + t.amountCents, 0) });
  } catch (err) { fail(res, err, 'payables:import'); }
});

module.exports = router;
module.exports.generateRecurring = generateRecurring;
module.exports.currentAndNext = currentAndNext;
