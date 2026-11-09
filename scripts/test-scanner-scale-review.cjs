'use strict';
// Synthetic geometry only: this test never loads a private photo, OCR model,
// database or external service. Cases describe printed scale ownership, not
// a conversion chart or a catalog-derived guess about Brazilian sizes.
const assert = require('node:assert/strict');
const { readWords } = require('../src/services/scannerArchivedLabel');
const { createProcessor } = require('../src/services/scannerImageProcessor');

const word = (text, x, y, confidence = 96, width = 40, height = 25) => ({
  text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + height },
});
const data = words => ({ text: words.map(w => w.text).join(' '),
  blocks: [{ paragraphs: [{ lines: [{ words }] }] }] });
const ref = () => word('IF1405', 100, 400, 96, 90);
const br = size => [word('BR', 100, 100), word(size, 160, 100)];
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('literal BR keeps its own value on a complete multiscale row', () => {
  const result = readWords(data([...br('41'), word('F', 400, 100), word('43.5', 460, 100),
    word('UK', 700, 100), word('9', 760, 100), ref()]));
  assert.equal(result?.size, '41');
});
test('literal half-size is preserved without rounding or conversion', () => {
  assert.equal(readWords(data([...br('41,5'), ref()]))?.size, '41.5');
});
test('foreign scales alone never prove BR', () => {
  assert.equal(readWords(data([word('F', 100, 100), word('43', 160, 100),
    word('UK', 100, 200), word('9', 160, 200), ref()])), null);
});
test('low-confidence BR number never promotes another scale', () => {
  assert.equal(readWords(data([word('BR', 100, 100), word('41', 160, 100, 50), ref()])), null);
});
for (const [foreignScale, value] of [['F', '43'], ['EUR', '43'], ['EU', '43'], ['UK', '10'],
  ['US', '11'], ['USA', '11'], ['CM', '28'], ['CHN', '28'], ['JP', '28'], ['J', '28']]) {
  test(`unreadable BR cannot steal the horizontal ${foreignScale} value`, () => {
    // BR's value is unreadable. The only reliable number is explicitly on
    // the far side of another scale label. Proximity to BR is insufficient.
    assert.equal(readWords(data([word('BR', 100, 100), word(foreignScale, 160, 100),
      word(value, 215, 100), ref()])), null);
  });
}
for (const foreignScale of ['F', 'EUR', 'UK', 'US', 'CM', 'JP', 'J']) {
  test(`unreadable BR cannot steal the preceding vertical ${foreignScale} value`, () => {
    assert.equal(readWords(data([word(foreignScale, 100, 100), word('43', 100, 145),
      word('BR', 100, 190), ref()])), null);
  });
}
test('two literal Brazilian sizes keep the photo pending', () => {
  assert.equal(readWords(data([...br('41'), word('BR', 600, 100), word('42', 660, 100), ref()])), null);
});
test('two different label regions are not made unambiguous by equal BR sizes', () => {
  assert.equal(readWords(data([...br('41'), word('IF1405', 100, 200),
    word('BR', 600, 100), word('41', 660, 100), word('IF1406', 600, 200)])), null);
});

test('a closer foreign scale after the horizontal value cannot supply BR', () => {
  assert.equal(readWords(data([word('BR',100,100),word('43',215,100),word('F',265,100),ref()])),null);
});
test('a closer foreign scale below the vertical value cannot supply BR', () => {
  assert.equal(readWords(data([word('BR',100,100),word('43',100,160),word('F',100,190),ref()])),null);
});
test('a foreign scale between BR and a vertical value owns that value', () => {
  assert.equal(readWords(data([word('BR',100,100),word('F',100,130),word('43',100,160),ref()])),null);
});
test('the closer literal BR keeps its value when a foreign label follows farther away', () => {
  assert.equal(readWords(data([word('BR',100,100),word('41',155,100),word('F',270,100),ref()]))?.size,'41');
});
test('a number before its own BR label remains valid', () => {
  assert.equal(readWords(data([word('41',100,100),word('BR',155,100),word('F',350,100),ref()]))?.size,'41');
});
test('distinct printed model references with only one BR still remain ambiguous', () => {
  assert.equal(readWords(data([word('IF1405',100,100),word('IF1406',600,100),word('BR',600,200),word('41',660,200)])),null);
});
test('the same printed model repeated on the label is not a model conflict', () => {
  assert.equal(readWords(data([...br('41'),word('IF1405',100,300),word('IF1405',600,300)]))?.size,'41');
});
for(const [first,second] of [['if1405','if1406'],['IF1405','if1406'],['ＩＦ１４０５','ＩＦ１４０６']]){
  test(`model conflict preserves case and NFKC normalization: ${first}/${second}`,()=>{
    assert.equal(readWords(data([word(first,100,100),word(second,600,100),word('BR',600,200),word('41',660,200)])),null);
  });
}

// All image transforms and worker calls are injected; no real sharp/Tesseract
// instance is created. A reusable worker must not reuse partial label evidence
// from the previous photo, even when both pieces have the same scanned EAN.
const fakeSharp = () => ({
  rotate() { return this; }, resize() { return this; }, greyscale() { return this; },
  normalize() { return this; }, png() { return this; },
  async metadata() { return { width: 1000, height: 800 }; },
  async toBuffer() { return Buffer.from('derived-current-photo'); },
});
const barcode = '4067889546889';
async function processorFixture(recognize, task) {
  const worker = { async setParameters() {}, async recognize(bytes) { return { data: await recognize(bytes) }; }, async terminate() {} };
  const processor = createProcessor({ sharp: fakeSharp, decode: async () => [barcode], createWorker: async () => worker });
  try { await task(processor); } finally { await processor.close(); }
}
test('partial size from one photo is never merged with another photo reference', async () => {
  let photo = 0;
  await processorFixture(() => data(photo === 0 ? br('41') : [ref()]), async processor => {
    assert.equal((await processor.run('label', Buffer.from('physical-piece-one'), barcode)).pending, true);
    photo = 1;
    assert.equal((await processor.run('label', Buffer.from('physical-piece-two'), barcode)).pending, true);
  });
});
test('a size-only first pass still conflicts with a different BR in the same photo', async () => {
  let pass = 0;
  await processorFixture(() => data(++pass === 1 ? br('41') : [...br('42'), ref()]), async processor => {
    assert.equal((await processor.run('label', Buffer.from('same-photo'), barcode)).pending, true);
  });
});
test('a reference-only first pass still conflicts with another printed colour in the same photo', async () => {
  let pass = 0;
  await processorFixture(() => data(++pass === 1
    ? [word('101060060ROSA46', 100, 400, 96, 200)]
    : [...br('41'), word('101060060AZUL46', 100, 400, 96, 200)]), async processor => {
    assert.equal((await processor.run('label', Buffer.from('same-photo-two-colours'), barcode)).pending, true);
  });
});

test('a reference-only first pass still conflicts with another alphanumeric model', async () => {
  let pass=0;
  await processorFixture(()=>data(++pass===1?[word('IF1405',100,400)]:[...br('41'),word('IF1406',100,400)]),async processor=>{
    assert.equal((await processor.run('label',Buffer.from('same-photo-two-models'),barcode)).pending,true);
  });
});

test('a printed customer-service phone field is not a contradictory model', async () => {
  let pass=0;
  await processorFixture(()=>data(++pass===1?[word('SAC:0800',100,400)]:[...br('36'),word('101056056AZLTQS',100,400)]),async processor=>{
    assert.equal((await processor.run('label',Buffer.from('same-photo-phone-and-model'),barcode)).size,'36');
  });
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS: ' + name); }
    catch (error) { failed++; console.error('FAIL: ' + name + '\n' + error.message); }
  }
  console.log(`${tests.length - failed}/${tests.length} independent scale-review cases passed; no OCR model or network used.`);
  if (failed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
