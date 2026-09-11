const assert = require('node:assert/strict');
const { applyBrandThirtyOffer, isFootwear, isAllStar } = require('../src/services/brandThirtyOffer');
async function main() {
  const rows = [
    { id: 'ous', brand: 'OUS', active: true, name: 'OUS', price: 575.90, promoPrice: 500, aiContext: { keep: true } },
    { id: 'diadora', brand: 'DIADORA', active: true, name: 'Diadora', price: 188.85 },
    { id: 'other', brand: 'KAPPA', active: true, name: 'Obvious', price: 54 },
    { id: 'inactive', brand: 'OUS', active: false, name: 'Old', price: 100 },
  ];
  rows.forEach(p => { p.category = 'tenis'; });
  assert.equal(isFootwear({name:'VESTUARIO OLYMPIKUS REGATA',category:'tenis'}), false);
  assert.equal(isFootwear({name:'ACESSORIO OLYMPIKUS GYM BAG',category:'tenis'}), false);
  assert.equal(isFootwear({name:'TENIS OLYMPIKUS COSMO',category:'A CLASSIFICAR'}), true);
  assert.equal(isFootwear({name:'CHINELO SPEEDO',category:'Calçados'}), true);
  assert.equal(isAllStar({brand:'Converse',name:'Chuck Taylor All Star'}), true);
  assert.equal(isAllStar({brand:'Converse',name:'Run Star Motion'}), false);
  const prisma = { $transaction: async fn => fn({ product: {
    findMany: async ({ where }) => rows.filter(p => p.active === where.active && p.brand === where.brand.equals),
    updateMany: async ({ where, data }) => {
      const p = rows.find(p => Object.entries(where).every(([key, value]) => p[key] === value));
      if (!p) return { count: 0 };
      Object.assign(p, data); return { count: 1 };
    },
  } }) };
  const untouched = structuredClone(rows.slice(2));
  assert.equal((await applyBrandThirtyOffer(prisma, 'ous')).updated, 1);
  assert.equal(rows[0].promoPrice, 403.13);
  assert.equal(rows[0].price, 575.90);
  assert.deepEqual(rows[0].aiContext, { keep: true });
  const once = structuredClone(rows);
  await applyBrandThirtyOffer(prisma, 'OUS');
  assert.deepEqual(rows, once, 'reapplication must not compound');
  await applyBrandThirtyOffer(prisma, 'DIADORA');
  assert.equal(rows[1].promoPrice, 132.20);
  assert.deepEqual(rows.slice(2), untouched);
  await assert.rejects(applyBrandThirtyOffer(prisma, 'KAPPA'));
  rows.push(
    { id:'oly-shoe', brand:'OLYMPIKUS', active:true, name:'TENIS OLYMPIKUS', price:100, promoPrice:70 },
    { id:'oly-shirt', brand:'OLYMPIKUS', active:true, name:'VESTUARIO CAMISETA', category:'tenis', price:100, promoPrice:70 },
    { id:'oly-other-offer', brand:'OLYMPIKUS', active:true, name:'BOLSA', price:100, promoPrice:80 }
  );
  const correction = await applyBrandThirtyOffer(prisma, 'OLYMPIKUS');
  assert.equal(correction.updated, 1);
  assert.equal(correction.removed, 1);
  assert.equal(rows.find(p => p.id === 'oly-shirt').promoPrice, null);
  assert.equal(rows.find(p => p.id === 'oly-other-offer').promoPrice, 80);
  assert.equal((await applyBrandThirtyOffer(prisma, 'OLYMPIKUS')).removed, 0);
  rows[0].price = 0;
  await assert.rejects(applyBrandThirtyOffer(prisma, 'OUS'));
  console.log('Brand discount: scope, rounding, idempotence and original prices verified.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
