'use strict';
// API-side adapter: sharp and ZXing execute in the bounded image process.
const broker = require('./scannerImageBroker');
async function decodeBarcodesFromDataUri(uri) {
  if (!uri) return [];
  const value = String(uri);
  if (value.length > Math.ceil(broker.limits.maxImageBytes * 4 / 3) + 256) throw broker.failure('SCANNER_IMAGE_INVALID');
  const image = Buffer.from(value.slice(value.indexOf(',') + 1), 'base64');
  return broker.run('barcode', image, null, { queue: true });
}
module.exports = { decodeBarcodesFromDataUri };
