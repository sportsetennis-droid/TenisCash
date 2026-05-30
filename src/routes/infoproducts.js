// =====================================================================
// INFOPRODUTOS — plataforma estilo Hotmart dentro do TenisCash
// ---------------------------------------------------------------------
// Produtor (Professional) cria produto digital + curso (módulos/aulas),
// vende no checkout (Pix/cartão/boleto), libera área de membros, emite
// certificado. Afiliados indicam por link rastreado e ganham comissão.
// Split/take rate/cashback entram quando o PSP (Asaas) estiver ligado;
// até lá o checkout roda em Pix off-platform (services/payments.js).
// =====================================================================

const express = require('express');
const crypto = require('crypto');
const { prisma, authMiddleware, adminMiddleware } = require('../middleware');
const { generatePublicToken, sanitize } = require('../services/pix');
const payments = require('../services/payments');

const router = express.Router();

const PRODUCT_TYPES = ['course', 'ebook', 'community', 'mentorship', 'file', 'bundle'];
const SALE_STATUS = ['waiting_payment', 'paid', 'refunded', 'chargeback', 'cancelled', 'overdue'];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function slugify(s) {
  return (
    sanitize(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'produto'
  );
}
function shortCode(n = 8) {
  return crypto.randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n);
}
async function uniqueProductSlug(base) {
  let slug = slugify(base);
  let i = 1;
  while (await prisma.digitalProduct.findUnique({ where: { slug } })) {
    i += 1;
    slug = `${slugify(base)}-${i}`;
  }
  return slug;
}
async function getMyPro(req) {
  return prisma.professional.findUnique({ where: { userId: req.userId } });
}
function proOnly(handler) {
  return async (req, res) => {
    try {
      const pro = await getMyPro(req);
      if (!pro) return res.status(404).json({ error: 'Crie seu perfil profissional primeiro (POST /api/professionals/me)' });
      req.pro = pro;
      return handler(req, res);
    } catch (err) {
      console.error('[infoproducts]', err);
      return res.status(500).json({ error: err.message });
    }
  };
}
// dono do produto?
async function getMyProduct(req, productId) {
  return prisma.digitalProduct.findFirst({ where: { id: productId, professionalId: req.pro.id } });
}

// Núcleo: confirma pagamento de uma venda (idempotente). Usado pelo
// produtor (off_platform) E pelo webhook do PSP (on_platform):
// marca paga, libera matrícula, gera comissão e credita cashback.
async function markSalePaid(saleId, { confirmedBy = 'manual' } = {}) {
  const sale = await prisma.digitalSale.findUnique({ where: { id: saleId }, include: { product: true } });
  if (!sale) return null;
  if (sale.status === 'paid') {
    const existing = await prisma.enrollment.findFirst({ where: { saleId: sale.id } });
    return { sale, enrollment: existing, already: true };
  }

  return prisma.$transaction(async (tx) => {
    const paid = await tx.digitalSale.update({
      where: { id: sale.id },
      data: { status: 'paid', paidAt: new Date() },
    });

    // matrícula (acesso à área de membros) — sem login, via accessToken
    let enrollment = await tx.enrollment.findFirst({ where: { saleId: sale.id } });
    if (!enrollment) {
      const expiresAt = sale.product.accessDays
        ? new Date(Date.now() + sale.product.accessDays * 86400000)
        : null;
      enrollment = await tx.enrollment.create({
        data: {
          productId: sale.productId,
          userId: sale.userId || null,
          buyerName: sale.buyerName,
          buyerEmail: sale.buyerEmail,
          buyerPhone: sale.buyerPhone,
          saleId: sale.id,
          affiliateId: sale.affiliateId || null,
          accessToken: generatePublicToken(),
          expiresAt,
        },
      });
    }

    // stats do produto + recebido do produtor
    await tx.digitalProduct.update({
      where: { id: sale.productId },
      data: { salesCount: { increment: 1 }, revenueTotal: { increment: sale.amount } },
    });
    await tx.professional.update({
      where: { id: sale.product.professionalId },
      data: { totalBilled: { increment: sale.amount }, totalPaid: { increment: sale.producerAmount } },
    });

    // comissão de afiliado
    if (sale.affiliateId && sale.affiliateAmount > 0) {
      await tx.affiliateCommission.create({
        data: { affiliateId: sale.affiliateId, saleId: sale.id, amount: sale.affiliateAmount, status: sale.settlementMode === 'on_platform' ? 'available' : 'pending' },
      });
      await tx.affiliate.update({
        where: { id: sale.affiliateId },
        data: { salesTotal: { increment: 1 }, commissionTotal: { increment: sale.affiliateAmount }, commissionPending: { increment: sale.affiliateAmount } },
      });
      if (sale.affiliateCode) {
        await tx.affiliateLink.updateMany({ where: { code: sale.affiliateCode }, data: { sales: { increment: 1 } } });
      }
    }

    // cashback TenisCash pro comprador (só on_platform e se for usuário)
    if (sale.userId && sale.cashbackAmount > 0) {
      await tx.user.update({ where: { id: sale.userId }, data: { balance: { increment: sale.cashbackAmount } } });
    }

    return { sale: paid, enrollment, already: false };
  });
}

// =====================================================================
// PRODUTOR — produtos / curso (autenticado, dono do card)
// =====================================================================
router.get('/me/products', authMiddleware, proOnly(async (req, res) => {
  const products = await prisma.digitalProduct.findMany({
    where: { professionalId: req.pro.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { sales: true, enrollments: true, modules: true } } },
  });
  res.json(products);
}));

router.post('/me/products', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title obrigatório' });
  const type = PRODUCT_TYPES.includes(b.type) ? b.type : 'course';
  const slug = await uniqueProductSlug(b.slug || b.title);
  const product = await prisma.digitalProduct.create({
    data: {
      professionalId: req.pro.id,
      slug,
      title: b.title,
      subtitle: b.subtitle || null,
      description: b.description || null,
      coverUrl: b.coverUrl || null,
      type,
      price: Number(b.price) || 0,
      comparePrice: b.comparePrice != null ? Number(b.comparePrice) : null,
      recurrence: ['monthly', 'annual'].includes(b.recurrence) ? b.recurrence : null,
      hasMembersArea: b.hasMembersArea !== undefined ? !!b.hasMembersArea : type === 'course' || type === 'community',
      fileUrl: b.fileUrl || null,
      accessDays: b.accessDays != null ? Number(b.accessDays) : null,
      allowPix: b.allowPix !== undefined ? !!b.allowPix : true,
      allowCard: b.allowCard !== undefined ? !!b.allowCard : true,
      allowBoleto: b.allowBoleto !== undefined ? !!b.allowBoleto : false,
      installmentsMax: b.installmentsMax != null ? Number(b.installmentsMax) : 12,
      affiliateEnabled: !!b.affiliateEnabled,
      affiliateCommissionPct: b.affiliateCommissionPct != null ? Number(b.affiliateCommissionPct) : 30,
      affiliateAutoApprove: b.affiliateAutoApprove !== undefined ? !!b.affiliateAutoApprove : true,
      affiliateCookieDays: b.affiliateCookieDays != null ? Number(b.affiliateCookieDays) : 30,
      platformFeePct: b.platformFeePct != null ? Number(b.platformFeePct) : 0,
      cashbackPct: b.cashbackPct != null ? Number(b.cashbackPct) : 0,
      guaranteeDays: b.guaranteeDays != null ? Number(b.guaranteeDays) : 7,
      status: b.status === 'published' ? 'published' : 'draft',
    },
  });
  res.status(201).json(product);
}));

router.get('/me/products/:id', authMiddleware, proOnly(async (req, res) => {
  const product = await prisma.digitalProduct.findFirst({
    where: { id: req.params.id, professionalId: req.pro.id },
    include: {
      modules: { orderBy: { order: 'asc' }, include: { lessons: { orderBy: { order: 'asc' } } } },
      _count: { select: { sales: true, enrollments: true } },
    },
  });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  res.json(product);
}));

router.put('/me/products/:id', authMiddleware, proOnly(async (req, res) => {
  const product = await getMyProduct(req, req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  const b = req.body || {};
  const data = {};
  for (const f of ['title', 'subtitle', 'description', 'coverUrl', 'fileUrl']) if (b[f] !== undefined) data[f] = b[f];
  for (const f of ['price', 'comparePrice', 'accessDays', 'installmentsMax', 'affiliateCommissionPct', 'affiliateCookieDays', 'platformFeePct', 'cashbackPct', 'guaranteeDays']) {
    if (b[f] !== undefined) data[f] = b[f] != null ? Number(b[f]) : null;
  }
  for (const f of ['hasMembersArea', 'allowPix', 'allowCard', 'allowBoleto', 'affiliateEnabled', 'affiliateAutoApprove', 'visible']) {
    if (b[f] !== undefined) data[f] = !!b[f];
  }
  if (b.type !== undefined && PRODUCT_TYPES.includes(b.type)) data.type = b.type;
  if (b.recurrence !== undefined) data.recurrence = ['monthly', 'annual'].includes(b.recurrence) ? b.recurrence : null;
  if (b.status !== undefined && ['draft', 'published', 'archived'].includes(b.status)) data.status = b.status;
  if (b.slug !== undefined && b.slug !== product.slug) data.slug = await uniqueProductSlug(b.slug);
  const updated = await prisma.digitalProduct.update({ where: { id: product.id }, data });
  res.json(updated);
}));

router.delete('/me/products/:id', authMiddleware, proOnly(async (req, res) => {
  const product = await getMyProduct(req, req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  const salesCount = await prisma.digitalSale.count({ where: { productId: product.id, status: 'paid' } });
  if (salesCount > 0) {
    // tem venda paga: arquiva (não apaga, preserva acesso dos alunos)
    const arch = await prisma.digitalProduct.update({ where: { id: product.id }, data: { status: 'archived', visible: false } });
    return res.json({ archived: true, product: arch });
  }
  await prisma.digitalProduct.delete({ where: { id: product.id } });
  res.json({ ok: true });
}));

// ---- Módulos ----
router.post('/me/products/:id/modules', authMiddleware, proOnly(async (req, res) => {
  const product = await getMyProduct(req, req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  const count = await prisma.courseModule.count({ where: { productId: product.id } });
  const mod = await prisma.courseModule.create({
    data: { productId: product.id, title: (req.body && req.body.title) || `Módulo ${count + 1}`, description: req.body?.description || null, order: req.body?.order != null ? Number(req.body.order) : count },
  });
  res.status(201).json(mod);
}));

router.put('/me/modules/:id', authMiddleware, proOnly(async (req, res) => {
  const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!mod) return res.status(404).json({ error: 'Módulo não encontrado' });
  const b = req.body || {};
  const data = {};
  if (b.title !== undefined) data.title = b.title;
  if (b.description !== undefined) data.description = b.description;
  if (b.order !== undefined) data.order = Number(b.order);
  res.json(await prisma.courseModule.update({ where: { id: mod.id }, data }));
}));

router.delete('/me/modules/:id', authMiddleware, proOnly(async (req, res) => {
  const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!mod) return res.status(404).json({ error: 'Módulo não encontrado' });
  await prisma.courseModule.delete({ where: { id: mod.id } });
  res.json({ ok: true });
}));

// ---- Aulas ----
router.post('/me/modules/:id/lessons', authMiddleware, proOnly(async (req, res) => {
  const mod = await prisma.courseModule.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!mod) return res.status(404).json({ error: 'Módulo não encontrado' });
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title obrigatório' });
  const count = await prisma.lesson.count({ where: { moduleId: mod.id } });
  const lesson = await prisma.lesson.create({
    data: {
      moduleId: mod.id,
      title: b.title,
      description: b.description || null,
      order: b.order != null ? Number(b.order) : count,
      videoUrl: b.videoUrl || null,
      videoProvider: b.videoProvider || null,
      durationSec: b.durationSec != null ? Number(b.durationSec) : null,
      contentHtml: b.contentHtml || null,
      attachmentUrl: b.attachmentUrl || null,
      free: !!b.free,
    },
  });
  res.status(201).json(lesson);
}));

router.put('/me/lessons/:id', authMiddleware, proOnly(async (req, res) => {
  const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, module: { product: { professionalId: req.pro.id } } } });
  if (!lesson) return res.status(404).json({ error: 'Aula não encontrada' });
  const b = req.body || {};
  const data = {};
  for (const f of ['title', 'description', 'videoUrl', 'videoProvider', 'contentHtml', 'attachmentUrl']) if (b[f] !== undefined) data[f] = b[f];
  if (b.durationSec !== undefined) data.durationSec = b.durationSec != null ? Number(b.durationSec) : null;
  if (b.order !== undefined) data.order = Number(b.order);
  if (b.free !== undefined) data.free = !!b.free;
  res.json(await prisma.lesson.update({ where: { id: lesson.id }, data }));
}));

router.delete('/me/lessons/:id', authMiddleware, proOnly(async (req, res) => {
  const lesson = await prisma.lesson.findFirst({ where: { id: req.params.id, module: { product: { professionalId: req.pro.id } } } });
  if (!lesson) return res.status(404).json({ error: 'Aula não encontrada' });
  await prisma.lesson.delete({ where: { id: lesson.id } });
  res.json({ ok: true });
}));

// ---- Vendas / dashboard do produtor ----
router.get('/me/dashboard', authMiddleware, proOnly(async (req, res) => {
  const proId = req.pro.id;
  const products = await prisma.digitalProduct.findMany({ where: { professionalId: proId }, select: { id: true } });
  const ids = products.map((p) => p.id);
  const [paidAgg, waitingAgg, studentCount, productCount] = await Promise.all([
    prisma.digitalSale.aggregate({ where: { productId: { in: ids }, status: 'paid' }, _sum: { amount: true, producerAmount: true }, _count: true }),
    prisma.digitalSale.aggregate({ where: { productId: { in: ids }, status: 'waiting_payment' }, _sum: { amount: true }, _count: true }),
    prisma.enrollment.count({ where: { productId: { in: ids }, status: 'active' } }),
    prisma.digitalProduct.count({ where: { professionalId: proId } }),
  ]);
  res.json({
    productCount,
    studentCount,
    paidCount: paidAgg._count || 0,
    grossPaid: paidAgg._sum.amount || 0,
    netPaid: paidAgg._sum.producerAmount || 0,
    waitingCount: waitingAgg._count || 0,
    waitingAmount: waitingAgg._sum.amount || 0,
  });
}));

router.get('/me/products/:id/sales', authMiddleware, proOnly(async (req, res) => {
  const product = await getMyProduct(req, req.params.id);
  if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
  const where = { productId: product.id };
  if (req.query.status && SALE_STATUS.includes(String(req.query.status))) where.status = String(req.query.status);
  const sales = await prisma.digitalSale.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
  res.json(sales);
}));

// produtor confirma pagamento manual (off_platform)
router.post('/me/sales/:id/confirm', authMiddleware, proOnly(async (req, res) => {
  const sale = await prisma.digitalSale.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!sale) return res.status(404).json({ error: 'Venda não encontrada' });
  const r = await markSalePaid(sale.id, { confirmedBy: 'producer' });
  res.json(r.sale);
}));

// ---- Afiliados dos meus produtos (aprovar/rejeitar) ----
router.get('/me/affiliates', authMiddleware, proOnly(async (req, res) => {
  const links = await prisma.affiliateLink.findMany({
    where: { product: { professionalId: req.pro.id } },
    orderBy: { createdAt: 'desc' },
    include: { affiliate: { select: { id: true, name: true, email: true } }, product: { select: { id: true, title: true } } },
  });
  res.json(links);
}));
router.post('/me/affiliate-links/:id/approve', authMiddleware, proOnly(async (req, res) => {
  const link = await prisma.affiliateLink.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!link) return res.status(404).json({ error: 'Link não encontrado' });
  res.json(await prisma.affiliateLink.update({ where: { id: link.id }, data: { status: 'approved' } }));
}));
router.post('/me/affiliate-links/:id/reject', authMiddleware, proOnly(async (req, res) => {
  const link = await prisma.affiliateLink.findFirst({ where: { id: req.params.id, product: { professionalId: req.pro.id } } });
  if (!link) return res.status(404).json({ error: 'Link não encontrado' });
  res.json(await prisma.affiliateLink.update({ where: { id: link.id }, data: { status: 'rejected' } }));
}));

// =====================================================================
// AFILIADO (autenticado)
// =====================================================================
async function getMyAffiliate(req) {
  return prisma.affiliate.findUnique({ where: { userId: req.userId } });
}

router.post('/affiliate/me', authMiddleware, async (req, res) => {
  try {
    let aff = await getMyAffiliate(req);
    if (aff) return res.json(aff);
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    const b = req.body || {};
    aff = await prisma.affiliate.create({
      data: { userId: req.userId, name: b.name || user.name, email: b.email || user.email || null, phone: b.phone || user.phone || null, pixKey: b.pixKey || null },
    });
    res.status(201).json(aff);
  } catch (err) {
    console.error('[infoproducts] affiliate create', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/affiliate/me', authMiddleware, async (req, res) => {
  const aff = await getMyAffiliate(req);
  if (!aff) return res.status(404).json({ error: 'Você ainda não é afiliado (POST /affiliate/me)' });
  res.json(aff);
});

router.put('/affiliate/me', authMiddleware, async (req, res) => {
  const aff = await getMyAffiliate(req);
  if (!aff) return res.status(404).json({ error: 'Você ainda não é afiliado' });
  const b = req.body || {};
  const data = {};
  for (const f of ['name', 'email', 'phone', 'pixKey']) if (b[f] !== undefined) data[f] = b[f];
  res.json(await prisma.affiliate.update({ where: { id: aff.id }, data }));
});

// vitrine de produtos pra afiliar
router.get('/affiliate/marketplace', authMiddleware, async (req, res) => {
  const products = await prisma.digitalProduct.findMany({
    where: { status: 'published', visible: true, affiliateEnabled: true },
    orderBy: { salesCount: 'desc' },
    take: 100,
    include: { professional: { select: { displayName: true, avatarUrl: true } } },
  });
  res.json(products.map((p) => ({
    id: p.id, slug: p.slug, title: p.title, subtitle: p.subtitle, coverUrl: p.coverUrl,
    price: p.price, type: p.type, affiliateCommissionPct: p.affiliateCommissionPct,
    producer: p.professional, salesCount: p.salesCount,
  })));
});

// afiliar-se a um produto (gera link)
router.post('/affiliate/products/:productId/join', authMiddleware, async (req, res) => {
  try {
    const aff = await getMyAffiliate(req);
    if (!aff) return res.status(404).json({ error: 'Vire afiliado primeiro (POST /affiliate/me)' });
    const product = await prisma.digitalProduct.findUnique({ where: { id: req.params.productId } });
    if (!product || !product.affiliateEnabled) return res.status(404).json({ error: 'Produto não disponível para afiliação' });
    const existing = await prisma.affiliateLink.findUnique({ where: { affiliateId_productId: { affiliateId: aff.id, productId: product.id } } });
    if (existing) return res.json(existing);
    const link = await prisma.affiliateLink.create({
      data: { affiliateId: aff.id, productId: product.id, code: shortCode(8), commissionPct: product.affiliateCommissionPct, status: product.affiliateAutoApprove ? 'approved' : 'pending' },
    });
    res.status(201).json(link);
  } catch (err) {
    console.error('[infoproducts] affiliate join', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/affiliate/links', authMiddleware, async (req, res) => {
  const aff = await getMyAffiliate(req);
  if (!aff) return res.status(404).json({ error: 'Você ainda não é afiliado' });
  const links = await prisma.affiliateLink.findMany({
    where: { affiliateId: aff.id }, orderBy: { createdAt: 'desc' },
    include: { product: { select: { id: true, slug: true, title: true, coverUrl: true, price: true } } },
  });
  res.json(links);
});

router.get('/affiliate/commissions', authMiddleware, async (req, res) => {
  const aff = await getMyAffiliate(req);
  if (!aff) return res.status(404).json({ error: 'Você ainda não é afiliado' });
  const commissions = await prisma.affiliateCommission.findMany({
    where: { affiliateId: aff.id }, orderBy: { createdAt: 'desc' }, take: 200,
    include: { sale: { select: { id: true, buyerName: true, amount: true, createdAt: true, product: { select: { title: true } } } } },
  });
  res.json(commissions);
});

// saque de comissão (off_platform: registra pedido; on_platform: TODO transferência PSP)
router.post('/affiliate/payout', authMiddleware, async (req, res) => {
  const aff = await getMyAffiliate(req);
  if (!aff) return res.status(404).json({ error: 'Você ainda não é afiliado' });
  if (aff.commissionPending <= 0) return res.status(400).json({ error: 'Sem comissão disponível' });
  if (!aff.pixKey) return res.status(400).json({ error: 'Cadastre sua chave Pix antes de sacar' });
  const payout = await prisma.payout.create({
    data: { affiliateId: aff.id, payeeType: 'affiliate', amount: aff.commissionPending, pixKey: aff.pixKey, status: 'requested' },
  });
  res.status(201).json(payout);
});

// =====================================================================
// PÚBLICO (sem auth) — página de vendas, checkout, recibo
// =====================================================================

// dados da página de vendas: /api/infoproducts/public/:slug
router.get('/public/:slug', async (req, res) => {
  try {
    const product = await prisma.digitalProduct.findUnique({
      where: { slug: req.params.slug },
      include: {
        professional: { select: { displayName: true, avatarUrl: true, slug: true, verified: true, headline: true } },
        modules: { orderBy: { order: 'asc' }, include: { lessons: { orderBy: { order: 'asc' }, select: { id: true, title: true, durationSec: true, free: true } } } },
      },
    });
    if (!product || product.status !== 'published') return res.status(404).json({ error: 'Produto não encontrado' });
    const lessonCount = product.modules.reduce((n, m) => n + m.lessons.length, 0);
    res.json({
      id: product.id, slug: product.slug, title: product.title, subtitle: product.subtitle,
      description: product.description, coverUrl: product.coverUrl, type: product.type,
      price: product.price, comparePrice: product.comparePrice, recurrence: product.recurrence,
      allowPix: product.allowPix, allowCard: product.allowCard, allowBoleto: product.allowBoleto,
      installmentsMax: product.installmentsMax, guaranteeDays: product.guaranteeDays,
      hasMembersArea: product.hasMembersArea, lessonCount,
      producer: product.professional,
      modules: product.modules.map((m) => ({
        id: m.id, title: m.title, description: m.description,
        lessons: m.lessons.map((l) => ({ id: l.id, title: l.title, durationSec: l.durationSec, free: l.free })),
      })),
    });
  } catch (err) {
    console.error('[infoproducts] public', err);
    res.status(500).json({ error: err.message });
  }
});

// checkout: cria a venda + gera cobrança (Pix off-platform ou Asaas split)
router.post('/checkout', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.productSlug) return res.status(400).json({ error: 'productSlug obrigatório' });
    const buyer = b.buyer || {};
    if (!buyer.name) return res.status(400).json({ error: 'buyer.name obrigatório' });

    const product = await prisma.digitalProduct.findUnique({ where: { slug: b.productSlug }, include: { professional: true } });
    if (!product || product.status !== 'published') return res.status(404).json({ error: 'Produto não encontrado' });

    const method = ['pix', 'card', 'boleto'].includes(b.method) ? b.method : 'pix';
    const installments = method === 'card' ? Math.max(1, Math.min(product.installmentsMax, Number(b.installments) || 1)) : 1;

    // atribuição de afiliado (via código do link)
    let affiliate = null;
    let affiliateCode = null;
    if (b.ref) {
      const link = await prisma.affiliateLink.findUnique({ where: { code: String(b.ref) }, include: { affiliate: true } });
      if (link && link.productId === product.id && link.status === 'approved') {
        affiliate = { id: link.affiliate.id, asaasWalletId: link.affiliate.asaasWalletId, commissionPct: link.commissionPct };
        affiliateCode = link.code;
      }
    }

    // vincula comprador a usuário TenisCash pelo telefone (cashback no loop)
    let userId = null;
    if (buyer.phone) {
      const u = await prisma.user.findUnique({ where: { phone: String(buyer.phone) } }).catch(() => null);
      if (u) userId = u.id;
    }

    const publicToken = generatePublicToken();

    // produto grátis (isca): libera acesso na hora, sem cobrança
    if (!product.price || product.price <= 0) {
      const sale = await prisma.digitalSale.create({
        data: {
          productId: product.id, userId, buyerName: buyer.name, buyerEmail: buyer.email || null, buyerPhone: buyer.phone || null,
          affiliateId: affiliate ? affiliate.id : null, affiliateCode,
          amount: 0, producerAmount: 0, settlementMode: 'off_platform', method: 'free', status: 'paid',
          publicToken, paidAt: new Date(),
        },
      });
      const enr = await prisma.enrollment.create({
        data: { productId: product.id, userId, buyerName: buyer.name, buyerEmail: buyer.email || null, buyerPhone: buyer.phone || null, saleId: sale.id, accessToken: generatePublicToken() },
      });
      await prisma.digitalProduct.update({ where: { id: product.id }, data: { salesCount: { increment: 1 } } });
      return res.status(201).json({ free: true, saleToken: publicToken, accessToken: enr.accessToken });
    }

    // cria a venda "aguardando pagamento" e gera a cobrança
    const baseSale = await prisma.digitalSale.create({
      data: {
        productId: product.id, userId, buyerName: buyer.name, buyerEmail: buyer.email || null, buyerPhone: buyer.phone || null,
        affiliateId: affiliate ? affiliate.id : null, affiliateCode,
        amount: product.price, settlementMode: 'off_platform', method, installments, status: 'waiting_payment', publicToken,
      },
    });

    const charge = await payments.createSaleCharge({
      product, professional: product.professional, sale: baseSale, affiliate,
      buyer: { name: buyer.name, email: buyer.email, phone: buyer.phone }, method, installments,
    });

    const sale = await prisma.digitalSale.update({
      where: { id: baseSale.id },
      data: {
        settlementMode: charge.settlementMode, method: charge.method, installments: charge.installments,
        producerAmount: charge.producerAmount, affiliateAmount: charge.affiliateAmount,
        platformFee: charge.platformFee, cashbackAmount: charge.cashbackAmount,
        pixPayload: charge.pixPayload, pixQrUrl: charge.pixQrUrl,
        pspProvider: charge.pspProvider, pspChargeId: charge.pspChargeId, pspInvoiceUrl: charge.pspInvoiceUrl,
        dueDate: charge.dueDate,
      },
    });

    // afiliado registra clique->venda (atribuição)
    res.status(201).json({
      saleToken: sale.publicToken,
      amount: sale.amount, method: sale.method, status: sale.status,
      pixPayload: sale.pixPayload, pixQrUrl: sale.pixQrUrl, pspInvoiceUrl: sale.pspInvoiceUrl,
      settlementMode: sale.settlementMode,
    });
  } catch (err) {
    console.error('[infoproducts] checkout', err);
    res.status(500).json({ error: err.message });
  }
});

// status da venda (polling do checkout) + recibo
router.get('/sale/:token', async (req, res) => {
  try {
    const sale = await prisma.digitalSale.findUnique({
      where: { publicToken: req.params.token },
      include: { product: { select: { title: true, slug: true, hasMembersArea: true, professional: { select: { displayName: true, avatarUrl: true } } } } },
    });
    if (!sale) return res.status(404).json({ error: 'Venda não encontrada' });
    let accessToken = null;
    if (sale.status === 'paid') {
      const enr = await prisma.enrollment.findFirst({ where: { saleId: sale.id }, select: { accessToken: true } });
      accessToken = enr ? enr.accessToken : null;
    }
    res.json({
      amount: sale.amount, status: sale.status, method: sale.method, settlementMode: sale.settlementMode,
      pixPayload: sale.pixPayload, pixQrUrl: sale.pixQrUrl, pspInvoiceUrl: sale.pspInvoiceUrl, paidAt: sale.paidAt,
      product: sale.product, accessToken,
    });
  } catch (err) {
    console.error('[infoproducts] sale status', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ÁREA DE MEMBROS (aluno) — acesso por accessToken, sem login
// =====================================================================
router.get('/enrollment/:token', async (req, res) => {
  try {
    const enr = await prisma.enrollment.findUnique({
      where: { accessToken: req.params.token },
      include: {
        product: {
          include: {
            professional: { select: { displayName: true, avatarUrl: true } },
            modules: { orderBy: { order: 'asc' }, include: { lessons: { orderBy: { order: 'asc' } } } },
          },
        },
        lessonProgress: true,
        certificate: true,
      },
    });
    if (!enr) return res.status(404).json({ error: 'Acesso não encontrado' });
    if (enr.status !== 'active') return res.status(403).json({ error: 'Acesso ' + enr.status });
    if (enr.expiresAt && enr.expiresAt < new Date()) return res.status(403).json({ error: 'Acesso expirado' });
    await prisma.enrollment.update({ where: { id: enr.id }, data: { lastAccessAt: new Date() } }).catch(() => {});

    const doneIds = new Set(enr.lessonProgress.filter((p) => p.completed).map((p) => p.lessonId));
    res.json({
      buyerName: enr.buyerName,
      progressPct: enr.progressPct,
      completedAt: enr.completedAt,
      certificate: enr.certificate,
      product: {
        title: enr.product.title, coverUrl: enr.product.coverUrl, type: enr.product.type,
        producer: enr.product.professional,
        modules: enr.product.modules.map((m) => ({
          id: m.id, title: m.title, description: m.description,
          lessons: m.lessons.map((l) => ({
            id: l.id, title: l.title, description: l.description, videoUrl: l.videoUrl, videoProvider: l.videoProvider,
            durationSec: l.durationSec, contentHtml: l.contentHtml, attachmentUrl: l.attachmentUrl,
            completed: doneIds.has(l.id),
          })),
        })),
      },
    });
  } catch (err) {
    console.error('[infoproducts] enrollment', err);
    res.status(500).json({ error: err.message });
  }
});

// marca/desmarca aula concluída + recalcula progresso
router.post('/enrollment/:token/lessons/:lessonId/progress', async (req, res) => {
  try {
    const enr = await prisma.enrollment.findUnique({ where: { accessToken: req.params.token }, include: { product: { include: { modules: { include: { lessons: { select: { id: true } } } } } } } });
    if (!enr) return res.status(404).json({ error: 'Acesso não encontrado' });
    const lessonId = req.params.lessonId;
    const allLessonIds = enr.product.modules.flatMap((m) => m.lessons.map((l) => l.id));
    if (!allLessonIds.includes(lessonId)) return res.status(404).json({ error: 'Aula não pertence a este curso' });
    const completed = req.body && req.body.completed === false ? false : true;

    await prisma.lessonProgress.upsert({
      where: { enrollmentId_lessonId: { enrollmentId: enr.id, lessonId } },
      create: { enrollmentId: enr.id, lessonId, completed, watchedSec: Number(req.body?.watchedSec) || 0, completedAt: completed ? new Date() : null },
      update: { completed, completedAt: completed ? new Date() : null, watchedSec: req.body?.watchedSec != null ? Number(req.body.watchedSec) : undefined },
    });

    const doneCount = await prisma.lessonProgress.count({ where: { enrollmentId: enr.id, completed: true } });
    const total = allLessonIds.length || 1;
    const pct = Math.round((doneCount / total) * 100);
    const finished = pct >= 100;
    await prisma.enrollment.update({ where: { id: enr.id }, data: { progressPct: pct, completedAt: finished ? new Date() : null } });

    res.json({ progressPct: pct, completed: finished });
  } catch (err) {
    console.error('[infoproducts] progress', err);
    res.status(500).json({ error: err.message });
  }
});

// emite certificado (quando 100%)
router.post('/enrollment/:token/certificate', async (req, res) => {
  try {
    const enr = await prisma.enrollment.findUnique({ where: { accessToken: req.params.token }, include: { product: true, certificate: true } });
    if (!enr) return res.status(404).json({ error: 'Acesso não encontrado' });
    if (enr.certificate) return res.json(enr.certificate);
    if (enr.progressPct < 100) return res.status(400).json({ error: 'Conclua 100% do curso para emitir o certificado' });
    const cert = await prisma.certificate.create({
      data: { enrollmentId: enr.id, productId: enr.productId, code: shortCode(10), recipientName: enr.buyerName, courseTitle: enr.product.title },
    });
    await prisma.enrollment.update({ where: { id: enr.id }, data: { certificateIssued: true } });
    res.status(201).json(cert);
  } catch (err) {
    console.error('[infoproducts] certificate', err);
    res.status(500).json({ error: err.message });
  }
});

// verificação pública de certificado: /api/infoproducts/cert/:code
router.get('/cert/:code', async (req, res) => {
  const cert = await prisma.certificate.findUnique({
    where: { code: req.params.code },
    include: { product: { select: { title: true, professional: { select: { displayName: true } } } } },
  });
  if (!cert) return res.status(404).json({ error: 'Certificado não encontrado' });
  res.json({ code: cert.code, recipientName: cert.recipientName, courseTitle: cert.courseTitle, issuedAt: cert.issuedAt, producer: cert.product.professional.displayName });
});

// minhas compras (autenticado)
router.get('/my/purchases', authMiddleware, async (req, res) => {
  const enrollments = await prisma.enrollment.findMany({
    where: { userId: req.userId, status: 'active' }, orderBy: { createdAt: 'desc' },
    include: { product: { select: { title: true, coverUrl: true, type: true } } },
  });
  res.json(enrollments.map((e) => ({ accessToken: e.accessToken, progressPct: e.progressPct, product: e.product, createdAt: e.createdAt })));
});

// =====================================================================
// WEBHOOK PSP (Asaas) — confirma pagamento on_platform
// =====================================================================
router.post('/webhook/asaas', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const asaas = require('../services/psp/asaas');
    if (!asaas.verifyWebhook(req)) return res.status(401).json({ error: 'invalid token' });
    const event = req.body || {};
    const eventType = event.event || 'unknown';
    const payment = event.payment || {};
    const externalId = `asaas:${eventType}:${payment.id || event.id || shortCode(12)}`;

    // idempotência
    const dup = await prisma.webhookEvent.findUnique({ where: { externalId } }).catch(() => null);
    if (dup && dup.processed) return res.json({ ok: true, duplicate: true });
    if (!dup) {
      await prisma.webhookEvent.create({ data: { provider: 'asaas', eventType, externalId, payload: JSON.stringify(event) } }).catch(() => {});
    }

    const saleId = payment.externalReference;
    if (saleId && (eventType === 'PAYMENT_CONFIRMED' || eventType === 'PAYMENT_RECEIVED')) {
      await markSalePaid(saleId, { confirmedBy: 'platform' }).catch((e) => console.error('[asaas webhook] markPaid', e));
    } else if (saleId && (eventType === 'PAYMENT_REFUNDED' || eventType === 'PAYMENT_CHARGEBACK_REQUESTED')) {
      await prisma.digitalSale.update({ where: { id: saleId }, data: { status: eventType === 'PAYMENT_REFUNDED' ? 'refunded' : 'chargeback', refundedAt: new Date() } }).catch(() => {});
      const enr = await prisma.enrollment.findFirst({ where: { saleId } });
      if (enr) await prisma.enrollment.update({ where: { id: enr.id }, data: { status: 'refunded' } }).catch(() => {});
    }

    await prisma.webhookEvent.update({ where: { externalId }, data: { processed: true } }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[infoproducts] webhook', err);
    res.json({ ok: true }); // 200 sempre: PSP não deve reenviar em loop por erro nosso
  }
});

// =====================================================================
// ADMIN (plataforma) — visão de cima de TODOS os produtores/vendas
// =====================================================================
router.get('/admin/overview', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const [productCount, publishedCount, paidAgg, waitingAgg, enrollCount, affCount, producersRaw] = await Promise.all([
      prisma.digitalProduct.count(),
      prisma.digitalProduct.count({ where: { status: 'published' } }),
      prisma.digitalSale.aggregate({ where: { status: 'paid' }, _sum: { amount: true, platformFee: true, cashbackAmount: true, affiliateAmount: true }, _count: true }),
      prisma.digitalSale.aggregate({ where: { status: 'waiting_payment' }, _sum: { amount: true }, _count: true }),
      prisma.enrollment.count({ where: { status: 'active' } }),
      prisma.affiliate.count(),
      prisma.digitalProduct.findMany({ distinct: ['professionalId'], select: { professionalId: true } }),
    ]);
    let payoutPending = { _sum: { amount: null }, _count: 0 };
    try { payoutPending = await prisma.payout.aggregate({ where: { status: 'pending' }, _sum: { amount: true }, _count: true }); } catch (_) {}
    res.json({
      products: productCount,
      published: publishedCount,
      producers: producersRaw.length,
      gmv: paidAgg._sum.amount || 0,
      paidSales: paidAgg._count || 0,
      platformFee: paidAgg._sum.platformFee || 0,
      cashback: paidAgg._sum.cashbackAmount || 0,
      affiliateComm: paidAgg._sum.affiliateAmount || 0,
      waitingSales: waitingAgg._count || 0,
      waitingAmount: waitingAgg._sum.amount || 0,
      enrollments: enrollCount,
      affiliates: affCount,
      payoutPending: payoutPending._sum.amount || 0,
      payoutPendingCount: payoutPending._count || 0,
    });
  } catch (err) {
    console.error('[infoproducts] admin overview', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/products', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.q) where.title = { contains: String(req.query.q), mode: 'insensitive' };
    const products = await prisma.digitalProduct.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 300,
      include: { professional: { select: { displayName: true, slug: true } }, _count: { select: { sales: true, enrollments: true } } },
    });
    res.json(products.map((p) => ({
      id: p.id, title: p.title, slug: p.slug, type: p.type, price: p.price, status: p.status, visible: p.visible,
      producer: (p.professional && p.professional.displayName) || '—', producerSlug: p.professional && p.professional.slug,
      salesCount: p._count.sales, enrollments: p._count.enrollments, createdAt: p.createdAt,
    })));
  } catch (err) {
    console.error('[infoproducts] admin products', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/sales', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = String(req.query.status);
    const sales = await prisma.digitalSale.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 300,
      include: { product: { select: { title: true, professional: { select: { displayName: true } } } } },
    });
    res.json(sales.map((s) => ({
      id: s.id, buyerName: s.buyerName, amount: s.amount, status: s.status, method: s.method, settlementMode: s.settlementMode,
      product: (s.product && s.product.title) || '—',
      producer: (s.product && s.product.professional && s.product.professional.displayName) || '—',
      affiliateCode: s.affiliateCode, createdAt: s.createdAt, paidAt: s.paidAt,
    })));
  } catch (err) {
    console.error('[infoproducts] admin sales', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/producers', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const products = await prisma.digitalProduct.findMany({
      select: { professionalId: true, status: true, salesCount: true, professional: { select: { displayName: true, slug: true } } },
    });
    const map = new Map();
    for (const p of products) {
      if (!map.has(p.professionalId)) {
        map.set(p.professionalId, { id: p.professionalId, name: (p.professional && p.professional.displayName) || '—', slug: p.professional && p.professional.slug, products: 0, published: 0, sales: 0 });
      }
      const e = map.get(p.professionalId);
      e.products++;
      if (p.status === 'published') e.published++;
      e.sales += p.salesCount || 0;
    }
    res.json(Array.from(map.values()).sort((a, b) => b.sales - a.sales));
  } catch (err) {
    console.error('[infoproducts] admin producers', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
