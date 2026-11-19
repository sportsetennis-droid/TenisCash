/* Recuperador de bipes presos no aparelho — dono 14/11/2026:
 * "Eu quero que o bipe vá direito pro sistema e não fique no meu telefone nem no telefone de ninguém."
 *
 * Roda em QUALQUER página do TenisCash. Só LÊ o que a tela de bipagem guardou neste navegador
 * (fila de bipes e fila de fotos da contagem). Não apaga, não altera e não envia leitura nenhuma por
 * conta própria: o envio continua sendo feito pela tela de bipagem, que já tem as travas de
 * operador, rodada, foto e repetição. Este script:
 *   1) mostra um aviso vermelho fixo quando há leitura que ainda não chegou ao sistema;
 *   2) informa ao sistema quantas leituras este aparelho tem guardadas (POST /api/stocktake/device-pending),
 *      para o escritório saber de quem cobrar o envio;
 *   3) fora da tela de bipagem, abre /bipar.html em segundo plano (iframe invisível) para o envio rodar
 *      sozinho com as travas originais, sem a pessoa precisar fazer nada.
 */
(function (root) {
  'use strict';
  if (root.__tcScannerRecovery) return;
  root.__tcScannerRecovery = true;
  const DEVICE_KEY = 'tc_scanner_device_id_v1';
  const REPORT_KEY = 'tc_scanner_device_report_v1';
  const onBipar = /\/bipar(\.html)?$/i.test(root.location.pathname);
  const inFrame = root.self !== root.top;

  function read(key, fallback) { try { const v = JSON.parse(root.localStorage.getItem(key) || 'null'); return v == null ? fallback : v; } catch (_) { return fallback; } }
  function deviceId() {
    try {
      let id = root.localStorage.getItem(DEVICE_KEY);
      if (!id) { id = 'dev' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); root.localStorage.setItem(DEVICE_KEY, id); }
      return id;
    } catch (_) { return null; }
  }

  // Mesmo critério do contador "no aparelho/aguardando envio" da tela de bipagem.
  function stateOf(item) {
    const currentPhoto = item.capId && Number(item.capIdPhotoRevision || 0) === Number(item.photoRevision || 0);
    const codeOnlyReceived = item.bipeId && !item.photoRevision && !item.photoRef && !item.b64;
    if (item.excluded || item.msg === 'Repetição cancelada — não contada') return 'excluded';
    if (item.bipeId && item.bipou === true) return 'applied';
    if (item.authPending || item.repeat || item.repeatCancelPending || item.st === 'revisao' || item.st === 'erro' ||
        (!item.complete && (item.needsSize || item.alerta || item.st === 'pendente'))) return item.bipeId || currentPhoto ? 'received' : 'pending';
    return currentPhoto || codeOnlyReceived ? 'received' : 'local';
  }

  function scan() {
    const rounds = new Map();
    const touch = (item, kind) => {
      const key = (item.roundId || '?') + '|' + (item.storeId || '?');
      const row = rounds.get(key) || { roundId: item.roundId || null, storeId: item.storeId || null, storeLabel: item.storeLabel || null, local: 0, pending: 0, oldestAt: null, newestAt: null };
      row[kind]++;
      const m = String(item.clientScanId || '').match(/^cs([0-9a-z]{8})/);
      const at = m ? new Date(parseInt(m[1], 36)).toISOString() : null;
      if (at) { if (!row.oldestAt || at < row.oldestAt) row.oldestAt = at; if (!row.newestAt || at > row.newestAt) row.newestAt = at; }
      rounds.set(key, row);
    };
    const sellers = new Set(); let operatorName = null;
    // Fila de fotos/etiquetas da contagem (espelho leve gravado pela própria tela de bipagem).
    for (const item of [].concat(read('etiqFila', []))) {
      if (!item || typeof item !== 'object') continue;
      const s = stateOf(item);
      if (s === 'local' || s === 'pending') { touch(item, s); if (item.sellerId) sellers.add(item.sellerId); operatorName = operatorName || item.sellerName || null; }
    }
    // Fila de bipes sem foto (código digitado/leitor).
    const acked = id => { try { return !!root.localStorage.getItem('tc_bipe_retry_ack_v1:' + id); } catch (_) { return false; } };
    const retry = [].concat(read('tc_bipe_retry_queue', []));
    try {
      for (let i = 0; i < root.localStorage.length; i++) {
        const k = root.localStorage.key(i);
        if (k && k.startsWith('tc_bipe_retry_piece_v1:')) { const it = read(k, null); if (it) retry.push(it); }
      }
    } catch (_) {}
    const seen = new Set();
    for (const item of retry) {
      if (!item || typeof item !== 'object') continue;
      const id = item.clientScanId || JSON.stringify(item);
      if (seen.has(id) || (item.clientScanId && acked(item.clientScanId))) continue;
      seen.add(id);
      touch(item, item.blocked ? 'pending' : 'local');
      if (item.sellerId) sellers.add(item.sellerId); operatorName = operatorName || item.sellerName || null;
    }
    const byRound = [...rounds.values()];
    return { byRound, localCount: byRound.reduce((a, r) => a + r.local, 0), pendingCount: byRound.reduce((a, r) => a + r.pending, 0), sellerIds: [...sellers], operatorName };
  }

  function banner(state) {
    const doc = root.document; if (!doc?.body) return;
    let el = doc.getElementById('tc-scanner-recovery');
    const total = state.localCount;
    if (!total) { if (el) { el.remove(); doc.body.style.paddingTop = doc.body.dataset.tcRecoveryPad || ''; } return; }
    if (!el) {
      el = doc.createElement('div'); el.id = 'tc-scanner-recovery';
      el.setAttribute('role', 'alert');
      el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483646;background:#c62828;color:#fff;font:700 15px/1.3 system-ui,-apple-system,sans-serif;' +
        'padding:calc(10px + env(safe-area-inset-top)) 14px 10px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.35)';
      doc.body.dataset.tcRecoveryPad = doc.body.style.paddingTop || '';
      doc.body.appendChild(el);
    }
    const lojas = [...new Set(state.byRound.filter(r => r.local).map(r => r.storeLabel).filter(Boolean))].join(', ');
    el.innerHTML = '⚠ ' + total + ' bipe' + (total > 1 ? 's' : '') + ' de contagem ainda <u>neste celular</u>' + (lojas ? ' (' + lojas.replace(/[<>&]/g, '') + ')' : '') +
      ' — NÃO feche e NÃO limpe o navegador. ' + (onBipar ? 'Enviando…' : 'Enviando em segundo plano…') +
      (onBipar ? '' : ' <a href="/bipar.html" style="color:#fff;background:rgba(0,0,0,.25);padding:4px 10px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:4px">Abrir bipagem</a>');
    // Não cobrir o topo da página: empurra o conteúdo pra baixo da faixa.
    doc.body.style.paddingTop = (el.offsetHeight + 4) + 'px';
  }

  let frame = null;
  function backgroundSender(state) {
    // Fora da bipagem: carrega /bipar.html invisível para o envio rodar com as travas originais.
    if (onBipar || inFrame || !state.localCount) { if (frame && !state.localCount) { frame.remove(); frame = null; } return; }
    if (frame) return;
    frame = root.document.createElement('iframe');
    frame.src = '/bipar.html?recuperar=1';
    frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;opacity:0;pointer-events:none;border:0';
    root.document.body.appendChild(frame);
  }

  function report(state, force) {
    const id = deviceId(); if (!id) return;
    const sig = JSON.stringify([state.localCount, state.pendingCount, state.byRound.map(r => [r.roundId, r.local, r.pending])]);
    const last = read(REPORT_KEY, {});
    // Informa quando muda, e no máximo a cada 5 min mesmo sem mudança (aparelho "vivo").
    if (!force && last.sig === sig && Date.now() - (last.at || 0) < 5 * 60e3) return;
    if (!force && !state.localCount && !state.pendingCount && !last.sig) return; // aparelho que nunca bipou: nada a informar
    try { root.localStorage.setItem(REPORT_KEY, JSON.stringify({ sig, at: Date.now() })); } catch (_) {}
    try {
      root.fetch('/api/stocktake/device-pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
        body: JSON.stringify({ deviceId: id, page: root.location.pathname, ...state }) }).catch(() => {});
    } catch (_) {}
  }

  function tick(force) {
    if (inFrame) return;
    let state; try { state = scan(); } catch (_) { return; }
    banner(state); backgroundSender(state); report(state, force);
  }
  root.TenisCashScannerRecovery = { scan, refresh: () => tick(true) };
  const start = () => { tick(true); root.setInterval(() => tick(false), 10000); };
  if (root.document?.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start); else start();
  root.addEventListener?.('storage', e => { if (!e.key || /etiqFila|tc_bipe_retry/.test(e.key)) tick(false); });
  // Na bipagem: avisa antes de fechar/recarregar a página com bipe ainda no celular.
  if (onBipar && !inFrame) root.addEventListener?.('beforeunload', e => {
    try { if (scan().localCount > 0) { e.preventDefault(); e.returnValue = 'Ainda há bipes neste celular que não chegaram ao sistema.'; return e.returnValue; } } catch (_) {}
  });
})(typeof window !== 'undefined' ? window : globalThis);
