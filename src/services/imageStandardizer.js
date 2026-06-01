// =====================================================================
// imageStandardizer — normaliza imagens de produto pro PADRÃO DA LOJA.
// =====================================================================
// O storefront (sportsetennis.com.br / Nuvemshop) usa predominantemente
// imagem QUADRADA 1:1 ~1200px. Fontes misturadas (IA 2048px, scrapes 1000-
// 1200px) causam "diferença de tamanho". Aqui uniformizamos TODAS pro mesmo
// formato e re-hospedamos em fal.storage (URL limpa, leve), evitando data:
// URLs gigantes nas respostas de listagem.
//
// Default: 1200x1200 webp q85 (≈100-200KB) — mesmo ratio do storefront,
// então NÃO recorta fotos já quadradas (só reescala).
// =====================================================================

const sharp = require('sharp');

const DEFAULT_SIZE = 1200;
const DEFAULT_QUALITY = 85;

// Sobe um buffer pro fal.storage e devolve a URL pública.
async function uploadBufferToFal(buffer, filename, mimetype = 'image/webp') {
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY não configurada');
  const mod = await import('@fal-ai/client');
  const fal = mod.fal;
  fal.config({ credentials: process.env.FAL_KEY });
  let FileC = (typeof File !== 'undefined') ? File : null;
  if (!FileC) { try { FileC = require('node:buffer').File; } catch {} }
  const payload = FileC
    ? new FileC([buffer], filename, { type: mimetype })
    : new Blob([buffer], { type: mimetype });
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('fal.storage retornou vazio');
  return url;
}

// Baixa uma src (URL http(s) ou data:URL) e devolve o buffer cru.
async function fetchToBuffer(src) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(src);
  if (m) return Buffer.from(m[2], 'base64');
  const r = await fetch(src);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Normaliza UM buffer pro formato padrão. ratio:'1:1'|'4:5'. fit:'cover'|'contain'.
async function standardizeBuffer(buf, { size = DEFAULT_SIZE, ratio = '1:1', fit = 'cover', quality = DEFAULT_QUALITY } = {}) {
  const w = size;
  const h = ratio === '4:5' ? Math.round(size * 1.25) : size; // 1:1 default
  const pipeline = sharp(buf, { failOn: 'none' }).rotate();
  if (fit === 'contain') {
    pipeline.resize(w, h, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } }).flatten({ background: '#ffffff' });
  } else {
    pipeline.resize(w, h, { fit: 'cover', position: 'centre' });
  }
  return pipeline.webp({ quality }).toBuffer();
}

// Fluxo completo de UMA imagem: baixa → padroniza → sobe → URL.
async function standardizeAndUpload(src, opts = {}) {
  const raw = await fetchToBuffer(src);
  const before = await sharp(raw).metadata().catch(() => ({}));
  const out = await standardizeBuffer(raw, opts);
  const filename = `std-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
  const url = await uploadBufferToFal(out, filename, 'image/webp');
  return {
    url,
    beforeKb: Math.round(raw.length / 1024),
    afterKb: Math.round(out.length / 1024),
    before: before.width ? `${before.width}x${before.height}` : '?',
  };
}

// Padroniza uma LISTA de srcs (best-effort: mantém a original se falhar).
async function standardizeList(srcs, opts = {}) {
  const results = [];
  for (const src of srcs) {
    try {
      const r = await standardizeAndUpload(src, opts);
      results.push({ ok: true, original: src, ...r });
    } catch (e) {
      results.push({ ok: false, original: src, url: src, error: e.message });
    }
  }
  return results;
}

module.exports = {
  uploadBufferToFal,
  fetchToBuffer,
  standardizeBuffer,
  standardizeAndUpload,
  standardizeList,
  DEFAULT_SIZE,
};
