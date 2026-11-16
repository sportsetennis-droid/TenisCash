/* =====================================================================
 * CARTA DA MEDALHA — frente e verso (SVG 500x700 = 2,5 x 3,5), variantes
 * de raridade, animação de abertura (brilho/tilt/flip) e imagem estática
 * pra compartilhar (PNG com a credencial assinada embutida).
 * Depende de MedalTemplate (medal-template.js).
 * Raridade vem SÓ do mérito: tier (ouro/prata/bronze/concluinte) + títulos
 * raros (invicto, artilheiro, melhor atleta, estadual, nacional, recorde).
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./medal-template.js'));
  else root.MedalCard = factory(root.MedalTemplate);
})(typeof self !== 'undefined' ? self : this, function (T) {
  'use strict';
  var esc = T.esc;

  var TIER = {
    GOLD: { label: 'OURO', stops: ['#6b4e0f', '#f6e27a', '#b8862a', '#fff1b8', '#8a6514', '#e0b84a'], disc: ['#fff6cf', '#e8c35a', '#a8791f'], emboss: '#7a560f', text: '#3d2a05' },
    SILVER: { label: 'PRATA', stops: ['#545c66', '#eef1f5', '#9aa3ae', '#ffffff', '#66707b', '#c9d0d8'], disc: ['#ffffff', '#c7ced6', '#7f8893'], emboss: '#56606b', text: '#262c33' },
    BRONZE: { label: 'BRONZE', stops: ['#4f2a12', '#f2b483', '#9c5a2a', '#ffd3ad', '#6b3a1a', '#c98450'], disc: ['#ffd9b5', '#c98450', '#7e4320'], emboss: '#6b3a1a', text: '#3a1c08' },
    FINISHER: { label: 'CONCLUINTE', stops: null, disc: null, emboss: null, text: null },
    SPECIAL: { label: 'ESPECIAL', stops: ['#6b4e0f', '#f6e27a', '#b8862a', '#fff1b8', '#8a6514', '#e0b84a'], disc: ['#fff6cf', '#e8c35a', '#a8791f'], emboss: '#7a560f', text: '#3d2a05' },
  };
  var HOLO = ['#ff5f6d', '#ffc371', '#f9f871', '#47e5bc', '#4facfe', '#a18cd1', '#fbc2eb', '#ff5f6d'];
  var FONT_W = { archivo: 0.74, barlow: 0.46, anton: 0.5, bebas: 0.42, oswald: 0.5, teko: 0.42, saira: 0.48, russo: 0.66 };
  var AWARD_ICON = { TOP_SCORER: 'BALL', MVP: 'STAR', RECORD: 'STOPWATCH' };

  // ---------- rótulos (fem. quando a categoria é feminina) ----------
  var DIST = {
    UNBEATEN: ['CAMPEÃO INVICTO', 'CAMPEÃ INVICTA'], STATE_CHAMPION: ['CAMPEÃO ESTADUAL', 'CAMPEÃ ESTADUAL'],
    NATIONAL_CHAMPION: ['CAMPEÃO NACIONAL', 'CAMPEÃ NACIONAL'], RECORD: ['RECORDE', 'RECORDE'],
  };
  function placementLabel(v) {
    var f = v.gender === 'F' ? 1 : 0;
    if (v.achievement === 'TOP_SCORER') return f ? 'ARTILHEIRA' : 'ARTILHEIRO';
    if (v.achievement === 'MVP') return 'MELHOR ATLETA';
    if (v.achievement === 'RECORD') return 'RECORDE';
    if (v.tier === 'FINISHER') return 'CONCLUINTE';
    if (v.placement === 1) return f ? 'CAMPEÃ' : 'CAMPEÃO';
    if (v.placement === 2) return f ? 'VICE-CAMPEÃ' : 'VICE-CAMPEÃO';
    if (v.placement) return v.placement + 'º LUGAR';
    return (TIER[v.tier] || TIER.GOLD).label;
  }
  function distinctionLabels(v) { var f = v.gender === 'F' ? 1 : 0; return (v.distinctions || []).map(function (d) { return DIST[d] ? DIST[d][f] : d; }); }
  function isRare(v) { return (v.distinctions && v.distinctions.length > 0) || ['TOP_SCORER', 'MVP', 'RECORD'].indexOf(v.achievement) >= 0; }
  function editionText(v) { return v.edition ? v.edition.n + ' DE ' + v.edition.total : ''; }
  function fmtDate(d) { if (!d) return '—'; var x = new Date(d); if (isNaN(x)) return String(d); return ('0' + x.getUTCDate()).slice(-2) + '/' + ('0' + (x.getUTCMonth() + 1)).slice(-2) + '/' + x.getUTCFullYear(); }

  // ---------- texto: estimativa de largura e quebra ----------
  function fit(text, maxW, maxSize, minSize, k) {
    var len = Math.max(1, String(text).length), size = Math.min(maxSize, maxW / (len * k));
    if (size >= minSize) return { size: Math.round(size * 10) / 10, squeeze: false };
    return { size: minSize, squeeze: true };
  }
  function wrap2(text, maxW, size, k) {
    var words = String(text).split(/\s+/), lines = [''];
    for (var i = 0; i < words.length; i++) {
      var cur = lines[lines.length - 1], next = cur ? cur + ' ' + words[i] : words[i];
      if (next.length * size * k <= maxW || !cur) lines[lines.length - 1] = next;
      else if (lines.length < 2) lines.push(words[i]);
      else lines[1] += ' ' + words[i];
    }
    return lines;
  }
  function txt(x, y, s, o) {
    o = o || {};
    var a = ' x="' + x + '" y="' + y + '"';
    if (o.anchor) a += ' text-anchor="' + o.anchor + '"';
    if (o.size) a += ' font-size="' + o.size + '"';
    if (o.family) a += ' font-family="' + esc(o.family) + '"';
    if (o.weight) a += ' font-weight="' + o.weight + '"';
    if (o.italic) a += ' font-style="italic"';
    if (o.fill) a += ' fill="' + o.fill + '"';
    if (o.opacity != null) a += ' opacity="' + o.opacity + '"';
    if (o.ls) a += ' letter-spacing="' + o.ls + '"';
    if (o.stretch) a += ' font-stretch="' + o.stretch + '"';
    if (o.squeeze && o.maxW) a += ' textLength="' + o.maxW + '" lengthAdjust="spacingAndGlyphs"';
    return '<text' + a + '>' + esc(s) + '</text>';
  }
  function fontAttrs(design) {
    var f = T.FONTS[design.font] || T.FONTS.archivo;
    return { family: "'" + f.family + "', 'Archivo', 'Arial Narrow', sans-serif", weight: f.weight, italic: f.italic, stretch: f.stretch, k: FONT_W[design.font] || 0.6 };
  }
  var BODY = "'Archivo', 'Segoe UI', Roboto, sans-serif";

  function gradStops(stops) { return stops.map(function (c, i) { return '<stop offset="' + (i / (stops.length - 1)).toFixed(3) + '" stop-color="' + c + '"/>'; }).join(''); }
  function hi(fi) { return fi.stops[3] || fi.stops[1]; }
  function finishOf(v) {
    var d = v.design, t = TIER[v.tier] || TIER.GOLD;
    if (v.tier !== 'FINISHER') return t;
    var s = d.palette.secondary;
    return { label: 'CONCLUINTE', stops: [T.shade(s, -12), T.shade(s, 8), T.shade(s, -4)], disc: [T.shade(d.palette.primary, 26), d.palette.primary, d.palette.deep], emboss: d.palette.deep, text: d.palette.ink, flat: true };
  }

  // ---------- FRENTE ----------
  function front(v, opt) {
    opt = opt || {};
    var u = 'm' + (opt.uid || Math.random().toString(36).slice(2, 8));
    var d = v.design, pal = d.palette, fi = finishOf(v), rare = isRare(v), F = fontAttrs(d);
    var defs = '';
    defs += '<linearGradient id="' + u + 'fr" x1="0" y1="0" x2="1" y2="1">' + gradStops(fi.stops) + '</linearGradient>';
    defs += '<linearGradient id="' + u + 'holo" x1="0" y1="0" x2="1" y2="1">' + gradStops(HOLO) + '</linearGradient>';
    defs += '<linearGradient id="' + u + 'bg" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="' + T.shade(pal.primary, 6) + '"/><stop offset=".55" stop-color="' + pal.primary + '"/><stop offset="1" stop-color="' + pal.deep + '"/></linearGradient>';
    defs += '<linearGradient id="' + u + 'gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>';
    defs += '<radialGradient id="' + u + 'disc" cx=".38" cy=".32" r=".8"><stop offset="0" stop-color="' + fi.disc[0] + '"/><stop offset=".55" stop-color="' + fi.disc[1] + '"/><stop offset="1" stop-color="' + fi.disc[2] + '"/></radialGradient>';
    defs += '<linearGradient id="' + u + 'ring" x1="0" y1="0" x2="1" y2="1">' + gradStops(fi.stops) + '</linearGradient>';
    defs += '<filter id="' + u + 'sh" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000" flood-opacity=".45"/></filter>';
    defs += '<clipPath id="' + u + 'in"><rect x="14" y="14" width="472" height="672" rx="22"/></clipPath>';
    defs += T.patternDef(d, u + 'pt');

    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 700" class="mc-svg" role="img" aria-label="' + esc(placementLabel(v) + ' — ' + v.athlete.name + ' — ' + v.event.name) + '"><defs>' + defs + '</defs>';
    // moldura (acabamento do tier) + borda holográfica nos raros
    s += '<rect x="0" y="0" width="500" height="700" rx="32" fill="url(#' + u + (rare ? 'holo' : 'fr') + ')"/>';
    if (rare) s += '<rect x="7" y="7" width="486" height="686" rx="27" fill="url(#' + u + 'fr)"/>';
    // fundo do evento
    s += '<g clip-path="url(#' + u + 'in)"><rect x="14" y="14" width="472" height="672" fill="url(#' + u + 'bg)"/><rect x="14" y="14" width="472" height="672" fill="url(#' + u + 'pt)"/>';
    // raios de luz atrás da medalha (só metal)
    if (!fi.flat) {
      var rays = '';
      for (var i = 0; i < 18; i++) rays += '<path d="M250 312 L' + (250 + 600 * Math.cos(i * Math.PI / 9)).toFixed(1) + ' ' + (312 + 600 * Math.sin(i * Math.PI / 9)).toFixed(1) + ' L' + (250 + 600 * Math.cos(i * Math.PI / 9 + 0.12)).toFixed(1) + ' ' + (312 + 600 * Math.sin(i * Math.PI / 9 + 0.12)).toFixed(1) + 'Z"/>';
      s += '<g fill="' + fi.stops[3] + '" opacity=".07">' + rays + '</g>';
    }
    // faixa diagonal do evento atrás do nome
    s += '<path d="M14 470 L486 420 L486 560 L14 610 Z" fill="' + pal.deep + '" opacity=".55"/>';
    s += '<rect x="14" y="14" width="472" height="330" fill="url(#' + u + 'gl)"/></g>';
    s += '<rect x="14" y="14" width="472" height="672" rx="22" fill="none" stroke="' + (rare ? '#fff6cf' : hi(fi)) + '" stroke-opacity=".7" stroke-width="2"/>';

    // topo: escudo + nome do evento
    s += '<g transform="translate(32 30) scale(.86)">' + T.crestSvg(d, u) + '</g>';
    var evMax = 330, ev = String(v.event.name || '').toUpperCase();
    var evSize = Math.min(30, Math.max(18, 330 / Math.max(10, ev.length) / F.k * 1.6));
    var evLines = wrap2(ev, evMax, evSize, F.k);
    evLines.forEach(function (ln, li) {
      var ff = fit(ln, evMax, evSize, 14, F.k);
      s += txt(134, 58 + li * (evSize + 2), ln, { size: ff.size, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: pal.ink, squeeze: ff.squeeze, maxW: evMax });
    });
    var sub = [T.SPORTS[v.event.sport] || v.event.sport, v.event.circuit].filter(Boolean).join(' · ').toUpperCase();
    s += txt(134, evLines.length > 1 ? 120 : 92, sub, { size: 13, family: BODY, weight: 700, fill: pal.accent, ls: 1.5 });

    // fita (V) com as cores do evento
    s += '<g filter="url(#' + u + 'sh)">';
    s += '<path d="M188 120 L238 120 L272 236 L234 250 Z" fill="' + pal.secondary + '"/><path d="M206 120 L220 120 L256 242 L246 246 Z" fill="' + pal.accent + '" opacity=".85"/>';
    s += '<path d="M312 120 L262 120 L228 236 L266 250 Z" fill="' + T.shade(pal.secondary, -8) + '"/><path d="M294 120 L280 120 L244 242 L254 246 Z" fill="' + pal.accent + '" opacity=".85"/>';
    // medalha
    s += '<circle cx="250" cy="312" r="106" fill="url(#' + u + 'ring)"/>';
    s += '</g>';
    s += '<circle cx="250" cy="312" r="93" fill="none" stroke="' + fi.emboss + '" stroke-width="3" opacity=".7"/>';
    s += '<circle cx="250" cy="312" r="88" fill="url(#' + u + 'disc)"/>';
    // louros em relevo
    var leaves = '';
    for (var j = 0; j < 9; j++) {
      var ang = (125 + j * 12) * Math.PI / 180, lx = 250 + 70 * Math.cos(ang), ly = 312 + 70 * Math.sin(ang), rot = 125 + j * 12 + 90;
      leaves += '<ellipse cx="' + lx.toFixed(1) + '" cy="' + ly.toFixed(1) + '" rx="10" ry="4.2" transform="rotate(' + rot + ' ' + lx.toFixed(1) + ' ' + ly.toFixed(1) + ')"/>';
      var ang2 = (55 - j * 12) * Math.PI / 180, rx2 = 250 + 70 * Math.cos(ang2), ry2 = 312 + 70 * Math.sin(ang2), rot2 = 55 - j * 12 - 90;
      leaves += '<ellipse cx="' + rx2.toFixed(1) + '" cy="' + ry2.toFixed(1) + '" rx="10" ry="4.2" transform="rotate(' + rot2 + ' ' + rx2.toFixed(1) + ' ' + ry2.toFixed(1) + ')"/>';
    }
    s += '<g fill="' + fi.emboss + '" opacity=".5">' + leaves + '</g>';
    // centro: número da colocação ou ícone
    var iconKey = AWARD_ICON[v.achievement] || (v.tier === 'FINISHER' ? (T.ICONS[d.crest.icon] ? d.crest.icon : 'TROPHY') : null);
    if (iconKey) {
      s += '<g transform="translate(212 268) scale(.76)" fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fff" stroke-opacity=".55" stroke-width="9" transform="translate(-2 -2)">' + T.ICONS[iconKey] + '</g><g stroke="' + fi.text + '" stroke-width="8">' + T.ICONS[iconKey] + '</g></g>';
    } else {
      var num = v.placement ? v.placement + 'º' : '★';
      s += txt(252, 340, num, { anchor: 'middle', size: 84, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: '#fff', opacity: 0.55 });
      s += txt(250, 338, num, { anchor: 'middle', size: 84, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: fi.text });
    }
    var discLabel = { TOP_SCORER: 'ARTILHARIA', MVP: 'DESTAQUE', RECORD: 'RECORDE' }[v.achievement] || fi.label;
    s += txt(250, 378, discLabel, { anchor: 'middle', size: 13, family: BODY, weight: 800, fill: fi.text, ls: 4, opacity: 0.85 });
    // reflexo no aro
    s += '<path d="M168 262 A100 100 0 0 1 300 214" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity=".45"/>';

    // numeração "1 DE 1"
    var ed = editionText(v);
    if (ed) {
      var ew = 24 + ed.length * 9.6;
      s += '<g transform="translate(' + (466 - ew) + ' 140)"><rect width="' + ew + '" height="30" rx="15" fill="#000" fill-opacity=".35" stroke="' + hi(fi) + '" stroke-opacity=".8"/>' + txt(ew / 2, 21, ed, { anchor: 'middle', size: 15, family: BODY, weight: 800, fill: '#fff', ls: 1 }) + '</g>';
    }
    // título raro (faixa)
    var dl = distinctionLabels(v);
    if (dl.length) {
      s += '<g transform="translate(34 140)"><rect width="' + (40 + dl[0].length * 10.6) + '" height="30" rx="6" fill="url(#' + u + 'holo)"/>' + txt(12, 21, '★ ' + dl[0], { size: 14, family: BODY, weight: 900, fill: '#1b1030', ls: 0.5 }) + '</g>';
    }

    // rótulo da colocação
    var pl = placementLabel(v), plf = fit(pl, 360, 46, 24, F.k);
    s += '<g transform="rotate(-6 250 470)">' + txt(250, 486, pl, { anchor: 'middle', size: plf.size, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: rare ? '#fff6cf' : fi.flat ? pal.accent : hi(fi), squeeze: plf.squeeze, maxW: 360 }) + '</g>';
    // atleta
    var nm = String(v.athlete.name || '').toUpperCase(), nf = fit(nm, 420, 40, 22, F.k);
    s += txt(250, 548, nm, { anchor: 'middle', size: nf.size, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: pal.ink, squeeze: nf.squeeze, maxW: 420 });
    var cat = String(v.event.category || '').toUpperCase();
    if (cat) s += txt(250, 578, cat, { anchor: 'middle', size: 15, family: BODY, weight: 700, fill: pal.ink, opacity: 0.8, ls: 2 });

    // rodapé
    s += '<path d="M40 616 H460" stroke="' + pal.ink + '" stroke-opacity=".25"/>';
    s += txt(40, 646, 'CLUB SPORTS & TENNIS', { size: 12, family: BODY, weight: 800, fill: pal.ink, opacity: 0.85, ls: 2 });
    s += txt(40, 664, v.serial || '', { size: 11, family: BODY, weight: 600, fill: pal.ink, opacity: 0.6, ls: 1 });
    var ok = v.status !== 'REVOKED';
    s += '<g transform="translate(460 640)">' + txt(0, 6, ok ? '✓ VERIFICADA' : '✕ REVOGADA', { anchor: 'end', size: 13, family: BODY, weight: 900, fill: ok ? pal.accent : '#ff5a5a', ls: 1.2 }) + txt(0, 24, 'OPEN BADGES 3.0', { anchor: 'end', size: 10, family: BODY, weight: 700, fill: pal.ink, opacity: 0.55, ls: 1.5 }) + '</g>';
    if (v.sample) s += '<g transform="rotate(-28 250 350)" opacity=".3">' + txt(250, 360, 'EXEMPLO', { anchor: 'middle', size: 92, family: BODY, weight: 900, fill: '#fff', ls: 6 }) + '</g>';
    if (!ok) s += stamp();
    return s + '</svg>';
  }

  function stamp() {
    return '<g transform="rotate(-18 250 350)"><rect x="70" y="300" width="360" height="96" rx="10" fill="#b00020" fill-opacity=".14" stroke="#ff3b3b" stroke-width="7"/>' +
      txt(250, 366, 'REVOGADA', { anchor: 'middle', size: 56, family: BODY, weight: 900, fill: '#ff3b3b', ls: 6 }) + '</g>';
  }

  // ---------- VERSO (súmula) ----------
  function qrSvg(qr, x, y, size) {
    if (!qr || !qr.bits) { // espaço reservado (prévia sem medalha emitida)
      return '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="8" fill="#fff"/>' + txt(x + size / 2, y + size / 2 + 5, 'QR', { anchor: 'middle', size: 22, family: BODY, weight: 900, fill: '#999' });
    }
    var n = qr.size, q = 2, cell = (size - 16) / (n + q * 2), p = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.bits.charCodeAt(r * n + c) === 49) p += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    return '<rect x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" rx="10" fill="#fff"/><path transform="translate(' + (x + 8) + ' ' + (y + 8) + ') scale(' + cell.toFixed(4) + ')" d="' + p + '" fill="#111"/>';
  }
  function back(v, opt) {
    opt = opt || {};
    var u = 'b' + (opt.uid || Math.random().toString(36).slice(2, 8));
    var d = v.design, pal = d.palette, fi = finishOf(v), rare = isRare(v), F = fontAttrs(d);
    var defs = '<linearGradient id="' + u + 'fr" x1="0" y1="0" x2="1" y2="1">' + gradStops(fi.stops) + '</linearGradient>' +
      '<linearGradient id="' + u + 'holo" x1="0" y1="0" x2="1" y2="1">' + gradStops(HOLO) + '</linearGradient>' +
      '<linearGradient id="' + u + 'hd" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + pal.primary + '"/><stop offset="1" stop-color="' + pal.deep + '"/></linearGradient>' +
      '<clipPath id="' + u + 'in"><rect x="14" y="14" width="472" height="672" rx="22"/></clipPath>' + T.patternDef(d, u + 'pt');
    var s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 700" class="mc-svg" role="img" aria-label="' + esc('Súmula da medalha ' + (v.serial || '')) + '"><defs>' + defs + '</defs>';
    s += '<rect width="500" height="700" rx="32" fill="url(#' + u + (rare ? 'holo' : 'fr') + ')"/>';
    if (rare) s += '<rect x="7" y="7" width="486" height="686" rx="27" fill="url(#' + u + 'fr)"/>';
    s += '<g clip-path="url(#' + u + 'in)"><rect x="14" y="14" width="472" height="672" fill="#121417"/><rect x="14" y="14" width="472" height="672" fill="url(#' + u + 'pt)" opacity=".5"/>';
    s += '<rect x="14" y="14" width="472" height="110" fill="url(#' + u + 'hd)"/><rect x="14" y="124" width="472" height="4" fill="' + pal.accent + '"/></g>';
    s += '<g transform="translate(30 28) scale(.68)">' + T.crestSvg(d, u) + '</g>';
    s += txt(108, 52, 'SÚMULA OFICIAL', { size: 12, family: BODY, weight: 900, fill: pal.accent, ls: 3 });
    var ev = String(v.event.name || '').toUpperCase(), ef = fit(ev, 350, 26, 16, F.k);
    s += txt(108, 84, ev, { size: ef.size, family: F.family, weight: F.weight, italic: F.italic, stretch: F.stretch, fill: pal.ink, squeeze: ef.squeeze, maxW: 350 });
    s += txt(108, 106, 'Nº DE SÉRIE ' + (v.serial || '—'), { size: 11, family: BODY, weight: 700, fill: pal.ink, opacity: 0.75, ls: 1.5 });

    var r = v.result || {};
    var vs = r.time ? ['TEMPO', r.time] : r.opponent ? ['ADVERSÁRIO', r.opponent] : ['ADVERSÁRIO / TEMPO', '—'];
    var rows = [
      [['ATLETA', v.athlete.name], ['CATEGORIA', v.event.category || '—']],
      [['DATA', fmtDate(v.event.date)], ['LOCAL', v.event.location || '—']],
      [['COLOCAÇÃO', placementLabel(v) + (editionText(v) ? ' · ' + editionText(v) : '')], ['RESULTADO', r.score || '—']],
      [[vs[0], vs[1]]],
    ];
    var y = 164;
    rows.forEach(function (row) {
      row.forEach(function (cell, ci) {
        var x = ci === 0 ? 36 : 262, w = row.length === 1 ? 428 : 200, val = String(cell[1] == null ? '—' : cell[1]);
        var vf = fit(val, w, 18, 12, 0.56);
        s += txt(x, y, cell[0], { size: 11, family: BODY, weight: 800, fill: '#fff', opacity: 0.5, ls: 1.8 });
        s += txt(x, y + 24, val, { size: vf.size, family: BODY, weight: 700, fill: '#fff', squeeze: vf.squeeze, maxW: w });
      });
      y += 62;
    });
    if (r.note) { s += txt(36, y - 6, String(r.note).slice(0, 70), { size: 12, family: BODY, weight: 500, fill: '#fff', opacity: 0.7 }); y += 12; }

    // organizador + assinatura
    var oy = Math.max(y + 8, 420);
    s += '<path d="M36 ' + (oy - 14) + ' H464" stroke="#fff" stroke-opacity=".12"/>';
    s += txt(36, oy + 6, 'ORGANIZADOR', { size: 11, family: BODY, weight: 800, fill: '#fff', opacity: 0.5, ls: 1.8 });
    var on = String(v.organizer.name || '—'), onf = fit(on, 196, 16, 11, 0.6);
    s += txt(36, oy + 30, on, { size: onf.size, family: BODY, weight: 800, fill: '#fff', squeeze: onf.squeeze, maxW: 196 });
    var sig = String(v.organizer.signatory || v.organizer.name || ''), sgf = fit(sig, 200, 30, 18, 0.42);
    s += txt(262, oy + 26, sig, { size: sgf.size, family: "'Caveat', 'Segoe Script', cursive", weight: 600, fill: pal.accent === '#ffffff' ? '#fff' : T.shade(pal.accent, 12), squeeze: sgf.squeeze, maxW: 200 });
    s += '<path d="M262 ' + (oy + 36) + ' H464" stroke="#fff" stroke-opacity=".5"/>';
    var did = String(v.organizer.did || '');
    s += txt(262, oy + 52, 'Assinatura digital Ed25519', { size: 9.5, family: BODY, weight: 700, fill: '#fff', opacity: 0.6 });
    s += txt(262, oy + 66, did ? did.slice(0, 18) + '…' + did.slice(-6) : '—', { size: 9.5, family: BODY, weight: 600, fill: '#fff', opacity: 0.5 });

    // QR + código
    var qy = 528;
    s += qrSvg(v.qr, 36, qy, 136);
    s += txt(194, qy + 18, 'CÓDIGO DE VERIFICAÇÃO', { size: 11, family: BODY, weight: 800, fill: '#fff', opacity: 0.5, ls: 1.8 });
    s += txt(194, qy + 50, v.verificationCode || '—', { size: 25, family: BODY, weight: 900, fill: '#fff', ls: 2 });
    var vu = String(v.verifyUrl || '').replace(/^https?:\/\//, '');
    var vuf = fit(vu, 270, 13, 9, 0.56);
    s += txt(194, qy + 76, vu, { size: vuf.size, family: BODY, weight: 700, fill: pal.accent === '#ffffff' ? '#fff' : T.shade(pal.accent, 10), squeeze: vuf.squeeze, maxW: 270 });
    s += txt(194, qy + 100, 'Open Badges 3.0 · confira sem login', { size: 11, family: BODY, weight: 600, fill: '#fff', opacity: 0.65 });
    s += txt(194, qy + 118, 'Intransferível · vinculada ao CPF do atleta', { size: 11, family: BODY, weight: 600, fill: '#fff', opacity: 0.65 });
    s += txt(194, qy + 136, v.status === 'REVOKED' ? 'Situação: REVOGADA' : 'Situação: válida', { size: 11, family: BODY, weight: 800, fill: v.status === 'REVOKED' ? '#ff5a5a' : '#7CF29A' });
    if (v.sample) s += '<g transform="rotate(-28 250 350)" opacity=".35">' + txt(250, 360, 'EXEMPLO', { anchor: 'middle', size: 92, family: BODY, weight: 900, fill: '#fff', ls: 6 }) + '</g>';
    if (v.status === 'REVOKED') s += stamp();
    return s + '</svg>';
  }

  // ===================== DOM (navegador) =====================
  var loadedCss = {};
  function ensureFonts(design) {
    if (typeof document === 'undefined') return;
    var href = T.fontCssUrl(design);
    if (loadedCss[href]) return;
    loadedCss[href] = 1;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l);
  }

  function reduceMotion() { return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // Monta a carta interativa. opts: { reveal, flippable, tilt, onFlip }
  function mount(container, v, opts) {
    opts = opts || {};
    ensureFonts(v.design);
    var uid = Math.random().toString(36).slice(2, 8);
    var rare = isRare(v);
    var el = document.createElement('div');
    el.className = 'mc mc-' + String(v.tier || 'GOLD').toLowerCase() + (rare ? ' mc-rare' : '') + (v.status === 'REVOKED' ? ' mc-revoked' : '');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', 'Carta da medalha. Toque para virar e ver a súmula.');
    el.innerHTML = '<div class="mc-tilt"><div class="mc-card">' +
      '<div class="mc-face mc-front">' + front(v, { uid: uid }) + '<i class="mc-holo"></i><i class="mc-glare"></i><i class="mc-sweep"></i></div>' +
      '<div class="mc-face mc-back">' + back(v, { uid: uid }) + '<i class="mc-glare"></i></div>' +
      '</div></div>';
    container.appendChild(el);
    var tilt = el.querySelector('.mc-tilt');
    var flipped = false;
    function flip() { flipped = !flipped; el.classList.toggle('is-flipped', flipped); if (opts.onFlip) opts.onFlip(flipped); }
    if (opts.flippable !== false) {
      el.addEventListener('click', flip);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    }
    if (opts.tilt !== false && !reduceMotion()) {
      var set = function (px, py) {
        el.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
        el.style.setProperty('--my', (py * 100).toFixed(1) + '%');
        el.style.setProperty('--rx', ((0.5 - py) * 18).toFixed(2) + 'deg');
        el.style.setProperty('--ry', ((px - 0.5) * 22).toFixed(2) + 'deg');
        el.style.setProperty('--hp', (px * 100).toFixed(1) + '%');
      };
      el.addEventListener('pointermove', function (e) {
        var r = tilt.getBoundingClientRect();
        set(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
        el.classList.add('is-hover');
      });
      el.addEventListener('pointerleave', function () { el.classList.remove('is-hover'); set(0.5, 0.5); });
      if (opts.gyro && typeof window !== 'undefined' && 'DeviceOrientationEvent' in window) {
        window.addEventListener('deviceorientation', function (e) {
          if (e.gamma == null) return;
          set(Math.min(1, Math.max(0, 0.5 + e.gamma / 60)), Math.min(1, Math.max(0, 0.5 + (e.beta - 45) / 60)));
          el.classList.add('is-hover');
        });
      }
      set(0.5, 0.5);
    }
    if (opts.reveal && !reduceMotion()) reveal(el, v);
    return { el: el, flip: flip };
  }

  // Abertura estilo "pacote": giro + explosão de luz + faíscas (mais forte quanto mais raro).
  function reveal(el, v) {
    var rare = isRare(v), power = rare ? 3 : v.tier === 'GOLD' ? 2 : v.tier === 'FINISHER' ? 0 : 1;
    var stage = document.createElement('div');
    stage.className = 'mc-burst mc-burst-' + power;
    var sparks = '';
    var n = [0, 10, 18, 30][power];
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 360, dist = 120 + Math.random() * 160, dl = Math.random() * 0.5;
      sparks += '<b style="--a:' + a.toFixed(0) + 'deg;--d:' + dist.toFixed(0) + 'px;--dl:' + (0.55 + dl).toFixed(2) + 's"></b>';
    }
    stage.innerHTML = '<i class="mc-rays"></i>' + sparks;
    el.insertBefore(stage, el.firstChild);
    el.classList.add('is-revealing');
    setTimeout(function () { el.classList.remove('is-revealing'); }, 1900);
    setTimeout(function () { if (stage.parentNode) stage.parentNode.removeChild(stage); }, 2600);
  }

  // ---------- imagem estática (PNG) com credencial embutida ----------
  var fontDataCache = {};
  function inlineFonts(design) {
    var url = T.fontCssUrl(design);
    if (fontDataCache[url]) return fontDataCache[url];
    fontDataCache[url] = fetch(url).then(function (r) { return r.text(); }).then(function (css) {
      // só os blocos latin/latin-ext (português)
      var blocks = css.split('@font-face').slice(1).filter(function (b) { return /U\+0000-00FF|U\+0100-02BA|U\+0100-024F/.test(b); });
      return Promise.all(blocks.map(function (b) {
        var m = /url\((https:[^)]+)\)/.exec(b);
        if (!m) return '';
        return fetch(m[1]).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
          var bin = '', by = new Uint8Array(buf);
          for (var i = 0; i < by.length; i += 0x8000) bin += String.fromCharCode.apply(null, by.subarray(i, i + 0x8000));
          return '@font-face' + b.replace(m[1], 'data:font/woff2;base64,' + btoa(bin));
        });
      })).then(function (arr) { return arr.join('\n'); });
    }).catch(function () { return ''; });
    return fontDataCache[url];
  }
  var CRC;
  function crc32(bytes) {
    if (!CRC) { CRC = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
    var x = 0xffffffff; for (var i = 0; i < bytes.length; i++) x = CRC[(x ^ bytes[i]) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0;
  }
  function bake(pngBytes, jwt) {
    var enc = new TextEncoder(), kw = enc.encode('openbadgecredential'), tx = enc.encode(jwt);
    var data = new Uint8Array(kw.length + 5 + tx.length); data.set(kw, 0); data.set(tx, kw.length + 5);
    var typeData = new Uint8Array(4 + data.length); typeData.set(enc.encode('iTXt'), 0); typeData.set(data, 4);
    var chunk = new Uint8Array(12 + data.length), dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length); chunk.set(typeData, 4); dv.setUint32(8 + data.length, crc32(typeData));
    var ihdrEnd = 8 + 8 + new DataView(pngBytes.buffer, pngBytes.byteOffset).getUint32(8) + 4;
    var out = new Uint8Array(pngBytes.length + chunk.length);
    out.set(pngBytes.subarray(0, ihdrEnd), 0); out.set(chunk, ihdrEnd); out.set(pngBytes.subarray(ihdrEnd), ihdrEnd + chunk.length);
    return out;
  }
  // opts: { side: 'front'|'back'|'both', width: 1000 }
  function toPng(v, opts) {
    opts = opts || {};
    var side = opts.side || 'front', W = opts.width || 1000, H = Math.round(W * 1.4);
    return inlineFonts(v.design).then(function (fontCss) {
      var style = fontCss ? '<style>' + fontCss + '</style>' : '';
      var draw = function (svg) {
        svg = svg.replace('<defs>', '<defs>' + style).replace('<svg ', '<svg width="' + W + '" height="' + H + '" ');
        return new Promise(function (res, rej) {
          var img = new Image();
          img.onload = function () { res(img); };
          img.onerror = rej;
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        });
      };
      var sides = side === 'both' ? [front(v, { uid: 'pf' }), back(v, { uid: 'pb' })] : [side === 'back' ? back(v, { uid: 'pb' }) : front(v, { uid: 'pf' })];
      return Promise.all(sides.map(draw)).then(function (imgs) {
        var gap = side === 'both' ? Math.round(W * 0.06) : 0;
        var cv = document.createElement('canvas');
        cv.width = W * imgs.length + gap * (imgs.length - 1); cv.height = H;
        var ctx = cv.getContext('2d');
        imgs.forEach(function (im, i) { ctx.drawImage(im, i * (W + gap), 0, W, H); });
        return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
      });
    }).then(function (blob) {
      if (!v.credentialJwt) return blob;
      return blob.arrayBuffer().then(function (buf) { return new Blob([bake(new Uint8Array(buf), v.credentialJwt)], { type: 'image/png' }); });
    });
  }
  function fileName(v) { return 'medalha-' + String(v.serial || 'club').toLowerCase() + '.png'; }
  // Compartilhar (celular) ou baixar (desktop).
  function share(v, opts) {
    return toPng(v, opts).then(function (blob) {
      var file = typeof File !== 'undefined' ? new File([blob], fileName(v), { type: 'image/png' }) : null;
      var text = placementLabel(v) + ' — ' + v.event.name + '. Medalha verificada: ' + (v.verifyUrl || '');
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: 'Minha medalha', text: text }).then(function () { return 'shared'; }).catch(function () { return 'cancelled'; });
      }
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName(v);
      document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
      return 'downloaded';
    });
  }

  return {
    front: front, back: back, mount: mount, reveal: reveal, toPng: toPng, share: share, bake: bake, ensureFonts: ensureFonts,
    placementLabel: placementLabel, distinctionLabels: distinctionLabels, isRare: isRare, editionText: editionText, TIER: TIER,
  };
});
