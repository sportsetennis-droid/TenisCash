/* =====================================================================
 * ESTANTE DE TROFÉUS do atleta — por esporte e por série/circuito, com
 * ESPAÇOS VAZIOS visíveis pro que falta no pódio da mesma série
 * (ex.: tem bronze e prata do circuito → aparece o encaixe do ouro vazio).
 * Vitrine no topo = as 3 maiores conquistas (raridade > tier > data).
 * Depende de MedalCard e MedalTemplate.
 * ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./medal-card.js'), require('./medal-template.js'));
  else root.MedalShelf = factory(root.MedalCard, root.MedalTemplate);
})(typeof self !== 'undefined' ? self : this, function (C, T) {
  'use strict';
  var esc = T.esc;
  var TIER_SCORE = { GOLD: 30, SPECIAL: 28, SILVER: 20, BRONZE: 10, FINISHER: 1 };
  var PODIUM = ['GOLD', 'SILVER', 'BRONZE'];
  var MISSING = { GOLD: 'Falta o ouro', SILVER: 'Falta a prata', BRONZE: 'Falta o bronze' };
  var TIER_COLOR = { GOLD: '#e8c35a', SILVER: '#c7ced6', BRONZE: '#c98450' };

  function score(v) { return (C.isRare(v) ? 100 : 0) + (TIER_SCORE[v.tier] || 0) + (new Date(v.issuedAt || v.event.date || 0).getTime() / 1e13); }
  function top3(medals) { return medals.slice().sort(function (a, b) { return score(b) - score(a); }).slice(0, 3); }

  // Agrupa: esporte → série → medalhas
  function group(medals) {
    var sports = {};
    medals.forEach(function (v) {
      var sp = v.event.sport || 'GENERIC';
      var s = sports[sp] || (sports[sp] = { sport: sp, label: T.SPORTS[sp] || sp, series: {}, count: 0 });
      var key = v.series || ('event:' + v.event.name + ':' + (v.event.category || ''));
      var se = s.series[key] || (s.series[key] = { key: key, title: v.event.circuit || v.event.name, sub: v.event.category || '', isCircuit: !!v.event.circuit, medals: [] });
      se.medals.push(v); s.count += 1;
    });
    return Object.keys(sports).map(function (k) {
      var s = sports[k];
      s.series = Object.keys(s.series).map(function (x) { return s.series[x]; }).sort(function (a, b) { return Math.max.apply(null, b.medals.map(score)) - Math.max.apply(null, a.medals.map(score)); });
      return s;
    }).sort(function (a, b) { return b.count - a.count; });
  }

  function mini(v, i) {
    return '<button type="button" class="ms-card ms-' + String(v.tier).toLowerCase() + (C.isRare(v) ? ' ms-rare' : '') + '" data-i="' + i + '" aria-label="' + esc(C.placementLabel(v) + ' — ' + v.event.name) + '">' + C.front(v, { uid: 's' + i }) + '<i class="ms-shine"></i></button>';
  }
  function empty(tier) {
    return '<div class="ms-empty ms-empty-' + tier.toLowerCase() + '" aria-label="' + MISSING[tier] + '"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="none" stroke="' + TIER_COLOR[tier] + '" stroke-width="3" stroke-dasharray="6 6"/><text x="50" y="58" text-anchor="middle" font-size="22" font-weight="900" fill="' + TIER_COLOR[tier] + '" font-family="Archivo, sans-serif">' + (PODIUM.indexOf(tier) + 1) + 'º</text></svg><span>' + MISSING[tier] + '</span></div>';
  }

  function render(el, medals, opts) {
    opts = opts || {};
    medals = medals || [];
    var all = [];
    var html = '';
    if (!medals.length) {
      el.innerHTML = '<div class="ms-none"><p><b>A estante ainda está vazia.</b></p><p>As medalhas aparecem aqui quando o organizador do evento confirma o resultado e emite.</p></div>';
      return;
    }
    medals.forEach(function (v) { C.ensureFonts(v.design); });
    // números
    var cnt = function (t) { return medals.filter(function (v) { return v.tier === t; }).length; };
    var rare = medals.filter(C.isRare).length, sportsN = group(medals).length;
    html += '<div class="ms-stats">' +
      [['Medalhas', medals.length], ['Ouro', cnt('GOLD')], ['Prata', cnt('SILVER')], ['Bronze', cnt('BRONZE')], ['Raras', rare], [sportsN === 1 ? 'Esporte' : 'Esportes', sportsN]]
        .map(function (x) { return '<div><b>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('') + '</div>';
    // vitrine
    if (opts.showcase !== false) {
      html += '<h3 class="ms-h">Vitrine</h3><div class="ms-showcase">' + top3(medals).map(function (v) { var i = all.push(v) - 1; return mini(v, i); }).join('') + '</div>';
    }
    // por esporte → série
    group(medals).forEach(function (s) {
      html += '<section class="ms-sport"><h3 class="ms-h">' + esc(s.label) + ' <small>' + s.count + (s.count === 1 ? ' medalha' : ' medalhas') + '</small></h3>';
      s.series.forEach(function (se) {
        var podiumHas = se.medals.some(function (v) { return PODIUM.indexOf(v.tier) >= 0 && v.achievement === 'PLACEMENT'; });
        var cells = '';
        if (podiumHas) {
          PODIUM.forEach(function (t) {
            var got = se.medals.filter(function (v) { return v.tier === t && v.achievement === 'PLACEMENT'; });
            if (!got.length) cells += empty(t);
            got.forEach(function (v) { var i = all.push(v) - 1; cells += mini(v, i); });
          });
          se.medals.filter(function (v) { return !(PODIUM.indexOf(v.tier) >= 0 && v.achievement === 'PLACEMENT'); }).forEach(function (v) { var i = all.push(v) - 1; cells += mini(v, i); });
        } else {
          se.medals.forEach(function (v) { var i = all.push(v) - 1; cells += mini(v, i); });
        }
        var missing = podiumHas ? PODIUM.filter(function (t) { return !se.medals.some(function (v) { return v.tier === t && v.achievement === 'PLACEMENT'; }); }).length : 0;
        html += '<div class="ms-series"><div class="ms-series-h"><b>' + esc(se.title) + '</b>' + (se.sub ? '<span>' + esc(se.sub) + '</span>' : '') +
          (podiumHas ? '<em>' + (3 - missing) + ' de 3 do pódio</em>' : '') + '</div><div class="ms-row">' + cells + '</div></div>';
      });
      html += '</section>';
    });
    el.innerHTML = '<div class="ms">' + html + '</div>';
    el.querySelectorAll('.ms-card').forEach(function (b) {
      b.addEventListener('click', function () { if (opts.onOpen) opts.onOpen(all[+b.dataset.i]); });
    });
    // medalha 3D (foto renderizada) nas miniaturas, em sequência pra não travar o celular
    function photos() {
      var btns = Array.prototype.slice.call(el.querySelectorAll('.ms-card'));
      btns.reduce(function (p, b) {
        return p.then(function () {
          var v = all[+b.dataset.i];
          return C.medalPhoto(v, 300, 360, 'normal').then(function (url) {
            if (url && b.isConnected) { var svg = b.querySelector('svg'); if (svg) svg.outerHTML = C.front(v, { uid: 'p' + b.dataset.i, medalImage: url }); }
          });
        });
      }, Promise.resolve());
    }
    if (C.has3d()) photos(); else if (typeof window !== 'undefined') window.addEventListener('medal3d-ready', photos, { once: true });
  }

  // Bottom-sheet com a carta animada + ações.
  function openSheet(sheet, v, opts) {
    opts = opts || {};
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    sheet.innerHTML = '<div class="mu-sheet-bg" data-x></div><div class="mu-sheet-box" role="dialog" aria-modal="true" aria-label="Medalha"><button type="button" class="mu-x" data-x aria-label="Fechar">✕</button><div class="mu-sheet-card"></div>' +
      '<p class="mu-hint">Toque na carta para ver a súmula</p><div class="mu-actions mu-actions-big">' +
      '<button type="button" class="mu-btn mu-btn-main" data-a="share">Compartilhar imagem</button>' +
      '<a class="mu-btn" href="' + esc(v.verifyUrl || '#') + '" target="_blank" rel="noopener">Verificar</a></div>' +
      (v.ownershipCode ? '<p class="mu-own">Código de titularidade (só seu): <code>' + esc(v.ownershipCode) + '</code><br><small>Com ele e o seu CPF, qualquer pessoa confirma que a medalha é sua.</small></p>' : '') + '</div>';
    C.mount(sheet.querySelector('.mu-sheet-card'), v, { reveal: opts.reveal !== false, gyro: true });
    function close() { C.unmount(sheet); sheet.hidden = true; sheet.innerHTML = ''; document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    sheet.querySelectorAll('[data-x]').forEach(function (x) { x.addEventListener('click', close); });
    sheet.querySelector('[data-a="share"]').addEventListener('click', function (e) {
      var b = e.currentTarget; b.disabled = true; b.textContent = 'Gerando…';
      C.share(v, { side: 'front' }).then(function (r) { b.textContent = r === 'downloaded' ? 'Imagem baixada' : 'Compartilhar imagem'; }).catch(function () { b.textContent = 'Não deu — tente de novo'; }).finally(function () { b.disabled = false; });
    });
    return close;
  }

  return { render: render, openSheet: openSheet, group: group, top3: top3 };
});
