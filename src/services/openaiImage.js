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
 */
async function uploadToFalStorage(buffer, filename) {
  const fal = await getFal();
  // fal client aceita File (browser) ou Blob. Em Node 20+ tem Blob global.
  const blob = new Blob([buffer], { type: 'image/png' });
  // Cria File via File API (Node 20+ tem File global)
  const file = new File([blob], filename, { type: 'image/png' });
  const url = await fal.storage.upload(file);
  if (!url) throw new Error('fal.storage.upload retornou vazio');
  return url;
}

/**
 * Gera foto editorial usando gpt-image-1 com imagem de referência do produto.
 * Interface idêntica ao falAi.generateEditorialPhoto pra plug-and-play.
 *
 * @param {object} opts
 * @param {string} opts.productName
 * @param {string} opts.brand
 * @param {string} opts.imageUrl   - URL pública da foto do produto (referência)
 * @param {string} opts.aspectRatio - '16:9' | '9:16' | '1:1'
 * @param {string} opts.sceneHint  - cenário custom (opcional)
 * @param {string} opts.quality    - 'low' | 'medium' | 'high' (default: medium)
 * @returns {Promise<{outputUrl, model, prompt, costUsd}>}
 */
async function generateEditorialPhoto({
  productName,
  brand,
  imageUrl,
  aspectRatio = '16:9',
  sceneHint = '',
  quality = 'medium',
}) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não configurada no .env');

  const scene = sceneHint || pickEditorialScene(productName, brand);
  const prompt = `Editorial product photography of the ${productName} (${brand}), ${scene}. Hyperrealistic, magazine cover quality, dramatic professional studio lighting, sharp focus on the product. Premium sports/lifestyle brand aesthetic. Do not change product colors, logos, or shape — keep faithful to reference image.`;

  // 1. Baixa imagem do produto
  const refBuffer = await withRetry(() => fetchAsBuffer(imageUrl), `fetch ref ${productName.slice(0, 30)}`);

  // 2. Monta multipart pra /v1/images/edits
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', sizeFor(aspectRatio));
  form.append('quality', quality);
  form.append('n', '1');
  // gpt-image-1 aceita PNG/JPEG/WebP até 25MB
  const inputBlob = new Blob([refBuffer], { type: 'image/png' });
  form.append('image', inputBlob, 'product.png');

  // 3. Chama OpenAI
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
  }, `gpt-image-1 ${productName.slice(0, 30)}`);

  const b64 = result?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-1 não retornou b64_json');

  // 4. Upload pra fal.storage
  const outBuffer = Buffer.from(b64, 'base64');
  const filename = `gpt-${Date.now()}-${(productName || 'prod').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.png`;
  const outputUrl = await withRetry(() => uploadToFalStorage(outBuffer, filename), `upload ${filename}`);

  return {
    outputUrl,
    model: 'gpt-image-1',
    prompt,
    costUsd: COSTS[`gpt-image-1:${quality}`] || 0.042,
  };
}

/**
 * Mesma heurística do falAi pra escolher cenário editorial.
 */
function pickEditorialScene(name, brand) {
  const n = (name || '').toLowerCase();
  if (n.match(/corrida|run|running/)) return 'urban street with morning light, athlete blur in background';
  if (n.match(/futebol|chuteira|society/)) return 'green grass football field, golden hour, condensation drops';
  if (n.match(/tenis(?!\s)|tennis|padel/)) return 'red clay tennis court with net in background, vibrant sunset';
  if (n.match(/basquete|basket/)) return 'outdoor concrete basketball court, dramatic city skyline';
  if (n.match(/treino|gym|crossfit|musculação/)) return 'industrial gym with steel beams, moody dramatic lighting';
  if (n.match(/caminhada|walk|tracking|trilha/)) return 'mountain trail with morning mist, soft natural light';
  if (n.match(/feminin|woman/)) return 'modern minimalist studio, soft pastel background';
  return 'modern sports lifestyle scene, urban environment, warm sunset lighting';
}

module.exports = {
  generateEditorialPhoto,
  COSTS,
};
