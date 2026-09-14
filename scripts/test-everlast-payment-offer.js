const assert = require('node:assert/strict');
const { OFFER_ID, calculateOffer, productOffer, applyOffer } = require('../src/services/everlastPaymentOffer');
const { drawEverlastLabel } = require('../src/services/everlastLabel');

(async () => {
  // Retain arithmetic checks for interpretation of historical campaign data.
  for (const [price, expected] of [[229.89, 183.91], [249.90, 199.92], [300.01, 240.01], [499.99, 399.99]]) {
    const offer = calculateOffer(price);
    assert.equal(offer.finalPrice, expected);
    assert.equal(offer.discountPercent, 20);
  }
  for (const [name, expected] of [['CLIMBER PRO 3', 299], ['NEW YORK', 199], ['SOLO', 179], ['FORCEKNIT LOW', 239], ['RING 4', 223]]) {
    assert.equal(calculateOffer(499.99, 'TENIS ' + name).finalPrice, expected);
  }
  for (const bad of [0, -1, NaN, Infinity, undefined]) assert.throws(() => calculateOffer(bad));
  const stored = { id: 'old', brand: 'EVERLAST', name: 'TENIS SOLO', price: 229.89, promoPrice: 179,
    aiContext: { supplier: { name: 'NESK' }, paymentOffer: { ...calculateOffer(229.89, 'SOLO'), id: OFFER_ID } } };
  const before = structuredClone(stored);
  let touched = false;
  await assert.rejects(applyOffer({ $transaction() { touched = true; throw new Error('Must not run'); } }), error => error.statusCode === 409);
  assert.equal(touched, false);
  assert.equal(productOffer(stored), null);
  assert.equal(productOffer({ ...stored, aiContext: JSON.stringify(stored.aiContext) }), null);
  assert.equal(drawEverlastLabel(null, { brand: 'EVERLAST', price: 229.89, promotionalPrice: 179, paymentOffer: stored.aiContext.paymentOffer }), false);
  assert.deepEqual(stored, before, 'Historical campaign data must remain unchanged');
  console.log('PASS: historical Everlast arithmetic retained; current offers, writes and promotional label rendering blocked');
})().catch(error => { console.error(error); process.exitCode = 1; });
