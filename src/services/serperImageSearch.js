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

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: cleanQ,
        gl: 'br',
        hl: 'pt-br',
        num: Math.min(Math.max(opts.count || 10, 1), 100),
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      return {
        ok: false,
        items: [],
        query: cleanQ,
        error: `[Serper ${res.status}] ${data.error || data.message || JSON.stringify(data).slice(0, 200)}`,
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
  // Com Serper (Google), a ref entre aspas pega o produto exato.
  if (product.supplierRef) {
    const parts = [];
    if (product.brand) parts.push(product.brand);
    parts.push(`"${product.supplierRef}"`);
    return parts.join(' ').trim();
  }

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
