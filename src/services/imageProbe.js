// =====================================================================
// imageProbe — lê dimensões/peso de uma imagem por URL SEM baixar tudo.
// Faz Range request (só o cabeçalho) e parseia JPEG/PNG/WebP/GIF.
// Zero IA, zero custo (só banda). Pra triagem de qualidade do catálogo.
// =====================================================================
const https = require('https');
const http = require('http');

function fetchHead(url, maxBytes = 131072, timeoutMs = 7000, redirects = 3) {
  return new Promise((resolve) => {
    let done = false; const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let lib, u;
    try { u = new URL(url); lib = u.protocol === 'http:' ? http : https; } catch (_) { return fin({ ok: false, status: 'badurl' }); }
    let req;
    try {
      req = lib.get(url, { headers: { Range: `bytes=0-${maxBytes - 1}`, 'User-Agent': 'Mozilla/5.0 (compatible; img-probe/1.0)' } }, (res) => {
        const sc = res.statusCode;
        if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
          res.resume();
          try { return fetchHead(new URL(res.headers.location, url).href, maxBytes, timeoutMs, redirects - 1).then(fin); }
          catch (_) { return fin({ ok: false, status: 'badredirect' }); }
        }
        if (sc >= 400) { res.resume(); return fin({ ok: false, status: sc }); }
        const len = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
        const crange = res.headers['content-range'] || '';
        const totBytes = crange.includes('/') ? Number(crange.split('/')[1]) : len;
        const ctype = res.headers['content-type'] || '';
        const chunks = []; let got = 0;
        res.on('data', (d) => { chunks.push(d); got += d.length; if (got >= maxBytes) { try { req.destroy(); } catch (_) {} } });
        const end = () => fin({ ok: true, buf: Buffer.concat(chunks), bytes: totBytes, ctype });
        res.on('end', end); res.on('close', end); res.on('error', end);
      });
      req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (_) {} fin({ ok: false, status: 'timeout' }); });
      req.on('error', () => fin({ ok: false, status: 'error' }));
    } catch (_) { fin({ ok: false, status: 'error' }); }
  });
}

function dims(buf) {
  if (!buf || buf.length < 12) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
  // WebP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf.length > 30 && buf.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = buf.toString('ascii', 12, 16);
    try {
      if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, type: 'webp' }; }
      if (fmt === 'VP8X') { const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1; const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1; return { w, h, type: 'webp' }; }
    } catch (_) {}
  }
  // JPEG — varre marcadores até achar um SOF
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off < buf.length - 9) {
      if (buf[off] !== 0xff) { off++; continue; }
      const m = buf[off + 1];
      if (m === 0xd8 || m === 0xd9 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; } // sem comprimento
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) { // SOF
        try { return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7), type: 'jpeg' }; } catch (_) { return null; }
      }
      const segLen = buf.readUInt16BE(off + 2);
      if (segLen < 2) break;
      off += 2 + segLen;
    }
  }
  return null;
}

async function probe(url) {
  const r = await fetchHead(url);
  if (!r.ok) return { ok: false, status: r.status };
  const d = dims(r.buf);
  return { ok: true, bytes: r.bytes || null, ctype: r.ctype, w: d ? d.w : null, h: d ? d.h : null, type: d ? d.type : null, parsed: !!d };
}

module.exports = { probe, dims, fetchHead };
