const { parseStringPromise } = require('xml2js');

const NEWS_TTL_MS = 5 * 60 * 1000;
const GOOGLE_NEWS_RSS = 'https://news.google.com/rss/search';

let cache = null;

const FALLBACK_NEWS = [
  {
    id: 'fifa-news',
    title: 'Central oficial da FIFA para a Copa do Mundo 2026',
    source: 'FIFA',
    url: 'https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026',
    publishedAt: null,
    tag: 'Oficial',
  },
  {
    id: 'ge-copa',
    title: 'Noticias, agenda e tabelas da Copa no ge',
    source: 'ge',
    url: 'https://ge.globo.com/futebol/copa-do-mundo/',
    publishedAt: null,
    tag: 'Brasil',
  },
  {
    id: 'fifa-fixtures',
    title: 'Jogos, resultados e tabela oficial da Copa',
    source: 'FIFA',
    url: 'https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/scores-fixtures',
    publishedAt: null,
    tag: 'Tabela',
  },
];

function cacheGet() {
  if (!cache || cache.expiresAt <= Date.now()) {
    cache = null;
    return null;
  }
  return cache.value;
}

function cacheSet(value) {
  cache = { value, expiresAt: Date.now() + NEWS_TTL_MS };
  return value;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitGoogleTitle(title) {
  const value = normalizeText(title);
  const marker = value.lastIndexOf(' - ');
  if (marker <= 0) return { title: value, source: 'Google News' };
  return {
    title: value.slice(0, marker).trim(),
    source: value.slice(marker + 3).trim() || 'Google News',
  };
}

function buildRssUrl(query) {
  const url = new URL(GOOGLE_NEWS_RSS);
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('gl', 'BR');
  url.searchParams.set('ceid', 'BR:pt-419');
  return url;
}

function mapItem(item, index) {
  const { title, source } = splitGoogleTitle(item.title?.[0]);
  const link = normalizeText(item.link?.[0]);
  const publishedAt = item.pubDate?.[0] ? new Date(item.pubDate[0]).toISOString() : null;

  return {
    id: `news-${index}-${Buffer.from(title).toString('base64url').slice(0, 12)}`,
    title,
    source,
    url: link,
    publishedAt,
    tag: /brasil|selecao|seleção/i.test(title) ? 'Brasil' : 'Copa',
  };
}

async function fetchGoogleNews() {
  const url = buildRssUrl('Copa do Mundo 2026 selecao brasileira escalação jogadores');
  const response = await fetch(url, {
    headers: {
      Accept: 'application/rss+xml,text/xml,application/xml',
      'User-Agent': 'TenisCash-Copa/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`Google News RSS HTTP ${response.status}`);
  }

  const xml = await response.text();
  const parsed = await parseStringPromise(xml, { explicitArray: true });
  const items = parsed?.rss?.channel?.[0]?.item || [];

  return items
    .slice(0, 8)
    .map(mapItem)
    .filter((item) => item.title && item.url);
}

async function getWorldCupNews() {
  const cached = cacheGet();
  if (cached) return cached;

  try {
    const liveItems = await fetchGoogleNews();
    if (liveItems.length) {
      return cacheSet({
        mode: 'google_news_rss',
        status: 'ok',
        items: liveItems,
        sources: FALLBACK_NEWS,
      });
    }
  } catch (err) {
    console.warn('[copa-news] Feed indisponivel:', err.message);
  }

  return cacheSet({
    mode: 'curated_sources',
    status: 'fallback',
    items: FALLBACK_NEWS,
    sources: FALLBACK_NEWS,
  });
}

module.exports = {
  getWorldCupNews,
};
