const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, getJwtSecret } = require('../middleware');
const ns = require('../services/nuvemshop');

const router = express.Router();

const PARTNER_TYPES = ['atleta', 'influencer', 'saude', 'personal', 'outro'];
const PARTNER_STATUS = ['active', 'paused', 'banned'];

// Governança: teto de desconto do cupom de um Creation (regra ≤15%; dono fixou 10%).
const MAX_DISCOUNT_PCT = 10;
const DEFAULT_DISCOUNT_PCT = 5;
const DEFAULT_COMMISSION_PCT = 5;

// ----------------------------------------------------------------------
// Interligação Creation ⇄ Nuvemshop — espelha o cupom do Creation na loja.
// Resiliente: se a NS falhar, NÃO derruba a operação local (loga e segue).
// ----------------------------------------------------------------------
async function getNsConnection() {
  try { return await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } }); }
  catch { return null; }
}

// Cria (ou recria) o cupom na NS e devolve o nsCouponId, ou null se falhar.
async function nsCreateOrUpdateCoupon(partner, { valid } = {}) {
  const conn = await getNsConnection();
  if (!conn) { console.warn('[creation] sem conexão NS — cupom não espelhado:', partner.couponCode); return null; }
  const isValid = valid != null ? valid : (partner.status === 'active');
  try {
    if (partner.nsCouponId) {
      await ns.updateCoupon(conn, partner.nsCouponId, { code: partner.couponCode, discountPct: partner.discountPct, valid: isValid });
      return partner.nsCouponId;
    }
    const created = await ns.createCoupon(conn, { code: partner.couponCode, discountPct: partner.discountPct, valid: isValid });
    return created && created.id != null ? String(created.id) : null;
  } catch (err) {
    // Cupom já existe na NS com esse code? tenta achar e linkar.
    console.warn('[creation] falha espelhar cupom NS:', partner.couponCode, err.message);
    return null;
  }
}

async function nsSetCouponValid(partner, valid) {
  if (!partner?.nsCouponId) return;
  const conn = await getNsConnection();
  if (!conn) return;
  try { await ns.setCouponValid(conn, partner.nsCouponId, valid); }
  catch (err) { console.warn('[creation] falha valid=' + valid + ' cupom NS:', partner.couponCode, err.message); }
}
const TIER_THRESHOLDS = [
  { tier: 'platina', min: 100 },
  { tier: 'ouro', min: 31 },
  { tier: 'prata', min: 10 },
  { tier: 'bronze', min: 0 },
];

function adminOnly(req, res, next) {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

function partnerOnly(req, res, next) {
  if (req.userRole !== 'partner') {
    return res.status(403).json({ error: 'Acesso restrito a parceiros' });
  }
  next();
}

function sellerOrAdmin(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito a vendedor ou admin' });
  }
  next();
}

function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userId = null;
    req.userRole = null;
    return next();
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, getJwtSecret());
    req.userId = decoded.userId;
    req.userRole = decoded.role;
  } catch {
    req.userId = null;
    req.userRole = null;
  }
  next();
}

function normalizeCoupon(raw) {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '')
    .slice(0, 32);
}

function tierFromSales(totalSales) {
  for (const t of TIER_THRESHOLDS) if (totalSales >= t.min) return t.tier;
  return 'bronze';
}

function maskCpf(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length !== 11) return null;
  return digits;
}

function startOfTodayBrazil() {
  const offsetMin = -180;
  const now = new Date();
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return new Date(Date.UTC(y, m, d) - offsetMin * 60000);
}

function startOfMonthBrazil() {
  const offsetMin = -180;
  const now = new Date();
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return new Date(Date.UTC(y, m, 1) - offsetMin * 60000);
}

// Chaves YYYY-MM dos últimos 6 meses (incluindo o atual) no fuso de Fortaleza (UTC-3 fixo),
// + o instante UTC do primeiro dia do mês mais antigo (pra filtrar o findMany).
function last6MonthsBrazil() {
  const offsetMin = -180;
  const now = new Date();
  const local = new Date(now.getTime() + offsetMin * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const keys = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    keys.push(d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'));
  }
  const start = new Date(Date.UTC(y, m - 5, 1) - offsetMin * 60000);
  return { keys, start };
}

// Mês (YYYY-MM) de uma data UTC, no fuso de Fortaleza.
function monthKeyBrazil(date) {
  const offsetMin = -180;
  const local = new Date(new Date(date).getTime() + offsetMin * 60000);
  return local.getUTCFullYear() + '-' + String(local.getUTCMonth() + 1).padStart(2, '0');
}

/* ========================================================================
   ENDPOINTS PÚBLICOS / SEMI-PÚBLICOS
   ====================================================================== */

router.post('/coupon/validate', optionalAuth, async (req, res) => {
  try {
    const code = normalizeCoupon(req.body?.code);
    if (!code) return res.json({ valid: false, error: 'Cupom obrigatório' });
    const partner = await prisma.partner.findUnique({
      where: { couponCode: code },
      include: { user: { select: { name: true, phone: true } } },
    });
    if (!partner || partner.status !== 'active') {
      return res.json({ valid: false, error: partner ? 'Cupom inativo' : 'Cupom não encontrado' });
    }
    res.json({
      valid: true,
      couponCode: partner.couponCode,
      discountPct: partner.discountPct,
      commissionPct: partner.commissionPct,
      partnerName: partner.user?.name || '—',
      type: partner.type,
      tier: partner.tier,
    });
  } catch (err) {
    console.error('coupon/validate', err);
    res.status(500).json({ error: 'Erro ao validar cupom' });
  }
});

/* ========================================================================
   ENDPOINTS DO PARCEIRO (role=partner)
   ====================================================================== */

router.get('/partner/me', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({
      where: { userId: req.userId },
      include: { user: { select: { id: true, name: true, phone: true, email: true, balance: true, partnerBalance: true } } },
    });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    res.json({ partner });
  } catch (err) {
    console.error('partner/me', err);
    res.status(500).json({ error: 'Erro ao carregar parceiro' });
  }
});

router.get('/partner/dashboard', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({
      where: { userId: req.userId },
      include: { user: { select: { id: true, name: true, balance: true, partnerBalance: true } } },
    });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });

    const monthStart = startOfMonthBrazil();
    const { keys: seriesKeys, start: seriesStart } = last6MonthsBrazil();
    const [salesMonth, recent, seriesRows] = await Promise.all([
      prisma.partnerSale.aggregate({
        where: { partnerId: partner.id, createdAt: { gte: monthStart }, status: { not: 'refunded' } },
        _sum: { saleAmount: true, commissionT: true },
        _count: { _all: true },
      }),
      prisma.partnerSale.findMany({
        where: { partnerId: partner.id, status: { not: 'refunded' } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true, customerName: true, saleAmount: true, commissionT: true, createdAt: true,
        },
      }),
      prisma.partnerSale.findMany({
        where: { partnerId: partner.id, status: { not: 'refunded' }, createdAt: { gte: seriesStart } },
        select: { createdAt: true, commissionT: true, saleAmount: true },
      }),
    ]);

    // Série mensal (6 meses) pro gráfico do dashboard
    const buckets = {};
    seriesKeys.forEach((k) => { buckets[k] = { month: k, sales: 0, commission: 0, revenue: 0 }; });
    for (const r of seriesRows) {
      const k = monthKeyBrazil(r.createdAt);
      if (buckets[k]) {
        buckets[k].sales += 1;
        buckets[k].commission += (r.commissionT || 0);
        buckets[k].revenue += (r.saleAmount || 0);
      }
    }
    const monthlySeries = seriesKeys.map((k) => buckets[k]);

    // Posição no ranking por totalCommission
    const better = await prisma.partner.count({
      where: { totalCommission: { gt: partner.totalCommission }, status: 'active' },
    });

    res.json({
      partner: {
        id: partner.id,
        couponCode: partner.couponCode,
        discountPct: partner.discountPct,
        commissionPct: partner.commissionPct,
        tier: partner.tier,
        status: partner.status,
        totalSales: partner.totalSales,
        totalRevenue: partner.totalRevenue,
        totalCommission: partner.totalCommission,
      },
      user: partner.user,
      // Mantém `balance` (cashback) e expõe `partnerBalance` (comissão) separados
      balance: partner.user?.balance || 0,
      partnerBalance: partner.user?.partnerBalance || 0,
      monthSales: salesMonth._count?._all || 0,
      monthRevenue: salesMonth._sum?.saleAmount || 0,
      monthCommission: salesMonth._sum?.commissionT || 0,
      rankingPosition: better + 1,
      recentSales: recent,
      monthlySeries,
    });
  } catch (err) {
    console.error('partner/dashboard', err);
    res.status(500).json({ error: 'Erro ao carregar dashboard' });
  }
});

router.get('/partner/sales', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({ where: { userId: req.userId } });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });

    const month = String(req.query.month || '').trim(); // YYYY-MM
    const where = { partnerId: partner.id };
    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split('-').map((x) => parseInt(x, 10));
      const offsetMin = -180;
      const start = new Date(Date.UTC(y, m - 1, 1) - offsetMin * 60000);
      const end = new Date(Date.UTC(y, m, 1) - offsetMin * 60000);
      where.createdAt = { gte: start, lt: end };
    }

    const sales = await prisma.partnerSale.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ sales });
  } catch (err) {
    console.error('partner/sales', err);
    res.status(500).json({ error: 'Erro ao listar vendas' });
  }
});

router.post('/partner/redeem', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({
      where: { userId: req.userId },
      include: { user: { select: { id: true, name: true, balance: true, partnerBalance: true } } },
    });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const totalT = items.reduce((acc, it) => acc + (Number(it.priceT) || 0) * (Math.max(1, parseInt(it.qty, 10) || 1)), 0);
    if (!items.length || totalT <= 0) {
      return res.status(400).json({ error: 'Adicione pelo menos um item à troca' });
    }
    // Troca usa SALDO COMISSÃO (partnerBalance), nunca cashback do cliente (balance)
    const partnerBalance = partner.user?.partnerBalance || 0;
    if (totalT > partnerBalance) {
      return res.status(400).json({ error: 'Saldo de comissão insuficiente. Disponível: T$ ' + partnerBalance.toFixed(2) });
    }

    const summary = items
      .map((it) => `${Math.max(1, parseInt(it.qty, 10) || 1)}x ${String(it.name || it.sku || 'item').slice(0, 80)} (T$ ${Number(it.priceT || 0).toFixed(2)})`)
      .join('\n');

    const adminUser = await prisma.user.findFirst({
      where: { role: { in: ['admin', 'superadmin', 'manager'] }, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!adminUser) return res.status(503).json({ error: 'Nenhum admin disponível para receber a solicitação' });

    const message = await prisma.message.create({
      data: {
        fromId: req.userId,
        toId: adminUser.id,
        type: 'request',
        title: `Troca de T$ ${totalT.toFixed(2)} — Parceiro ${partner.user?.name || ''}`.slice(0, 200),
        content: `Solicitação de troca de TenisCash (comissão) por produtos:\n\n${summary}\n\nTotal solicitado: T$ ${totalT.toFixed(2)}\nSaldo comissão disponível: T$ ${partnerBalance.toFixed(2)}`,
        status: 'sent',
      },
    });

    res.json({ ok: true, requestId: message.id, totalT });
  } catch (err) {
    console.error('partner/redeem', err);
    res.status(500).json({ error: 'Erro ao solicitar troca' });
  }
});

/* ========================================================================
   ENDPOINTS DO ADMIN
   ====================================================================== */

router.get('/admin/partners', authMiddleware, adminOnly, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const status = String(req.query.status || '').trim();
    const where = {};
    if (status && PARTNER_STATUS.includes(status)) where.status = status;
    if (search) {
      where.OR = [
        { couponCode: { contains: search.toUpperCase() } },
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search } } },
      ];
    }
    const partners = await prisma.partner.findMany({
      where,
      orderBy: [{ totalCommission: 'desc' }],
      take: 500,
      include: {
        user: { select: { id: true, name: true, phone: true, email: true, balance: true, role: true, active: true } },
      },
    });
    res.json({ partners });
  } catch (err) {
    console.error('admin/partners list', err);
    res.status(500).json({ error: 'Erro ao listar parceiros' });
  }
});

router.get('/admin/partners/stats', authMiddleware, adminOnly, async (_req, res) => {
  try {
    const monthStart = startOfMonthBrazil();
    const [count, top, monthAgg, totalAgg] = await Promise.all([
      prisma.partner.count(),
      prisma.partner.findMany({
        orderBy: { totalCommission: 'desc' },
        take: 10,
        include: { user: { select: { id: true, name: true } } },
      }),
      prisma.partnerSale.aggregate({
        where: { createdAt: { gte: monthStart }, status: { not: 'refunded' } },
        _sum: { saleAmount: true, commissionT: true, discountValue: true },
        _count: { _all: true },
      }),
      prisma.partnerSale.aggregate({
        where: { status: { not: 'refunded' } },
        _sum: { saleAmount: true, commissionT: true },
        _count: { _all: true },
      }),
    ]);
    const monthRevenue = monthAgg._sum?.saleAmount || 0;
    const monthCommission = monthAgg._sum?.commissionT || 0;
    res.json({
      partnersCount: count,
      monthSales: monthAgg._count?._all || 0,
      monthRevenue,
      monthCommission,
      monthDiscount: monthAgg._sum?.discountValue || 0,
      totalSales: totalAgg._count?._all || 0,
      totalRevenue: totalAgg._sum?.saleAmount || 0,
      totalCommission: totalAgg._sum?.commissionT || 0,
      monthRoi: monthCommission > 0 ? Number((monthRevenue / monthCommission).toFixed(2)) : null,
      top: top.map((p) => ({
        id: p.id,
        couponCode: p.couponCode,
        userName: p.user?.name,
        totalSales: p.totalSales,
        totalCommission: p.totalCommission,
        tier: p.tier,
      })),
    });
  } catch (err) {
    console.error('admin/partners/stats', err);
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

router.get('/admin/partners/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const p = await prisma.partner.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, name: true, phone: true, email: true, balance: true } } },
    });
    if (!p) return res.status(404).json({ error: 'Parceiro não encontrado' });
    res.json({ partner: p });
  } catch (err) {
    console.error('admin/partners get', err);
    res.status(500).json({ error: 'Erro ao carregar parceiro' });
  }
});

router.get('/admin/partners/:id/sales', authMiddleware, adminOnly, async (req, res) => {
  try {
    const partner = await prisma.partner.findUnique({ where: { id: req.params.id } });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const sales = await prisma.partnerSale.findMany({
      where: { partnerId: partner.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { seller: { select: { id: true, name: true } } },
    });
    res.json({ sales });
  } catch (err) {
    console.error('admin/partners/:id/sales', err);
    res.status(500).json({ error: 'Erro ao listar vendas' });
  }
});

router.post('/admin/partners', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const phone = String(b.phone || '').replace(/\D/g, '');
    const couponCode = normalizeCoupon(b.couponCode);
    const type = String(b.type || '').trim().toLowerCase();
    if (!phone) return res.status(400).json({ error: 'Telefone do usuário obrigatório' });
    if (!couponCode || couponCode.length < 3) return res.status(400).json({ error: 'Código do cupom inválido (mínimo 3 caracteres)' });
    if (!PARTNER_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo inválido. Use: ' + PARTNER_TYPES.join(', ') });

    // Desconto do cupom tem teto de governança (MAX_DISCOUNT_PCT). Comissão é margem
    // interna do programa, não vai pro cliente — cap mais folgado (50%).
    const discountPct = Math.min(MAX_DISCOUNT_PCT, Math.max(0, parseFloat(b.discountPct))) || DEFAULT_DISCOUNT_PCT;
    const commissionPct = Math.min(50, Math.max(0, parseFloat(b.commissionPct))) || DEFAULT_COMMISSION_PCT;

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) return res.status(404).json({ error: 'Usuário com este telefone não encontrado. Cadastre o usuário antes.' });
    if (!user.active) return res.status(400).json({ error: 'Usuário desativado — não pode virar parceiro.' });

    const existsP = await prisma.partner.findUnique({ where: { userId: user.id } });
    if (existsP) {
      if (existsP.status === 'banned') {
        return res.status(400).json({ error: 'Esse usuário já foi parceiro e está banido. Remova-o pelo botão Excluir antes de recriar.' });
      }
      return res.status(400).json({ error: 'Esse usuário já é parceiro (cupom: ' + existsP.couponCode + ')' });
    }

    const dupCoupon = await prisma.partner.findUnique({ where: { couponCode } });
    if (dupCoupon) {
      return res.status(400).json({ error: 'Esse cupom já está em uso por outro parceiro. Escolha outro código.' });
    }

    const partner = await prisma.$transaction(async (tx) => {
      const p = await tx.partner.create({
        data: {
          userId: user.id,
          type,
          couponCode,
          discountPct,
          commissionPct,
          bio: b.bio ? String(b.bio).slice(0, 500) : null,
          niche: b.niche ? String(b.niche).slice(0, 80) : null,
          followers: b.followers != null && b.followers !== '' ? Math.max(0, parseInt(b.followers, 10) || 0) : null,
          socialMedia: b.socialMedia ? (typeof b.socialMedia === 'string' ? b.socialMedia.slice(0, 1000) : JSON.stringify(b.socialMedia).slice(0, 1000)) : null,
          notes: b.notes ? String(b.notes).slice(0, 500) : null,
        },
      });
      await tx.user.update({ where: { id: user.id }, data: { role: 'partner' } });
      return p;
    });

    // Espelha o cupom na Nuvemshop (interligação Creation ⇄ NS). Não bloqueia se falhar.
    let nsCouponId = null;
    try {
      nsCouponId = await nsCreateOrUpdateCoupon(partner);
      if (nsCouponId && nsCouponId !== partner.nsCouponId) {
        await prisma.partner.update({ where: { id: partner.id }, data: { nsCouponId } });
        partner.nsCouponId = nsCouponId;
      }
    } catch (e) {
      console.warn('[creation] cupom NS não espelhado na criação:', partner.couponCode, e.message);
    }

    res.json({ partner, nsCouponId });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Cupom ou usuário já cadastrados' });
    console.error('admin/partners create', err);
    res.status(500).json({ error: 'Erro ao criar parceiro' });
  }
});

router.put('/admin/partners/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const existing = await prisma.partner.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Parceiro não encontrado' });

    const b = req.body || {};
    const data = {};
    if (b.type != null) {
      const t = String(b.type).trim().toLowerCase();
      if (!PARTNER_TYPES.includes(t)) return res.status(400).json({ error: 'Tipo inválido' });
      data.type = t;
    }
    if (b.status != null) {
      const s = String(b.status).trim().toLowerCase();
      if (!PARTNER_STATUS.includes(s)) return res.status(400).json({ error: 'Status inválido' });
      data.status = s;
    }
    if (b.couponCode != null) {
      const c = normalizeCoupon(b.couponCode);
      if (!c || c.length < 3) return res.status(400).json({ error: 'Código do cupom inválido' });
      if (c !== existing.couponCode) {
        const dup = await prisma.partner.findUnique({ where: { couponCode: c } });
        if (dup) return res.status(400).json({ error: 'Cupom já está em uso' });
      }
      data.couponCode = c;
    }
    if (b.discountPct != null) data.discountPct = Math.min(MAX_DISCOUNT_PCT, Math.max(0, parseFloat(b.discountPct)));
    if (b.commissionPct != null) data.commissionPct = Math.min(50, Math.max(0, parseFloat(b.commissionPct)));
    if (b.bio !== undefined) data.bio = b.bio ? String(b.bio).slice(0, 500) : null;
    if (b.niche !== undefined) data.niche = b.niche ? String(b.niche).slice(0, 80) : null;
    if (b.followers !== undefined) {
      data.followers = b.followers != null && b.followers !== ''
        ? Math.max(0, parseInt(b.followers, 10) || 0) : null;
    }
    if (b.socialMedia !== undefined) {
      data.socialMedia = b.socialMedia
        ? (typeof b.socialMedia === 'string' ? b.socialMedia.slice(0, 1000) : JSON.stringify(b.socialMedia).slice(0, 1000))
        : null;
    }
    if (b.notes !== undefined) data.notes = b.notes ? String(b.notes).slice(0, 500) : null;

    const updated = await prisma.partner.update({ where: { id }, data });

    // Re-espelha na NS se mudou code, desconto ou status (afeta o cupom).
    const couponChanged = data.couponCode != null && data.couponCode !== existing.couponCode;
    const discountChanged = data.discountPct != null && data.discountPct !== existing.discountPct;
    const statusChanged = data.status != null && data.status !== existing.status;
    if (couponChanged || discountChanged || statusChanged) {
      try {
        const nsCouponId = await nsCreateOrUpdateCoupon(updated, { valid: updated.status === 'active' });
        if (nsCouponId && nsCouponId !== updated.nsCouponId) {
          await prisma.partner.update({ where: { id }, data: { nsCouponId } });
          updated.nsCouponId = nsCouponId;
        }
      } catch (e) {
        console.warn('[creation] cupom NS não re-espelhado no update:', updated.couponCode, e.message);
      }
    }

    res.json({ partner: updated });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'Cupom já está em uso' });
    console.error('admin/partners update', err);
    res.status(500).json({ error: 'Erro ao atualizar parceiro' });
  }
});

router.delete('/admin/partners/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const partner = await prisma.partner.findUnique({ where: { id } });
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });

    // Sufixo arquivado para liberar o couponCode original (campo @unique).
    // Mantém rastro: PEDRO -> PEDRO_DEL_1716490231234
    const archivedCoupon = (partner.couponCode || '').slice(0, 24).toUpperCase()
      + '_DEL_' + Date.now();

    // Desativa o cupom espelhado na NS (não apaga: preserva histórico de pedidos NS).
    await nsSetCouponValid(partner, false);

    const salesCount = await prisma.partnerSale.count({ where: { partnerId: id } });
    if (salesCount > 0 && req.query.force !== 'true') {
      // Tem vendas: ban + libera cupom (renomeia) preservando o histórico de PartnerSale
      const updated = await prisma.$transaction(async (tx) => {
        const p = await tx.partner.update({
          where: { id },
          data: { status: 'banned', couponCode: archivedCoupon },
        });
        await tx.user.update({ where: { id: partner.userId }, data: { role: 'user' } });
        return p;
      });
      return res.json({
        ok: true,
        soft: true,
        partner: updated,
        message: 'Parceiro tem vendas: banido (histórico preservado). Cupom "' + partner.couponCode + '" liberado para reuso.',
      });
    }

    // Hard delete (sem vendas, ou ?force=true): apaga PartnerSale + Partner e libera tudo
    await prisma.$transaction(async (tx) => {
      if (salesCount > 0) await tx.partnerSale.deleteMany({ where: { partnerId: id } });
      await tx.partner.delete({ where: { id } });
      await tx.user.update({ where: { id: partner.userId }, data: { role: 'user' } });
    });
    res.json({ ok: true, message: 'Parceiro removido. Cupom "' + partner.couponCode + '" liberado.' });
  } catch (err) {
    console.error('admin/partners delete', err);
    res.status(500).json({ error: 'Erro ao remover parceiro' });
  }
});

/* ========================================================================
   REGISTRAR VENDA COM CUPOM (vendedor ou admin)
   ====================================================================== */

router.post('/admin/sale-with-coupon', authMiddleware, sellerOrAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const couponCode = normalizeCoupon(b.couponCode);
    if (!couponCode) return res.status(400).json({ error: 'Cupom obrigatório' });

    const customerPhoneDigits = String(b.customerPhone || '').replace(/\D/g, '');
    const customerName = b.customerName ? String(b.customerName).trim().slice(0, 120) : null;
    const customerCpf = maskCpf(b.customerCpf);
    const saleAmountFull = parseFloat(b.saleAmountFull);
    if (!Number.isFinite(saleAmountFull) || saleAmountFull <= 0) {
      return res.status(400).json({ error: 'saleAmountFull inválido' });
    }

    const partner = await prisma.partner.findUnique({
      where: { couponCode },
      include: { user: { select: { id: true, name: true, phone: true, balance: true } } },
    });
    if (!partner) return res.status(404).json({ error: 'Cupom não encontrado' });
    if (partner.status !== 'active') return res.status(400).json({ error: 'Cupom inativo (' + partner.status + ')' });

    // Antifraude #1: cupom não pode ser usado pelo próprio parceiro
    if (customerPhoneDigits && partner.user?.phone && customerPhoneDigits === partner.user.phone.replace(/\D/g, '')) {
      return res.status(400).json({ error: 'Parceiro não pode usar o próprio cupom' });
    }

    // Antifraude #2: 1 venda por CPF de cliente por dia (apenas quando CPF fornecido)
    if (customerCpf) {
      const t0 = startOfTodayBrazil();
      const exists = await prisma.partnerSale.findFirst({
        where: { customerCpf, createdAt: { gte: t0 } },
        select: { id: true, createdAt: true },
      });
      if (exists) {
        return res.status(400).json({ error: 'Este CPF já usou um cupom de parceiro hoje' });
      }
    }

    const products = Array.isArray(b.products) ? b.products.map((p) => ({
      sku: String(p.sku || '').slice(0, 80),
      name: String(p.name || '').slice(0, 200),
      qty: Math.max(1, parseInt(p.qty, 10) || 1),
      price: parseFloat(p.price) || 0,
    })) : [];

    const discountValue = Number((saleAmountFull * partner.discountPct / 100).toFixed(2));
    const saleAmount = Number((saleAmountFull - discountValue).toFixed(2));
    const commissionT = Number((saleAmount * partner.commissionPct / 100).toFixed(2));

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.partnerSale.create({
        data: {
          partnerId: partner.id,
          customerName,
          customerCpf,
          customerPhone: customerPhoneDigits || null,
          saleAmount,
          saleAmountFull,
          discountValue,
          commissionT,
          products: products.length ? JSON.stringify(products) : null,
          status: 'approved',
          sellerId: req.userId,
        },
      });

      // Credita comissão T$ no SALDO COMISSÃO (partnerBalance) — NUNCA no balance (cashback)
      const updatedUser = await tx.user.update({
        where: { id: partner.userId },
        data: { partnerBalance: { increment: commissionT } },
      });

      // Cria Transaction de rastreio. balanceAfter representa o partnerBalance pós-crédito.
      await tx.transaction.create({
        data: {
          type: 'partner_commission',
          amount: commissionT,
          description: `Comissão cupom ${partner.couponCode} — venda R$ ${saleAmount.toFixed(2)}`,
          receiverId: partner.userId,
          balanceAfter: updatedUser.partnerBalance,
          metadata: JSON.stringify({
            partnerSaleId: sale.id,
            couponCode: partner.couponCode,
            sellerId: req.userId,
            wallet: 'partnerBalance',
          }),
        },
      });

      // Atualiza estatísticas + tier do parceiro
      const newTotalSales = partner.totalSales + 1;
      const newTotalRevenue = partner.totalRevenue + saleAmount;
      const newTotalCommission = partner.totalCommission + commissionT;
      const newTier = tierFromSales(newTotalSales);
      const updatedPartner = await tx.partner.update({
        where: { id: partner.id },
        data: {
          totalSales: newTotalSales,
          totalRevenue: newTotalRevenue,
          totalCommission: newTotalCommission,
          tier: newTier,
        },
      });

      return { sale, partner: updatedPartner, user: updatedUser };
    });

    console.log(
      '[partner-sale] coupon=' + partner.couponCode
      + ' sellerId=' + req.userId
      + ' saleAmount=' + saleAmount
      + ' commissionT=' + commissionT,
    );

    res.json({
      sale: result.sale,
      partner: {
        id: result.partner.id,
        couponCode: result.partner.couponCode,
        tier: result.partner.tier,
        totalSales: result.partner.totalSales,
      },
      commissionEarned: commissionT,
      partnerBalance: result.user.partnerBalance,
      cashbackBalance: result.user.balance,
    });
  } catch (err) {
    console.error('admin/sale-with-coupon', err);
    res.status(500).json({ error: 'Erro ao registrar venda com cupom' });
  }
});

module.exports = router;
