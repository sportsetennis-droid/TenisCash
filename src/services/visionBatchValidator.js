// =====================================================================
// Vision Batch Validator — usa Anthropic Messages Batch API (50% desconto)
// pra pontuar MUITAS imagens de uma só vez. Indicado pra cure em massa.
// =====================================================================
// Trade-off: assincrono. Submetem N requests, espera ~5-30 min, baixa resultados.
// Custo: 50% do preço normal. Pra 6700 produtos × 8 imgs = ~R$ 10 (vs R$ 20).
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_VISION_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

const CACHED_SYSTEM = `Você é um validador de qualidade de imagens de produto pra e-commerce esportivo.

Critérios: mostra produto inteiro em fundo limpo, cor bate com declarada, não é banner/logo/screenshot.

Responda APENAS este JSON:
{"score":<0-10>,"is_correct_product":<true|false>,"color_matches":<true|false>,"reason":"<frase curta>"}

Score: 10 produto+cor exatos / 8-9 cor levemente off / 5-7 variação errada / 1-4 errado/ruim / 0 não-produto`;

/**
 * Submete um batch de avaliações. Retorna { batchId, requestCount }.
 *
 * @param {Array<{customId, imageUrl, product}>} items
 *   - customId: identificador único pra retomar resultado depois
 *   - product: { name, brand, color, category }
 */
async function submitBatch(items) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  if (!items?.length) return { ok: false, error: 'items vazio' };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const requests = items.map(({ customId, imageUrl, product }) => ({
    custom_id: String(customId),
    params: {
      model: MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: CACHED_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            {
              type: 'text',
              text: `Produto: ${product.name || ''}\nMarca: ${product.brand || ''}\nCor: ${product.color || ''}\nCategoria: ${product.category || ''}\n\nAnalise e devolva o JSON.`,
            },
          ],
        },
      ],
    },
  }));

  try {
    const batch = await client.messages.batches.create({ requests });
    return { ok: true, batchId: batch.id, requestCount: items.length, status: batch.processing_status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Consulta status de um batch.
 * @param {string} batchId
 */
async function getBatchStatus(batchId) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const batch = await client.messages.batches.retrieve(batchId);
    return {
      ok: true,
      id: batch.id,
      status: batch.processing_status,
      requestCounts: batch.request_counts,
      createdAt: batch.created_at,
      endedAt: batch.ended_at,
      resultsUrl: batch.results_url,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Baixa os resultados de um batch finalizado. Devolve array de { customId, score, ... }.
 */
async function fetchBatchResults(batchId) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const stream = await client.messages.batches.results(batchId);
    const results = [];
    for await (const r of stream) {
      const customId = r.custom_id;
      if (r.result?.type === 'succeeded') {
        const text = (r.result.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        let json = null;
        try { json = JSON.parse(text); }
        catch (_) {
          const first = text.indexOf('{'), last = text.lastIndexOf('}');
          if (first !== -1 && last > first) try { json = JSON.parse(text.slice(first, last + 1)); } catch (_) {}
        }
        results.push({
          customId,
          ok: true,
          score: Number(json?.score) || 0,
          isCorrectProduct: !!json?.is_correct_product,
          colorMatches: !!json?.color_matches,
          reason: json?.reason || '',
          usage: r.result.message?.usage,
        });
      } else {
        results.push({ customId, ok: false, error: r.result?.error?.message || 'failed' });
      }
    }
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function cancelBatch(batchId) {
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  try {
    const r = await client.messages.batches.cancel(batchId);
    return { ok: true, status: r.processing_status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { isConfigured, submitBatch, getBatchStatus, fetchBatchResults, cancelBatch };
