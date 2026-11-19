/* Club Sports & Tennis — AO VIVO por Server-Sent Events com volta automática.
 * window.ClubLiveSSE.connect(url, { onMessage(data), onState(open:boolean) }) → { close(), isOpen() }
 *  - onState(true) quando a conexão abre; onState(false) quando cai (ou o navegador não tem SSE).
 *    Quem usa liga a consulta de 20 s SÓ no onState(false) e desliga no onState(true).
 *  - Queda simples: o próprio EventSource reconecta (o servidor manda "retry: 4000").
 *  - Conexão FECHADA (servidor recusou: lotado/erro): reconecta com espera crescente
 *    (2 s, 4 s, 8 s… até 60 s, com variação) — não martela o servidor.
 * Usado pela página /t/:slug (via torneio-midia.js), telão, embed e /racha/:slug.
 */
(function () {
  'use strict';
  if (window.ClubLiveSSE) return;
  function connect(url, o) {
    o = o || {};
    var es = null, tries = 0, timer = null, stopped = false, up = null;
    function state(v) { if (up !== v) { up = v; if (o.onState) { try { o.onState(v); } catch (e) { /* ignora */ } } } }
    function schedule() {
      if (stopped) return;
      clearTimeout(timer);
      var d = Math.min(60000, 2000 * Math.pow(2, tries++));
      d = Math.round(d * (0.8 + Math.random() * 0.4));
      timer = setTimeout(open, d);
    }
    function open() {
      if (stopped) return;
      if (!window.EventSource) { state(false); return; }
      try { es = new window.EventSource(url); } catch (e) { state(false); schedule(); return; }
      es.onopen = function () { tries = 0; state(true); };
      es.onmessage = function (e) { var d; try { d = JSON.parse(e.data); } catch (_) { return; } if (o.onMessage) o.onMessage(d); };
      es.onerror = function () {
        state(false);
        if (es && es.readyState === 2) { try { es.close(); } catch (_) { /* ignora */ } es = null; schedule(); }
      };
    }
    open();
    return {
      close: function () { stopped = true; clearTimeout(timer); if (es) { try { es.close(); } catch (_) { /* ignora */ } } },
      isOpen: function () { return up === true; },
    };
  }
  window.ClubLiveSSE = { connect: connect };
})();
