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

  // Landing das ofertas QR dentro do domínio oficial da loja. Os QR antigos
  // chegam aqui via redirecionamento e mantêm o código impresso inalterado.
  function startQrOffer() {
    if (window.__sportsTennisQrOfferStarted) return;
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('oferta') || params.get('qr_oferta');
    var match = raw && String(raw).toLowerCase().match(/^placa[-_ ]?(\d{1,2})$/);
    if (!match) return;
    var number = Number(match[1]);
    if (!Number.isInteger(number) || number < 1 || number > 12) return;
    window.__sportsTennisQrOfferStarted = true;

    var plate = 'placa-' + String(number).padStart(2, '0');
    var previousOverflow = document.documentElement.style.overflow;
    var root = document.createElement('div');
    root.id = 'sports-tennis-qr-offer';
    root.innerHTML = '<style>' +
      '#sports-tennis-qr-offer{position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#fff5ee;color:#21150f;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
      '#sports-tennis-qr-offer *{box-sizing:border-box}' +
      '#sports-tennis-qr-offer .tcq-wrap{max-width:1080px;margin:0 auto;padding:18px 16px 48px}' +
      '#sports-tennis-qr-offer .tcq-top{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#f4511e;font-weight:900;letter-spacing:.4px}' +
      '#sports-tennis-qr-offer .tcq-close{border:0;background:#fff;color:#21150f;border-radius:999px;width:42px;height:42px;font-size:25px;line-height:1;cursor:pointer;box-shadow:0 4px 14px #6b3b1c20}' +
      '#sports-tennis-qr-offer .tcq-hero{background:linear-gradient(135deg,#f4511e,#ff7b45);color:#fff;border-radius:22px;padding:28px 24px;margin:14px 0 18px;box-shadow:0 10px 28px #6b3b1c22}' +
      '#sports-tennis-qr-offer .tcq-hero h1{font-size:clamp(25px,5vw,48px);line-height:1.05;margin:12px 0}' +
      '#sports-tennis-qr-offer .tcq-hero p{font-size:17px;line-height:1.45;margin:8px 0}' +
      '#sports-tennis-qr-offer .tcq-badge{display:inline-block;background:#fff;color:#df3e12;border-radius:999px;padding:7px 12px;font-weight:900}' +
      '#sports-tennis-qr-offer .tcq-count{font-weight:900;margin-top:16px}' +
      '#sports-tennis-qr-offer .tcq-coupon{background:#fff;border:2px dashed #f4511e;border-radius:14px;padding:14px;margin-top:18px;font-weight:800}' +
      '#sports-tennis-qr-offer .tcq-coupon code{font-size:22px;letter-spacing:2px;color:#df3e12}' +
      '#sports-tennis-qr-offer .tcq-exchange{margin:18px 0;padding:14px 16px;background:#fff;border-radius:14px;font-weight:750}' +
      '#sports-tennis-qr-offer .tcq-products{display:grid;grid-template-columns:repeat(auto-fit,minmax(235px,1fr));gap:16px}' +
      '#sports-tennis-qr-offer .tcq-product{background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 8px 24px #6b3b1c16}' +
      '#sports-tennis-qr-offer .tcq-product img{display:block;width:100%;aspect-ratio:1/1;object-fit:contain;background:#fafafa}' +
      '#sports-tennis-qr-offer .tcq-product>div{padding:16px}' +
      '#sports-tennis-qr-offer .tcq-product small{color:#7d6f68;font-weight:800}' +
      '#sports-tennis-qr-offer .tcq-product h2{font-size:17px;min-height:44px;margin:8px 0}' +
      '#sports-tennis-qr-offer .tcq-price{font-size:22px;font-weight:900;color:#df3e12}' +
      '#sports-tennis-qr-offer .tcq-buy{display:block;text-align:center;background:#f4511e;color:#fff;text-decoration:none;border-radius:10px;padding:12px;font-weight:900}' +
      '#sports-tennis-qr-offer .tcq-empty{text-align:center;background:#fff;border-radius:18px;padding:40px 18px;font-size:18px}' +
      '@media(max-width:600px){#sports-tennis-qr-offer .tcq-wrap{padding:12px 12px 32px}#sports-tennis-qr-offer .tcq-hero{padding:22px 18px;border-radius:16px}}' +
      '</style><main class="tcq-wrap"><div class="tcq-top"><span>SPORTS &amp; TENNIS · OFERTA QR ' + String(number).padStart(2, '0') + '</span><button class="tcq-close" data-close aria-label="Fechar">×</button></div><div data-content class="tcq-empty">Carregando oferta exclusiva…</div></main>';
    document.body.appendChild(root);
    document.documentElement.style.overflow = 'hidden';

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function close() {
      root.remove();
      document.documentElement.style.overflow = previousOverflow;
      window.__sportsTennisQrOfferStarted = false;
    }
    root.querySelector('[data-close]').addEventListener('click', close);
    function money(value) {
      return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    }
    function render(data) {
      var offer = data && data.offer;
      var content = root.querySelector('[data-content]');
      if (!offer) {
        content.className = 'tcq-empty';
        content.innerHTML = '<strong>Oferta exclusiva em breve</strong><br><span>Esta placa recebe uma seleção nova todos os dias. Tente novamente mais tarde.</span>';
        return;
      }
      var products = Array.isArray(offer.products) ? offer.products : [];
      var cards = products.map(function (p) {
        return '<article class="tcq-product"><img src="' + escapeHtml(p.imageUrl || '') + '" alt="' + escapeHtml(p.name) + '"><div><small>' + escapeHtml(p.brand || '') + '</small><h2>' + escapeHtml(p.name) + '</h2><p class="tcq-price">' + money(p.promoPrice || p.price) + '</p><a class="tcq-buy" href="' + escapeHtml(p.storeUrl || '#') + '">Comprar com desconto</a></div></article>';
      }).join('');
      var end = offer.endsAt ? new Date(offer.endsAt).toISOString() : '';
      content.className = '';
      content.innerHTML = '<section class="tcq-hero"><span class="tcq-badge">EXCLUSIVA PARA QUEM LEU A PLACA</span><h1>' + escapeHtml(offer.title) + '</h1><p>Escolha seu produto e finalize na loja oficial com o desconto desta placa.</p><div class="tcq-count" data-count>Válida por 24 horas</div><div class="tcq-coupon">Cupom da oferta: <code>' + escapeHtml(offer.couponCode || '') + '</code><br><small>O desconto será aplicado no checkout da Nuvemshop.</small></div></section>' + (offer.freeExchange ? '<div class="tcq-exchange">↔ Troca grátis garantida pela Sports &amp; Tennis.</div>' : '') + '<section class="tcq-products">' + (cards || '<div class="tcq-empty">Nenhum produto disponível nesta oferta.</div>') + '</section>';
      if (!end) return;
      var count = content.querySelector('[data-count]');
      function tick() {
        var remaining = Math.max(0, new Date(end).getTime() - Date.now());
        var h = Math.floor(remaining / 3600000);
        var m = Math.floor((remaining % 3600000) / 60000);
        var s = Math.floor((remaining % 60000) / 1000);
        count.textContent = remaining ? 'Termina em ' + h + 'h ' + m + 'min ' + s + 's' : 'Oferta encerrada';
      }
      tick();
      window.setInterval(tick, 1000);
    }
    fetch('https://teniscash.com.br/api/qr-offers/plates/' + plate, { credentials: 'omit' })
      .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
      .then(render)
      .catch(function () { root.querySelector('[data-content]').innerHTML = '<strong>Não foi possível carregar esta oferta agora.</strong><br><span>Feche e tente novamente em instantes.</span>'; });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startQrOffer);
  else setTimeout(startQrOffer, 0);
})();
