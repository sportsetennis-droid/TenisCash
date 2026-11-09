'use strict';
const assert = require('node:assert/strict'), sharp = require('sharp');
const { decode } = require('../src/services/scanActionPhotos');
const input = { barcode: '4006381333931', capturedAt: new Date().toISOString() };
(async () => {
  let passed = 0;
  for (const format of ['jpeg', 'png', 'webp']) {
    const bytes = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#1248ae' } }).toFormat(format).toBuffer();
    const photo = 'data:image/' + format + ';base64,' + bytes.toString('base64');
    const result = await decode({ ...input, photo });
    assert.deepEqual(result.image, bytes); assert.equal(result.width, 1280); assert.equal(result.height, 720); passed++;
    const broken = bytes.subarray(0, Math.floor(bytes.length / 2));
    await assert.rejects(decode({ ...input, photo: 'data:image/' + format + ';base64,' + broken.toString('base64') })); passed++;
    if (format === 'jpeg') {
      assert.equal((await sharp(broken).metadata()).width, 1280, 'Regression: header reads while pixels are broken');
      await assert.rejects(decode({ ...input, photo, capturedAt: 'invalid' }), /Horário/); passed++;
      await assert.rejects(decode({ ...input, photo, capturedAt: new Date(Date.now() + 3600000).toISOString() }), /Horário/); passed++;
      await assert.rejects(decode({ ...input, photo, barcode: '' }), /Código/); passed++;
      await assert.rejects(decode({ ...input, photo: photo.replace('image/jpeg', 'image/png') }), /estática válida/); passed++;
    }
  }
  await assert.rejects(decode({ ...input, photo: 'data:image/jpeg;base64,' + 'A'.repeat(1400000) }), /até 1 MB/); passed++;
  await assert.rejects(decode({ ...input, photo: 'data:image/svg+xml;base64,PHN2Zz4=' }), /Formato/); passed++;
  console.log('PASS: ' + passed + ' photo integrity cases — complete JPEG/PNG/WebP retain exact bytes; truncated, mismatched, oversized and invalid payloads rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
