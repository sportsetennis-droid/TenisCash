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
const fs = require('fs');
const path = require('path');
const { buildBackgroundPrompt, getReferenceImages } = require('./marketingPrompts');

// =====================================================
// Fontes Inter embedded (Base64) — render robusto independente do SO
// =====================================================
// librsvg do Sharp lê @font-face com data URI WOFF2 nativamente.
// Carregamos a fonte 1x no boot e reutilizamos em todas as gerações.

// =====================================================
// Texto → SVG PATH (opentype.js) — vetorial, sem fontconfig
// =====================================================
// librsvg do Railway tem fontconfig quebrado, então não consegue
// renderizar <text> mesmo com @font-face TTF embedded. Solução:
// converter texto em <path d="..."> shapes vetoriais via opentype.js.
// Cada letra vira uma figura SVG, independente de qualquer fonte do SO.

const opentype = require('opentype.js');

let _fontBlack = null;
let _fontBold = null;

function loadFont(relPath) {
  try {
    const p = path.resolve(__dirname, '../..', relPath);
    const buf = fs.readFileSync(p);
    const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return font;
  } catch (e) {
    console.warn('[compositeImage] falha ao carregar fonte', relPath, ':', e.message);
    return null;
  }
}

function getFontBlack() {
  if (_fontBlack !== null) return _fontBlack;
  _fontBlack = loadFont('node_modules/@expo-google-fonts/inter/900Black/Inter_900Black.ttf') || false;
  if (_fontBlack) console.log('[compositeImage] Inter-900 Black (opentype) carregada');
  return _fontBlack;
}
function getFontBold() {
  if (_fontBold !== null) return _fontBold;
  _fontBold = loadFont('node_modules/@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf') || false;
  return _fontBold;
}

/**
 * Retorna { pathData, width } pro texto desenhado em (x, y) com fontSize.
 * Usa fonte Black (default) ou Bold. Se nenhuma carregar, retorna null.
 */
function textToSvgPath(text, x, y, fontSize, useBold = false) {
  const font = (useBold ? getFontBold() : getFontBlack()) || getFontBold() || getFontBlack();
  if (!font) return null;
  try {
    const otPath = font.getPath(String(text || ''), x, y, fontSize);
    const advance = font.getAdvanceWidth(String(text || ''), fontSize);
    return { d: otPath.toPathData(2), width: advance };
  } catch (e) {
    console.warn('[compositeImage] textToSvgPath falhou:', e.message);
    return null;
  }
}

/**
 * Mede largura do texto em pixels (pra wrapping).
 */
function measureText(text, fontSize, useBold = false) {
  const font = (useBold ? getFontBold() : getFontBlack()) || getFontBold() || getFontBlack();
  if (!font) return text.length * fontSize * 0.5;
  return font.getAdvanceWidth(String(text || ''), fontSize);
}

// fontDefsCss não é mais necessário (sem @font-face). Mantido vazio pra compat.
function fontDefsCss() { return ''; }

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
 * Expande canvas no topo da imagem usando BLUR da própria foto como fill.
 * Garante espaço pro headline sem ficar no rosto do sujeito.
 *
 * Estratégia:
 *   1. Pega faixa superior da imagem original (top 20%)
 *   2. Cria versão dela em 18% da altura, blur 40px + 85% brightness
 *   3. Compose: blur no topo + original embaixo
 *   4. Resize de volta pro aspect ratio target (squeeze vertical leve ~15%)
 *
 * O squeeze é praticamente imperceptível em fotos editoriais; vale o
 * trade-off pra garantir headline SEMPRE no espaço vazio do topo.
 */
async function expandTopForText(imgBuf, targetW, targetH, topExpandPct = 0.18) {
  const meta = await sharp(imgBuf).metadata();
  if (!meta.width || !meta.height) return imgBuf;
  const expandPx = Math.round(meta.height * topExpandPct);

  // 1. Fill blur: pega top 20% da imagem original, resize pra altura expandPx, blur forte + dim
  const topSliceH = Math.max(40, Math.round(meta.height * 0.2));
  const topFill = await sharp(imgBuf)
    .extract({ left: 0, top: 0, width: meta.width, height: topSliceH })
    .resize(meta.width, expandPx, { fit: 'cover', position: 'top' })
    .blur(35)
    .modulate({ brightness: 0.82 })
    .toBuffer();

  // 2. Canvas expandido = original + blur no topo
  const expanded = await sharp({
    create: { width: meta.width, height: meta.height + expandPx, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: topFill, top: 0, left: 0 },
      { input: imgBuf, top: expandPx, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();

  // 3. Resize pro aspect ratio final (squeeze vertical leve)
  return sharp(expanded)
    .resize(targetW, targetH, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
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
 * Quebra texto em múltiplas linhas pra caber numa largura máxima em pixels.
 * MEDIÇÃO REAL via opentype.js (não mais estimativa por chars).
 */
function wrapText(text, fontSize, maxWidthPx, useBold = false) {
  if (!text) return [];
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? (line + ' ' + w) : w;
    if (measureText(candidate, fontSize, useBold) <= maxWidthPx) line = candidate;
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Calcula o maior fontSize que mantém o texto cabendo em maxLines linhas
 * dentro de maxWidthPx. Usa medição real.
 */
function autoFitFontSize(text, maxWidthPx, maxLines, startSize, minSize, useBold = false) {
  let size = startSize;
  while (size > minSize) {
    const lines = wrapText(text, size, maxWidthPx, useBold);
    // E também checa se a maior linha cabe (não só count)
    const fits = lines.length <= maxLines && lines.every(l => measureText(l, size, useBold) <= maxWidthPx);
    if (fits) return { size, lines };
    size -= Math.max(2, Math.round(startSize * 0.04));
  }
  // Último recurso: trunca com "…"
  const lines = wrapText(text, size, maxWidthPx, useBold).slice(0, maxLines);
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (measureText(last + '…', size, useBold) > maxWidthPx && last.length > 0) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = last + '…';
  }
  return { size, lines };
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
  const { headline, subline, price, installments = 6, width, height, handle, logoEmbedB64 } = opts;
  const hasHeadline = headline && String(headline).trim().length > 0;
  const hasPrice = typeof price === 'number' && price > 0;
  const hasSubline = subline && String(subline).trim().length > 0;
  const hasHandle = handle && String(handle).trim().length > 0;
  const hasLogo = !!logoEmbedB64;

  if (!hasHeadline && !hasPrice && !hasSubline && !hasHandle && !hasLogo) return null;

  // Margem segura horizontal (10% pra cada lado = 80% de largura útil pro texto)
  const sideMargin = Math.round(width * 0.05);
  const maxTextWidth = width - 2 * sideMargin;

  // === HEADLINE com auto-fit (diminui fontSize até caber em 2 linhas) ===
  const startHeadlineSize = Math.round(width * 0.085);  // ~87px em 1024px
  const minHeadlineSize = Math.round(width * 0.04);     // ~41px mínimo
  let headlineLines = [];
  let headlineSize = startHeadlineSize;
  if (hasHeadline) {
    const fit = autoFitFontSize(headline.toUpperCase(), maxTextWidth, 2, startHeadlineSize, minHeadlineSize);
    headlineLines = fit.lines;
    headlineSize = fit.size;
  }
  const headlineLineHeight = Math.round(headlineSize * 1.0);
  const headlineY = Math.round(headlineSize * 1.15);
  const headlineBlockH = headlineY + (headlineLines.length - 1) * headlineLineHeight + Math.round(headlineSize * 0.5);

  // === SUBLINE com auto-fit ===
  const startSublineSize = Math.round(width * 0.028);
  const minSublineSize = Math.round(width * 0.02);
  let sublineLines = [];
  let sublineSize = startSublineSize;
  if (hasSubline) {
    const fit = autoFitFontSize(subline, maxTextWidth, 2, startSublineSize, minSublineSize);
    sublineLines = fit.lines;
    sublineSize = fit.size;
  }
  const sublineLineHeight = Math.round(sublineSize * 1.15);
  const sublineY = Math.round(height * 0.82);

  // === PREÇO badge (canto inferior direito) ===
  const priceSize = Math.round(width * 0.055);
  const parcelaSize = Math.round(width * 0.022);
  const badgeR = Math.round(width * 0.13);
  const badgeCx = width - badgeR - Math.round(width * 0.04);
  const badgeCy = height - badgeR - Math.round(width * 0.04);
  const parcela = hasPrice ? (price / installments).toFixed(2).replace('.', ',') : '';
  const priceStr = hasPrice ? Math.round(price).toString() : '';

  // === LOGO (canto inferior esquerdo) ===
  const logoSize = Math.round(width * 0.13);
  const logoX = Math.round(width * 0.04);
  const logoY = height - logoSize - Math.round(width * 0.04);

  // === HANDLE @ (canto inferior, abaixo da logo OU sozinho) ===
  const handleSize = Math.round(width * 0.022);
  const handleX = hasLogo ? (logoX + logoSize + Math.round(width * 0.018)) : Math.round(width * 0.05);
  const handleY = hasLogo ? (logoY + logoSize / 2 + handleSize / 3) : (height - Math.round(width * 0.04));

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <style>${fontDefsCss()}</style>
      <linearGradient id="bg-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#FF6A1F"/>
        <stop offset="100%" stop-color="#FF2D92"/>
      </linearGradient>
      <!-- Gradient escuro pra fundo do headline: forte no topo, transparente embaixo -->
      <linearGradient id="headline-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(0,0,0,0.75)"/>
        <stop offset="60%" stop-color="rgba(0,0,0,0.55)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </linearGradient>
      <!-- Gradient claro pra fundo do handle/logo: bottom-up -->
      <linearGradient id="bottom-grad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(0,0,0,0.65)"/>
        <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
      </linearGradient>
      <filter id="text-shadow" x="-15%" y="-15%" width="130%" height="130%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="4"/>
        <feOffset dx="0" dy="4" result="offsetblur"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.8"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    ${hasHeadline ? `
      <!-- Faixa gradient escuro (transparente embaixo) — protege legibilidade sem cortar foto -->
      <rect x="0" y="0" width="${width}" height="${Math.round(headlineBlockH * 1.6)}" fill="url(#headline-grad)"/>
      ${headlineLines.map((line, i) => {
        const p = textToSvgPath(line, sideMargin, headlineY + i * headlineLineHeight, headlineSize, false);
        return p ? `<path d="${p.d}" fill="#ffffff" filter="url(#text-shadow)"/>` : '';
      }).join('')}
    ` : ''}

    ${hasSubline ? sublineLines.map((line, i) => {
      const p = textToSvgPath(line, sideMargin, sublineY + i * sublineLineHeight, sublineSize, true);
      return p ? `<path d="${p.d}" fill="#ffffff" filter="url(#text-shadow)"/>` : '';
    }).join('') : ''}

    ${(hasLogo || hasHandle) ? `
      <!-- Faixa gradient inferior protege legibilidade da logo/handle sem cobrir o produto -->
      <rect x="0" y="${Math.round(height * 0.78)}" width="${width}" height="${Math.round(height * 0.22)}" fill="url(#bottom-grad)"/>
    ` : ''}

    ${hasLogo ? `
      <rect x="${logoX - 6}" y="${logoY - 6}" width="${logoSize + 12}" height="${logoSize + 12}" rx="14" fill="rgba(255,255,255,0.95)"/>
      <image href="data:image/png;base64,${logoEmbedB64}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>
    ` : ''}

    ${hasHandle ? (() => {
      const p = textToSvgPath(handle, handleX, handleY, handleSize, true);
      return p ? `<path d="${p.d}" fill="#ffffff" filter="url(#text-shadow)"/>` : '';
    })() : ''}

    ${hasPrice ? (() => {
      const priceText = 'R$ ' + priceStr;
      const pricePath = textToSvgPath(priceText, 0, 0, priceSize, false);
      const priceW = pricePath ? pricePath.width : 0;
      const priceX = badgeCx - priceW / 2;
      const priceY = badgeCy + priceSize * 0.3;
      const pricePathEl = pricePath ? `<path d="${textToSvgPath(priceText, priceX, priceY, priceSize, false).d}" fill="#ffffff"/>` : '';

      let parcelaEl = '';
      if (installments > 1) {
        const ptxt = installments + 'x R$ ' + parcela;
        const pp = textToSvgPath(ptxt, 0, 0, parcelaSize, true);
        if (pp) {
          const px = badgeCx - pp.width / 2;
          const py = badgeCy + Math.round(badgeR * 0.55);
          parcelaEl = `<path d="${textToSvgPath(ptxt, px, py, parcelaSize, true).d}" fill="#ffffff" opacity="0.95"/>`;
        }
      }
      return `
        <circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="url(#bg-grad)" stroke="#ffffff" stroke-width="3" filter="url(#text-shadow)"/>
        ${pricePathEl}
        ${parcelaEl}
      `;
    })() : ''}
  </svg>`;
}

/**
 * Aplica overlay de texto + badge sobre uma imagem buffer.
 * Aceita logoUrl (URL pública); baixa, converte pra base64 e embeda no SVG.
 */
async function applyTextOverlay(imageBuffer, opts) {
  const meta = await sharp(imageBuffer).metadata();
  let logoEmbedB64 = null;
  if (opts.logoUrl) {
    try {
      const buf = await fetchAsBuffer(opts.logoUrl);
      // Normaliza pra PNG quadrada 256x256 (com fundo transparente)
      const norm = await sharp(buf).resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      logoEmbedB64 = norm.toString('base64');
    } catch (e) {
      console.warn('[compositeImage] logo download falhou:', e.message);
    }
  }
  const svg = buildOverlaySvg({ ...opts, width: meta.width, height: meta.height, logoEmbedB64 });
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
  const productImageUrl = refs[0]; // pode ser null no modo conceito

  const productName = product.name || 'product';
  const bgPrompt = await buildBackgroundPrompt(product, sceneHint);

  let finalBuffer;
  const { w: targetW, h: targetH } = dimsFor(aspectRatio);

  if (productImageUrl) {
    // MODO COM FOTO: Bria (remove bg) + Flux (gera bg) EM PARALELO + Sharp compõe
    const [productPngUrl, backgroundUrl] = await Promise.all([
      removeBgBria(productImageUrl),
      generateBackground(bgPrompt, aspectRatio),
    ]);
    finalBuffer = await composeFinal(backgroundUrl, productPngUrl, aspectRatio);
  } else {
    // MODO CONCEITO PURO (sem foto): só gera background via Flux text-to-image
    const backgroundUrl = await generateBackground(bgPrompt, aspectRatio);
    const bgBuf = await fetchAsBuffer(backgroundUrl);
    finalBuffer = await sharp(bgBuf)
      .resize(targetW, targetH, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 92 })
      .toBuffer();
  }

  // === EXPANSÃO DE CANVAS PRO HEADLINE ===
  // Se vai ter headline (ou subline), expande topo via blur+squeeze pra
  // garantir espaço pro texto sem ficar em cima do sujeito.
  // Default ON quando includeHeadline=true. Pode desligar via opts.expandTop=false
  const willHaveTopText = (opts.includeHeadline !== false) &&
                          (opts.headline || opts.includeHeadline === true);
  if (willHaveTopText && opts.expandTop !== false) {
    finalBuffer = await expandTopForText(finalBuffer, targetW, targetH, 0.18);
  }

  // Aplica overlay de texto/logo/handle se solicitado
  // Cada elemento é opt-in via flag separada (controlado pela UI)
  //   opts.includeHeadline (default true se opts.headline tem texto)
  //   opts.includePrice    (default false — só liga se UI marcar)
  //   opts.includeLogo     (default false)
  //   opts.includeHandle   (default false)
  //   opts.includeSubline  (default false)
  //   opts.logoUrl, opts.handle — passados pela rota
  const headline = opts.includeHeadline === false ? '' : (opts.headline || '');
  const subline = opts.includeSubline ? (opts.subline || '') : '';
  const price = opts.includePrice && product.price > 0 ? product.price : null;
  const logoUrl = opts.includeLogo ? (opts.logoUrl || null) : null;
  const handle = opts.includeHandle ? (opts.handle || '') : '';

  const wantOverlay = headline || subline || price || logoUrl || handle;
  if (wantOverlay) {
    finalBuffer = await applyTextOverlay(finalBuffer, {
      headline, subline, price, logoUrl, handle,
      installments: opts.installments || 6,
    });
  }

  // Upload final
  const filename = `composite-${Date.now()}-${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.jpg`;
  const outputUrl = await withRetry(() => uploadToFalStorage(finalBuffer, filename), `upload ${filename}`);

  return {
    outputUrl,
    model: productImageUrl ? 'composite (bria+flux+sharp)' : 'composite (flux-only / concept)',
    prompt: bgPrompt,
    costUsd: productImageUrl ? COSTS.composite : 0.04, // sem Bria, só Flux
  };
}

module.exports = {
  generateEditorialPhoto,
  COSTS,
};
