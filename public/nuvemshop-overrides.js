/* =====================================================================
 * Sports & Tennis — Overrides visuais na loja Nuvemshop
 * Hospedado em: https://teniscash.com.br/nuvemshop-overrides.js
 * Injetado via Nuvemshop API /scripts
 * =====================================================================
 * O que faz hoje:
 *  - Substitui "Tamanho" por "Tamanhos" só no cabeçalho (header)
 *  - Injeta botão "Descobrir meu tamanho" nas páginas de produto vestuário
 * ===================================================================== */
(function () {
  var TC_BASE = 'https://teniscash.com.br'; // ajustar se domínio mudar

  // -------------------------------------------------------------------
  // FIT BUTTON: injeta botão "Descobrir meu tamanho" na PDP
  // -------------------------------------------------------------------
  function isProductPage() {
    // Nuvemshop usa /produto/<slug> ou /products/<slug>
    var p = (location.pathname || '').toLowerCase();
    return /\/produto[s]?\//.test(p) || /\/products?\//.test(p);
  }

  function getProductIdFromMeta() {
    // Tenta meta tags ou data-attrs comuns em Nuvemshop
    var meta = document.querySelector('meta[property="og:product:id"]')
      || document.querySelector('meta[name="product:id"]');
    if (meta) return meta.getAttribute('content');
    var dp = document.querySelector('[data-product-id]');
    if (dp) return dp.getAttribute('data-product-id');
    return null;
  }

  function injectFitButton() {
    if (!isProductPage()) return;
    if (document.querySelector('.tc-fit-btn')) return; // já injetado

    // Alvo: container de variantes (tamanhos). Tenta seletores comuns.
    var target = document.querySelector('.js-product-variants')
      || document.querySelector('[class*="variant"]')
      || document.querySelector('.product-options')
      || document.querySelector('form[data-store="product-form"]');
    if (!target) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tc-fit-btn';
    btn.innerHTML = '<span style="font-size:18px;margin-right:8px">📐</span>Descobrir meu tamanho';
    btn.style.cssText = 'display:flex;align-items:center;justify-content:center;width:100%;padding:12px 16px;margin:12px 0;background:#E5571E;color:#fff;border:0;border-radius:10px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(229,87,30,0.3)';
    btn.onmouseenter = function () { btn.style.background = '#D14E1A'; };
    btn.onmouseleave = function () { btn.style.background = '#E5571E'; };
    btn.addEventListener('click', openFitModal);

    target.parentNode.insertBefore(btn, target);
  }

  function getTcSession() {
    // Tenta detectar usuário logado via cookie ou localStorage do TenisCash
    try {
      var raw = localStorage.getItem('tc_user');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
  }

  function openFitModal() {
    // Cria modal overlay
    var existing = document.getElementById('tc-fit-modal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'tc-fit-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var box = document.createElement('div');
    box.style.cssText = 'background:#1a1a1a;color:#fff;border-radius:16px;padding:28px;max-width:420px;width:100%;max-height:90vh;overflow:auto;font-family:system-ui,-apple-system,sans-serif';
    overlay.appendChild(box);

    var session = getTcSession();
    var productId = getProductIdFromMeta();

    if (session && session.lastScanId && productId) {
      // Usuário tem scan — busca recomendação direto
      box.innerHTML = '<p style="text-align:center;color:#FFD54F">Buscando seu tamanho ideal...</p>';
      fetch(TC_BASE + '/api/measurement/recommend?productId=' + encodeURIComponent(productId), {
        headers: { 'Authorization': 'Bearer ' + (session.token || '') },
        credentials: 'include',
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data.ok) {
            renderModalCallToAction(box, 'Não encontramos sua recomendação. Faça o scan no app.');
            return;
          }
          renderModalRecommendation(box, data);
        })
        .catch(function () {
          renderModalCallToAction(box, 'Erro ao buscar recomendação. Tente abrir o app TenisCash.');
        });
    } else {
      renderModalCallToAction(box, null);
    }

    document.body.appendChild(overlay);
  }

  function renderModalRecommendation(box, data) {
    box.innerHTML = ''
      + '<div style="text-align:center"><div style="font-size:48px">📐</div>'
      + '<p style="font-size:22px;font-weight:700;margin:8px 0 4px">Seu tamanho ideal</p>'
      + '<p style="font-family:Orbitron,sans-serif;font-size:64px;font-weight:900;color:#FFD54F;line-height:1">' + (data.recommendedSize || '–') + '</p>'
      + (data.alternativeSize ? '<p style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px">ou <strong>' + data.alternativeSize + '</strong> se preferir mais folgado</p>' : '')
      + '<p style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:14px;line-height:1.5">' + (data.reasoning || '') + '</p>'
      + '<p style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:14px">Precisão: ' + Math.round((data.confidence || 0) * 100) + '%</p>'
      + '<button onclick="document.getElementById(\'tc-fit-modal\').remove()" style="margin-top:20px;background:#E5571E;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-weight:700;cursor:pointer;width:100%">FECHAR</button>'
      + '</div>';
  }

  function renderModalCallToAction(box, errMsg) {
    box.innerHTML = ''
      + '<div style="text-align:center"><div style="font-size:56px">📐</div>'
      + '<p style="font-size:22px;font-weight:700;margin:12px 0 8px">Acerte o tamanho<br>de primeira</p>'
      + (errMsg ? '<p style="font-size:13px;color:#FFB4B4;margin-top:8px">' + errMsg + '</p>' : '')
      + '<p style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:12px;line-height:1.5">Use a câmera do seu celular para medir seu corpo e receber a recomendação exata para esta peça.</p>'
      + '<a href="' + TC_BASE + '/?screen=fit-camera" target="_blank" style="display:inline-block;margin-top:20px;background:#E5571E;color:#fff;padding:14px 24px;border-radius:8px;font-weight:700;text-decoration:none;width:100%;box-sizing:border-box">ABRIR NO TENISCASH</a>'
      + '<button onclick="document.getElementById(\'tc-fit-modal\').remove()" style="margin-top:10px;background:transparent;color:rgba(255,255,255,0.5);border:1px solid rgba(255,255,255,0.2);padding:10px 24px;border-radius:8px;cursor:pointer;width:100%">AGORA NÃO</button>'
      + '</div>';
  }

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
    try { injectFitButton(); } catch (_) {}
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
