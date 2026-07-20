// Comissao progressiva por relacionamento com o cliente.
// Percentuais confirmados pelo dono em 2026-07-20.
// Cada etapa paga somente a diferenca ate o percentual-alvo da venda.

const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const RULES = Object.freeze({
  1: Object.freeze([
    { key: 'SALE_COMPLETED', title: 'Venda do produto', targetPct: 1.00, automatic: true },
    { key: 'CUSTOMER_REGISTERED', title: 'Cadastro do cliente conferido e atualizado', targetPct: 1.10 },
    { key: 'FEED_PHOTO', title: 'Foto do cliente usando o produto publicada no feed da loja', targetPct: 1.20, media: 'photo', publication: true, consent: true },
    { key: 'TESTIMONIAL_REEL', title: 'Video do cliente sobre atendimento e produto publicado no Reels da loja', targetPct: 1.30, media: 'video', publication: true, consent: true },
    { key: 'POST_SALE', title: 'Pos-venda com interacao do cliente apos uma semana', targetPct: 1.40, interaction: true, minDaysAfterSale: 7 },
    { key: 'FEEDBACK_REEL', title: 'Reels sobre o feedback do cliente publicado no perfil da loja', targetPct: 1.50, media: 'video', publication: true, consent: true },
  ]),
  2: Object.freeze([
    { key: 'REPEAT_SALE', title: 'Nova venda ao mesmo cliente', targetPct: 1.50, automatic: true },
    { key: 'FEED_PHOTO', title: 'Nova foto do cliente usando o produto publicada no feed da loja', targetPct: 1.60, media: 'photo', publication: true, consent: true },
    { key: 'TESTIMONIAL_REEL', title: 'Novo video do cliente sobre atendimento e produto publicado no Reels da loja', targetPct: 1.70, media: 'video', publication: true, consent: true },
    { key: 'POST_SALE', title: 'Novo pos-venda com interacao do cliente apos uma semana', targetPct: 1.80, interaction: true, minDaysAfterSale: 7 },
    { key: 'FEEDBACK_REEL', title: 'Novo Reels sobre o feedback do cliente publicado no perfil da loja', targetPct: 1.90, media: 'video', publication: true, consent: true },
    { key: 'REFERRAL_CONVERTED', title: 'Cliente indicou uma pessoa que realizou uma compra paga', targetPct: 2.00, referral: true },
  ]),
});

function rulesForPosition(position) {
  const rules = RULES[Number(position)];
  if (!rules) throw new Error('Posicao de compra invalida no ciclo');
  return rules;
}

function ruleForStage(position, key) {
  return rulesForPosition(position).find((rule) => rule.key === String(key || '').toUpperCase()) || null;
}

function amountAtPct(baseAmount, pct) {
  return round2(round2(baseAmount) * Number(pct || 0) / 100);
}

function stageAvailability(journey, stages, now = new Date()) {
  const ordered = rulesForPosition(journey.purchasePosition);
  const byKey = new Map((stages || []).map((stage) => [stage.key, stage]));
  let previousCompleted = true;

  return ordered.map((rule, index) => {
    const stage = byKey.get(rule.key);
    const earliestAt = rule.minDaysAfterSale
      ? new Date(new Date(journey.sale.createdAt).getTime() + rule.minDaysAfterSale * 86400000)
      : null;
    const completed = stage?.status === 'COMPLETED';
    const submitted = stage?.status === 'SUBMITTED';
    const rejected = stage?.status === 'REJECTED';
    const timeReady = !earliestAt || now >= earliestAt;
    const available = !completed && !submitted && stage?.status !== 'REVERSED' && previousCompleted && timeReady && journey.status === 'ACTIVE';
    const waitingReason = completed || stage?.status === 'REVERSED'
      ? null
      : submitted
        ? 'Aguardando fiscalizacao'
      : !previousCompleted
        ? 'Conclua a etapa anterior'
        : !timeReady
          ? 'Disponivel uma semana apos a venda'
          : journey.status !== 'ACTIVE'
            ? 'Ciclo encerrado'
            : null;
    previousCompleted = previousCompleted && completed;
    return { ...rule, position: index, stage, completed, submitted, rejected, available, earliestAt, waitingReason };
  });
}

async function createJourneyForSale(tx, { sale, sellerId, customer, storeId }) {
  if (!sale?.id || !sellerId || !customer?.id) return null;

  const existing = await tx.sellerCommissionJourney.findUnique({ where: { saleId: sale.id } });
  if (existing) return existing;

  const priorCount = await tx.sellerCommissionJourney.count({
    where: { sellerId, customerUserId: customer.id, status: { in: ['ACTIVE', 'COMPLETED'] } },
  });
  const purchasePosition = (priorCount % 2) + 1;
  const cycleNumber = Math.floor(priorCount / 2) + 1;
  const rules = rulesForPosition(purchasePosition);
  const baseRule = rules[0];
  const baseAmount = round2(Number(sale.totalAmount || 0) - Number(sale.tcUsed || 0));
  const baseEarned = amountAtPct(baseAmount, baseRule.targetPct);

  return tx.sellerCommissionJourney.create({
    data: {
      saleId: sale.id,
      sellerId,
      customerUserId: customer.id,
      storeId: storeId || null,
      customerName: customer.name,
      customerPhone: customer.phone || null,
      cycleNumber,
      purchasePosition,
      baseAmount,
      basePct: baseRule.targetPct,
      currentPct: baseRule.targetPct,
      earnedAmount: baseEarned,
      stages: {
        create: rules.map((rule, index) => ({
          key: rule.key,
          position: index,
          title: rule.title,
          targetPct: rule.targetPct,
          deltaPct: index === 0 ? rule.targetPct : round2(rule.targetPct - rules[index - 1].targetPct),
          amount: index === 0 ? baseEarned : 0,
          status: index === 0 ? 'COMPLETED' : 'PENDING',
          completedById: index === 0 ? sellerId : null,
          completedAt: index === 0 ? sale.createdAt : null,
          note: index === 0 ? 'Venda paga registrada no TenisCash' : null,
        })),
      },
    },
    include: { stages: true },
  });
}

async function markJourneyPaymentPending(prismaClient, saleId) {
  return prismaClient.sellerCommissionJourney.updateMany({
    where: { saleId, status: 'ACTIVE' },
    data: { status: 'PENDING_PAYMENT' },
  });
}

async function activateJourneyAfterPayment(prismaClient, saleId) {
  return prismaClient.sellerCommissionJourney.updateMany({
    where: { saleId, status: 'PENDING_PAYMENT' },
    data: { status: 'ACTIVE' },
  });
}

async function cancelJourneyForSale(tx, saleId, reason) {
  const journey = await tx.sellerCommissionJourney.findUnique({ where: { saleId } });
  const now = new Date();
  const result = { journeyCanceled: false, referralBonusesReversed: 0 };

  if (journey && journey.status !== 'CANCELED') {
    await tx.sellerCommissionStage.updateMany({
      where: { journeyId: journey.id, status: { not: 'REVERSED' } },
      data: { status: 'REVERSED', reversedAt: now, reversalReason: reason },
    });
    await tx.sellerCommissionJourney.update({
      where: { id: journey.id },
      data: {
        status: 'CANCELED',
        earnedAmount: 0,
        reversedAmount: journey.earnedAmount,
        canceledAt: now,
        cancellationReason: reason,
      },
    });
    result.journeyCanceled = true;
  }

  const referralStages = await tx.sellerCommissionStage.findMany({
    where: { referredSaleId: saleId, status: { in: ['SUBMITTED', 'COMPLETED'] } },
    include: { journey: true },
  });
  for (const stage of referralStages) {
    await tx.sellerCommissionStage.update({
      where: { id: stage.id },
      data: {
        status: 'REJECTED',
        amount: 0,
        completedById: null,
        completedAt: null,
        referredSaleId: null,
        reviewedAt: now,
        reviewNote: `Indicacao retirada: ${reason}`,
        reversedAt: now,
        reversalReason: reason,
      },
    });
    if (stage.status === 'COMPLETED') {
      await tx.sellerCommissionJourney.update({
        where: { id: stage.journeyId },
        data: {
          status: 'ACTIVE',
          completedAt: null,
          currentPct: round2(stage.targetPct - stage.deltaPct),
          earnedAmount: round2(stage.journey.earnedAmount - stage.amount),
          reversedAmount: { increment: stage.amount },
        },
      });
      result.referralBonusesReversed += 1;
    }
  }

  return result;
}

module.exports = {
  RULES,
  round2,
  amountAtPct,
  rulesForPosition,
  ruleForStage,
  stageAvailability,
  createJourneyForSale,
  markJourneyPaymentPending,
  activateJourneyAfterPayment,
  cancelJourneyForSale,
};
