// =====================================================================
// Marca por domínio. clubsportsetennis.com.br abre o MESMO sistema
// (mesmo banco, mesmo login), mas com a cara da Sports & Tennis:
// logo oficial, nome e ícone próprios. teniscash.com.br fica intocado.
// Logo: public/brand/club-sports-tennis.svg = vetor 100% digital (traçado
// fiel da logo oficial branca do acervo + palavra CLUB em vetor).
// Ícone: public/brand/sports-tennis-icon.svg (+ PNGs 512/192/180).
// =====================================================================
const fs = require('fs');
const path = require('path');

const ST_HOSTS = new Set(['clubsportsetennis.com.br', 'www.clubsportsetennis.com.br']);
const INDEX = path.join(__dirname, '../../public/index.html');
const LOGO = '/brand/club-sports-tennis.svg?v=3'; // vetor: CLUB + logo oficial
const LOGO_IMG = (w) => `<img src="${LOGO}" alt="Club Sports &amp; Tennis" style="display:block;width:${w};max-width:86vw;height:auto;margin:0 auto">`;

function isSportsTennisHost(req) {
  return ST_HOSTS.has(String((req && req.hostname) || '').toLowerCase());
}

// [de, para] — troca literal. Se um trecho sumir do index.html, só avisa no log
// (a página continua abrindo, só sem aquela troca).
const SWAPS = [
  ['<title>TenisCash</title>', '<title>Club Sports &amp; Tennis</title>'],
  [/<meta name="description" content="[^"]*">/, '<meta name="description" content="Club Sports &amp; Tennis — benefícios, cashback e esporte da Sports &amp; Tennis em João Pessoa/PB.">'],
  ['<link rel="manifest" href="/manifest.json">',
    '<link rel="manifest" href="/manifest.json">\n<link rel="icon" type="image/svg+xml" href="/brand/sports-tennis-icon.svg?v=2">\n<link rel="icon" type="image/png" sizes="192x192" href="/brand/sports-tennis-icon-192.png?v=2">\n<link rel="apple-touch-icon" href="/brand/sports-tennis-icon-180.png?v=2">\n<meta name="apple-mobile-web-app-title" content="Club S&amp;T">'],
  // Splash
  [/<div class="splash-logo">[\s\S]*?<p class="splash-sub">SPORTS &amp; TENNIS<\/p>|<div class="splash-logo">[\s\S]*?<p class="splash-sub">SPORTS & TENNIS<\/p>/,
    `<div class="splash-logo">${LOGO_IMG('300px')}</div>`],
  // Login: círculo "T" + "TENIS CASH"
  [/<div class="login-logo"><span[^>]*>T<\/span><\/div>\s*<div style="margin-bottom:10px">\s*<span[^>]*>TENIS<\/span>\s*<span[^>]*>CASH<\/span>\s*<\/div>/,
    `<div style="margin-bottom:22px">${LOGO_IMG('260px')}</div>`],
  // Demais telas com o círculo "T" (esqueci a senha etc.)
  [/<div class="login-logo"><span[^>]*>T<\/span><\/div>/g, `<div style="margin-bottom:20px">${LOGO_IMG('220px')}</div>`],
  // Menu lateral (computador): "TENISCASH / Sports & Tennis" → logo Club.
  // Fica depois do CSS original → vence pela ordem.
  ['</head>', `<style>
@media (min-width:1024px){
  .bottom-nav::before{content:'';top:28px;left:22px;width:206px;height:66px;background:url('${LOGO}') left center/contain no-repeat;letter-spacing:0;font-size:0}
  .bottom-nav::after{content:none;display:none}
}
</style>
</head>`],
  // Textos de tela do cliente (marca no rodapé + nome do saldo).
  // Termos/Política NÃO mudam: o programa juridicamente segue sendo o TenisCash.
  ['TENISCASH v2.0', 'CLUB SPORTS &amp; TENNIS'],
  [/Usar meu TenisCash na loja/g, 'Usar meu saldo na loja'],
  ['Usar TenisCash na loja</p>', 'Usar meu saldo na loja</p>'],
  ['usar seu TenisCash como desconto', 'usar seu saldo como desconto'],
  ['ou o do TenisCash. Não acumulam.', 'ou o do seu saldo. Não acumulam.'],
  ['>ENVIAR TENISCASH<', '>ENVIAR SALDO<'],
  ['ganhe TenisCash grátis!', 'ganhe saldo grátis!'],
  ['para aplicar o TenisCash<', 'para aplicar o seu saldo<'],
  ['Os arquivos ficam privados no TenisCash.', 'Os arquivos ficam privados no sistema.'],
  // Clube = torneios, times, jogos e treinos oficiais. Depois do login o atleta
  // vai pro painel do clube (/torneios.html), não pra carteira do TenisCash.
  // Vendedor/parceiro/design seguem o fluxo normal.
  ['</body>', `<script>(function(){
  var KEEP=['seller','partner','design','design_view'];
  function isKeep(){try{return typeof user!=='undefined'&&user&&KEEP.indexOf(user.role)>=0;}catch(e){return false;}}
  var g=window.goHomeByRole;
  window.goHomeByRole=function(){if(!isKeep()){location.replace('/torneios.html');return;}return g.apply(this,arguments);};
  var s=window.showScreen;
  window.showScreen=function(id){if(id==='home'&&localStorage.getItem('tc_token')&&!isKeep()){location.replace('/torneios.html');return;}return s.apply(this,arguments);};
})();</script>
</body>`],
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
    short_name: 'Club S&T',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#E5571E',
    theme_color: '#E5571E',
    icons: [
      { src: '/brand/sports-tennis-icon-192.png?v=2', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/brand/sports-tennis-icon-512.png?v=2', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}

// ---- Torneios (/torneios.html) no domínio do clube ----
const TORNEIOS = path.join(__dirname, '../../public/torneios.html');
const TORNEIOS_SWAPS = [
  ['<title>TenisCash — Torneios</title>', '<title>Torneios — Club Sports &amp; Tennis</title>'],
  ['</head>', '<link rel="icon" type="image/svg+xml" href="/brand/sports-tennis-icon.svg?v=2">\n<link rel="apple-touch-icon" href="/brand/sports-tennis-icon-180.png?v=2">\n</head>'],
  ['Use a mesma conta do TenisCash.', 'Use a mesma conta do Club Sports &amp; Tennis.'],
  ['Atletas precisam ter conta TenisCash (@username).', 'Atletas precisam ter conta no Club Sports &amp; Tennis (@username).'],
  ['Atletas têm que ter conta TenisCash.', 'Atletas têm que ter conta no Club Sports &amp; Tennis.'],
  // No clube, a entrada/cadastro é a tela da marca (/) — não o login simples daqui.
  ['function renderLogin(){', "function renderLogin(){location.replace('/');return;"],
  ["let html=topbar('Torneios');", "let html=topbar('Club Sports & Tennis');"],
  ['Central de Torneios', 'Meu painel'],
];
let tcache = { mtime: 0, html: '' };
function brandedTorneiosHtml() {
  const st = fs.statSync(TORNEIOS);
  if (tcache.html && tcache.mtime === st.mtimeMs) return tcache.html;
  let html = fs.readFileSync(TORNEIOS, 'utf8');
  for (const [from, to] of TORNEIOS_SWAPS) {
    const before = html;
    html = html.replace(from, to);
    if (html === before) console.warn('[siteBrand] torneios: trecho não encontrado:', String(from).slice(0, 80));
  }
  tcache = { mtime: st.mtimeMs, html };
  return html;
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
  app.get(['/torneios', '/torneios.html'], (req, res, next) => {
    if (!isSportsTennisHost(req)) return next();
    try {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      return res.type('html').send(brandedTorneiosHtml());
    } catch (e) {
      console.error('[siteBrand] torneios erro:', e.message);
      return next();
    }
  });
  app.get('/manifest.json', (req, res, next) => {
    if (!isSportsTennisHost(req)) return next();
    res.set('Cache-Control', 'no-store');
    return res.json(manifest());
  });
}

module.exports = { mount, isSportsTennisHost, brandedIndexHtml, brandedTorneiosHtml };
