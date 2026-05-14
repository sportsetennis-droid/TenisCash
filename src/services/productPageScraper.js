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
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
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

// Encontra <div class="..."> com balanceamento de <div> aninhados.
// Retorna o conteúdo interno (string entre as tags), ou null.
function extractDivByClass(html, classNameSubstr) {
  // Importante: usar [^"]*? entre as palavras pra NÃO escapar do valor de class=""
  const escaped = classNameSubstr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+[^"]*?');
  const openRe = new RegExp(`<div\\b[^>]*\\bclass="[^"]*\\b${escaped}\\b[^"]*"[^>]*>`, 'i');
  const m = html.match(openRe);
  if (!m) return null;
  const openIdx = html.indexOf(m[0]);
  const startIdx = openIdx + m[0].length;
  let depth = 1, i = startIdx;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return html.slice(startIdx, nextClose);
      i = nextClose + 6;
    }
  }
  return null;
}

// Limpa HTML do Magento Page Builder, mantendo só tags semânticas
function cleanProductHtml(html) {
  if (!html) return '';
  let out = html;
  // remove <style>...</style>
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');
  // remove <script>...</script>
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  // remove atributos lixo (data-*, class, style, id) das tags
  out = out.replace(/\s+(data-[a-z-]+|class|style|id)="[^"]*"/gi, '');
  out = out.replace(/\s+(data-[a-z-]+|class|style|id)='[^']*'/gi, '');
  // remove <span> mas mantém conteúdo
  out = out.replace(/<\/?span[^>]*>/gi, '');
  // remove <figure> mas mantém conteúdo
  out = out.replace(/<\/?figure[^>]*>/gi, '');
  // colapsa divs vazias (várias passadas pra divs aninhadas)
  for (let i = 0; i < 12; i++) {
    out = out.replace(/<div[^>]*>\s*<\/div>/gi, '');
  }
  // remove TODAS as <div> (sobrou só estrutura semântica)
  out = out.replace(/<\/?div[^>]*>/gi, '');
  // colapsa whitespace dentro de linhas, preserva quebras
  out = out.replace(/[ \t]+/g, ' ');
  out = out.replace(/\n{3,}/g, '\n\n');
  // remove tags abertas/fechadas órfãs vazias
  out = out.replace(/<(p|h[1-6]|li|ul|ol|strong|em|b|i)>\s*<\/\1>/gi, '');
  return out.trim();
}

function htmlToPlainText(html) {
  return decodeHtml(html || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
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

    // 1ª prioridade: bloco completo da descrição Magento (product attribute description > value)
    //   contém ÍCONE DO DIA A DIA + Características + Origem em HTML formatado.
    let descriptionHtml = null;
    let descriptionPlain = null;

    const fullDescBlock = extractDivByClass(html, 'product attribute description');
    if (fullDescBlock) {
      const valueBlock = extractDivByClass(fullDescBlock, 'value');
      if (valueBlock) {
        descriptionHtml = cleanProductHtml(valueBlock);
        descriptionPlain = htmlToPlainText(descriptionHtml);
      }
    }

    // 2ª prioridade: overview curto (short description Magento)
    const overviewBlock = extractDivByClass(html, 'product attribute overview');
    let overviewPlain = null;
    if (overviewBlock) {
      const valueBlock = extractDivByClass(overviewBlock, 'value');
      if (valueBlock) {
        overviewPlain = htmlToPlainText(cleanProductHtml(valueBlock));
      }
    }

    // 3ª — Vtex: <div class="vtex-store-components-X-x-productDescriptionText">
    if (!descriptionHtml) {
      const vtexRe = /<div[^>]+class="[^"]*productDescriptionText[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
      const vtexMatch = html.match(vtexRe);
      if (vtexMatch) {
        descriptionHtml = cleanProductHtml(vtexMatch[1]);
        descriptionPlain = htmlToPlainText(descriptionHtml);
      }
    }
    // Vtex alt: <div data-testid="product-description"> ou class*="ProductDescription"
    if (!descriptionHtml) {
      const altRe = /<(?:div|section)[^>]+(?:data-testid="product-description"|class="[^"]*ProductDescription[^"]*"|id="description")[^>]*>([\s\S]{50,5000}?)<\/(?:div|section)>/i;
      const m = html.match(altRe);
      if (m) {
        const cleaned = cleanProductHtml(m[1]);
        if (cleaned.length > 50) {
          descriptionHtml = cleaned;
          descriptionPlain = htmlToPlainText(cleaned);
        }
      }
    }

    // 4ª — Shopify: <div class="product__description"> ou <div class="product-single__description">
    if (!descriptionHtml) {
      const shopRe = /<div[^>]+class="[^"]*product(?:-single)?__description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
      const m = html.match(shopRe);
      if (m) {
        descriptionHtml = cleanProductHtml(m[1]);
        descriptionPlain = htmlToPlainText(descriptionHtml);
      }
    }

    // 5ª — WooCommerce: #tab-description ou .woocommerce-product-details__short-description
    if (!descriptionHtml) {
      const wcRe = /<(?:div|section)[^>]+(?:id="tab-description"|class="[^"]*woocommerce-(?:Tabs-panel--description|product-details__short-description)[^"]*")[^>]*>([\s\S]{50,8000}?)<\/(?:div|section)>/i;
      const m = html.match(wcRe);
      if (m) {
        descriptionHtml = cleanProductHtml(m[1]);
        descriptionPlain = htmlToPlainText(descriptionHtml);
      }
    }

    // 6ª — JSON-LD com description rica (pode ter HTML embutido)
    if (!descriptionHtml && jsonDesc && jsonDesc.length > 80) {
      // Se a description do JSON-LD tem tags HTML, usa como descriptionHtml
      if (/<\w+/.test(jsonDesc)) {
        descriptionHtml = cleanProductHtml(jsonDesc);
        descriptionPlain = htmlToPlainText(descriptionHtml);
      } else {
        descriptionPlain = decodeHtml(jsonDesc);
      }
    }

    // Fallback final pro caso de outros sites (sem nenhum bloco identificado)
    if (!descriptionPlain) {
      descriptionPlain = decodeHtml(jsonDesc || ogDesc || metaDesc);
    }

    return {
      ok: true,
      url,
      title: decodeHtml(jsonName || ogTitle),
      // HTML formatado (vai pro longDescription, renderiza bem no Nuvemshop)
      descriptionHtml: descriptionHtml || null,
      // Texto plano (fallback/preview)
      description: descriptionPlain,
      // Resumo curto (vai pro shortDescription se existir)
      overview: overviewPlain,
      mainImage: ogImage || jsonImages[0] || null,
      images: [...new Set([ogImage, ...jsonImages].filter(Boolean))],
      price: jsonPrice,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { scrapeProductPage };
