(function (root) {
  'use strict';
  function findRegions({ width: w, height: h, data }) {
    const rows = [];
    for (let y = 0; y < h; y++) {
      let count = 0, left = w, right = 0;
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
        if (g > r + 18 && g > b + 8 && g > 45) { count++; left = Math.min(left, x); right = x; }
      }
      rows.push({ count, left, right });
    }
    const bands = [];
    for (let y = 0; y < h; y++) {
      if (rows[y].count < w * .12) continue;
      const top = y; let left = w, right = 0;
      while (y < h && rows[y].count >= w * .12) {
        left = Math.min(left, rows[y].left); right = Math.max(right, rows[y].right); y++;
      }
      const bh = y - top;
      if (bh < h * .035 || bh > h * .3 || right - left < w * .3) continue;
      const pad = Math.max(3, Math.round(bh * .03));
      bands.push({ x: Math.max(0, left - pad), y: Math.max(0, top - pad),
        width: Math.min(w, right + pad) - Math.max(0, left - pad),
        height: Math.min(h, y + pad) - Math.max(0, top - pad), kind: 'label-header' });
    }
    bands.sort((a, b) => Math.abs(a.y + a.height / 2 - h / 2) - Math.abs(b.y + b.height / 2 - h / 2));
    // Bound work on phones. Overlapping text bands cover plain labels as well.
    const fallback = [.25, .4, .1, .55, .7].map(top => ({ x: Math.round(w * .05), y: Math.round(h * top),
      width: Math.round(w * .9), height: Math.round(h * .2), kind: 'text-band' }));
    const header = bands.slice(0, 1).flatMap(b => [{
      x: b.x + Math.round(b.width * .02), y: b.y + Math.round(b.height * .22),
      width: Math.round(b.width * .96), height: Math.round(b.height * .72), kind: 'header-text',
    }, b]);
    return [...header, ...fallback];
  }
  function normalizePixels(pixels) {
    let min = 255, max = 0;
    const values = [];
    for (let i = 0; i < pixels.length; i += 4) {
      const v = Math.round(.2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2]);
      values.push(v); min = Math.min(min, v); max = Math.max(max, v);
    }
    for (let i = 0; i < pixels.length; i += 4) {
      const v = max > min ? Math.round((values[i / 4] - min) * 255 / (max - min)) : values[i / 4];
      pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
    }
    return pixels;
  }
  const api = { findRegions, normalizePixels };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ScannerRegions = api;
})(typeof window === 'object' ? window : {});
