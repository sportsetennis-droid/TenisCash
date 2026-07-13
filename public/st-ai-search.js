/* Sports & Tennis — Busca com IA (liga a barra da loja no endpoint do TenisCash).
   Deploy: adicionar como <script> antes de </body> no layout.tpl do tema, OU como arquivo
   static/js/st-ai-search.js incluído pelo layout. Sem dependências. */
(function () {
  var API = 'https://teniscash.com.br/api/catalog/search-ai';
  function fmtPrice(v) { if (v == null) return ''; return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }

  function render(panel, data, q) {
    var redirect = (data && data.redirect) || ('/search/?q=' + encodeURIComponent(q));
    if (!data || !data.products || !data.products.length) {
      panel.innerHTML = '<div style="padding:18px;text-align:center;color:#666;font-size:14px">Não achei um produto exato para <b>"' + q + '"</b>.<br><a href="' + redirect + '" style="color:#f05023;font-weight:700;text-decoration:none">Ver opções parecidas →</a></div>';
      panel.style.display = 'block'; return;
    }
    var items = data.products.map(function (p) {
      var preco = fmtPrice(p.promoPrice != null ? p.promoPrice : p.price);
      return '<a href="' + p.store_url + '" style="display:flex;gap:12px;align-items:center;padding:10px 14px;text-decoration:none;color:#222;border-bottom:1px solid #f2e9e3">'
        + (p.image ? '<img src="' + p.image + '" style="width:54px;height:54px;object-fit:contain;border-radius:8px;background:#faf5f2;flex:none" loading="lazy" alt="">' : '')
        + '<span style="flex:1;min-width:0">'
        + '<span style="display:block;font-size:13px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>'
        + '<span style="display:block;font-size:13px;color:#f05023;font-weight:800;margin-top:2px">' + preco + (p.inStock ? '' : ' <span style="color:#999;font-weight:500">(sob consulta)</span>') + '</span>'
        + '</span></a>';
    }).join('');
    var verTudo = '<a href="' + redirect + '" style="display:block;text-align:center;padding:12px;color:#f05023;font-weight:700;text-decoration:none;font-size:13px">Ver todos os resultados →</a>';
    panel.innerHTML = items + verTudo;
    panel.style.display = 'block';
  }

  function init() {
    var form = document.querySelector('.js-search-form') || document.querySelector('form[action*="search"]');
    if (!form) return;
    var input = form.querySelector('.js-search-input') || form.querySelector('input[name="q"]');
    if (!input) return;
    var panel = (form.parentNode && form.parentNode.querySelector('.js-search-suggest')) || form.querySelector('.js-search-suggest');
    if (!panel) { panel = document.createElement('div'); panel.className = 'js-ai-suggest'; form.appendChild(panel); }
    panel.style.cssText = 'position:absolute;z-index:99999;left:0;right:0;top:100%;background:#fff;border-radius:12px;box-shadow:0 12px 44px rgba(0,0,0,.18);max-height:440px;overflow:auto;margin-top:6px;display:none';
    if (getComputedStyle(form).position === 'static') form.style.position = 'relative';

    var t, lastQ = '';
    function go(q, force) {
      q = (q || '').trim();
      if (q.length < 2) { panel.style.display = 'none'; return; }
      if (q === lastQ && !force) { panel.style.display = 'block'; return; }
      lastQ = q;
      panel.innerHTML = '<div style="padding:18px;text-align:center;color:#999;font-size:14px">Buscando com IA…</div>';
      panel.style.display = 'block';
      fetch(API + '?q=' + encodeURIComponent(q) + '&limit=8')
        .then(function (r) { return r.json(); })
        .then(function (d) { render(panel, d, q); })
        .catch(function () { panel.style.display = 'none'; form.submit(); }); // erro → busca nativa
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); go(input.value, true); });
    input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { go(input.value); }, 350); });
    input.addEventListener('focus', function () { if (lastQ && panel.innerHTML) panel.style.display = 'block'; });
    document.addEventListener('click', function (e) { if (!form.contains(e.target)) panel.style.display = 'none'; });
  }
  if (document.readyState !== 'loading') init(); else document.addEventListener('DOMContentLoaded', init);
})();
