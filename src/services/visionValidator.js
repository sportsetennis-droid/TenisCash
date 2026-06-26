// =====================================================================
// Vision Validator — usa Claude (vision) pra dar nota a uma imagem
// candidata contra os atributos do produto (nome, marca, cor, categoria).
// =====================================================================
// Usado pelo curationAgent pra escolher a melhor imagem dentre N candidatas.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

let la = null;
try { la = require('./locateAnything'); } catch (_) {}

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
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

async function scoreImageMatch(imageUrl, product) {
  if (!isConfigured()) {
    return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  }
  if (!imageUrl) return { ok: false, error: 'imageUrl obrigatório' };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Só o trecho específico do produto vai variar — o resto é cacheado.
  const userPrompt = `Produto: ${product.name || '(sem nome)'}
Marca: ${product.brand || '(sem marca)'}
Cor declarada: ${product.color || '(qualquer)'}
Categoria: ${product.category || '(qualquer)'}

Analise a imagem acima e devolva o JSON.`;

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

    return {
      ok: true,
      score: Number(json.score) || 0,
      isCorrectProduct: !!json.is_correct_product,
      colorMatches: !!json.color_matches,
      reason: json.reason || '',
      cost: { usd, brl: usd * brl, inT, outT },
    };
  } catch (err) {
    return { ok: false, error: err.message };
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
      ranked.push({ ...c, _score: r.score, _reason: r.reason, _colorMatches: r.colorMatches });
      totalCostBRL += r.cost?.brl || 0;
      if (r.score >= earlyStopScore) break;
    } else {
      ranked.push({ ...c, _score: 0, _reason: 'falhou ao analisar: ' + r.error });
    }
  }
  ranked.sort((a, b) => (b._score || 0) - (a._score || 0));
  return { ranked, totalCostBRL };
}

module.exports = { isConfigured, scoreImageMatch, pickBestImage, productExistsInImage, locateProductInImage };
