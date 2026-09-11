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
  await assert.rejects(applyBrandThirtyOffer(prisma, 'NIKE'));
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
  rows.push(
    {id:'joma-boot', brand:'JOMA', active:true, name:'CHUTEIRA FUTSAL JOMA TOP FLEX', price:599.98},
    {id:'joma-ball', brand:'JOMA', active:true, name:'BOLA FUTSAL JOMA TOP-5', category:'tenis', price:429},
    {id:'umbro-boot', brand:'UMBRO', active:true, name:'CHUTEIRA UMBRO', price:200, promoPrice:140},
    {id:'umbro-shoe', brand:'UMBRO', active:true, name:'TENIS UMBRO CASUAL', price:100, promoPrice:80}
  );
  assert.equal((await applyBrandThirtyOffer(prisma, 'JOMA')).updated, 1);
  assert.equal(rows.find(p => p.id === 'joma-boot').promoPrice, 419.99);
  assert.equal(rows.find(p => p.id === 'joma-ball').promoPrice, undefined);
  assert.equal((await applyBrandThirtyOffer(prisma, 'UMBRO')).updated, 1);
  assert.equal(rows.find(p => p.id === 'umbro-boot').promoPrice, null);
  assert.equal(rows.find(p => p.id === 'umbro-shoe').promoPrice, 80);
  rows.push(
    {id:'mizuno-sala',brand:'MIZUNO',active:true,name:'FOOTBALL MORELIA SALA PRO IN PRADOU',category:'A CLASSIFICAR',price:599.99},
    {id:'mizuno-campo',brand:'MIZUNO',active:true,name:'CHUTEIRA MIZUNO MORELIA II PRO M PRADOU',price:799.90},
    {id:'mizuno-running',brand:'MIZUNO',active:true,name:'TENIS MIZUNO WAVE',price:499.90},
    {id:'kappa-boot',brand:'KAPPA',active:true,name:'CHUTEIRA KAPPA MAESTRO',price:199.99},
    {id:'kappa-shirt',brand:'KAPPA',active:true,name:'CAMISA KAPPA',category:'tenis',price:99.90}
  );
  assert.equal((await applyBrandThirtyOffer(prisma,'MIZUNO')).updated,2);
  assert.equal(rows.find(p=>p.id==='mizuno-sala').promoPrice,359.99);
  assert.equal(rows.find(p=>p.id==='mizuno-campo').promoPrice,479.94);
  assert.equal(rows.find(p=>p.id==='mizuno-running').promoPrice,undefined);
  assert.equal((await applyBrandThirtyOffer(prisma,'KAPPA')).updated,1);
  assert.equal(rows.find(p=>p.id==='kappa-boot').promoPrice,139.99);
  assert.equal(rows.find(p=>p.id==='kappa-shirt').promoPrice,undefined);
  const beforeRepeat=structuredClone(rows);
  await applyBrandThirtyOffer(prisma,'MIZUNO');
  await applyBrandThirtyOffer(prisma,'KAPPA');
  assert.deepEqual(rows,beforeRepeat);
  rows[0].price = 0;
  await assert.rejects(applyBrandThirtyOffer(prisma, 'OUS'));
  console.log('Brand discount: scope, rounding, idempotence and original prices verified.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
