const assert = require('node:assert/strict');
const { applyBrandThirtyOffer, isFootwear, isAllStar } = require('../src/services/brandThirtyOffer');
const { drawEverlastLabel } = require('../src/services/everlastLabel');
(async () => {
  assert.equal(isFootwear({ name: 'VESTUARIO OLYMPIKUS REGATA', category: 'tenis' }), false);
  assert.equal(isFootwear({ name: 'ACESSORIO OLYMPIKUS GYM BAG', category: 'tenis' }), false);
  assert.equal(isFootwear({ name: 'TENIS OLYMPIKUS COSMO', category: 'A CLASSIFICAR' }), true);
  assert.equal(isFootwear({ name: 'CHINELO SPEEDO', category: 'Calçados' }), true);
  assert.equal(isAllStar({ brand: 'Converse', name: 'Chuck Taylor All Star' }), true);
  assert.equal(isAllStar({ brand: 'Converse', name: 'Run Star Motion' }), false);
  let transactions = 0;
  for (const brand of ['OUS', 'DIADORA', 'OLYMPIKUS', 'FILA', 'SPEEDO', 'ALLSTAR', 'JOMA', 'UMBRO', 'TOPPER', 'MUNICH', 'MIZUNO', 'KAPPA', 'NIKE']) {
    await assert.rejects(applyBrandThirtyOffer({ $transaction() { transactions++; throw new Error('Must not write'); } }, brand), error => error.statusCode === 409);
    assert.equal(drawEverlastLabel(null, { brand, name: 'TENIS', price: 100, promotionalPrice: 70 }), false);
  }
  assert.equal(transactions, 0, 'Applying a brand offer must not read or update products');
  console.log('PASS: product classification retained; all brand promotion application and artwork blocked before database access');
})().catch(error => { console.error(error); process.exitCode = 1; });
