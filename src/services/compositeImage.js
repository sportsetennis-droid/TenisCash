// =====================================================================
// Composite Image Pipeline — produto REAL + cenário IA + composição
// =====================================================================
// Resolve o problema de IA gerativa (Flux/GPT) deformar produtos.
//
// Pipeline:
//   1. Bria remove fundo da foto do catálogo  →  PNG com alpha
//   2. Flux Pro text-to-image gera SÓ o cenário (sem mandar produto)
//   3. Sharp compõe: produto recortado por cima do cenário
//   4. (opcional) Sharp aplica leve drop shadow + ajuste tonal
//
// Resultado: produto 100% fiel (é a foto original) + cena bonita (IA).
// Custo: ~$0.05 ($0.01 Bria + $0.04 Flux background).
// Tempo: ~25s (parallel onde possível).
//
// Usa @fal-ai/client (já carregado) e sharp (já no package.json).
// =====================================================================

const sharp = require('sharp');
const { pickSceneAuto, getReferenceImages } = require('./marketingPrompts');

const COSTS = {
  'composite': 0.05,  // bria 0.01 + flux 0.04 (estimado)
};

let _fal = null;
async function getFal() {
  if (_fal) return _fal;
  const mod = await import('@fal-ai/client');
  _fal = mod.fal;
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY não configurada');
  _fal.config({ credentials: process.env.FAL_KEY });
  return _fal;
}

async function withRetry(fn, opName, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const t0 = Date.now();
      const result = await fn();
      console.log(`[compositeImage] ${opName} OK em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.warn(`[compositeImage] ${opName} falhou ${attempt}/${maxAttempts}: ${err.message}. Esperando ${wait}ms`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function fetchAsBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} → HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Aspect ratio → dimensões em pixels (lado maior fixo em 1536).
 */
function dimsFor(aspectRatio) {
  switch (aspectRatio) {
    case '1:1':  return { w: 1024, h: 1024 };
    case '4:5':  return { w: 1080, h: 1350 };
    case '9:16': return { w: 1080, h: 1920 };
    case '16:9':
    default:     return { w: 1920, h: 1080 };
  }
}

/**
 * Constrói prompt pra geração de SÓ o cenário (sem produto na cena).
 */
function buildBackgroundPrompt(product, sceneHint) {
  const scene = (sceneHint && sceneHint.trim()) || pickSceneAuto(product);
  return [
    'Editorial background scene for sports lifestyle product photography:',
    scene + '.',
    'Empty scene with clean focal point — no products, no people, no text.',
    'Hyperrealistic, magazine quality, dramatic professional lighting, shallow depth of field.',
    'Subtle warm orange-pink gradient accents are welcome but not required.',
    'IMPORTANT: Do not include any product, person, animal, or text in the image. Leave space in the center-bottom area for a product overlay.',
  ].join(' ');
}

/**
 * Remove fundo da foto do produto via Bria.
 */
async function removeBgBria(imageUrl) {
  const fal = await getFal();
  const result = await withRetry(
    () => fal.subscribe('fal-ai/bria/background/remove', { input: { image_url: imageUrl }, logs: false }),
    'bria removeBg'
  );
  const outUrl = result?.data?.image?.url;
  if (!outUrl) throw new Error('bria não retornou URL');
  return outUrl;
}

/**
 * Gera SÓ o background via Flux Pro v1.1 (text-to-image puro).
 * Não passa imagem do produto — o modelo só vê o prompt.
 */
async function generateBackground(prompt, aspectRatio) {
  const fal = await getFal();
  const result = await withRetry(
    () => fal.subscribe('fal-ai/flux-pro/v1.1', {
      input: {
        prompt,
        aspect_ratio: aspectRatio === '4:5' ? '4:5' : aspectRatio,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        output_format: 'jpeg',
        safety_tolerance: '2',
      },
      logs: false,
    }),
    `flux-pro background ${aspectRatio}`
  );
  const url = result?.data?.images?.[0]?.url;
  if (!url) throw new Error('flux-pro não retornou URL');
  return url;
}

/**
 * Compõe: produto (PNG com alpha) por cima do background.
 * Redimensiona produto pra ocupar ~55% da menor dimensão, centra
 * horizontalmente, posiciona 60% pra baixo da altura (visual editorial).
 * Adiciona leve drop shadow pra integração.
 */
async function composeFinal(bgUrl, productPngUrl, aspectRatio) {
  const [bgBuf, prodBuf] = await Promise.all([
    fetchAsBuffer(bgUrl),
    fetchAsBuffer(productPngUrl),
  ]);

  const { w: targetW, h: targetH } = dimsFor(aspectRatio);

  // Garante que o background tem o tamanho certo (Flux pode entregar dimensões diferentes)
  const bgResized = await sharp(bgBuf)
    .resize(targetW, targetH, { fit: 'cover', position: 'center' })
    .toBuffer();

  // Lê metadata do produto pra calcular escala
  const prodMeta = await sharp(prodBuf).metadata();
  const prodAspect = (prodMeta.width || 1) / (prodMeta.height || 1);

  // Escala produto: ocupa ~58% da menor dimensão (margem segura)
  const targetMin = Math.min(targetW, targetH);
  const prodH = Math.round(targetMin * 0.58);
  const prodW = Math.round(prodH * prodAspect);

  // Limita largura pra não estourar
  const maxW = Math.round(targetW * 0.7);
  const finalW = Math.min(prodW, maxW);
  const finalH = Math.round(finalW / prodAspect);

  const prodResized = await sharp(prodBuf)
    .resize(finalW, finalH, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();

  // Posição: centrado horizontalmente, 58% da altura (rule of thirds bottom)
  const top = Math.round(targetH * 0.58 - finalH / 2);
  const left = Math.round((targetW - finalW) / 2);

  // Sombra suave embaixo do produto (10px blur, deslocada 20px pra baixo)
  // Cria sombra: shape do produto com canal alpha 0.35, gaussian blur
  let shadowBuf = null;
  try {
    shadowBuf = await sharp(prodResized)
      .composite([{
        input: Buffer.from(`<svg width="${finalW}" height="${finalH}"><rect width="${finalW}" height="${finalH}" fill="rgba(0,0,0,0.45)"/></svg>`),
        blend: 'in',
      }])
      .blur(15)
      .toBuffer();
  } catch (e) {
    console.warn('[compositeImage] shadow falhou, segue sem sombra:', e.message);
  }

  const layers = [];
  if (shadowBuf) {
    layers.push({ input: shadowBuf, top: Math.max(0, top + 25), left: Math.max(0, left + 8) });
  }
  layers.push({ input: prodResized, top: Math.max(0, top), left: Math.max(0, left) });

  return await sharp(bgResized)
    .composite(layers)
    .jpeg({ quality: 92 })
    .toBuffer();
}

/**
 * Upload do buffer final pra fal.storage.
 */
let _FileCtor = null;
function getFileCtor() {
  if (_FileCtor !== null) return _FileCtor;
  if (typeof File !== 'undefined') { _FileCtor = File; return _FileCtor; }
  try {
    const buf = require('node:buffer');
    if (buf?.File) { _FileCtor = buf.File; return _FileCtor; }
  } catch {}
  _FileCtor = false;
  return _FileCtor;
}

async function uploadToFalStorage(buffer, filename) {
  const fal = await getFal();
  const FileC = getFileCtor();
  const payload = FileC
    ? new FileC([buffer], filename, { type: 'image/jpeg' })
    : new Blob([buffer], { type: 'image/jpeg' });
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('upload retornou vazio');
  return url;
}

/**
 * API principal — interface idêntica ao falAi/openaiImage pra plug-and-play.
 *
 * @param {object} opts
 *   - product: objeto Product completo (com imageUrl, imageUrls, aiContext)
 *   - aspectRatio: '16:9' | '9:16' | '1:1' | '4:5'
 *   - sceneHint: cenário custom (opcional)
 * @returns {Promise<{outputUrl, model, prompt, costUsd}>}
 */
async function generateEditorialPhoto(opts) {
  let product = opts.product;
  if (!product) {
    product = { name: opts.productName, brand: opts.brand, imageUrl: opts.imageUrl, imageUrls: opts.imageUrls };
  }

  const aspectRatio = opts.aspectRatio || '1:1';
  const sceneHint = opts.sceneHint || '';
  const refs = getReferenceImages(product, 1);
  const productImageUrl = refs[0];
  if (!productImageUrl) throw new Error('produto sem imagem de referência');

  const productName = product.name || 'product';
  const bgPrompt = buildBackgroundPrompt(product, sceneHint);

  // Roda Bria (remove bg) e Flux (gera bg) EM PARALELO — economia de tempo
  const [productPngUrl, backgroundUrl] = await Promise.all([
    removeBgBria(productImageUrl),
    generateBackground(bgPrompt, aspectRatio),
  ]);

  // Composição local (Sharp) — rápida
  const finalBuffer = await composeFinal(backgroundUrl, productPngUrl, aspectRatio);

  // Upload final
  const filename = `composite-${Date.now()}-${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.jpg`;
  const outputUrl = await withRetry(() => uploadToFalStorage(finalBuffer, filename), `upload ${filename}`);

  return {
    outputUrl,
    model: 'composite (bria+flux+sharp)',
    prompt: bgPrompt,
    costUsd: COSTS.composite,
  };
}

module.exports = {
  generateEditorialPhoto,
  COSTS,
};
