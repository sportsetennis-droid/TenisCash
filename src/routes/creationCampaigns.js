const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

/* ========================================================================
   CAMPANHAS DE CREATION — briefing + entregáveis + retainer
   ------------------------------------------------------------------------
   Extensão do Programa de Parceiros (Partner = Creation). Contrata um Creation
   por campanha pagando por comissão (já roda via cupom), valor mensal fixo
   (retainer) ou híbrido. O retainer é liquidado via CreationPayout:
     - payoutMode=tenis_cash → credita partnerBalance (T$) + cria Transaction
     - payoutMode=pix_cash   → liquidação OFF-PLATFORM (só registra)
   ====================================================================== */

const PAYMENT_MODELS = ['commission', 'monthly_fee', 'hybrid'];
const PAYOUT_MODES = ['tenis_cash', 'pix_cash'];
const RECURRENCES = ['one_off', 'monthly'];
const CAMPAIGN_STATUS = ['proposed', 'active', 'paused', 'delivered', 'finished', 'cancelled'];
const PAYOUT_METHODS = ['tenis_cash', 'pix', 'cash', 'transfer'];

function adminOnly(req, res, next) {
  if (!['admin', 'superadmin', 'manager'].includes(req.userRole)) {
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

// YYYY-MM do mês corrente no fuso de Fortaleza (UTC-3 fixo, sem DST).
function currentMonthKeyBrazil() {
  const offsetMin = -180;
  const local = new Date(Date.now() + offsetMin * 60000);
  return local.getUTCFullYear() + '-' + String(local.getUTCMonth() + 1).padStart(2, '0');
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Normaliza a lista de entregáveis: [{ type, qty, done }]
function normalizeDeliverables(raw) {
  if (raw == null) return undefined; // não mexe
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { return undefined; }
  }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 50).map((d) => ({
    type: String(d?.type || 'item').trim().slice(0, 40),
    qty: Math.max(0, parseInt(d?.qty, 10) || 0),
    done: Math.max(0, parseInt(d?.done, 10) || 0),
  }));
}

function clampMoney(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? Number(n.toFixed(2)) : 0;
}

/* ========================================================================
   ADMIN — CRUD de campanhas
   ====================================================================== */

router.get('/admin/creation-campaigns', authMiddleware, adminOnly, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const partnerId = String(req.query.partnerId || '').trim();
    const where = {};
    if (status && CAMPAIGN_STATUS.includes(status)) where.status = status;
    if (partnerId) where.partnerId = partnerId;

    const campaigns = await prisma.creationCampaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: 500,
      include: {
        partner: {
          select: {
            id: true, couponCode: true, type: true, tier: true, commissionPct: true,
            user: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });
    res.json({ campaigns });
  } catch (err) {
    console.error('admin/creation-campaigns list', err);
    res.status(500).json({ error: 'Erro ao listar campanhas' });
  }
});

router.get('/admin/creation-campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const campaign = await prisma.creationCampaign.findUnique({
      where: { id: req.params.id },
      include: {
        partner: {
          select: {
            id: true, couponCode: true, type: true, tier: true, commissionPct: true,
            user: { select: { id: true, name: true, phone: true, partnerBalance: true } },
          },
        },
        payouts: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ campaign });
  } catch (err) {
    console.error('admin/creation-campaigns get', err);
    res.status(500).json({ error: 'Erro ao carregar campanha' });
  }
});

router.post('/admin/creation-campaigns', authMiddleware, adminOnly, async (req, res) => {
  try {
    const b = req.body || {};

    // Resolve o Creation por partnerId ou couponCode
    let partner = null;
    if (b.partnerId) {
      partner = await prisma.partner.findUnique({ where: { id: String(b.partnerId) } });
    } else if (b.couponCode) {
      partner = await prisma.partner.findUnique({
        where: { couponCode: String(b.couponCode).trim().toUpperCase() },
      });
    }
    if (!partner) return res.status(404).json({ error: 'Creation (parceiro) não encontrado. Informe partnerId ou couponCode válido.' });
    if (partner.status === 'banned') return res.status(400).json({ error: 'Creation banido — não pode receber campanha.' });

    const title = String(b.title || '').trim().slice(0, 160);
    if (!title) return res.status(400).json({ error: 'Título da campanha obrigatório' });

    const paymentModel = PAYMENT_MODELS.includes(b.paymentModel) ? b.paymentModel : 'commission';
    const payoutMode = PAYOUT_MODES.includes(b.payoutMode) ? b.payoutMode : 'tenis_cash';
    const recurrence = RECURRENCES.includes(b.recurrence) ? b.recurrence : 'monthly';
    const monthlyFee = (paymentModel === 'monthly_fee' || paymentModel === 'hybrid') ? clampMoney(b.monthlyFee) : 0;

    let dayOfMonth = null;
    if (b.dayOfMonth != null && b.dayOfMonth !== '') {
      dayOfMonth = Math.min(28, Math.max(1, parseInt(b.dayOfMonth, 10) || 1));
    }

    let commissionPctOverride = null;
    if (b.commissionPctOverride != null && b.commissionPctOverride !== '') {
      commissionPctOverride = Math.min(50, Math.max(0, parseFloat(b.commissionPctOverride) || 0));
    }

    const campaign = await prisma.creationCampaign.create({
      data: {
        partnerId: partner.id,
        title,
        briefing: b.briefing ? String(b.briefing).slice(0, 4000) : null,
        objective: b.objective ? String(b.objective).trim().slice(0, 40) : null,
        paymentModel,
        monthlyFee,
        commissionPctOverride,
        payoutMode,
        recurrence,
        startDate: parseDate(b.startDate) || new Date(),
        endDate: parseDate(b.endDate),
        dayOfMonth,
        deliverables: normalizeDeliverables(b.deliverables) ?? [],
        status: CAMPAIGN_STATUS.includes(b.status) ? b.status : 'proposed',
        notes: b.notes ? String(b.notes).slice(0, 1000) : null,
      },
    });
    res.json({ campaign });
  } catch (err) {
    console.error('admin/creation-campaigns create', err);
    res.status(500).json({ error: 'Erro ao criar campanha' });
  }
});

router.put('/admin/creation-campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const existing = await prisma.creationCampaign.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Campanha não encontrada' });

    const b = req.body || {};
    const data = {};
    if (b.title != null) {
      const t = String(b.title).trim().slice(0, 160);
      if (!t) return res.status(400).json({ error: 'Título inválido' });
      data.title = t;
    }
    if (b.briefing !== undefined) data.briefing = b.briefing ? String(b.briefing).slice(0, 4000) : null;
    if (b.objective !== undefined) data.objective = b.objective ? String(b.objective).trim().slice(0, 40) : null;
    if (b.paymentModel != null) {
      if (!PAYMENT_MODELS.includes(b.paymentModel)) return res.status(400).json({ error: 'paymentModel inválido' });
      data.paymentModel = b.paymentModel;
    }
    if (b.payoutMode != null) {
      if (!PAYOUT_MODES.includes(b.payoutMode)) return res.status(400).json({ error: 'payoutMode inválido' });
      data.payoutMode = b.payoutMode;
    }
    if (b.recurrence != null) {
      if (!RECURRENCES.includes(b.recurrence)) return res.status(400).json({ error: 'recurrence inválido' });
      data.recurrence = b.recurrence;
    }
    if (b.monthlyFee != null) data.monthlyFee = clampMoney(b.monthlyFee);
    if (b.commissionPctOverride !== undefined) {
      data.commissionPctOverride = (b.commissionPctOverride === null || b.commissionPctOverride === '')
        ? null : Math.min(50, Math.max(0, parseFloat(b.commissionPctOverride) || 0));
    }
    if (b.dayOfMonth !== undefined) {
      data.dayOfMonth = (b.dayOfMonth == null || b.dayOfMonth === '')
        ? null : Math.min(28, Math.max(1, parseInt(b.dayOfMonth, 10) || 1));
    }
    if (b.startDate !== undefined) data.startDate = parseDate(b.startDate) || existing.startDate;
    if (b.endDate !== undefined) data.endDate = parseDate(b.endDate);
    if (b.deliverables !== undefined) {
      const norm = normalizeDeliverables(b.deliverables);
      if (norm !== undefined) data.deliverables = norm;
    }
    if (b.status != null) {
      if (!CAMPAIGN_STATUS.includes(b.status)) return res.status(400).json({ error: 'Status inválido' });
      data.status = b.status;
    }
    if (b.notes !== undefined) data.notes = b.notes ? String(b.notes).slice(0, 1000) : null;

    const campaign = await prisma.creationCampaign.update({ where: { id: existing.id }, data });
    res.json({ campaign });
  } catch (err) {
    console.error('admin/creation-campaigns update', err);
    res.status(500).json({ error: 'Erro ao atualizar campanha' });
  }
});

router.delete('/admin/creation-campaigns/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const campaign = await prisma.creationCampaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    // Protege contra apagar histórico financeiro: se há payout liquidado, exige force.
    const paidCount = await prisma.creationPayout.count({
      where: { campaignId: campaign.id, status: 'paid' },
    });
    if (paidCount > 0 && req.query.force !== 'true') {
      return res.status(400).json({
        error: 'Campanha tem ' + paidCount + ' pagamento(s) liquidado(s). Use ?force=true para apagar mesmo assim (mantém as Transactions de auditoria).',
      });
    }
    await prisma.creationCampaign.delete({ where: { id: campaign.id } }); // cascade nos payouts
    res.json({ ok: true });
  } catch (err) {
    console.error('admin/creation-campaigns delete', err);
    res.status(500).json({ error: 'Erro ao remover campanha' });
  }
});

/* ========================================================================
   ADMIN — Retainer (geração e liquidação de payouts)
   ====================================================================== */

// Gera um payout PENDENTE pra uma competência (mês). Idempotente por (campaign, reference).
router.post('/admin/creation-campaigns/:id/payouts', authMiddleware, adminOnly, async (req, res) => {
  try {
    const campaign = await prisma.creationCampaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    if (campaign.paymentModel === 'commission') {
      return res.status(400).json({ error: 'Campanha é só comissão (sem retainer). Comissão é creditada automaticamente na venda com cupom.' });
    }

    const b = req.body || {};
    const reference = campaign.recurrence === 'one_off'
      ? 'one_off'
      : (String(b.reference || '').match(/^\d{4}-\d{2}$/) ? b.reference : currentMonthKeyBrazil());
    const amount = b.amount != null && b.amount !== '' ? clampMoney(b.amount) : campaign.monthlyFee;
    if (amount <= 0) return res.status(400).json({ error: 'Valor do retainer inválido (defina monthlyFee na campanha ou amount na requisição).' });

    try {
      const payout = await prisma.creationPayout.create({
        data: {
          campaignId: campaign.id,
          partnerId: campaign.partnerId,
          reference,
          amount,
          payoutMode: campaign.payoutMode,
          status: 'pending',
        },
      });
      res.json({ payout });
    } catch (e) {
      if (e.code === 'P2002') {
        return res.status(409).json({ error: 'Já existe um payout para a competência ' + reference + ' nesta campanha.' });
      }
      throw e;
    }
  } catch (err) {
    console.error('admin/creation-campaigns payouts generate', err);
    res.status(500).json({ error: 'Erro ao gerar payout' });
  }
});

router.get('/admin/creation-payouts', authMiddleware, adminOnly, async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const where = {};
    if (['pending', 'paid', 'cancelled'].includes(status)) where.status = status;
    const payouts = await prisma.creationPayout.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
      include: {
        campaign: {
          select: {
            id: true, title: true, payoutMode: true,
            partner: { select: { id: true, couponCode: true, user: { select: { id: true, name: true } } } },
          },
        },
      },
    });
    res.json({ payouts });
  } catch (err) {
    console.error('admin/creation-payouts list', err);
    res.status(500).json({ error: 'Erro ao listar payouts' });
  }
});

// LIQUIDAÇÃO (ação financeira). tenis_cash credita partnerBalance + Transaction;
// pix_cash apenas marca como pago (liquidação fora da plataforma).
router.post('/admin/creation-payouts/:id/pay', authMiddleware, adminOnly, async (req, res) => {
  try {
    const payout = await prisma.creationPayout.findUnique({
      where: { id: req.params.id },
      include: { campaign: { include: { partner: { select: { id: true, userId: true, couponCode: true } } } } },
    });
    if (!payout) return res.status(404).json({ error: 'Payout não encontrado' });
    if (payout.status === 'paid') return res.status(400).json({ error: 'Payout já liquidado' });
    if (payout.status === 'cancelled') return res.status(400).json({ error: 'Payout cancelado' });

    const partner = payout.campaign?.partner;
    if (!partner) return res.status(400).json({ error: 'Creation da campanha não encontrado' });

    const b = req.body || {};

    if (payout.payoutMode === 'tenis_cash') {
      // Credita T$ no SALDO COMISSÃO (partnerBalance) — nunca no cashback do cliente.
      const result = await prisma.$transaction(async (tx) => {
        const updatedUser = await tx.user.update({
          where: { id: partner.userId },
          data: { partnerBalance: { increment: payout.amount } },
        });
        const trx = await tx.transaction.create({
          data: {
            type: 'partner_retainer',
            amount: payout.amount,
            description: 'Retainer campanha "' + (payout.campaign.title || '').slice(0, 80) + '" — ' + payout.reference,
            receiverId: partner.userId,
            balanceAfter: updatedUser.partnerBalance,
            metadata: JSON.stringify({
              creationPayoutId: payout.id,
              campaignId: payout.campaignId,
              reference: payout.reference,
              couponCode: partner.couponCode,
              paidById: req.userId,
              wallet: 'partnerBalance',
            }),
          },
        });
        const updatedPayout = await tx.creationPayout.update({
          where: { id: payout.id },
          data: { status: 'paid', method: 'tenis_cash', paidAt: new Date(), paidById: req.userId, txId: trx.id },
        });
        await tx.creationCampaign.update({
          where: { id: payout.campaignId },
          data: { totalPaid: { increment: payout.amount } },
        });
        return { updatedPayout, partnerBalance: updatedUser.partnerBalance, txId: trx.id };
      });
      return res.json({
        ok: true,
        payout: result.updatedPayout,
        partnerBalance: result.partnerBalance,
        txId: result.txId,
      });
    }

    // pix_cash → liquidação fora da plataforma (não mexe em saldo)
    const method = PAYOUT_METHODS.includes(b.method) && b.method !== 'tenis_cash' ? b.method : 'pix';
    const updatedPayout = await prisma.$transaction(async (tx) => {
      const up = await tx.creationPayout.update({
        where: { id: payout.id },
        data: {
          status: 'paid',
          method,
          paidAt: new Date(),
          paidById: req.userId,
          notes: b.notes ? String(b.notes).slice(0, 500) : payout.notes,
        },
      });
      await tx.creationCampaign.update({
        where: { id: payout.campaignId },
        data: { totalPaid: { increment: payout.amount } },
      });
      return up;
    });
    res.json({ ok: true, payout: updatedPayout, offPlatform: true });
  } catch (err) {
    console.error('admin/creation-payouts pay', err);
    res.status(500).json({ error: 'Erro ao liquidar payout' });
  }
});

router.post('/admin/creation-payouts/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  try {
    const payout = await prisma.creationPayout.findUnique({ where: { id: req.params.id } });
    if (!payout) return res.status(404).json({ error: 'Payout não encontrado' });
    if (payout.status === 'paid') {
      return res.status(400).json({ error: 'Payout já liquidado — estorno de T$ deve ser feito manualmente pelo admin (evita reversão automática de saldo).' });
    }
    if (payout.status === 'cancelled') return res.json({ ok: true, payout });
    const updated = await prisma.creationPayout.update({
      where: { id: payout.id },
      data: { status: 'cancelled', notes: req.body?.notes ? String(req.body.notes).slice(0, 500) : payout.notes },
    });
    res.json({ ok: true, payout: updated });
  } catch (err) {
    console.error('admin/creation-payouts cancel', err);
    res.status(500).json({ error: 'Erro ao cancelar payout' });
  }
});

/* ========================================================================
   PARCEIRO (role=partner) — minhas campanhas e pagamentos
   ====================================================================== */

async function myPartner(userId) {
  return prisma.partner.findUnique({ where: { userId }, select: { id: true } });
}

router.get('/partner/campaigns', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await myPartner(req.userId);
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const campaigns = await prisma.creationCampaign.findMany({
      where: { partnerId: partner.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
    });
    res.json({ campaigns });
  } catch (err) {
    console.error('partner/campaigns', err);
    res.status(500).json({ error: 'Erro ao listar campanhas' });
  }
});

router.get('/partner/campaigns/:id', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await myPartner(req.userId);
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const campaign = await prisma.creationCampaign.findFirst({
      where: { id: req.params.id, partnerId: partner.id },
      include: { payouts: { orderBy: { createdAt: 'desc' } } },
    });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ campaign });
  } catch (err) {
    console.error('partner/campaigns get', err);
    res.status(500).json({ error: 'Erro ao carregar campanha' });
  }
});

// Creator atualiza o progresso dos entregáveis (campo done de cada item).
router.patch('/partner/campaigns/:id/deliverables', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await myPartner(req.userId);
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const campaign = await prisma.creationCampaign.findFirst({
      where: { id: req.params.id, partnerId: partner.id },
    });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });

    const norm = normalizeDeliverables(req.body?.deliverables);
    if (norm === undefined) return res.status(400).json({ error: 'deliverables inválido' });
    const updated = await prisma.creationCampaign.update({
      where: { id: campaign.id },
      data: { deliverables: norm },
    });
    res.json({ campaign: updated });
  } catch (err) {
    console.error('partner/campaigns deliverables', err);
    res.status(500).json({ error: 'Erro ao atualizar entregáveis' });
  }
});

router.get('/partner/payouts', authMiddleware, partnerOnly, async (req, res) => {
  try {
    const partner = await myPartner(req.userId);
    if (!partner) return res.status(404).json({ error: 'Parceiro não encontrado' });
    const payouts = await prisma.creationPayout.findMany({
      where: { partnerId: partner.id },
      orderBy: [{ createdAt: 'desc' }],
      take: 200,
      include: { campaign: { select: { id: true, title: true } } },
    });
    res.json({ payouts });
  } catch (err) {
    console.error('partner/payouts', err);
    res.status(500).json({ error: 'Erro ao listar pagamentos' });
  }
});

module.exports = router;
