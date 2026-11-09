'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseScannerText } = require('../src/services/scannerText');

// Load only pure route helpers: requiring the Express route itself starts
// schema/queue services. These tests must not open a database or run OCR.
const route = fs.readFileSync(require.resolve('../src/routes/stocktake'), 'utf8');
function helper(name) {
  const declaration = route.includes('async function ' + name + '(') ? 'async function ' : 'function ';
  const start = route.indexOf(declaration + name + '(');
  assert.notEqual(start, -1, name + ' must exist');
  const end = route.indexOf('\n}', start) + 2;
  assert.ok(end > start, name + ' must have a closing brace');
  return route.slice(start, end);
}
const state = { fiscalQueries: 0 };
const sandbox = {
  prisma: { xmlFiscalItem: { async findFirst() { state.fiscalQueries++; return null; } } },
  barcodeVariants: value => [value],
};
vm.createContext(sandbox);
vm.runInContext("const LETTER_SEQ = ['PP','P','M','G','GG','XG','XGG'];\n" +
  ['normalizeScannedSize', 'normalizeManualSize', 'extractSizeOptions', 'sizeOptionsForBipe', 'inferSizeFromDescription'].map(helper).join('\n') +
  '\nthis.helpers={normalizeScannedSize,normalizeManualSize,extractSizeOptions,sizeOptionsForBipe,inferSizeFromDescription};', sandbox);
const { normalizeScannedSize, normalizeManualSize, extractSizeOptions, sizeOptionsForBipe, inferSizeFromDescription } = sandbox.helpers;
const ocr = size => parseScannerText('FIBER\nTFBU-BLACK\n' + size + '\n7898707779915');
const plain = value => JSON.parse(JSON.stringify(value));

(async () => {
  for (const paired of ['38/39', '40/41', '42/43']) {
    for (const scale of ['BR', 'BRA']) {
      assert.equal(ocr(scale + ' ' + paired).tamanho, 'BR ' + paired);
      assert.equal(ocr(scale + ' ' + paired.replace('/', ' / ')).tamanho, 'BR ' + paired);
      assert.equal(ocr(scale + ' ' + paired.replace('/', '/ ')).tamanho, 'BR ' + paired);
      assert.equal(ocr(scale + ' ' + paired.replace('/', ' /')).tamanho, 'BR ' + paired);
      assert.equal(normalizeScannedSize(scale + ' ' + paired), paired);
      assert.equal(normalizeScannedSize(ocr(scale + ' ' + paired).tamanho), paired,
        'The complete OCR-to-route chain preserves one paired variant');
    }
    assert.equal(normalizeManualSize(paired), paired);
    assert.equal(normalizeManualSize(paired.replace('/', ' / ')), paired);
    assert.deepEqual(plain(await sizeOptionsForBipe('TENIS FIBER ' + paired, 'fixture-code', paired)), [paired]);
    assert.deepEqual(plain(await sizeOptionsForBipe('TENIS FIBER', 'fixture-code', paired)), [paired],
      'The confirmed variant stays whole even when the product name has no size');
    assert.equal(ocr(paired).tamanho, null, 'An unlabelled pair is not Brazilian evidence');
    assert.equal(normalizeScannedSize(paired), null);
  }
  assert.equal(state.fiscalQueries, 0, 'Known paired variants need no fallback to an NF-e range');

  for (const invalid of ['BR 40/', 'BR 40/4', 'BR 40/41/42', 'BR 40/41.5', 'BR 40/411', 'BR 40/41/422', 'BR 40/41X', 'BR 40 / 411', 'BRA 40 / 41 / 422', 'BR 10/11.5', 'BR 10/41', 'BR 40/42', 'BR 34/39', 'BR 40 / BR 41']) {
    assert.equal(ocr(invalid), null, 'Incomplete/foreign-fraction pair must not become an endpoint: ' + invalid);
    assert.equal(normalizeScannedSize(invalid), null);
  }
  for (const invalid of ['40/', '/41', '40/4', '40/41/42', '40/41.5', '10/11.5', '10/41', '40/42', '34/39']) {
    assert.equal(normalizeManualSize(invalid), null);
  }
  for (const ambiguous of ['BR 40\nBR 41', 'BR 40/41\nBR 42/43', 'BR 40/41\nBR 40/41']) {
    assert.equal(ocr(ambiguous), null, 'Separate BR labels never become one paired size');
    assert.equal(normalizeScannedSize(ambiguous), null);
  }
  assert.equal(ocr('US 10/11.5\nUK 9/10\nEUR 40/41').tamanho, null);
  assert.equal(normalizeScannedSize('US 10/11.5'), null);
  assert.equal(normalizeScannedSize('BR 41,5'), '41.5');
  assert.equal(ocr('BR 41,5').tamanho, 'BR 41.5');
  assert.equal(normalizeManualSize('41,5'), '41.5');
  assert.equal(normalizeScannedSize('M'), 'M');
  assert.equal(normalizeManualSize('8A'), '8A');

  // Preserve existing fiscal grade semantics unless an actual paired variant
  // was supplied. A broad Adidas grade must not become one new shoe size.
  assert.deepEqual(plain(extractSizeOptions('TENIS ADIDAS 34/39')), ['34','35','36','37','38','39']);
  assert.deepEqual(plain(await sizeOptionsForBipe('TENIS ADIDAS 34/39', 'fixture-code')), ['34','35','36','37','38','39']);
  assert.deepEqual(plain(await sizeOptionsForBipe('TENIS ADIDAS 34/39', 'fixture-code', '34/39')), ['34','35','36','37','38','39']);
  assert.deepEqual(plain(extractSizeOptions('TENIS 40/41')), ['40','41']);
  assert.deepEqual(plain(extractSizeOptions('CAMISA 7A/9A')), ['7A','8A','9A']);
  assert.deepEqual(plain(extractSizeOptions('CAMISA P/GG')), ['P','M','G','GG']);
  assert.equal(inferSizeFromDescription('TENIS FIBER TAM 40/41'), '?', 'An NF-e range never silently becomes its first endpoint');
  assert.equal(inferSizeFromDescription('TENIS FIBER TAM 42 / 43'), '?');
  assert.equal(inferSizeFromDescription('TENIS FIBER 40 / 41'), '?', 'A spaced slash must not expose the last number to the tail matcher');
  assert.equal(inferSizeFromDescription('TENIS FIBER 42 / 43'), '?');
  assert.equal(inferSizeFromDescription('TENIS ADIDAS 34/39'), '?');
  assert.equal(inferSizeFromDescription('TENIS TAM 41'), '41');
  assert.equal(state.fiscalQueries, 0);
  console.log('PASS paired BR/BRA OCR and normalization, manual pair, known-variant choices, incomplete slash rejection, separate-label ambiguity, foreign-scale rejection and existing fiscal grade ranges; no DB/OCR/network.');
})().catch(error => { console.error(error); process.exitCode = 1; });
