// =====================================================================
// fal.ai wrapper — geração de criativos de marketing
// =====================================================================
// Modelos usados:
//   - fal-ai/flux-pro/kontext-max  → foto editorial 16:9
//   - fal-ai/minimax/hailuo-02/pro/image-to-video → vídeo 6s 9:16 pra Reels (cinematográfico, escolhido apos teste comparativo)
//   - fal-ai/bria/background/remove → remove fundo do produto
//
// Auth: FAL_KEY no env. Pegar em https://fal.ai/dashboard/keys
//
// IMPORTANTE: @fal-ai/client é ESM. Carregamos via dynamic import.
// =====================================================================

let _fal = null;
async function getFal() {
  if (_fal) return _fal;
  const mod = await import('@fal-ai/client');
  const client = mod.fal;
  if (!process.env.FAL_KEY) {
    throw new Error('FAL_KEY não configurada no .env');
  }
  client.config({ credentials: process.env.FAL_KEY });
  _fal = client;
  return _fal;
}

// Custos estimados por chamada (USD) — atualizar conforme fal.ai mudar tabela
const COSTS = {
  'fal-ai/flux-pro/kontext/max': 0.04,
  'fal-ai/flux-pro/v1.1': 0.04,
  'fal-ai/kling-video/v2.1/standard/image-to-video': 0.10,
  'fal-ai/minimax/hailuo-02/pro/image-to-video': 0.50,
  'fal-ai/veo3.1/image-to-video': 0.40,
  'fal-ai/elevenlabs/tts/multilingual-v2': 0.10,
  'fal-ai/bria/background/remove': 0.01,
};

// Helper genérico com retry exponencial (3 tentativas)
async function withRetry(fn, opName, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const t0 = Date.now();
      const result = await fn();
      console.log(`[falAi] ${opName} OK em ${((Date.now()-t0)/1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.warn(`[falAi] ${opName} falhou tentativa ${attempt}/${maxAttempts}: ${err.message}. Aguardando ${wait}ms`);
      if (attempt < maxAttempts) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

const { buildEditorialPrompt, getReferenceImages } = require('./marketingPrompts');

/**
 * Gera foto editorial profissional do produto.
 * Usa Flux Pro Kontext Max com imagem de referência (produto do catálogo).
 * Flux Kontext Max aceita apenas 1 imagem de ref, então usa a 1ª.
 *
 * @param {object} opts
 *   - product: objeto Product completo (preferido — usa aiContext, imageUrls)
 *   - OU productName, brand, imageUrl (compat antiga)
 *   - aspectRatio, sceneHint
 * @returns {Promise<{outputUrl, model, prompt, costUsd}>}
 */
async function generateEditorialPhoto(opts) {
  const fal = await getFal();
  const model = 'fal-ai/flux-pro/kontext/max';

  // Compat: aceita assinatura antiga
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

  const prompt = await buildEditorialPrompt(product, sceneHint, { aspectRatio });
  const refs = getReferenceImages(product, 1); // Kontext Max só aceita 1
  const imageUrl = refs[0];
  if (!imageUrl) throw new Error('produto sem imagem de referência');

  const productName = product.name || 'product';

  const result = await withRetry(
    () => fal.subscribe(model, {
      input: {
        prompt,
        image_url: imageUrl,
        aspect_ratio: aspectRatio,
        guidance_scale: 3.5,
        num_inference_steps: 28,
        output_format: 'jpeg',
        safety_tolerance: '2',
      },
      logs: false,
    }),
    `editorialPhoto ${productName.slice(0,40)}`
  );

  const outputUrl = result?.data?.images?.[0]?.url;
  if (!outputUrl) throw new Error('flux-pro retornou sem image url');

  return { outputUrl, model, prompt, costUsd: COSTS[model] };
}

/**
 * Gera vídeo de 5s vertical (9:16) animando uma imagem (Reels/TikTok).
 * @param {object} opts { imageUrl, productName, duration }
 */
async function generateReelVideo({ imageUrl, productName, duration = 6 }) {
  const fal = await getFal();
  // Minimax Hailuo 02 Pro: melhor custo/benefício em UGC realista pra produto
  // Validado vs Veo3 Full ($3), Wan 2.5, Seedance, Luma — Hailuo Pro entregou
  // qualidade cinematográfica mantendo fidelidade do produto, ao preço de $0.50
  const model = 'fal-ai/minimax/hailuo-02/pro/image-to-video';

  const prompt = `Cinematic slow camera movement around the ${productName} product, dynamic lighting reveal, premium sports brand commercial style, smooth motion, soft warm pastel background morphing into lifestyle scene, golden hour light, hyperrealistic`;

  const result = await withRetry(
    () => fal.subscribe(model, {
      input: {
        prompt,
        image_url: imageUrl,
        duration: Math.max(6, Math.min(10, duration)), // Hailuo aceita 6 ou 10
        prompt_optimizer: true,
      },
      logs: false,
    }),
    `reelVideo ${productName.slice(0,40)}`
  );

  const outputUrl = result?.data?.video?.url;
  if (!outputUrl) throw new Error('hailuo retornou sem video url');

  return { outputUrl, model, prompt, costUsd: COSTS[model] };
}

/**
 * Vídeo TOP (Google Veo 3.1 image-to-video) com ÁUDIO NATIVO — cena realista pra Reels.
 * $0.40/seg @720p/1080p com áudio. @param {object} opts { imageUrl, prompt, duration, aspectRatio, resolution }
 */
async function generateVeoVideo({ imageUrl, prompt, duration = '8s', aspectRatio = '9:16', resolution = '1080p' }) {
  const fal = await getFal();
  const model = 'fal-ai/veo3.1/image-to-video';
  const dur = ['4s', '6s', '8s'].includes(String(duration)) ? String(duration) : '8s';
  const result = await withRetry(
    () => fal.subscribe(model, {
      input: { prompt, image_url: imageUrl, aspect_ratio: aspectRatio, duration: dur, generate_audio: true, resolution },
      logs: false,
    }),
    `veoVideo`,
    2,
  );
  const outputUrl = result?.data?.video?.url;
  if (!outputUrl) throw new Error('veo retornou sem video url');
  const sec = parseInt(dur, 10) || 8;
  return { outputUrl, model, prompt, costUsd: +(COSTS[model] * sec).toFixed(2) };
}

// Veo demora 2-4min @1080p -> NAO cabe num request sincrono atras do Cloudflare (524 em 100s).
// Modo FILA: submit devolve requestId na hora; poll busca o resultado quando pronto.
const VEO_MODEL = 'fal-ai/veo3.1/image-to-video';
async function submitVeoVideo({ imageUrl, prompt, duration = '8s', aspectRatio = '9:16', resolution = '1080p' }) {
  const fal = await getFal();
  const dur = ['4s', '6s', '8s'].includes(String(duration)) ? String(duration) : '8s';
  const submitted = await withRetry(
    () => fal.queue.submit(VEO_MODEL, {
      input: { prompt, image_url: imageUrl, aspect_ratio: aspectRatio, duration: dur, generate_audio: true, resolution },
    }),
    'veoSubmit', 2,
  );
  const requestId = submitted?.request_id || submitted?.requestId;
  if (!requestId) throw new Error('veo submit sem request_id');
  const sec = parseInt(dur, 10) || 8;
  return { requestId, model: VEO_MODEL, costUsd: +(COSTS[VEO_MODEL] * sec).toFixed(2) };
}
async function pollVeoVideo({ requestId }) {
  const fal = await getFal();
  const st = await fal.queue.status(VEO_MODEL, { requestId, logs: false });
  const status = st?.status || 'UNKNOWN';
  if (status !== 'COMPLETED') return { status };
  const result = await fal.queue.result(VEO_MODEL, { requestId });
  const outputUrl = result?.data?.video?.url || null;
  return { status, outputUrl };
}

/**
 * Remove fundo de uma foto de produto (Bria RMBG 2.0).
 * @param {object} opts { imageUrl }
 */
async function removeBackground({ imageUrl }) {
  const fal = await getFal();
  const model = 'fal-ai/bria/background/remove';

  const result = await withRetry(
    () => fal.subscribe(model, { input: { image_url: imageUrl }, logs: false }),
    `removeBg`
  );

  const outputUrl = result?.data?.image?.url;
  if (!outputUrl) throw new Error('bria-rmbg retornou sem image url');

  return { outputUrl, model, prompt: null, costUsd: COSTS[model] };
}

/**
 * EDITOR FIEL — Nano-Banana (Gemini 2.5 Flash Image) edit.
 * Pega a FOTO REAL do produto (referência) e compõe numa cena com PESSOA
 * usando o produto, mantendo o produto IDÊNTICO e no TAMANHO CERTO.
 * Resolve o problema do Flux/concept que inventa/deforma/aumenta o produto.
 *
 * @param {object} opts
 *   - product (preferido) OU productName/imageUrl/imageUrls
 *   - scene: descrição da cena/estado (ex "ESTADO DE FOCO: vestiário...")
 *   - aspectRatio (default 9:16)
 * @returns {Promise<{outputUrl, model, prompt, costUsd}>}
 */
async function generateWornScene(opts) {
  const fal = await getFal();
  const model = 'fal-ai/nano-banana/edit';

  let product = opts.product;
  if (!product) product = { name: opts.productName, imageUrl: opts.imageUrl, imageUrls: opts.imageUrls };
  const refs = getReferenceImages(product, 3);
  if (!refs.length) throw new Error('produto sem imagem de referência');

  const ar = opts.aspectRatio || '9:16';
  const scene = (opts.scene && opts.scene.trim()) || 'a young Brazilian athlete wearing the sneakers in a real lifestyle moment, cinematic light';
  const prompt = (opts.fullPrompt && opts.fullPrompt.trim()) ? opts.fullPrompt : [
    `Photorealistic vertical ${ar} editorial photograph for a premium sportswear brand.`,
    `SCENE: ${scene}.`,
    'The person is WEARING the exact sneakers shown in the reference image (on the feet, being used).',
    'CRITICAL: keep the sneakers ABSOLUTELY IDENTICAL to the reference — same model, same colors, same materials, same logos and details.',
    'The sneakers must be at REALISTIC, CORRECT human foot scale — natural proportion to the foot and body. DO NOT enlarge or oversize the shoes.',
    'Natural realistic Brazilian person, authentic pose for the scene, dramatic professional lighting, shallow depth of field, magazine quality.',
    'No text, no captions, no extra fake logos.',
  ].join(' ');

  const result = await withRetry(
    () => fal.subscribe(model, {
      input: { prompt, image_urls: refs.slice(0, 3), num_images: 1, output_format: 'jpeg', aspect_ratio: ar },
      logs: false,
    }),
    `wornScene ${(product.name || '').slice(0, 40)}`
  );

  const outputUrl = result?.data?.images?.[0]?.url;
  if (!outputUrl) throw new Error('nano-banana edit retornou sem image url');
  return { outputUrl, model, prompt, costUsd: 0.039 };
}

/**
 * Heurística pra escolher cenário editorial baseado em categoria/marca.
 * Pode evoluir pra usar AI ou regras manuais.
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

/**
 * Gera MÚSICA instrumental via fal (stable-audio) a partir de um prompt de mood.
 * @param {object} opts { prompt, seconds }
 */
async function generateMusic({ prompt, seconds = 12 }) {
  const fal = await getFal();
  const model = 'fal-ai/stable-audio';
  const result = await withRetry(
    () => fal.subscribe(model, { input: { prompt, seconds_total: Math.max(8, Math.min(40, seconds)), steps: 100 }, logs: false }),
    `music ${String(prompt).slice(0, 40)}`
  );
  const url = result?.data?.audio_file?.url || result?.data?.audio?.url || result?.data?.url;
  if (!url) throw new Error('stable-audio sem url');
  return { outputUrl: url, model };
}

/**
 * VOZ DA MARCA (locucao) — ElevenLabs Multilingual v2 via fal. A melhor TTS p/ pt-BR.
 * Le o roteiro que a gente escreve. NUNCA inventa: o texto vem pronto de fonte real.
 * @param {object} opts { text, voice, languageCode, stability, similarityBoost, style, speed }
 */
async function generateVoice({ text, voice = 'Rachel', languageCode = 'pt', stability = 0.45, similarityBoost = 0.8, style = 0.3, speed = 0.95 }) {
  const fal = await getFal();
  const model = 'fal-ai/elevenlabs/tts/multilingual-v2';
  if (!text || !String(text).trim()) throw new Error('tts sem texto');
  const result = await withRetry(
    () => fal.subscribe(model, {
      input: {
        text: String(text),
        voice,
        language_code: languageCode,
        stability,
        similarity_boost: similarityBoost,
        style,
        speed: Math.max(0.7, Math.min(1.2, speed)),
      },
      logs: false,
    }),
    `voice ${voice}`,
    2,
  );
  const outputUrl = result?.data?.audio?.url;
  if (!outputUrl) throw new Error('elevenlabs tts retornou sem audio url');
  return { outputUrl, model, voice, costUsd: COSTS[model] };
}

module.exports = {
  generateEditorialPhoto,
  generateWornScene,
  generateReelVideo,
  generateVeoVideo,
  submitVeoVideo,
  pollVeoVideo,
  removeBackground,
  generateMusic,
  generateVoice,
  COSTS,
};
