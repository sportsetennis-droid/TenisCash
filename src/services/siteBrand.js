// =====================================================================
// Marca por domínio. clubsportsetennis.com.br abre o MESMO sistema
// (mesmo banco, mesmo login), mas com a cara da Sports & Tennis:
// logo oficial, nome e ícone próprios. teniscash.com.br fica intocado.
// Logo oficial: public/brand/sports-tennis-logo-branca.png (cópia exata
// do acervo brand-sports-tennis — não redesenhar).
// =====================================================================
const fs = require('fs');
const path = require('path');

const ST_HOSTS = new Set(['clubsportsetennis.com.br', 'www.clubsportsetennis.com.br']);
const INDEX = path.join(__dirname, '../../public/index.html');
const LOGO = '/brand/sports-tennis-logo-branca.png?v=1';
const LOGO_IMG = (w) => `<img src="${LOGO}" alt="Sports &amp; Tennis" style="display:block;width:${w};max-width:86vw;height:auto;margin:0 auto">`;

function isSportsTennisHost(req) {
  return ST_HOSTS.has(String((req && req.hostname) || '').toLowerCase());
}

// [de, para] — troca literal. Se um trecho sumir do index.html, só avisa no log
// (a página continua abrindo, só sem aquela troca).
const SWAPS = [
  ['<title>TenisCash</title>', '<title>Sports &amp; Tennis</title>'],
  [/<meta name="description" content="[^"]*">/, '<meta name="description" content="Club Sports &amp; Tennis — benefícios, cashback e esporte da Sports &amp; Tennis em João Pessoa/PB.">'],
  ['<link rel="manifest" href="/manifest.json">',
    '<link rel="manifest" href="/manifest.json">\n<link rel="icon" type="image/png" href="/brand/sports-tennis-icon-192.png">\n<link rel="apple-touch-icon" href="/brand/sports-tennis-icon-180.png">\n<meta name="apple-mobile-web-app-title" content="Sports &amp; Tennis">'],
  // Splash
  [/<div class="splash-logo">[\s\S]*?<p class="splash-sub">SPORTS &amp; TENNIS<\/p>|<div class="splash-logo">[\s\S]*?<p class="splash-sub">SPORTS & TENNIS<\/p>/,
    `<div class="splash-logo">${LOGO_IMG('300px')}</div>\n  <p class="splash-sub">CLUB</p>`],
  // Login: círculo "T" + "TENIS CASH"
  [/<div class="login-logo"><span[^>]*>T<\/span><\/div>\s*<div style="margin-bottom:10px">\s*<span[^>]*>TENIS<\/span>\s*<span[^>]*>CASH<\/span>\s*<\/div>/,
    `<div style="margin-bottom:22px">${LOGO_IMG('260px')}</div>`],
  // Demais telas com o círculo "T" (esqueci a senha etc.)
  [/<div class="login-logo"><span[^>]*>T<\/span><\/div>/g, `<div style="margin-bottom:20px">${LOGO_IMG('220px')}</div>`],
];

let cache = { mtime: 0, html: '' };

function brandedIndexHtml() {
  const st = fs.statSync(INDEX);
  if (cache.html && cache.mtime === st.mtimeMs) return cache.html;
  let html = fs.readFileSync(INDEX, 'utf8');
  for (const [from, to] of SWAPS) {
    const before = html;
    html = html.replace(from, to);
    if (html === before) console.warn('[siteBrand] trecho não encontrado no index.html:', String(from).slice(0, 80));
  }
  cache = { mtime: st.mtimeMs, html };
  return html;
}

function manifest() {
  return {
    name: 'Club Sports & Tennis',
    short_name: 'Sports & Tennis',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#E5571E',
    theme_color: '#E5571E',
    icons: [
      { src: '/brand/sports-tennis-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/sports-tennis-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

// Monta as rotas. Chamar ANTES do express.static.
function mount(app) {
  app.get(['/', '/index.html'], (req, res, next) => {
    if (!isSportsTennisHost(req)) return next();
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      return res.type('html').send(brandedIndexHtml());
    } catch (e) {
      console.error('[siteBrand] erro:', e.message);
      return next();
    }
  });
  app.get('/manifest.json', (req, res, next) => {
    if (!isSportsTennisHost(req)) return next();
    res.set('Cache-Control', 'no-store');
    return res.json(manifest());
  });
}

module.exports = { mount, isSportsTennisHost, brandedIndexHtml };
