// =====================================================================
// Product Page Scraper — extrai dados estruturados de uma página de produto:
//   - título (og:title, JSON-LD Product.name)
//   - descrição (og:description, meta description, JSON-LD Product.description)
//   - imagem principal (og:image)
//   - imagens adicionais (JSON-LD Product.image array)
//   - preço (JSON-LD Product.offers.price)
// =====================================================================

function decodeHtml(s) {
  if (!s) return null;
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent(html, attr, value) {
  // Pega <meta {attr}="{value}" content="..."> nas duas ordens (attr/content e content/attr)
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']+)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+${attr}=["']${value}["']`, 'i');
  return (html.match(re1) || html.match(re2) || [])[1] || null;
}

function pickJsonLdProducts(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const json = JSON.parse(m[1]);
      const list = Array.isArray(json) ? json : json['@graph'] ? json['@graph'] : [json];
      for (const item of list) {
        if (item && item['@type'] === 'Product') out.push(item);
      }
    } catch (_) { /* ignora JSON inválido */ }
  }
  return out;
}

async function scrapeProductPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ao buscar ${url}` };
    const html = await res.text();

    const ogTitle = metaContent(html, 'property', 'og:title');
    const ogDesc = metaContent(html, 'property', 'og:description');
    const ogImage = metaContent(html, 'property', 'og:image');
    const metaDesc = metaContent(html, 'name', 'description');

    const products = pickJsonLdProducts(html);
    let jsonName = null, jsonDesc = null, jsonImages = [], jsonPrice = null;
    for (const p of products) {
      if (!jsonName && p.name) jsonName = p.name;
      if (!jsonDesc && p.description) jsonDesc = p.description;
      if (p.image) {
        if (Array.isArray(p.image)) jsonImages.push(...p.image);
        else if (typeof p.image === 'string') jsonImages.push(p.image);
        else if (p.image.url) jsonImages.push(p.image.url);
      }
      if (!jsonPrice) {
        const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
        if (offer && offer.price) jsonPrice = Number(offer.price);
      }
    }

    return {
      ok: true,
      url,
      title: decodeHtml(jsonName || ogTitle),
      description: decodeHtml(jsonDesc || ogDesc || metaDesc),
      mainImage: ogImage || jsonImages[0] || null,
      images: [...new Set([ogImage, ...jsonImages].filter(Boolean))],
      price: jsonPrice,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { scrapeProductPage };
