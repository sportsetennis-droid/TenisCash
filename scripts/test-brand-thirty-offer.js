const assert = require('node:assert/strict');
const { applyBrandThirtyOffer } = require('../src/services/brandThirtyOffer');
async function main() {
  const rows = [
    { id: 'ous', brand: 'OUS', active: true, name: 'OUS', price: 575.90, promoPrice: 500, aiContext: { keep: true } },
    { id: 'diadora', brand: 'DIADORA', active: true, name: 'Diadora', price: 188.85 },
    { id: 'other', brand: 'KAPPA', active: true, name: 'Obvious', price: 54 },
    { id: 'inactive', brand: 'OUS', active: false, name: 'Old', price: 100 },
  ];
  const prisma = { $transaction: async fn => fn({ product: {
    findMany: async ({ where }) => rows.filter(p => p.active === where.active && p.brand === where.brand.equals),
    updateMany: async ({ where, data }) => {
      const p = rows.find(p => p.id === where.id && p.price === where.price && p.active === where.active);
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
  rows[0].price = 0;
  await assert.rejects(applyBrandThirtyOffer(prisma, 'OUS'));
  console.log('Brand discount: scope, rounding, idempotence and original prices verified.');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
