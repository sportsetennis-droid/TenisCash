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

// =====================================================================
// TEXT OVERLAY — headline + badge de preço (estilo S&T)
// =====================================================================

function escapeXml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Quebra texto em múltiplas linhas pra caber numa largura máxima.
 * Aproximação: 0.55 * fontSize por caractere (Inter/Helvetica bold).
 */
function wrapText(text, maxChars) {
  if (!text) return [];
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length <= maxChars) line = (line + ' ' + w).trim();
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Gera SVG com headline no topo e badge de preço no canto inferior direito.
 * Aplica sobre a imagem composite via Sharp.composite.
 *
 * @param {object} opts
 *   - headline: string (opcional) — texto grande no topo
 *   - subline: string (opcional) — texto pequeno abaixo do produto
 *   - price: number (opcional) — preço em BRL, vira badge
 *   - installments: number (opcional, default 6) — pra calcular parcela
 *   - aspectRatio, width, height: dimensões da imagem base
 */
function buildOverlaySvg(opts) {
  const { headline, subline, price, installments = 6, width, height } = opts;
  const hasHeadline = headline && String(headline).trim().length > 0;
  const hasPrice = typeof price === 'number' && price > 0;
  const hasSubline = subline && String(subline).trim().length > 0;

  if (!hasHeadline && !hasPrice && !hasSubline) return null;

  // Tamanhos proporcionais à largura (responsivo)
  const headlineSize = Math.round(width * 0.075);   // ~77px em 1024px
  const sublineSize = Math.round(width * 0.025);    // ~26px
  const priceSize = Math.round(width * 0.055);      // ~56px
  const parcelaSize = Math.round(width * 0.022);    // ~22px

  // Headline: até 22 chars por linha, max 2 linhas
  const headlineLines = hasHeadline ? wrapText(headline.toUpperCase(), 22).slice(0, 2) : [];
  const headlineLineHeight = Math.round(headlineSize * 1.05);
  const headlineY = Math.round(headlineSize * 1.3);

  // Subline
  const sublineY = Math.round(height * 0.85);

  // Badge preço (canto inferior direito) — círculo laranja c/ gradiente
  const badgeR = Math.round(width * 0.13);
  const badgeCx = width - badgeR - Math.round(width * 0.04);
  const badgeCy = height - badgeR - Math.round(width * 0.04);
  const parcela = hasPrice ? (price / installments).toFixed(2).replace('.', ',') : '';
  const priceStr = hasPrice ? Math.round(price).toString() : '';

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FF6A1F"/>
        <stop offset="100%" stop-color="#FF2D92"/>
      </linearGradient>
      <filter id="text-shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
        <feOffset dx="0" dy="3" result="offsetblur"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    ${hasHeadline ? `
      <!-- Faixa de fundo semitransparente atrás do headline pra garantir legibilidade -->
      <rect x="0" y="0" width="${width}" height="${headlineY + (headlineLines.length - 1) * headlineLineHeight + Math.round(headlineSize * 0.6)}" fill="rgba(0,0,0,0.18)"/>
      ${headlineLines.map((line, i) => `
        <text x="${Math.round(width * 0.05)}" y="${headlineY + i * headlineLineHeight}"
              font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif"
              font-size="${headlineSize}"
              font-weight="900"
              fill="#ffffff"
              filter="url(#text-shadow)"
              letter-spacing="-1">${escapeXml(line)}</text>
      `).join('')}
    ` : ''}

    ${hasSubline ? `
      <text x="${Math.round(width * 0.05)}" y="${sublineY}"
            font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif"
            font-size="${sublineSize}"
            font-weight="700"
            fill="#ffffff"
            filter="url(#text-shadow)">${escapeXml(subline.slice(0, 80))}</text>
    ` : ''}

    ${hasPrice ? `
      <!-- Badge circular de preço -->
      <circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="url(#bg-grad)" stroke="#ffffff" stroke-width="3" filter="url(#text-shadow)"/>
      <text x="${badgeCx}" y="${badgeCy - Math.round(badgeR * 0.05)}"
            font-family="Arial Black, Helvetica, sans-serif"
            font-size="${priceSize}"
            font-weight="900"
            fill="#ffffff"
            text-anchor="middle"
            dominant-baseline="middle">R$ ${priceStr}</text>
      ${installments > 1 ? `
        <text x="${badgeCx}" y="${badgeCy + Math.round(badgeR * 0.4)}"
              font-family="Liberation Sans, DejaVu Sans, Arial, sans-serif"
              font-size="${parcelaSize}"
              font-weight="700"
              fill="#ffffff"
              text-anchor="middle"
              dominant-baseline="middle"
              opacity="0.95">${installments}x R$ ${parcela}</text>
      ` : ''}
    ` : ''}
  </svg>`;
}

/**
 * Aplica overlay de texto + badge sobre uma imagem buffer.
 */
async function applyTextOverlay(imageBuffer, opts) {
  const meta = await sharp(imageBuffer).metadata();
  const svg = buildOverlaySvg({ ...opts, width: meta.width, height: meta.height });
  if (!svg) return imageBuffer;
  try {
    return await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (e) {
    console.warn('[compositeImage] overlay falhou, retornando sem texto:', e.message);
    return imageBuffer;
  }
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
  let finalBuffer = await composeFinal(backgroundUrl, productPngUrl, aspectRatio);

  // Aplica overlay de texto (headline + preço) se solicitado
  // opts.headline: string com a frase principal
  // opts.subline: string secundária pequena
  // opts.price: número (puxa do product.price se não passar e includePrice=true)
  // opts.includePrice: bool (default true se price > 0)
  const wantOverlay = opts.headline || opts.subline || opts.includePrice !== false;
  if (wantOverlay) {
    const overlayPrice = (opts.includePrice !== false && product.price > 0) ? product.price : null;
    finalBuffer = await applyTextOverlay(finalBuffer, {
      headline: opts.headline || '',
      subline: opts.subline || '',
      price: overlayPrice,
      installments: opts.installments || 6,
    });
  }

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
