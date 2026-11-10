'use strict';
// Parser inputs and a local fiscal fixture only. The US11/29CM token was
// observed in a real OUS replay; this script does not run OCR or apply stock.
const assert = require('node:assert/strict');
const { readParts, readWords } = require('../src/services/scannerArchivedLabel');
const { matchIncomingManufacturerReference } = require('../src/services/scannerReference');
const word = (text, x, y, width = 120, height = 20) => ({
  text, confidence: 96, bbox: { x0: x, y0: y, x1: x + width, y1: y + height },
});
const data = words => ({ text: words.map(w => w.text).join(' '), blocks: [{ paragraphs: [{ lines: [{ words }] }] }] });
const br = size => [word('BR', 600, 100, 30), word(size, 650, 100, 30)];
const norm = text => text.toUpperCase().replace(/[^A-Z0-9]/g, '');
let total = 0, failures = 0;
function test(name, run) {
  total++;
  try { run(); }
  catch (error) { failures++; console.error('FAIL: ' + name + '\n' + error.message); }
}

// Two explicitly named scales, their own numbers, and an explicit separator.
// They cannot become a product reference merely by stripping punctuation.
for (const token of ['US11/29CM', 'US11 / 29CM', 'US11.5/29CM', 'UK9/43EUR', 'EUR43/US11', '11US/29CM']) {
  test('Compound scale is not an identity: ' + token, () => {
    const input = data([...br('43'), word(token, 100, 300)]);
    const parts = readParts(input);
    assert.equal(parts.size, '43', 'Keep the separate literal BR');
    assert.ok(!parts.references.includes(norm(token)), 'Do not promote compacted foreign scales');
    assert.equal(readWords(input), null, 'BR plus foreign scales has no product identity');
  });
  test('Compound scale cannot obscure a real reference: ' + token, () => {
    const observed = readWords(data([...br('43'), word(token, 100, 300), word('35004417', 100, 430)]));
    assert.equal(observed?.size, '43');
    assert.deepEqual(observed.references, ['35004417']);
  });
}

// Preserve actual manufacturer formats, including size-bearing Fiber codes.
for (const token of ['35004417', '10795201', '1011C017.402', 'TFBU-WHITE-39', 'SFBMUL-0998-V2-40/41', '220644/BKW']) {
  test('Manufacturer reference survives compound-scale filtering: ' + token, () => {
    const observed = readWords(data([...br('43'), word(token, 100, 300, 280)]));
    assert.ok(observed?.references.includes(norm(token)));
    assert.equal(observed.size, '43', 'Reference suffix cannot supply or replace BR');
  });
}
for (const token of ['US1129', 'CM12901', 'F350044']) {
  test('A model-shaped token without two explicit scale fields survives: ' + token, () => {
    assert.ok(readParts(data([word(token, 100, 300)])).references.includes(token));
  });
}
test('A complete reference without literal BR stays pending', () => {
  assert.equal(readWords(data([word('35004417', 100, 430), word('US11/29CM', 100, 300)])), null);
});
test('A single paired Brazilian scale is not discarded as two foreign fields', () => {
  const observed = readWords(data([word('BRA40/41', 600, 100, 130), word('SFBMUL-0998-V2-40/41', 100, 430, 280)]));
  assert.equal(observed?.size, '40/41');
  assert.ok(observed.references.includes('SFBMUL0998V24041'));
});

// Existing OUS matching uses the exact incoming item's model/variation and
// literal fiscal size. A distributor SKU is not the printed manufacturer code.
const product = {
  id: 'ous-product', brand: 'OUS', sku: '0190-7909434878489',
  name: '350044 TENIS COURO 17 IMIGRANTE SERIE X BOURBON CHANTILLY PRT ESSENCIAL',
  aiContext: { supplierRef: '146789' },
};
const fiscal = {
  productId: product.id, supplierCode: '146789', ean: '7909434878533',
  description: product.name + ' 43',
};
const match = (references, size = '43', rows = [fiscal]) => matchIncomingManufacturerReference(product, { references, size }, rows);
test('Exact OUS model/variation and separate BR43 match the incoming item', () => {
  assert.deepEqual(match(['35004417']), { handled: true, reference: '35004417' });
});
for (const references of [['350044'], ['35004418'], ['US1129CM'], ['35004417', '35004418']]) {
  test('OUS rejects partial, scale, or conflicting reference: ' + references.join(','), () => {
    assert.equal(match(references).reference, null);
  });
}
test('OUS cannot infer BR from its incoming description', () => assert.equal(match(['35004417'], '').reference, null));
test('OUS preserves a literal BR conflict', () => assert.equal(match(['35004417'], '42').reference, null));
test('Conflicting incoming OUS variations remain pending', () => {
  assert.equal(match(['35004417'], '43', [fiscal, { ...fiscal, description: fiscal.description.replace('COURO 17', 'COURO 18') }]).reference, null);
});
test('Catalog name alone cannot replace the exact incoming OUS record', () => {
  assert.deepEqual(match(['35004417'], '43', []), { handled: false, reference: null });
});
test('Another product incoming record cannot establish OUS identity', () => {
  assert.deepEqual(match(['35004417'], '43', [{ ...fiscal, productId: 'other-product' }]), { handled: false, reference: null });
});

console.log(`${total - failures}/${total} compound-scale and OUS reference assertions passed. No OCR, network, database or stock writes.`);
if (failures) process.exitCode = 1;
