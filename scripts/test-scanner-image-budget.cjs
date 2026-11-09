'use strict';
// Deterministic guards for the server image budget; no real OCR or database.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createProcessor } = require('../src/services/scannerImageProcessor');
const barcode = '7898707778727';
function harness({ width, height, immediate = false, codes = [barcode] }) {
  const derived = [], calls = []; let created = 0, psm;
  const original = Buffer.from(JSON.stringify({ width, height, original: true }));
  const sharp = bytes => {
    const value = JSON.parse(bytes.toString());
    let angle = 0, resize;
    return {
      rotate(turn) { angle = turn; return this; },
      resize(options) { resize = options; return this; },
      greyscale() { return this; }, normalize() { return this; }, png() { return this; },
      async metadata() { return { width: value.width, height: value.height }; },
      async toBuffer() {
        const turned = angle === 90 || angle === 270;
        let w = turned ? value.height : value.width, h = turned ? value.width : value.height;
        if (resize) { derived.push({ ...resize }); h = Math.round(h * resize.width / w); w = resize.width; }
        return Buffer.from(JSON.stringify({ width: w, height: h, angle, enhanced: !!resize }));
      },
    };
  };
  const worker = { async setParameters(options) { if (options.tessedit_pageseg_mode) psm = options.tessedit_pageseg_mode; },
    async recognize(bytes) {
      calls.push({ bytes, psm });
      return { data: immediate ? { answer: { size: '34/35', references: ['SFBMULALLBLACKV23435'] } } : { text: '', blocks: [] } };
    }, async terminate() {} };
  const processor = createProcessor({ sharp, decode: async () => codes, createWorker: async () => { created++; return worker; },
    readParts: () => ({ size: null, identityReferences: [] }), readWords: value => value.answer || null });
  return { processor, original, derived, calls, created: () => created };
}
(async () => {
  const fast = harness({ width: 1013, height: 1800, immediate: true });
  const original = Buffer.from(fast.original), result = await fast.processor.run('label', fast.original, barcode);
  assert.equal(result.size, '34/35'); assert.equal(fast.calls.length, 1);
  assert.strictEqual(fast.calls[0].bytes, fast.original, 'First OCR receives the unchanged original');
  assert.equal(fast.derived.length, 0, 'A complete original does not allocate an enhanced raster');
  assert.deepEqual(fast.original, original); await fast.processor.close();

  for (const [width, height] of [[1013, 1800], [1800, 1013], [1800, 1800], [600, 800]]) {
    const h = harness({ width, height });
    assert.equal((await h.processor.run('label', h.original, barcode)).pending, true);
    assert.equal(h.derived.length, 4, 'Only one enhanced buffer per orientation, reused between PSM11 and PSM6');
    assert.equal(h.calls.length, 16, 'Existing original/enhanced segmentation and orientation attempts remain');
    for (const item of h.derived) {
      assert(item.width > 0 && item.width <= 3000);
      assert.deepEqual(Object.keys(item), ['width'], 'Preserve existing aspect ratio and width-only enhancement; the reduced resolution candidate was rejected');
    }
    assert.equal(h.derived[0].width, Math.min(3000, width * 2));
    if (width === 1013 && height === 1800) {
      const enhanced = JSON.parse(h.calls[1].bytes.toString());
      assert.equal(enhanced.width, 2026); assert.equal(enhanced.height, 3600, 'Resolution must remain identical until a lower budget passes real controls');
    }
    await h.processor.close();
  }
  const conflict = harness({ width: 1013, height: 1800, codes: [barcode, '5901234123457'] });
  assert.equal((await conflict.processor.run('label', conflict.original, barcode)).reason, 'photo_barcode_conflict');
  assert.equal(conflict.created(), 0); assert.equal(conflict.calls.length, 0); assert.equal(conflict.derived.length, 0);
  await conflict.processor.close();
  console.log('PASS: unchanged original first, lazy enhanced frame with identical prior resolution, existing passes, and multi-barcode rejection before OCR.');

  // A Buffer view can start inside a larger ArrayBuffer: offset and length are
  // both necessary to preserve the identical RGBA input without another copy.
  const backing = Buffer.alloc(40, 99), raw = backing.subarray(9, 25);
  for (let i = 0; i < raw.length; i++) raw[i] = i * 13;
  const prior = Buffer.from(raw), copied = new Uint8ClampedArray(raw);
  const decoder = { prepareZXingModule() {}, async readBarcodes(image) {
    assert.strictEqual(image.data.buffer, raw.buffer, 'No second RGBA backing store');
    assert.equal(image.data.byteOffset, raw.byteOffset); assert.equal(image.data.byteLength, raw.byteLength);
    assert.deepEqual([...image.data], [...copied], 'Every supplied byte matches the former copy');
    assert.equal(image.width, 2); assert.equal(image.height, 2);
    return [{ text: barcode }];
  } };
  const sharp = () => ({ ensureAlpha() { return this; }, raw() { return this; }, async toBuffer() { return { data: raw, info: { width: 2, height: 2 } }; } });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/scannerBarcodeEngine.js'), 'utf8'), {
    module, Buffer, Uint8ClampedArray, __dirname: path.join(__dirname, '../src/services'),
    require(name) { if (name === 'sharp') return sharp; if (name === 'node:fs') return { readFileSync: () => Buffer.from('fake wasm') };
      if (name === 'zxing-wasm/reader') return decoder; if (name === '../../public/scanner-barcode-policy') return require('../public/scanner-barcode-policy'); return require(name); },
  });
  assert.deepEqual(Array.from(await module.exports.decode(Buffer.from('synthetic'))), [barcode]);
  assert.deepEqual(raw, prior, 'Decoder preserves original pixel bytes');
  console.log('PASS: offset Buffer RGBA view supplies identical pixels/output with no duplicate allocation or input mutation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
