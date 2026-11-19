/* Club Sports & Tennis — MODO TELÃO (/t/:slug/telao)
 * ES5 de propósito: TV de ginásio costuma ter navegador antigo.
 * Dados: /api/public/tournaments/:slug · Tempo real: SSE /api/tournaments/:id/live
 */
(function () {
  'use strict';
  var C = window.CLUB_TELAO || {};
  var main = document.getElementById('main');
  var bar = document.getElementById('bar');
  var eye = document.getElementById('eye');
  var DATA = null, SLIDES = [], IDX = -1, TIMER = null, POLL = null, ES = null, SSE_OK = false, REFRESH = null;
  var STAGE = { FINAL: 'Final', SEMI: 'Semifinal', THIRD: '3º lugar', QUARTER: 'Quartas', RO16: 'Oitavas', RO32: '16-avos', RO64: '32-avos' };

  function esc(s) { s = s == null ? '' : String(s); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function hue(s) { var h = 0; s = String(s || ''); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
  function ini(s) { var p = String(s || '?').replace(/[^0-9A-Za-zÀ-ÿ ]/g, ' ').replace(/^\s+|\s+$/g, '').split(/\s+/); return ((p[0] || '?').charAt(0) + (p[1] || '').charAt(0)).toUpperCase(); }
  function crest(e, size) {
    var st = 'width:' + size + ';height:' + size + ';';
    if (e && e.logoUrl) return '<span class="crest" style="' + st + '"><img src="' + esc(e.logoUrl) + '" alt=""></span>';
    return '<span class="crest" style="' + st + 'background:hsl(' + hue(e ? e.name : '?') + ',45%,32%);font-size:calc(' + size + ' * .42)">' + esc(e ? ini(e.name) : '?') + '</span>';
  }
  function tname(m, side) { var e = m[side]; return e ? e.name : (side === 'home' ? m.homeSourceLabel : m.awaySourceLabel) || 'A definir'; }
  function hm(d) { try { return new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' }); } catch (e) { return ''; } }
  function dm(d) { try { return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Fortaleza' }); } catch (e) { return ''; } }
  function today(d) { return dm(d) === dm(new Date()); }
  function stage(m) { return m.stage === 'GROUP' ? 'Grupo ' + (m.groupName || '?') : m.stage === 'LEAGUE' ? 'Rodada ' + m.round : (STAGE[m.stage] || m.stage); }
  function score(m, side) {
    if (m.status === 'LIVE' && m.liveScore) return m.liveScore[side];
    var v = side === 'home' ? m.homeScore : m.awayScore; return v == null ? '-' : v;
  }

  // ---------- relógio ----------
  function tick() { var el = document.getElementById('clock'); if (el) el.textContent = hm(new Date()); }
  tick(); setInterval(tick, 10000);

  // ---------- slides ----------
  function allMatches() {
    var out = [];
    if (!DATA) return out;
    DATA.categories.forEach(function (c) {
      if (C.categoria && c.id !== C.categoria) return;
      c.matches.forEach(function (m) { m._cat = c.name; out.push(m); });
    });
    return out;
  }
  function evRow(t) {
    var ic = t.type === 'GOAL' ? '<span class="g"></span>' : '<span class="k' + (t.type === 'RED' ? ' r' : '') + '"></span>';
    return '<div class="ev' + (t.side === 'away' ? ' a' : '') + '">' + ic + '<b>' + (t.minute != null ? t.minute + "'" : '') + '</b><span>' + esc((t.number != null ? t.number + ' ' : '') + (t.player || (t.type === 'GOAL' ? 'Gol' : 'Cartão'))) + '</span></div>';
  }
  function liveSlide(ms) {
    var one = ms.length === 1;
    var h = '<div class="st fade"><span class="lv">AO VIVO</span>' + (one ? esc(ms[0]._cat) + ' <small>' + esc(stage(ms[0])) + '</small>' : '<small>' + ms.length + ' jogos agora</small>') + '</div><div class="lives fade">';
    ms.forEach(function (m) {
      var tl = (m.timeline || []).slice(-(one ? 5 : 4)).reverse();
      h += '<div class="lm' + (one ? ' one' : '') + '">' + (one ? '' : '<div class="cat">' + esc(m._cat) + ' · ' + esc(stage(m)) + '</div>') +
        '<div class="row"><div class="sd">' + crest(m.home, one ? '20vh' : '14vh') + '<div class="nm">' + esc(tname(m, 'home')) + '</div></div>' +
        '<div class="sc"><span>' + esc(score(m, 'home')) + '</span><i>×</i><span>' + esc(score(m, 'away')) + '</span></div>' +
        '<div class="sd">' + crest(m.away, one ? '20vh' : '14vh') + '<div class="nm">' + esc(tname(m, 'away')) + '</div></div></div>' +
        '<div class="tlx">' + tl.map(evRow).join('') + '</div></div>';
    });
    return h + '</div>';
  }
  function matchItem(m, showDay) {
    var done = m.status === 'FINISHED' || m.status === 'WALKOVER';
    var hw = done && m.winnerEntryId && m.home && m.winnerEntryId === m.home.id;
    var aw = done && m.winnerEntryId && m.away && m.winnerEntryId === m.away.id;
    var left = done ? '<div class="hr">FIM<small>' + (m.scheduledAt ? dm(m.scheduledAt) : '') + '</small></div>'
      : '<div class="hr">' + (m.scheduledAt ? hm(m.scheduledAt) : '--:--') + (showDay && m.scheduledAt ? '<small>' + dm(m.scheduledAt) + '</small>' : '') + '</div>';
    return '<div class="mi">' + left + '<div class="tm">' +
      '<div class="ln' + (hw ? ' w' : '') + '">' + crest(m.home, '4.4vh') + '<span>' + esc(tname(m, 'home')) + '</span>' + (done ? '<b>' + esc(score(m, 'home')) + '</b>' : '') + '</div>' +
      '<div class="ln' + (aw ? ' w' : '') + '">' + crest(m.away, '4.4vh') + '<span>' + esc(tname(m, 'away')) + '</span>' + (done ? '<b>' + esc(score(m, 'away')) + '</b>' : '') + '</div>' +
      '<div class="sub">' + esc([m._cat, stage(m), m.location].filter(Boolean).join(' · ')) + '</div></div></div>';
  }
  function tableSlide(c, groups) {
    var h = '<div class="st fade">Classificação <small>' + esc(c.name) + '</small></div><div class="groups fade">';
    groups.forEach(function (g) {
      h += '<div class="grp">' + (g.name ? '<h3>Grupo ' + esc(g.name) + '</h3>' : '') +
        '<table><thead><tr><th>#</th><th class="l">Equipe</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>P</th></tr></thead><tbody>';
      g.rows.forEach(function (r, i) {
        h += '<tr' + (i < 2 ? ' class="q"' : '') + '><td>' + (r.rank || i + 1) + '</td><td class="l">' + crest(r.entry, '3.6vh') + esc(r.entry ? r.entry.name : '?') + '</td><td>' + r.played + '</td><td>' + r.won + '</td><td>' + r.drawn + '</td><td>' + r.lost + '</td><td>' + r.goalDiff + '</td><td>' + r.points + '</td></tr>';
      });
      h += '</tbody></table></div>';
    });
    return h + '</div>';
  }
  function scorersSlide(c) {
    var rows = c.scorers.slice(0, 10);
    var h = '<div class="st fade">Artilharia <small>' + esc(c.name) + '</small></div><div class="sc-list fade">';
    rows.forEach(function (r, i) {
      h += '<div class="sr' + (i < 3 ? ' top' : '') + '"><span class="ps">' + (i + 1) + 'º</span><div class="pn"><div>' + esc((r.number != null ? r.number + ' ' : '') + r.name) + '</div><small>' + esc(r.team) + '</small></div><span class="gl">' + r.goals + '</span></div>';
    });
    return h + '</div>';
  }
  function sponsorsSlide() {
    return '<div class="st fade">Patrocínio</div><div class="spg fade">' + DATA.sponsors.map(function (s) {
      return '<div class="spc">' + (s.logoUrl ? '<img src="' + esc(s.logoUrl) + '" alt="' + esc(s.name) + '">' : '<b>' + esc(s.name) + '</b>') + '</div>';
    }).join('') + '</div>';
  }

  function buildSlides() {
    var S = [];
    var ms = allMatches();
    var lives = ms.filter(function (m) { return m.status === 'LIVE'; });
    var now = Date.now();
    var next = ms.filter(function (m) { return m.status === 'SCHEDULED' && m.scheduledAt && new Date(m.scheduledAt).getTime() > now - 30 * 60000; })
      .sort(function (a, b) { return new Date(a.scheduledAt) - new Date(b.scheduledAt); }).slice(0, 8);
    var recent = ms.filter(function (m) { return (m.status === 'FINISHED' || m.status === 'WALKOVER') && m.homeScore != null; })
      .sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); }).slice(0, 8);
    var liveSlides = [];
    for (var i = 0; i < lives.length; i += 2) liveSlides.push({ k: 'live', html: liveSlide.bind(null, lives.slice(i, i + 2)), eye: 'Ao vivo agora' });
    var rest = [];
    if (next.length) {
      var allToday = next.every(function (m) { return today(m.scheduledAt); });
      rest.push({ k: 'next', eye: 'Agenda', html: function () { return '<div class="st fade">' + (allToday ? 'Próximos jogos de hoje' : 'Próximos jogos') + '</div><div class="list fade">' + next.map(function (m) { return matchItem(m, !allToday); }).join('') + '</div>'; } });
    }
    if (recent.length) rest.push({ k: 'recent', eye: 'Resultados', html: function () { return '<div class="st fade">Últimos resultados</div><div class="list fade">' + recent.map(function (m) { return matchItem(m); }).join('') + '</div>'; } });
    DATA.categories.forEach(function (c) {
      if (C.categoria && c.id !== C.categoria) return;
      if (c.standings && c.standings.length) {
        var by = {}, order = [];
        c.standings.forEach(function (s) { var g = s.groupName || ''; if (!by[g]) { by[g] = []; order.push(g); } by[g].push(s); });
        order.sort();
        for (var j = 0; j < order.length; j += 3) {
          (function (gs) { rest.push({ k: 'table', eye: c.name, html: function () { return tableSlide(c, gs); } }); })(order.slice(j, j + 3).map(function (g) { return { name: g, rows: by[g].slice(0, 8) }; }));
        }
      }
      if (c.scorers && c.scorers.length) rest.push({ k: 'scorers', eye: c.name, html: function () { return scorersSlide(c); } });
    });
    if (DATA.sponsors && DATA.sponsors.length) rest.push({ k: 'sponsors', eye: 'Patrocínio', html: sponsorsSlide });
    // jogo ao vivo aparece a cada 2 slides
    if (liveSlides.length) {
      var li = 0;
      S.push(liveSlides[li++ % liveSlides.length]);
      rest.forEach(function (r, ix) { S.push(r); if (ix % 2 === 1) S.push(liveSlides[li++ % liveSlides.length]); });
    } else S = rest;
    if (!S.length) S.push({ k: 'empty', eye: 'Em breve', html: function () { return '<div class="empty">Tabela em breve</div>'; } });
    SLIDES = S;
  }

  function show(i) {
    if (!SLIDES.length) return;
    IDX = i % SLIDES.length;
    var s = SLIDES[IDX];
    main.innerHTML = s.html();
    eye.textContent = s.eye || 'Ao vivo no ginásio';
    var dur = (C.tempo || 12) * 1000 * (s.k === 'live' ? 1.4 : 1);
    bar.style.transition = 'none'; bar.style.width = '0';
    setTimeout(function () { bar.style.transition = 'width ' + dur + 'ms linear'; bar.style.width = '100%'; }, 30);
    clearTimeout(TIMER);
    TIMER = setTimeout(function () { show(IDX + 1); }, dur);
  }
  function rerenderCurrent() {
    var cur = SLIDES[IDX];
    var k = cur ? cur.k : null;
    buildSlides();
    // fica no mesmo tipo de slide se ainda existir (não "pula" no meio)
    var j = -1;
    for (var i = 0; i < SLIDES.length; i++) if (SLIDES[i].k === k) { j = i; break; }
    if (j < 0) { show(0); return; }
    IDX = j; main.innerHTML = SLIDES[j].html();
  }

  function ticker() {
    var el = document.getElementById('tick');
    var sp = (DATA && DATA.sponsors) || [];
    if (!sp.length) { el.innerHTML = '<span class="chip"><b>Club Sports &amp; Tennis</b></span>'; document.getElementById('splb').textContent = ''; return; }
    var one = sp.map(function (s) { return '<span class="chip">' + (s.logoUrl ? '<img src="' + esc(s.logoUrl) + '" alt="' + esc(s.name) + '">' : '<b>' + esc(s.name) + '</b>') + '</span>'; }).join('');
    el.innerHTML = one + one;
  }

  function load(first) {
    var x = new XMLHttpRequest();
    x.open('GET', '/api/public/tournaments/' + encodeURIComponent(C.slug) + '?_=' + Date.now());
    x.onload = function () {
      if (x.status !== 200) return;
      try { DATA = JSON.parse(x.responseText); } catch (e) { return; }
      if (first) { buildSlides(); ticker(); show(0); } else { rerenderCurrent(); ticker(); }
    };
    x.send();
  }
  function scheduleRefresh() { clearTimeout(REFRESH); REFRESH = setTimeout(function () { load(false); }, 700); }

  // ---------- GOL! ----------
  var GT = null;
  function overlay(big, who, sc) {
    document.getElementById('gbig').textContent = big;
    document.getElementById('gwho').textContent = who || '';
    document.getElementById('gsc').textContent = sc || '';
    var g = document.getElementById('goal'); g.className = 'goal on';
    clearTimeout(GT); GT = setTimeout(function () { g.className = 'goal'; }, 7000);
  }
  function onLive(msg) {
    if (!msg || !msg.match) { if (msg && msg.type === 'hello') scheduleRefresh(); return; }
    var m = msg.match;
    if (C.categoria && m.categoryId !== C.categoria) return;
    var h = m.homeEntry ? m.homeEntry.name : 'Casa', a = m.awayEntry ? m.awayEntry.name : 'Visitante';
    var sc = h + '  ' + m.liveScore.home + ' × ' + m.liveScore.away + '  ' + a;
    if ((msg.type === 'event' || msg.type === 'start') && msg.last && msg.last.type === 'GOAL') {
      var team = msg.last.side === 'home' ? h : a;
      overlay('GOL!', (msg.last.player ? msg.last.player + ' · ' : '') + team, sc);
    } else if (msg.type === 'end') {
      overlay('FIM', 'Fim de jogo', h + '  ' + (m.homeScore != null ? m.homeScore : m.liveScore.home) + ' × ' + (m.awayScore != null ? m.awayScore : m.liveScore.away) + '  ' + a);
    }
    scheduleRefresh();
  }
  function connect() {
    // Liga F4: reconexão com espera crescente (live-sse.js); consulta de 20 s SÓ com o SSE caído
    if (window.ClubLiveSSE) {
      ES = window.ClubLiveSSE.connect('/api/tournaments/' + encodeURIComponent(C.tid) + '/live', {
        onMessage: onLive,
        onState: function (ok) {
          SSE_OK = ok;
          if (ok) { if (POLL) { clearInterval(POLL); POLL = null; } } else if (!POLL) POLL = setInterval(function () { load(false); }, 20000);
        },
      });
      return;
    }
    if (!window.EventSource) { POLL = setInterval(function () { load(false); }, 20000); return; }
    ES = new EventSource('/api/tournaments/' + encodeURIComponent(C.tid) + '/live');
    ES.onopen = function () { SSE_OK = true; if (POLL) { clearInterval(POLL); POLL = null; } };
    ES.onmessage = function (e) { try { onLive(JSON.parse(e.data)); } catch (_) { /* ignora */ } };
    ES.onerror = function () {
      SSE_OK = false;
      if (!POLL) POLL = setInterval(function () { load(false); }, 20000); // fallback: polling
    };
  }

  // ---------- TV: tela cheia, tela acesa, cursor some ----------
  var hint = document.getElementById('hint');
  setTimeout(function () { hint.style.opacity = '0'; }, 6000);
  document.addEventListener('click', function () {
    var d = document.documentElement;
    var rq = d.requestFullscreen || d.webkitRequestFullscreen || d.msRequestFullscreen;
    if (rq && !document.fullscreenElement && !document.webkitFullscreenElement) { try { rq.call(d); } catch (e) { /* ignore */ } }
    wake();
  });
  var idleT = null;
  document.addEventListener('mousemove', function () { document.body.className = ''; clearTimeout(idleT); idleT = setTimeout(function () { document.body.className = 'idle'; }, 3000); });
  function wake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(function () {}); } catch (e) { /* ignore */ } }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { wake(); load(false); } });
  wake();

  load(true);
  connect();
  setInterval(function () { if (SSE_OK) load(false); }, 60000); // horários/tabela mudam fora do ao vivo
})();
