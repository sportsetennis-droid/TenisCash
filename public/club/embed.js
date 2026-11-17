/* Club Sports & Tennis — EMBED (/t/:slug/embed) para iframe em qualquer site.
 * Avisa a altura ao site pai: postMessage({type:'club-embed-height', height}).
 */
(function () {
  'use strict';
  var C = window.CLUB_EMBED || {};
  var DATA = null, CAT = C.categoria || null, VIEW = C.view || 'tabela', POLL = null;
  var STAGE = { FINAL: 'Final', SEMI: 'Semifinal', THIRD: '3º lugar', QUARTER: 'Quartas', RO16: 'Oitavas', RO32: '16-avos', RO64: '32-avos' };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { s = s == null ? '' : String(s); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ini(s) { var p = String(s || '?').replace(/^\s+|\s+$/g, '').split(/\s+/); return ((p[0] || '?').charAt(0) + (p[1] || '').charAt(0)).toUpperCase(); }
  function cr(e) { return e && e.logoUrl ? '<img src="' + esc(e.logoUrl) + '" alt="">' : '<span class="cr">' + esc(ini(e ? e.name : '?')) + '</span>'; }
  function when(d) { try { return new Date(d).toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' }); } catch (e) { return ''; } }
  function stage(m) { return m.stage === 'GROUP' ? 'Grupo ' + (m.groupName || '?') : m.stage === 'LEAGUE' ? 'Rodada ' + m.round : (STAGE[m.stage] || m.stage); }
  function sendHeight() { try { parent.postMessage({ type: 'club-embed-height', slug: C.slug, height: document.documentElement.scrollHeight }, '*'); } catch (e) { /* ignore */ } }

  function cat() { if (!DATA) return null; for (var i = 0; i < DATA.categories.length; i++) if (DATA.categories[i].id === CAT) return DATA.categories[i]; return DATA.categories[0] || null; }
  function renderTabs() {
    $('cats').innerHTML = DATA.categories.length > 1 ? DATA.categories.map(function (c) { return '<button class="pill' + (c.id === (cat() || {}).id ? ' on' : '') + '" data-c="' + esc(c.id) + '">' + esc(c.name) + '</button>'; }).join('') : '';
    $('tabs').innerHTML = [['tabela', 'Classificação'], ['jogos', 'Jogos'], ['artilharia', 'Artilharia']].map(function (v) { return '<button class="pill' + (v[0] === VIEW ? ' on' : '') + '" data-v="' + v[0] + '">' + v[1] + '</button>'; }).join('');
  }
  function table(c) {
    if (!c.standings.length) return '<div class="empty">Classificação aparece quando os jogos começarem.</div>';
    var by = {}, order = [];
    c.standings.forEach(function (s) { var g = s.groupName || ''; if (!by[g]) { by[g] = []; order.push(g); } by[g].push(s); });
    order.sort();
    return order.map(function (g) {
      return (g ? '<div class="gh">Grupo ' + esc(g) + '</div>' : '') + '<table><thead><tr><th>#</th><th class="l">Equipe</th><th>P</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th></tr></thead><tbody>' +
        by[g].map(function (s, i) { return '<tr' + (i < 2 ? ' class="q"' : '') + '><td>' + (s.rank || i + 1) + '</td><td class="l">' + cr(s.entry) + esc(s.entry ? s.entry.name : '?') + '</td><td class="pts">' + s.points + '</td><td>' + s.played + '</td><td>' + s.won + '</td><td>' + s.drawn + '</td><td>' + s.lost + '</td><td>' + s.goalDiff + '</td></tr>'; }).join('') + '</tbody></table>';
    }).join('');
  }
  function games(c) {
    if (!c.matches.length) return '<div class="empty">Jogos ainda não gerados.</div>';
    var live = c.matches.filter(function (m) { return m.status === 'LIVE'; });
    var next = c.matches.filter(function (m) { return m.status === 'SCHEDULED'; }).sort(function (a, b) { return new Date(a.scheduledAt || 8.64e15) - new Date(b.scheduledAt || 8.64e15); });
    var done = c.matches.filter(function (m) { return m.status === 'FINISHED' || m.status === 'WALKOVER'; }).sort(function (a, b) { return new Date(b.scheduledAt || b.updatedAt) - new Date(a.scheduledAt || a.updatedAt); });
    function card(m) {
      var fin = m.status === 'FINISHED' || m.status === 'WALKOVER', lv = m.status === 'LIVE';
      var hs = lv && m.liveScore ? m.liveScore.home : m.homeScore, as = lv && m.liveScore ? m.liveScore.away : m.awayScore;
      var hw = fin && m.home && m.winnerEntryId === m.home.id, aw = fin && m.away && m.winnerEntryId === m.away.id;
      var goals = (m.timeline || []).filter(function (t) { return t.type === 'GOAL'; }).map(function (t) { return (t.player || 'Gol') + (t.minute != null ? " " + t.minute + "'" : ''); });
      return '<div class="m' + (lv ? ' live' : '') + '"><div class="meta"><span>' + esc(stage(m)) + (m.scheduledAt ? ' · ' + esc(when(m.scheduledAt)) : '') + (m.location ? ' · ' + esc(m.location) : '') + '</span>' + (lv ? '<span class="lv">AO VIVO</span>' : '') + '</div>' +
        '<div class="t' + (hw ? ' w' : '') + '">' + cr(m.home) + '<span>' + esc(m.home ? m.home.name : m.homeSourceLabel || 'A definir') + '</span><b>' + (fin || lv ? esc(hs == null ? '-' : hs) : '') + '</b></div>' +
        '<div class="t' + (aw ? ' w' : '') + '">' + cr(m.away) + '<span>' + esc(m.away ? m.away.name : m.awaySourceLabel || 'A definir') + '</span><b>' + (fin || lv ? esc(as == null ? '-' : as) : '') + '</b></div>' +
        (goals.length ? '<div class="tl">Gols: ' + esc(goals.join(', ')) + '</div>' : '') + '</div>';
    }
    return live.concat(next.slice(0, 8)).concat(done.slice(0, 8)).map(card).join('');
  }
  function scorers(c) {
    if (!c.scorers.length) return '<div class="empty">Sem gols registrados ainda.</div>';
    return '<table><thead><tr><th>#</th><th class="l">Jogador</th><th class="l">Equipe</th><th>G</th></tr></thead><tbody>' +
      c.scorers.slice(0, 15).map(function (r, i) { return '<tr' + (i < 3 ? ' class="q"' : '') + '><td>' + (i + 1) + '</td><td class="l" style="display:table-cell">' + esc((r.number != null ? r.number + ' ' : '') + r.name) + '</td><td class="l" style="display:table-cell;font-weight:600;color:var(--m)">' + esc(r.team) + '</td><td class="pts">' + r.goals + '</td></tr>'; }).join('') + '</tbody></table>';
  }
  function render() {
    if (!DATA) return;
    renderTabs();
    var c = cat();
    $('body').innerHTML = !c ? '<div class="empty">Nenhuma categoria ainda.</div>' : VIEW === 'jogos' ? games(c) : VIEW === 'artilharia' ? scorers(c) : table(c);
    $('sp').innerHTML = (DATA.sponsors || []).map(function (s) {
      var inner = s.logoUrl ? '<img src="' + esc(s.logoUrl) + '" alt="' + esc(s.name) + '">' : esc(s.name);
      return s.link ? '<a href="' + esc(s.link) + '" target="_blank" rel="noopener sponsored">' + inner + '</a>' : '<span>' + inner + '</span>';
    }).join('');
    setTimeout(sendHeight, 30);
  }
  function load() {
    var x = new XMLHttpRequest();
    x.open('GET', '/api/public/tournaments/' + encodeURIComponent(C.slug) + '?_=' + Date.now());
    x.onload = function () { if (x.status === 200) { try { DATA = JSON.parse(x.responseText); render(); } catch (e) { /* ignore */ } } };
    x.send();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null;
    if (!b) return;
    if (b.getAttribute('data-c')) { CAT = b.getAttribute('data-c'); render(); }
    if (b.getAttribute('data-v')) { VIEW = b.getAttribute('data-v'); render(); }
  });
  window.addEventListener('resize', sendHeight);
  load();
  var t = null;
  if (window.EventSource) {
    var es = new EventSource('/api/tournaments/' + encodeURIComponent(C.tid) + '/live');
    es.onmessage = function () { clearTimeout(t); t = setTimeout(load, 800); };
    es.onerror = function () { if (!POLL) POLL = setInterval(load, 30000); };
    es.onopen = function () { if (POLL) { clearInterval(POLL); POLL = null; } };
  } else POLL = setInterval(load, 30000);
})();
