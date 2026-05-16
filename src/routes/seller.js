const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

function sellerOnly(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'store'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor / loja' });
  }
  next();
}

function recifeDayBounds(now = new Date()) {
  // Recife é UTC-3 (sem DST)
  const offsetMin = -180;
  const local = new Date(now.getTime() + offsetMin * 60 * 1000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startLocalUtc = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
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

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function summarizeToday(clockIns, now = new Date()) {
  const items = (clockIns || []).slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const entry = items.find(x => x.type === 'entry');
  const exit = items.find(x => x.type === 'exit');
  const effectiveEnd = exit ? new Date(exit.timestamp) : now;

  let breakMinutes = 0;
  let lastBreakStart = null;
  for (const it of items) {
    if (it.type === 'break_start') lastBreakStart = new Date(it.timestamp);
    if (it.type === 'break_end' && lastBreakStart) {
      breakMinutes += Math.max(0, (new Date(it.timestamp) - lastBreakStart) / 60000);
      lastBreakStart = null;
    }
  }
  if (lastBreakStart) {
    breakMinutes += Math.max(0, (effectiveEnd - lastBreakStart) / 60000);
  }

  let workedMinutes = 0;
  if (entry) {
    workedMinutes = Math.max(0, (effectiveEnd - new Date(entry.timestamp)) / 60000 - breakMinutes);
  }

  const lastType = items.length ? items[items.length - 1].type : null;
  const inBreak = lastType === 'break_start';
  const hasEntry = !!entry;
  const hasExit = !!exit;

  let allowedNext = [];
  if (!hasEntry) allowedNext = ['entry'];
  else if (hasEntry && !hasExit) {
    if (inBreak) allowedNext = ['break_end', 'exit'];
    else allowedNext = ['break_start', 'exit'];
  }

  return {
    points: items.map(i => ({
      id: i.id,
      type: i.type,
      timestamp: i.timestamp,
    })),
    summary: {
      hasEntry,
      hasExit,
      inBreak,
      lastType,
      workedMinutes: Math.round(workedMinutes),
      breakMinutes: Math.round(breakMinutes),
      allowedNext,
    },
  };
}

// =====================================================================
// BATER PONTO COMO VENDEDOR (a partir do PDV institucional)
// Operador escolhe o vendedor, vendedor digita PIN pessoal pra confirmar
// =====================================================================
router.post('/clockin-as', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { vendorId, pin, type, latitude, longitude, storeId, note } = req.body || {};

    if (!vendorId) return res.status(400).json({ error: 'Selecione o vendedor' });
    if (!pin) return res.status(400).json({ error: 'Vendedor precisa digitar PIN' });

    const allowed = new Set(['entry', 'break_start', 'break_end', 'exit']);
    if (!type || !allowed.has(type)) {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'GPS obrigatório' });
    }

    const vendor = await prisma.user.findUnique({
      where: { id: vendorId },
      include: { store: true },
    });
    if (!vendor || !vendor.active) return res.status(404).json({ error: 'Vendedor não encontrado' });
    if (vendor.role !== 'seller') return res.status(400).json({ error: 'Selecionado não é vendedor' });

    // Confere PIN do vendedor (não do operador logado)
    const ok = await bcrypt.compare(pin, vendor.pin || '');
    if (!ok) return res.status(401).json({ error: 'PIN incorreto' });

    const finalStoreId = storeId || vendor.storeId;

    // Estado anterior do dia
    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const today = await prisma.clockIn.findMany({
      where: { userId: vendor.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    const summary = summarizeToday(today, now).summary;
    if (!summary.allowedNext.includes(type)) {
      return res.status(400).json({ error: `Ação "${type}" não permitida agora. Disponível: ${summary.allowedNext.join(', ')}` });
    }

    const created = await prisma.clockIn.create({
      data: {
        userId: vendor.id,
        storeId: finalStoreId,
        type,
        latitude,
        longitude,
        note: note || null,
      },
    });

    res.json({
      ok: true,
      clockInId: created.id,
      vendor: { id: vendor.id, name: vendor.name },
      type,
      at: created.timestamp,
    });
  } catch (err) {
    console.error('Erro clockin-as:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// PONTO DO DIA — opcionalmente de um vendedor específico (PDV usa)
// =====================================================================
router.get('/clockin/today-of', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const vendorId = req.query.vendorId;
    if (!vendorId) return res.status(400).json({ error: 'vendorId obrigatório' });

    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const items = await prisma.clockIn.findMany({
      where: { userId: vendorId, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    res.json(summarizeToday(items, now));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/clockin', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const { type, storeId, latitude, longitude, note } = req.body || {};
    const allowed = new Set(['entry', 'break_start', 'break_end', 'exit']);
    if (!type || !allowed.has(type)) {
      return res.status(400).json({ error: 'Tipo inválido. Use: entry, break_start, break_end, exit' });
    }

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Latitude e longitude são obrigatórias' });
    }

    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        storeId: true,
        role: true,
        active: true,
        store: { select: { id: true, code: true, name: true, latitude: true, longitude: true } },
      },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const resolvedStoreId = storeId || u.storeId;
    if (!resolvedStoreId) return res.status(400).json({ error: 'Vendedor sem loja vinculada (storeId)' });

    const store = u.store || await prisma.store.findUnique({
      where: { id: resolvedStoreId },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
    });
    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
    if (typeof store.latitude !== 'number' || typeof store.longitude !== 'number') {
      return res.status(400).json({ error: 'Loja sem coordenadas configuradas' });
    }

    const distM = haversineMeters(latitude, longitude, store.latitude, store.longitude);
    if (distM > 150) {
      return res.status(403).json({ error: `Você está a ${Math.round(distM)}m da loja. Bata o ponto quando estiver dentro do raio de 150m.` });
    }

    // Validação de sequência (dia Recife)
    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const today = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });
    const state = summarizeToday(today, now).summary;
    if (!state.allowedNext.includes(type)) {
      return res.status(400).json({ error: `Batida inválida neste momento. Próximos permitidos: ${state.allowedNext.join(', ') || 'nenhum'}` });
    }

    const clockIn = await prisma.clockIn.create({
      data: {
        userId: u.id,
        storeId: resolvedStoreId,
        type,
        latitude,
        longitude,
        note: note ? String(note).slice(0, 280) : null,
      },
    });

    res.json({ success: true, clockIn });
  } catch (err) {
    console.error('Erro clockin:', err);
    res.status(500).json({ error: 'Erro ao registrar ponto' });
  }
});

router.get('/clockin/today', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, active: true, storeId: true },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const now = new Date();
    const { startUtc, endUtc } = recifeDayBounds(now);
    const items = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: startUtc, lt: endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });

    res.json(summarizeToday(items, now));
  } catch (err) {
    console.error('Erro clockin/today:', err);
    res.status(500).json({ error: 'Erro ao buscar ponto do dia' });
  }
});

router.get('/clockin/me', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const u = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, active: true },
    });
    if (!u || !u.active) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (u.role !== 'seller' && req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'Acesso restrito ao vendedor' });
    }

    const period = req.query.period;
    const bounds = recifeMonthBounds(period);
    if (!bounds) return res.status(400).json({ error: 'Informe period=YYYY-MM' });

    const items = await prisma.clockIn.findMany({
      where: { userId: u.id, timestamp: { gte: bounds.startUtc, lt: bounds.endUtc } },
      orderBy: { timestamp: 'asc' },
      select: { id: true, type: true, timestamp: true },
    });

    // Agrupa por dia local Recife (YYYY-MM-DD)
    const offsetMin = -180;
    const byDay = new Map();
    for (const it of items) {
      const local = new Date(new Date(it.timestamp).getTime() + offsetMin * 60000);
      const key = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(it);
    }

    const days = Array.from(byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, points]) => {
      const summary = summarizeToday(points, new Date()).summary;
      return { date, points: points.map(p => ({ id: p.id, type: p.type, timestamp: p.timestamp })), summary };
    });

    res.json({ period, days });
  } catch (err) {
    console.error('Erro clockin/me:', err);
    res.status(500).json({ error: 'Erro ao buscar histórico' });
  }
});

// =====================================================================
// VENDEDORES DA LOJA — pra escolher quem atendeu o cliente no PDV
// =====================================================================
router.get('/store-sellers', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const storeId = req.query.storeId;
    if (!storeId) return res.status(400).json({ error: 'storeId é obrigatório' });

    const sellers = await prisma.user.findMany({
      where: { role: 'seller', active: true, storeId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, employeeCode: true },
    });
    res.json({ sellers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// LISTA LOJAS — pra escolher onde está trabalhando hoje
// =====================================================================
router.get('/stores', authMiddleware, sellerOnly, async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { active: true },
      orderBy: { code: 'asc' },
      select: { id: true, name: true, code: true, city: true, mall: true, latitude: true, longitude: true },
    });
    res.json({ stores });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// DASHBOARD DO VENDEDOR — KPIs do dia/mês
// =====================================================================
router.get('/dashboard', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const operator = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { store: true },
    });
    const { startUtc: todayStart, endUtc: todayEnd } = recifeDayBounds(new Date());
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Escopo: se logado é STORE (PDV), agrega por LOJA. Se é seller individual, por vendedor.
    const isStoreAccount = operator?.role === 'store';
    const storeId = req.query.storeId || operator?.storeId;

    const baseWhere = isStoreAccount
      ? { storeId } // dados da loja inteira
      : { sellerId: operator.id }; // dados do vendedor pessoal

    const [salesToday, salesMonth, topSellersToday] = await Promise.all([
      prisma.sale.aggregate({
        _sum: { totalAmount: true, tcEarned: true },
        _count: { _all: true },
        where: { ...baseWhere, createdAt: { gte: todayStart, lt: todayEnd } },
      }),
      prisma.sale.aggregate({
        _sum: { totalAmount: true, tcEarned: true },
        _count: { _all: true },
        where: { ...baseWhere, createdAt: { gte: monthStart } },
      }),
      isStoreAccount ? prisma.sale.groupBy({
        by: ['sellerId'],
        _sum: { totalAmount: true },
        _count: { _all: true },
        where: { storeId, createdAt: { gte: todayStart, lt: todayEnd } },
        orderBy: { _sum: { totalAmount: 'desc' } },
        take: 5,
      }) : Promise.resolve([]),
    ]);

    // Resolve nomes dos top vendedores do dia
    let topSellers = [];
    if (topSellersToday.length) {
      const ids = topSellersToday.map(t => t.sellerId);
      const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
      const userMap = new Map(users.map(u => [u.id, u.name]));
      topSellers = topSellersToday.map(t => ({
        sellerId: t.sellerId,
        name: userMap.get(t.sellerId) || '?',
        salesCount: t._count._all,
        salesAmount: t._sum.totalAmount || 0,
      }));
    }

    res.json({
      operator: {
        id: operator?.id,
        name: operator?.name,
        role: operator?.role,
        store: operator?.store ? { id: operator.store.id, name: operator.store.name, code: operator.store.code } : null,
      },
      scope: isStoreAccount ? 'store' : 'seller',
      today: {
        salesCount: salesToday._count._all || 0,
        salesAmount: salesToday._sum.totalAmount || 0,
        cashbackGiven: salesToday._sum.tcEarned || 0,
      },
      month: {
        salesCount: salesMonth._count._all || 0,
        salesAmount: salesMonth._sum.totalAmount || 0,
        cashbackGiven: salesMonth._sum.tcEarned || 0,
      },
      topSellersToday: topSellers,
    });
  } catch (err) {
    console.error('Erro dashboard:', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

// =====================================================================
// REGISTRAR VENDA — vendedor fecha venda + cliente ganha cashback
// =====================================================================
router.post('/sale', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const operatorId = req.userId; // quem operou o PDV (loja ou vendedor)
    const { customerPhone, items, paymentMethod, tcUsed, note, storeId, vendorId } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Informe ao menos 1 item' });
    }

    const operator = await prisma.user.findUnique({
      where: { id: operatorId },
      include: { store: true },
    });
    if (!operator) return res.status(404).json({ error: 'Operador não encontrado' });

    // Vendedor da comissão: vem do frontend (PDV institucional escolhe quem atendeu).
    // Se NÃO veio (login pessoal de vendedor antigo), assume o próprio logado.
    const sellerId = vendorId || (operator.role === 'seller' ? operator.id : null);
    if (!sellerId) return res.status(400).json({ error: 'Informe o vendedor (vendorId) da venda' });

    const seller = await prisma.user.findUnique({ where: { id: sellerId } });
    if (!seller || !seller.active) return res.status(400).json({ error: 'Vendedor inválido ou inativo' });
    if (seller.role !== 'seller' && seller.role !== 'admin') return res.status(400).json({ error: 'Vendedor deve ter perfil de seller' });

    // Loja ativa: enviada pelo frontend. Fallback: loja do operador.
    const activeStoreId = storeId || operator.storeId;
    if (activeStoreId) {
      const exists = await prisma.store.findUnique({ where: { id: activeStoreId } });
      if (!exists || !exists.active) return res.status(400).json({ error: 'Loja inválida ou inativa' });
    }

    // Busca produtos pra montar SaleItems
    const productIds = items.map(i => i.productId).filter(Boolean);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      include: { sizes: true },
    });
    const productMap = new Map(products.map(p => [p.id, p]));

    let totalAmount = 0;
    const saleItemsData = items.map(item => {
      const p = productMap.get(item.productId);
      if (!p) throw new Error(`Produto ${item.productId} não encontrado`);
      const qty = parseInt(item.quantity || 1, 10);
      const unit = parseFloat(item.unitPrice || p.promoPrice || p.price);
      const total = unit * qty;
      totalAmount += total;
      return {
        productId: p.id,
        productName: p.name,
        brand: p.brand || 'SEM MARCA',
        category: p.category || null,
        size: item.size || null,
        quantity: qty,
        unitPrice: unit,
        totalPrice: total,
      };
    });

    // Cliente (opcional): busca por telefone
    let customer = null;
    if (customerPhone) {
      customer = await prisma.user.findUnique({ where: { phone: String(customerPhone) } });
    }

    // TenisCash usado (consome saldo do cliente)
    const tcConsumed = customer && tcUsed > 0 ? Math.min(parseFloat(tcUsed), customer.balance || 0) : 0;

    // Cashback ganho (4% do total — pode virar config no futuro)
    const tcEarned = customer ? Math.round((totalAmount - tcConsumed) * 0.04 * 100) / 100 : 0;

    // Transação atômica: cria venda + items + atualiza saldo do cliente
    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: {
          sellerId,
          storeId: activeStoreId,
          totalAmount,
          tcUsed: tcConsumed,
          tcEarned,
          paymentMethod: paymentMethod || 'unknown',
          status: 'completed',
          note: note || null,
          items: { create: saleItemsData },
        },
        include: { items: true },
      });

      // Atualiza saldo do cliente (deduz tcUsed, soma tcEarned)
      if (customer) {
        await tx.user.update({
          where: { id: customer.id },
          data: { balance: { increment: tcEarned - tcConsumed } },
        });
        await tx.transaction.create({
          data: {
            type: 'sale',
            amount: tcEarned - tcConsumed,
            description: `Venda #${sale.id.slice(0, 8)} — ${seller.name}`,
            receiverId: customer.id,
            balanceAfter: (customer.balance || 0) + (tcEarned - tcConsumed),
            metadata: JSON.stringify({ saleId: sale.id, tcUsed: tcConsumed, tcEarned }),
          },
        });
      }

      // Calcula comissão por marca
      const itemsByBrand = new Map();
      for (const it of saleItemsData) {
        itemsByBrand.set(it.brand, (itemsByBrand.get(it.brand) || 0) + it.totalPrice);
      }
      const brandCommissions = await tx.brandCommission.findMany({
        where: { brand: { in: [...itemsByBrand.keys()] }, active: true },
      });
      const commissionsData = [];
      for (const bc of brandCommissions) {
        const brandSale = itemsByBrand.get(bc.brand) || 0;
        if (brandSale > 0) {
          commissionsData.push({
            saleId: sale.id,
            sellerId,
            brand: bc.brand,
            saleAmount: brandSale,
            pct: bc.commissionPct,
            amount: Math.round(brandSale * bc.commissionPct / 100 * 100) / 100,
          });
        }
      }
      if (commissionsData.length) {
        await tx.saleCommission.createMany({ data: commissionsData });
      }

      return { sale, commissionsCount: commissionsData.length };
    });

    res.json({
      ok: true,
      saleId: result.sale.id,
      totalAmount,
      tcUsed: tcConsumed,
      tcEarned,
      commissionsCreated: result.commissionsCount,
      customer: customer ? { id: customer.id, name: customer.name, newBalance: (customer.balance || 0) + (tcEarned - tcConsumed) } : null,
    });
  } catch (err) {
    console.error('Erro registrar venda:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// MINHAS VENDAS — histórico do vendedor
// =====================================================================
router.get('/sales', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const sales = await prisma.sale.findMany({
      where: { sellerId: req.userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// RANKING DE VENDAS — por vendedor, com filtros loja + periodo
// =====================================================================
// Retorna ranking ordenado por valor de vendas. Cada linha tem:
//   sellerId, name, storeName, salesCount, salesAmount, commissionAmount
// Filtros:
//   storeId — UUID da loja, ou "all" pra todas
//   period  — "today" | "yesterday" | "month" | "last_month" | "custom"
//   from    — YYYY-MM-DD (se period=custom)
//   to      — YYYY-MM-DD (se period=custom)
// =====================================================================
router.get('/rankings', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const storeId = req.query.storeId && req.query.storeId !== 'all' ? req.query.storeId : null;
    const period = req.query.period || 'month';

    // Resolve range de datas
    const now = new Date();
    let startUtc, endUtc;
    if (period === 'today') {
      const r = recifeDayBounds(now); startUtc = r.startUtc; endUtc = r.endUtc;
    } else if (period === 'yesterday') {
      const r = recifeDayBounds(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      startUtc = r.startUtc; endUtc = r.endUtc;
    } else if (period === 'month') {
      startUtc = new Date(now.getFullYear(), now.getMonth(), 1);
      endUtc = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else if (period === 'last_month') {
      startUtc = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endUtc = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (period === 'custom') {
      if (!req.query.from || !req.query.to) return res.status(400).json({ error: 'Informe from e to no formato YYYY-MM-DD' });
      startUtc = new Date(req.query.from + 'T00:00:00-03:00');
      endUtc = new Date(req.query.to + 'T23:59:59-03:00');
    } else {
      return res.status(400).json({ error: 'period inválido' });
    }

    // Filtro de vendas
    const saleWhere = { createdAt: { gte: startUtc, lt: endUtc } };
    if (storeId) saleWhere.storeId = storeId;

    // Agrega vendas por vendedor
    const salesAgg = await prisma.sale.groupBy({
      by: ['sellerId'],
      _sum: { totalAmount: true, tcEarned: true, tcUsed: true },
      _count: { _all: true },
      where: saleWhere,
      orderBy: { _sum: { totalAmount: 'desc' } },
    });

    // Agrega comissões por vendedor (mesmo periodo)
    const commWhere = { createdAt: { gte: startUtc, lt: endUtc } };
    if (storeId) {
      // Comissões não têm storeId, mas todas vêm de Sales — filtra via saleId in sales of store
      const saleIds = (await prisma.sale.findMany({ where: { storeId }, select: { id: true } })).map(s => s.id);
      commWhere.saleId = { in: saleIds.length ? saleIds : ['__none__'] };
    }
    const commAgg = await prisma.saleCommission.groupBy({
      by: ['sellerId'],
      _sum: { amount: true },
      where: commWhere,
    });
    const commBySeller = new Map(commAgg.map(c => [c.sellerId, c._sum.amount || 0]));

    // Nomes + loja dos vendedores
    const sellerIds = salesAgg.map(s => s.sellerId);
    const sellers = await prisma.user.findMany({
      where: { id: { in: sellerIds } },
      select: { id: true, name: true, employeeCode: true, store: { select: { id: true, name: true, code: true } } },
    });
    const sellerMap = new Map(sellers.map(s => [s.id, s]));

    const ranking = salesAgg.map((s, i) => {
      const u = sellerMap.get(s.sellerId);
      return {
        position: i + 1,
        sellerId: s.sellerId,
        name: u?.name || '(removido)',
        employeeCode: u?.employeeCode || null,
        store: u?.store ? { id: u.store.id, name: u.store.name, code: u.store.code } : null,
        salesCount: s._count._all || 0,
        salesAmount: Math.round((s._sum.totalAmount || 0) * 100) / 100,
        cashbackGiven: Math.round((s._sum.tcEarned || 0) * 100) / 100,
        commissionAmount: Math.round((commBySeller.get(s.sellerId) || 0) * 100) / 100,
      };
    });

    // Totais
    const totals = {
      salesCount: ranking.reduce((sum, r) => sum + r.salesCount, 0),
      salesAmount: Math.round(ranking.reduce((sum, r) => sum + r.salesAmount, 0) * 100) / 100,
      cashbackGiven: Math.round(ranking.reduce((sum, r) => sum + r.cashbackGiven, 0) * 100) / 100,
      commissionAmount: Math.round(ranking.reduce((sum, r) => sum + r.commissionAmount, 0) * 100) / 100,
      sellersCount: ranking.length,
    };

    res.json({
      period,
      from: startUtc.toISOString(),
      to: endUtc.toISOString(),
      storeId: storeId || 'all',
      ranking,
      totals,
    });
  } catch (err) {
    console.error('Erro rankings:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// MINHAS COMISSÕES — histórico de comissões
// =====================================================================
router.get('/commissions', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const status = req.query.status; // pending | paid | all
    const where = { sellerId: req.userId };
    if (status && status !== 'all') where.status = status;
    const commissions = await prisma.saleCommission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { sale: { select: { totalAmount: true, createdAt: true } } },
    });
    res.json({ commissions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ESTOQUE ENTRE LOJAS — vendedor consulta disponibilidade em outras unidades
// =====================================================================
router.get('/inventory/check', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const productId = req.query.productId;
    if (!productId) return res.status(400).json({ error: 'productId é obrigatório' });

    const sizes = await prisma.productSize.findMany({
      where: { productId },
      orderBy: { size: 'asc' },
    });

    // Sem multi-loja por tamanho ainda; retorna estoque agregado por tamanho.
    res.json({
      productId,
      sizes: sizes.map(s => ({
        size: s.size,
        barcode: s.barcode,
        stock: s.stock || 0,
      })),
      totalStock: sizes.reduce((sum, s) => sum + (s.stock || 0), 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// BUSCA CLIENTE TenisCash por telefone (autocomplete pro PDV)
// =====================================================================
router.get('/customer/lookup', authMiddleware, sellerOnly, async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '');
    if (phone.length < 10) return res.json({ customer: null });
    const customer = await prisma.user.findUnique({
      where: { phone },
      select: { id: true, name: true, phone: true, balance: true, profileComplete: true },
    });
    res.json({ customer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

