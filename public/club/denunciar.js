/* Club Sports & Tennis — Liga Aberta F6: DENUNCIAR (torneio, time, aviso, imagem)
 * window.ClubReport.open({ tournamentId, tournamentName, targetType?, targetId?, context? })
 * Usa a folha de baixo do ClubMidia (torneio-midia.js). Login: token do app (tc_token).
 * Mobile-first: botões de 44 px, folha de baixo, safe-area (vem do .cm-sh).
 */
(function () {
  'use strict';
  if (window.ClubReport) return;
  var REASONS = [['OFFENSIVE', 'Ofensivo'], ['IMPROPER', 'Impróprio'], ['SCAM', 'Golpe ou spam'], ['PERSONAL_DATA', 'Dados pessoais'], ['OTHER', 'Outro']];
  var css = '' +
    '.rp-ch{display:flex;flex-wrap:wrap;gap:8px;margin:4px 0 8px}' +
    '.rp-ch button{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#fff;font:700 15px "Barlow Condensed",sans-serif;cursor:pointer}' +
    '.rp-ch button.on{background:#fff;color:#0B0B0D;border-color:#fff}' +
    '.rp-ta{width:100%;min-height:84px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0B0B0D;color:#fff;padding:10px;font:15px "Inter",system-ui,sans-serif;resize:vertical;box-sizing:border-box}' +
    '.rp-ok{text-align:center;padding:18px 6px;font:600 16px "Inter",system-ui,sans-serif;color:#e4e4e7}' +
    '.rp-link{background:none;border:0;color:inherit;opacity:.7;font:600 13px "Inter",system-ui,sans-serif;text-decoration:underline;cursor:pointer;min-height:44px;padding:0 6px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function token() { try { return localStorage.getItem('tc_token') || ''; } catch (_) { return ''; } }
  function postsInPage() {
    return [].map.call(document.querySelectorAll('[data-post-id]'), function (el) {
      var t = el.querySelector('.post-t'), b = el.querySelector('.post-b');
      return { id: el.getAttribute('data-post-id'), label: ((t && t.textContent) || (b && b.textContent) || 'Aviso').slice(0, 60), hasImage: !!el.querySelector('.post-img') };
    });
  }

  function open(o) {
    o = o || {};
    if (!window.ClubMidia || !ClubMidia.openSheet) return;
    if (!token()) {
      var b0 = ClubMidia.openSheet('Denunciar', '<div data-testid="report-sheet"></div><div class="rp-ok">Entre na sua conta para denunciar. Assim a moderação consegue falar com você se precisar.</div>' +
        '<div class="cm-row"><a class="cm-btn cm-p" data-testid="report-login" href="/torneios.html?voltar=' + encodeURIComponent(location.pathname) + '">Entrar</a></div>');
      return b0;
    }
    var posts = postsInPage();
    var target = o.targetType || 'TOURNAMENT';
    var targetId = o.targetId || o.tournamentId;
    var reason = '';
    var opts = '<option value="TOURNAMENT|' + esc(o.tournamentId) + '">Este torneio' + (o.tournamentName ? ' — ' + esc(o.tournamentName) : '') + '</option>' +
      '<optgroup label="Times" id="rp-teams"></optgroup>' +
      (posts.length ? '<optgroup label="Avisos">' + posts.map(function (p) { return '<option value="POST|' + esc(p.id) + '">Aviso: ' + esc(p.label) + '</option>'; }).join('') + '</optgroup>' : '') +
      '<optgroup label="Imagens">' + (o.hasBanner ? '<option value="IMAGE|tournament|' + esc(o.tournamentId) + '|bannerUrl">Imagem do torneio (capa)</option>' : '') +
      posts.filter(function (p) { return p.hasImage; }).map(function (p) { return '<option value="IMAGE|post|' + esc(p.id) + '|imageUrl">Imagem do aviso: ' + esc(p.label) + '</option>'; }).join('') + '</optgroup>';
    var html = '<div data-testid="report-sheet"></div>' +
      '<div class="cm-lbl">O que você quer denunciar?</div>' +
      '<select class="cm-sel" data-testid="report-target" aria-label="O que denunciar">' + opts + '</select>' +
      '<div class="cm-lbl">Motivo</div>' +
      '<div class="rp-ch" data-testid="report-reasons">' + REASONS.map(function (r) { return '<button type="button" data-r="' + r[0] + '">' + esc(r[1]) + '</button>'; }).join('') + '</div>' +
      '<div class="cm-lbl">Conte o que aconteceu (opcional)</div>' +
      '<textarea class="rp-ta" maxlength="500" data-testid="report-text" placeholder="Até 500 caracteres"></textarea>' +
      '<div class="cm-row"><button class="cm-btn cm-p" type="button" data-a="send" data-testid="report-send" disabled>Enviar denúncia</button></div>' +
      '<div class="cm-note">A moderação revisa cada denúncia. Quem foi denunciado não fica sabendo quem denunciou.</div>';
    var body = ClubMidia.openSheet('Denunciar', html);
    var sel = body.querySelector('[data-testid="report-target"]');
    var sendBtn = body.querySelector('[data-a="send"]');
    // pré-seleção (ex.: "Denunciar" num aviso)
    function preselect() {
      var want = target === 'IMAGE' && o.context ? ['IMAGE', o.context.entity, o.context.entityId, o.context.field].join('|') : target + '|' + targetId;
      [].forEach.call(sel.options, function (op) { if (op.value === want) sel.value = want; });
    }
    preselect();
    // times do torneio (lista pública de inscritos)
    fetch('/api/tournaments/' + encodeURIComponent(o.tournamentId) + '/entries', { cache: 'no-store', headers: { Authorization: 'Bearer ' + token() } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = (j && (j.entries || j)) || [];
        if (!Array.isArray(list)) list = [];
        var seen = {};
        var g = body.querySelector('#rp-teams');
        list.forEach(function (e) {
          if (!e || !e.id || seen[e.name]) return; seen[e.name] = 1;
          var op = document.createElement('option'); op.value = 'ENTRY|' + e.id; op.textContent = 'Time: ' + (e.name || '');
          g.appendChild(op);
          if (e.logoUrl) { var oi = document.createElement('option'); oi.value = 'IMAGE|entry|' + e.id + '|logoUrl'; oi.textContent = 'Escudo do time: ' + (e.name || ''); body.querySelector('optgroup[label="Imagens"]').appendChild(oi); }
        });
        preselect();
      }).catch(function () {});
    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-r')) {
        reason = b.getAttribute('data-r');
        [].forEach.call(body.querySelectorAll('[data-r]'), function (x) { x.classList.toggle('on', x === b); });
        sendBtn.disabled = false; return;
      }
      if (b.getAttribute('data-a') === 'send') {
        if (!reason) return;
        var v = sel.value.split('|');
        var payload = { reason: reason, text: body.querySelector('.rp-ta').value || null };
        if (v[0] === 'IMAGE') { payload.targetType = 'IMAGE'; payload.targetId = v[2]; payload.context = { entity: v[1], entityId: v[2], field: v[3] }; }
        else { payload.targetType = v[0]; payload.targetId = v[1]; }
        sendBtn.disabled = true; sendBtn.textContent = 'Enviando…';
        fetch('/api/liga/reports', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token() }, body: JSON.stringify(payload) })
          .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
          .then(function (x) {
            if (x.s === 201) { body.innerHTML = '<div class="rp-ok" data-testid="report-done">Denúncia recebida. Obrigado — a moderação vai revisar.</div><div class="cm-row"><button class="cm-btn cm-s" type="button" data-a="close">Fechar</button></div>'; return; }
            sendBtn.disabled = false; sendBtn.textContent = 'Enviar denúncia';
            ClubMidia.toast((x.j && x.j.error) || 'Não deu para enviar agora');
          })
          .catch(function () { sendBtn.disabled = false; sendBtn.textContent = 'Enviar denúncia'; ClubMidia.toast('Sem conexão — tente de novo'); });
        return;
      }
      if (b.getAttribute('data-a') === 'close') ClubMidia.close();
    });
    return body;
  }

  // Liga os botões "Denunciar" da página (rodapé e cada aviso) — delegação, vale para avisos carregados depois.
  function bind(o) {
    document.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-report]') : null; if (!b) return;
      e.preventDefault();
      var kind = b.getAttribute('data-report');
      var id = b.getAttribute('data-report-id');
      open({ tournamentId: o.tournamentId, tournamentName: o.tournamentName, hasBanner: o.hasBanner, targetType: kind === 'post' ? 'POST' : 'TOURNAMENT', targetId: kind === 'post' ? id : o.tournamentId });
    });
  }

  window.ClubReport = { open: open, bind: bind };
})();
