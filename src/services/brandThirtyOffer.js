const BRANDS = new Set(['OUS', 'DIADORA', 'OLYMPIKUS', 'FILA', 'SPEEDO', 'ALLSTAR']);
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
function isFootwear(p) {
  const name = normalize(p.name);
  if (/\b(VESTUARIO|CAMISETA|CAMISA|BERMUDA|SHORT|CALCA|LEGGING|REGATA|MEIA|MEIAS|TRIPK|TRIPACK|MOCHILA|BOLSA|GYM BAG|GYM SACK|TOP|OCULOS|TOUCA|ACESSORIO|PDVS|TOTEM)\b/.test(name)) return false;
  return /\b(TENIS|CHUTEIRA|CHINELO|CHINELOS|SANDALIA|SAPATILHA|SAPATO|CALCADO|CALCADOS)\b/.test(name)
    || /^(TENIS|CALCADO|CALCADOS|CHUTEIRA|CHUTEIRAS|SANDALIA|SANDALIAS|CHINELO|CHINELOS)$/.test(normalize(p.category));
}
function isAllStar(p) {
  return /^(CONVERSE|ALL ?STAR)$/.test(normalize(p.brand)) && /ALL\s*STAR|CHUCK\s*TAYLOR/.test(normalize(p.name));
}
function brandWhere(brand) {
  return brand === 'ALLSTAR' ? { OR: ['CONVERSE', 'ALLSTAR', 'ALL STAR'].map(b => ({ brand: { equals: b, mode: 'insensitive' } })) }
    : { brand: { equals: brand, mode: 'insensitive' } };
}

async function campaignFootwear(prisma) {
  const rows = await prisma.product.findMany({ where: { active: true, OR: [...BRANDS].map(brandWhere).concat([
    { brand: { equals: 'EVERLAST', mode: 'insensitive' } }, { brand: { equals: 'REEBOK', mode: 'insensitive' } },
  ]) }, orderBy: [{ brand: 'asc' }, { name: 'asc' }] });
  return rows.filter(p => isFootwear(p) && (normalize(p.brand) !== 'REEBOK' || /STREET\s*RIDE/.test(normalize(p.name)))
    && (!/CONVERSE|ALL ?STAR/.test(normalize(p.brand)) || isAllStar(p))
    && Number(p.price) > 0 && Math.round(Number(p.promoPrice) * 100) === Math.round(Math.round(Number(p.price) * 100) * 70 / 100))
    .map(p => { let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext || {}; } catch {}
      return { id:p.id, name:p.name, brand:p.brand, category:p.category, price:p.price, promoPrice:p.promoPrice,
        sku:p.sku, supplierRef:p.supplierRef, internalBarcode:p.internalBarcode,
        aiContext:{ classification:ctx.classification || {} } }; });
}

async function applyBrandThirtyOffer(prisma, inputBrand) {
  const brand = String(inputBrand || '').trim().toUpperCase();
  if (!BRANDS.has(brand)) throw new Error('Marca não habilitada para esta promoção');
  return prisma.$transaction(async tx => {
    const products = await tx.product.findMany({
      where: { active: true, ...brandWhere(brand) },
      select: { id: true, name: true, price: true, promoPrice: true, brand: true, category: true },
    });
    if (!products.length) throw new Error('Nenhum produto ativo encontrado');
    const selected = products.filter(p => isFootwear(p) && (brand !== 'ALLSTAR' || isAllStar(p)));
    const changes = selected.map(p => {
      const cents = Math.round(Number(p.price) * 100);
      if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`Preço original inválido: ${p.name}`);
      return { id: p.id, name: p.name, price: Number(p.price), promoPrice: Math.round(cents * 70 / 100) / 100 };
    });
    for (const p of changes) {
      const result = await tx.product.updateMany({ where: { id: p.id, price: p.price, active: true },
        data: { promoPrice: p.promoPrice } });
      if (result.count !== 1) throw new Error('Um preço mudou durante a operação. Atualize e tente novamente.');
    }
    let removed = 0;
    // The owner narrowed the Olympikus campaign to footwear after its first application.
    if (brand === 'OLYMPIKUS') {
      for (const p of products.filter(p => !isFootwear(p))) {
        const expected = Math.round(Math.round(Number(p.price) * 100) * 70 / 100);
        if (p.promoPrice != null && Math.round(Number(p.promoPrice) * 100) === expected) {
          const result = await tx.product.updateMany({ where: { id: p.id, promoPrice: p.promoPrice }, data: { promoPrice: null } });
          removed += result.count;
        }
      }
    }
    return { brand, discountPercent: 30, updated: changes.length, removed, excluded: products.length - changes.length, products: changes };
  }, { timeout: 30000 });
}
module.exports = { applyBrandThirtyOffer, campaignFootwear, isFootwear, isAllStar };
