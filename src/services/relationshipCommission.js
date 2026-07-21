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

async function submitReservedReferralAfterPayment(prismaClient, saleId) {
  return prismaClient.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      select: { id: true, status: true, referralCode: true, sellerId: true, storeId: true, customerUserId: true },
    });
    if (!sale?.referralCode || sale.status !== 'completed') return { submitted: false, reason: 'PAYMENT_NOT_CONFIRMED' };
    const referral = await tx.sellerReferralCode.findUnique({
      where: { code: sale.referralCode },
      include: {
        originJourney: {
          include: {
            sale: { select: { createdAt: true, status: true } },
            stages: { orderBy: { position: 'asc' } },
          },
        },
      },
    });
    if (!referral || referral.referredSaleId !== sale.id) throw new Error('Reserva da indicacao nao localizada');
    const referralStage = referral.originJourney.stages.find((stage) => stage.key === 'REFERRAL_CONVERTED');
    if (referral.status === 'CONVERTED' && referralStage?.status === 'SUBMITTED' && referralStage.referredSaleId === sale.id) {
      return { submitted: true, alreadySubmitted: true, code: referral.code, stageId: referralStage.id };
    }
    if (referral.status !== 'RESERVED') throw new Error('Codigo de indicacao nao esta reservado para esta venda');
    if (!sale.customerUserId || sale.customerUserId === referral.originCustomerUserId) throw new Error('Cliente indicado invalido');
    if (sale.sellerId !== referral.sellerId) throw new Error('Vendedor da indicacao nao confere');
    if (referral.originStoreId && sale.storeId !== referral.originStoreId) throw new Error('Loja da indicacao nao confere');
    const available = stageAvailability(referral.originJourney, referral.originJourney.stages)
      .find((item) => item.key === 'REFERRAL_CONVERTED');
    if (!available?.available || !available.stage) throw new Error(available?.waitingReason || 'Etapa de indicacao indisponivel');

    const now = new Date();
    const claimedStage = await tx.sellerCommissionStage.updateMany({
      where: { id: available.stage.id, status: { in: ['PENDING', 'REJECTED'] }, referredSaleId: null },
      data: {
        status: 'SUBMITTED',
        note: `Codigo ${referral.code} apresentado no caixa. Compra paga confirmada e enviada para fiscalizacao.`,
        referredSaleId: sale.id,
        submittedAt: now,
        completedById: referral.sellerId,
        completedAt: null,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        reversedAt: null,
        reversalReason: null,
      },
    });
    if (claimedStage.count !== 1) throw new Error('Etapa de indicacao mudou antes da confirmacao do pagamento');
    const claimedCode = await tx.sellerReferralCode.updateMany({
      where: { id: referral.id, status: 'RESERVED', referredSaleId: sale.id },
      data: { status: 'CONVERTED', convertedAt: now },
    });
    if (claimedCode.count !== 1) throw new Error('Reserva da indicacao mudou antes da confirmacao do pagamento');
    return { submitted: true, code: referral.code, stageId: available.stage.id };
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

  // Mantem compatibilidade com transacoes simuladas antigas e reabre o codigo
  // quando a venda indicada e cancelada. A comissao continua dependendo de revisao humana.
  if (tx.sellerReferralCode?.updateMany) {
    await tx.sellerReferralCode.updateMany({
      where: { referredSaleId: saleId },
      data: { status: 'ACTIVE', referredSaleId: null, convertedAt: null },
    });
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
  submitReservedReferralAfterPayment,
  cancelJourneyForSale,
};
