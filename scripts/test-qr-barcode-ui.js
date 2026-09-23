const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../public/loja.html'), 'utf8');
for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (script[1].trim()) new vm.Script(script[1]);
}
const source = html.slice(html.indexOf('function _cleanSellerSize(value)'), html.indexOf('\nfunction addToCart(productId'));
const qrMessage = 'Foi lido um QR Code de site, não o código de barras do produto. Leia as barras da etiqueta (EAN/UPC) ou busque pela referência.';

function harness(lookup = async () => ({ recognized: false })) {
  const calls = [], added = [], prompts = [];
  let focused;
  const input = { value: '', focus() { focused = 'scan'; } };
  const search = { focus() { focused = 'search'; } };
  const message = { style: {}, textContent: '' };
  Object.defineProperty(message, 'innerHTML', { set() { throw Error('Scanned input must never be interpreted as HTML'); } });
  const context = {
    _pendingBarcode: 'previous-unmatched-code',
    _sellSearchAll: [],
    activeStore: null,
    document: { getElementById(id) { return { sellBipeInput: input, sellBipeMsg: message, sellSearchInput: search }[id]; } },
    api: async route => { calls.push(route); return lookup(route); },
    prompt: text => { prompts.push(text); return '40'; },
    alert() {},
    addToCart: (...args) => added.push(args),
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, calls, added, prompts, input, message, get focused() { return focused; },
    scan(code) { input.value = code; return context.onSellBipe(); },
    select(product) { context._sellSearchAll = [product]; return context.addToCartById(product.id); } };
}

async function flushQueue() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function main() {
  for (const code of [
    'HTTPS://QR.NIKE.COM/05M71S96C6681', ' https://qr.nike.com/example ',
    'http://example.com/a', '//qr.nike.com/test', 'www.example.com', 'qr.nike.com/a',
    'https:example.com', 'javascript:alert(1)', 'data:text/plain,test', 'mailto:test@example.com',
  ]) {
    const h = harness();
    await h.scan(code);
    assert.equal(h.calls.length, 0, code + ': website QR must not be sent for product lookup');
    assert.equal(h.context._pendingBarcode, null, code + ': must not be attached to a manually selected product');
    assert.equal(h.added.length, 0);
    assert.equal(h.prompts.length, 0);
    assert.equal(h.message.textContent, qrMessage);
    assert.equal(h.input.value, '');
    assert.equal(h.focused, 'scan', 'scanner remains ready for the real barcode');
  }

  const product = { id: 'nike-test', name: 'Produto Nike', price: 99, productSizeId: 'size-40', size: '40' };
  for (const code of ['7891234567895', '2015052069439', 'NIKE-DM3982-010', 'ABC/40', 'REF.123']) {
    const h = harness(async () => ({ recognized: true, product }));
    await h.scan(code);
    assert.equal(h.calls.length, 1);
    assert.equal(h.added.length, 1);
    assert.equal(h.added[0][5].barcode, code);
    assert.equal(h.added[0][5].productSizeId, product.productSizeId);
    assert.equal(h.context._pendingBarcode, null);
  }

  const ambiguous = harness(async () => ({ recognized: true, ambiguous: true, product: null }));
  await ambiguous.scan('7891234567895');
  assert.equal(ambiguous.context._pendingBarcode, null);
  assert.equal(ambiguous.added.length, 0);
  assert.match(ambiguous.message.textContent, /mais de um cadastro/);
  assert.equal(ambiguous.focused, 'search');

  const missing = harness();
  await missing.scan('7891234567895');
  assert.equal(missing.context._pendingBarcode, '7891234567895', 'real barcode can still be resolved manually');
  assert.equal(missing.focused, 'search');
  await missing.scan('HTTPS://QR.NIKE.COM/05M71S96C6681');
  assert.equal(missing.context._pendingBarcode, null, 'QR scan clears a previously pending real code');

  const literal = harness();
  await literal.scan('<img src=x onerror=alert(1)>');
  assert.match(literal.message.textContent, /<img src=x onerror=alert\(1\)>/);

  let resolveLookup;
  const race = harness(() => new Promise(resolve => { resolveLookup = resolve; }));
  const earlier = race.scan('7891234567895');
  const laterQr = race.scan('https://qr.nike.com/05M71S96C6681');
  await flushQueue();
  resolveLookup({ recognized: false });
  await Promise.all([earlier, laterQr]);
  assert.equal(race.context._pendingBarcode, null, 'QR following an unresolved scan clears the pending code');
  assert.equal(race.message.textContent, qrMessage);
  assert.equal(race.added.length, 0);
  assert.equal(race.calls.length, 1, 'queued QR must not call lookup');

  let resolveRecognized;
  const raceKnown = harness(() => new Promise(resolve => { resolveRecognized = resolve; }));
  const known = raceKnown.scan('7891234567895');
  const qrAfterKnown = raceKnown.scan('https://qr.nike.com/05M71S96C6681');
  await flushQueue();
  resolveRecognized({ recognized: true, product });
  await Promise.all([known, qrAfterKnown]);
  assert.equal(raceKnown.added.length, 1, 'QR must not silently discard the preceding valid scan');
  assert.equal(raceKnown.added[0][5].barcode, '7891234567895');
  assert.equal(raceKnown.message.textContent, qrMessage);
  assert.equal(raceKnown.context._pendingBarcode, null);

  const resolvers = [];
  const twoCodes = harness(() => new Promise(resolve => { resolvers.push(resolve); }));
  const firstCode = twoCodes.scan('7891234567895');
  const secondCode = twoCodes.scan('123456789012');
  await flushQueue();
  assert.equal(twoCodes.calls.length, 1, 'normal scans run sequentially');
  resolvers[0]({ recognized: true, product });
  await flushQueue();
  assert.equal(twoCodes.calls.length, 2);
  resolvers[1]({ recognized: true, product: { ...product, id: 'second-product' } });
  await Promise.all([firstCode, secondCode]);
  assert.deepEqual(twoCodes.added.map(args => args[5].barcode), ['7891234567895', '123456789012'], 'both real scans enter the cart in scan order');

  const manualProduct = { id: 'manual-product', name: 'Produto selecionado', price: 99, sizes: [{ id: 'manual-size', size: '40' }] };
  for (const response of [{ recognized: false }, { recognized: true, product }, new Error('late failure')]) {
    let finish;
    const manual = harness(() => new Promise((resolve, reject) => { finish = () => response instanceof Error ? reject(response) : resolve(response); }));
    const pending = manual.scan('7891234567895');
    const queued = manual.scan('123456789012');
    await flushQueue();
    manual.select(manualProduct);
    assert.equal(manual.added.length, 1);
    assert.equal(manual.added[0][5].barcode, undefined);
    assert.match(manual.message.textContent, /consultas de códigos pendentes foram canceladas/);
    const selectionMessage = manual.message.textContent;
    finish();
    await Promise.all([pending, queued]);
    assert.equal(manual.context._pendingBarcode, null, 'late result cannot bind its barcode to the next manual product');
    assert.equal(manual.added.length, 1, 'late recognized result cannot add a duplicate item');
    assert.equal(manual.calls.length, 1, 'manual selection cancels the remaining lookup queue');
    assert.equal(manual.message.textContent, selectionMessage, 'late result cannot overwrite manual-selection feedback');
    manual.select({ ...manualProduct, id: 'next-manual-product' });
    assert.equal(manual.added[1][5].barcode, undefined);
  }

  const bind = harness();
  await bind.scan('7891234567895');
  bind.context.prompt = () => null;
  bind.select(manualProduct);
  assert.equal(bind.added.length, 0, 'canceling size selection does not add an item');
  assert.equal(bind.context._pendingBarcode, '7891234567895', 'canceling preserves the unresolved barcode');
  bind.context.prompt = () => '40';
  bind.select(manualProduct);
  assert.equal(bind.added.length, 1);
  assert.equal(bind.added[0][5].barcode, '7891234567895');
  assert.equal(bind.added[0][5].isNewBarcode, true);
  assert.equal(bind.context._pendingBarcode, null);

  const error = harness(async () => { throw Error('Falha de consulta'); });
  await error.scan('7891234567895');
  assert.equal(error.context._pendingBarcode, null);
  assert.match(error.message.textContent, /Falha de consulta/);
  console.log('PASS QR sale UI: links refused, queued normal codes preserved, manual selection cancels stale reads, ambiguity and escaped display');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
