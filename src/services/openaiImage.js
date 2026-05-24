// =====================================================================
// OpenAI gpt-image-1 wrapper — alternativa ao Flux Pro Kontext Max
// =====================================================================
// Modelo: gpt-image-1 (lançado abr/2025, substituiu DALL-E 3)
// Vantagens vs Flux: melhor obediência ao prompt, melhor render de texto
//   na imagem, mais "fotográfico real". Custo similar ($0.04 standard).
// Desvantagem: 2x mais lento (~60s vs ~30s).
//
// Endpoint: POST https://api.openai.com/v1/images/edits (multipart)
//   - aceita imagem de referência (image_url do produto) → image-to-image
//   - retorna b64_json (gpt-image-1 não suporta response_format=url)
//
// Como guardamos o resultado:
//   - Recebe b64, faz upload pra fal.storage (CDN), retorna URL pública
//   - Assim usa a mesma stack de armazenamento do falAi (sem R2 necessário)
//
// Auth: OPENAI_API_KEY no .env
// =====================================================================

const COSTS = {
  // Tabela oficial OpenAI (mai/2025): https://openai.com/api/pricing
  'gpt-image-1:low':    0.011,  // 1024x1024 low quality
  'gpt-image-1:medium': 0.042,  // 1024x1024 medium (default)
  'gpt-image-1:high':   0.167,  // 1024x1024 high quality
};

let _fal = null;
async function getFal() {
  if (_fal) return _fal;
  const mod = await import('@fal-ai/client');
  _fal = mod.fal;
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY necessária pra hospedar saída do gpt-image-1');
  _fal.config({ credentials: process.env.FAL_KEY });
  return _fal;
}

async function withRetry(fn, opName, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const t0 = Date.now();
      const result = await fn();
      console.log(`[openaiImage] ${opName} OK em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.warn(`[openaiImage] ${opName} falhou tentativa ${attempt}/${maxAttempts}: ${err.message}. Aguardando ${wait}ms`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Aspect ratio → size da OpenAI.
 * gpt-image-1 aceita: 1024x1024 (1:1), 1536x1024 (3:2 paisagem), 1024x1536 (2:3 retrato).
 */
function sizeFor(aspectRatio) {
  if (!aspectRatio) return '1024x1024';
  if (aspectRatio === '16:9' || aspectRatio === '3:2') return '1536x1024';
  if (aspectRatio === '9:16' || aspectRatio === '2:3') return '1024x1536';
  return '1024x1024';
}

/**
 * Baixa imagem do produto como Buffer (pra mandar como multipart pra OpenAI).
 */
async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Faz upload de um Buffer pra fal.storage e retorna URL pública.
 * File global não existe no Node do Railway, então importamos de node:buffer
 * (Node 20+) ou caímos pro Blob (que fal.storage também aceita).
 */
let _FileCtor = null;
function getFileCtor() {
  if (_FileCtor !== null) return _FileCtor;
  // 1) global File (browser-like / Node 20+ com File exposto)
  if (typeof File !== 'undefined') { _FileCtor = File; return _FileCtor; }
  // 2) node:buffer.File (Node 20+)
  try {
    const buf = require('node:buffer');
    if (buf?.File) { _FileCtor = buf.File; return _FileCtor; }
  } catch {}
  _FileCtor = false; // marca que não tem
  return _FileCtor;
}

async function uploadToFalStorage(buffer, filename) {
  const fal = await getFal();
  const FileC = getFileCtor();
  let payload;
  if (FileC) {
    payload = new FileC([buffer], filename, { type: 'image/png' });
  } else {
    // fal.storage.upload aceita Blob também — fica sem nome custom mas funciona
    payload = new Blob([buffer], { type: 'image/png' });
  }
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('fal.storage.upload retornou vazio');
  return url;
}

const { buildEditorialPrompt, getReferenceImages } = require('./marketingPrompts');

/**
 * Gera foto editorial usando gpt-image-1 com até 3 imagens de referência.
 * Aceita objeto product COMPLETO pra ter acesso a aiContext, imageUrls[], etc.
 *
 * @param {object} opts
 * @param {object} opts.product    - objeto Product Prisma (com aiContext, imageUrls)
 * @param {string} opts.aspectRatio - '16:9' | '9:16' | '1:1' | '4:5'
 * @param {string} opts.sceneHint  - cenário custom (opcional)
 * @param {string} opts.quality    - 'low' | 'medium' | 'high' (default: medium)
 * @param {number} opts.maxRefs    - máx imagens de referência (default 3, gpt-image-1 aceita até 4)
 *
 * Aceita também a assinatura antiga { productName, brand, imageUrl } pra compat.
 *
 * @returns {Promise<{outputUrl, model, prompt, costUsd}>}
 */
async function generateEditorialPhoto(opts) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada no .env');

  // Compat: aceita assinatura antiga { productName, brand, imageUrl } montando product on-the-fly
  let product = opts.product;
  if (!product) {
    product = {
      name: opts.productName,
      brand: opts.brand,
      imageUrl: opts.imageUrl,
      imageUrls: opts.imageUrls,
    };
  }

  const aspectRatio = opts.aspectRatio || '16:9';
  const sceneHint = opts.sceneHint || '';
  const quality = opts.quality || 'medium';
  const maxRefs = opts.maxRefs || 3;

  const prompt = await buildEditorialPrompt(product, sceneHint, { aspectRatio });
  const refUrls = getReferenceImages(product, maxRefs);
  if (refUrls.length === 0) throw new Error('produto sem imagem de referência');

  // 1. Baixa todas as imagens de referência em paralelo
  const refBuffers = await Promise.all(
    refUrls.map((url, i) => withRetry(() => fetchAsBuffer(url), `fetch ref ${i + 1}/${refUrls.length}`))
  );

  // 2. Monta multipart pra /v1/images/edits — gpt-image-1 aceita múltiplas refs
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', sizeFor(aspectRatio));
  form.append('quality', quality);
  form.append('n', '1');
  // Manda cada ref como image[] (ou image múltiplas vezes, dependendo da API)
  refBuffers.forEach((buf, i) => {
    const blob = new Blob([buf], { type: 'image/png' });
    form.append('image[]', blob, `product-${i}.png`);
  });

  // 3. Chama OpenAI
  const productName = product.name || 'product';
  const result = await withRetry(async () => {
    const r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`OpenAI ${r.status}: ${txt.slice(0, 300)}`);
    }
    return r.json();
  }, `gpt-image-1 ${productName.slice(0, 30)} [${refUrls.length} refs]`);

  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-1 não retornou b64_json');

  // 4. Upload pra fal.storage
  const outBuffer = Buffer.from(b64, 'base64');
  const filename = `gpt-${Date.now()}-${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.png`;
  const outputUrl = await withRetry(() => uploadToFalStorage(outBuffer, filename), `upload ${filename}`);

  return {
    outputUrl,
    model: 'gpt-image-1',
    prompt,
    costUsd: COSTS[`gpt-image-1:${quality}`] || 0.042,
  };
}

module.exports = {
  generateEditorialPhoto,
  COSTS,
};
