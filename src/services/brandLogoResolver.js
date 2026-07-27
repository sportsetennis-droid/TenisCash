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
const REQUEST_TIMEOUT_MS = 4500;
const sharp = require('sharp');

// Slugs que não seguem exatamente o nome comercial no catálogo do Simple Icons.
const SIMPLE_ICON_ALIASES = {
  'new-balance': 'newbalance',
  'under-armour': 'underarmour',
  'body-for-sure': 'bodyforsure',
  'powell-peralta': 'powellperalta',
  'zero-american': 'zeroamerican',
};

// Termos comuns do catálogo que costumam retornar logos de instituições,
// clubes ou unidades militares no Commons. Sem confirmação da identidade,
// eles ficam pendentes para cadastro manual.
const AMBIGUOUS_COMMONS_NAMES = new Set([
  'army', 'bel', 'fiber', 'impacto', 'leader', 'n1', 'ous', 'vitoria',
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
    const response = await fetchWithTimeout(url);
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return false;
    if (/svg/i.test(String(mime || '')) || /\.svg(?:$|\?)/i.test(url)) {
      const source = bytes.toString('utf8');
      // SVGs sem uma camada de fundo são escaláveis e preservam transparência.
      // Rejeita apenas o padrão explícito de uma tela branca ocupando tudo.
      return !/<rect[^>]+(?:width=["']100%["'][^>]+height=["']100%["']|height=["']100%["'][^>]+width=["']100%["'])[^>]+fill=["'](?:#fff(?:fff)?|white)["']/i.test(source);
    }
    const metadata = await sharp(bytes).metadata();
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
    const simple = await simpleIconsCandidate(brand);
    if (simple) return simple;
    return commonsCandidate(brand);
  })();
  CACHE.set(key, promise);
  const resolved = await promise;
  CACHE.set(key, resolved || null);
  return resolved || null;
}

function clearBrandLogoCache() {
  CACHE.clear();
}

module.exports = {
  resolveBrandLogoUrl,
  clearBrandLogoCache,
};
