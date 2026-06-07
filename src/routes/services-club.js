// =====================================================================
// CLUBE (tiered) + CONSUMO DO PROFISSIONAL + MEMBROS DO VENUE
// ---------------------------------------------------------------------
// Parte do módulo de serviços (/barber). Mesmas regras do services.js:
//   - SCHEMA ADITIVO: models NOVOS (ServiceClubTier, ServiceClubMembership)
//     linkam aos existentes só por String id (venueId, clientUserId...). Sem
//     FK pros models existentes; FK só entre tabelas novas
//     (ServiceClubMembership.tierId). Prefixo "Service" evita colisão com o
//     ClubMembership do APEX (clube esportivo) que já existe no schema.
//   - Timezone America/Fortaleza = UTC-3 fixo (TZ_OFFSET_MIN reaproveitado).
//   - Dinheiro sempre via round2.
//   - $transaction com múltiplas escritas leva { timeout, maxWait }.
//
// CLUBE = planos por nível (mensalidade + % desconto). O dono cria níveis,
// assina clientes a um nível. Cobrança recorrente real = TODO(skeleton).
//
// CONSUMO DO PROFISSIONAL = comanda interna (o barbeiro consome produto do
// próprio estabelecimento). Gera Comanda paga (paymentMethod "staff",
// comissão 0) + baixa estoque, mas NÃO lança CashEntry de receita (não é
// venda — é consumo interno, não pode inflar o caixa).
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (regra CLAUDE.md).
// Mesmo valor/sinal usado em src/routes/services.js.
const TZ_OFFSET_MIN = -180;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Promise wrapper — captura erro e responde 500 (sem deixar handler estourar)
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error('[services-club]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

// Helper de posse do estabelecimento (idêntico ao de services.js)
async function ownedVenue(req, res) {
  const v = await prisma.serviceVenue.findUnique({ where: { id: req.params.id } });
  if (!v) {
    res.status(404).json({ error: 'Estabelecimento não encontrado' });
    return null;
  }
  if (v.ownerUserId !== req.userId) {
    res.status(403).json({ error: 'Sem permissão' });
    return null;
  }
  return v;
}

// =====================================================================
// CLUBE — NÍVEIS (tiers)
// =====================================================================

// Listar níveis do estabelecimento (ativos)
router.get(
  '/venues/:id/club/tiers',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const tiers = await prisma.serviceClubTier.findMany({
      where: { venueId: v.id, active: true },
      orderBy: { monthlyFee: 'asc' },
    });
    // anexa contagem de membros ativos por nível (pra UI)
    const out = [];
    for (const t of tiers) {
      const memberCount = await prisma.serviceClubMembership.count({
        where: { tierId: t.id, status: 'active' },
      });
      out.push({ ...t, memberCount });
    }
    res.json(out);
  })
);

// Criar nível
router.post(
  '/venues/:id/club/tiers',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name obrigatório' });
    const tier = await prisma.serviceClubTier.create({
      data: {
        venueId: v.id,
        name: String(b.name),
        monthlyFee: round2(b.monthlyFee),
        discountPct: Number(b.discountPct) || 0,
        benefits: b.benefits != null ? String(b.benefits) : null,
      },
    });
    res.status(201).json(tier);
  })
);

// Remover nível (soft-delete) — escopado ao venue do dono
router.delete(
  '/venues/:id/club/tiers/:tierId',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const r = await prisma.serviceClubTier.updateMany({
      where: { id: req.params.tierId, venueId: v.id },
      data: { active: false },
    });
    res.json({ ok: r.count > 0 });
  })
);

// =====================================================================
// CLUBE — MEMBROS (assinaturas)
// =====================================================================

// Listar membros (assinaturas ativas) — junta o nome do nível
router.get(
  '/venues/:id/club/members',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const members = await prisma.serviceClubMembership.findMany({
      where: { venueId: v.id, status: 'active' },
      orderBy: { since: 'desc' },
    });
    const tierIds = [...new Set(members.map((m) => m.tierId))];
    const tiers = tierIds.length
      ? await prisma.serviceClubTier.findMany({ where: { id: { in: tierIds } } })
      : [];
    const tierById = Object.fromEntries(tiers.map((t) => [t.id, t]));
    res.json(
      members.map((m) => ({
        ...m,
        tierName: tierById[m.tierId]?.name || null,
        monthlyFee: tierById[m.tierId]?.monthlyFee ?? null,
        discountPct: tierById[m.tierId]?.discountPct ?? null,
      }))
    );
  })
);

// Assinar cliente a um nível
router.post(
  '/venues/:id/club/members',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    if (!b.tierId) return res.status(400).json({ error: 'tierId obrigatório' });
    if (!b.customerName && !b.clientUserId) {
      return res.status(400).json({ error: 'customerName (ou clientUserId) obrigatório' });
    }
    // garante que o nível pertence a este venue e está ativo
    const tier = await prisma.serviceClubTier.findFirst({
      where: { id: String(b.tierId), venueId: v.id, active: true },
    });
    if (!tier) return res.status(404).json({ error: 'Nível não encontrado neste estabelecimento' });

    const membership = await prisma.serviceClubMembership.create({
      data: {
        venueId: v.id,
        tierId: tier.id,
        clientUserId: b.clientUserId || null,
        customerName: b.customerName || null,
        customerPhone: b.customerPhone || null,
      },
    });
    // TODO(skeleton): cobrança recorrente real da mensalidade precisa aprovação humana
    // (gateway/PIX). Por ora só registra a assinatura — nada é debitado/cobrado.
    res.status(201).json({ ...membership, tierName: tier.name, monthlyFee: tier.monthlyFee });
  })
);

// =====================================================================
// MEMBROS DO VENUE (equipe) — usado no form de consumo do profissional.
// Cruza VenueMember ativos com Professional.displayName.
// =====================================================================
router.get(
  '/venues/:id/members',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const members = await prisma.venueMember.findMany({
      where: { venueId: v.id, active: true },
    });
    const proIds = members.map((m) => m.professionalId);
    const pros = proIds.length
      ? await prisma.professional.findMany({
          where: { id: { in: proIds } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = Object.fromEntries(pros.map((p) => [p.id, p.displayName]));
    res.json(
      members.map((m) => ({
        professionalId: m.professionalId,
        name: nameById[m.professionalId] || 'Profissional',
      }))
    );
  })
);

// =====================================================================
// CONSUMO DO PROFISSIONAL — comanda interna, sem receita.
// body: { professionalId, products:[{productId, qty}] }
// Cria Comanda status "paid", paymentMethod "staff", commissionTotal 0,
// ComandaItem (kind "product"), baixa estoque. NÃO lança CashEntry.
// =====================================================================
router.post(
  '/venues/:id/staff-consumption',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    const professionalId = b.professionalId;
    if (!professionalId) return res.status(400).json({ error: 'professionalId obrigatório' });
    const products = Array.isArray(b.products) ? b.products : [];
    if (!products.length) return res.status(400).json({ error: 'Adicione ao menos 1 produto' });

    // confirma que o profissional é membro ativo do venue
    const member = await prisma.venueMember
      .findUnique({ where: { venueId_professionalId: { venueId: v.id, professionalId } } })
      .catch(() => null);
    if (!member || !member.active) {
      return res.status(400).json({ error: 'Profissional não é membro deste estabelecimento' });
    }

    const out = await prisma.$transaction(
      async (tx) => {
        const items = [];
        const stockOps = [];
        for (const pi of products) {
          const prod = await tx.venueProduct.findFirst({
            where: { id: pi.productId, venueId: v.id },
          });
          if (!prod) continue;
          const qty = Math.max(1, Number(pi.qty) || 1);
          const total = round2(prod.price * qty);
          items.push({
            kind: 'product',
            refId: prod.id,
            name: prod.name,
            qty,
            unitPrice: prod.price,
            total,
            commissionPct: 0,
            commissionAmount: 0,
          });
          stockOps.push({ id: prod.id, qty });
        }
        if (!items.length) throw new Error('Nenhum produto válido');

        const subtotal = round2(items.reduce((a, i) => a + i.total, 0));
        const comanda = await tx.comanda.create({
          data: {
            venueId: v.id,
            professionalId,
            status: 'paid',
            subtotal,
            discount: 0,
            total: subtotal,
            commissionTotal: 0,
            paymentMethod: 'staff',
            paidAt: new Date(),
            items: { create: items },
          },
          include: { items: true },
        });
        for (const op of stockOps) {
          await tx.venueProduct.update({
            where: { id: op.id },
            data: { stock: { decrement: op.qty } },
          });
        }
        // NÃO cria CashEntry: consumo interno não é receita do caixa.
        return comanda;
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.status(201).json(out);
  })
);

module.exports = router;
