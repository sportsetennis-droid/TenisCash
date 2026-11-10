'use strict';
// Per-brand label layouts. Each layout says where the LITERAL Brazilian size
// value sits relative to its own printed BR/BRA caption on that manufacturer's
// label, and which printed reference shape the label carries. No layout
// converts a foreign scale, and no layout derives a size from a reference.
const norm = (v) => String(v || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
const clean = (v) => String(v || '').normalize('NFKC').trim().replace(/^[^\w]+|[^\w/.,]+$/g, '');

// Join same-line neighbours (in reading order) so references printed as two
// tokens ("106455 01", "232932 / CCRD") can be matched as a single field.
function lineTexts(words) {
  const rows = [];
  for (const w of [...words].filter(w => w.bbox).sort((a, z) => a.bbox.x0 - z.bbox.x0)) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2, h = w.bbox.y1 - w.bbox.y0;
    let row = rows.find(r => Math.abs(r.cy - cy) <= Math.max(r.h, h) * 0.45 && w.bbox.x0 - r.x1 <= Math.max(r.h, h) * 2.2 && w.bbox.x0 >= r.x1 - Math.max(r.h, h) * 0.3);
    if (!row) { row = { cy, h, x1: w.bbox.x1, words: [] }; rows.push(row); }
    row.words.push(w); row.x1 = Math.max(row.x1, w.bbox.x1);
  }
  return rows.map(r => ({ words: r.words, text: r.words.map(w => clean(w.text)).filter(Boolean).join(' ').toUpperCase(), confidence: Math.min(...r.words.map(w => w.confidence)) }));
}

// Reference extractors return normalized printed identifiers only when the
// complete shape is present with reliable characters.
const REF_CONFIDENCE = 70;
function refsByRegex(words, regexes) {
  const out = new Set();
  for (const line of lineTexts(words.filter(w => w.confidence >= REF_CONFIDENCE))) {
    for (const re of regexes) for (const m of line.text.matchAll(re)) out.add(norm(m[1]) + (m[2] ? norm(m[2]) : ''));
  }
  return [...out];
}

const LAYOUTS = {
  PUMA: {
    // "106455 01" model + two-digit colour; scale header UK US EUR BR above values.
    signature: /\bPUMA\b/,
    directions: ['below'],
    // Colour may be printed without its leading zero ("404440 2" = colour 02).
    references: (w) => refsByRegex(w, [/(?:^|\s)(\d{6}) ?(\d{2})(?=\s|$)/g])
      .concat(refsByRegex(w, [/(?:^|\s)(\d{6}) (\d)(?=\s|$)/g]).map(r => r.slice(0, 6) + '0' + r.slice(6))),
    // Reference line printed just above the barcode, left-aligned with it.
    refZone: { box: [-0.15, -0.32, 1.0, 0.02], whitelist: '0123456789 ' },
    eurCheck: true,
  },
  ADIDAS: {
    // Grid BR/UK, F/US, J/CHN with captions above values; article like GW1988.
    signature: /\bADIDAS\b/,
    directions: ['below'],
    references: (w) => refsByRegex(w, [/(?:^|\s)([A-Z]{2}\d{4})(?=\s|$)/g]),
  },
  CONVERSE: {
    // Values printed ABOVE their captions: "38" over "BR"; reference CT09830001.
    signature: /CONVERSE/,
    directions: ['above'],
    // Second character is always a letter (CT, CK, CO...): a zero read there
    // is the letter O. Any other digit/letter confusion is left unresolved.
    references: (w) => refsByRegex(w, [/(?:^|\s)([A-Z]\d{9}|C[A-Z]\d{8})(?=\s|$)/g]).map(r => /^C0\d{8}$/.test(r) ? 'CO' + r.slice(2) : r),
    // Reference block to the right of the barcode, beside the bars.
    refZone: { box: [1.1, -0.15, 2.4, 0.55], whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /' },
    eurCheck: true,
  },
  SALOMON: {
    // Right column rows "UK 11.5 / EUR 46⅔ / USA 12 / BR 44"; title "471800 X BRAZE".
    signature: /SALOMON/,
    directions: ['right'],
    references: (w) => refsByRegex(w, [/^(\d{6}) [A-Z]/g, /(?:^|\s)L(\d{6})\d{3,4}(?=\s|$)/g]),
    eurCheck: true,
  },
  OUS: {
    // "Ref.:350044 18"; inverted black band "BR 39" (value right of caption).
    signature: /\bOUS\b/,
    directions: ['right'],
    negative: true,
    references: (w) => refsByRegex(w, [/REF\W{0,3}(\d{6}) ?(\d{1,3})(?=\s|$)/g]),
  },
  ASICS: {
    // "1011B911.400"; "BR 44" with the value right of (and slightly below) BR.
    signature: /\bASICS\b/,
    directions: ['right'],
    references: (w) => refsByRegex(w, [/(?:^|\s)(\d{4}[A-Z]\d{3})[.\-]?(\d{3})(?=\s|$)/g]),
    eurCheck: true,
  },
  SKECHERS: {
    // "894294BR/NVY" with a vertical scale column (BRA over 42), or
    // "232932 / CCRD" with a small grid row "BRA 41".
    signature: /SKECHERS/,
    directions: ['below', 'right'],
    references: (w) => refsByRegex(w, [/(?:^|\s)(\d{5,6}(?:BR)?)(?: ?\/ ?| )([A-Z]{2,5})(?=\s|$)/g]),
    eurCheck: true,
  },
  REEBOK: {
    // Big "40" over "BR" at the left; nine-digit article or UCNV001 style.
    signature: /\bREEBOK\b/,
    directions: ['above'],
    references: (w) => refsByRegex(w, [/(?:^|\s)(100\d{6})(?=\s|$)/g, /(?:^|\s)(U[A-Z]{3}\d{3}[A-Z]{0,6})(?=\s|$)/g]),
  },
  FIBER: {
    // "BRA" over the (often paired) value "38/39"; full reference with size.
    signature: /\bFIBER\b/,
    directions: ['below'],
    references: (w) => refsByRegex(w, [/((?:SFBMUL|TFBU|TFER|FBRFLYR)[A-Z0-9\-]{2,24}(?:\/\d{2})?)/g]),
  },
};

// The label's own brand words may veto a catalogue hint; a hint never
// overrides a different printed brand. Without a hint, exactly one printed
// brand signature selects the layout.
function detectBrand(words, hint) {
  const text = lineTexts(words.filter(w => w.confidence >= 70)).map(l => l.text).join('\n');
  const printed = Object.entries(LAYOUTS).filter(([, l]) => l.signature.test(text)).map(([k]) => k);
  const h = norm(hint);
  if (h) {
    if (printed.some(b => b !== h)) return { conflict: true };
    return LAYOUTS[h] ? { brand: h } : { brand: null };
  }
  return printed.length === 1 ? { brand: printed[0] } : { brand: null };
}
module.exports = { LAYOUTS, detectBrand, lineTexts, norm, clean };
