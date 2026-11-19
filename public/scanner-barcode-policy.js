(function (root, factory) {
  'use strict';
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ScannerBarcodePolicy = policy;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function codeOf(value) { return String(value || '').trim(); }
  // Código alfanumérico do fornecedor impresso em Code 128 (ex.: Atama KIM10U0001011, NF-e "SEM GTIN").
  // Estrito para referência de modelo não passar: só maiúsculas e números, 10–24, ≥2 letras e ≥2 números.
  function isSupplierCode(value) { return /^(?=(?:[^A-Z]*[A-Z]){2})(?=(?:\D*\d){2})[A-Z0-9]{10,24}$/.test(codeOf(value)); }
  function isInternalCode(value) { const code = codeOf(value); return /^\d{16}$/.test(code) && !/^0+$/.test(code); }
  function isScanCode(value) {
    const code = codeOf(value);
    return (/^(?:\d{8}|\d{12,14})$/.test(code) && !/^0+$/.test(code)) || isInternalCode(code) || isSupplierCode(code);
  }
  function identity(value) {
    const code = codeOf(value);
    return isInternalCode(code) || isSupplierCode(code) ? code : code.replace(/^0+/, '');
  }
  function variants(value) {
    const code = codeOf(value);
    if (!isScanCode(code)) return code ? [code] : [];
    if (isInternalCode(code) || isSupplierCode(code)) return [code];
    const normalized = identity(code);
    const aliases = [code, normalized, code.padStart(13, '0'), code.padStart(14, '0')];
    // UPC-A can itself start with zero. An equivalent EAN-13/GTIN-14 read
    // must still find that exact 12-digit catalogue key. Never truncate a
    // nonzero digit, expand EAN-8 here, or alias the opaque 16-digit code.
    if (/^\d{12,14}$/.test(code)) for (const length of [12, 13, 14]) {
      if (normalized.length <= length) aliases.push(normalized.padStart(length, '0'));
    }
    return [...new Set(aliases)];
  }
  return Object.freeze({ codeOf, isInternalCode, isSupplierCode, isScanCode, identity, variants });
});
