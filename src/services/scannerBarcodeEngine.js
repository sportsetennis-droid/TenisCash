'use strict';
// Heavy dependencies are loaded only by the isolated image process.
const fs = require('node:fs'), path = require('node:path'), sharp = require('sharp');
const barcodePolicy = require('../../public/scanner-barcode-policy');
const MAX_PIXELS = 24000000;
let mod;
function getMod() {
  if (!mod) {
    mod = require('zxing-wasm/reader');
    const file = path.join(__dirname, '../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
    const overrides = { wasmBinary: fs.readFileSync(file) };
    if (mod.prepareZXingModule) mod.prepareZXingModule({ overrides }); else mod.setZXingModuleOverrides(overrides);
  }
  return mod;
}
async function read(buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows = await getMod().readBarcodes({ data: new Uint8ClampedArray(data), width: info.width, height: info.height },
    { tryHarder: true, tryRotate: true, tryInvert: true, formats: ['EAN-13', 'UPC-A', 'EAN-8', 'Code128', 'ITF'], maxNumberOfSymbols: 3 });
  return [...new Set(rows.map(r => String(r.text || '').trim()).filter(barcodePolicy.isScanCode))];
}
async function decode(image) {
  const codes = await read(image);
  if (codes.length) return codes;
  const frame = await sharp(image, { limitInputPixels: MAX_PIXELS }).rotate(270)
    .resize({ width: 2400, height: 2400, fit: 'inside' }).grayscale().normalize().png().toBuffer();
  return read(frame);
}
module.exports = { decode, MAX_PIXELS };
