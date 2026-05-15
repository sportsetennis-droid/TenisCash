// =====================================================================
// Serper.dev — Google Images via API. Mesmo resultado da busca real do Google.
// =====================================================================
// Requer env var: SERPER_API_KEY (https://serper.dev — 2500 buscas/mes gratis)
// Doc: https://serper.dev/playground
// =====================================================================

const API_KEY = process.env.SERPER_API_KEY;
const ENDPOINT = 'https://google.serper.dev/images';

function isConfigured() {
  return !!API_KEY;
}

function sanitizeQuery(q) {
  return String(q || '')
    .replace(/[\/\\]/g, ' ')
    .replace(/[^\w\sÀ-ÿ\-".:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

async function searchImages(query, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, items: [], error: 'SERPER_API_KEY não configurada' };
  }
  const cleanQ = sanitizeQuery(query);
  if (!cleanQ) {
    return { ok: false, items: [], error: 'query vazia após sanitização' };
  }

  // Retry com backoff em caso de 429 (rate limit) ou 5xx
  let res, data, lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: cleanQ, gl: 'br', hl: 'pt-br',
          num: Math.min(Math.max(opts.count || 10, 1), 100),
        }),
      });
      data = await res.json();
      // Rate limit ou erro temporário → tenta de novo
      if (res.status === 429 || res.status >= 500) {
        lastErr = `[Serper ${res.status}] retry...`;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      break;
    } catch (err) {
      lastErr = err.message;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }

  try {
    if (!res) {
      return { ok: false, items: [], query: cleanQ, error: `Serper falhou após 3 tentativas: ${lastErr}` };
    }
    if (!res.ok || data?.error) {
      return {
        ok: false,
        items: [],
        query: cleanQ,
        error: `[Serper ${res.status}] ${data?.error || data?.message || JSON.stringify(data).slice(0, 200)}`,
      };
    }

    const items = (data.images || []).map((r) => ({
      url: r.imageUrl,
      thumbnailUrl: r.thumbnailUrl || r.imageUrl,
      width: r.imageWidth || null,
      height: r.imageHeight || null,
      source: r.source || (r.link ? new URL(r.link).hostname : null),
      title: r.title || null,
      pageUrl: r.link || null,
      mimeType: 'image/jpeg',
    }));
    return { ok: true, items, query: cleanQ, totalResults: items.length };
  } catch (err) {
    return { ok: false, items: [], error: err.message };
  }
}

function buildProductQuery(product) {
  // Constrói: marca + "ref"(quoted) + nome limpo + cor. Tudo junto.
  // Antes a ref sozinha era suficiente pra Converse (refs únicas de 10 dígitos),
  // mas pra refs curtas (ex Lets Gym "2611ST") precisa do nome pra desambiguar.
  const parts = [];
  if (product.brand) parts.push(product.brand);
  if (product.supplierRef) parts.push(`"${product.supplierRef}"`);

  // Nome do produto, limpo dos slashes e do prefixo "REF: XXXX -" (lixo NF-e)
  let cleanModel = product.model || product.name || '';
  cleanModel = cleanModel
    .replace(/^REF:\s*[A-Z0-9]+\s*-\s*/i, '')
    .replace(/\s*\/\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleanModel && !parts.join(' ').toLowerCase().includes(cleanModel.toLowerCase().slice(0, 15))) {
    parts.push(cleanModel);
  }

  if (product.color) parts.push(product.color);
  if (product.category && /tenis|sapato|calc/i.test(product.category)) {
    if (!parts.join(' ').toLowerCase().includes('tenis')) parts.push('tênis');
  }
  return parts.join(' ').trim();
}

module.exports = { isConfigured, searchImages, buildProductQuery };
