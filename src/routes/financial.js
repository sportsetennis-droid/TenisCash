// =====================================================================
// Routes: /api/admin/financial — Contas a Pagar e Receber
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// =====================================================================
// CONTAS A PAGAR
// =====================================================================

router.get('/payable', async (req, res) => {
  try {
    const { status, supplierId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(supplierId ? { supplierId } : {}),
    };
    const list = await prisma.accountPayable.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 200,
    });
    res.json({ accounts: list });
  } catch (err) {
    console.error('[financial/payable] erro:', err);
    res.status(500).json({ error: 'Erro ao listar contas a pagar' });
  }
});

router.post('/payable', async (req, res) => {
  try {
    const { supplierId, description, amount, dueDate, category, notes } = req.body || {};
    if (!description || !amount || !dueDate) {
      return res.status(400).json({ error: 'description, amount e dueDate são obrigatórios' });
    }
    const account = await prisma.accountPayable.create({
      data: {
        supplierId: supplierId || null,
        description,
        amount: parseFloat(amount),
        dueDate: new Date(dueDate),
        category: category || null,
        notes: notes || null,
        status: 'PENDING',
      },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar conta', detail: err.message });
  }
});

router.put('/payable/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.amount != null) data.amount = parseFloat(data.amount);
    const account = await prisma.accountPayable.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar conta', detail: err.message });
  }
});

router.post('/payable/:id/pay', async (req, res) => {
  try {
    const account = await prisma.accountPayable.update({
      where: { id: req.params.id },
      data: { status: 'PAID', paidDate: new Date() },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar como paga' });
  }
});

router.delete('/payable/:id', async (req, res) => {
  try {
    await prisma.accountPayable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

// =====================================================================
// CONTAS A RECEBER
// =====================================================================

router.get('/receivable', async (req, res) => {
  try {
    const { status, customerId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(customerId ? { customerId } : {}),
    };
    const list = await prisma.accountReceivable.findMany({
      where,
      orderBy: { dueDate: 'asc' },
      take: 200,
    });
    res.json({ accounts: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar contas a receber' });
  }
});

router.post('/receivable', async (req, res) => {
  try {
    const { customerId, saleId, description, amount, dueDate, category, notes } = req.body || {};
    if (!description || !amount || !dueDate) {
      return res.status(400).json({ error: 'description, amount e dueDate são obrigatórios' });
    }
    const account = await prisma.accountReceivable.create({
      data: {
        customerId: customerId || null,
        saleId: saleId || null,
        description,
        amount: parseFloat(amount),
        dueDate: new Date(dueDate),
        category: category || null,
        notes: notes || null,
        status: 'PENDING',
      },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar conta', detail: err.message });
  }
});

router.put('/receivable/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    if (data.amount != null) data.amount = parseFloat(data.amount);
    const account = await prisma.accountReceivable.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar conta', detail: err.message });
  }
});

router.post('/receivable/:id/receive', async (req, res) => {
  try {
    const account = await prisma.accountReceivable.update({
      where: { id: req.params.id },
      data: { status: 'PAID', receivedDate: new Date() },
    });
    res.json({ account });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao marcar como recebida' });
  }
});

router.delete('/receivable/:id', async (req, res) => {
  try {
    await prisma.accountReceivable.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover' });
  }
});

// =====================================================================
// DASHBOARD FINANCEIRO
// =====================================================================

router.get('/dashboard', async (_req, res) => {
  try {
    const today = new Date();
    const in7 = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000);

    const [payablePending, payableOverdue, payableDueSoon, payableNext30, receivablePending, receivableOverdue] = await Promise.all([
      prisma.accountPayable.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      prisma.accountPayable.findMany({ where: { status: 'PENDING', dueDate: { lt: today } } }),
      prisma.accountPayable.findMany({ where: { status: 'PENDING', dueDate: { gte: today, lte: in7 } } }),
      prisma.accountPayable.aggregate({ where: { status: 'PENDING', dueDate: { lte: in30 } }, _sum: { amount: true } }),
      prisma.accountReceivable.aggregate({ where: { status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      prisma.accountReceivable.findMany({ where: { status: 'PENDING', dueDate: { lt: today } } }),
    ]);

    res.json({
      payable: {
        totalPending: payablePending._sum.amount || 0,
        countPending: payablePending._count || 0,
        overdueCount: payableOverdue.length,
        overdueTotal: payableOverdue.reduce((s, x) => s + x.amount, 0),
        dueSoonCount: payableDueSoon.length,
        next30: payableNext30._sum.amount || 0,
      },
      receivable: {
        totalPending: receivablePending._sum.amount || 0,
        countPending: receivablePending._count || 0,
        overdueCount: receivableOverdue.length,
        overdueTotal: receivableOverdue.reduce((s, x) => s + x.amount, 0),
      },
    });
  } catch (err) {
    console.error('[financial/dashboard] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar dashboard' });
  }
});

// =====================================================================
// DESPESAS OPERACIONAIS (folha + fixas) + RAIO-X DO DIA (lucro/prejuízo)
// Valores são SEMPRE cadastrados pelo dono — nunca inventados.
// =====================================================================

// Lista despesas (ativas; ?all=1 inclui inativas) + lojas pra o select
router.get('/expenses', async (req, res) => {
  try {
    const where = req.query.all === '1' ? {} : { active: true };
    const [expenses, stores] = await Promise.all([
      prisma.operatingExpense.findMany({ where, orderBy: [{ category: 'asc' }, { description: 'asc' }] }),
      prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    ]);
    const sm = Object.fromEntries(stores.map((s) => [s.id, s]));
    res.json({
      expenses: expenses.map((e) => ({ ...e, storeName: e.storeId ? (sm[e.storeId] && sm[e.storeId].name) || null : null })),
      stores,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/expenses', async (req, res) => {
  try {
    const { category, description, amount, storeId, collaborator } = req.body || {};
    if (!category || !description || amount == null) return res.status(400).json({ error: 'Informe categoria, descrição e valor mensal' });
    const amt = Number(amount);
    if (!(amt >= 0)) return res.status(400).json({ error: 'Valor mensal inválido' });
    const expense = await prisma.operatingExpense.create({
      data: {
        category: String(category), description: String(description).trim(), amount: amt,
        storeId: storeId || null, collaborator: collaborator ? String(collaborator).trim() : null,
      },
    });
    res.json({ ok: true, expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/expenses/:id', async (req, res) => {
  try {
    const { category, description, amount, storeId, collaborator, active } = req.body || {};
    const data = {};
    if (category != null) data.category = String(category);
    if (description != null) data.description = String(description).trim();
    if (amount != null) data.amount = Number(amount);
    if (storeId !== undefined) data.storeId = storeId || null;
    if (collaborator !== undefined) data.collaborator = collaborator ? String(collaborator).trim() : null;
    if (active != null) data.active = !!active;
    const expense = await prisma.operatingExpense.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, expense });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/expenses/:id', async (req, res) => {
  try {
    await prisma.operatingExpense.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// RAIO-X DO DIA: receita − CMV − folha/dia − despesas fixas/dia = lucro/prejuízo (por loja + total)
router.get('/daily-xray', async (req, res) => {
  try {
    const q = String(req.query.date || '').trim();
    const base = /^\d{4}-\d{2}-\d{2}$/.test(q) ? new Date(q + 'T12:00:00Z') : new Date();
    const fort = new Date(base.getTime() - 3 * 3600 * 1000); // João Pessoa = UTC-3
    const y = fort.getUTCFullYear(), m = fort.getUTCMonth(), d = fort.getUTCDate();
    const dayStart = new Date(Date.UTC(y, m, d, 3, 0, 0));       // 00:00 Fortaleza em UTC
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

    const stores = await prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } });

    const sales = await prisma.sale.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd }, status: { not: 'canceled' } },
      select: { id: true, storeId: true, totalAmount: true },
    });
    const saleStore = {}; sales.forEach((s) => { saleStore[s.id] = s.storeId || '__none__'; });

    let items = [];
    if (sales.length) {
      items = await prisma.saleItem.findMany({
        where: { saleId: { in: sales.map((s) => s.id) } },
        select: { saleId: true, quantity: true, totalPrice: true, product: { select: { costPrice: true } } },
      });
    }

    const per = {};
    const bucket = (sid) => (per[sid] = per[sid] || { revenue: 0, cogs: 0, cogsKnownValue: 0, itemsValue: 0 });
    sales.forEach((s) => { bucket(s.storeId || '__none__').revenue += s.totalAmount || 0; });
    items.forEach((it) => {
      const b = bucket(saleStore[it.saleId] || '__none__');
      b.itemsValue += it.totalPrice || 0;
      const cost = it.product && it.product.costPrice;
      if (cost && cost > 0) { b.cogs += cost * (it.quantity || 1); b.cogsKnownValue += it.totalPrice || 0; }
    });

    const expenses = await prisma.operatingExpense.findMany({ where: { active: true } });
    const expStore = {}; let cwFolha = 0, cwFixas = 0;
    const perDay = (a) => (a || 0) / daysInMonth;
    expenses.forEach((e) => {
      const dc = perDay(e.amount); const folha = e.category === 'folha';
      if (e.storeId) { const b = (expStore[e.storeId] = expStore[e.storeId] || { folha: 0, fixas: 0 }); if (folha) b.folha += dc; else b.fixas += dc; }
      else { if (folha) cwFolha += dc; else cwFixas += dc; }
    });

    const storesOut = stores.map((s) => {
      const b = per[s.id] || { revenue: 0, cogs: 0, cogsKnownValue: 0, itemsValue: 0 };
      const ex = expStore[s.id] || { folha: 0, fixas: 0 };
      return {
        storeId: s.id, code: s.code, name: s.name,
        revenue: b.revenue, cogs: b.cogs,
        cogsCoverage: b.itemsValue > 0 ? b.cogsKnownValue / b.itemsValue : null,
        laborDay: ex.folha, fixedDay: ex.fixas,
        result: b.revenue - b.cogs - ex.folha - ex.fixas,
      };
    });
    const none = per['__none__'];
    if (none && none.revenue > 0) {
      storesOut.push({ storeId: null, code: '—', name: 'Sem loja definida', revenue: none.revenue, cogs: none.cogs, cogsCoverage: none.itemsValue > 0 ? none.cogsKnownValue / none.itemsValue : null, laborDay: 0, fixedDay: 0, result: none.revenue - none.cogs });
    }

    const sum = (f) => Object.values(per).reduce((a, b) => a + f(b), 0);
    const tRevenue = sum((b) => b.revenue), tCogs = sum((b) => b.cogs), tItems = sum((b) => b.itemsValue), tKnown = sum((b) => b.cogsKnownValue);
    const tLabor = Object.values(expStore).reduce((a, b) => a + b.folha, 0) + cwFolha;
    const tFixed = Object.values(expStore).reduce((a, b) => a + b.fixas, 0) + cwFixas;

    res.json({
      date: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      daysInMonth, salesCount: sales.length,
      company: {
        revenue: tRevenue, cogs: tCogs, cogsCoverage: tItems > 0 ? tKnown / tItems : null,
        laborDay: tLabor, fixedDay: tFixed, companyWideLaborDay: cwFolha, companyWideFixedDay: cwFixas,
        result: tRevenue - tCogs - tLabor - tFixed,
      },
      stores: storesOut,
      hasExpenses: expenses.length > 0,
    });
  } catch (err) { console.error('[financial/daily-xray]', err); res.status(500).json({ error: err.message }); }
});

module.exports = router;
