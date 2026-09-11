const BRANDS = new Set(['OUS', 'DIADORA']);

async function applyBrandThirtyOffer(prisma, inputBrand) {
  const brand = String(inputBrand || '').trim().toUpperCase();
  if (!BRANDS.has(brand)) throw new Error('Marca não habilitada para esta promoção');
  return prisma.$transaction(async tx => {
    const products = await tx.product.findMany({
      where: { active: true, brand: { equals: brand, mode: 'insensitive' } },
      select: { id: true, name: true, price: true },
    });
    if (!products.length) throw new Error('Nenhum produto ativo encontrado');
    const changes = products.map(p => {
      const cents = Math.round(Number(p.price) * 100);
      if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`Preço original inválido: ${p.name}`);
      return { id: p.id, name: p.name, price: Number(p.price), promoPrice: Math.round(cents * 70 / 100) / 100 };
    });
    for (const p of changes) {
      const result = await tx.product.updateMany({ where: { id: p.id, price: p.price, active: true },
        data: { promoPrice: p.promoPrice } });
      if (result.count !== 1) throw new Error('Um preço mudou durante a operação. Atualize e tente novamente.');
    }
    return { brand, discountPercent: 30, updated: changes.length, products: changes };
  }, { timeout: 30000 });
}
module.exports = { applyBrandThirtyOffer };
