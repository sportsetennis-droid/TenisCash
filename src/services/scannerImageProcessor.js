'use strict';
const path = require('node:path');
const barcodePolicy = require('../../public/scanner-barcode-policy');
// One reusable OCR worker per isolated process; the parent owns deadlines.
// Never terminate while Tesseract is preparing an image asynchronously.
function createProcessor(deps = {}) {
  const sharp = deps.sharp || require('sharp');
  const decode = deps.decode || require('./scannerBarcodeEngine').decode;
  const readWords = deps.readWords || require('./scannerArchivedLabel').readWords;
  const createWorker = deps.createWorker || require('tesseract.js').createWorker;
  let worker, busy = false;
  const input = image => sharp(image, { limitInputPixels: 24000000 });
  async function label(image, barcode) {
    const codes = await decode(image);
    if (codes.length !== 1 || barcodePolicy.identity(codes[0]) !== barcodePolicy.identity(barcode)) {
      return { pending: true, reason: 'photo_barcode_conflict' };
    }
    if (!worker) worker = await createWorker('eng', 1, {
      langPath: path.join(__dirname, '../../public/vendor/ocr'), cacheMethod: 'none', errorHandler: () => {},
    });
    await worker.setParameters({ preserve_interword_spaces: '1' });
    for (const angle of [0, 90, 270, 180]) {
      const frame = angle ? await input(image).rotate(angle).png().toBuffer() : image;
      const metadata = await input(frame).metadata();
      const enhanced = await input(frame).resize({ width: Math.min(3000, metadata.width * 2) }).greyscale().normalize().png().toBuffer();
      // Same original/enhanced pixels and literal-scale guards. No database
      // product/size information is sent to this process.
      for (const psm of ['11', '6']) {
        await worker.setParameters({ tessedit_pageseg_mode: psm });
        for (const candidate of [frame, enhanced]) {
          const observed = readWords((await worker.recognize(candidate, {}, { text: true, blocks: true })).data);
          if (observed) return { ...observed, decodedBarcodes: codes };
        }
      }
    }
    return { pending: true, reason: 'photo_size_or_reference_pending' };
  }
  async function run(kind, image, barcode) {
    if (busy) throw Error('image_process_busy');
    busy = true;
    try {
      if (kind === 'barcode') return await decode(image);
      if (kind === 'label') return await label(image, barcode);
      throw Error('image_operation_invalid');
    } finally { busy = false; }
  }
  async function close() {
    if (busy) throw Error('image_process_busy');
    if (worker) { const old = worker; worker = null; await old.terminate(); }
  }
  return { run, close };
}
module.exports = { createProcessor };
