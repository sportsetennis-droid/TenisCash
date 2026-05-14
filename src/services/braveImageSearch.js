// =====================================================================
// Brave Search API — busca imagens de produtos
// =====================================================================
// Requer env var: BRAVE_API_KEY
// Doc: https://api-dashboard.search.brave.com/app/documentation/image-search/get-started
// Custo: $5 grátis/mês (= 1000 buscas), depois $5/1000 buscas
// =====================================================================

const API_KEY = process.env.BRAVE_API_KEY;
const ENDPOINT = 'https://api.search.brave.com/res/v1/images/search';

function isConfigured() {
  return !!API_KEY;
}

function sanitizeQuery(q) {
  return String(q || '')
    .replace(/[\/\\]/g, ' ')
    .replace(/[^\w\sÀ-ÿ\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * searchImages — busca imagens via Brave.
 *
 * @param {string} query
 * @param {Object} opts - { count: 5, safesearch: 'strict'|'off' }
 * @returns {Promise<{ok, items, error}>}
 */
async function searchImages(query, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, items: [], error: 'BRAVE_API_KEY não configurada' };
  }
  const cleanQ = sanitizeQuery(query);
  if (!cleanQ) {
    return { ok: false, items: [], error: 'query vazia após sanitização' };
  }

  const params = new URLSearchParams({
    q: cleanQ,
    count: String(Math.min(Math.max(opts.count || 5, 1), 50)),
    safesearch: opts.safesearch || 'strict',
    country: opts.country || 'BR',
    search_lang: opts.search_lang || 'pt-br',
  });

  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': API_KEY,
      },
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      return {
        ok: false,
        items: [],
        query: cleanQ,
        error: `[Brave ${res.status}] ${data.error?.detail || data.message || JSON.stringify(data).slice(0, 200)}`,
        detail: data.error || null,
      };
    }

    const results = data.results || [];
    const items = results.map((r) => ({
      url: r.properties?.url || r.url,            // URL direta da imagem
      thumbnailUrl: r.thumbnail?.src || r.url,
      width: r.properties?.width || null,
      height: r.properties?.height || null,
      source: r.source || (r.meta_url?.hostname) || null,
      title: r.title || null,
      pageUrl: r.url || null,                      // URL da página de origem
      mimeType: 'image/jpeg',
    }));
    return { ok: true, items, query: cleanQ, totalResults: items.length };
  } catch (err) {
    return { ok: false, items: [], error: err.message };
  }
}

function buildProductQuery(product) {
  const parts = [];
  if (product.brand) parts.push(product.brand);
  if (product.model) parts.push(product.model);
  if (product.color) parts.push(product.color);
  if (!parts.length && product.name) parts.push(product.name);
  if (product.category && /tenis|sapato|calc/i.test(product.category)) {
    if (!parts.join(' ').toLowerCase().includes('tenis')) parts.push('tênis');
  }
  return parts.join(' ').trim();
}

module.exports = { isConfigured, searchImages, buildProductQuery };
