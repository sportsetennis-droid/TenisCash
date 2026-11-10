'use strict';
// Barcode-anchored label geometry. The decoded symbol that matches the scanned
// code is the only anchor: its position and reading direction select the
// manufacturer label that belongs to THIS piece, never a neighbouring box.
// No catalogue, product or size information is used here.
const policy = require('../../../public/scanner-barcode-policy');
const MAX_PIXELS = 24000000;

const pt = (p) => ({ x: Number(p.x), y: Number(p.y) });
function quadOf(position) {
  return [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft].map(pt);
}
function centre(q) { return { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 }; }

// Decode with positions over the whole frame, then (only if needed) an
// enhanced whole frame and enlarged overlapping tiles. Returns every placement
// of the scanned code; other symbols are ignored but counted.
async function findAnchors({ sharp, readPositions, image, barcode }) {
  const want = policy.identity(barcode);
  const meta = await sharp(image, { limitInputPixels: MAX_PIXELS }).metadata();
  const W = meta.width, H = meta.height;
  const pixelsOf = async (pipeline) => {
    const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { pixels: { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }, info };
  };
  const tiles = [];
  for (const [fx, fy] of [[0, 0], [0.4, 0], [0, 0.3], [0.4, 0.3], [0.2, 0.15]]) {
    tiles.push({ left: Math.floor(W * fx), top: Math.floor(H * fy), width: Math.floor(W * 0.6), height: Math.floor(H * 0.7) });
  }
  const passes = [{ enhance: false }, { enhance: true }, ...tiles.map(region => ({ region, enhance: true }))];
  for (const pass of passes) {
    let pipe = sharp(image, { limitInputPixels: MAX_PIXELS });
    let scale = 1, left = 0, top = 0;
    if (pass.region) {
      ({ left, top } = pass.region);
      scale = Math.min(1.6, 2400 / Math.max(pass.region.width, pass.region.height));
      pipe = pipe.extract(pass.region).resize({ width: Math.round(pass.region.width * scale) });
    }
    if (pass.enhance) pipe = pipe.greyscale().normalize();
    const { pixels } = await pixelsOf(pipe);
    const rows = await readPositions(pixels);
    const hits = rows.filter(r => policy.identity(r.text) === want).map(r => quadOf(r.position).map(p => ({ x: left + p.x / scale, y: top + p.y / scale })));
    if (!hits.length) continue;
    // Same symbol found twice by the decoder at one place is one anchor.
    const unique = [];
    for (const q of hits) {
      const c = centre(q), w = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
      if (!unique.some(u => Math.hypot(centre(u).x - c.x, centre(u).y - c.y) < Math.max(20, w * 0.5))) unique.push(q);
    }
    return { width: W, height: H, anchors: unique, others: rows.filter(r => policy.identity(r.text) !== want).length };
  }
  return { width: W, height: H, anchors: [], others: 0 };
}

// Rotate so the anchor reads left-to-right with vertical bars. Small skews are
// left alone (rotation resampling costs more legibility than it gains).
function uprightAngle(q) {
  const a = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) * 180 / Math.PI;
  const snapped = Math.round(a / 90) * 90;
  return Math.abs(a - snapped) <= 4 ? snapped : a;
}
// Coordinates of a point after sharp.rotate(deg) with canvas expansion.
function rotatePoint(p, deg, W, H) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const W2 = Math.abs(W * c) + Math.abs(H * s), H2 = Math.abs(W * s) + Math.abs(H * c);
  const x = p.x - W / 2, y = p.y - H / 2;
  return { x: x * c - y * s + W2 / 2, y: x * s + y * c + H2 / 2 };
}

// Segment the light label paper that contains the anchor (flood fill from the
// barcode quiet zones). Bounded by a window in barcode-width units so a label
// touching a white wall cannot grow without limit.
function labelBox({ data, width, height, channels }, bar) {
  const v = new Float32Array(width * height), neutral = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const r = data[j], g = data[j + 1], b = data[j + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    v[i] = mx; neutral[i] = (mx - mn) <= Math.max(18, mx * 0.3) ? 1 : 0;
  }
  const W = bar.x1 - bar.x0, h = bar.y1 - bar.y0;
  const sample = [];
  for (let y = Math.max(0, Math.floor(bar.y0 - h * 0.2)); y < Math.min(height, Math.ceil(bar.y1 + h * 0.2)); y++)
    for (let x = Math.max(0, Math.floor(bar.x0)); x < Math.min(width, Math.ceil(bar.x1)); x++) sample.push(v[y * width + x]);
  if (!sample.length) return null;
  sample.sort((a, z) => a - z);
  const paper = sample[Math.floor(sample.length * 0.92)];
  if (paper < 60) return null;
  const limit = { x0: Math.max(0, Math.floor(bar.x0 - 5 * W)), x1: Math.min(width - 1, Math.ceil(bar.x1 + 5 * W)),
    y0: Math.max(0, Math.floor(bar.y0 - 4 * W)), y1: Math.min(height - 1, Math.ceil(bar.y1 + 4 * W)) };
  const ok = (x, y) => { const i = y * width + x; return v[i] >= paper * 0.68 && neutral[i]; };
  const seen = new Uint8Array(width * height), stack = [];
  for (let y = Math.max(0, Math.floor(bar.y0 - h * 0.3)); y <= Math.min(height - 1, Math.ceil(bar.y1 + h * 0.3)); y++)
    for (let x = Math.max(0, Math.floor(bar.x0)); x <= Math.min(width - 1, Math.ceil(bar.x1)); x++)
      if (ok(x, y)) { seen[y * width + x] = 1; stack.push(x, y); }
  if (!stack.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  while (stack.length) {
    const y = stack.pop(), x = stack.pop(); count++;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < limit.x0 || nx > limit.x1 || ny < limit.y0 || ny > limit.y1) continue;
      const i = ny * width + nx;
      if (!seen[i] && ok(nx, ny)) { seen[i] = 1; stack.push(nx, ny); }
    }
  }
  return { x0, y0, x1, y1, count, limit, paper };
}

// Prepare the upright label crop for OCR. Coordinates of the anchor inside
// the crop are returned so readers can reason relative to the barcode.
async function labelCrop({ sharp, image, quad, frame, targetBarWidth = 620 }) {
  const angle = uprightAngle(quad);
  const rotated = angle ? await sharp(image, { limitInputPixels: MAX_PIXELS }).rotate(-angle, { background: '#000000' }).png({ compressionLevel: 0 }).toBuffer() : image;
  const meta = await sharp(rotated, { limitInputPixels: MAX_PIXELS }).metadata();
  const q = angle ? quad.map(p => rotatePoint(p, -angle, frame.width, frame.height)) : quad;
  const bar = { x0: Math.min(...q.map(p => p.x)), x1: Math.max(...q.map(p => p.x)), y0: Math.min(...q.map(p => p.y)), y1: Math.max(...q.map(p => p.y)) };
  const W = bar.x1 - bar.x0;
  if (W < 40) return null;
  const s = Math.min(1, 720 / Math.max(meta.width, meta.height));
  const small = await sharp(rotated, { limitInputPixels: MAX_PIXELS }).resize({ width: Math.max(1, Math.round(meta.width * s)) }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const sb = { x0: bar.x0 * s, x1: bar.x1 * s, y0: bar.y0 * s, y1: bar.y1 * s };
  const box = labelBox({ data: small.data, width: small.info.width, height: small.info.height, channels: small.info.channels }, sb);
  let region;
  if (box && box.count > 200) {
    const pad = Math.max(4, (box.x1 - box.x0) * 0.03);
    region = { x0: (box.x0 - pad) / s, y0: (box.y0 - pad) / s, x1: (box.x1 + pad) / s, y1: (box.y1 + pad) / s };
  } else {
    region = { x0: bar.x0 - 2 * W, y0: bar.y0 - 1.6 * W, x1: bar.x1 + 2.6 * W, y1: bar.y1 + 1.2 * W };
  }
  // The crop must always contain the anchor itself.
  region.x0 = Math.max(0, Math.min(region.x0, bar.x0)); region.y0 = Math.max(0, Math.min(region.y0, bar.y0));
  region.x1 = Math.min(meta.width, Math.max(region.x1, bar.x1)); region.y1 = Math.min(meta.height, Math.max(region.y1, bar.y1));
  const extract = { left: Math.floor(region.x0), top: Math.floor(region.y0), width: Math.max(1, Math.floor(region.x1 - region.x0)), height: Math.max(1, Math.floor(region.y1 - region.y0)) };
  let k = Math.max(1, Math.min(3, targetBarWidth / W));
  const maxSide = 3200, maxPixels = 4000000;
  k = Math.min(k, maxSide / Math.max(extract.width, extract.height), Math.sqrt(maxPixels / (extract.width * extract.height)));
  const crop = await sharp(rotated, { limitInputPixels: MAX_PIXELS }).extract(extract)
    .resize({ width: Math.max(1, Math.round(extract.width * k)), kernel: 'lanczos3' }).greyscale().normalize().png().toBuffer();
  const barBox = { x0: (bar.x0 - extract.left) * k, x1: (bar.x1 - extract.left) * k, y0: (bar.y0 - extract.top) * k, y1: (bar.y1 - extract.top) * k };
  const raw = await sharp(crop).raw().toBuffer({ resolveWithObject: true });
  return {
    crop, angle, scale: k, segmented: !!(box && box.count > 200), bar: barBox, bars: barExtent(raw, barBox), paper: paperLevel(raw),
    size: { width: raw.info.width, height: raw.info.height },
  };
}
// Full vertical extent of the bars: the decoder's quad may cover only the
// scan lines it used. Rows belong to the symbol while they keep alternating.
function barExtent({ data, info }, bar) {
  const { width, height, channels } = info;
  const x0 = Math.max(0, Math.floor(bar.x0 + (bar.x1 - bar.x0) * 0.04)), x1 = Math.min(width - 1, Math.ceil(bar.x1 - (bar.x1 - bar.x0) * 0.04));
  const cy = Math.max(0, Math.min(height - 1, Math.round((bar.y0 + bar.y1) / 2)));
  const at = (x, y) => data[(y * width + x) * channels];
  const row = [];
  for (let x = x0; x <= x1; x++) row.push(at(x, cy));
  const sorted = [...row].sort((a, z) => a - z), t = (sorted[Math.floor(sorted.length * 0.1)] + sorted[Math.floor(sorted.length * 0.9)]) / 2;
  const transitions = (y) => { let n = 0, prev = at(x0, y) < t; for (let x = x0 + 1; x <= x1; x++) { const d = at(x, y) < t; if (d !== prev) n++; prev = d; } return n; };
  const base = transitions(cy);
  if (base < 16) return { y0: bar.y0, y1: bar.y1 };
  const walk = (dir) => { let y = cy, miss = 0, last = cy; while (y + dir >= 0 && y + dir < height && miss < 3) { y += dir; if (transitions(y) >= base * 0.8) { last = y; miss = 0; } else miss++; } return last; };
  return { y0: Math.min(bar.y0, walk(-1)), y1: Math.max(bar.y1, walk(1)) };
}
// One OCR input derived from a crop: barcode-upright or photo-upright
// orientation, a character scale (expressed as the barcode width in pixels:
// Tesseract misreads very large glyphs) and optionally negated, for labels that
// print the size in white on a black band.
const BAR_WIDTHS = [370, 280, 500];
async function variantImage({ sharp, crop, orientation = 'bar', barWidth = 370, negate = false }) {
  const back = Math.round(crop.angle / 90) * 90;
  const k = Math.min(1, barWidth / (crop.bar.x1 - crop.bar.x0));
  const meta0 = await sharp(crop.crop).metadata();
  const width = Math.max(1, Math.round(meta0.width * k)), height = Math.max(1, Math.round(meta0.height * k));
  // The bars themselves are painted white: they only produce OCR noise and
  // disturb Tesseract's layout analysis of the printed fields around them.
  const W = crop.bar.x1 - crop.bar.x0;
  const bars = crop.bars || crop.bar;
  const mx0 = Math.max(0, (crop.bar.x0 - 0.02 * W) * k), my0 = Math.max(0, (bars.y0 - 0.01 * W) * k);
  const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect x="${mx0}" y="${my0}" width="${Math.min(width - mx0, W * 1.04 * k)}" height="${Math.max(1, Math.min(height - my0, (bars.y1 - bars.y0 + 0.02 * W) * k))}" fill="rgb(${crop.paper ?? 255},${crop.paper ?? 255},${crop.paper ?? 255})"/></svg>`);
  const resized = await sharp(crop.crop).resize({ width, height, fit: 'fill' }).png().toBuffer();
  let buffer = await sharp(resized).composite([{ input: mask }]).png().toBuffer();
  buffer = await removeRules(sharp, buffer, crop.paper ?? 255);
  if (orientation === 'photo' && back % 360) buffer = await sharp(buffer).rotate(back).png().toBuffer();
  if (negate) buffer = await sharp(buffer).negate({ alpha: false }).png().toBuffer();
  const meta = await sharp(buffer).metadata();
  return { key: orientation + '@' + barWidth + (negate ? '-neg' : ''), buffer, size: { width: meta.width, height: meta.height } };
}
function orientations(crop) { return Math.round(crop.angle / 90) * 90 % 360 ? ['bar', 'photo'] : ['bar']; }
async function ocrVariants({ sharp, crop }) {
  const out = [];
  for (const orientation of orientations(crop)) for (const barWidth of BAR_WIDTHS) out.push(await variantImage({ sharp, crop, orientation, barWidth }));
  return out;
}
module.exports = { findAnchors, labelCrop, ocrVariants, variantImage, orientations, uprightAngle, rotatePoint, labelBox, BAR_WIDTHS };
// Typical paper brightness of the crop: masks and paddings use it so that
// Tesseract's global threshold is not pulled by an artificial pure white.
function paperLevel({ data, info }) {
  const hist = new Array(256).fill(0), step = info.channels;
  for (let i = 0; i < data.length; i += step * 7) hist[data[i]]++;
  const total = hist.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.8) return v; }
  return 255;
}
module.exports.paperLevel = paperLevel;

// Thin printed table rules (cell borders) break Tesseract's segmentation of
// grids such as "UK 9.5 / EUR 44 / USA 10 / BR 42". Paint thin long dark
// strokes with the paper level; thick dark bands (white text on black) stay.
async function removeRules(sharp, buffer, paper) {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info, px = Buffer.from(data);
  let sum = 0; for (let i = 0; i < px.length; i += 5) sum += px[i];
  const dark = Math.min(140, (sum / Math.ceil(px.length / 5)) * 0.6);
  const mark = new Uint8Array(width * height);
  const minH = Math.max(40, width * 0.12), minV = Math.max(30, height * 0.22), thin = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
    if (px[y * width + x] >= dark) { x++; continue; }
    let e = x; while (e + 1 < width && (px[y * width + e + 1] < dark || (e + 2 < width && px[y * width + e + 2] < dark))) e++;
    if (e - x + 1 >= minH) for (let i = x; i <= e; i++) mark[y * width + i] |= 1;
    x = e + 1;
  }
  for (let x = 0; x < width; x++) for (let y = 0; y < height;) {
    if (px[y * width + x] >= dark) { y++; continue; }
    let e = y; while (e + 1 < height && (px[(e + 1) * width + x] < dark || (e + 2 < height && px[(e + 2) * width + x] < dark))) e++;
    if (e - y + 1 >= minV) for (let i = y; i <= e; i++) mark[i * width + x] |= 2;
    y = e + 1;
  }
  let changed = 0;
  // Keep only thin strokes: the marked run across the line must be short.
  for (let x = 0; x < width; x++) for (let y = 0; y < height;) {
    if (!(mark[y * width + x] & 1)) { y++; continue; }
    let e = y; while (e + 1 < height && mark[(e + 1) * width + x] & 1) e++;
    const off = 3 * thin, clear = y - off >= 0 && e + off < height && px[(y - off) * width + x] >= dark && px[(e + off) * width + x] >= dark;
    if (e - y + 1 <= thin && clear) for (let i = Math.max(0, y - 1); i <= Math.min(height - 1, e + 1); i++) { px[i * width + x] = paper; changed++; }
    y = e + 1;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width;) {
    if (!(mark[y * width + x] & 2)) { x++; continue; }
    let e = x; while (e + 1 < width && mark[y * width + e + 1] & 2) e++;
    const off = 3 * thin, clear = x - off >= 0 && e + off < width && px[y * width + x - off] >= dark && px[y * width + e + off] >= dark;
    if (e - x + 1 <= thin && clear) for (let i = Math.max(0, x - 1); i <= Math.min(width - 1, e + 1); i++) { px[y * width + i] = paper; changed++; }
    x = e + 1;
  }
  if (!changed) return buffer;
  return sharp(px, { raw: { width, height, channels: 1 } }).png().toBuffer();
}
module.exports.removeRules = removeRules;
