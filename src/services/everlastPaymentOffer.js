// Oferta aprovada: descontos alternativos sobre o preço normal, sem acumular.
const OFFER_ID = 'everlast-off20-baixou-20260912';

function contextOf(product) {
  try {
    const ctx = typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
    return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  } catch { return {}; }
}

function calculateOffer(price, name = "") {
  const baseCents = Math.round(Number(price) * 100);
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0) throw new Error('Preço normal inválido');
  const fixed = /\bCLIMBER\s+PRO\b/i.test(name) ? 29999
    : /\bNEW\s+YORK\b/i.test(name) ? 19999
    : /\bSOLO\b/i.test(name) ? 17999
    : /\bFORCEKNIT\b/i.test(name) ? 23999 : null;
  const finalCents = fixed ?? Math.round(baseCents * 80 / 100);
  if (finalCents >= baseCents) throw new Error('Oferta deve ser menor que o pre�o normal');
  return {
    id: OFFER_ID, active: true, basePrice: baseCents / 100,
    fixedPrice: fixed !== null, discountPercent: fixed === null ? 20 : Math.round((1 - finalCents / baseCents) * 10000) / 100, finalPrice: finalCents / 100,
    paymentMethods: ['DINHEIRO', 'PIX', 'CARTÃO'],
  };
}

function productOffer(product) {
  if (String(product?.brand || '').trim().toUpperCase() !== 'EVERLAST') return null;
  const offer = contextOf(product).paymentOffer;
  if (offer?.id !== OFFER_ID || offer.active !== true) return null;
  // Se o preço normal for alterado depois, exige reaplicação explícita da oferta.
  if (Math.round(Number(product.price) * 100) !== Math.round(Number(offer.basePrice) * 100)) return null;
  return { ...offer };
}

async function applyOffer(prisma) {
  return prisma.$transaction(async tx => {
    const products = await tx.product.findMany({ where: { active: true, brand: { equals: 'EVERLAST', mode: 'insensitive' } } });
    if (!products.length) throw new Error('Nenhum produto Everlast encontrado');
    const skipped = [];
    const planned = products.filter(require('./brandThirtyOffer').isFootwear).flatMap(p => {
      try { return [{ p, offer: calculateOffer(p.price, p.name) }]; }
      catch {
        skipped.push({ productId:p.id, name:p.name, price:p.price }); return [];
      }
    });
    for (const { p, offer } of planned) {
      await tx.product.update({ where: { id: p.id }, data: {
        promoPrice: offer.finalPrice,
        aiContext: { ...contextOf(p), paymentOffer: offer },
      } });
    }
    return { updated: planned.length, total: products.length, skipped, offerId: OFFER_ID, products: planned.map(({p,offer}) => ({ ...offer, productId:p.id, name:p.name })) };
  }, { timeout: 30000 });
}

module.exports = { OFFER_ID, calculateOffer, productOffer, applyOffer };
