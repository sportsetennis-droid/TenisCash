'use strict';
// Brand label readers: barcode-anchored, per-manufacturer layouts, local OCR
// only (Tesseract in this isolated process). Returns no size whenever any step
// is not conclusive, so the caller keeps its generic pass and its pending
// outcome. A result is literal evidence from this photo only; catalogue size,
// product and reference checks remain in stockReplacement.validateRead and
// referenceMatches. Never converts foreign scales and never guesses.
const geometry = require('./labelGeometry');
const { LAYOUTS, detectBrand, clean } = require('./brandLayouts');
const { readBr } = require('./sizeField');
const VERSION = 'brand-label-reader-v1';
// Brands enabled after the ground-truth evaluation (Loja 04 / rodada 27, 250
// reviewed pairs): each produced correct literal BR reads and zero wrong ones.
// OUS, ASICS and REEBOK layouts exist but produced no confirmed read on the
// truth set, so they stay disabled (detected, never answering).
const ENABLED = new Set(['PUMA', 'CONVERSE', 'FIBER', 'SKECHERS', 'ADIDAS', 'SALOMON']);

const wordsOf = (data) => (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).flatMap(l => (l.words || []).map(w => ({ text: w.text, confidence: w.confidence, bbox: w.bbox })))));

// Parse every OCR variant of one label. Variants must not contradict each
// other: one brand layout, one BR value. Pure function (unit-testable).
function decide(variants, { enabled = ENABLED, hint = null } = {}) {
  const detected = variants.map(v => detectBrand(v.words, hint));
  if (detected.some(d => d.conflict)) return { reason: 'brand_text_conflict' };
  const brands = [...new Set(detected.map(d => d.brand).filter(Boolean))];
  if (!brands.length) return { reason: 'brand_layout_unknown' };
  if (brands.length > 1) return { reason: 'brand_layout_conflict' };
  const brand = brands[0];
  if (!enabled.has(brand)) return { reason: 'brand_reader_disabled', brand };
  const layout = LAYOUTS[brand];
  const parsed = variants.map(v => ({ key: v.key, ...readBr(v.words, layout), references: layout.references(v.words) }));
  const sizes = [...new Set(parsed.map(p => p.size).filter(Boolean))];
  if (sizes.length > 1) return { reason: 'variants_disagree', brand, parsed };
  const vetoes = ['br_conflict', 'eur_br_inconsistent', 'multiple_size_grids', 'multiple_audiences'];
  const veto = parsed.find(p => vetoes.includes(p.reason));
  if (veto) return { reason: veto.reason, brand, parsed };
  if (!sizes.length) return { reason: parsed.find(p => p.reason)?.reason || 'br_not_read', brand, parsed };
  // OCR may misread one digit of the reference in one variant. Keep the
  // reference read by the most variants; ties keep every candidate (the
  // existing reference check then refuses an ambiguous set).
  const votes = new Map();
  for (const p of parsed) for (const r of new Set(p.references || [])) votes.set(r, (votes.get(r) || 0) + 1);
  const top = Math.max(0, ...votes.values());
  const references = [...votes].filter(([, n]) => n === top).map(([r]) => r);
  // Not an answer, but the literal BR it saw is kept as evidence for callers.
  if (!references.length) return { reason: 'reference_not_read', brand, parsed, literalSize: sizes[0] };
  const witness = parsed.find(p => p.size);
  return { brand, size: sizes[0], references, witness, support: parsed.filter(p => p.size).length, parsed };
}

// Prefer the orientation whose text Tesseract reads with confidence.
function legibility(words) { return words.filter(w => w.confidence >= 80 && /[A-Z0-9]{2,}/i.test(w.text)).reduce((s, w) => s + String(w.text).length, 0); }

// Second, independent read of the BR value: a tight crop around the value
// token, OCR'd as one line restricted to digits. It must reproduce the value.
async function confirmValue({ sharp, worker, buffer, size, token }) {
  const b = token.bbox, h = b.y1 - b.y0, w = b.x1 - b.x0;
  const left = Math.max(0, Math.floor(b.x0 - h * 0.5)), top = Math.max(0, Math.floor(b.y0 - h * 0.35));
  const width = Math.min(size.width - left, Math.ceil(w + h * 1.0)), height = Math.min(size.height - top, Math.ceil(h * 1.7));
  if (width < 4 || height < 4) return null;
  const k = Math.max(0.5, Math.min(4, 60 / h));
  const zoom = await sharp(buffer).extract({ left, top, width, height }).resize({ width: Math.max(1, Math.round(width * k)) })
    .extend({ top: 24, bottom: 24, left: 24, right: 24, extendWith: 'copy' }).png().toBuffer();
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789./' });
  try {
    const data = (await worker.recognize(zoom, {}, { text: true })).data;
    return String(data.text || '').replace(/\s+/g, '').replace(',', '.');
  } finally { await worker.setParameters({ tessedit_char_whitelist: '' }); }
}

// Small scale captions (BR, US, EUR...) are often missed by the full-label
// pass. For each printed size-shaped number, look exactly where this brand's
// layout puts its caption and OCR that spot alone, letters only. A probe
// only ADDS captions that are literally read there (conf >= 80); every other
// rule (ownership by other captions, uniqueness, variant agreement, EUR check,
// zoomed confirmation of the value) still applies afterwards.
const SIZE_SHAPED = /^\d{2}(?:[.,]5|\/\d{2})?$/;
const PROBE_SCALE = /^(BRA?|USA?|UK|EUR?|CM|JPN?|CHN|AR|MM)$/;
// Tesseract word boxes can be much taller than the glyphs. Shrink a box to
// the rows/columns that actually contain ink (Otsu inside the box).
async function tightBox(sharp, buffer, size, b) {
  const left = Math.max(0, Math.floor(b.x0)), top = Math.max(0, Math.floor(b.y0));
  const width = Math.min(size.width, Math.ceil(b.x1)) - left, height = Math.min(size.height, Math.ceil(b.y1)) - top;
  if (width < 3 || height < 3) return b;
  const px = await sharp(buffer).extract({ left, top, width, height }).greyscale().raw().toBuffer();
  const t = otsu(px), mean = px.reduce((a, v) => a + v, 0) / px.length, inkDark = mean > t;
  const ink = (x, y) => { const v = px[y * width + x]; return inkDark ? v < t : v > t; };
  // The box may also contain a neighbouring caption line: keep the tallest
  // run of consecutive inked rows (the digits themselves).
  const rowInk = [];
  for (let y = 0; y < height; y++) { let n = 0; for (let x = 0; x < width; x++) if (ink(x, y)) n++; rowInk.push(n > Math.max(1, width * 0.01)); }
  let best = null;
  for (let y = 0; y < height;) {
    if (!rowInk[y]) { y++; continue; }
    let e = y; while (e + 1 < height && (rowInk[e + 1] || (e + 2 < height && rowInk[e + 2]))) e++;
    if (!best || e - y > best[1] - best[0]) best = [y, e];
    y = e + 1;
  }
  if (!best) return b;
  let x0 = width, x1 = -1;
  for (let y = best[0]; y <= best[1]; y++) for (let x = 0; x < width; x++) if (ink(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  return x1 < 0 ? b : { x0: left + x0, x1: left + x1 + 1, y0: top + best[0], y1: top + best[1] + 1 };
}

async function probeCaptions({ sharp, worker, buffer, size, words, layout, source = null, limit = 8, deadline = Infinity }) {
  // source: same orientation at full resolution (sharper small captions).
  const src = source || { buffer, size }, s = src.size.width / size.width;
  const values = words.filter(w => w.bbox && w.confidence >= 75 && /^\d{2}(?:[.,]5|\/\d{2})?$/.test(clean(w.text)) && Number(clean(w.text).slice(0, 2)) >= 15 && Number(clean(w.text).slice(0, 2)) <= 50)
    .sort((a, z) => (z.bbox.y1 - z.bbox.y0) - (a.bbox.y1 - a.bbox.y0)).slice(0, limit);
  const added = [];
  const overlaps = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)) > 0.3 * (a.x1 - a.x0) * (a.y1 - a.y0);
  for (const v of values) {
    if (Date.now() > deadline) throw Object.assign(Error('brand_budget_exceeded'), { budget: true });
    const b = await tightBox(sharp, src.buffer, src.size, { x0: v.bbox.x0 * s, x1: v.bbox.x1 * s, y0: v.bbox.y0 * s, y1: v.bbox.y1 * s });
    const h = b.y1 - b.y0;
    if (h < 4) continue;
    for (const dir of layout.directions) {
      const r = dir === 'below' ? { x0: b.x0 - 0.5 * h, x1: b.x1 + 0.5 * h, y0: b.y0 - 1.3 * h, y1: b.y0 - 0.05 * h }
        : dir === 'above' ? { x0: b.x0 - 0.3 * h, x1: b.x1 + 0.6 * h, y0: b.y1 + 0.04 * h, y1: b.y1 + 0.68 * h }
          : dir === 'right' ? { x0: b.x0 - 2.6 * h, x1: b.x0 - 0.05 * h, y0: b.y0 - 0.25 * h, y1: b.y1 + 0.25 * h }
            : null;
      if (!r) continue;
      const left = Math.max(0, Math.floor(r.x0)), top = Math.max(0, Math.floor(r.y0));
      const width = Math.min(src.size.width, Math.ceil(r.x1)) - left, height = Math.min(src.size.height, Math.ceil(r.y1)) - top;
      if (width < 6 || height < 6) continue;
      const k = Math.max(0.5, Math.min(5, 110 / height));
      let pipe = sharp(src.buffer).extract({ left, top, width, height });
      const stats = await sharp(src.buffer).extract({ left, top, width, height }).stats();
      if (stats.channels[0].mean < 110) pipe = pipe.negate({ alpha: false });
      const img = await pipe.normalize().resize({ width: Math.max(1, Math.round(width * k)) }).extend({ top: 16, bottom: 16, left: 16, right: 16, extendWith: 'copy' }).png().toBuffer();
      // Same spot, also binarized at its own Otsu level: faint grey captions.
      const grey = await sharp(img).greyscale().raw().toBuffer();
      const binary = await sharp(img).greyscale().threshold(otsu(grey)).png().toBuffer();
      const found = [];
      await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
      try { for (const input of [img, binary]) found.push(...wordsOf((await worker.recognize(input, {}, { blocks: true })).data)); }
      finally { await worker.setParameters({ tessedit_char_whitelist: '' }); }
      for (const f of found) {
        const text = clean(f.text).toUpperCase();
        if (!PROBE_SCALE.test(text) || f.confidence < 80) continue;
        // Back to the variant's coordinates.
        const bbox = { x0: (left + (f.bbox.x0 - 16) / k) / s, x1: (left + (f.bbox.x1 - 16) / k) / s, y0: (top + (f.bbox.y0 - 16) / k) / s, y1: (top + (f.bbox.y1 - 16) / k) / s };
        if ([...words, ...added].some(w => w.bbox && overlaps(bbox, w.bbox) && clean(w.text).toUpperCase() === text)) continue;
        added.push({ text, confidence: Math.round(f.confidence), bbox, probed: true });
      }
    }
  }
  return added;
}

function otsu(values) {
  const h = new Array(256).fill(0); for (const v of values) h[v]++;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * h[i];
  let sB = 0, wB = 0, best = -1, t = 128;
  for (let i = 0; i < 256; i++) { wB += h[i]; if (!wB) continue; const wF = values.length - wB; if (!wF) break; sB += i * h[i]; const d = wB * wF * (sB / wB - (sum - sB) / wF) ** 2; if (d > best) { best = d; t = i; } }
  return Math.max(1, t);
}

// A brand's reference zone, in barcode-width units from the anchor's top-left
// corner on the barcode-upright crop. Used only to read the printed reference.
async function zoneImage({ sharp, crop, box }) {
  const W = crop.bar.x1 - crop.bar.x0, meta = await sharp(crop.crop).metadata();
  const left = Math.max(0, Math.floor(crop.bar.x0 + box[0] * W)), top = Math.max(0, Math.floor(crop.bar.y0 + box[1] * W));
  const right = Math.min(meta.width, Math.ceil(crop.bar.x0 + box[2] * W)), bottom = Math.min(meta.height, Math.ceil(crop.bar.y0 + box[3] * W));
  if (right - left < 8 || bottom - top < 8) return null;
  const buffer = await sharp(crop.crop).extract({ left, top, width: right - left, height: bottom - top })
    .extend({ top: 16, bottom: 16, left: 16, right: 16, extendWith: 'copy' }).png().toBuffer();
  return { buffer, size: { width: right - left + 32, height: bottom - top + 32 } };
}

async function ocrWords(worker, buffer) {
  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  const data = (await worker.recognize(buffer, {}, { text: true, blocks: true })).data;
  return { words: wordsOf(data), text: String(data.text || '') };
}

async function readAnchoredLabel({ sharp, worker, image, quad, frame, hint, deadline = Infinity, diagnostic = () => {} }) {
  const c = await geometry.labelCrop({ sharp, image, quad, frame });
  if (!c) return { reason: 'anchor_too_small' };
  const ocr = async (options) => {
    if (Date.now() > deadline) throw Object.assign(Error('brand_budget_exceeded'), { budget: true });
    const v = await geometry.variantImage({ sharp, crop: c, ...options }); diagnostic('brand-ocr', { variant: v.key });
    const o = await ocrWords(worker, v.buffer);
    // Size-shaped numbers get glyph-tight boxes so caption geometry is exact.
    for (const w of o.words) if (w.bbox && SIZE_SHAPED.test(clean(w.text))) w.bbox = await tightBox(sharp, v.buffer, v.size, w.bbox);
    return { ...v, ...o };
  };
  const first = [];
  for (const orientation of geometry.orientations(c)) first.push(await ocr({ orientation, barWidth: geometry.BAR_WIDTHS[0] }));
  first.sort((a, z) => legibility(z.words) - legibility(a.words));
  const orientation = first[0].key.split('@')[0];
  const read = [first[0]];
  for (const barWidth of geometry.BAR_WIDTHS.slice(1)) read.push(await ocr({ orientation, barWidth }));
  const brand = decide(read, { hint, enabled: new Set(Object.keys(LAYOUTS)) }).brand;
  if (brand && LAYOUTS[brand].negative) for (const barWidth of [geometry.BAR_WIDTHS[0], geometry.BAR_WIDTHS[2]]) read.push(await ocr({ orientation, barWidth, negate: true }));
  if (brand && ENABLED.has(brand)) {
    // Caption probes on the best variant (and its negative, if any).
    for (const v of read.filter((x, i) => i === 0 || x.key.endsWith('-neg')).slice(0, 2)) {
      const source = await geometry.variantImage({ sharp, crop: c, orientation, barWidth: 100000, negate: v.key.endsWith('-neg') });
      const added = await probeCaptions({ sharp, worker, buffer: v.buffer, size: v.size, words: v.words, layout: LAYOUTS[brand], source, deadline });
      if (added.length) v.words = [...v.words, ...added];
    }
  }
  if (brand && LAYOUTS[brand].refZone) {
    const zone = await zoneImage({ sharp, crop: c, box: LAYOUTS[brand].refZone.box });
    if (zone) {
      diagnostic('brand-ocr', { variant: 'refzone' });
      await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: LAYOUTS[brand].refZone.whitelist });
      try { const data = (await worker.recognize(zone.buffer, {}, { text: true, blocks: true })).data; read.push({ ...zone, key: 'refzone', words: wordsOf(data), text: '' }); }
      finally { await worker.setParameters({ tessedit_char_whitelist: '' }); }
    }
  }
  const d = decide(read, { hint });
  if (!d.size) return { reason: d.reason, brand: d.brand || null, ...(d.literalSize ? { literalSize: d.literalSize } : {}) };
  const v = read.find(x => x.key === d.witness.key);
  for (const token of d.witness.tokens) {
    const zoomed = await confirmValue({ sharp, worker, buffer: v.buffer, size: v.size, token });
    if (zoomed !== clean(token.text).replace(',', '.')) return { reason: 'br_value_not_confirmed', brand: d.brand };
  }
  return { brand: d.brand, size: d.size, references: d.references, support: d.support, text: read.map(x => x.text).join('\n').slice(0, 12000) };
}

// Entry point used by scannerImageProcessor before its generic whole-photo pass.
// budgetMs bounds this reader so the generic pass keeps its time inside the
// label deadline. Exceeding it is a plain fallback, never an answer.
async function readBrandLabel({ sharp, readPositions, worker, image, barcode, hint = null, budgetMs = 7000, diagnostic = () => {} }) {
  const deadline = Date.now() + budgetMs;
  diagnostic('brand-anchor');
  const frame = await geometry.findAnchors({ sharp, readPositions, image, barcode });
  if (!frame.anchors.length) return { reason: 'anchor_not_found' };
  if (frame.anchors.length > 2) return { reason: 'anchor_ambiguous' };
  const reads = [];
  try { for (const quad of frame.anchors) reads.push(await readAnchoredLabel({ sharp, worker, image, quad, frame, hint, deadline, diagnostic })); }
  catch (error) { if (error.budget) return { reason: 'brand_budget_exceeded' }; throw error; }
  // Two equal codes in one photo (two identical labels) must read identically.
  if (reads.some(r => !r.size)) { const bad = reads.find(r => !r.size); return { reason: bad.reason, brand: bad.brand || reads.find(r => r.brand)?.brand || null, literalSizes: [...new Set(reads.flatMap(r => [r.size, r.literalSize]).filter(Boolean))] }; }
  if (new Set(reads.map(r => r.brand + ':' + r.size)).size !== 1) return { reason: 'anchors_disagree' };
  const references = [...new Set(reads.flatMap(r => r.references))];
  return { size: reads[0].size, references, text: reads.map(r => r.text).join('\n'), reader: VERSION + ':' + reads[0].brand.toLowerCase(), brand: reads[0].brand };
}
module.exports = { readBrandLabel, readAnchoredLabel, decide, confirmValue, probeCaptions, ENABLED, VERSION };
