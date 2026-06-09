const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
// /api/admin/fiscal tem guard PROPRIO (caixa store/seller pode emitir/imprimir cupom) —
// nao aplica o adminMiddleware blanket aqui; deixa cair pro mount /api/admin/fiscal.
router.use((req, res, next) => {
  if (req.path === '/fiscal' || req.path.startsWith('/fiscal/')) return next();
  return adminMiddleware(req, res, next);
});

function recifeDayBoundsFromDate(dateYYYYMMDD) {
  const [yStr, mStr, dStr] = String(dateYYYYMMDD || '').split('-');
  const y = parseInt(yStr, 10);
  const m1 = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (!y || !m1 || !d) return null;
  const offsetMin = -180;
  const startLocalUtc = new Date(Date.UTC(y, m1 - 1, d, 0, 0, 0, 0));
  const startUtc = new Date(startLocalUtc.getTime() - offsetMin * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}

function recifeMonthBounds(periodYYYYMM) {
  const [yStr, mStr] = String(periodYYYYMM || '').split('-');
  const y = parseInt(yStr, 10);
  const m1 = parseInt(mStr, 10);
  if (!y || !m1 || m1 < 1 || m1 > 12) return null;
  const offsetMin = -180;
  const startLocalUtc = new Date(Date.UTC(y, m1 - 1, 1, 0, 0, 0, 0));
  const startUtc = new Date(startLocalUtc.getTime() - offsetMin * 60 * 1000);
  const endLocalUtc = new Date(Date.UTC(y, m1, 1, 0, 0, 0, 0));
  const endUtc = new Date(endLocalUtc.getTime() - offsetMin * 60 * 1000);
  return { startUtc, endUtc };
}

function minutesBetween(a, b) {
  return Math.max(0, (b - a) / 60000);
}

function summarizeDayPoints(points, now = null) {
  const items = (points || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const entry = items.find(x => x.type === 'entry');
  const exit = items.find(x => x.type === 'exit');
  const effectiveEnd = exit ? new Date(exit.timestamp) : (now || null);

  let breakMinutes = 0;
  let lastBreakStart = null;
  for (const it of items) {
    if (it.type === 'break_start') lastBreakStart = new Date(it.timestamp);
    if (it.type === 'break_end' && lastBreakStart) {
      breakMinutes += minutesBetween(lastBreakStart, new Date(it.timestamp));
      lastBreakStart = null;
    }
  }
  if (lastBreakStart && effectiveEnd) breakMinutes += minutesBetween(lastBreakStart, effectiveEnd);

  let workedMinutes = 0;
  if (entry && effectiveEnd) workedMinutes = Math.max(0, minutesBetween(new Date(entry.timestamp), effectiveEnd) - breakMinutes);

  return {
    hasEntry: !!entry,
    hasExit: !!exit,
    entryAt: entry ? entry.timestamp : null,
    exitAt: exit ? exit.timestamp : null,
    breakMinutes: Math.round(breakMinutes),
    workedMinutes: Math.round(workedMinutes),
  };
}

function localRecifeDateKey(ts) {
  const offsetMin = -180;
  const local = new Date(new Date(ts).getTime() + offsetMin * 60000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
}

// ==================== DASHBOARD ====================

// ==================== BUSCA GENÉRICA DE USUÁRIOS (admin) ====================
//
// Substitui /api/sellers/search quando o admin precisa buscar QUALQUER usuário
// (cliente, vendedor, parceiro, admin) — por exemplo na tela de criar parceiro.
// Marca isPartner=true para os que já têm registro ativo em Partner, para o
// frontend desabilitar a seleção.
router.get('/users/search', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.length < 2 && digits.length < 2) {
      return res.json({ users: [] });
    }

    const or = [];
    if (raw.length >= 2) {
      or.push({ name: { contains: raw, mode: 'insensitive' } });
      or.push({ email: { contains: raw, mode: 'insensitive' } });
    }
    if (digits.length >= 2) {
      or.push({ phone: { contains: digits } });
      or.push({ cpf: { contains: digits } });
    }

    const users = await prisma.user.findMany({
      where: {
        active: true,
        OR: or,
      },
      take: 20,
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        cpf: true,
        role: true,
        partner: { select: { id: true, status: true, couponCode: true } },
      },
    });

    const result = users.map((u) => ({
      id: u.id,
      name: u.name,
      phone: u.phone,
      email: u.email,
      cpf: u.cpf,
      role: u.role,
      isPartner: !!(u.partner && u.partner.status === 'active'),
      partnerCoupon: u.partner ? u.partner.couponCode : null,
    }));

    res.json({ users: result });
  } catch (err) {
    console.error('Erro admin/users/search:', err);
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

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

    // dispara mensagem do bot "TenisCash" + push pro cliente (best-effort)
    try {
      const sysMsg = require('../services/systemMessenger');
      sysMsg.notifyCashbackEarned(user.id, teniscashEarned, result.transaction.id).catch(() => {});
    } catch (e) { /* ignora */ }

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

router.get('/config/:key', async (req, res) => {
  try {
    const row = await prisma.config.findUnique({ where: { key: req.params.key } });
    res.json({ key: req.params.key, value: row ? row.value : null });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao ler config' });
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

// ==================== VINCULAR VENDEDOR À LOJA ====================
// Define role=seller e storeId do usuário
router.post('/seller/assign-store', async (req, res) => {
  try {
    const { userId, phone, employeeCode, storeCode, storeId } = req.body || {};

    if (!userId && !phone && !employeeCode) {
      return res.status(400).json({ error: 'Informe userId, phone ou employeeCode' });
    }
    if (!storeId && !storeCode) {
      return res.status(400).json({ error: 'Informe storeId ou storeCode' });
    }

    const user = await prisma.user.findFirst({
      where: {
        ...(userId ? { id: userId } : {}),
        ...(phone ? { phone: String(phone).replace(/\D/g, '') } : {}),
        ...(employeeCode ? { employeeCode } : {}),
      },
      select: { id: true, name: true, role: true, storeId: true, active: true },
    });

    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const store = await prisma.store.findFirst({
      where: {
        ...(storeId ? { id: storeId } : {}),
        ...(storeCode ? { code: storeCode } : {}),
      },
      select: { id: true, code: true, name: true },
    });

    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: 'seller', storeId: store.id },
      select: { id: true, name: true, role: true, storeId: true },
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'seller_assign_store',
        targetUserId: user.id,
        description: `Vinculou vendedor à loja ${store.code} (${store.name})`,
        metadata: JSON.stringify({ storeId: store.id, storeCode: store.code }),
      }
    });

    res.json({
      success: true,
      message: `Vendedor vinculado: ${updated.name} → ${store.code} (${store.name})`,
      user: updated,
      store,
    });
  } catch (err) {
    console.error('Erro ao vincular vendedor:', err);
    res.status(500).json({ error: 'Erro ao vincular vendedor' });
  }
});

// ==================== LISTAR VENDEDORES ====================
router.get('/sellers', async (req, res) => {
  try {
    const sellers = await prisma.user.findMany({
      where: { role: 'seller', active: true },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        phone: true,
        employeeCode: true,
        hireDate: true,
        storeId: true,
        store: { select: { id: true, code: true, name: true } },
        createdAt: true,
      },
    });

    res.json({ sellers });
  } catch (err) {
    console.error('Erro ao listar vendedores:', err);
    res.status(500).json({ error: 'Erro ao listar vendedores' });
  }
});

// ==================== REMOVER VENDEDOR (volta pra user) ====================
router.post('/seller/remove', async (req, res) => {
  try {
    const { userId, phone, employeeCode } = req.body || {};
    if (!userId && !phone && !employeeCode) {
      return res.status(400).json({ error: 'Informe userId, phone ou employeeCode' });
    }

    const user = await prisma.user.findFirst({
      where: {
        ...(userId ? { id: userId } : {}),
        ...(phone ? { phone: String(phone).replace(/\D/g, '') } : {}),
        ...(employeeCode ? { employeeCode } : {}),
        role: 'seller',
      },
      select: { id: true, name: true, storeId: true, employeeCode: true },
    });

    if (!user) return res.status(404).json({ error: 'Vendedor não encontrado' });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        role: 'user',
        storeId: null,
        hireDate: null,
        baseSalary: null,
        employeeCode: null,
      },
      select: { id: true, name: true, role: true },
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'seller_remove',
        targetUserId: user.id,
        description: `Removeu vendedor (voltou para user): ${user.name}`,
        metadata: JSON.stringify({ previousStoreId: user.storeId, employeeCode: user.employeeCode }),
      }
    });

    res.json({ success: true, message: `Vendedor removido: ${updated.name}`, user: updated });
  } catch (err) {
    console.error('Erro ao remover vendedor:', err);
    res.status(500).json({ error: 'Erro ao remover vendedor' });
  }
});

// ==================== GERENTE (acesso a TODAS as lojas) ====================
// role='manager' equivale a admin nas checagens de acesso, mas storeId fica null
// (gerente nao trava em loja unica — opera em todas)

// Promover usuario a gerente (busca por userId, phone ou employeeCode)
router.post('/manager/promote', async (req, res) => {
  try {
    const { userId, phone, employeeCode } = req.body || {};
    if (!userId && !phone && !employeeCode) {
      return res.status(400).json({ error: 'Informe userId, phone ou employeeCode' });
    }

    const user = await prisma.user.findFirst({
      where: {
        ...(userId ? { id: userId } : {}),
        ...(phone ? { phone: String(phone).replace(/\D/g, '') } : {}),
        ...(employeeCode ? { employeeCode } : {}),
      },
      select: { id: true, name: true, phone: true, role: true, storeId: true, active: true },
    });

    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.role === 'superadmin') return res.status(400).json({ error: 'Superadmin nao pode virar gerente' });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: 'manager', storeId: null }, // gerente vê TODAS as lojas
      select: { id: true, name: true, role: true, phone: true },
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'manager_promote',
        targetUserId: user.id,
        description: `Promoveu a gerente (acesso a todas as lojas): ${user.name}`,
        metadata: JSON.stringify({ previousRole: user.role, previousStoreId: user.storeId }),
      }
    });

    res.json({
      success: true,
      message: `${updated.name} agora é gerente com acesso a todas as lojas`,
      user: updated,
    });
  } catch (err) {
    console.error('Erro ao promover gerente:', err);
    res.status(500).json({ error: 'Erro ao promover gerente' });
  }
});

// Remover gerente (volta pra user)
router.post('/manager/remove', async (req, res) => {
  try {
    const { userId, phone, employeeCode } = req.body || {};
    if (!userId && !phone && !employeeCode) {
      return res.status(400).json({ error: 'Informe userId, phone ou employeeCode' });
    }

    const user = await prisma.user.findFirst({
      where: {
        ...(userId ? { id: userId } : {}),
        ...(phone ? { phone: String(phone).replace(/\D/g, '') } : {}),
        ...(employeeCode ? { employeeCode } : {}),
        role: 'manager',
      },
      select: { id: true, name: true },
    });

    if (!user) return res.status(404).json({ error: 'Gerente não encontrado' });

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role: 'user' },
      select: { id: true, name: true, role: true },
    });

    await prisma.adminAction.create({
      data: {
        adminId: req.userId,
        action: 'manager_remove',
        targetUserId: user.id,
        description: `Removeu gerente (voltou para user): ${user.name}`,
      }
    });

    res.json({ success: true, message: `Gerente removido: ${updated.name}`, user: updated });
  } catch (err) {
    console.error('Erro ao remover gerente:', err);
    res.status(500).json({ error: 'Erro ao remover gerente' });
  }
});

// Listar gerentes ativos
router.get('/managers', async (req, res) => {
  try {
    const managers = await prisma.user.findMany({
      where: { role: 'manager', active: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        phone: true,
        employeeCode: true,
        createdAt: true,
      },
    });
    res.json({ managers, total: managers.length });
  } catch (err) {
    console.error('Erro ao listar gerentes:', err);
    res.status(500).json({ error: 'Erro ao listar gerentes' });
  }
});

// ==================== PONTO DIGITAL (ADMIN) ====================
router.get('/clockin/summary', async (req, res) => {
  try {
    const { period, date } = req.query;
    const bounds = date ? recifeDayBoundsFromDate(date) : recifeMonthBounds(period);
    if (!bounds) return res.status(400).json({ error: 'Informe date=YYYY-MM-DD ou period=YYYY-MM' });

    const sellers = await prisma.user.findMany({
      where: { role: 'seller', active: true },
      select: { id: true, name: true, phone: true, employeeCode: true, store: { select: { code: true, name: true } } },
      orderBy: { name: 'asc' },
    });
    const sellerIds = sellers.map(s => s.id);

    const clockins = await prisma.clockIn.findMany({
      where: { userId: { in: sellerIds }, timestamp: { gte: bounds.startUtc, lt: bounds.endUtc } },
      select: { userId: true, type: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    const byUserByDay = new Map(); // userId -> Map(dayKey -> points[])
    for (const c of clockins) {
      const dayKey = localRecifeDateKey(c.timestamp);
      if (!byUserByDay.has(c.userId)) byUserByDay.set(c.userId, new Map());
      const m = byUserByDay.get(c.userId);
      if (!m.has(dayKey)) m.set(dayKey, []);
      m.get(dayKey).push(c);
    }

    // Regra simples: esperado entrada até 09:10 (Recife)
    const expectedHour = 9;
    const expectedMin = 10;
    const overtimeThresholdMin = 8 * 60;

    const rows = sellers.map(s => {
      const daysMap = byUserByDay.get(s.id) || new Map();
      let totalMinutes = 0;
      let daysWorked = 0;
      let lateCount = 0;
      let overtimeMinutes = 0;

      for (const [day, pts] of daysMap.entries()) {
        const sum = summarizeDayPoints(pts, null);
        if (sum.hasEntry) {
          daysWorked += 1;
          totalMinutes += sum.workedMinutes;
          if (sum.workedMinutes > overtimeThresholdMin) overtimeMinutes += (sum.workedMinutes - overtimeThresholdMin);

          if (sum.entryAt) {
            const offsetMin = -180;
            const local = new Date(new Date(sum.entryAt).getTime() + offsetMin * 60000);
            const h = local.getUTCHours();
            const m = local.getUTCMinutes();
            if (h > expectedHour || (h === expectedHour && m > expectedMin)) lateCount += 1;
          }
        }
      }

      return {
        userId: s.id,
        name: s.name,
        phone: s.phone,
        employeeCode: s.employeeCode,
        store: s.store || null,
        totalMinutes,
        daysWorked,
        lateCount,
        overtimeMinutes: Math.max(0, Math.round(overtimeMinutes)),
      };
    });

    res.json({ period: period || null, date: date || null, sellers: rows });
  } catch (err) {
    console.error('Erro clockin summary:', err);
    res.status(500).json({ error: 'Erro ao gerar resumo' });
  }
});

router.get('/clockin/seller/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { period } = req.query;
    const bounds = recifeMonthBounds(period);
    if (!bounds) return res.status(400).json({ error: 'Informe period=YYYY-MM' });

    const seller = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, employeeCode: true, store: { select: { code: true, name: true } } },
    });
    if (!seller) return res.status(404).json({ error: 'Vendedor não encontrado' });

    const points = await prisma.clockIn.findMany({
      where: { userId, timestamp: { gte: bounds.startUtc, lt: bounds.endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true, latitude: true, longitude: true, store: { select: { code: true, name: true } } },
    });

    const offsetMin = -180;
    const byDay = new Map();
    for (const p of points) {
      const local = new Date(new Date(p.timestamp).getTime() + offsetMin * 60000);
      const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(p);
    }

    const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, pts]) => {
      const sum = summarizeDayPoints(pts, null);
      return {
        date,
        summary: sum,
        points: pts.map(x => ({ id: x.id, type: x.type, timestamp: x.timestamp, latitude: x.latitude, longitude: x.longitude, store: x.store })),
      };
    });

    res.json({ period, seller, days });
  } catch (err) {
    console.error('Erro clockin seller:', err);
    res.status(500).json({ error: 'Erro ao buscar detalhamento' });
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

// ==================== MENSAGENS (MÓDULO 1) ====================

function isValidMessageType(type) {
  return ['message', 'demand', 'announcement', 'request'].includes(type);
}

function isValidDemandPriority(p) {
  return ['low', 'normal', 'high', 'urgent'].includes(p);
}

function parseDueDate(v) {
  if (!v) return null;
  const d = new Date(v);
  // eslint-disable-next-line no-restricted-globals
  if (isNaN(d.getTime())) return null;
  return d;
}

router.get('/messages', async (req, res) => {
  try {
    const { type, status, priority, fromId, toId, toStoreId } = req.query || {};
    const where = {
      ...(type && isValidMessageType(type) ? { type } : {}),
      ...(status ? { status: String(status) } : {}),
      ...(priority ? { priority: String(priority) } : {}),
      ...(fromId ? { fromId: String(fromId) } : {}),
      ...(toId ? { toId: String(toId) } : {}),
      ...(toStoreId ? { toStoreId: String(toStoreId) } : {}),
    };

    const messages = await prisma.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        priority: true,
        dueDate: true,
        status: true,
        readAt: true,
        doneAt: true,
        repliedAt: true,
        replyContent: true,
        createdAt: true,
        from: { select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } } },
        to: { select: { id: true, name: true, role: true, store: { select: { code: true, name: true } } } },
        toStore: { select: { id: true, code: true, name: true } },
        toAll: true,
      },
    });

    res.json({ messages });
  } catch (err) {
    console.error('Erro admin/messages:', err);
    res.status(500).json({ error: 'Erro ao listar mensagens' });
  }
});

router.get('/messages/pending', async (req, res) => {
  try {
    const now = new Date();
    const pendingDemands = await prisma.message.findMany({
      where: { type: 'demand', NOT: { status: 'done' } },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 500,
      select: {
        id: true,
        title: true,
        content: true,
        priority: true,
        dueDate: true,
        status: true,
        createdAt: true,
        from: { select: { id: true, name: true, store: { select: { code: true } } } },
        to: { select: { id: true, name: true, store: { select: { code: true } } } },
      },
    });

    const pendingAnnouncements = await prisma.message.findMany({
      where: { type: 'announcement', NOT: { status: 'confirmed' } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        createdAt: true,
        from: { select: { id: true, name: true } },
        to: { select: { id: true, name: true, store: { select: { code: true } } } },
      },
    });

    const pendingRequests = await prisma.message.findMany({
      where: { type: 'request', status: { in: ['sent', 'read'] } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        id: true,
        title: true,
        content: true,
        status: true,
        createdAt: true,
        from: { select: { id: true, name: true, store: { select: { code: true } } } },
      },
    });

    const demands = pendingDemands.map((d) => ({
      ...d,
      overdue: d.dueDate ? new Date(d.dueDate).getTime() < now.getTime() : false,
    }));

    res.json({ demands, announcements: pendingAnnouncements, requests: pendingRequests });
  } catch (err) {
    console.error('Erro admin/messages/pending:', err);
    res.status(500).json({ error: 'Erro ao listar pendências' });
  }
});

router.post('/messages', async (req, res) => {
  try {
    const { toId, toStoreId, toAll, type, title, content, priority, dueDate } = req.body || {};
    const t = String(type || '').trim();
    if (!isValidMessageType(t)) return res.status(400).json({ error: 'Tipo inválido' });

    const c = String(content || '').trim();
    if (!c) return res.status(400).json({ error: 'Conteúdo é obrigatório' });

    const ttl = title ? String(title).trim().slice(0, 120) : null;
    const pr = priority ? String(priority).trim() : null;
    const dd = parseDueDate(dueDate);

    if ((toId ? 1 : 0) + (toStoreId ? 1 : 0) + (toAll ? 1 : 0) !== 1) {
      return res.status(400).json({ error: 'Informe exatamente um destino: toId, toStoreId ou toAll' });
    }

    // validações
    if (t === 'demand') {
      if (!ttl) return res.status(400).json({ error: 'Título é obrigatório para demanda' });
      if (!dd) return res.status(400).json({ error: 'dueDate é obrigatório e deve ser válido' });
      if (pr && !isValidDemandPriority(pr)) return res.status(400).json({ error: 'priority inválido (low/normal/high/urgent)' });
    }
    if (t === 'announcement' || t === 'request') {
      if (!ttl) return res.status(400).json({ error: 'Título é obrigatório' });
    }

    // destinatários (fan-out)
    let recipients = [];
    if (toId) {
      const u = await prisma.user.findUnique({ where: { id: String(toId) }, select: { id: true, active: true } });
      if (!u || !u.active) return res.status(404).json({ error: 'Destinatário não encontrado' });
      recipients = [u.id];
    } else if (toStoreId) {
      const store = await prisma.store.findUnique({ where: { id: String(toStoreId) }, select: { id: true } });
      if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
      const sellers = await prisma.user.findMany({
        where: { active: true, role: 'seller', storeId: store.id },
        select: { id: true },
      });
      recipients = sellers.map(s => s.id);
      if (!recipients.length) return res.status(400).json({ error: 'Nenhum vendedor ativo nesta loja' });
    } else if (toAll) {
      const sellers = await prisma.user.findMany({
        where: { active: true, role: 'seller', storeId: { not: null } },
        select: { id: true, storeId: true },
      });
      recipients = sellers.map(s => s.id);
      if (!recipients.length) return res.status(400).json({ error: 'Nenhum vendedor ativo encontrado' });
    }

    const created = await prisma.$transaction(async (tx) => {
      const rows = [];
      for (const rid of recipients) {
        rows.push(await tx.message.create({
          data: {
            fromId: req.userId,
            toId: rid,
            toStoreId: toStoreId ? String(toStoreId) : null,
            toAll: !!toAll,
            type: t,
            title: ttl,
            content: c.slice(0, 2000),
            priority: t === 'demand' ? (pr || 'normal') : null,
            dueDate: t === 'demand' ? dd : null,
            status: 'sent',
          },
        }));
      }
      return rows;
    });

    res.json({ success: true, createdCount: created.length });
  } catch (err) {
    console.error('Erro admin/messages create:', err);
    res.status(500).json({ error: 'Erro ao criar mensagem' });
  }
});

router.put('/messages/:id/reply', async (req, res) => {
  try {
    const id = String(req.params.id);
    const { replyContent, status } = req.body || {};
    const reply = String(replyContent || '').trim();
    if (!reply) return res.status(400).json({ error: 'replyContent é obrigatório' });
    const st = String(status || '').trim();
    if (!['approved', 'rejected'].includes(st)) return res.status(400).json({ error: 'status inválido (approved|rejected)' });

    const msg = await prisma.message.findUnique({
      where: { id },
      select: { id: true, type: true, fromId: true },
    });
    if (!msg) return res.status(404).json({ error: 'Solicitação não encontrada' });
    if (msg.type !== 'request') return res.status(400).json({ error: 'Apenas solicitações (request) podem receber reply' });

    const updated = await prisma.message.update({
      where: { id },
      data: {
        status: st,
        replyContent: reply.slice(0, 2000),
        repliedAt: new Date(),
      },
      select: { id: true, status: true, repliedAt: true },
    });

    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Erro admin/messages reply:', err);
    res.status(500).json({ error: 'Erro ao responder solicitação' });
  }
});

function startOfMonthBrazil() {
  const offsetMin = -180;
  const now = new Date();
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const startLocalAsUtc = Date.UTC(y, m, 1, 0, 0, 0, 0);
  return new Date(startLocalAsUtc - offsetMin * 60000);
}

router.get('/ai/stats', async (req, res) => {
  try {
    const monthStart = startOfMonthBrazil();
    const [agg, byType, last30] = await Promise.all([
      prisma.aIConversation.aggregate({
        where: { createdAt: { gte: monthStart }, active: true },
        _sum: { totalCostBRL: true, totalTokensIn: true, totalTokensOut: true },
        _count: true,
      }),
      prisma.aIConversation.groupBy({
        by: ['userType'],
        where: { createdAt: { gte: monthStart }, active: true },
        _sum: { totalCostBRL: true },
        _count: { _all: true },
      }),
      prisma.aIConversation.count({
        where: {
          active: true,
          updatedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const monthCost = agg._sum.totalCostBRL || 0;
    res.json({
      monthCostBRL: monthCost,
      monthTokensIn: agg._sum.totalTokensIn || 0,
      monthTokensOut: agg._sum.totalTokensOut || 0,
      conversationsThisMonth: agg._count?._all ?? 0,
      conversationsLast30Days: last30,
      byUserType: byType,
      alertOverBudget: monthCost > 200,
    });
  } catch (err) {
    console.error('Erro admin/ai/stats:', err);
    res.status(500).json({ error: 'Erro ao gerar estatísticas de IA' });
  }
});

router.get('/ai/conversations', async (req, res) => {
  try {
    const userType = String(req.query.userType || '').trim();
    const where = {
      active: true,
      ...(userType ? { userType } : {}),
    };
    const conversations = await prisma.aIConversation.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 300,
      include: {
        user: { select: { id: true, name: true, role: true, phone: true } },
      },
    });
    res.json({ conversations });
  } catch (err) {
    console.error('Erro admin/ai/conversations:', err);
    res.status(500).json({ error: 'Erro ao listar conversas de IA' });
  }
});

router.get('/ai/conversations/:id', async (req, res) => {
  try {
    const c = await prisma.aIConversation.findFirst({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, role: true, phone: true } } },
    });
    if (!c) return res.status(404).json({ error: 'Conversa não encontrada' });
    res.json({ conversation: c });
  } catch (err) {
    console.error('Erro admin/ai/conversations/:id:', err);
    res.status(500).json({ error: 'Erro ao carregar conversa' });
  }
});

router.get('/messages/stats', async (req, res) => {
  try {
    const now = new Date();
    const demands = await prisma.message.findMany({
      where: { type: 'demand', NOT: { status: 'done' } },
      select: { id: true, dueDate: true, priority: true },
      take: 2000,
    });
    const overdueDemands = demands.filter(d => d.dueDate && new Date(d.dueDate).getTime() < now.getTime()).length;

    const unconfirmedAnnouncements = await prisma.message.count({
      where: { type: 'announcement', NOT: { status: 'confirmed' } },
    });

    const pendingRequests = await prisma.message.count({
      where: { type: 'request', status: { in: ['sent', 'read'] } },
    });

    res.json({
      overdueDemands,
      unconfirmedAnnouncements,
      pendingRequests,
    });
  } catch (err) {
    console.error('Erro admin/messages/stats:', err);
    res.status(500).json({ error: 'Erro ao gerar stats' });
  }
});

// ===== PagBank (PIX-QR) por loja — lista + salvar (token tratado como segredo) =====
router.get('/pagbank-stores', async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true, pagbankToken: true, pagbankPixKey: true, pagbankSandbox: true, pagbankEnabled: true },
      orderBy: { code: 'asc' },
    });
    res.json({ stores: stores.map((s) => ({
      id: s.id, name: s.name, code: s.code,
      pixKey: s.pagbankPixKey || '',
      sandbox: s.pagbankSandbox, enabled: s.pagbankEnabled,
      hasToken: !!s.pagbankToken,
      tokenMasked: s.pagbankToken ? '••••' + s.pagbankToken.slice(-4) : '',
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/pagbank-stores/:id', async (req, res) => {
  try {
    const { token, pixKey, sandbox, enabled } = req.body || {};
    const data = {};
    if (typeof token === 'string' && token.trim()) data.pagbankToken = token.trim(); // só sobrescreve se mandar token novo
    if (typeof pixKey === 'string') data.pagbankPixKey = pixKey.trim() || null;
    if (typeof sandbox === 'boolean') data.pagbankSandbox = sandbox;
    if (typeof enabled === 'boolean') data.pagbankEnabled = enabled;
    if (!Object.keys(data).length) return res.status(400).json({ error: 'nada pra salvar' });
    await prisma.store.update({ where: { id: req.params.id }, data });
    const s = await prisma.store.findUnique({ where: { id: req.params.id }, select: { pagbankToken: true, pagbankPixKey: true, pagbankSandbox: true, pagbankEnabled: true } });
    res.json({ ok: true, hasToken: !!s.pagbankToken, tokenMasked: s.pagbankToken ? '••••' + s.pagbankToken.slice(-4) : '', pixKey: s.pagbankPixKey || '', sandbox: s.pagbankSandbox, enabled: s.pagbankEnabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
