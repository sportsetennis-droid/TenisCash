'use strict';

const { validGtin } = require('./scannerReference');

// OCR is untrusted input. Only literal identifiers are used, never fuzzy names,
// corrected digits (O -> 0), guessed shoe sizes, or shortened colour references.
function parseScannerText(value) {
  if (typeof value !== 'string') return null;
  const text = value.slice(0, 4000).normalize('NFKC').toUpperCase()
    .replace(/[‐‑–—]/g, '-').replace(/\r/g, '');
  const codes = new Set();
  const gtins = new Set();
  const sizes = new Set();
  const add = code => { if (code && code.length <= 50) codes.add(code); };
  for (const line of text.split('\n')) {
    const clean = line.trim();
    if (/HTTPS?:|WWW\.|@/.test(clean)) continue;
    for (const match of clean.matchAll(/\b[A-Z]{2}\d{4}[ -]?\d{3}\b/g)) add(match[0].replace(/ /g, '-'));
    for(const m of clean.matchAll(/\b\d{5,6}(?:BR)?\s*[/\-]\s*[A-Z]{2,5}\b/g)) add(m[0].replace(/\s/g,'').replace('/','-'));
    for (const token of clean.match(/[A-Z0-9]+(?:[-_.][A-Z0-9]+)*/g) || []) {
      if (validGtin(token)) gtins.add(token);
      else if (/^\d{5,9}$/.test(token) || (token.length >= 5 && /[A-Z]/.test(token) && /\d/.test(token)) || /^[A-Z]{3,}-[A-Z]{3,}(?:-[A-Z0-9]+)*$/.test(token)) add(token);
    }
    // UPC digits are frequently printed in separated groups under the bars.
    if (/^[\d ]+$/.test(clean)) {
      const digits = clean.replace(/ /g, '');
      if (validGtin(digits)) gtins.add(digits);
    }
    const clothing = clean.match(/^(?:(?:SIZE|TAM(?:ANHO)?\.?)[ :]+)?(XXXL|XXL|XL|XS|PP|GGG|GG|P|M|G|S|L|U)$/);
    if (clothing) sizes.add(clothing[1]);
    for (const match of clean.matchAll(/\bBRA?\s*[:\-]?\s*(\d{2}(?:[.,]5)?)(?!\d)/g)) sizes.add('BR ' + match[1].replace(',', '.'));
  }
  const brands = [...text.matchAll(/\b(SKECHERS|NIKE|ADIDAS|FIBER|TOPPER|MIZUNO|ASICS|PUMA|FILA|REEBOK|OLYMPIKUS|UMBRO|EVERLAST|NEW BALANCE|UNDER ARMOUR)\b/g)].map(m => m[1]);
  // Several sizes/barcodes/brands can mean several labels: require review.
  if (gtins.size > 1 || sizes.size > 1 || new Set(brands).size > 1) return null;
  const codigos = [...codes].slice(0, 12);
  if (!codigos.length && !gtins.size) return null;
  return { codigos, sku: codigos[0] || null, ean: [...gtins][0] || null,
    tamanho: [...sizes][0] || null, marca: brands[0] || null, source: 'tesseract-local' };
}

function scannerPendingMessage(text, read, reason) {
  if(!read&&reason==='inactive_product')return 'Código encontrado em cadastro inativo sem vínculo válido de consolidação. Precisa de revisão.';
  if(!read&&reason==='barcode_conflict')return 'Código encontrado em mais de um produto. Precisa de revisão para evitar contar no produto errado.';
  if(!read&&reason==='reference_not_found')return 'Código lido, mas não localizado no cadastro. A referência da foto ainda precisa ser identificada.';
  if (!read) return String(text || '').trim()
    ? 'Li texto, mas os códigos ou tamanhos ficaram ambíguos. Foto salva para conferência.'
    : 'Não consegui extrair a referência da foto. Foto salva para conferência.';
  const label = read.sku || read.ean || 'código';
  const reasons = { reference_not_found: 'referência não encontrada no cadastro/NF-e',
    size_required: 'falta confirmar o tamanho', reference_conflict: 'mais de um produto corresponde à referência',
    barcode_conflict: 'código de barras em conflito', size_conflict: 'tamanho diferente do cadastro',
    size_barcode_conflict: 'o tamanho já possui outro código de barras', brand_conflict: 'marca diferente do cadastro',
    invalid_barcode: 'código de barras não validado', inactive_product: 'produto inativo', matched: 'contagem aguardando conclusão' };
  return 'Li ' + label + (read.tamanho ? ' / ' + read.tamanho : '') + ' — ' + (reasons[reason] || 'aguardando conferência');
}
module.exports = { parseScannerText, scannerPendingMessage };
