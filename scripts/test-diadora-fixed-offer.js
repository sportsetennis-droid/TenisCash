const assert = require('node:assert/strict');
const { diadoraFixedPrice } = require('../src/services/diadoraFixedOffer');
const { applyBrandThirtyOffer } = require('../src/services/brandThirtyOffer');
const { drawEverlastLabel } = require('../src/services/everlastLabel');
(async () => {
  for (const [name, expected] of [['SAGA', 129], ['GIOVE', 189], ['SFORZA', 239], ['VULCANO II', 199]]) {
    const item = { brand: 'DIADORA', name: 'TENIS ' + name + ' PRETO 38', price: expected + 100, promotionalPrice: expected };
    assert.equal(diadoraFixedPrice(item), expected, 'Historical fixed-price lookup must remain reproducible');
    assert.equal(drawEverlastLabel(null, item), false, 'A saved promotional price cannot enable a new offer label');
  }
  assert.equal(diadoraFixedPrice({ brand: 'NIKE', name: 'SAGA' }), null);
  let touched = false;
  await assert.rejects(applyBrandThirtyOffer({ $transaction() { touched = true; throw new Error('Must not run'); } }, 'DIADORA'), error => error.statusCode === 409);
  assert.equal(touched, false);
  console.log('PASS: historical Diadora lookup retained; applying and displaying the promotional offer disabled');
})().catch(error => { console.error(error); process.exitCode = 1; });
