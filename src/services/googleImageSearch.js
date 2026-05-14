// =====================================================================
// Google Custom Search API — busca imagens de produtos
// =====================================================================
// Requer env vars: GOOGLE_API_KEY e GOOGLE_CSE_ID
// Custo: 100 buscas/dia grátis. Acima disso: US$ 5 / 1000 buscas (max 10k/dia).
// =====================================================================

const API_KEY = process.env.GOOGLE_API_KEY;
const CSE_ID = process.env.GOOGLE_CSE_ID;
const ENDPOINT = 'https://customsearch.googleapis.com/customsearch/v1';

function isConfigured() {
  return !!(API_KEY && CSE_ID);
}

/**
 * searchImages — busca imagens de produto.
 *
 * @param {string} query - texto da busca ex: "Converse Chuck Taylor All Star Branco"
 * @param {Object} opts - { count: 5, safe: 'active' | 'off', imgSize: 'large' | 'medium' }
 * @returns {Promise<{ok, items, error}>}
 */
function sanitizeQuery(q) {
  // Remove caracteres que podem quebrar Google search (mas preserva aspas pra match exato)
  return String(q || '')
    .replace(/[\/\\]/g, ' ')        // barras viram espaço
    .replace(/[^\w\sÀ-ÿ\-"]/g, ' ') // letras, números, acentos, hífen, aspas
    .replace(/\s+/g, ' ')            // colapsa espaços
    .trim()
    .slice(0, 100);                  // limite 100 chars
}

async function searchImages(query, opts = {}) {
  if (!isConfigured()) {
    return { ok: false, items: [], error: 'GOOGLE_API_KEY ou GOOGLE_CSE_ID não configuradas' };
  }
  const cleanQ = sanitizeQuery(query);
  if (!cleanQ) {
    return { ok: false, items: [], error: 'query é obrigatória ou ficou vazia após sanitização' };
  }

  const params = new URLSearchParams({
    key: API_KEY,
    cx: CSE_ID,
    q: cleanQ,
    searchType: 'image',
    num: String(Math.min(Math.max(opts.count || 5, 1), 10)),
    safe: opts.safe || 'active',
  });
  // imgSize é opcional, se aceita: huge, icon, large, medium, small, xlarge, xxlarge
  if (opts.imgSize && ['huge','icon','large','medium','small','xlarge','xxlarge'].includes(opts.imgSize)) {
    params.set('imgSize', opts.imgSize);
  }

  try {
    const url = `${ENDPOINT}?${params.toString()}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      return {
        ok: false,
        items: [],
        query: cleanQ,
        error: `[Google ${res.status}] ${data.error?.message || JSON.stringify(data).slice(0, 200)}`,
        detail: data.error?.errors || null,
      };
    }
    const items = (data.items || []).map((it) => ({
      url: it.link,
      thumbnailUrl: it.image?.thumbnailLink || it.link,
      width: it.image?.width || null,
      height: it.image?.height || null,
      source: it.displayLink || null,
      title: it.title || null,
      mimeType: it.mime || 'image/jpeg',
    }));
    return { ok: true, items, totalResults: data.searchInformation?.totalResults || items.length };
  } catch (err) {
    return { ok: false, items: [], error: err.message };
  }
}

/**
 * buildProductQuery — monta query inteligente pra busca de produto.
 *
 * @param {Object} product - { brand, model, color, name }
 * @returns {string}
 */
function buildProductQuery(product) {
  // Quando temos a ref do fornecedor (cProd), usa query enxuta com ref entre aspas
  if (product.supplierRef) {
    const parts = [];
    if (product.brand) parts.push(product.brand);
    parts.push(`"${product.supplierRef}"`);
    if (product.color) parts.push(product.color);
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
