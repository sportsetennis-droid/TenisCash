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
  const rows = await getMod().readBarcodes({ data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height },
    { tryHarder: true, tryRotate: true, tryInvert: true, formats: ['EAN-13', 'UPC-A', 'EAN-8', 'Code128', 'ITF'], maxNumberOfSymbols: 3 });
  return [...new Set(rows.map(r => String(r.text || '').trim()).filter(barcodePolicy.isScanCode))];
}
async function decode(image) {
  const codes = await read(image);
  if (codes.length) return codes;
  const frame = await sharp(image, { limitInputPixels: MAX_PIXELS }).rotate(270)
    .resize({ width: 2400, height: 2400, fit: 'inside' }).grayscale().normalize().png().toBuffer();
  const enhancedCodes = await read(frame);
  if (enhancedCodes.length) return enhancedCodes;
  // Reuse the camera's bounded all-candidate recovery only after both whole
  // frame reads failed. No expected barcode or catalogue data selects a region.
  const { data, info } = await sharp(image, { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const recovered = [];
  const result = await require('../../public/scanner-auto').decodeFullFramePixels({
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height,
  }, {
    normalizePixels: require('../../public/scanner-regions').normalizePixels,
    readBarcodes: async (pixels, options) => { const rows = await getMod().readBarcodes(pixels, options); recovered.push(...rows); return rows; },
  });
  // A candidate/pixel budget failure is not permission to accept the first
  // recovered label. Preserve all distinct results when the scan is ambiguous.
  if (!result.code && !result.ambiguous) return [];
  return [...new Set(recovered.map(r => String(r.text || '').trim()).filter(barcodePolicy.isScanCode))];
}
// Positions are needed only by the brand label readers, which use the decoded
// symbol as a geometric anchor. Same decoder, formats and pixel budget.
async function readPositions(pixels) {
  const rows = await getMod().readBarcodes(pixels, { tryHarder: true, tryRotate: true, tryInvert: true,
    formats: ['EAN-13', 'UPC-A', 'EAN-8', 'Code128', 'ITF'], maxNumberOfSymbols: 8 });
  return rows.map(r => ({ text: String(r.text || '').trim(), position: r.position })).filter(r => barcodePolicy.isScanCode(r.text) && r.position);
}
module.exports = { decode, readPositions, MAX_PIXELS };
