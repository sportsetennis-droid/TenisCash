const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateOffer, productOffer, applyOffer } = require('../src/services/everlastPaymentOffer');
const { generateLabelsPDF, defaultTemplates } = require('../src/services/labelGenerator');

async function main() {
  const cases = [
    [229.89, 160.92, 'SOLO'], [249.90, 174.93, 'STATION 3'],
    [259.90, 181.93, 'NEW YORK'], [279.99, 195.99, 'RING 4'],
    [299.99, 209.99, 'CLIMBER RUN'], [300.01, 210.01, 'FORCEKNIT LOW'],
    [399.99, 279.99, 'CLIMBER PRO 3'], [499.99, 349.99, 'CLIMBER ULTRA'],
  ];
  for (const [base, final] of cases) {
    const offer = calculateOffer(base);
    assert.equal(offer.finalPrice, final);
    assert.equal(offer.discountPercent, 30);
    assert.deepEqual(offer.paymentMethods, ['DINHEIRO', 'PIX', 'CARTÃO']);
    assert.equal(offer.installments, undefined);
  }
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.throws(() => calculateOffer(bad));
  const original = { id: 'one', brand: 'Everlast', name: 'Solo', price: 229.89, promoPrice: 100, aiContext: { supplier: { name: 'NESK' }, classification: 'training' } };
  let rows = [structuredClone(original)];
  const prisma = { $transaction: async fn => fn({ product: {
    findMany: async query => { assert.deepEqual(query.where, { active:true, brand: { equals: 'EVERLAST', mode: 'insensitive' } }); return rows; },
    update: async ({where, data}) => { const row = rows.find(p => p.id === where.id); Object.assign(row, data); return row; },
  } }) };
  assert.equal((await applyOffer(prisma)).updated, 1);
  assert.equal(rows[0].price, original.price);
  assert.deepEqual(rows[0].aiContext.supplier, original.aiContext.supplier);
  assert.equal(rows[0].aiContext.classification, 'training');
  assert.equal(productOffer(rows[0]).finalPrice, 160.92);
  const first = structuredClone(rows);
  await applyOffer(prisma);
  assert.deepEqual(rows, first, 'reapplying must not compound discounts');
  assert.equal(productOffer({ ...rows[0], brand: 'Nike' }), null);
  assert.equal(productOffer({ ...rows[0], price: 100 }), null);
  assert.equal(productOffer(original), null, 'unconfigured products must not get an automatic offer');
  rows.push({ ...original, id: 'bad', price: 0 });
  const before = structuredClone(rows);
  const partial = await applyOffer(prisma);
  assert.equal(partial.updated, 1);
  assert.deepEqual(partial.skipped, [{ productId:'bad', name:'Solo', price:0 }]);
  assert.deepEqual(rows, before, 'unpriced products must stay unchanged');

  const pdf = await generateLabelsPDF({
    template: defaultTemplates().a4_16_5x7_duplex,
    storeName: 'Sports & Tennis',
    items: cases.map(([price, , model]) => ({
      productName: `TÊNIS EVERLAST ${model}`, brand: 'EVERLAST',
      categoryLabel: 'TREINO', color: 'PRETO/BRANCO', price,
      paymentOffer: calculateOffer(price), quantity: 1,
      guaranteeText: 'PRODUTO ORIGINAL E GARANTIA.',
    })),
  });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2,
    'eight offers must fit on one front sheet and one mirrored back, without text overflow pages');
  const output = path.join(__dirname, '..', 'tmp', 'pdfs', 'everlast-oferta-teste.pdf');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, pdf);
  console.log(`Oferta Everlast validada; amostra: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
