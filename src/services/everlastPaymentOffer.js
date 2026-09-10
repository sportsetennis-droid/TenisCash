// Oferta aprovada: descontos alternativos sobre o preço normal, sem acumular.
const OFFER_ID = 'everlast-pix25-card20-5x-20260910';

function contextOf(product) {
  try {
    const ctx = typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
    return ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {};
  } catch { return {}; }
}

function calculateOffer(price) {
  const baseCents = Math.round(Number(price) * 100);
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0) throw new Error('Preço normal inválido');
  const cardCents = Math.round(baseCents * 80 / 100);
  const pixCents = Math.round(baseCents * 75 / 100);
  const installmentCents = Math.round(cardCents / 5);
  return {
    id: OFFER_ID, active: true, basePrice: baseCents / 100,
    cardDiscountPercent: 20, pixDiscountPercent: 25, installments: 5,
    cardPrice: cardCents / 100, pixPrice: pixCents / 100,
    installmentPrice: installmentCents / 100,
    lastInstallmentPrice: (cardCents - installmentCents * 4) / 100,
  };
}

function productOffer(product) {
  if (String(product?.brand || '').trim().toUpperCase() !== 'EVERLAST') return null;
  const offer = contextOf(product).paymentOffer;
  if (offer?.id !== OFFER_ID || offer.active !== true) return null;
  // Se o preço normal for alterado depois, exige reaplicação explícita da oferta.
  if (Math.round(Number(product.price) * 100) !== Math.round(Number(offer.basePrice) * 100)) return null;
  return calculateOffer(offer.basePrice);
}

async function applyOffer(prisma) {
  return prisma.$transaction(async tx => {
    const products = await tx.product.findMany({ where: { brand: { equals: 'EVERLAST', mode: 'insensitive' } } });
    if (!products.length) throw new Error('Nenhum produto Everlast encontrado');
    const skipped = [];
    const planned = products.flatMap(p => {
      try { return [{ p, offer: calculateOffer(p.price) }]; }
      catch {
        // Cadastros gerais importados podem estar zerados embora as numerações
        // do MESMO nome/modelo/cor já tenham um preço normal uniforme.
        const name = String(p.name || '').trim().toUpperCase();
        const siblings = products.filter(other => {
          const otherName = String(other.name || '').trim().toUpperCase();
          return name.length > 0 && Number(other.price) > 0 && otherName.startsWith(name + ' ')
            && /^\d{2}(?:\s+REF\s+.+)?$/.test(otherName.slice(name.length + 1));
        });
        const prices = [...new Set(siblings.map(other => Math.round(Number(other.price) * 100)))];
        if (prices.length === 1) return [{ p, offer: calculateOffer(prices[0] / 100), recoveredFrom: siblings.map(other => other.id) }];
        skipped.push({ productId:p.id, name:p.name, price:p.price }); return [];
      }
    });
    for (const { p, offer, recoveredFrom } of planned) {
      await tx.product.update({ where: { id: p.id }, data: {
        ...(recoveredFrom ? { price: offer.basePrice } : {}),
        promoPrice: offer.cardPrice,
        aiContext: { ...contextOf(p), paymentOffer: { ...contextOf(p).paymentOffer, ...offer, ...(recoveredFrom ? { recoveredPriceFrom: recoveredFrom } : {}) } },
      } });
    }
    return { updated: planned.length, total: products.length, skipped, offerId: OFFER_ID, products: planned.map(({p,offer}) => ({ ...offer, productId:p.id, name:p.name })) };
  }, { timeout: 30000 });
}

module.exports = { OFFER_ID, calculateOffer, productOffer, applyOffer };
