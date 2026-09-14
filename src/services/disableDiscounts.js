const { randomUUID } = require('crypto');
const { getRankingOwner } = require('./rankingOwner');

const AUDIT_KEY_PREFIX = 'discount-shutdown:';
const TRANSACTION_OPTIONS = { isolationLevel: 'Serializable', maxWait: 5000, timeout: 60000 };

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function requireOwner(prisma, ownerId) {
  const owner = await getRankingOwner(prisma);
  if (!owner || owner.id !== ownerId) throw fail(403, 'Somente o proprietário pode desativar os descontos.');
}

function contextObject(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

async function currentDiscounts(prisma, now) {
  const [products, promos, qrOffers] = await Promise.all([
    // aiContext também pode conter JSON legado armazenado como string.
    prisma.product.findMany({ select: { id: true, promoPrice: true, aiContext: true } }),
    prisma.promo.findMany({ where: { active: true }, select: { id: true, active: true } }),
    prisma.qROffer.findMany({
      where: { status: { in: ['ACTIVE', 'SCHEDULED'] }, endsAt: { gt: now } },
      select: { id: true, status: true },
    }),
  ]);
  const productChanges = products.flatMap(product => {
    const context = contextObject(product.aiContext);
    const offer = context?.paymentOffer;
    const paymentOfferActive = !!offer && typeof offer === 'object' && !Array.isArray(offer) && offer.active === true;
    if (product.promoPrice == null && !paymentOfferActive) return [];
    const before = { id: product.id };
    const data = {};
    if (product.promoPrice != null) {
      before.promoPrice = product.promoPrice;
      data.promoPrice = null;
    }
    if (paymentOfferActive) {
      before.aiContext = product.aiContext;
      const next = { ...context, paymentOffer: { ...offer, active: false } };
      data.aiContext = typeof product.aiContext === 'string' ? JSON.stringify(next) : next;
    }
    return [{ id: product.id, before, data }];
  });
  return {
    productChanges, promos, qrOffers,
    counts: {
      productPromoPrices: productChanges.filter(product => 'promoPrice' in product.data).length,
      paymentOffers: productChanges.filter(product => 'aiContext' in product.data).length,
      promos: promos.length,
      qrOffers: qrOffers.length,
    },
  };
}

async function transaction(prisma, work) {
  try { return await prisma.$transaction(work, TRANSACTION_OPTIONS); }
  catch (error) {
    if (error.code === 'P2034') throw fail(409, 'Os descontos mudaram durante a operação. Consulte novamente e tente de novo.');
    if (error.code === 'P2028') throw fail(503, 'A operação não foi concluída. Consulte novamente antes de tentar de novo.');
    throw error;
  }
}

async function inspectDiscounts(prisma, { ownerId } = {}) {
  return transaction(prisma, async tx => {
    await requireOwner(tx, ownerId);
    const checkedAt = new Date();
    const plan = await currentDiscounts(tx, checkedAt);
    return { ok: true, checkedAt: checkedAt.toISOString(), counts: plan.counts };
  });
}

async function disableDiscounts(prisma, { ownerId, reason } = {}) {
  const explanation = reason === undefined ? 'Desativação dos descontos atuais solicitada pelo proprietário.' : reason;
  if (typeof explanation !== 'string' || explanation.trim().length < 3 || explanation.trim().length > 500) {
    throw fail(400, 'Informe um motivo entre 3 e 500 caracteres.');
  }
  return transaction(prisma, async tx => {
    await requireOwner(tx, ownerId);
    const now = new Date();
    const plan = await currentDiscounts(tx, now);
    const before = plan.counts;
    if (!Object.values(before).some(Boolean)) return { ok: true, changed: false, before, after: { ...before }, auditKey: null };

    // Alterar somente os campos de promoção; preços normais e outros metadados ficam intactos.
    const promoIds = plan.productChanges.filter(product => 'promoPrice' in product.data).map(product => product.id);
    if (promoIds.length) {
      const result = await tx.product.updateMany({ where: { id: { in: promoIds }, promoPrice: { not: null } }, data: { promoPrice: null } });
      if (result.count !== promoIds.length) throw fail(409, 'Os preços promocionais mudaram. Consulte novamente.');
    }
    for (const product of plan.productChanges.filter(product => 'aiContext' in product.data)) {
      await tx.product.update({ where: { id: product.id }, data: { aiContext: product.data.aiContext } });
    }
    if (plan.promos.length) {
      const result = await tx.promo.updateMany({ where: { id: { in: plan.promos.map(promo => promo.id) }, active: true }, data: { active: false } });
      if (result.count !== plan.promos.length) throw fail(409, 'As promoções mudaram. Consulte novamente.');
    }
    if (plan.qrOffers.length) {
      const result = await tx.qROffer.updateMany({
        where: { id: { in: plan.qrOffers.map(offer => offer.id) }, status: { in: ['ACTIVE', 'SCHEDULED'] }, endsAt: { gt: now } },
        data: { status: 'CANCELLED' },
      });
      if (result.count !== plan.qrOffers.length) throw fail(409, 'As ofertas QR mudaram. Consulte novamente.');
    }

    const after = (await currentDiscounts(tx, now)).counts;
    if (Object.values(after).some(Boolean)) throw fail(409, 'Ainda existem descontos ativos. A operação foi revertida; consulte novamente.');
    const auditKey = AUDIT_KEY_PREFIX + randomUUID();
    await tx.config.create({ data: {
      id: auditKey,
      key: auditKey,
      value: JSON.stringify({
        version: 1, action: 'disable-current-discounts', actorId: ownerId, createdAt: now.toISOString(),
        reason: explanation.trim(), before, after,
        restore: {
          products: plan.productChanges.map(product => product.before),
          promos: plan.promos,
          qrOffers: plan.qrOffers,
        },
      }),
    } });
    return { ok: true, changed: true, before, after, auditKey };
  });
}

module.exports = { AUDIT_KEY_PREFIX, inspectDiscounts, disableDiscounts };
