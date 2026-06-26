// =====================================================================
// LocateAnything — detecção de objeto por linguagem natural.
// Retorna bounding box { x1, y1, x2, y2 } como frações 0.0–1.0 da imagem.
//
// Backend (em ordem de prioridade):
//   1. LOCATE_ANYTHING_URL — servidor externo (Docker/GPU, futura opção)
//   2. Claude Vision (padrão) — já pago, já integrado, mesma qualidade
//
// Uso:
//   const la = require('./locateAnything');
//   const bbox = await la.locate(imageUrl, 'barcode label');
//   // → { x1: 0.12, y1: 0.45, x2: 0.88, y2: 0.62 } ou null se não achou
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const http = require('http');

const MODEL = 'claude-haiku-4-5-20251001'; // rápido e barato — ideal pra detecção

// Sistema cacheável (prompt fixo = tokens cached na Anthropic)
const SYSTEM_PROMPT = `You are a precise object locator for product images.
Given an image and a text description of what to find, return ONLY a JSON object with the bounding box.
Coordinates are decimal fractions of image dimensions (0.0 = left/top edge, 1.0 = right/bottom edge).
If the object is not found, return null.
Format: {"x1":0.0,"y1":0.0,"x2":1.0,"y2":1.0}
No extra text, no markdown, just the JSON or null.`;

/**
 * Detecta um objeto na imagem e retorna seu bounding box.
 *
 * @param {string} imageSource - URL pública ou data URI (data:image/...;base64,...)
 * @param {string} query - descrição do que encontrar (ex: "barcode", "shoe", "foot", "Nike logo")
 * @param {Object} [opts]
 * @param {number} [opts.timeout=10000] - timeout em ms
 * @returns {Promise<{x1,y1,x2,y2}|null>}
 */
async function locate(imageSource, query, opts = {}) {
  if (!imageSource || !query) return null;

  // Backend externo (GPU própria)
  if (process.env.LOCATE_ANYTHING_URL) {
    return _locateExternal(imageSource, query, opts);
  }

  // Claude Vision (padrão)
  return _locateClaude(imageSource, query, opts);
}

/**
 * Detecta múltiplos objetos diferentes na mesma imagem em paralelo.
 * Retorna { [query]: bbox|null }
 */
async function locateMany(imageSource, queries = []) {
  if (!imageSource || !queries.length) return {};
  const results = await Promise.all(queries.map((q) => locate(imageSource, q).then((b) => [q, b])));
  return Object.fromEntries(results);
}

/**
 * Verifica se um objeto específico EXISTE na imagem (sem precisar de bbox).
 * Mais barato — usa prompt de sim/não.
 */
async function exists(imageSource, query) {
  if (!imageSource || !query) return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const imgContent = _buildImageContent(imageSource);
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 10,
      system: [{ type: 'text', text: 'Reply only "yes" or "no".', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [imgContent, { type: 'text', text: `Is there a ${query} visible in this image?` }] }],
    });
    const txt = (res.content[0]?.text || '').toLowerCase().trim();
    return txt.startsWith('yes');
  } catch (_) {
    return false;
  }
}

/**
 * Dado um bounding box e dimensões reais da imagem, devolve { x, y, w, h } em pixels.
 */
function bboxToPixels(bbox, width, height) {
  if (!bbox) return null;
  return {
    x: Math.round(bbox.x1 * width),
    y: Math.round(bbox.y1 * height),
    w: Math.round((bbox.x2 - bbox.x1) * width),
    h: Math.round((bbox.y2 - bbox.y1) * height),
  };
}

// ---- internals --------------------------------------------------------

async function _locateClaude(imageSource, query, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const imgContent = _buildImageContent(imageSource);

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 80,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          imgContent,
          { type: 'text', text: `Find: "${query}". Return bounding box JSON or null.` },
        ],
      }],
    });

    const txt = (res.content[0]?.text || '').trim();
    if (txt === 'null' || !txt) return null;

    // extrai JSON mesmo que venha com lixo em volta
    const match = txt.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.x1 !== 'number') return null;
    return _clamp(parsed);
  } catch (_) {
    return null;
  }
}

async function _locateExternal(imageSource, query, opts = {}) {
  const url = new URL('/locate', process.env.LOCATE_ANYTHING_URL);
  const body = JSON.stringify({ image: imageSource, query });
  const lib = url.protocol === 'https:' ? https : http;
  const timeout = opts.timeout || 10000;

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    const req = lib.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(data);
          resolve(j && typeof j.x1 === 'number' ? _clamp(j) : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => { clearTimeout(timer); resolve(null); });
    req.write(body);
    req.end();
  });
}

function _buildImageContent(src) {
  if (String(src).startsWith('data:')) {
    const [header, b64] = src.split(',');
    const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
  }
  return { type: 'image', source: { type: 'url', url: src } };
}

function _clamp(b) {
  const c = (v) => Math.max(0, Math.min(1, v));
  return { x1: c(b.x1), y1: c(b.y1), x2: c(b.x2), y2: c(b.y2) };
}

module.exports = { locate, locateMany, exists, bboxToPixels };
