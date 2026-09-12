const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { calculateOffer, productOffer, applyOffer } = require('../src/services/everlastPaymentOffer');
const { generateLabelsPDF, defaultTemplates } = require('../src/services/labelGenerator');

async function main() {
  const cases = [
    [229.89, 183.91, 'SOLO'], [249.90, 199.92, 'STATION 3'],
    [259.90, 207.92, 'NEW YORK'], [279.99, 223.99, 'RING 4'],
    [299.99, 239.99, 'CLIMBER RUN'], [300.01, 240.01, 'FORCEKNIT LOW'],
    [399.99, 319.99, 'CLIMBER PRO 3'], [499.99, 399.99, 'CLIMBER ULTRA'],
  ];
  for (const [base, final] of cases) {
    const offer = calculateOffer(base);
    assert.equal(offer.finalPrice, final);
    assert.equal(offer.discountPercent, 20);
    assert.deepEqual(offer.paymentMethods, ['DINHEIRO', 'PIX', 'CARTÃO']);
    assert.equal(offer.installments, undefined);
  }
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.throws(() => calculateOffer(bad));
  for (const [name, expected] of [['CLIMBER PRO 3',299.99],['NEW YORK',199.99],['SOLO',179.99],['FORCEKNIT LOW',239.99]]) {
    assert.equal(calculateOffer(399.99, 'TENIS '+name+' PRETO').finalPrice, expected);
  }
  const original = { id: 'one', brand: 'Everlast', name: 'TENIS EVERLAST SOLO', price: 229.89, promoPrice: 100, aiContext: { supplier: { name: 'NESK' }, classification: 'training' } };
  let rows = [structuredClone(original)];
  const prisma = { $transaction: async fn => fn({ product: {
    findMany: async query => { assert.deepEqual(query.where, { active:true, brand: { equals: 'EVERLAST', mode: 'insensitive' } }); return rows; },
    update: async ({where, data}) => { const row = rows.find(p => p.id === where.id); Object.assign(row, data); return row; },
  } }) };
  assert.equal((await applyOffer(prisma)).updated, 1);
  assert.equal(rows[0].price, original.price);
  assert.deepEqual(rows[0].aiContext.supplier, original.aiContext.supplier);
  assert.equal(rows[0].aiContext.classification, 'training');
  assert.equal(productOffer(rows[0]).finalPrice, 179.99);
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
  assert.deepEqual(partial.skipped, [{ productId:'bad', name:'TENIS EVERLAST SOLO', price:0 }]);
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
  const larger = defaultTemplates().a4_16_5x7_duplex;
  assert.equal(larger.widthMm, 50);
  assert.equal(larger.heightMm, 70);
  assert.equal(larger.rows * larger.columns, 16);
  assert.ok(larger.marginTopMm * 2 + larger.rows * larger.heightMm <= 297);
  const largePdf = await generateLabelsPDF({
    template: larger, storeName: 'Sports & Tennis',
    items: Array.from({ length: 15 }, (_, i) => {
      const [price, , model] = cases[i % cases.length];
      return { productName: `TÊNIS EVERLAST ${model}`, brand: 'EVERLAST',
        paymentOffer: calculateOffer(price), quantity: 1 };
    }),
  });
  assert.equal((largePdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2,
    '15 labels must fit on one duplex A4 sheet');
  fs.writeFileSync(path.join(path.dirname(output), 'everlast-16-por-folha.pdf'), largePdf);
  const { drawEverlastLabel } = require('../src/services/everlastLabel');
  for (const item of [
    { brand: 'REEBOK', name: 'Hammer Street', price: 199.99, promotionalPrice: 139.99 },
    { brand: 'REEBOK', name: 'Street Ride', price: 199.99 },
    { brand: 'REEBOK', name: 'Street Ride', price: 199.99, promotionalPrice: 159.99 },
    { brand: 'NIKE', name: 'Street Ride', price: 199.99, promotionalPrice: 139.99 },
  ]) assert.equal(drawEverlastLabel(null, item), false, 'only Street Ride with a selected 30% promotion uses the offer artwork');
  const reebokPdf = await generateLabelsPDF({ template: larger, storeName: 'Sports & Tennis',
    items: ['Cinza', 'Marrom', 'Preto'].map(color => ({ brand: 'REEBOK',
      productName: `Street Ride Unissex ${color}`, price: 199.99, promotionalPrice: 139.99, quantity: 1 })) });
  assert.equal((reebokPdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
  console.log(`Oferta Everlast validada; amostra: ${output}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
