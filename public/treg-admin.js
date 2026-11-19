// =====================================================================
// CLUB F3 — Painel de INSCRIÇÕES, CHECK-IN por QR e W.O. sugerido
// Roda dentro de /torneios.html (rota #/inscricoes/<torneio>) e usa os
// helpers globais dela (app, topbar, esc, toast, openSheet, closeSheet,
// cardH, emptyB, I, TOKEN, loading, errPage).
// API: /api/tournament-registration/manage/:tid/*
// =====================================================================
(function () {
  'use strict';
  var TR = { tid: null, tab: 'lista', slug: '', name: '', manage: false, cfg: null, cats: [], admin: false, stores: [], list: null, filters: { status: '', categoryId: '', q: '' }, scope: { type: 'event', matchId: '', round: '1' }, board: null };
  var CAM = { stream: null, on: false, last: '', lastAt: 0, det: null, zx: null };

  function brl(c) { return 'R$ ' + (Math.round(c || 0) / 100).toFixed(2).replace('.', ','); }
  function toCents(v) { var s = String(v == null ? '' : v).trim().replace(/[^\d,.-]/g, ''); if (!s) return 0; if (s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.'); var n = Math.round(parseFloat(s) * 100); return isFinite(n) ? n : NaN; }
  function centsIn(c) { return c ? (c / 100).toFixed(2).replace('.', ',') : ''; }
  function dt(d) { return d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' }) : ''; }
  function tapi(path, opts) {
    var o = opts || {};
    return fetch('/api/tournament-registration/manage/' + TR.tid + path, {
      method: o.method || (o.body ? 'POST' : 'GET'),
      headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}),
      body: o.body ? JSON.stringify(o.body) : undefined, cache: 'no-store',
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || ('erro ' + r.status)); e.status = r.status; throw e; } return j; }); });
  }
  var ST = { PENDING_PAYMENT: ['Aguardando', 'w'], CONFIRMED: ['Confirmada', 'ok'], WAITLIST: ['Fila', 'g'], EXPIRED: ['Expirada', 'g'], CANCELED: ['Cancelada', 'g'], REFUNDED: ['Estornada', 'dang'] };
  function pill(st) { var s = ST[st] || [st, 'g']; return '<span class="pill ' + s[1] + '">' + esc(s[0]) + '</span>'; }

  // ------------------------------------------------------------------
  window.renderInscricoes = async function (tid, tab) {
    loading();
    TR.tid = tid; TR.tab = tab || TR.tab || 'lista';
    try {
      var t = await api('/' + tid);
      TR.slug = t.slug; TR.name = t.name;
    } catch (e) { errPage('Inscrições', e.message); return; }
    TR.manage = false;
    try {
      var c = await tapi('/config');
      TR.manage = true; TR.cfg = c.config; TR.cats = c.categories; TR.admin = !!c.isGlobalAdmin;
    } catch (e) {
      if (e.status !== 403) { errPage('Inscrições', e.message); return; }
    }
    if (!TR.manage) TR.tab = 'checkin';
    draw();
  };

  function draw() {
    var tabs = TR.manage ? [['lista', 'Inscritos'], ['checkin', 'Check-in'], ['config', 'Configurar'], ['cupons', 'Cupons']] : [['checkin', 'Check-in']];
    var html = topbar('Inscrições', true) + '<div class="wrap enter">' +
      '<div class="card wh"><div class="eyebrow" style="color:#C93E19">' + esc(TR.name) + '</div><h2 style="margin:4px 0 2px">Inscrições &amp; check-in</h2>' +
      (TR.manage ? '<p class="muted" style="margin:0 0 12px">Link público: <b>/t/' + esc(TR.slug) + '/inscricao</b></p><div class="brow"><button class="btn sm" data-tact="copy-link">' + I.link + 'Copiar link</button><a class="btn sm gho" href="/t/' + esc(TR.slug) + '/inscricao" target="_blank" rel="noopener">' + I.ext + 'Abrir</a></div>' : '<p class="muted" style="margin:0">Mesa / arbitragem: leia o QR do atleta ou do time.</p>') +
      '</div>' +
      (tabs.length > 1 ? '<div class="tabs">' + tabs.map(function (x) { return '<button data-tact="tab" data-tab="' + x[0] + '" class="' + (TR.tab === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('') + '</div>' : '') +
      '<div id="tr-body"><div class="spin"></div></div></div>';
    app.innerHTML = html;
    if (TR.tab === 'lista') drawList();
    else if (TR.tab === 'checkin') drawCheckin();
    else if (TR.tab === 'config') drawConfig();
    else drawCoupons();
  }
  function body(h) { var b = document.getElementById('tr-body'); if (b) b.innerHTML = h; }

  // ------------------------------------------------------------------ INSCRITOS
  async function drawList() {
    var f = TR.filters, qs = [];
    if (f.status) qs.push('status=' + encodeURIComponent(f.status));
    if (f.categoryId) qs.push('categoryId=' + encodeURIComponent(f.categoryId));
    if (f.q) qs.push('q=' + encodeURIComponent(f.q));
    var d;
    try { d = await tapi('/registrations' + (qs.length ? '?' + qs.join('&') : '')); } catch (e) { body('<div class="card">' + emptyB(I.warn, esc(e.message)) + '</div>'); return; }
    TR.list = d;
    var s = d.summary, bs = s.byStatus || {};
    var h = '<div class="card">' + cardH(I.chart, 'Resumo') +
      '<div class="stats4"><div class="stat hl"><b class="num">' + (bs.CONFIRMED || 0) + '</b><span>Confirmadas</span></div><div class="stat"><b class="num">' + (bs.PENDING_PAYMENT || 0) + '</b><span>Aguardando</span></div><div class="stat"><b class="num">' + (bs.WAITLIST || 0) + '</b><span>Fila</span></div><div class="stat"><b class="num">' + ((bs.EXPIRED || 0) + (bs.CANCELED || 0)) + '</b><span>Expir./canc.</span></div></div>' +
      '<div class="sp12"></div>' +
      '<div class="listitem"><div class="grow"><div class="nm">Arrecadado (dinheiro, líquido)</div><div class="sub">PIX + no local − estornos</div></div><b>' + brl(s.netCents) + '</b></div>' +
      '<div class="listitem"><div class="grow"><div class="nm">Pago com TenisCash</div></div><b>' + brl(s.tenisCashCents) + '</b></div>' +
      '<div class="listitem"><div class="grow"><div class="nm">A receber (aguardando)</div></div><b>' + brl(s.pendingCents) + '</b></div>' +
      (s.refundedCents ? '<div class="listitem"><div class="grow"><div class="nm">Estornado</div></div><b>' + brl(s.refundedCents) + '</b></div>' : '') +
      (s.cashbackCents ? '<div class="listitem"><div class="grow"><div class="nm">Cashback creditado</div></div><b>' + brl(s.cashbackCents) + '</b></div>' : '') +
      (s.refundRequests ? '<div class="sp8"></div><div class="alert warn">' + I.warn + s.refundRequests + ' pedido(s) de reembolso pra analisar</div>' : '') +
      '<div class="sp12"></div><button class="btn sm gho full" data-tact="csv">' + I.download + 'Exportar CSV</button></div>';
    h += '<div class="card">' + cardH(I.list, 'Inscrições (' + d.registrations.length + ')') +
      '<div class="row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div><label for="trf-st">Situação</label><select id="trf-st"><option value="">Todas</option>' + Object.keys(ST).map(function (k) { return '<option value="' + k + '"' + (f.status === k ? ' selected' : '') + '>' + ST[k][0] + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="trf-cat">Categoria</label><select id="trf-cat"><option value="">Todas</option>' + TR.cats.map(function (c) { return '<option value="' + c.id + '"' + (f.categoryId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div></div>' +
      '<label for="trf-q">Buscar</label><input id="trf-q" placeholder="Nome, responsável ou telefone" value="' + esc(f.q) + '">' +
      '<div class="sp12"></div>';
    if (!d.registrations.length) h += emptyB(I.users, 'Nenhuma inscrição com esse filtro.', 'sm');
    d.registrations.forEach(function (r) {
      var money = r.status === 'CONFIRMED' || r.status === 'REFUNDED' ? brl((r.paidCents || 0) + (r.tcCents || 0)) + ' pago' : (r.dueCents ? brl(r.dueCents) + ' a pagar' : 'grátis');
      h += '<div class="listitem card-tap" data-tact="reg" data-rid="' + r.id + '" style="cursor:pointer"><div class="av round">' + esc(String(r.displayName || '?').slice(0, 2).toUpperCase()) + '</div>' +
        '<div class="grow"><div class="nm">' + esc(r.displayName) + (r.refundStatus === 'REQUESTED' ? ' <span class="pill w">reembolso?</span>' : '') + '</div><div class="sub">' + esc(r.category) + ' · ' + esc(money) + (r.checkins ? ' · ✓ check-in' : '') + '</div></div>' + pill(r.status) + '</div>';
    });
    h += '</div>';
    body(h);
    var st = document.getElementById('trf-st'), ct = document.getElementById('trf-cat'), q = document.getElementById('trf-q');
    st.onchange = function () { f.status = st.value; drawList(); };
    ct.onchange = function () { f.categoryId = ct.value; drawList(); };
    var to; q.oninput = function () { clearTimeout(to); to = setTimeout(function () { f.q = q.value.trim(); drawList(); }, 450); };
  }

  function regSheet(rid) {
    var r = (TR.list.registrations || []).filter(function (x) { return x.id === rid; })[0];
    if (!r) return;
    var people = r.kind === 'TEAM' ? (r.roster || []).map(function (p) { return (p.number != null ? p.number + ' · ' : '') + esc(p.name) + (p.isGoalkeeper ? ' (GOL)' : ''); }).join('<br>') :
      (r.athletes || []).map(function (a) { return esc(a.name) + ' · ' + esc(a.birthDate) + (a.minor && a.guardian ? '<br><span class="muted">Responsável: ' + esc(a.guardian.name) + (a.guardian.relationship ? ' (' + esc(a.guardian.relationship) + ')' : '') + ' · ' + esc(a.guardian.phone) + '</span>' : ''); }).join('<br>');
    var ans = r.answers || {}, fields = (TR.cfg && TR.cfg.customFields) || [];
    var h = '<h3>' + esc(r.displayName) + '</h3><div class="brow" style="margin:4px 0 10px">' + pill(r.status) + '<span class="pill g">' + esc(r.category) + '</span></div>' +
      '<div class="subcard" style="padding:12px;border-radius:14px;background:var(--card2)">' +
      '<div class="sub">Responsável</div><div class="nm">' + esc(r.contactName) + ' · ' + esc(r.contactPhone) + (r.contactEmail ? ' · ' + esc(r.contactEmail) : '') + '</div>' +
      (people ? '<div class="sp8"></div><div class="sub">' + (r.kind === 'TEAM' ? 'Elenco' : 'Atleta(s)') + '</div><div>' + people + '</div>' : '') +
      (fields.length ? '<div class="sp8"></div>' + fields.map(function (fl) { var v = ans[fl.key]; return '<div class="sub">' + esc(fl.label) + ': <b>' + esc(v === true ? 'Sim' : v === false ? 'Não' : (v == null ? '—' : v)) + '</b></div>'; }).join('') : '') +
      '<div class="sp8"></div><div class="sub">Taxa ' + brl(r.feeCents) + (r.discountCents ? ' · cupom ' + esc(r.couponCode) + ' −' + brl(r.discountCents) : '') + (r.tcCents ? ' · TenisCash ' + brl(r.tcCents) : '') + (r.paidCents ? ' · dinheiro ' + brl(r.paidCents) : '') + (r.paymentMethod ? ' · ' + esc(r.paymentMethod) : '') + '</div>' +
      (r.paymentExpiresAt && r.status === 'PENDING_PAYMENT' ? '<div class="sub">Prazo: ' + dt(r.paymentExpiresAt) + '</div>' : '') +
      (r.termsAcceptedAt ? '<div class="sub">Termo v' + r.termsVersion + ' aceito em ' + dt(r.termsAcceptedAt) + '</div>' : '') +
      (r.cashbackStatus ? '<div class="sub">Cashback: ' + esc(r.cashbackStatus) + ' ' + brl(r.cashbackCents) + '</div>' : '') +
      (r.refundStatus ? '<div class="sub">Reembolso: ' + esc(r.refundStatus) + (r.refundReason ? ' — ' + esc(r.refundReason) : '') + (r.refundNote ? ' · ' + esc(r.refundNote) : '') + '</div>' : '') +
      '</div><div class="sp12"></div><div style="display:grid;gap:8px">';
    if (['PENDING_PAYMENT', 'WAITLIST', 'EXPIRED'].indexOf(r.status) >= 0) h += '<button class="btn" data-tact="mark-paid" data-rid="' + r.id + '">' + I.check + 'Recebi no local (' + brl(r.dueCents) + ')</button>';
    if (r.status === 'CONFIRMED') h += '<button class="btn sec" data-tact="manual-checkin" data-rid="' + r.id + '">' + I.check + 'Check-in manual (geral)</button>';
    if ((r.status === 'CONFIRMED' || r.status === 'EXPIRED') && (r.paidCents || r.tcCents)) h += '<button class="btn gho" data-tact="refund" data-rid="' + r.id + '">' + I.back + 'Registrar estorno</button>';
    if (r.refundStatus === 'REQUESTED' && r.status === 'CONFIRMED') h += '<button class="btn gho" data-tact="deny-refund" data-rid="' + r.id + '">' + I.x + 'Negar reembolso</button>';
    if (['PENDING_PAYMENT', 'WAITLIST'].indexOf(r.status) >= 0 && !r.paidCents) h += '<button class="btn dang" data-tact="cancel-reg" data-rid="' + r.id + '">' + I.trash + 'Cancelar inscrição</button>';
    h += '<button class="btn sm gho" data-tact="audit" data-rid="' + r.id + '">' + I.clock + 'Histórico</button></div>';
    openSheet(h);
  }

  function moneySheet(title, hint, label, prefill, act, rid, needNote) {
    openSheet('<h3>' + title + '</h3><p class="muted">' + hint + '</p><label for="tr-amt">' + label + '</label><input id="tr-amt" inputmode="decimal" value="' + esc(prefill) + '">' +
      '<label for="tr-note">' + (needNote ? 'Como foi feito (obrigatório)' : 'Observação') + '</label><textarea id="tr-note" maxlength="300"></textarea>' +
      '<div class="sp16"></div><button class="btn" data-tact="' + act + '" data-rid="' + rid + '">' + I.check + 'Confirmar</button>');
  }

  // ------------------------------------------------------------------ CHECK-IN
  async function drawCheckin() {
    var b;
    try { b = await tapi('/board'); } catch (e) { body('<div class="card">' + emptyB(I.warn, esc(e.message)) + '</div>'); return; }
    TR.board = b;
    var sc = TR.scope;
    var opts = '<option value="event"' + (sc.type === 'event' ? ' selected' : '') + '>Evento (presença geral)</option><option value="round"' + (sc.type === 'round' ? ' selected' : '') + '>Rodada…</option>' +
      b.matches.map(function (m) { return '<option value="m:' + m.matchId + '"' + (sc.type === 'match' && sc.matchId === m.matchId ? ' selected' : '') + '>' + esc((m.scheduledAt ? dt(m.scheduledAt) + ' · ' : '') + (m.home ? m.home.name : '?') + ' × ' + (m.away ? m.away.name : '?')) + '</option>'; }).join('');
    var h = '<div class="card wh">' + cardH(I.target, 'Ler QR de check-in') +
      '<label for="tr-scope">Presença em</label><select id="tr-scope">' + opts + '</select>' +
      '<div id="tr-round-w" style="display:' + (sc.type === 'round' ? 'block' : 'none') + '"><label for="tr-round">Nº da rodada</label><input id="tr-round" type="number" min="0" value="' + esc(sc.round) + '"></div>' +
      '<div class="sp12"></div><button class="btn big full" data-tact="scan">' + I.target + 'Abrir câmera e ler QR</button>' +
      '<div class="sp12"></div><label for="tr-code">Ou digite o código</label><div style="display:flex;gap:8px"><input id="tr-code" placeholder="código do QR" autocapitalize="off"><button class="btn sm" data-tact="code-go">OK</button></div></div>';
    if (b.suggestions.length) {
      h += '<div class="card">' + cardH(I.warn, 'W.O. sugerido (' + b.suggestions.length + ')') + '<p class="muted" style="margin:-4px 0 10px">Tolerância de ' + b.toleranceMin + ' min. Nada é aplicado sozinho — a coordenação confirma.</p>';
      b.suggestions.forEach(function (m) {
        h += '<div class="listitem"><div class="grow"><div class="nm">' + esc((m.home ? m.home.name : '?') + ' × ' + (m.away ? m.away.name : '?')) + '</div><div class="sub">' + esc(m.suggestion.text) + '</div></div>' +
          (TR.manage && m.suggestion.type === 'WO' ? '<button class="btn sm" data-tact="wo" data-mid="' + m.matchId + '" data-absent="' + m.suggestion.absentEntryId + '">Confirmar W.O.</button>' : '') + '</div>';
      });
      h += '</div>';
    }
    h += '<div class="card" id="tr-att">' + cardH(I.users, 'Presentes / ausentes') + '<div class="spin"></div></div>';
    body(h);
    var sel = document.getElementById('tr-scope');
    sel.onchange = function () {
      var v = sel.value;
      if (v.indexOf('m:') === 0) { sc.type = 'match'; sc.matchId = v.slice(2); } else { sc.type = v; sc.matchId = ''; }
      document.getElementById('tr-round-w').style.display = sc.type === 'round' ? 'block' : 'none';
      loadAttendance();
    };
    document.getElementById('tr-round').onchange = function () { sc.round = this.value; loadAttendance(); };
    document.getElementById('tr-code').onkeydown = function (e) { if (e.key === 'Enter') doCheckin(this.value); };
    loadAttendance();
  }
  function scopeBody() {
    var sc = TR.scope;
    if (sc.type === 'match') return { matchId: sc.matchId };
    if (sc.type === 'round') return { round: Number(sc.round) || 0 };
    return {};
  }
  async function loadAttendance() {
    var box = document.getElementById('tr-att'); if (!box) return;
    var sc = TR.scope, q = sc.type === 'match' ? '?matchId=' + sc.matchId : sc.type === 'round' ? '?round=' + (Number(sc.round) || 0) : '';
    var a;
    try { a = await tapi('/attendance' + q); } catch (e) { box.innerHTML = cardH(I.users, 'Presentes / ausentes') + emptyB('', esc(e.message), 'sm'); return; }
    var h = cardH(I.users, 'Presentes / ausentes');
    if (sc.type === 'match') {
      var side = function (s) {
        if (!s) return '';
        var st = !s.tracked ? '<span class="pill g">sem inscrição online</span>' : s.present ? '<span class="pill ok">' + I.check + 'presente</span>' : '<span class="pill w">ausente</span>';
        return '<div class="listitem"><div class="grow"><div class="nm">' + esc(s.name) + '</div></div>' + st + (s.tracked && !s.present ? '<button class="btn sm gho" data-tact="mcheck" data-rid="' + s.registrationId + '">Marcar</button>' : '') + (s.present ? '<button class="btn icon gho" aria-label="Desfazer" data-tact="undo" data-rid="' + s.registrationId + '" data-scope="' + a.scopeKey + '">' + I.x + '</button>' : '') + '</div>';
      };
      h += side(a.home) + side(a.away);
      if (a.deadline) h += '<p class="muted" style="margin-top:8px">Tolerância até ' + dt(a.deadline) + '.</p>';
      if (a.suggestion) h += '<div class="sp8"></div><div class="alert warn">' + I.warn + esc(a.suggestion.text) + '</div>' + (TR.manage && a.suggestion.type === 'WO' ? '<div class="sp8"></div><button class="btn full" data-tact="wo" data-mid="' + a.matchId + '" data-absent="' + a.suggestion.absentEntryId + '">Confirmar W.O.</button>' : '');
    } else {
      h += '<div class="brow" style="margin-bottom:8px"><span class="pill ok">' + a.present + ' presentes</span><span class="pill w">' + a.absent + ' ausentes</span></div>';
      if (!a.list.length) h += emptyB('', 'Nenhuma inscrição confirmada ainda.', 'sm');
      a.list.forEach(function (x) {
        h += '<div class="listitem"><div class="grow"><div class="nm">' + esc(x.displayName) + '</div><div class="sub">' + esc(x.category) + (x.present ? ' · ' + dt(x.at) + ' · ' + esc(x.method) : '') + '</div></div>' +
          (x.present ? '<span class="pill ok">' + I.check + '</span><button class="btn icon gho" aria-label="Desfazer" data-tact="undo" data-rid="' + x.registrationId + '" data-scope="' + a.scopeKey + '">' + I.x + '</button>' : '<button class="btn sm gho" data-tact="mcheck" data-rid="' + x.registrationId + '">Marcar</button>') + '</div>';
      });
    }
    box.innerHTML = h;
  }
  async function doCheckin(code, registrationId) {
    try {
      var r = await tapi('/checkin', { body: Object.assign({ code: code, registrationId: registrationId }, scopeBody()) });
      try { if (navigator.vibrate) navigator.vibrate(r.already ? [40, 60, 40] : 80); } catch (e) { }
      toast((r.already ? 'Já estava presente: ' : '✓ Presente: ') + r.registration.displayName);
      var res = document.getElementById('tr-scanres');
      if (res) res.innerHTML = '<div class="alert" style="background:#D9FFEA;color:#0B7A4B">' + I.check + esc(r.registration.displayName) + ' · ' + esc(r.registration.category) + (r.already ? ' (já estava)' : '') + '</div>';
      var ci = document.getElementById('tr-code'); if (ci) ci.value = '';
      loadAttendance();
    } catch (e) {
      try { if (navigator.vibrate) navigator.vibrate([200, 80, 200]); } catch (_) { }
      toast(e.message);
      var res2 = document.getElementById('tr-scanres');
      if (res2) res2.innerHTML = '<div class="alert bad">' + I.warn + esc(e.message) + '</div>';
    }
  }

  // câmera: BarcodeDetector nativo; senão o zxing-wasm que o repo já usa no scanner
  function loadZxing() {
    return new Promise(function (res, rej) {
      if (window.ZXingWASM) return res(window.ZXingWASM);
      var s = document.createElement('script'); s.src = '/vendor/barcode/zxing-reader-3.1.4.js';
      s.onload = function () { res(window.ZXingWASM); }; s.onerror = function () { rej(new Error('leitor não carregou')); };
      document.head.appendChild(s);
    });
  }
  async function decoder() {
    if ('BarcodeDetector' in window) {
      try {
        var fm = await window.BarcodeDetector.getSupportedFormats();
        if (fm.indexOf('qr_code') >= 0) { var bd = new window.BarcodeDetector({ formats: ['qr_code'] }); return function (v) { return bd.detect(v).then(function (r) { return r[0] ? r[0].rawValue : ''; }); }; }
      } catch (e) { }
    }
    var Z = await loadZxing();
    if (!CAM.zx) CAM.zx = Z.prepareZXingModule({ overrides: { locateFile: function () { return '/vendor/barcode/zxing_reader.wasm'; } }, fireImmediately: true });
    await CAM.zx;
    var cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    return async function (v) {
      var w = v.videoWidth, h = v.videoHeight; if (!w || !h) return '';
      var sc = Math.min(1, 720 / Math.max(w, h)); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
      cx.drawImage(v, 0, 0, cv.width, cv.height);
      var r = await Z.readBarcodes(cx.getImageData(0, 0, cv.width, cv.height), { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
      return r && r[0] ? r[0].text : '';
    };
  }
  function stopCam() { CAM.on = false; if (CAM.stream) { CAM.stream.getTracks().forEach(function (t) { t.stop(); }); CAM.stream = null; } }
  async function openScanner() {
    openSheet('<h3>Check-in por QR</h3><p class="muted">Aponte para o QR da inscrição. A leitura é contínua.</p>' +
      '<div style="position:relative;border-radius:18px;overflow:hidden;background:#000;aspect-ratio:1/1;margin-top:8px"><video id="tr-video" playsinline muted style="width:100%;height:100%;object-fit:cover"></video>' +
      '<div style="position:absolute;inset:18%;border:3px solid rgba(255,255,255,.85);border-radius:18px;pointer-events:none"></div></div>' +
      '<div id="tr-scanres" style="margin-top:10px"></div>');
    var v = document.getElementById('tr-video');
    try {
      CAM.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch (e) { document.getElementById('tr-scanres').innerHTML = '<div class="alert bad">' + I.warn + 'Sem acesso à câmera: ' + esc(e.message) + '</div>'; return; }
    v.srcObject = CAM.stream; try { await v.play(); } catch (e) { }
    var detect;
    try { detect = await decoder(); } catch (e) { document.getElementById('tr-scanres').innerHTML = '<div class="alert bad">' + I.warn + esc(e.message) + '</div>'; stopCam(); return; }
    CAM.on = true;
    var loop = async function () {
      if (!CAM.on) return;
      if (!document.getElementById('tr-video') || !document.getElementById('sheetbg').classList.contains('on')) { stopCam(); return; }
      try {
        var code = await detect(v);
        if (code && !(code === CAM.last && Date.now() - CAM.lastAt < 2500)) { CAM.last = code; CAM.lastAt = Date.now(); await doCheckin(code); }
      } catch (e) { }
      setTimeout(loop, 220);
    };
    loop();
  }

  // ------------------------------------------------------------------ CONFIG
  async function drawConfig() {
    var c = TR.cfg;
    if (TR.admin && !TR.stores.length) { try { TR.stores = (await tapi('/stores')).stores || []; } catch (e) { } }
    var h = '<div class="card wh">' + cardH(I.cog, 'Inscrição online') +
      '<label class="chk" style="margin-top:6px"><input type="checkbox" id="cf-en"' + (c.enabled ? ' checked' : '') + '>Inscrição online ligada</label>' +
      '<div class="sp12"></div><div class="sub" style="font-weight:800">Taxa e vagas por categoria</div>' +
      TR.cats.map(function (k) { var r = (c.categories || {})[k.id] || {}; return '<div style="display:grid;grid-template-columns:1fr 96px 80px;gap:8px;align-items:end;margin-top:6px"><div class="nm" style="padding-bottom:12px">' + esc(k.name) + '</div><div><label for="fee-' + k.id + '">Taxa R$</label><input id="fee-' + k.id + '" inputmode="decimal" value="' + centsIn(r.feeCents) + '" placeholder="0,00"></div><div><label for="max-' + k.id + '">Vagas</label><input id="max-' + k.id + '" type="number" min="1" value="' + (r.maxEntries || '') + '" placeholder="∞"></div></div>'; }).join('') +
      (TR.cats.length ? '' : '<p class="muted">Crie as categorias do torneio primeiro.</p>') +
      '<div class="sp12"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div><label for="cf-hold">Reserva aguardando PIX (min)</label><input id="cf-hold" type="number" min="10" max="1440" value="' + c.holdMinutes + '"></div>' +
      '<div><label for="cf-wl">Prazo após sair da fila (h)</label><input id="cf-wl" type="number" min="1" max="168" value="' + c.waitlistHoldHours + '"></div>' +
      '<div><label for="cf-tol">Tolerância check-in (min)</label><input id="cf-tol" type="number" min="0" max="180" value="' + c.checkinToleranceMin + '"></div>' +
      '<div><label for="cf-cb">Cashback TenisCash %</label><input id="cf-cb" type="number" min="0" max="30" value="' + (c.cashbackPct || 0) + '"' + (TR.admin ? '' : ' disabled title="Só o admin da Sports & Tennis"') + '></div></div>' +
      '<div class="checks"><label class="chk"><input type="checkbox" id="cf-tc"' + (c.allowTenisCash ? ' checked' : '') + '>Aceita saldo TenisCash</label><label class="chk"><input type="checkbox" id="cf-on"' + (c.allowOnsite ? ' checked' : '') + '>Aceita pagar no local</label></div>' +
      (TR.admin ? '<label for="cf-store">Conta PagBank que recebe o PIX</label><select id="cf-store"><option value="">Loja-sede do torneio / padrão</option>' + TR.stores.map(function (s) { return '<option value="' + s.id + '"' + (c.paymentStoreId === s.id ? ' selected' : '') + (s.pixReady ? '' : ' disabled') + '>' + esc(s.code + ' · ' + s.name) + (s.pixReady ? (s.sandbox ? ' (sandbox)' : '') : ' — sem PIX') + '</option>'; }).join('') + '</select>' : '') +
      '</div>';
    h += '<div class="card">' + cardH(I.doc, 'Termo de responsabilidade / regulamento') + '<p class="muted" style="margin:-4px 0 8px">O atleta precisa aceitar. Mudar o texto cria nova versão (fica registrada em cada inscrição).</p><textarea id="cf-terms" rows="7" maxlength="20000">' + esc(c.termsText || '') + '</textarea><div class="sub" style="margin-top:6px">Versão atual: ' + c.termsVersion + '</div></div>';
    h += '<div class="card">' + cardH(I.edit, 'Campos personalizados') + '<p class="muted" style="margin:-4px 0 8px">Ex.: tamanho de camisa, clube, nº do documento da federação.</p><div id="cf-fields"></div><button class="btn sm gho" data-tact="add-field">' + I.plus + 'Campo</button></div>';
    h += '<button class="btn big full" data-tact="save-cfg">' + I.check + 'Salvar configuração</button><div class="sp16"></div>';
    body(h);
    TR.fields = (c.customFields || []).map(function (x) { return Object.assign({}, x, { options: (x.options || []).join(', ') }); });
    drawFields();
  }
  function drawFields() {
    var box = document.getElementById('cf-fields'); if (!box) return;
    box.innerHTML = TR.fields.map(function (f, i) {
      return '<div class="subcard" style="padding:10px;border-radius:14px;background:var(--card2);margin-bottom:8px" data-frow="' + i + '"><div style="display:grid;grid-template-columns:1fr 110px;gap:8px"><div><label>Pergunta</label><input data-ff="label" value="' + esc(f.label) + '"></div><div><label>Tipo</label><select data-ff="type">' +
        [['text', 'Texto'], ['number', 'Número'], ['boolean', 'Sim/não'], ['select', 'Opções'], ['shirt', 'Camisa']].map(function (o) { return '<option value="' + o[0] + '"' + (f.type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div></div>' +
        '<div style="display:' + (f.type === 'select' ? 'block' : 'none') + '"><label>Opções (separe por vírgula)</label><input data-ff="options" value="' + esc(f.options || '') + '"></div>' +
        '<div class="brow" style="margin-top:8px"><label class="chk" style="min-height:40px"><input type="checkbox" data-ff="required"' + (f.required ? ' checked' : '') + '>Obrigatório</label><button class="btn sm dang" data-tact="del-field" data-fi="' + i + '">' + I.trash + 'Remover</button></div></div>';
    }).join('') || '<p class="muted">Nenhum campo extra.</p>';
    box.querySelectorAll('[data-ff="type"]').forEach(function (s) { s.onchange = function () { syncFields(); drawFields(); }; });
  }
  function syncFields() {
    document.querySelectorAll('#cf-fields [data-frow]').forEach(function (row) {
      var i = +row.getAttribute('data-frow'), f = TR.fields[i]; if (!f) return;
      f.label = row.querySelector('[data-ff=label]').value; f.type = row.querySelector('[data-ff=type]').value;
      var o = row.querySelector('[data-ff=options]'); f.options = o ? o.value : ''; f.required = row.querySelector('[data-ff=required]').checked;
    });
  }
  async function saveConfig() {
    syncFields();
    var cats = {}, bad = '';
    TR.cats.forEach(function (k) {
      var fee = toCents(document.getElementById('fee-' + k.id).value), mx = document.getElementById('max-' + k.id).value;
      if (isNaN(fee) || fee < 0) bad = 'Taxa inválida em ' + k.name;
      cats[k.id] = { feeCents: fee || 0, maxEntries: mx ? Number(mx) : null };
    });
    if (bad) return toast(bad);
    var b = {
      enabled: document.getElementById('cf-en').checked, categories: cats,
      holdMinutes: Number(document.getElementById('cf-hold').value), waitlistHoldHours: Number(document.getElementById('cf-wl').value),
      checkinToleranceMin: Number(document.getElementById('cf-tol').value), allowTenisCash: document.getElementById('cf-tc').checked, allowOnsite: document.getElementById('cf-on').checked,
      termsText: document.getElementById('cf-terms').value,
      customFields: TR.fields.map(function (f) { return { key: f.key, label: f.label, type: f.type, required: f.required, options: f.options }; }),
    };
    if (TR.admin) { b.cashbackPct = Number(document.getElementById('cf-cb').value) || 0; var st = document.getElementById('cf-store'); if (st) b.paymentStoreId = st.value || null; }
    try { var r = await tapi('/config', { method: 'PUT', body: b }); TR.cfg = r.config; toast('Configuração salva'); drawConfig(); } catch (e) { toast(e.message); }
  }

  // ------------------------------------------------------------------ CUPONS
  async function drawCoupons() {
    var cs;
    try { cs = (await tapi('/coupons')).coupons || []; } catch (e) { body('<div class="card">' + emptyB(I.warn, esc(e.message)) + '</div>'); return; }
    var h = '<div class="card wh">' + cardH(I.plus, 'Novo cupom') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label for="cp-code">Código</label><input id="cp-code" placeholder="AMIGOS10" autocapitalize="characters"></div>' +
      '<div><label for="cp-kind">Tipo</label><select id="cp-kind"><option value="PERCENT">% de desconto</option><option value="FIXED">R$ de desconto</option></select></div>' +
      '<div><label for="cp-val">Valor</label><input id="cp-val" inputmode="decimal" placeholder="10"></div>' +
      '<div><label for="cp-max">Limite de usos</label><input id="cp-max" type="number" min="1" placeholder="sem limite"></div></div>' +
      '<label for="cp-exp">Válido até (opcional)</label><input id="cp-exp" type="date">' +
      '<div class="sp12"></div><button class="btn full" data-tact="save-coupon">' + I.check + 'Criar cupom</button></div>';
    h += '<div class="card">' + cardH(I.list, 'Cupons (' + cs.length + ')');
    if (!cs.length) h += emptyB('', 'Nenhum cupom criado.', 'sm');
    cs.forEach(function (c) {
      h += '<div class="listitem"><div class="grow"><div class="nm">' + esc(c.code) + ' · ' + (c.kind === 'FIXED' ? brl(c.value) : c.value + '%') + '</div><div class="sub">' + c.usedCount + (c.maxUses ? '/' + c.maxUses : '') + ' usos' + (c.expiresAt ? ' · até ' + new Date(c.expiresAt).toLocaleDateString('pt-BR') : '') + '</div></div>' +
        '<button class="btn sm ' + (c.active ? 'gho' : '') + '" data-tact="coupon-toggle" data-cid="' + c.id + '" data-on="' + (c.active ? 0 : 1) + '">' + (c.active ? 'Desativar' : 'Ativar') + '</button></div>';
    });
    h += '</div>';
    body(h);
  }

  // ------------------------------------------------------------------ ações
  document.addEventListener('click', async function (ev) {
    var el = ev.target.closest('[data-tact]'); if (!el) return;
    var a = el.getAttribute('data-tact'), rid = el.getAttribute('data-rid');
    if (el.tagName === 'A' && !el.getAttribute('href')) ev.preventDefault();
    try {
      if (a === 'tab') { TR.tab = el.getAttribute('data-tab'); draw(); return; }
      if (a === 'copy-link') { var u = location.origin + '/t/' + TR.slug + '/inscricao'; try { await navigator.clipboard.writeText(u); toast('Link copiado'); } catch (e) { prompt('Copie o link:', u); } return; }
      if (a === 'csv') {
        var r = await fetch('/api/tournament-registration/manage/' + TR.tid + '/registrations.csv', { headers: { Authorization: 'Bearer ' + TOKEN } });
        if (!r.ok) throw new Error('não foi possível exportar');
        var blob = await r.blob(), link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'inscricoes-' + TR.slug + '.csv'; document.body.appendChild(link); link.click(); setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
        return;
      }
      if (a === 'reg') { regSheet(rid); return; }
      if (a === 'mark-paid') { var rg = TR.list.registrations.filter(function (x) { return x.id === rid; })[0]; moneySheet('Recebi no local', 'Fica registrado no histórico com seu nome, data e valor.', 'Valor recebido (R$)', centsIn(rg.dueCents), 'mark-paid-go', rid, false); return; }
      if (a === 'mark-paid-go') { var amt = toCents(document.getElementById('tr-amt').value); if (isNaN(amt)) return toast('Valor inválido'); await tapi('/registrations/' + rid + '/mark-paid', { body: { amountCents: amt, note: document.getElementById('tr-note').value } }); closeSheet(); toast('Pagamento registrado — inscrição confirmada'); drawList(); return; }
      if (a === 'refund') { var rr = TR.list.registrations.filter(function (x) { return x.id === rid; })[0]; moneySheet('Registrar estorno', 'O sistema NÃO devolve dinheiro: faça a devolução (PIX/dinheiro) e registre aqui. O TenisCash usado volta automático pro saldo do atleta e a vaga vai pro próximo da fila.', 'Valor devolvido em dinheiro (R$)', centsIn(rr.paidCents), 'refund-go', rid, true); return; }
      if (a === 'refund-go') { var rc = toCents(document.getElementById('tr-amt').value); if (isNaN(rc)) return toast('Valor inválido'); await tapi('/registrations/' + rid + '/refund', { body: { refundCents: rc, note: document.getElementById('tr-note').value } }); closeSheet(); toast('Estorno registrado'); drawList(); return; }
      if (a === 'deny-refund') { var why = prompt('Motivo (o atleta é avisado):'); if (why === null) return; await tapi('/registrations/' + rid + '/refund', { body: { denied: true, note: why } }); closeSheet(); toast('Reembolso negado'); drawList(); return; }
      if (a === 'cancel-reg') { if (!confirm('Cancelar esta inscrição? A vaga vai pro próximo da fila.')) return; await tapi('/registrations/' + rid + '/cancel', { body: {} }); closeSheet(); toast('Inscrição cancelada'); drawList(); return; }
      if (a === 'manual-checkin') { await tapi('/checkin', { body: { registrationId: rid } }); closeSheet(); toast('Check-in registrado'); drawList(); return; }
      if (a === 'audit') {
        var au = (await tapi('/audit?registrationId=' + rid)).audit || [];
        openSheet('<h3>Histórico</h3>' + (au.length ? au.map(function (x) { return '<div class="listitem"><div class="grow"><div class="nm">' + esc(x.action) + '</div><div class="sub">' + dt(x.createdAt) + (x.note ? ' · ' + esc(x.note) : '') + '</div></div></div>'; }).join('') : emptyB('', 'Sem registros.', 'sm')));
        return;
      }
      if (a === 'scan') { openScanner(); return; }
      if (a === 'code-go') { doCheckin(document.getElementById('tr-code').value); return; }
      if (a === 'mcheck') { doCheckin(null, rid); return; }
      if (a === 'undo') { await tapi('/checkin/undo', { body: { registrationId: rid, scopeKey: el.getAttribute('data-scope') } }); toast('Check-in desfeito'); loadAttendance(); return; }
      if (a === 'wo') {
        var mid = el.getAttribute('data-mid'), absent = el.getAttribute('data-absent');
        var m = (TR.board.matches || []).filter(function (x) { return x.matchId === mid; })[0] || {};
        openSheet('<h3>Confirmar W.O.</h3><p class="muted">Ausente: <b>' + esc(m.home && m.home.entryId === absent ? m.home.name : (m.away ? m.away.name : '')) + '</b>. Informe o placar do W.O. conforme o regulamento do torneio.</p>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label for="wo-h">' + esc(m.home ? m.home.name : 'Mandante') + '</label><input id="wo-h" type="number" min="0"></div><div><label for="wo-a">' + esc(m.away ? m.away.name : 'Visitante') + '</label><input id="wo-a" type="number" min="0"></div></div>' +
          '<label for="wo-n">Observação</label><input id="wo-n" placeholder="ex: não compareceu até a tolerância">' +
          '<div class="sp16"></div><button class="btn" data-tact="wo-go" data-mid="' + mid + '" data-absent="' + absent + '">' + I.check + 'Aplicar W.O.</button>');
        return;
      }
      if (a === 'wo-go') {
        var hs = document.getElementById('wo-h').value, as = document.getElementById('wo-a').value;
        if (hs === '' || as === '') return toast('Informe o placar');
        await tapi('/walkover', { body: { matchId: el.getAttribute('data-mid'), absentEntryId: el.getAttribute('data-absent'), homeScore: Number(hs), awayScore: Number(as), note: document.getElementById('wo-n').value } });
        closeSheet(); toast('W.O. aplicado'); drawCheckin(); return;
      }
      if (a === 'add-field') { syncFields(); TR.fields.push({ label: '', type: 'text', required: false, options: '' }); drawFields(); return; }
      if (a === 'del-field') { syncFields(); TR.fields.splice(+el.getAttribute('data-fi'), 1); drawFields(); return; }
      if (a === 'save-cfg') { saveConfig(); return; }
      if (a === 'save-coupon') {
        var kind = document.getElementById('cp-kind').value, raw = document.getElementById('cp-val').value;
        var value = kind === 'FIXED' ? toCents(raw) : Math.round(Number(String(raw).replace(',', '.')));
        await tapi('/coupons', { body: { code: document.getElementById('cp-code').value, kind: kind, value: value, maxUses: document.getElementById('cp-max').value || null, expiresAt: document.getElementById('cp-exp').value ? document.getElementById('cp-exp').value + 'T23:59:59-03:00' : null } });
        toast('Cupom criado'); drawCoupons(); return;
      }
      if (a === 'coupon-toggle') { await tapi('/coupons/' + el.getAttribute('data-cid') + '/active', { body: { active: el.getAttribute('data-on') === '1' } }); drawCoupons(); return; }
    } catch (e) { toast(e.message); }
  });
})();
