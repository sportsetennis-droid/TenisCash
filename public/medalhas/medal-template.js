/* =====================================================================
 * GERADOR DE TEMPLATE POR EVENTO — identidade visual da coleção.
 * Cada campeonato tem escudo, cores, tipografia e padrão próprios, pra
 * coleção variar de evento pra evento. Determinístico: o mesmo nome de
 * evento gera sempre o mesmo template (semente = nome), e o organizador
 * pode sobrescrever cor, fonte, padrão, formato do escudo ou subir o
 * escudo oficial (imagem).
 * Roda no navegador e no Node (o servidor gera o template padrão).
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MedalTemplate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Tipografias abertas (OFL, Google Fonts) — todas com licença pra uso em peça/marca.
  var FONTS = {
    archivo: { label: 'Archivo Expandida', family: 'Archivo', css: 'family=Archivo:ital,wdth,wght@1,112..125,800..900', weight: 900, italic: true, stretch: '125%' },
    barlow: { label: 'Barlow Condensed', family: 'Barlow Condensed', css: 'family=Barlow+Condensed:ital,wght@1,800;1,900', weight: 900, italic: true },
    anton: { label: 'Anton', family: 'Anton', css: 'family=Anton', weight: 400 },
    bebas: { label: 'Bebas Neue', family: 'Bebas Neue', css: 'family=Bebas+Neue', weight: 400 },
    oswald: { label: 'Oswald', family: 'Oswald', css: 'family=Oswald:wght@700', weight: 700 },
    teko: { label: 'Teko', family: 'Teko', css: 'family=Teko:wght@600', weight: 600 },
    saira: { label: 'Saira Condensed', family: 'Saira Condensed', css: 'family=Saira+Condensed:wght@800', weight: 800 },
    russo: { label: 'Russo One', family: 'Russo One', css: 'family=Russo+One', weight: 400 },
  };
  // Fonte do corpo da carta (texto miúdo) e da assinatura manuscrita.
  var BODY_FONT = { family: 'Archivo', css: 'family=Archivo:wdth,wght@75..100,500..800' };
  var SIGN_FONT = { family: 'Caveat', css: 'family=Caveat:wght@600' };

  var PATTERNS = { diagonal: 'Listras diagonais', rays: 'Raios', hex: 'Colmeia', waves: 'Ondas', grid: 'Quadriculado', chevron: 'Chevron', dots: 'Pontilhado' };
  var SHIELDS = { classic: 'Escudo clássico', round: 'Redondo', hex: 'Hexágono', pennant: 'Flâmula', badge: 'Brasão' };

  var SPORTS = {
    BEACH_TENNIS: 'Beach Tennis', TENNIS: 'Tênis', PADEL: 'Padel', FUTSAL: 'Futsal', SOCCER: 'Futebol',
    VOLLEY: 'Vôlei', BEACH_VOLLEY: 'Vôlei de Praia', RUNNING: 'Corrida', BASKET: 'Basquete', SWIM: 'Natação',
    HANDBALL: 'Handebol', CYCLING: 'Ciclismo', GENERIC: 'Esporte',
  };
  // Ícones do esporte (traço, caixa 100x100). Desenho próprio, simples.
  var ICONS = {
    BALL: '<circle cx="50" cy="50" r="34"/><path d="M50 36l13 9-5 15H42l-5-15z"/><path d="M50 36V17M63 45l18-6M58 60l11 15M42 60L31 75M37 45l-18-6"/>',
    RACKET: '<ellipse cx="42" cy="40" rx="24" ry="28" transform="rotate(-35 42 40)"/><path d="M58 60l22 22M30 24l26 30M24 40l26 22M40 18l20 26"/><circle cx="76" cy="30" r="7"/>',
    PADDLE: '<path d="M30 18c14-10 36-4 42 12s-2 30-16 36l-6 4-8-8 4-6c-8-12-26-26-16-38z"/><path d="M42 58L22 82"/><circle cx="50" cy="34" r="3"/><circle cx="58" cy="44" r="3"/><circle cx="44" cy="46" r="3"/>',
    VOLLEY: '<circle cx="50" cy="50" r="34"/><path d="M50 16c-6 18-4 36 6 52M22 32c18 2 34 10 44 26M30 80c6-18 20-30 38-34"/>',
    SHOE: '<path d="M10 64c0-7 4-11 11-12l17-3 12-15c2-3 6-3 9-1l4 3c-2 6 1 10 7 11l15 4c6 2 8 7 8 13v4H10z"/><path d="M10 76h83M52 44l6 5M47 50l6 5"/>',
    STOPWATCH: '<circle cx="50" cy="56" r="30"/><path d="M50 56V38M44 18h12M50 18v8M74 30l6-6"/>',
    WAVE: '<path d="M12 50c10-10 18-10 26 0s18 10 26 0 18-10 26 0M12 68c10-10 18-10 26 0s18 10 26 0 18-10 26 0"/><circle cx="62" cy="28" r="8"/>',
    BIKE: '<circle cx="26" cy="62" r="16"/><circle cx="74" cy="62" r="16"/><path d="M26 62l16-24h22l10 24M42 38l12 24h20M58 30h10"/>',
    STAR: '<path d="M50 14l10 22 24 2-18 16 6 24-22-12-22 12 6-24-18-16 24-2z"/>',
    FLAG: '<path d="M26 90V12"/><path d="M26 14h50l-9 15 9 15H26"/><path d="M42 14v30M58 14v30M26 29h44"/>',
    TROPHY: '<path d="M32 18h36v16c0 14-8 24-18 24s-18-10-18-24z"/><path d="M32 24H18c0 12 6 18 16 18M68 24h14c0 12-6 18-16 18M50 58v12M36 82h28M40 70h20v12H40z"/>',
  };
  var SPORT_ICON = {
    BEACH_TENNIS: 'PADDLE', PADEL: 'PADDLE', TENNIS: 'RACKET', FUTSAL: 'BALL', SOCCER: 'BALL', HANDBALL: 'BALL',
    VOLLEY: 'VOLLEY', BEACH_VOLLEY: 'VOLLEY', BASKET: 'BALL', RUNNING: 'FLAG', SWIM: 'WAVE', CYCLING: 'BIKE', GENERIC: 'TROPHY',
  };

  // ---------------- cor ----------------
  function hash(s) { var h = 2166136261; s = String(s || ''); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var x = hash(seed) || 1; return function () { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) % 100000) / 100000; }; }
  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    var k = function (n) { return (n + h / 30) % 12; }, a = s * Math.min(l, 1 - l);
    var f = function (n) { return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); };
    return '#' + [f(0), f(8), f(4)].map(function (v) { return ('0' + Math.round(v * 255).toString(16)).slice(-2); }).join('');
  }
  function hexToRgb(hex) { var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim()); if (!m) return null; var n = parseInt(m[1], 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function toHsl(hex) {
    var c = hexToRgb(hex); if (!c) return null;
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
    if (mx !== mn) { var d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
    return [h, s * 100, l * 100];
  }
  function lum(hex) { var c = hexToRgb(hex) || [0, 0, 0]; var t = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]; }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  function shade(hex, dl) { var h = toHsl(hex); return h ? hsl(h[0], h[1], Math.max(4, Math.min(96, h[2] + dl))) : hex; }
  function validHex(v) { return hexToRgb(v) ? '#' + /([0-9a-f]{6})/i.exec(v)[1].toLowerCase() : null; }

  function initialsOf(name) {
    var stop = { DE: 1, DA: 1, DO: 1, DAS: 1, DOS: 1, E: 1, THE: 1, OF: 1 };
    var w = String(name || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(function (x) { return x && !stop[x] && !/^\d{4}$/.test(x); });
    if (!w.length) return 'EV';
    if (w.length === 1) return w[0].slice(0, 3);
    return (w[0][0] + w[1][0] + (w[2] ? w[2][0] : '')).slice(0, 3);
  }

  // ---------------- geração ----------------
  // input: { name, sport, circuit, primary, secondary, font, pattern, shape, crestImage, initials }
  function generate(input) {
    input = input || {};
    var seed = (input.name || 'evento') + '|' + (input.sport || '');
    var r = rng(seed);
    var p = validHex(input.primary);
    var baseH = p ? toHsl(p)[0] : Math.floor(r() * 360);
    var primary = p || hsl(baseH, 62 + r() * 20, 34 + r() * 12);
    var sh = toHsl(primary);
    var secondary = validHex(input.secondary) || hsl(sh[0] + (r() < 0.5 ? 150 + r() * 60 : 28 + r() * 20), 55 + r() * 25, 22 + r() * 12);
    var accent = validHex(input.accent) || hsl(sh[0] + 180 + (r() - 0.5) * 50, 85, 62);
    if (contrast(accent, primary) < 2.2) accent = shade(accent, lum(primary) > 0.3 ? -40 : 30);
    var ink = contrast('#ffffff', primary) >= 3 ? '#ffffff' : '#111111';
    var fontKeys = Object.keys(FONTS), patKeys = Object.keys(PATTERNS), shapeKeys = Object.keys(SHIELDS);
    return {
      v: 1,
      seed: seed,
      palette: { primary: primary, secondary: secondary, accent: accent, ink: ink, deep: shade(primary, -22) },
      font: FONTS[input.font] ? input.font : fontKeys[Math.floor(r() * fontKeys.length)],
      pattern: PATTERNS[input.pattern] ? input.pattern : patKeys[Math.floor(r() * patKeys.length)],
      crest: {
        shape: SHIELDS[input.shape] ? input.shape : shapeKeys[Math.floor(r() * shapeKeys.length)],
        initials: String(input.initials || initialsOf(input.name)).toUpperCase().slice(0, 3),
        icon: ICONS[input.icon] ? input.icon : (SPORT_ICON[input.sport] || 'TROPHY'),
        image: typeof input.crestImage === 'string' && /^(data:image\/(png|jpeg|webp|svg\+xml);base64,|https:\/\/)/.test(input.crestImage) ? input.crestImage : null,
      },
    };
  }

  // ---------------- desenho (SVG) ----------------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var SHIELD_PATH = {
    classic: 'M50 4 L92 16 V48 C92 74 74 90 50 98 C26 90 8 74 8 48 V16 Z',
    round: 'M50 4 A46 46 0 1 1 49.9 4 Z',
    hex: 'M50 3 L91 26 V74 L50 97 L9 74 V26 Z',
    pennant: 'M10 6 H90 V62 L50 96 L10 62 Z',
    badge: 'M50 3 L62 12 L78 10 L84 25 L96 36 L90 52 L94 68 L80 76 L72 92 L56 88 L44 88 L28 92 L20 76 L6 68 L10 52 L4 36 L16 25 L22 10 L38 12 Z',
  };
  // Escudo do evento em 100x100 (usar dentro de <g transform>).
  function crestSvg(design, uid) {
    var c = design.crest, pal = design.palette, id = 'cr' + (uid || '');
    var shape = SHIELD_PATH[c.shape] || SHIELD_PATH.classic;
    if (c.image) {
      return '<defs><clipPath id="' + id + 'c"><path d="' + shape + '"/></clipPath></defs>' +
        '<path d="' + shape + '" fill="#fff"/>' +
        '<image href="' + esc(c.image) + '" x="6" y="6" width="88" height="88" preserveAspectRatio="xMidYMid meet" clip-path="url(#' + id + 'c)"/>' +
        '<path d="' + shape + '" fill="none" stroke="' + pal.accent + '" stroke-width="3"/>';
    }
    var f = FONTS[design.font] || FONTS.archivo;
    var ini = esc(c.initials || 'EV');
    var fs = ini.length >= 3 ? 26 : 34;
    return '<defs><linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + pal.primary + '"/><stop offset="1" stop-color="' + pal.deep + '"/></linearGradient>' +
      '<clipPath id="' + id + 'c"><path d="' + shape + '"/></clipPath></defs>' +
      '<path d="' + shape + '" fill="url(#' + id + 'g)"/>' +
      '<g clip-path="url(#' + id + 'c)"><path d="M-10 64 L110 30 V44 L-10 78 Z" fill="' + pal.secondary + '" opacity=".9"/></g>' +
      '<g transform="translate(30 10) scale(.4)" fill="none" stroke="' + pal.accent + '" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[c.icon || 'TROPHY'] + '</g>' +
      '<text x="50" y="' + (c.shape === 'pennant' ? 76 : 80) + '" text-anchor="middle" font-family="\'' + f.family + '\', Archivo, sans-serif" font-weight="' + f.weight + '"' + (f.italic ? ' font-style="italic"' : '') + ' font-size="' + fs + '" fill="' + pal.ink + '" letter-spacing="1">' + ini + '</text>' +
      '<path d="' + shape + '" fill="none" stroke="' + pal.accent + '" stroke-width="3.5"/>';
  }

  // <pattern> de fundo (id fornecido), cor do traço com opacidade.
  function patternDef(design, id) {
    var col = design.palette.ink, o = 0.09, t = design.pattern;
    var w = 24, body = '';
    if (t === 'diagonal') { w = 22; body = '<path d="M-5 27L27 -5M-5 5L5 -5M17 27L27 17" stroke="' + col + '" stroke-width="5" opacity="' + o + '"/>'; }
    else if (t === 'rays') { w = 60; body = '<path d="M30 30L0 0M30 30L30 0M30 30L60 0M30 30L60 30M30 30L60 60M30 30L30 60M30 30L0 60M30 30L0 30" stroke="' + col + '" stroke-width="2" opacity="' + o + '"/>'; }
    else if (t === 'hex') { w = 28; body = '<path d="M14 0L28 8V24L14 32L0 24V8Z" fill="none" stroke="' + col + '" stroke-width="2" opacity="' + (o + 0.02) + '"/>'; return '<pattern id="' + id + '" width="28" height="48" patternUnits="userSpaceOnUse">' + body + '<path d="M0 32V48M28 32V48" stroke="' + col + '" stroke-width="2" opacity="' + (o + 0.02) + '"/></pattern>'; }
    else if (t === 'waves') { w = 40; body = '<path d="M0 12C10 2 20 2 30 12S50 22 60 12M0 32C10 22 20 22 30 32S50 42 60 32" fill="none" stroke="' + col + '" stroke-width="3" opacity="' + o + '"/>'; }
    else if (t === 'grid') { w = 20; body = '<path d="M20 0V20H0" fill="none" stroke="' + col + '" stroke-width="1.5" opacity="' + (o + 0.03) + '"/>'; }
    else if (t === 'chevron') { w = 30; body = '<path d="M0 20L15 8L30 20M0 34L15 22L30 34" fill="none" stroke="' + col + '" stroke-width="4" opacity="' + o + '"/>'; }
    else { w = 16; body = '<circle cx="8" cy="8" r="2.2" fill="' + col + '" opacity="' + (o + 0.04) + '"/>'; }
    return '<pattern id="' + id + '" width="' + w + '" height="' + w + '" patternUnits="userSpaceOnUse">' + body + '</pattern>';
  }

  function fontCssUrl(design) {
    var f = FONTS[design.font] || FONTS.archivo;
    var fams = [f.css, BODY_FONT.css, SIGN_FONT.css].filter(function (v, i, a) { return a.indexOf(v) === i; });
    return 'https://fonts.googleapis.com/css2?' + fams.join('&') + '&display=swap';
  }

  return {
    FONTS: FONTS, BODY_FONT: BODY_FONT, SIGN_FONT: SIGN_FONT, PATTERNS: PATTERNS, SHIELDS: SHIELDS, SPORTS: SPORTS, ICONS: ICONS,
    generate: generate, crestSvg: crestSvg, patternDef: patternDef, fontCssUrl: fontCssUrl,
    initialsOf: initialsOf, contrast: contrast, shade: shade, esc: esc, validHex: validHex,
  };
});
