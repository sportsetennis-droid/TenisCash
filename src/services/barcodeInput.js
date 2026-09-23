'use strict';

const WEBSITE_BARCODE_ERROR_CODE = 'QR_URL_NOT_BARCODE';
const WEBSITE_BARCODE_ERROR = 'Foi lido um QR Code de site, não o código de barras do produto. Leia as barras da etiqueta (EAN/UPC) ou busque pela referência.';

// Barcode readers may type QR contents into the same field as EAN/UPC.
// Do not guess a product or turn a website/URI into a variant identifier.
// Ordinary alphanumeric supplier/internal codes remain supported.
function isWebsiteBarcode(value) {
  const code = String(value == null ? '' : value).trim();
  return /^(?:[a-z][a-z\d+.-]*:\/\/|\/\/|www\.|qr\.nike\.com(?:[\/?#:]|$))/i.test(code)
    || /^(?:https?|javascript|data|mailto|tel):/i.test(code);
}

module.exports = { isWebsiteBarcode, WEBSITE_BARCODE_ERROR, WEBSITE_BARCODE_ERROR_CODE };
