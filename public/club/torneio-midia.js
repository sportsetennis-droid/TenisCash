/* Club Sports & Tennis — mídia do torneio (artes, QR, calendário, embed, ao vivo)
 * Usado pela página pública /t/:slug e pela gestão /torneios.html.
 * window.ClubMidia.{openArtSheet, shareArt, openQr, openCalendar, openEmbed, sharePage, connectLive}
 * Bottom-sheet próprio (classes .cm-*), mobile-first, sem dependência.
 */
(function () {
  'use strict';
  if (window.ClubMidia) return;
  var ORANGE = '#E5571E';
  var css = '' +
    '.cm-bg{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9998;opacity:0;pointer-events:none;transition:opacity .2s}' +
    '.cm-bg.on{opacity:1;pointer-events:auto}' +
    '.cm-sh{position:fixed;left:0;right:0;bottom:0;z-index:9999;max-width:520px;margin:0 auto;background:#141418;color:#fff;border-radius:20px 20px 0 0;padding:10px 16px calc(18px + env(safe-area-inset-bottom));max-height:92vh;overflow:auto;transform:translateY(105%);transition:transform .25s ease;font-family:"Barlow Condensed","Inter",system-ui,sans-serif;box-shadow:0 -10px 40px rgba(0,0,0,.5)}' +
    '.cm-sh.on{transform:none}' +
    '.cm-grab{width:44px;height:5px;border-radius:9px;background:rgba(255,255,255,.25);margin:0 auto 10px}' +
    '.cm-h{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}' +
    '.cm-h b{font-weight:900;font-style:italic;font-size:22px;text-transform:uppercase;letter-spacing:.3px}' +
    '.cm-x{background:rgba(255,255,255,.1);border:0;color:#fff;width:44px;height:44px;border-radius:12px;font-size:20px;cursor:pointer}' +
    '.cm-seg{display:flex;gap:6px;background:rgba(255,255,255,.06);border-radius:12px;padding:4px;margin:6px 0 12px}' +
    '.cm-seg button{flex:1;min-height:44px;border:0;border-radius:9px;background:transparent;color:#c9c9d1;font:700 15px "Barlow Condensed",sans-serif;text-transform:uppercase;cursor:pointer}' +
    '.cm-seg button.on{background:' + ORANGE + ';color:#fff}' +
    '.cm-types{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px;-webkit-overflow-scrolling:touch}' +
    '.cm-types::-webkit-scrollbar{display:none}' +
    '.cm-types button{flex-shrink:0;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:transparent;color:#fff;font:700 15px "Barlow Condensed",sans-serif;cursor:pointer}' +
    '.cm-types button.on{background:#fff;color:#0B0B0D;border-color:#fff}' +
    '.cm-prev{position:relative;background:#0B0B0D;border-radius:14px;display:flex;align-items:center;justify-content:center;min-height:220px;overflow:hidden;border:1px solid rgba(255,255,255,.08)}' +
    '.cm-prev img{display:block;max-width:100%;max-height:52vh;object-fit:contain}' +
    '.cm-prev .cm-ld{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#a1a1aa;font-size:15px;background:rgba(11,11,13,.6)}' +
    '.cm-row{display:flex;gap:8px;margin-top:12px}' +
    '.cm-btn{flex:1;min-height:48px;border:0;border-radius:14px;font:800 17px "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.3px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none}' +
    '.cm-p{background:' + ORANGE + ';color:#fff}.cm-s{background:rgba(255,255,255,.1);color:#fff}' +
    '.cm-note{color:#a1a1aa;font-size:14px;margin-top:10px;text-align:center;font-family:"Inter",system-ui,sans-serif}' +
    '.cm-list a,.cm-list button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:52px;padding:0 14px;margin-bottom:8px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);color:#fff;text-decoration:none;font:700 17px "Barlow Condensed",sans-serif;cursor:pointer}' +
    '.cm-list small{color:#a1a1aa;font-weight:600}' +
    '.cm-sel{width:100%;min-height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0B0B0D;color:#fff;padding:0 12px;font:700 16px "Barlow Condensed",sans-serif;margin:4px 0 12px}' +
    '.cm-code{width:100%;min-height:120px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0B0B0D;color:#e4e4e7;padding:10px;font:12px ui-monospace,Menlo,monospace}' +
    '.cm-lbl{color:#a1a1aa;font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px;font-weight:700}' +
    '.cm-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));transform:translateX(-50%);background:#fff;color:#0B0B0D;padding:10px 16px;border-radius:12px;font:700 15px "Barlow Condensed",sans-serif;z-index:10000;opacity:0;transition:opacity .2s;pointer-events:none}' +
    '.cm-toast.on{opacity:1}' +
    /* Liga F4 — folha "Compartilhar" (imagens prontas + link) */
    '.cm-link{display:flex;gap:8px;align-items:center}' +
    '.cm-link input{flex:1;min-width:0;min-height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0B0B0D;color:#fff;padding:0 12px;font:600 14px "Inter",system-ui,sans-serif}' +
    '.cm-link button{min-height:46px;min-width:88px;border:0;border-radius:12px;background:#fff;color:#0B0B0D;font:800 15px "Barlow Condensed",sans-serif;text-transform:uppercase;cursor:pointer}' +
    '.cm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:4px}' +
    '.cm-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}' +
    '.cm-th{position:relative;border-radius:10px;overflow:hidden;background:#0B0B0D;aspect-ratio:4/5}' +
    '.cm-th.st{aspect-ratio:9/16}' +
    '.cm-th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}' +
    '.cm-th span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#a1a1aa;font:600 12px "Inter",system-ui,sans-serif;text-align:center;padding:6px}' +
    '.cm-card b{font:800 15px "Barlow Condensed",sans-serif;text-transform:uppercase;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.cm-card .cm-btn{min-height:44px;font-size:15px;border-radius:12px;flex:none}' +
    '.cm-list .jrow{display:flex;flex-direction:column;justify-content:center;min-height:52px;padding:6px 14px;margin-bottom:8px;border-radius:14px;background:rgba(255,255,255,.03);border:1px dashed rgba(255,255,255,.14)}' +
    '.cm-list .jrow b{font:700 17px "Barlow Condensed",sans-serif}' +
    '.cm-card .cm-dl{min-height:44px;border:0;background:transparent;color:#c9c9d1;font:700 14px "Barlow Condensed",sans-serif;text-transform:uppercase;cursor:pointer}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var bg = document.createElement('div'); bg.className = 'cm-bg';
  var sh = document.createElement('div'); sh.className = 'cm-sh'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
  var toastEl = document.createElement('div'); toastEl.className = 'cm-toast'; toastEl.setAttribute('role', 'status');
  function mount() { if (!bg.parentNode) { document.body.appendChild(bg); document.body.appendChild(sh); document.body.appendChild(toastEl); } }
  bg.addEventListener('click', close);
  function esc(s) { s = s == null ? '' : String(s); return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function open(title, html) {
    mount();
    sh.innerHTML = '<div class="cm-grab"></div><div class="cm-h"><b>' + esc(title) + '</b><button class="cm-x" type="button" aria-label="Fechar">×</button></div><div class="cm-body">' + html + '</div>';
    sh.querySelector('.cm-x').addEventListener('click', close);
    bg.classList.add('on'); sh.classList.add('on');
    return sh.querySelector('.cm-body'); // nó novo a cada abertura → listeners não acumulam
  }
  function close() { bg.classList.remove('on'); sh.classList.remove('on'); }
  var tt = null;
  function toast(m) { mount(); toastEl.textContent = m; toastEl.classList.add('on'); clearTimeout(tt); tt = setTimeout(function () { toastEl.classList.remove('on'); }, 2600); }

  function downloadBlob(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(u); a.remove(); }, 1500);
  }
  function legacyCopy(t) {
    try {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function copyText(t) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacyCopy(t); });
    } catch (e) { /* cai no antigo */ }
    return Promise.resolve(legacyCopy(t));
  }
  // Compartilha a ARTE como arquivo (Web Share Level 2) → Instagram/WhatsApp; senão baixa.
  // extra (Liga F4): { text, link } — vai junto no compartilhamento; no "baixar" o link é copiado.
  function shareArt(url, name, title, forceDownload, extra) {
    name = (name || 'arte') + '.png';
    toast('Gerando arte…');
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('não consegui gerar a arte');
      return r.blob();
    }).then(function (blob) {
      var file = null;
      try { file = new File([blob], name, { type: 'image/png' }); } catch (e) { file = null; }
      if (!forceDownload && file && navigator.canShare && navigator.canShare({ files: [file] })) {
        var data = { files: [file], title: title || 'Club Sports & Tennis' };
        if (extra && extra.text) data.text = extra.text;
        return navigator.share(data).catch(function (e) {
          if (e && e.name === 'AbortError') return;
          downloadBlob(blob, name);
        });
      }
      downloadBlob(blob, name);
      if (extra && extra.link) copyText(extra.link).then(function (ok) { toast(ok ? 'Arte baixada — link copiado' : 'Arte baixada'); });
      else toast('Arte baixada');
    }).catch(function (e) { toast(e.message || 'Erro ao gerar a arte'); });
  }

  var FORMATS = [['story', 'Story'], ['feed', 'Feed'], ['quadrado', 'Quadrado']];
  // opts: { tid, slug, title, tipo, matchId, categoryId, categoryName, types:[[tipo,label,extraQuery]] }
  function openArtSheet(opts) {
    var fmt = 'story';
    var types = opts.types && opts.types.length ? opts.types : [[opts.tipo, opts.title || 'Arte', opts.query || {}]];
    var cur = 0;
    function url(dl) {
      var t = types[cur];
      var q = { formato: fmt };
      if (opts.matchId) q.matchId = opts.matchId;
      if (opts.categoryId) q.categoryId = opts.categoryId;
      var ex = t[2] || {};
      for (var k in ex) if (Object.prototype.hasOwnProperty.call(ex, k)) q[k] = ex[k];
      var qs = Object.keys(q).filter(function (k) { return q[k] != null && q[k] !== ''; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(q[k]); }).join('&');
      return '/api/tournaments/' + encodeURIComponent(opts.tid) + '/arte/' + t[0] + '.png?' + qs + (dl ? '' : '');
    }
    function fname() { return [(opts.slug || 'torneio'), types[cur][0], fmt].join('-'); }
    var html = (types.length > 1 ? '<div class="cm-types">' + types.map(function (t, i) { return '<button type="button" data-ti="' + i + '"' + (i === 0 ? ' class="on"' : '') + '>' + esc(t[1]) + '</button>'; }).join('') + '</div>' : '') +
      '<div class="cm-seg">' + FORMATS.map(function (f) { return '<button type="button" data-f="' + f[0] + '"' + (f[0] === fmt ? ' class="on"' : '') + '>' + f[1] + '</button>'; }).join('') + '</div>' +
      '<div class="cm-prev"><img alt="Prévia da arte"><div class="cm-ld">Gerando prévia…</div></div>' +
      '<div class="cm-row"><button class="cm-btn cm-p" type="button" data-a="share">Compartilhar</button><button class="cm-btn cm-s" type="button" data-a="dl">Baixar</button></div>' +
      '<div class="cm-note">Arte pronta pro Instagram e WhatsApp (Story 1080×1920 · Feed 1080×1350 · Quadrado 1080×1080)</div>';
    var body = open(opts.title || 'Arte', html);
    var im = body.querySelector('.cm-prev img'), ld = body.querySelector('.cm-ld');
    function refresh() {
      ld.style.display = 'flex'; ld.textContent = 'Gerando prévia…';
      im.onload = function () { ld.style.display = 'none'; };
      im.onerror = function () { ld.textContent = 'Essa arte ainda não está disponível'; };
      im.src = url();
    }
    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-f')) { fmt = b.getAttribute('data-f'); [].forEach.call(body.querySelectorAll('[data-f]'), function (x) { x.classList.toggle('on', x === b); }); refresh(); }
      if (b.getAttribute('data-ti') != null) { cur = Number(b.getAttribute('data-ti')); [].forEach.call(body.querySelectorAll('[data-ti]'), function (x) { x.classList.toggle('on', x === b); }); refresh(); }
      if (b.getAttribute('data-a') === 'share') shareArt(url(), fname(), opts.shareTitle || opts.title);
      if (b.getAttribute('data-a') === 'dl') shareArt(url(), fname(), opts.title, true);
    });
    refresh();
  }

  function origin() { return location.protocol + '//' + location.host; }

  // Liga F4 — folha "Compartilhar": imagens prontas (feed/story) + o link.
  // o: { title, link, text, shareTitle, slug, images:[{ key, label, src: function(formato) }] }
  // Imagem: navigator.share com o ARQUIVO quando o celular deixa; senão baixa e copia o link.
  function openShareSheet(o) {
    var fmt = 'feed';
    var link = o.link || location.href;
    var text = o.text || ((o.shareTitle || document.title) + ': ' + link);
    var imgs = o.images || [];
    var html = '<div data-testid="share-sheet"></div>' +
      '<div class="cm-lbl">Link</div>' +
      '<div class="cm-link"><input readonly data-testid="share-link" value="' + esc(link) + '" aria-label="Link"><button type="button" data-a="copy" data-testid="share-copy">Copiar</button></div>' +
      '<div class="cm-row"><a class="cm-btn cm-p" data-testid="share-wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(text) + '">WhatsApp</a>' +
      '<button class="cm-btn cm-s" type="button" data-a="native">Mais opções</button></div>' +
      (imgs.length ? '<div class="cm-lbl" style="margin-top:16px">Imagens prontas</div>' +
        '<div class="cm-seg"><button type="button" data-f="feed" class="on" data-testid="share-fmt-feed">Feed</button><button type="button" data-f="story" data-testid="share-fmt-story">Story</button></div>' +
        '<div class="cm-grid">' + imgs.map(function (im, i) {
          return '<div class="cm-card" data-testid="share-img-' + esc(im.key) + '"><div class="cm-th"><img alt="' + esc(im.label) + '"><span>Gerando…</span></div><b>' + esc(im.label) + '</b>' +
            '<button class="cm-btn cm-p" type="button" data-a="ishare" data-i="' + i + '">Compartilhar</button>' +
            '<button class="cm-dl" type="button" data-a="idl" data-i="' + i + '">Baixar</button></div>';
        }).join('') + '</div>' : '') +
      '<div class="cm-note">Feed 1080×1350 · Story 1080×1920 — cada imagem leva o link da página.</div>';
    var body = open(o.title || 'Compartilhar', html);
    function thumbs() {
      [].forEach.call(body.querySelectorAll('.cm-card'), function (card, i) {
        var th = card.querySelector('.cm-th'), im = th.querySelector('img'), sp = th.querySelector('span');
        th.classList.toggle('st', fmt === 'story');
        sp.style.display = 'flex'; sp.textContent = 'Gerando…';
        im.style.opacity = '0';
        im.onload = function () { sp.style.display = 'none'; im.style.opacity = '1'; };
        im.onerror = function () { sp.textContent = 'Ainda não disponível'; };
        im.src = imgs[i].src(fmt);
      });
    }
    function fname(i) { return [(o.slug || 'club'), imgs[i].key, fmt].join('-'); }
    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      var a = b.getAttribute('data-a');
      if (b.getAttribute('data-f')) { fmt = b.getAttribute('data-f'); [].forEach.call(body.querySelectorAll('[data-f]'), function (x) { x.classList.toggle('on', x === b); }); thumbs(); return; }
      if (a === 'copy') { copyText(link).then(function (ok) { toast(ok ? 'Link copiado' : 'Copie o link acima'); }); return; }
      if (a === 'native') {
        if (navigator.share) navigator.share({ title: o.shareTitle || document.title, text: text, url: link }).catch(function () {});
        else copyText(link).then(function (ok) { toast(ok ? 'Link copiado' : 'Copie o link acima'); });
        return;
      }
      var i = Number(b.getAttribute('data-i'));
      if (a === 'ishare') shareArt(imgs[i].src(fmt), fname(i), o.shareTitle || o.title, false, { text: text, link: link });
      if (a === 'idl') shareArt(imgs[i].src(fmt), fname(i), o.shareTitle || o.title, true, { text: text, link: link });
    });
    if (imgs.length) thumbs();
    return body;
  }
  function sharePage(o) {
    var url = origin() + '/t/' + o.slug;
    var txt = 'Acompanhe ' + (o.name || 'o torneio') + ' ao vivo: ' + url;
    if (navigator.share) navigator.share({ title: o.name, text: txt, url: url }).catch(function () {});
    else window.open('https://wa.me/?text=' + encodeURIComponent(txt), '_blank');
  }
  function openQr(o) {
    var src = '/api/tournaments/' + encodeURIComponent(o.tid) + '/qr.png?size=900' + (o.matchId ? '&jogo=' + encodeURIComponent(o.matchId) : '');
    var body = open(o.matchId ? 'QR do jogo' : 'QR do torneio',
      '<div class="cm-prev" style="background:#fff"><img src="' + src + '" alt="QR code" style="max-height:46vh"></div>' +
      '<div class="cm-row"><button class="cm-btn cm-p" type="button" data-a="qrs">Compartilhar</button><button class="cm-btn cm-s" type="button" data-a="qrd">Baixar</button></div>' +
      '<div class="cm-note">Imprima e cole no ginásio: quem aponta a câmera abre a tabela ao vivo.</div>' +
      (o.slug ? '<div class="cm-list" style="margin-top:12px"><a href="/t/' + esc(o.slug) + '/telao" target="_blank" rel="noopener">Abrir modo telão (TV) <small>→</small></a></div>' : ''));
    body.querySelector('[data-a="qrs"]').addEventListener('click', function () { shareArt(src, (o.slug || 'torneio') + '-qr', o.name); });
    body.querySelector('[data-a="qrd"]').addEventListener('click', function () { shareArt(src, (o.slug || 'torneio') + '-qr', o.name, true); });
  }
  // o: { slug, name, categories:[{id,name}], teams:[{id,name}] }
  function openCalendar(o) {
    var base = location.host + '/t/' + o.slug + '/calendario.ics';
    function links(q) {
      var qs = q ? '?' + q : '';
      var web = 'webcal://' + base + qs, https = origin() + '/t/' + o.slug + '/calendario.ics' + qs;
      return '<div class="cm-list">' +
        '<a href="' + esc(web) + '">Assinar no celular <small>atualiza sozinho</small></a>' +
        '<a href="https://calendar.google.com/calendar/r?cid=' + encodeURIComponent(web) + '" target="_blank" rel="noopener">Google Agenda <small>→</small></a>' +
        '<a href="' + esc(https) + '" download>Baixar arquivo .ics <small>Outlook/Apple</small></a></div>';
    }
    var cats = o.categories || [], teams = o.teams || [];
    var html = '<div class="cm-lbl">Quais jogos?</div><select class="cm-sel" id="cm-calq"><option value="">Todos os jogos do torneio</option>' +
      cats.map(function (c) { return '<option value="categoria=' + encodeURIComponent(c.id) + '">Categoria: ' + esc(c.name) + '</option>'; }).join('') +
      teams.map(function (t) { return '<option value="time=' + encodeURIComponent(t.name) + '">Time: ' + esc(t.name) + '</option>'; }).join('') +
      '</select><div id="cm-call">' + links('') + '</div><div class="cm-note">Horários no fuso de João Pessoa. Mudou a tabela, o calendário assinado atualiza.</div>';
    var body = open('Adicionar ao calendário', html);
    body.querySelector('#cm-calq').addEventListener('change', function () { body.querySelector('#cm-call').innerHTML = links(this.value); });
  }
  function openEmbed(o) {
    var src = origin() + '/t/' + o.slug + '/embed';
    function code(view) {
      return '<iframe src="' + src + '?view=' + view + '" title="' + esc(o.name) + '" loading="lazy" style="width:100%;min-height:480px;border:0;border-radius:12px"></iframe>\n' +
        '<script>addEventListener("message",function(e){var d=e.data;if(d&&d.type==="club-embed-height"&&d.slug==="' + o.slug + '"){document.querySelectorAll(\'iframe[src*="/t/' + o.slug + '/embed"]\').forEach(function(f){f.style.height=d.height+"px"})}})<\/script>';
    }
    var body = open('Incorporar no site', '<div class="cm-seg"><button type="button" class="on" data-v="tabela">Tabela</button><button type="button" data-v="jogos">Jogos</button><button type="button" data-v="artilharia">Artilharia</button></div>' +
      '<textarea class="cm-code" readonly id="cm-emb"></textarea><div class="cm-row"><button class="cm-btn cm-p" type="button" data-a="copy">Copiar código</button><a class="cm-btn cm-s" href="' + esc(src) + '" target="_blank" rel="noopener">Ver</a></div>' +
      '<div class="cm-lbl">API pública (JSON)</div><div class="cm-list"><a href="/api/public/tournaments/' + esc(o.slug) + '" target="_blank" rel="noopener">/api/public/tournaments/' + esc(o.slug) + ' <small>→</small></a></div>');
    var ta = body.querySelector('#cm-emb'); ta.value = code('tabela');
    body.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.getAttribute('data-v')) { ta.value = code(b.getAttribute('data-v')); [].forEach.call(body.querySelectorAll('[data-v]'), function (x) { x.classList.toggle('on', x === b); }); }
      if (b.getAttribute('data-a') === 'copy') { ta.select(); try { navigator.clipboard.writeText(ta.value).then(function () { toast('Código copiado'); }); } catch (_) { document.execCommand('copy'); toast('Código copiado'); } }
    });
  }

  // SSE com fallback: onState(false) se o navegador não suporta ou a conexão cai.
  // Liga F4: com /club/live-sse.js carregado, reconecta sozinho com espera crescente.
  function connectLive(tid, onMsg, onState) {
    var url = '/api/tournaments/' + encodeURIComponent(tid) + '/live';
    if (window.ClubLiveSSE) return window.ClubLiveSSE.connect(url, { onMessage: onMsg, onState: onState });
    if (!window.EventSource) { if (onState) onState(false); return null; }
    var es = new EventSource('/api/tournaments/' + encodeURIComponent(tid) + '/live');
    es.onopen = function () { if (onState) onState(true); };
    es.onmessage = function (e) { var d; try { d = JSON.parse(e.data); } catch (_) { return; } onMsg(d); };
    es.onerror = function () { if (onState) onState(false); };
    return es;
  }

  window.ClubMidia = { openSheet: open, openShareSheet: openShareSheet, copyText: copyText, openArtSheet: openArtSheet, shareArt: shareArt, openQr: openQr, openCalendar: openCalendar, openEmbed: openEmbed, sharePage: sharePage, connectLive: connectLive, toast: toast, close: close };
})();
