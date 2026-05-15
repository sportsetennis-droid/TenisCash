/* =====================================================================
 * Sports & Tennis — Overrides visuais na loja Nuvemshop
 * Hospedado em: https://teniscash.com.br/nuvemshop-overrides.js
 * Injetado via Nuvemshop API /scripts
 * =====================================================================
 * O que faz hoje:
 *  - Substitui "Tamanho" por "Tamanhos" só no cabeçalho (header)
 * ===================================================================== */
(function () {
  function replaceTamanhoInHeader() {
    var header = document.querySelector('header') || document.querySelector('.header') ||
      document.querySelector('[class*="header"]') || document.querySelector('#header') ||
      document.querySelector('.nav-bar') || document.querySelector('[class*="navbar"]');
    if (!header) return;
    var walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var v = node.nodeValue;
      if (v && /(^|\s)Tamanho(\s|$|:)/.test(v) && !/Tamanhos/.test(v)) {
        node.nodeValue = v.replace(/\bTamanho\b/g, 'Tamanhos');
      }
    }
  }

  function run() {
    try { replaceTamanhoInHeader(); } catch (_) {}
  }

  // Roda assim que possível
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
  // Re-aplica algumas vezes pra cobrir lazy load / SPA do tema
  setTimeout(run, 300);
  setTimeout(run, 1500);
  setTimeout(run, 4000);

  // Observa mudanças no DOM caso o tema re-renderize
  if (window.MutationObserver) {
    var obs = new MutationObserver(function (muts) {
      // Throttle leve — re-aplica só se algum nó foi adicionado/modificado
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].addedNodes && muts[i].addedNodes.length) {
          run();
          break;
        }
      }
    });
    try {
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }
})();
