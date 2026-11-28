// Regra total do dono (28/11/2026): proibido markup abaixo de 100%.
const assert = require('node:assert/strict');
const { ajustarDados, precoMinimo, instalarTravaMarkup, MARKUP_MINIMO } = require('../src/services/markupMinimo');

assert.equal(MARKUP_MINIMO, 100);
assert.equal(precoMinimo(87.25), 174.5);

// criação com 80%: sobe preço e markup
let r = { price: 157.05, costPrice: 87.25, markupPercent: 80 };
ajustarDados(r, null);
assert.deepEqual([r.price, r.markupPercent], [174.5, 100]);

// preço novo abaixo do custo × 2 numa edição só do preço (custo vem do card)
r = { price: 100 };
ajustarDados(r, { price: 200, costPrice: 60 });
assert.equal(r.price, 120);

// custo subiu e o preço ficou abaixo: preço acompanha
r = { costPrice: 150 };
ajustarDados(r, { price: 250, costPrice: 100 });
assert.equal(r.price, 300);

// acima de 100% não mexe; sem custo não mexe; {set:} é lido
r = { price: 300, costPrice: 100 }; ajustarDados(r, null); assert.equal(r.price, 300);
r = { price: 50 }; ajustarDados(r, { price: 60, costPrice: null }); assert.equal(r.price, 50);
r = { price: { set: 90 }, costPrice: { set: 50 } }; ajustarDados(r, null); assert.equal(r.price, 100);
// preço 0 (ainda sem preço) não ganha preço sozinho
r = { price: 0, costPrice: 50 }; ajustarDados(r, null); assert.equal(r.price, 0);
// promoção não é tocada
r = { price: 200, costPrice: 100, promoPrice: 120 }; ajustarDados(r, null); assert.equal(r.promoPrice, 120);

// middleware: update só de preço busca o custo atual
(async () => {
  let mw;
  const fake = { $use: (fn) => { mw = fn; }, product: { findUnique: async () => ({ price: 200, costPrice: 87.25 }) } };
  instalarTravaMarkup(fake);
  const params = { model: 'Product', action: 'update', args: { where: { id: 'x' }, data: { price: 157.05 } } };
  await mw(params, async (p) => p);
  assert.equal(params.args.data.price, 174.5);
  const sup = { model: 'Supplier', action: 'update', args: { where: { id: 's' }, data: { averageMarkup: 80 } } };
  await mw(sup, async (p) => p);
  assert.equal(sup.args.data.averageMarkup, 100);
  console.log('markup mínimo 100%: ok');
})().catch((e) => { console.error(e); process.exit(1); });
