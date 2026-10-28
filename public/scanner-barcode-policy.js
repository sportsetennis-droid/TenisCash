(function (root, factory) {
  'use strict';
  const policy = factory();
  if (typeof module === 'object' && module.exports) module.exports = policy;
  else root.ScannerBarcodePolicy = policy;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function codeOf(value) { return String(value || '').trim(); }
  function isInternalCode(value) { const code = codeOf(value); return /^\d{16}$/.test(code) && !/^0+$/.test(code); }
  function isScanCode(value) {
    const code = codeOf(value);
    return (/^(?:\d{8}|\d{12,14})$/.test(code) && !/^0+$/.test(code)) || isInternalCode(code);
  }
  function identity(value) {
    const code = codeOf(value);
    return isInternalCode(code) ? code : code.replace(/^0+/, '');
  }
  function variants(value) {
    const code = codeOf(value);
    if (!isScanCode(code)) return code ? [code] : [];
    if (isInternalCode(code)) return [code];
    return [...new Set([code, identity(code), code.padStart(13, '0'), code.padStart(14, '0')])];
  }
  return Object.freeze({ codeOf, isInternalCode, isScanCode, identity, variants });
});
