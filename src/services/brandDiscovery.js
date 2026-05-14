// =====================================================================
// Brand Discovery — descobre o site oficial de uma marca via Claude.
// Resultado fica em cache na memória pra não pagar IA várias vezes
// pela mesma marca.
// =====================================================================

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_BRAND_DISCOVERY_MODEL || process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const cache = new Map(); // brandKey → { site, confidence, brand_canonical }

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function _key(brand, category) {
  return `${String(brand || '').toLowerCase().trim()}|${String(category || '').toLowerCase().trim()}`;
}

/**
 * Descobre o site oficial da marca e o nome canônico.
 *
 * @param {string} brand
 * @param {string} category  (opcional) - calçado, moda fitness, lingerie...
 * @returns {Promise<{ok, site, brandCanonical, confidence, source, cost}>}
 */
async function discoverBrandSite(brand, category) {
  const cleanBrand = String(brand || '').trim();
  if (!cleanBrand) return { ok: false, error: 'marca vazia' };
  if (!isConfigured()) return { ok: false, error: 'ANTHROPIC_API_KEY não configurada' };

  const k = _key(cleanBrand, category);
  if (cache.has(k)) {
    return { ...cache.get(k), source: 'cache' };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `Você é um especialista em e-commerce e marcas brasileiras. Dado o nome de uma marca, retorna o domínio oficial da loja online dela (sem https, sem www). Se não souber com certeza, retorna null no campo site.`;

  const userPrompt = `Marca: "${cleanBrand}"
Categoria do produto: "${category || 'não especificada'}"

Responda APENAS com este JSON, nada mais:
{
  "brand_canonical": "<nome correto da marca em PT-BR ou EN como escrito oficialmente>",
  "site": "<dominio.com.br ou null>",
  "confidence": <0-10>,
  "reasoning": "<frase curta justificando>"
}

Exemplos:
- "Converse" → {"brand_canonical":"Converse","site":"converse.com.br","confidence":10,"reasoning":"site oficial Brasil"}
- "Lets Gym" ou "Lu Martins" → {"brand_canonical":"Lets Gym","site":"letsgym.com.br","confidence":10}
- "Caju Brasil" ou "TOP CONFECÇÕES" (vest. fitness) → {"brand_canonical":"Caju Brasil","site":"cajubrasil.com.br","confidence":9}
- "Marca Inventada XYZ" → {"brand_canonical":"Marca Inventada XYZ","site":null,"confidence":1}`;

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    let json = null;
    try { json = JSON.parse(text); }
    catch (_) {
      const first = text.indexOf('{'), last = text.lastIndexOf('}');
      if (first !== -1 && last > first) try { json = JSON.parse(text.slice(first, last + 1)); } catch (_) {}
    }
    if (!json) return { ok: false, error: 'falha ao parsear resposta', raw: text };

    const site = (json.site || '').toString().toLowerCase().trim()
      .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    const result = {
      ok: true,
      site: site && /^[a-z0-9.\-]+\.[a-z]{2,}$/.test(site) ? site : null,
      brandCanonical: json.brand_canonical || cleanBrand,
      confidence: Number(json.confidence) || 0,
      reasoning: json.reasoning || '',
      cost: {
        inT: resp.usage?.input_tokens || 0,
        outT: resp.usage?.output_tokens || 0,
        brl: ((resp.usage?.input_tokens || 0) / 1e6 * 1 + (resp.usage?.output_tokens || 0) / 1e6 * 5) * 5.5,
      },
    };
    cache.set(k, result);
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { isConfigured, discoverBrandSite, clearCache };
