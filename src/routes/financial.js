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

module.exports = router;
