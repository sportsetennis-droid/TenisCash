'use strict';

const assert = require('node:assert/strict');
const { priceExchange, exchangeRequest, normalizeAuthCode, sameSnapshot, ExchangeValidationError } = require('../src/services/exchangePricing');
const cent = value => Math.round(value * 100);
const input = [{ id: 'new-40', qty: 1, price: 1299 }];
const before = JSON.stringify(input);

function check(result) {
  assert.equal(result.items.reduce((sum, item) => sum + item.qty * cent(item.price), 0), cent(result.newTotal));
  assert.equal(cent(result.credit) + Math.max(0, cent(result.diff)), cent(result.newTotal));
  assert.equal(cent(result.credit) + cent(result.vale), cent(result.returnedTotal));
  for (const item of result.items) {
    assert.ok(Number.isSafeInteger(item.qty) && item.qty > 0);
    assert.ok(item.price >= 0.01);
    assert.ok(Math.abs(item.price * 100 - cent(item.price)) < 1e-7);
  }
  return result;
}

let result = check(priceExchange(input, 711.11));
assert.equal(result.newTotal, 1299);
assert.equal(result.diff, 587.89);
assert.equal(result.overridden, false);

result = check(priceExchange(input, 711.11, 100));
assert.equal(result.newTotal, 811.11);
assert.equal(result.items[0].price, 811.11);
assert.equal(result.credit, 711.11);
assert.equal(result.adjustment, -487.89);
assert.equal(result.overridden, true);
assert.equal(JSON.stringify(input), before, 'The catalog price is not mutated');

result = check(priceExchange(input, 711.11, 0));
assert.equal(result.diff, 0);
assert.equal(result.newTotal, 711.11);
assert.equal(result.vale, 0);

result = check(priceExchange(input, 711.11, -100));
assert.equal(result.newTotal, 611.11);
assert.equal(result.credit, 611.11);
assert.equal(result.vale, 100);
result = check(priceExchange(input, 711.11, 700));
assert.equal(result.adjustment, 112.11);

result = check(priceExchange([{ id: 'three-pairs', qty: 3, price: 100 }], 100, 0));
assert.deepEqual(result.items, [
  { id: 'three-pairs', qty: 2, price: 33.33 },
  { id: 'three-pairs', qty: 1, price: 33.34 },
]);

// Vary quantities, proportions and both signs. Assert the accounting identities
// against integer cents, including cases requiring split SaleItems.
let cases = 0;
for (let qty = 1; qty <= 17; qty++) {
  for (const difference of [-73.29, 0, 0.01, 123.45, 5000.19]) {
    const original = [{ id: 'a', qty, price: 17.33 }, { id: 'b', qty: 5, price: 41.07 }];
    const priced = check(priceExchange(original, 177.77, difference));
    for (const id of ['a', 'b']) assert.equal(priced.items.filter(item => item.id === id).reduce((sum, item) => sum + item.qty, 0), original.find(item => item.id === id).qty);
    cases++;
  }
}

for (const value of ['', '100', '1.000,00', true, NaN, Infinity, -Infinity]) {
  assert.throws(() => priceExchange(input, 711.11, value), ExchangeValidationError);
}
for (const value of [-711.11, -800]) assert.throws(() => priceExchange(input, 711.11, value), /maior que zero/);
assert.throws(() => priceExchange([{ qty: 2, price: 1 }], 1, -0.99), /inferior a R\$ 0,01/);
for (const qty of [0, -1, 1.1, '2', NaN]) assert.throws(() => priceExchange([{ qty, price: 100 }], 1), ExchangeValidationError);
for (const value of [undefined, null, '', ' ', '000000', ' 000000 ']) assert.equal(normalizeAuthCode(value), null);
assert.equal(normalizeAuthCode('  098765  '), '098765');

const request = { returned: [{ saleItemId: 'b', qty: 2 }, { saleItemId: 'a', qty: 1 }], newItems: [{ barcode: ' 01234 ', size: ' U ', qty: 3 }], diffAmount: 0 };
assert.deepEqual(exchangeRequest(request), { returned: [{ saleItemId: 'a', qty: 1 }, { saleItemId: 'b', qty: 2 }], newItems: [{ barcode: '01234', size: 'u', qty: 3 }], diffAmount: 0 });
assert.throws(() => exchangeRequest({ ...request, returned: [{ saleItemId: 'a', qty: 1 }, { saleItemId: 'a', qty: 1 }] }), /repetido/);
assert.throws(() => exchangeRequest({ ...request, returned: [{ saleItemId: 'a', qty: 0 }] }), /Quantidade devolvida inválida/);
assert.equal(sameSnapshot({ nested: [{ saleItemId: 'a', qty: 1 }], diffAmount: 10 }, { diffAmount: 10, nested: [{ qty: 1, saleItemId: 'a' }] }), true, 'JSONB key order does not change the agreement');
assert.equal(sameSnapshot({ nested: [{ saleItemId: 'a', qty: 1 }] }, { nested: [{ qty: 2, saleItemId: 'a' }] }), false);
console.log('PASS exchange pricing: signed difference, actual credit, exact cent allocation (' + cases + ' scenarios), unchanged catalog, invalid input, optional NSU and retry snapshots');
