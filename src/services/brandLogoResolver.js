// =====================================================================
// Brand logo resolver
//
// Obtém apenas logos vetoriais/transparentes de fontes públicas conhecidas.
// A resolução é conservadora: se o resultado não tiver uma correspondência
// clara com a marca, retorna null para que a geração da etiqueta seja
// bloqueada em vez de usar uma imagem possivelmente errada.
// =====================================================================

const SIMPLE_ICONS_CDN = 'https://cdn.simpleicons.org';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const CACHE = new Map();
const QUALITY_CACHE = new Map();
const REQUEST_TIMEOUT_MS = 4500;
const MIN_RASTER_LOGO_WIDTH = 512;
const MIN_RASTER_LOGO_HEIGHT = 64;
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// Slugs que não seguem exatamente o nome comercial no catálogo do Simple Icons.
const SIMPLE_ICON_ALIASES = {
  'new-balance': 'newbalance',
  'under-armour': 'underarmour',
  'body-for-sure': 'bodyforsure',
  'powell-peralta': 'powellperalta',
  'zero-american': 'zeroamerican',
};

// Logo oficial publicada pela própria loja Sports & Tennis no cabeçalho do
// site institucional. O arquivo é PNG transparente e tem resolução suficiente
// para a etiqueta; a URL é mantida aqui para não usar uma marca parecida.
const CAJUBRASIL_OFFICIAL_SVG = (() => {
  try {
    const file = path.join(__dirname, '../../assets/logos/cajubrasil-negative.svg');
    return `data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
  } catch (err) {
    console.warn('[brand-logo] vetor oficial da Cajubrasil indisponivel:', err.message);
    return null;
  }
})();

const CAJUBRASIL_FALLBACK_URL = 'https://cajubrasil.vtexassets.com/assets/vtex/assets-builder/cajubrasil.store-theme/5.0.90/images/logos/logo___f7dd4dd2bc98ab3ded6e83f27ce24d3d.png';
const UMBRO_STACKED_OFFICIAL_SVG = 'https://upload.wikimedia.org/wikipedia/commons/2/22/Umbro_logo_%28current%29.svg';

// Biblioteca local preparada a partir dos sites oficiais das marcas e, quando
// o fabricante não publica a arte no próprio site, de arquivos exatos do
// Wikimedia Commons. Manter a arte dentro da aplicação elimina bloqueios e
// limites de requisição durante a geração de lotes grandes de etiquetas.
const LOCAL_BRAND_LOGO_URLS = (() => {
  try {
    const directory = path.join(__dirname, '../../assets/logos/brands');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'sources.json'), 'utf8'));
    return Object.values(manifest).reduce((logos, entry) => {
      if (!entry?.brand || !entry?.file) return logos;
      const file = path.join(directory, entry.file);
      const extension = path.extname(file).toLowerCase();
      const mime = extension === '.svg' ? 'image/svg+xml' : 'image/png';
      logos[normalize(entry.brand)] = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      return logos;
    }, {});
  } catch (err) {
    console.warn('[brand-logo] biblioteca local de marcas indisponivel:', err.message);
    return {};
  }
})();

const OFFICIAL_LOGO_URLS = {
  'sports and tennis': 'https://d2az8otjr0j19j.cloudfront.net/templates/007/890/890/twig/static/images/st-logo-sports-tennis-white-transparent-20260601.png?v=20260601-logo3',
  // Logo oficial publicada no cabeÃ§alho da loja da Caju Brasil (PNG com
  // canal alfa, hospedada no prÃ³prio domÃ­nio VTEX da marca).
  'caju brasil': CAJUBRASIL_OFFICIAL_SVG || CAJUBRASIL_FALLBACK_URL,
  'cajubrasil': CAJUBRASIL_OFFICIAL_SVG || CAJUBRASIL_FALLBACK_URL,
  // A busca genérica do Commons prioriza "Umbro logo.svg", uma composição
  // horizontal (1000x378) que parece esticada na face vertical da etiqueta.
  // A identidade usada no produto é a composição oficial empilhada (1000x649).
  'umbro': UMBRO_STACKED_OFFICIAL_SVG,
};

// Termos comuns do catálogo que costumam retornar logos de instituições,
// clubes ou unidades militares no Commons. Sem confirmação da identidade,
// eles ficam pendentes para cadastro manual.
const AMBIGUOUS_COMMONS_NAMES = new Set([
  'army', 'bel', 'fiber', 'impacto', 'impulse', 'leader', 'n1', 'ous', 'vitoria',
]);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function slug(value) {
  return normalize(value).replace(/ /g, '-');
}

function isUsableBrand(value) {
  const key = normalize(value);
  return Boolean(key) && key !== 'a definir' && key.length >= 2;
}

function isSupportedMime(mime) {
  // JPEG não tem canal alfa; não é aceito para uma etiqueta sem fundo.
  return /^(image\/svg\+xml|image\/png|image\/webp)$/i.test(String(mime || ''));
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'user-agent': 'TenisCash label logo resolver/1.0',
        accept: 'application/json,image/svg+xml,image/png,image/jpeg,image/webp,*/*;q=0.8',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function simpleIconsCandidate(name) {
  const key = slug(name);
  if (!key) return null;
  const iconSlug = SIMPLE_ICON_ALIASES[key] || key;
  const url = `${SIMPLE_ICONS_CDN}/${encodeURIComponent(iconSlug)}`;
  try {
    // O CDN devolve SVG quando a marca existe. Fazemos um GET leve para não
    // registrar uma URL 404 como se fosse logo válida.
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    const mime = String(response.headers.get('content-type') || '');
    if (!mime.includes('svg') && !mime.includes('image')) return null;
    await response.arrayBuffer();
    return url;
  } catch (err) {
    console.warn(`[brand-logo] Simple Icons indisponível para "${name}": ${err.message}`);
    return null;
  }
}

async function officialCandidate(name) {
  const normalized = normalize(name);
  // As unidades físicas usam nomes complementares (por exemplo,
  // "Sports & Tennis Praia do Bessa"), mas continuam usando a mesma logo
  // oficial da rede. Não confundimos outras marcas: somente nomes que
  // começam com a marca da rede recebem este alias.
  const url = LOCAL_BRAND_LOGO_URLS[normalized]
    || OFFICIAL_LOGO_URLS[normalized]
    || (normalized.startsWith('sports and tennis ') ? OFFICIAL_LOGO_URLS['sports and tennis'] : null);
  if (!url) return null;
  const mime = /^data:([^;,]+)/i.exec(url)?.[1]
    || (/\.svg(?:$|\?)/i.test(url) ? 'image/svg+xml' : 'image/png');
  return (await hasTransparentBackground(url, mime)) ? url : null;
}

function commonsTitleScore(title, brand) {
  const raw = String(title || '').replace(/^File:/i, '').replace(/\.[a-z0-9]+$/i, '');
  const titleKey = normalize(raw);
  const brandKey = normalize(brand);
  if (!titleKey || !brandKey || !titleKey.includes('logo')) return -1;

  // Cada palavra da marca precisa aparecer no título. Isso evita, por
  // exemplo, aceitar um logo de um time quando a busca foi por uma marca
  // diferente com nome parecido.
  const brandWords = brandKey.split(' ').filter((word) => word.length >= 2);
  if (!brandWords.every((word) => titleKey.split(' ').includes(word))) return -1;

  let score = 0;
  if (titleKey === `${brandKey} logo` || titleKey === `logo ${brandKey}`) score += 100;
  if (titleKey.startsWith(`${brandKey} logo`) || titleKey.startsWith(`logo ${brandKey}`)) score += 40;
  if (titleKey.includes(brandKey)) score += 20;
  if (/\.svg$/i.test(String(title || ''))) score += 15;
  else if (/\.png$/i.test(String(title || ''))) score += 8;
  else if (/\.jpe?g$/i.test(String(title || ''))) score += 3;
  return score;
}

async function commonsCandidate(name) {
  if (AMBIGUOUS_COMMONS_NAMES.has(normalize(name))) return null;
  const search = new URL(COMMONS_API);
  search.searchParams.set('action', 'query');
  search.searchParams.set('list', 'search');
  search.searchParams.set('srnamespace', '6');
  search.searchParams.set('srsearch', `${name} logo`);
  search.searchParams.set('srlimit', '10');
  search.searchParams.set('format', 'json');
  search.searchParams.set('origin', '*');

  try {
    const response = await fetchWithTimeout(search.toString());
    if (!response.ok) return null;
    const payload = await response.json();
    const results = Array.isArray(payload?.query?.search) ? payload.query.search : [];
    const ranked = results
      .map((row) => ({ row, score: commonsTitleScore(row.title, name) }))
      .filter((candidate) => candidate.score >= 100)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return null;

    const pageIds = ranked.map((candidate) => candidate.row.pageid).filter(Boolean).join('|');
    if (!pageIds) return null;
    const info = new URL(COMMONS_API);
    info.searchParams.set('action', 'query');
    info.searchParams.set('pageids', pageIds);
    info.searchParams.set('prop', 'imageinfo');
    info.searchParams.set('iiprop', 'url|mime|size|width|height');
    info.searchParams.set('format', 'json');
    info.searchParams.set('origin', '*');
    const infoResponse = await fetchWithTimeout(info.toString());
    if (!infoResponse.ok) return null;
    const infoPayload = await infoResponse.json();
    const pages = Object.values(infoPayload?.query?.pages || {});
    const candidates = pages
      .map((page) => {
        const image = page?.imageinfo?.[0];
        if (!image || !isSupportedMime(image.mime)) return null;
        if (!image.url || Number(image.size || 0) > 8 * 1024 * 1024) return null;
        if (Number(image.width || 0) && Number(image.width) < 128) return null;
        return {
          url: image.url,
          score: commonsTitleScore(page.title, name),
          mime: image.mime,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || (a.mime === 'image/svg+xml' ? -1 : 1));
    for (const candidate of candidates) {
      if (await hasTransparentBackground(candidate.url, candidate.mime)) return candidate.url;
    }
    return null;
  } catch (err) {
    console.warn(`[brand-logo] Wikimedia Commons indisponível para "${name}": ${err.message}`);
    return null;
  }
}

async function hasTransparentBackground(url, mime) {
  try {
    let bytes;
    let resolvedMime = String(mime || '');
    if (/^data:image\//i.test(String(url || ''))) {
      const match = String(url).match(/^data:([^;,]+)(?:;[^,]*)?,(.*)$/is);
      if (!match) return false;
      resolvedMime = match[1] || resolvedMime;
      const payload = match[2] || '';
      bytes = /;base64/i.test(match[0].slice(0, match[0].indexOf(',') + 1))
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload));
    } else {
      const response = await fetchWithTimeout(url);
      if (!response.ok) return false;
      resolvedMime = response.headers.get('content-type') || resolvedMime;
      bytes = Buffer.from(await response.arrayBuffer());
    }
    if (bytes.length > 8 * 1024 * 1024) return false;
    if (/svg/i.test(resolvedMime) || /\.svg(?:$|\?)/i.test(url)) {
      const source = bytes.toString('utf8');
      // SVGs sem uma camada de fundo são escaláveis e preservam transparência.
      // Rejeita apenas o padrão explícito de uma tela branca ocupando tudo.
      return !/<rect[^>]+(?:width=["']100%["'][^>]+height=["']100%["']|height=["']100%["'][^>]+width=["']100%["'])[^>]+fill=["'](?:#fff(?:fff)?|white)["']/i.test(source);
    }
    const metadata = await sharp(bytes).metadata();
    if (Number(metadata.width || 0) < MIN_RASTER_LOGO_WIDTH
      || Number(metadata.height || 0) < MIN_RASTER_LOGO_HEIGHT) return false;
    if (!metadata.hasAlpha) return false;
    const stats = await sharp(bytes).stats();
    const alpha = stats.channels?.[stats.channels.length - 1];
    return !alpha || alpha.min < 255;
  } catch (err) {
    console.warn(`[brand-logo] não foi possível validar transparência de ${url}: ${err.message}`);
    return false;
  }
}

/**
 * Resolve uma URL de logo transparente/sem fundo.
 * A função mantém cache em memória para não consultar a internet repetidamente
 * no mesmo processo e retorna null em qualquer caso ambíguo.
 */
async function resolveBrandLogoUrl(name) {
  const brand = String(name || '').trim();
  if (!isUsableBrand(brand)) return null;
  const key = normalize(brand);
  if (CACHE.has(key)) return CACHE.get(key);

  const promise = (async () => {
    const official = await officialCandidate(brand);
    if (official) return official;
    const simple = await simpleIconsCandidate(brand);
    if (simple) return simple;
    return commonsCandidate(brand);
  })();
  CACHE.set(key, promise);
  const resolved = await promise;
  CACHE.set(key, resolved || null);
  return resolved || null;
}

/**
 * Valida uma logo cadastrada manualmente antes de permitir a impressão.
 * Isso impede que uma imagem transparente, porém pequena demais, seja
 * ampliada e saia pixelada na etiqueta.
 */
async function validateBrandLogoUrl(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  if (QUALITY_CACHE.has(value)) return QUALITY_CACHE.get(value);
  const mime = /^data:([^;,]+)/i.exec(value)?.[1]
    || (/\.svg(?:$|\?)/i.test(value) ? 'image/svg+xml' : '');
  const promise = hasTransparentBackground(value, mime);
  QUALITY_CACHE.set(value, promise);
  const valid = await promise;
  QUALITY_CACHE.set(value, valid);
  return valid;
}

function clearBrandLogoCache() {
  CACHE.clear();
  QUALITY_CACHE.clear();
}

module.exports = {
  resolveBrandLogoUrl,
  validateBrandLogoUrl,
  clearBrandLogoCache,
};
