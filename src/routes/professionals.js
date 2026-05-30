// =====================================================================
// PROFISSIONAL ESPORTIVO — card público + gestão + cobrança
// ---------------------------------------------------------------------
// Wedge: o profissional ganha um perfil público ("card"), gerencia
// alunos e COBRA pelo app. COBRAR ≠ RECEBER: por padrão a cobrança é
// off_platform (Pix cai na conta DELE), sem trocar de PSP. Recebimento
// pela plataforma (split + cashback TenisCash) é upsell futuro.
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');
const { buildPixPayload, buildPixQrDataUrl, generatePublicToken, sanitize } = require('../services/pix');

const router = express.Router();

const OFFER_TYPES = ['class_presential', 'plan_monthly', 'digital_product', 'free_lead'];
const CHARGE_STATUS = ['pending', 'paid', 'overdue', 'cancelled', 'refunded'];
const CATEGORIES = ['personal', 'tennis', 'padel', 'physio', 'nutri', 'run', 'other'];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function slugify(s) {
  return (
    sanitize(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'pro'
  );
}

async function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 1;
  // colisão -> sufixo numérico
  while (await prisma.professional.findUnique({ where: { slug } })) {
    n += 1;
    slug = `${slugify(base)}-${n}`;
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
      if (!pro) return res.status(404).json({ error: 'Perfil profissional não encontrado. Crie com POST /api/professionals/me' });
      req.pro = pro;
      return handler(req, res);
    } catch (err) {
      console.error('[professionals]', err);
      return res.status(500).json({ error: err.message });
    }
  };
}

// =====================================================================
// CARD (perfil do profissional) — autenticado
// =====================================================================

// Vira profissional / cria o card
router.post('/me', authMiddleware, async (req, res) => {
  try {
    const existing = await getMyPro(req);
    if (existing) return res.json(existing);

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const b = req.body || {};
    const displayName = sanitize(b.displayName) || user.name;
    const slug = await uniqueSlug(b.slug || displayName);

    const pro = await prisma.professional.create({
      data: {
        userId: req.userId,
        slug,
        displayName,
        headline: b.headline || null,
        bio: b.bio || null,
        category: CATEGORIES.includes(b.category) ? b.category : null,
        city: b.city || user.city || null,
        state: b.state || user.state || null,
        whatsapp: b.whatsapp || user.phone || null,
        instagram: b.instagram || null,
        pixKey: b.pixKey || null,
        pixKeyType: b.pixKeyType || null,
        bankName: b.bankName || null,
      },
    });
    return res.status(201).json(pro);
  } catch (err) {
    console.error('[professionals] create', err);
    return res.status(500).json({ error: err.message });
  }
});

// Meu card
router.get('/me', authMiddleware, proOnly(async (req, res) => {
  res.json(req.pro);
}));

// Atualiza o card
router.put('/me', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  const data = {};
  for (const f of ['displayName', 'headline', 'bio', 'avatarUrl', 'coverUrl', 'city', 'state', 'whatsapp', 'instagram', 'pixKey', 'pixKeyType', 'bankName']) {
    if (b[f] !== undefined) data[f] = b[f];
  }
  if (b.category !== undefined) data.category = CATEGORIES.includes(b.category) ? b.category : null;
  if (b.published !== undefined) data.published = !!b.published;
  if (b.slug !== undefined && b.slug !== req.pro.slug) data.slug = await uniqueSlug(b.slug);

  const pro = await prisma.professional.update({ where: { id: req.pro.id }, data });
  res.json(pro);
}));

// Dashboard / resumo financeiro
router.get('/me/dashboard', authMiddleware, proOnly(async (req, res) => {
  const proId = req.pro.id;
  const [pendingAgg, paidAgg, overdueCount, clientCount, activeSubs] = await Promise.all([
    prisma.charge.aggregate({ where: { professionalId: proId, status: 'pending' }, _sum: { amount: true }, _count: true }),
    prisma.charge.aggregate({ where: { professionalId: proId, status: 'paid' }, _sum: { amount: true }, _count: true }),
    prisma.charge.count({ where: { professionalId: proId, status: 'overdue' } }),
    prisma.professionalClient.count({ where: { professionalId: proId } }),
    prisma.professionalSubscription.count({ where: { professionalId: proId, status: 'active' } }),
  ]);
  res.json({
    pro: req.pro,
    pendingAmount: pendingAgg._sum.amount || 0,
    pendingCount: pendingAgg._count || 0,
    paidAmount: paidAgg._sum.amount || 0,
    paidCount: paidAgg._count || 0,
    overdueCount,
    clientCount,
    activeSubscriptions: activeSubs,
  });
}));

// =====================================================================
// OFERTAS
// =====================================================================
router.get('/me/offers', authMiddleware, proOnly(async (req, res) => {
  const offers = await prisma.professionalOffer.findMany({ where: { professionalId: req.pro.id }, orderBy: { createdAt: 'desc' } });
  res.json(offers);
}));

router.post('/me/offers', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  if (!b.title) return res.status(400).json({ error: 'title obrigatório' });
  const type = OFFER_TYPES.includes(b.type) ? b.type : 'class_presential';
  const offer = await prisma.professionalOffer.create({
    data: {
      professionalId: req.pro.id,
      type,
      title: b.title,
      description: b.description || null,
      imageUrl: b.imageUrl || null,
      price: Number(b.price) || 0,
      recurrence: type === 'plan_monthly' ? b.recurrence || 'monthly' : null,
      durationMin: b.durationMin != null ? Number(b.durationMin) : null,
      visible: b.visible !== undefined ? !!b.visible : true,
    },
  });
  await prisma.professional.update({ where: { id: req.pro.id }, data: { offerCount: { increment: 1 } } });
  res.status(201).json(offer);
}));

router.put('/me/offers/:id', authMiddleware, proOnly(async (req, res) => {
  const offer = await prisma.professionalOffer.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
  const b = req.body || {};
  const data = {};
  for (const f of ['title', 'description', 'imageUrl', 'recurrence']) if (b[f] !== undefined) data[f] = b[f];
  if (b.price !== undefined) data.price = Number(b.price) || 0;
  if (b.durationMin !== undefined) data.durationMin = b.durationMin != null ? Number(b.durationMin) : null;
  if (b.active !== undefined) data.active = !!b.active;
  if (b.visible !== undefined) data.visible = !!b.visible;
  if (b.type !== undefined && OFFER_TYPES.includes(b.type)) data.type = b.type;
  const updated = await prisma.professionalOffer.update({ where: { id: offer.id }, data });
  res.json(updated);
}));

router.delete('/me/offers/:id', authMiddleware, proOnly(async (req, res) => {
  const offer = await prisma.professionalOffer.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!offer) return res.status(404).json({ error: 'Oferta não encontrada' });
  await prisma.professionalOffer.delete({ where: { id: offer.id } });
  await prisma.professional.update({ where: { id: req.pro.id }, data: { offerCount: { decrement: 1 } } });
  res.json({ ok: true });
}));

// =====================================================================
// CLIENTES (alunos) — ficha vale mesmo sem cadastro no app
// =====================================================================
router.get('/me/clients', authMiddleware, proOnly(async (req, res) => {
  const where = { professionalId: req.pro.id };
  if (req.query.status) where.status = String(req.query.status);
  const clients = await prisma.professionalClient.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json(clients);
}));

router.post('/me/clients', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
  let userId = null;
  // vincula a um usuário TenisCash se o telefone bater
  if (b.phone) {
    const u = await prisma.user.findUnique({ where: { phone: String(b.phone) } }).catch(() => null);
    if (u) userId = u.id;
  }
  const client = await prisma.professionalClient.create({
    data: {
      professionalId: req.pro.id,
      userId,
      name: b.name,
      phone: b.phone || null,
      email: b.email || null,
      notes: b.notes || null,
      tags: Array.isArray(b.tags) ? b.tags : [],
      status: ['active', 'inactive', 'lead'].includes(b.status) ? b.status : 'active',
    },
  });
  await prisma.professional.update({ where: { id: req.pro.id }, data: { clientCount: { increment: 1 } } });
  res.status(201).json(client);
}));

router.get('/me/clients/:id', authMiddleware, proOnly(async (req, res) => {
  const client = await prisma.professionalClient.findFirst({
    where: { id: req.params.id, professionalId: req.pro.id },
    include: { charges: { orderBy: { createdAt: 'desc' } }, subscriptions: true },
  });
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
  res.json(client);
}));

router.put('/me/clients/:id', authMiddleware, proOnly(async (req, res) => {
  const client = await prisma.professionalClient.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
  const b = req.body || {};
  const data = {};
  for (const f of ['name', 'phone', 'email', 'notes']) if (b[f] !== undefined) data[f] = b[f];
  if (Array.isArray(b.tags)) data.tags = b.tags;
  if (b.status !== undefined && ['active', 'inactive', 'lead'].includes(b.status)) data.status = b.status;
  const updated = await prisma.professionalClient.update({ where: { id: client.id }, data });
  res.json(updated);
}));

// =====================================================================
// COBRANÇA (charges) — o coração do wedge
// =====================================================================
router.get('/me/charges', authMiddleware, proOnly(async (req, res) => {
  const where = { professionalId: req.pro.id };
  if (req.query.status && CHARGE_STATUS.includes(String(req.query.status))) where.status = String(req.query.status);
  if (req.query.clientId) where.clientId = String(req.query.clientId);
  const charges = await prisma.charge.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    include: { client: { select: { id: true, name: true } } },
  });
  res.json(charges);
}));

// Cria cobrança. Se method=pix + off_platform + tem chave Pix => gera BR Code.
router.post('/me/charges', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });
  if (!b.description) return res.status(400).json({ error: 'description obrigatória' });

  let client = null;
  if (b.clientId) {
    client = await prisma.professionalClient.findFirst({ where: { id: b.clientId, professionalId: req.pro.id } });
    if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });
  }

  const settlementMode = b.settlementMode === 'on_platform' ? 'on_platform' : 'off_platform';
  const method = b.method || 'pix';
  const publicToken = generatePublicToken();

  let pixPayload = null;
  let pixQrUrl = null;
  // Pix off-platform: gera o "copia e cola" da chave do PROFISSIONAL
  if (method === 'pix' && settlementMode === 'off_platform' && req.pro.pixKey) {
    pixPayload = buildPixPayload({
      pixKey: req.pro.pixKey,
      merchantName: req.pro.displayName,
      merchantCity: req.pro.city || 'BRASIL',
      amount,
      txid: publicToken,
    });
    pixQrUrl = await buildPixQrDataUrl(pixPayload);
  }

  const charge = await prisma.$transaction(async (tx) => {
    const c = await tx.charge.create({
      data: {
        professionalId: req.pro.id,
        clientId: client ? client.id : null,
        offerId: b.offerId || null,
        subscriptionId: b.subscriptionId || null,
        amount,
        description: b.description,
        settlementMode,
        method,
        status: 'pending',
        dueDate: b.dueDate ? new Date(b.dueDate) : null,
        pixPayload,
        pixQrUrl,
        publicToken,
      },
    });
    await tx.professional.update({ where: { id: req.pro.id }, data: { totalBilled: { increment: amount } } });
    if (client) {
      await tx.professionalClient.update({
        where: { id: client.id },
        data: { totalBilled: { increment: amount }, lastChargeAt: new Date() },
      });
    }
    return c;
  });

  res.status(201).json(charge);
}));

// Marca cobrança como paga (confirmação manual do profissional — off_platform)
router.post('/me/charges/:id/pay', authMiddleware, proOnly(async (req, res) => {
  const charge = await prisma.charge.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!charge) return res.status(404).json({ error: 'Cobrança não encontrada' });
  if (charge.status === 'paid') return res.json(charge);
  if (charge.status === 'cancelled' || charge.status === 'refunded') {
    return res.status(400).json({ error: `Cobrança ${charge.status} não pode ser paga` });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const c = await tx.charge.update({
      where: { id: charge.id },
      data: { status: 'paid', paidAt: new Date(), paidConfirmedBy: req.body?.confirmedBy || 'manual' },
    });
    await tx.professional.update({ where: { id: req.pro.id }, data: { totalPaid: { increment: charge.amount } } });
    if (charge.clientId) {
      await tx.professionalClient.update({ where: { id: charge.clientId }, data: { totalPaid: { increment: charge.amount } } });
    }
    return c;
  });
  res.json(updated);
}));

// Cancela cobrança
router.post('/me/charges/:id/cancel', authMiddleware, proOnly(async (req, res) => {
  const charge = await prisma.charge.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!charge) return res.status(404).json({ error: 'Cobrança não encontrada' });
  if (charge.status === 'paid') return res.status(400).json({ error: 'Cobrança paga não pode ser cancelada (use estorno)' });
  const updated = await prisma.charge.update({ where: { id: charge.id }, data: { status: 'cancelled' } });
  res.json(updated);
}));

// =====================================================================
// PLANOS (assinaturas recorrentes)
// =====================================================================
router.get('/me/subscriptions', authMiddleware, proOnly(async (req, res) => {
  const subs = await prisma.professionalSubscription.findMany({
    where: { professionalId: req.pro.id },
    orderBy: { createdAt: 'desc' },
    include: { client: { select: { id: true, name: true } } },
  });
  res.json(subs);
}));

router.post('/me/subscriptions', authMiddleware, proOnly(async (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!b.clientId) return res.status(400).json({ error: 'clientId obrigatório' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount inválido' });
  const client = await prisma.professionalClient.findFirst({ where: { id: b.clientId, professionalId: req.pro.id } });
  if (!client) return res.status(404).json({ error: 'Cliente não encontrado' });

  const dayOfMonth = b.dayOfMonth ? Math.min(28, Math.max(1, Number(b.dayOfMonth))) : null;
  const nextDueDate = b.nextDueDate ? new Date(b.nextDueDate) : computeNextDue(dayOfMonth);

  const sub = await prisma.professionalSubscription.create({
    data: {
      professionalId: req.pro.id,
      clientId: client.id,
      offerId: b.offerId || null,
      title: b.title || 'Plano mensal',
      amount,
      recurrence: b.recurrence === 'weekly' ? 'weekly' : 'monthly',
      dayOfMonth,
      nextDueDate,
    },
  });
  res.status(201).json(sub);
}));

router.post('/me/subscriptions/:id/cancel', authMiddleware, proOnly(async (req, res) => {
  const sub = await prisma.professionalSubscription.findFirst({ where: { id: req.params.id, professionalId: req.pro.id } });
  if (!sub) return res.status(404).json({ error: 'Assinatura não encontrada' });
  const updated = await prisma.professionalSubscription.update({
    where: { id: sub.id },
    data: { status: 'cancelled', cancelledAt: new Date() },
  });
  res.json(updated);
}));

function computeNextDue(dayOfMonth) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), dayOfMonth || now.getDate());
  if (d <= now) d.setMonth(d.getMonth() + 1);
  return d;
}

// =====================================================================
// PÚBLICO (sem auth)
// =====================================================================

// Card público: /api/professionals/public/:slug
router.get('/public/:slug', async (req, res) => {
  try {
    const pro = await prisma.professional.findUnique({ where: { slug: req.params.slug } });
    if (!pro || !pro.published) return res.status(404).json({ error: 'Card não encontrado' });
    const offers = await prisma.professionalOffer.findMany({
      where: { professionalId: pro.id, active: true, visible: true },
      orderBy: { price: 'asc' },
    });
    res.json({
      slug: pro.slug,
      displayName: pro.displayName,
      headline: pro.headline,
      bio: pro.bio,
      avatarUrl: pro.avatarUrl,
      coverUrl: pro.coverUrl,
      category: pro.category,
      city: pro.city,
      state: pro.state,
      whatsapp: pro.whatsapp,
      instagram: pro.instagram,
      verified: pro.verified,
      offers: offers.map((o) => ({
        id: o.id, type: o.type, title: o.title, description: o.description,
        imageUrl: o.imageUrl, price: o.price, recurrence: o.recurrence, durationMin: o.durationMin,
      })),
    });
  } catch (err) {
    console.error('[professionals] public card', err);
    res.status(500).json({ error: err.message });
  }
});

// Página pública de cobrança: /api/professionals/charge/:token
router.get('/charge/:token', async (req, res) => {
  try {
    const charge = await prisma.charge.findUnique({
      where: { publicToken: req.params.token },
      include: { professional: { select: { displayName: true, avatarUrl: true, city: true, verified: true } } },
    });
    if (!charge) return res.status(404).json({ error: 'Cobrança não encontrada' });
    res.json({
      amount: charge.amount,
      description: charge.description,
      status: charge.status,
      method: charge.method,
      dueDate: charge.dueDate,
      pixPayload: charge.pixPayload,
      pixQrUrl: charge.pixQrUrl,
      paidAt: charge.paidAt,
      professional: charge.professional,
    });
  } catch (err) {
    console.error('[professionals] public charge', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
