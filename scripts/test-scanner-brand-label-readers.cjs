'use strict';
// Brand label readers: pure layout/decision rules (synthetic OCR words) and,
// when the local fixtures are present, the real anchored pipeline on a few
// anonymised label crops (product labels only; no people, no store data).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { decide } = require('../src/services/brandLabelReaders');
const { readBr } = require('../src/services/brandLabelReaders/sizeField');
const { LAYOUTS, detectBrand } = require('../src/services/brandLabelReaders/brandLayouts');
const geometry = require('../src/services/brandLabelReaders/labelGeometry');
const w = (text, x, y, width = 60, height = 30, confidence = 95) => ({ text, confidence, bbox: { x0: x, y0: y, x1: x + width, y1: y + height } });
const variant = (key, words) => ({ key, words });

// Puma: captions above values (UK US EUR BR), reference "106455 01" above the barcode.
const puma = [w('PUMA', 20, 10, 90), w('KING', 120, 10, 80), w('106455', 20, 60, 110), w('01', 140, 60, 35),
  w('UK', 400, 150, 30, 18), w('US', 480, 150, 30, 18), w('EUR', 560, 150, 40, 18), w('BR', 650, 150, 30, 18),
  w('9', 405, 180, 20, 34), w('10', 480, 180, 34, 34), w('43', 560, 180, 34, 34), w('41', 650, 180, 34, 34)];
let r = readBr(puma, LAYOUTS.PUMA);
assert.equal(r.size, '41', 'Puma BR value is the number directly below its BR caption');
let d = decide([variant('a', puma), variant('b', puma)], { hint: 'PUMA' });
assert.equal(d.size, '41');
assert.deepEqual(d.references, ['10645501'], 'Puma model + colour is one printed reference');

// A different BR value in another OCR variant of the same label is a veto.
const pumaOther = puma.map(x => x.text === '41' ? { ...x, text: '42' } : x);
d = decide([variant('a', puma), variant('b', pumaOther)], { hint: 'PUMA' });
assert.equal(d.size, undefined); assert.equal(d.reason, 'variants_disagree');

// EUR-BR sanity: a BR misread that contradicts the printed EUR never answers.
r = readBr(puma.map(x => x.text === '41' ? { ...x, text: '37' } : x), LAYOUTS.PUMA);
assert.equal(r.size, undefined); assert.equal(r.reason, 'eur_br_inconsistent');

// Low confidence BR value is not evidence.
r = readBr(puma.map(x => x.text === '41' ? { ...x, confidence: 60 } : x), LAYOUTS.PUMA);
assert.equal(r.size, undefined);

// Two printed grids (MEN and WOMEN rows) make the owner of BR a judgement call.
const twoGrids = [...puma, w('UK', 400, 260, 30, 18), w('BR', 650, 260, 30, 18), w('5', 405, 290, 20, 34), w('37', 650, 290, 34, 34)];
r = readBr(twoGrids, LAYOUTS.PUMA);
assert.equal(r.size, undefined); assert.equal(r.reason, 'multiple_size_grids');
const audiences = [...puma, w('MEN', 300, 120, 50, 18), w('WOMEN', 300, 220, 80, 18)];
assert.equal(readBr(audiences, LAYOUTS.PUMA).reason, 'multiple_audiences');

// Converse prints the value ABOVE its caption: "38" over "BR".
const converse = [w('CONVERSE', 20, 10, 200), w('38', 20, 60, 50, 40), w('BR', 22, 105, 30, 16), w('7', 120, 60, 25, 40), w('US', 120, 105, 30, 16),
  w('CT09830001', 400, 250, 200)];
d = decide([variant('a', converse)], { hint: 'CONVERSE' });
assert.equal(d.size, '38'); assert.deepEqual(d.references, ['CT09830001']);
// The same words under a "below" layout must not borrow another row's number.
assert.equal(readBr(converse, LAYOUTS.PUMA).size, undefined, 'Puma layout never reads Converse value-above-caption');

// Salomon: caption then value on the same row.
const salomon = [w('471800', 20, 10, 110), w('X', 140, 10, 15), w('BRAZE', 160, 10, 90), w('UK', 500, 40, 30, 20), w('11.5', 560, 40, 50, 20),
  w('EUR', 500, 70, 40, 20), w('46', 560, 70, 30, 20), w('USA', 500, 100, 40, 20), w('12', 560, 100, 30, 20), w('BR', 500, 130, 30, 20), w('44', 560, 130, 30, 20)];
d = decide([variant('a', salomon)], { hint: 'SALOMON' });
assert.equal(d.size, '44'); assert.ok(d.references.includes('471800'));

// Fiber paired size is one literal variant, below "BRA".
const fiber = [w('SAPATILHA', 20, 10, 150), w('FIBER', 180, 10, 80), w('BRA', 600, 10, 80, 30), w('38/39', 590, 50, 100, 30), w('SFBMUL-0998-V2-38/39', 120, 120, 300)];
d = decide([variant('a', fiber)], { hint: 'FIBER' });
assert.equal(d.size, '38/39'); assert.deepEqual(d.references, ['SFBMUL0998V23839']);

// A printed brand that differs from the catalogue hint is a veto, and an
// unknown or disabled layout never answers.
assert.deepEqual(detectBrand(converse, 'PUMA'), { conflict: true });
assert.equal(decide([variant('a', converse)], { hint: 'PUMA' }).reason, 'brand_text_conflict');
assert.equal(decide([variant('a', puma)], { hint: 'MIZUNO' }).reason, 'brand_text_conflict');
assert.equal(decide([variant('a', puma.filter(x => x.text !== 'PUMA'))], { hint: 'MIZUNO' }).reason, 'brand_layout_unknown');
assert.equal(decide([variant('a', puma)], { hint: 'PUMA', enabled: new Set() }).reason, 'brand_reader_disabled');
// Without a reference the reader does not answer (catalogue identity must still be checked).
assert.equal(decide([variant('a', puma.filter(x => !['106455', '01'].includes(x.text)))], { hint: 'PUMA' }).reason, 'reference_not_read');

// Geometry: rotation mapping used to bring the anchor upright.
const p = geometry.rotatePoint({ x: 10, y: 0 }, 90, 100, 50);
assert.ok(Math.abs(p.x - 50) < 1e-9 && Math.abs(p.y - 10) < 1e-9, 'clockwise 90 maps (10,0) to (50,10) on a 100x50 frame');
assert.equal(geometry.uprightAngle([{ x: 0, y: 0 }, { x: 0, y: -100 }, { x: 30, y: -100 }, { x: 30, y: 0 }]), -90);

(async () => {
  // Real pipeline on anonymised fixture crops (local Tesseract, no network).
  const dir = path.join(__dirname, 'fixtures/brand-labels');
  const manifest = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifest)) { console.log('brand label fixtures absent; pure rules passed'); return; }
  const sharp = require('sharp');
  const { createWorker } = require('tesseract.js');
  const { readPositions } = require('../src/services/scannerBarcodeEngine');
  const { readBrandLabel } = require('../src/services/brandLabelReaders');
  const worker = await createWorker('eng', 1, { langPath: path.join(__dirname, '../public/vendor/ocr'), cacheMethod: 'none', errorHandler: () => {} });
  try {
    for (const f of JSON.parse(fs.readFileSync(manifest, 'utf8'))) {
      const image = fs.readFileSync(path.join(dir, f.file));
      const out = await readBrandLabel({ sharp, readPositions, worker, image, barcode: f.barcode, hint: f.brand });
      if (f.size) {
        assert.equal(out.size, f.size, f.file + ': literal BR read from the anchored label ' + JSON.stringify(out).slice(0, 160));
        assert.ok(out.references.includes(f.reference), f.file + ': printed reference read');
      } else assert.equal(out.size, undefined, f.file + ': must stay pending (' + f.why + ')');
      // A different scanned code has no anchor on this label: never an answer.
      const other = await readBrandLabel({ sharp, readPositions, worker, image, barcode: '7891234567895', hint: f.brand });
      assert.equal(other.size, undefined); assert.equal(other.reason, 'anchor_not_found');
    }
  } finally { await worker.terminate(); }
  console.log('brand label readers: pure rules and fixture crops passed');
})().catch(error => { console.error(error); process.exit(1); });
