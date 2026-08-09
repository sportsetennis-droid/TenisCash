// =====================================================================
// Vision Validator — usa Claude (vision) pra dar nota a uma imagem
// candidata contra os atributos do produto (nome, marca, cor, categoria).
// =====================================================================
// Usado pelo curationAgent pra escolher a melhor imagem dentre N candidatas.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || process.env.CAMERA_SECURITY_OPENAI_MODEL || 'gpt-5.6-luna';
const GROQ_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const GEMINI_MODEL = process.env.GEMINI_VISION_MODEL || 'gemini-3.6-flash';
let anthropicUnavailableUntil = 0;
let openaiUnavailableUntil = 0;
let groqUnavailableUntil = 0;
let geminiUnavailableUntil = 0;
const lastProviderErrors = {};

let la = null;
try { la = require('./locateAnything'); } catch (_) {}

function isConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY || process.env.GOOGLE_API_KEY);
}

function providerStatus() {
  return {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    openai: !!process.env.OPENAI_API_KEY,
    groq: !!process.env.GROQ_API_KEY,
    gemini: !!process.env.GOOGLE_API_KEY,
    anthropicCoolingDown: Date.now() < anthropicUnavailableUntil,
    openaiCoolingDown: Date.now() < openaiUnavailableUntil,
    groqCoolingDown: Date.now() < groqUnavailableUntil,
    geminiCoolingDown: Date.now() < geminiUnavailableUntil,
    lastErrors: { ...lastProviderErrors },
  };
}

/**
 * Pontua uma imagem candidata pra um produto.
 *
 * @param {string} imageUrl - URL pública da imagem
 * @param {Object} product - { name, brand, color, category }
 * @returns {Promise<{ok, score, isCorrectProduct, colorMatches, reason, cost}>}
 *   - score: 0-10. 0 = totalmente errado. 10 = produto e cor exatos.
 *   - isCorrectProduct: true/false
 *   - colorMatches: true/false
 */
// Sistema cacheável (não muda entre chamadas) — economia ~80-90% em tokens repetidos
const CACHED_SYSTEM = `Você é um validador de qualidade de imagens de produto pra e-commerce esportivo.

Sua função: ANALISA UMA imagem e julga se ela é apropriada como FOTO PRINCIPAL.

Critérios pra ser FOTO PRINCIPAL boa:
- Mostra o produto inteiro, em fundo limpo (preferência branco) ou foto de catálogo
- A cor predominante da imagem bate com a cor declarada
- Não é banner de loja, não é logo, não é screenshot, não é stock genérico
- Não tem múltiplos produtos misturados

Responda APENAS com este JSON (sem mais texto):
{
  "score": <0 a 10>,
  "is_correct_product": <true|false>,
  "color_matches": <true|false>,
  "reason": "<frase curta em PT-BR explicando o score>"
}

Escala de score:
- 10: produto exato + cor exata + foto de catálogo limpa
- 8-9: produto exato, cor levemente off (ex: marinho/azul escuro)
- 5-7: mesmo modelo mas variação de cor errada
- 1-4: produto similar mas errado, ou foto ruim
- 0: não é o produto / banner / logo / genérico`;

/**
 * Verifica se um produto existe na imagem (pré-filtro barato antes do score completo).
 * Retorna false se a imagem não contiver o produto (ex: banner, logo, produto errado).
 */
async function productExistsInImage(imageUrl, product) {
  if (!la || !imageUrl) return true; // sem LocateAnything, deixa passar pro score completo
  const query = `${product.brand || ''} ${product.category || 'shoe'} product`.trim();
  return la.exists(imageUrl, query);
}

/**
 * Encontra o bounding box do produto na imagem.
 * Útil pra recortar antes de análises mais pesadas.
 */
async function locateProductInImage(imageUrl, product) {
  if (!la || !imageUrl) return null;
  const query = `${product.brand || ''} ${product.category || 'shoe'}`.trim();
  return la.locate(imageUrl, query);
}

function productPrompt(product) {
  return `Produto: ${product.name || '(sem nome)'}
Marca: ${product.brand || '(sem marca)'}
Cor declarada: ${product.color || '(qualquer)'}
Categoria: ${product.category || '(qualquer)'}

Analise a imagem acima e devolva o JSON.`;
}

async function scoreImageMatchOpenAI(imageUrl, product) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, error: 'OPENAI_API_KEY nao configurada' };
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: CACHED_SYSTEM,
        input: [{
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageUrl, detail: 'low' },
            { type: 'input_text', text: productPrompt(product) },
          ],
        }],
        max_output_tokens: 300,
        text: {
          format: {
            type: 'json_schema',
            name: 'product_image_validation',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                score: { type: 'number', minimum: 0, maximum: 10 },
                is_correct_product: { type: 'boolean' },
                color_matches: { type: 'boolean' },
                reason: { type: 'string' },
              },
              required: ['score', 'is_correct_product', 'color_matches', 'reason'],
            },
          },
          verbosity: 'low',
        },
        store: false,
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 500);
      try { detail = JSON.parse(raw)?.error?.message || detail; } catch (_) {}
      return { ok: false, error: `OpenAI ${response.status}: ${detail}` };
    }
    const payload = JSON.parse(raw);
    const text = typeof payload.output_text === 'string'
      ? payload.output_text
      : (payload.output || [])
        .flatMap((item) => item?.content || [])
        .map((item) => item?.text || item?.output_text || '')
        .filter(Boolean)
        .join('\n');
    const json = JSON.parse(text);
    const inputTokens = payload.usage?.input_tokens || 0;
    const outputTokens = payload.usage?.output_tokens || 0;
    const inputPrice = Number(process.env.OPENAI_VISION_PRICE_INPUT_PER_1M || process.env.AI_PRICE_INPUT_PER_1M || 1);
    const outputPrice = Number(process.env.OPENAI_VISION_PRICE_OUTPUT_PER_1M || process.env.AI_PRICE_OUTPUT_PER_1M || 5);
    const brl = Number(process.env.BRL_PER_USD || 5.5);
    const usd = (inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice;
    return {
      ok: true,
      provider: 'openai',
      score: Number(json.score) || 0,
      isCorrectProduct: json.is_correct_product === true,
      colorMatches: json.color_matches === true,
      reason: String(json.reason || ''),
      cost: { usd, brl: usd * brl, inT: inputTokens, outT: outputTokens },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function scoreImageMatchGroq(imageUrl, product) {
  if (!process.env.GROQ_API_KEY) return { ok: false, error: 'GROQ_API_KEY nao configurada' };
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: CACHED_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: productPrompt(product) },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_completion_tokens: 300,
        stream: false,
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 500);
      try { detail = JSON.parse(raw)?.error?.message || detail; } catch (_) {}
      return { ok: false, error: `Groq ${response.status}: ${detail}` };
    }
    const payload = JSON.parse(raw);
    const text = String(payload.choices?.[0]?.message?.content || '').trim();
    let json = null;
    try { json = JSON.parse(text); }
    catch (_) {
      const first = text.indexOf('{');
      const last = text.lastIndexOf('}');
      if (first >= 0 && last > first) json = JSON.parse(text.slice(first, last + 1));
    }
    if (!json) return { ok: false, error: 'Groq nao devolveu JSON valido' };
    const inputTokens = payload.usage?.prompt_tokens || 0;
    const outputTokens = payload.usage?.completion_tokens || 0;
    const inputPrice = Number(process.env.GROQ_VISION_PRICE_INPUT_PER_1M || 0);
    const outputPrice = Number(process.env.GROQ_VISION_PRICE_OUTPUT_PER_1M || 0);
    const brl = Number(process.env.BRL_PER_USD || 5.5);
    const usd = (inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice;
    return {
      ok: true,
      provider: 'groq',
      score: Number(json.score) || 0,
      isCorrectProduct: json.is_correct_product === true,
      colorMatches: json.color_matches === true,
      reason: String(json.reason || ''),
      cost: { usd, brl: usd * brl, inT: inputTokens, outT: outputTokens },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function scoreImageMatchGemini(imageUrl, product) {
  if (!process.env.GOOGLE_API_KEY) return { ok: false, error: 'GOOGLE_API_KEY nao configurada' };
  try {
    // Gemini's REST image input uses inline bytes. Download only bounded image
    // responses and never forward HTML/error bodies as visual evidence.
    const imageResponse = await fetch(imageUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0 TenisCashImageReview/1.0', Accept: 'image/*' },
    });
    if (!imageResponse.ok) return { ok: false, error: `Gemini image download ${imageResponse.status}` };
    const mimeType = String(imageResponse.headers.get('content-type') || '').split(';')[0].toLowerCase();
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(mimeType)) {
      return { ok: false, error: `Gemini image type unsupported: ${mimeType || 'unknown'}` };
    }
    const contentLength = Number(imageResponse.headers.get('content-length') || 0);
    if (contentLength > 15 * 1024 * 1024) return { ok: false, error: 'Gemini image exceeds 15MB' };
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    if (!imageBuffer.length || imageBuffer.length > 15 * 1024 * 1024) {
      return { ok: false, error: 'Gemini image is empty or exceeds 15MB' };
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GOOGLE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: CACHED_SYSTEM }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType, data: imageBuffer.toString('base64') } },
            { text: productPrompt(product) },
          ],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 300,
          responseMimeType: 'application/json',
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      let detail = raw.slice(0, 500);
      try { detail = JSON.parse(raw)?.error?.message || detail; } catch (_) {}
      return { ok: false, error: `Gemini ${response.status}: ${detail}` };
    }
    const payload = JSON.parse(raw);
    const text = (payload.candidates?.[0]?.content?.parts || []).map((part) => part?.text || '').join('\n').trim();
    const json = JSON.parse(text);
    const inputTokens = payload.usageMetadata?.promptTokenCount || 0;
    const outputTokens = payload.usageMetadata?.candidatesTokenCount || 0;
    const inputPrice = Number(process.env.GEMINI_VISION_PRICE_INPUT_PER_1M || 0);
    const outputPrice = Number(process.env.GEMINI_VISION_PRICE_OUTPUT_PER_1M || 0);
    const brl = Number(process.env.BRL_PER_USD || 5.5);
    const usd = (inputTokens / 1e6) * inputPrice + (outputTokens / 1e6) * outputPrice;
    return {
      ok: true,
      provider: 'gemini',
      score: Number(json.score) || 0,
      isCorrectProduct: json.is_correct_product === true,
      colorMatches: json.color_matches === true,
      reason: String(json.reason || ''),
      cost: { usd, brl: usd * brl, inT: inputTokens, outT: outputTokens },
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function providerBlocked(error) {
  return /credit balance|no credits|billing|insufficient|quota|rate limit|429/i.test(error || '');
}

async function scoreImageMatchFallback(imageUrl, product, priorErrors = []) {
  const errors = [...priorErrors];
  if (process.env.OPENAI_API_KEY && Date.now() >= openaiUnavailableUntil) {
    const openai = await scoreImageMatchOpenAI(imageUrl, product);
    if (openai.ok) {
      delete lastProviderErrors.openai;
      return openai;
    }
    lastProviderErrors.openai = String(openai.error || '').slice(0, 500);
    errors.push(openai.error);
    if (providerBlocked(openai.error)) openaiUnavailableUntil = Date.now() + 30 * 60 * 1000;
  }
  if (process.env.GROQ_API_KEY && Date.now() >= groqUnavailableUntil) {
    const groq = await scoreImageMatchGroq(imageUrl, product);
    if (groq.ok) {
      delete lastProviderErrors.groq;
      return groq;
    }
    lastProviderErrors.groq = String(groq.error || '').slice(0, 500);
    errors.push(groq.error);
    if (providerBlocked(groq.error)) groqUnavailableUntil = Date.now() + 30 * 60 * 1000;
  }
  if (process.env.GOOGLE_API_KEY && Date.now() >= geminiUnavailableUntil) {
    const gemini = await scoreImageMatchGemini(imageUrl, product);
    if (gemini.ok) {
      delete lastProviderErrors.gemini;
      return gemini;
    }
    lastProviderErrors.gemini = String(gemini.error || '').slice(0, 500);
    errors.push(gemini.error);
    if (providerBlocked(gemini.error) || /API key|permission|not found|not supported|403|404/i.test(gemini.error || '')) {
      geminiUnavailableUntil = Date.now() + 30 * 60 * 1000;
    }
  }
  return { ok: false, error: errors.filter(Boolean).join(' | ') || 'nenhum provedor visual disponivel' };
}

async function scoreImageMatch(imageUrl, product) {
  if (!isConfigured()) {
    return { ok: false, error: 'nenhum provedor visual configurado' };
  }
  if (!imageUrl) return { ok: false, error: 'imageUrl obrigatório' };

  if (!process.env.ANTHROPIC_API_KEY || Date.now() < anthropicUnavailableUntil) {
    return scoreImageMatchFallback(imageUrl, product);
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Só o trecho específico do produto vai variar — o resto é cacheado.
  const userPrompt = productPrompt(product);

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      // System prompt com cache_control: economiza 80-90% nas chamadas seguintes
      system: [
        { type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    });

    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    let json = null;
    try { json = JSON.parse(text); }
    catch (_) {
      const first = text.indexOf('{'), last = text.lastIndexOf('}');
      if (first !== -1 && last > first) {
        try { json = JSON.parse(text.slice(first, last + 1)); } catch (_) {}
      }
    }
    if (!json) return { ok: false, error: 'não foi possível extrair JSON', raw: text };

    // custo aproximado em R$
    const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
    const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
    const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
    const inT = resp.usage?.input_tokens || 0;
    const outT = resp.usage?.output_tokens || 0;
    const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;

    delete lastProviderErrors.anthropic;
    return {
      ok: true,
      provider: 'anthropic',
      score: Number(json.score) || 0,
      isCorrectProduct: !!json.is_correct_product,
      colorMatches: !!json.color_matches,
      reason: json.reason || '',
      cost: { usd, brl: usd * brl, inT, outT },
    };
  } catch (err) {
    lastProviderErrors.anthropic = String(err.message || '').slice(0, 500);
    if (/credit balance|billing|insufficient|quota/i.test(err.message || '')) {
      anthropicUnavailableUntil = Date.now() + 30 * 60 * 1000;
    }
    return scoreImageMatchFallback(imageUrl, product, [err.message]);
  }
}

/**
 * Escolhe a melhor imagem dentre candidatas, retornando o ranking ordenado.
 * Para na primeira que tirar score >= 9 (alta confiança) pra economizar custo.
 */
async function pickBestImage(candidates, product, opts = {}) {
  const earlyStopScore = opts.earlyStopScore ?? 9;
  const maxCalls = opts.maxCalls ?? candidates.length;
  const ranked = [];
  let totalCostBRL = 0;
  for (let i = 0; i < Math.min(candidates.length, maxCalls); i++) {
    const c = candidates[i];
    const url = c.url || c;
    const r = await scoreImageMatch(url, product);
    if (r.ok) {
      ranked.push({
        ...c,
        _score: r.score,
        _reason: r.reason,
        _colorMatches: r.colorMatches,
        _isCorrectProduct: r.isCorrectProduct,
        _provider: r.provider || null,
      });
      totalCostBRL += r.cost?.brl || 0;
      if (r.score >= earlyStopScore) break;
    } else {
      ranked.push({ ...c, _score: 0, _reason: 'falhou ao analisar: ' + r.error });
    }
  }
  ranked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return { ranked, totalCostBRL };
}

module.exports = { isConfigured, providerStatus, scoreImageMatch, pickBestImage, productExistsInImage, locateProductInImage };
