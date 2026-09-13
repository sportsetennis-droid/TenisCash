const { getRankingOwner } = require('./rankingOwner');
const relationshipCommission = require('./relationshipCommission');

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function validateSimpleJourney(journey, sale) {
  if ([journey.createdAt, journey.startedAt].some(value => !value || !Number.isFinite(new Date(value).getTime()))) {
    fail(409, 'As datas deste ciclo estão inválidas e precisam ser conferidas antes da troca.');
  }
  if (journey.status !== 'ACTIVE' || Number(journey.reversedAmount || 0) !== 0
    || journey.completedAt || journey.canceledAt || journey.cancellationReason) {
    fail(409, 'O ciclo desta venda já foi encerrado ou estornado e precisa de correção específica.');
  }
  let rules;
  try { rules = relationshipCommission.rulesForPosition(journey.purchasePosition); }
  catch { fail(409, 'A posição desta compra no ciclo está inválida e precisa ser conferida.'); }
  const expectedBase = relationshipCommission.round2(Number(sale.totalAmount) - Number(sale.tcUsed || 0));
  const expectedPct = rules[0].targetPct;
  const expectedEarned = relationshipCommission.amountAtPct(expectedBase, expectedPct);
  if (!Number.isFinite(expectedBase) || expectedBase < 0
    || Number(journey.baseAmount) !== expectedBase || Number(journey.basePct) !== expectedPct
    || Number(journey.currentPct) !== expectedPct || Number(journey.earnedAmount) !== expectedEarned) {
    fail(409, 'O valor da comissão deste ciclo já foi alterado ou não corresponde à venda. Confira-o antes da troca.');
  }
  const stages = journey.stages || [];
  if (stages.length !== rules.length) fail(409, 'O ciclo desta venda está incompleto e precisa ser conferido antes da troca.');
  for (const [index, rule] of rules.entries()) {
    const stage = stages.find(item => item.key === rule.key);
    const hasManualHistory = !stage || (stage.evidence || []).length > 0
      || stage.submittedAt || stage.reviewedAt || stage.reviewedById || stage.reviewNote
      || stage.publicationUrl || stage.evidenceUrl || stage.customerInteracted || stage.interactionChannel
      || stage.consentConfirmed || stage.referredSaleId || stage.reversedAt || stage.reversalReason;
    if (hasManualHistory || stage.position !== index || Number(stage.targetPct) !== rule.targetPct
      || Number(stage.deltaPct) !== (index ? relationshipCommission.round2(rule.targetPct - rules[index - 1].targetPct) : rule.targetPct)
      || (rule.automatic ? stage.status !== 'COMPLETED' || Number(stage.amount) !== expectedEarned
        || stage.completedById !== journey.sellerId || stage.note !== 'Venda paga registrada no TenisCash'
        || !stage.completedAt || new Date(stage.completedAt).getTime() !== new Date(sale.createdAt).getTime()
      : stage.status !== 'PENDING' || Number(stage.amount || 0) !== 0 || stage.completedById || stage.completedAt || stage.note)) {
      fail(409, 'Esta venda já tem atividades, evidências ou avaliações de comissão. A troca exige correção específica do ciclo.');
    }
  }
}

function saleInfo(sale, sellerId = sale.sellerId) {
  return { id: sale.id, sellerId, storeId: sale.storeId, totalAmount: sale.totalAmount };
}

async function correctSaleSeller(prisma, { ownerId, saleId, sellerId, expectedSellerId, reason } = {}) {
  for (const [label, value] of Object.entries({ ownerId, saleId, sellerId, expectedSellerId })) {
    if (typeof value !== 'string' || !value.trim()) fail(400, `Informe ${label}.`);
  }
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.trim().length > 500) {
    fail(400, 'Informe o motivo da correção, com 3 a 500 caracteres.');
  }
  const correctionReason = reason.trim();

  try {
    return await prisma.$transaction(async tx => {
      const owner = await getRankingOwner(tx);
      if (!owner || owner.id !== ownerId) fail(403, 'Somente o titular pode corrigir o vendedor de uma venda.');

      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: {
          commissions: true,
          relationshipJourney: { include: { stages: { include: { evidence: true } }, referralCode: true } },
          sellerReferralAttribution: true,
          referralCommissionStage: true,
        },
      });
      if (!sale) fail(404, 'Venda não encontrada.');
      if (sale.sellerId !== expectedSellerId) fail(409, 'O vendedor desta venda mudou. Atualize a lista antes de corrigir.');
      if (sale.status !== 'completed') fail(409, 'A troca de vendedor está disponível apenas para vendas concluídas.');
      if (!sale.storeId) fail(409, 'Esta venda não tem loja vinculada. Confira a loja antes de trocar o vendedor.');
      if (!sale.createdAt || !Number.isFinite(new Date(sale.createdAt).getTime())) {
        fail(409, 'A data desta venda está inválida e precisa ser conferida antes da troca.');
      }

      const target = await tx.user.findUnique({ where: { id: sellerId } });
      if (!target || !target.active) fail(400, 'O vendedor escolhido está inativo ou não foi encontrado.');
      const isOwner = target.id === owner.id && target.role === 'superadmin';
      const belongsToStore = sale.storeId && [target.storeId, ...(target.storeIds || [])].includes(sale.storeId);
      if (!isOwner && (target.role !== 'seller' || !belongsToStore)) {
        fail(403, 'Escolha um vendedor vinculado à loja desta venda ou o titular.');
      }
      if (target.id === sale.sellerId) {
        return { ok: true, changed: false, sale: saleInfo(sale), previousSellerId: sale.sellerId,
          commissionsUpdated: 0, relationshipRecalculated: false };
      }

      const commissions = sale.commissions || [];
      if (commissions.some(item => item.status !== 'pending' || item.paidAt)) {
        fail(409, 'Esta venda tem comissão paga ou já processada. É necessário corrigir o pagamento antes de trocar o vendedor.');
      }
      if (commissions.some(item => item.sellerId !== sale.sellerId)) {
        fail(409, 'O vendedor da comissão não corresponde ao da venda. Confira os lançamentos antes da troca.');
      }
      const journey = sale.relationshipJourney;
      if (sale.referralCode || sale.sellerReferralAttribution || sale.referralCommissionStage || journey?.referralCode) {
        fail(409, 'Esta venda participa de uma indicação. A troca exige correção específica da indicação e de suas comissões.');
      }
      if (journey) {
        if (journey.sellerId !== sale.sellerId || !sale.customerUserId || journey.customerUserId !== sale.customerUserId) {
          fail(409, 'O ciclo não corresponde ao vendedor e cliente da venda. Confira o vínculo antes da troca.');
        }
        validateSimpleJourney(journey, sale);
        // Removing/inserting a historical purchase must not change the meaning
        // of later first-purchase/repeat-purchase cycles for either salesperson.
        const subsequent = await tx.sellerCommissionJourney.findFirst({
          where: {
            id: { not: journey.id },
            sellerId: { in: [sale.sellerId, target.id] },
            customerUserId: journey.customerUserId,
            status: { in: ['ACTIVE', 'COMPLETED', 'PENDING_PAYMENT'] },
            createdAt: { gte: journey.createdAt },
          },
          select: { id: true },
        });
        if (subsequent) fail(409, 'Há outras compras posteriores deste cliente no ciclo de um dos vendedores. A sequência precisa de correção específica.');
      }

      const changed = await tx.sale.updateMany({
        where: { id: sale.id, sellerId: expectedSellerId, status: 'completed' },
        data: { sellerId: target.id },
      });
      if (changed.count !== 1) fail(409, 'A venda mudou durante a correção. Atualize a lista e tente novamente.');
      let commissionsUpdated = 0;
      if (commissions.length) {
        const transferred = await tx.saleCommission.updateMany({
          where: { saleId: sale.id, sellerId: expectedSellerId, status: 'pending', paidAt: null },
          data: { sellerId: target.id },
        });
        if (transferred.count !== commissions.length) fail(409, 'Uma comissão mudou durante a correção. Atualize a lista antes de continuar.');
        commissionsUpdated = transferred.count;
      }

      let replacement = null;
      if (journey) {
        // Only pristine, automatically created stages reach this point. Evidence,
        // reviews and referrals are never deleted or reassigned by this action.
        await tx.sellerCommissionJourney.delete({ where: { id: journey.id } });
        replacement = await relationshipCommission.createJourneyForSale(tx, {
          sale: { ...sale, sellerId: target.id }, sellerId: target.id, storeId: sale.storeId,
          customer: { id: journey.customerUserId, name: journey.customerName, phone: journey.customerPhone },
        });
        await tx.sellerCommissionJourney.update({
          where: { id: replacement.id },
          data: { startedAt: journey.startedAt || sale.createdAt, createdAt: journey.createdAt || sale.createdAt },
        });
      }

      await tx.adminAction.create({
        data: {
          adminId: owner.id, action: 'sale_seller_corrected', targetUserId: target.id,
          description: `Vendedor responsável corrigido: ${correctionReason}`,
          metadata: JSON.stringify({
            saleId: sale.id, storeId: sale.storeId, reason: correctionReason,
            before: { sellerId: sale.sellerId }, after: { sellerId: target.id },
            commissions: commissions.map(item => ({ id: item.id, sellerId: item.sellerId, amount: item.amount, pct: item.pct, status: item.status })),
            relationshipBefore: journey ? {
              id: journey.id, sellerId: journey.sellerId, cycleNumber: journey.cycleNumber,
              purchasePosition: journey.purchasePosition, basePct: journey.basePct,
              currentPct: journey.currentPct, earnedAmount: journey.earnedAmount,
              startedAt: journey.startedAt, createdAt: journey.createdAt,
              stages: journey.stages.map(stage => ({ id: stage.id, key: stage.key, status: stage.status,
                targetPct: stage.targetPct, amount: stage.amount, completedById: stage.completedById, completedAt: stage.completedAt })),
            } : null,
            relationshipAfter: replacement ? { id: replacement.id, sellerId: replacement.sellerId,
              cycleNumber: replacement.cycleNumber, purchasePosition: replacement.purchasePosition,
              basePct: replacement.basePct, earnedAmount: replacement.earnedAmount } : null,
          }),
        },
      });
      return { ok: true, changed: true, sale: saleInfo(sale, target.id), previousSellerId: sale.sellerId,
        commissionsUpdated, relationshipRecalculated: !!replacement };
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 15000 });
  } catch (error) {
    if (error?.code === 'P2034') fail(409, 'A venda ou suas comissões foram alteradas ao mesmo tempo. Atualize a lista e tente novamente.');
    throw error;
  }
}

module.exports = { correctSaleSeller };
