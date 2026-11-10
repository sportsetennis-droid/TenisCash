'use strict';
// Literal BR field association inside ONE anchored label crop.
// A value is accepted only when it is the unique number in the layout's
// direction from the BR/BRA caption and no other printed scale owns it.
const { clean } = require('./brandLayouts');
const SCALE = /^(BR|BRA|US|USA|UK|EUR|EU|CM|JP|JPN|MM|CHN|F|J|AR|MERC)$/;
const VALUE = /^(\d{2})(?:([.,])5|\/(\d{2}))?$/;
const CAPTION_CONFIDENCE = 55, VALUE_CONFIDENCE = 75;

function box(w) { const b = w.bbox; return { ...b, w: b.x1 - b.x0, h: b.y1 - b.y0, cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 }; }
function sizeOf(text) {
  const m = VALUE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 15 || n > 50) return null;
  if (m[3]) return Number(m[3]) === n + 1 ? m[1] + '/' + m[3] : null;
  return m[2] ? m[1] + '.5' : m[1];
}

// Split fused OCR tokens such as "BR40", "BRA:41", "40BR".
function tokens(words) {
  const out = [];
  for (const w of words) {
    if (!w.bbox) continue;
    const t = clean(w.text).toUpperCase();
    let m;
    if ((m = /^(BRA?)[:.\-]?(\d{2}(?:[.,]5|\/\d{2})?)$/.exec(t))) {
      const b = w.bbox, cut = b.x0 + (b.x1 - b.x0) * m[1].length / t.length;
      out.push({ kind: 'scale', scale: m[1], confidence: w.confidence, bbox: { ...b, x1: cut }, fused: 'right' });
      out.push({ kind: 'value', text: m[2], confidence: w.confidence, bbox: { ...b, x0: cut }, fused: 'right' });
      continue;
    }
    if ((m = /^(\d{2}(?:[.,]5)?)(BRA?)$/.exec(t))) {
      const b = w.bbox, cut = b.x0 + (b.x1 - b.x0) * m[1].length / t.length;
      out.push({ kind: 'value', text: m[1], confidence: w.confidence, bbox: { ...b, x1: cut }, fused: 'left' });
      out.push({ kind: 'scale', scale: m[2], confidence: w.confidence, bbox: { ...b, x0: cut }, fused: 'left' });
      continue;
    }
    if (SCALE.test(t)) out.push({ kind: 'scale', scale: t, confidence: w.confidence, bbox: w.bbox });
    else out.push({ kind: 'other', text: t, confidence: w.confidence, bbox: w.bbox });
  }
  return out;
}

// Geometric relation of value V to caption L for one direction; returns a
// distance (smaller is closer) or null when V is not in that direction.
function relation(L, V, dir) {
  const l = box(L), v = box(V), h = Math.max(l.h, v.h * 0.6);
  if (dir === 'below' || dir === 'above') {
    const gap = dir === 'below' ? v.y0 - l.y1 : l.y0 - v.y1;
    if (gap < -0.35 * l.h || gap > 2.6 * h) return null;
    // Captions are left-aligned or centred over their value.
    const dx = Math.min(Math.abs(v.cx - l.cx), Math.abs(v.x0 - l.x0));
    if (dx > Math.max(l.w, v.w) * 0.75 + l.h * 0.4) return null;
    return Math.max(0, gap) + dx * 0.8;
  }
  if (dir === 'right' || dir === 'left') {
    const gap = dir === 'right' ? v.x0 - l.x1 : l.x0 - v.x1;
    if (gap < -0.3 * l.h || gap > 4.5 * h) return null;
    // Value may be taller than its caption and baseline-aligned below it.
    if (v.y1 < l.y0 + l.h * 0.2 || v.y0 > l.y1 + l.h * 0.9) return null;
    return Math.max(0, gap) + Math.abs(v.cy - l.cy) * 0.8;
  }
  return null;
}

// Value of a given caption (BR or a foreign one for sanity checks).
function valueFor(caption, all, directions) {
  const values = all.filter(t => t.kind === 'value' || t.kind === 'other' && VALUE.test(t.text));
  const scales = all.filter(t => t.kind === 'scale');
  const candidates = [];
  for (const v of values) {
    if (v.fused && v.bbox && caption.fused && Math.abs(v.bbox.y0 - caption.bbox.y0) < 1 && directions.includes(v.fused)) { candidates.push({ v, d: 0 }); continue; }
    let best = null;
    for (const dir of directions) { const d = relation(caption, v, dir); if (d !== null && (best === null || d < best)) best = d; }
    if (best === null) continue;
    // Ownership veto: another caption in the same layout relation is closer.
    const owned = scales.some(s => s !== caption && directions.some(dir => { const d = relation(s, v, dir); return d !== null && d + 0.15 * box(v).h < best; }));
    if (!owned) candidates.push({ v, d: best });
  }
  candidates.sort((a, z) => a.d - z.d);
  if (!candidates.length) return { reason: 'no_value' };
  const first = candidates[0], second = candidates[1];
  if (second && second.d < Math.max(first.d * 1.6, first.d + box(caption).h * 0.6)) return { reason: 'ambiguous_value' };
  return { token: first.v };
}

function readBr(words, layout) {
  const all = tokens(words);
  const captions = all.filter(t => t.kind === 'scale' && /^BRA?$/.test(t.scale) && t.confidence >= CAPTION_CONFIDENCE);
  if (!captions.length) return { reason: 'no_br_caption' };
  // Two printed grids on one crop (MEN/WOMEN rows, or a neighbouring label)
  // make the BR owner a judgement call: never answer.
  const counts = {};
  for (const t of all) if (t.kind === 'scale' && t.confidence >= 70) { const k = t.scale.replace(/^USA$/, 'US').replace(/^BRA$/, 'BR').replace(/^EU$/, 'EUR'); counts[k] = (counts[k] || 0) + 1; }
  if (Object.values(counts).some(n => n > 1)) return { reason: 'multiple_size_grids' };
  if (all.some(t => t.kind === 'other' && /^(WOMEN|WOMAN|MULHER|FEMININO)$/.test(t.text)) && all.some(t => t.kind === 'other' && /^(MEN|MAN|HOMEM|MASCULINO)$/.test(t.text))) return { reason: 'multiple_audiences' };
  const found = [];
  for (const c of captions) {
    const r = valueFor(c, all, layout.directions);
    if (r.token) found.push({ caption: c, token: r.token });
    else found.push({ caption: c, reason: r.reason });
  }
  const read = found.filter(f => f.token);
  // Every printed BR caption on this label must resolve to one same value.
  if (!read.length) return { reason: found[0].reason };
  if (read.length !== found.length) return { reason: 'br_caption_unresolved' };
  const values = [...new Set(read.map(f => sizeOf(clean(f.token.text))))];
  if (values.length !== 1 || !values[0]) return { reason: values.length > 1 ? 'br_conflict' : 'br_value_invalid' };
  if (read.some(f => f.token.confidence < VALUE_CONFIDENCE)) return { reason: 'br_value_low_confidence' };
  // Optional cross-scale sanity: EUR minus BR is between 1 and 3 on every
  // brand enabled with eurCheck. A violation means a misread, never a size.
  if (layout.eurCheck) {
    const eurs = all.filter(t => t.kind === 'scale' && /^EUR?$/.test(t.scale));
    for (const e of eurs) {
      const r = valueFor(e, all, layout.directions);
      if (!r.token) continue;
      const eur = Number(String(clean(r.token.text)).replace(',', '.'));
      const br = Number(values[0].slice(0, 2)) + (values[0].endsWith('.5') ? 0.5 : 0);
      if (Number.isFinite(eur) && (eur - br < 0.9 || eur - br > 3.1)) return { reason: 'eur_br_inconsistent' };
    }
  }
  return { size: values[0], tokens: read.map(f => f.token), captions: read.map(f => f.caption) };
}
module.exports = { readBr, tokens, relation, valueFor, sizeOf };
