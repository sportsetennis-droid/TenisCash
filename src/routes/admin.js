const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// ==================== DASHBOARD ====================

router.get('/dashboard', async (req, res) => {
  try {
    const totalUsers = await prisma.user.count({ where: { role: 'user' } });
    const activeUsers = await prisma.user.count({ where: { role: 'user', active: true } });

    const balanceAgg = await prisma.user.aggregate({
      where: { role: 'user' },
      _sum: { balance: true },
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTransactions = await prisma.transaction.count({
      where: { createdAt: { gte: todayStart } }
    });

    const totalTransactions = await prisma.transaction.count();

    const recentTransactions = await prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        sender: { select: { name: true } },
        receiver: { select: { name: true } },
      }
    });

    res.json({
      totalUsers,
      activeUsers,
      totalBalance: balanceAgg._sum.balance || 0,
      todayTransactions,
      totalTransactions,
      recentTransactions,
    });
  } catch (err) {
    console.error('Erro no dashboard:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== CREDITAR TENISCASH ====================

router.post('/credit', async (req, res) => {
  try {
    const { userId, phone, amount, description } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valor deve ser maior que zero' });
    }

    const creditAmount = parseFloat(amount);

    // Busca por ID ou telefone
    let user;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (phone) {
      user = await prisma.user.findUnique({ where: { phone } });
    } else {
      return res.status(400).json({ error: 'Informe userId ou phone' });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { balance: { increment: creditAmount } }
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'admin_credit',
          amount: creditAmount,
          description: description || 'Crédito administrativo',
          receiverId: user.id,
          balanceAfter: updated.balance,
        }
      });

      await tx.adminAction.create({
        data: {
          adminId: req.userId,
          action: 'credit',
          targetUserId: user.id,
          amount: creditAmount,
          description: description || 'Crédito administrativo',
        }
      });

      return { updated, transaction };
    });

    res.json({
      success: true,
      message: `T$ ${creditAmount.toFixed(2)} creditado para ${user.name}`,
      newBalance: result.updated.balance,
    });
  } catch (err) {
    console.error('Erro ao creditar:', err);
    res.status(500).json({ error: 'Erro ao creditar' });
  }
});

// ==================== DEBITAR TENISCASH ====================

router.post('/debit', async (req, res) => {
  try {
    const { userId, phone, amount, description } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Valor deve ser maior que zero' });
    }

    const debitAmount = parseFloat(amount);

    let user;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (phone) {
      user = await prisma.user.findUnique({ where: { phone } });
    } else {
      return res.status(400).json({ error: 'Informe userId ou phone' });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.balance < debitAmount) {
      return res.status(400).json({ error: `Saldo insuficiente. Saldo atual: T$ ${user.balance.toFixed(2)}` });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { balance: { decrement: debitAmount } }
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'admin_debit',
          amount: debitAmount,
          description: description || 'Débito administrativo',
          senderId: user.id,
          balanceAfter: updated.balance,
        }
      });

      await tx.adminAction.create({
        data: {
          adminId: req.userId,
          action: 'debit',
          targetUserId: user.id,
          amount: debitAmount,
          description: description || 'Débito administrativo',
        }
      });

      return { updated, transaction };
    });

    res.json({
      success: true,
      message: `T$ ${debitAmount.toFixed(2)} debitado de ${user.name}`,
      newBalance: result.updated.balance,
    });
  } catch (err) {
    console.error('Erro ao debitar:', err);
    res.status(500).json({ error: 'Erro ao debitar' });
  }
});

// ==================== REGISTRAR VENDA (gera TenisCash) ====================

router.post('/sale', async (req, res) => {
  try {
    const { userId, phone, saleAmount, description } = req.body;

    if (!saleAmount || parseFloat(saleAmount) <= 0) {
      return res.status(400).json({ error: 'Valor da venda deve ser maior que zero' });
    }

    const amount = parseFloat(saleAmount);
    const teniscashEarned = amount; // R$1 = 1 TenisCash

    let user;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (phone) {
      user = await prisma.user.findUnique({ where: { phone } });
    } else {
      return res.status(400).json({ error: 'Informe userId ou phone' });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { balance: { increment: teniscashEarned } }
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'credit',
          amount: teniscashEarned,
          description: description || `Compra R$ ${amount.toFixed(2)}`,
          receiverId: user.id,
          balanceAfter: updated.balance,
          metadata: JSON.stringify({ saleAmount: amount }),
        }
      });

      await tx.adminAction.create({
        data: {
          adminId: req.userId,
          action: 'sale',
          targetUserId: user.id,
          amount: teniscashEarned,
          description: `Venda R$ ${amount.toFixed(2)} → T$ ${teniscashEarned.toFixed(2)}`,
        }
      });

      return { updated, transaction };
    });

    res.json({
      success: true,
      message: `Venda registrada. ${user.name} ganhou T$ ${teniscashEarned.toFixed(2)}`,
      newBalance: result.updated.balance,
    });
  } catch (err) {
    console.error('Erro ao registrar venda:', err);
    res.status(500).json({ error: 'Erro ao registrar venda' });
  }
});

// ==================== USAR TENISCASH NA COMPRA ====================

router.post('/use', async (req, res) => {
  try {
    const { userId, phone, useAmount, saleAmount, brand, description } = req.body;

    if (!useAmount || parseFloat(useAmount) <= 0) {
      return res.status(400).json({ error: 'Valor de uso deve ser maior que zero' });
    }

    const tcAmount = parseFloat(useAmount);

    let user;
    if (userId) {
      user = await prisma.user.findUnique({ where: { id: userId } });
    } else if (phone) {
      user = await prisma.user.findUnique({ where: { phone } });
    } else {
      return res.status(400).json({ error: 'Informe userId ou phone' });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.balance < tcAmount) {
      return res.status(400).json({ error: `Saldo insuficiente. Saldo: T$ ${user.balance.toFixed(2)}` });
    }

    // Verifica regra da marca se informada
    if (brand) {
      const rule = await prisma.brandRule.findUnique({ where: { brand } });
      if (rule && saleAmount) {
        const maxAllowed = (parseFloat(saleAmount) * rule.maxDiscount) / 100;
        if (tcAmount > maxAllowed) {
          return res.status(400).json({
            error: `Máximo permitido para ${brand}: T$ ${maxAllowed.toFixed(2)} (${rule.maxDiscount}%)`
          });
        }
      }
    }

    // Verifica promos ativas
    let appliedPromo = null;
    const activePromos = await prisma.promo.findMany({
      where: {
        active: true,
        OR: [
          { endsAt: null },
          { endsAt: { gt: new Date() } }
        ]
      }
    });

    for (const promo of activePromos) {
      if (promo.scope === 'all' || (promo.scope === 'brand' && promo.scopeValue === brand)) {
        appliedPromo = promo;
        break;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { balance: { decrement: tcAmount } }
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'used',
          amount: tcAmount,
          description: description || `Usado na compra${brand ? ` - ${brand}` : ''}`,
          senderId: user.id,
          balanceAfter: updated.balance,
          metadata: JSON.stringify({ brand, saleAmount, promo: appliedPromo?.title }),
        }
      });

      // Se houve venda, gera TenisCash da compra também
      // Gera TC apenas sobre o valor pago em dinheiro (total - TenisCash usado)
      let earnedTx = null;
      if (saleAmount) {
        const netSale = parseFloat(saleAmount) - tcAmount; // só sobre o que pagou em dinheiro
        if (netSale > 0) {
          const updatedAgain = await tx.user.update({
            where: { id: user.id },
            data: { balance: { increment: netSale } }
          });

          earnedTx = await tx.transaction.create({
            data: {
              type: 'credit',
              amount: netSale,
              description: `Compra R$ ${parseFloat(saleAmount).toFixed(2)} (pago R$ ${netSale.toFixed(2)})`,
              receiverId: user.id,
              balanceAfter: updatedAgain.balance,
            }
          });
        }
      }

      return { updated, transaction, earnedTx };
    });

    res.json({
      success: true,
      message: `T$ ${tcAmount.toFixed(2)} usado por ${user.name}`,
      newBalance: result.updated.balance + (saleAmount ? parseFloat(saleAmount) : 0),
      promoApplied: appliedPromo?.title || null,
    });
  } catch (err) {
    console.error('Erro ao usar TenisCash:', err);
    res.status(500).json({ error: 'Erro ao processar uso' });
  }
});

// ==================== PROMOS ====================

router.post('/promos', async (req, res) => {
  try {
    const { title, description, percentage, scope, scopeValue, endsAt } = req.body;

    const promo = await prisma.promo.create({
      data: {
        title, description,
        percentage: parseFloat(percentage),
        scope: scope || 'all',
        scopeValue: scopeValue || null,
        endsAt: endsAt ? new Date(endsAt) : null,
      }
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'promo_create',
        description: `Promo criada: ${title} (${percentage}%)`,
      }
    });

    res.status(201).json({ success: true, promo });
  } catch (err) {
    console.error('Erro ao criar promo:', err);
    res.status(500).json({ error: 'Erro ao criar promoção' });
  }
});

router.put('/promos/:id', async (req, res) => {
  try {
    const { active, percentage, endsAt } = req.body;
    const promo = await prisma.promo.update({
      where: { id: req.params.id },
      data: {
        ...(active !== undefined && { active }),
        ...(percentage && { percentage: parseFloat(percentage) }),
        ...(endsAt && { endsAt: new Date(endsAt) }),
      }
    });

    res.json({ success: true, promo });
  } catch (err) {
    console.error('Erro ao atualizar promo:', err);
    res.status(500).json({ error: 'Erro ao atualizar promoção' });
  }
});

// ==================== REGRAS DE MARCA ====================

router.post('/brands', async (req, res) => {
  try {
    const { brand, maxDiscount } = req.body;
    const rule = await prisma.brandRule.upsert({
      where: { brand },
      create: { brand, maxDiscount: parseFloat(maxDiscount) },
      update: { maxDiscount: parseFloat(maxDiscount) },
    });

    res.json({ success: true, rule });
  } catch (err) {
    console.error('Erro ao configurar marca:', err);
    res.status(500).json({ error: 'Erro ao configurar regra de marca' });
  }
});

router.get('/brands', async (req, res) => {
  try {
    const rules = await prisma.brandRule.findMany({ orderBy: { brand: 'asc' } });
    res.json({ brands: rules });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== CONFIGURAÇÕES ====================

router.post('/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    const config = await prisma.config.upsert({
      where: { key },
      create: { key, value: String(value) },
      update: { value: String(value) },
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'config_update',
        description: `Config atualizada: ${key} = ${value}`,
      }
    });

    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar config' });
  }
});

// ==================== LISTAR USUÁRIOS ====================

router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const search = req.query.search || '';

    const where = search ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search } },
        { cpf: { contains: search } },
      ]
    } : {};

    const users = await prisma.user.findMany({
      where,
      select: { id: true, name: true, phone: true, balance: true, active: true, createdAt: true, role: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: (page - 1) * limit,
    });

    const total = await prisma.user.count({ where });

    res.json({ users, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ==================== LOG DE AÇÕES ADMIN ====================

router.get('/log', async (req, res) => {
  try {
    const actions = await prisma.adminAction.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { admin: { select: { name: true } } },
    });

    res.json({ actions });
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
