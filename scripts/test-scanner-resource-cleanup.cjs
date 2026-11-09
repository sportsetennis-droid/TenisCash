'use strict';
// Lifecycle regression tests only: no camera, browser, OCR engine, network or user data.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const html = source('bipar.html');
const compressorStart = html.indexOf('  function comprimirFoto(file)');
const compressorEnd = html.indexOf('  function renderLista()', compressorStart);
assert(compressorStart >= 0 && compressorEnd > compressorStart, 'The production photo compressor must be present');
const compressor = html.slice(compressorStart, compressorEnd);

function compressionHarness(mode) {
  const active = new Set(), images = [], canvases = [];
  let sequence = 0;
  const context = {
    Promise,
    Image: class {
      constructor() { this.width = 1600; this.height = 1200; images.push(this); }
      set src(value) {
        this.url = value;
        if (value) queueMicrotask(() => { if (mode === 'image-error') this.onerror(); else this.onload(); });
      }
      get src() { return this.url; }
    },
    URL: {
      createObjectURL() {
        if (mode === 'url-error') throw Error('synthetic URL failure');
        const key = 'blob:synthetic-' + ++sequence; active.add(key); return key;
      },
      revokeObjectURL: key => active.delete(key),
    },
    document: {
      createElement() {
        const canvas = {
          width: 0, height: 0,
          getContext() { return { drawImage() { if (mode === 'draw-error') throw Error('synthetic draw failure'); } }; },
          toBlob(done, type, quality) {
            assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.72, 'Existing JPEG quality is preserved');
            assert.equal(canvas.width, 1280); assert.equal(canvas.height, 960, 'Existing aspect ratio and resolution are preserved');
            if (mode === 'blob-throw') throw Error('synthetic blob failure');
            queueMicrotask(() => done(mode === 'blob-empty' ? null : { type: 'image/jpeg', bytes: 'synthetic' }));
          },
        };
        canvases.push(canvas); return canvas;
      },
    },
  };
  vm.runInNewContext(compressor + '\nthis.compress = comprimirFoto;', context);
  return { compress: context.compress, active, images, canvases };
}

function ocrHarness(createWorker) {
  const timers = new Map(); let sequence = 0;
  const window = { Tesseract: { createWorker } };
  vm.runInNewContext(source('scanner-ocr.js'), {
    window, Promise,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { ocr: window.ScannerOCR, timers };
}

async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

(async () => {
  for (const mode of ['success', 'image-error', 'url-error', 'draw-error', 'blob-throw', 'blob-empty']) {
    const h = compressionHarness(mode);
    for (let i = 0; i < 5; i++) {
      if (mode === 'success') assert.equal((await h.compress({})).type, 'image/jpeg');
      else await assert.rejects(h.compress({}));
    }
    assert.equal(h.active.size, 0, 'No object URL remains after ' + mode);
    assert(h.canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Every canvas backing store is released after ' + mode);
    assert(h.images.every(image => image.src === '' && image.onload === null && image.onerror === null), 'Image and callbacks are released after ' + mode);
  }
  console.log('PASS: 30 compression operations release URLs, images and canvases on success and every load/URL/draw/blob failure; JPEG settings are preserved.');

  for (const terminationFails of [false, true]) {
    const workers = [];
    const h = ocrHarness(async () => {
      const worker = {
        terminated: 0,
        async setParameters() { throw Error('synthetic OCR initialization failure'); },
        async terminate() { this.terminated++; if (terminationFails) throw Error('synthetic termination failure'); },
      };
      workers.push(worker); return worker;
    });
    for (let i = 0; i < 3; i++) await assert.rejects(h.ocr.recognize('synthetic'), /synthetic OCR initialization failure/);
    assert.equal(workers.length, 3, 'A failed initialization is retryable');
    assert.deepEqual(workers.map(worker => worker.terminated), [1, 1, 1], 'Every created but failed worker must be terminated before another attempt');
    await h.ocr.stop();
    assert.deepEqual(workers.map(worker => worker.terminated), [1, 1, 1], 'Stop must not revisit released workers');
    assert.equal(h.timers.size, 0);
  }
  console.log('PASS: successive OCR initialization failures release each worker; failed cleanup preserves the original error and does not prevent retries.');

  let resolveCreated, parameters = 0, terminated = 0;
  const delayed = new Promise(resolve => { resolveCreated = resolve; });
  const h = ocrHarness(() => delayed);
  const pending = h.ocr.recognize('synthetic');
  const rejected = assert.rejects(pending, /Leitura cancelada/);
  await microtasks();
  await h.ocr.stop();
  resolveCreated({ async setParameters() { parameters++; }, async terminate() { terminated++; } });
  await rejected;
  assert.equal(parameters, 0, 'A worker created after cancellation must not initialize or OCR an image');
  assert.equal(terminated, 1, 'A late created worker must be released exactly once');
  await h.ocr.stop();
  assert.equal(h.timers.size, 0);
  console.log('PASS: cancellation during worker creation releases its late result without starting OCR.');
})().catch(error => { console.error(error); process.exitCode = 1; });
