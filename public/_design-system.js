// =====================================================================
// DESIGN SYSTEM JS — Componentes de UI reutilizáveis
// =====================================================================
// Use estas funções em qualquer aba/página pra renderizar componentes
// padronizados (cards de produto, chips, KPIs, etc.).
// =====================================================================

window.DS = (function () {
  function fmtBRL(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ','); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function isNoBrand(b) { return !b || b === 'A DEFINIR' || b === ''; }

  /**
   * Renderiza CARD PADRÃO DE PRODUTO.
   * @param {Object} p - produto com {id, sku, name, brand, imageUrl, price, sizes[], category}
   * @param {Object} opts - {showActions:true, showStock:false, classification:null, customBadge:null}
   * @returns {string} HTML do card
   */
  function productCard(p, opts) {
    opts = opts || {};
    const c = opts.classification || (p.classification || {});
    const hasBrand = !isNoBrand(p.brand);
    const brandHtml = hasBrand
      ? '<span class="ds-product-brand">' + esc(p.brand) + '</span>'
      : '<span class="ds-product-brand empty">⚠ SEM MARCA</span>';
    const sizesArr = (p.sizes || []).map(s => s.size).filter(Boolean);
    const sizesStr = sizesArr.slice(0, 6).join(', ') + (sizesArr.length > 6 ? ' +' + (sizesArr.length - 6) : '');

    let pillsHtml = '';
    if (c.type) pillsHtml += '<span class="ds-pill ds-pill-type">' + esc(c.type) + '</span>';
    if (c.gender) pillsHtml += '<span class="ds-pill ds-pill-gender">' + esc(c.gender) + '</span>';
    if (c.modality) pillsHtml += '<span class="ds-pill ds-pill-modality">' + esc(c.modality) + '</span>';
    if (c.tier) pillsHtml += '<span class="ds-pill ds-pill-tier">' + esc(c.tier) + '</span>';

    let stockHtml = '';
    if (opts.showStock && p.totalStock != null) {
      const s = p.totalStock || 0;
      const col = s === 0 ? '#d70015' : s <= 5 ? '#b06b00' : '#0a843d';
      const bg = s === 0 ? '#fff1f0' : s <= 5 ? '#fff8e0' : '#e8f7ee';
      stockHtml = '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:8px 10px;background:' + bg + ';border-radius:8px;"><span style="font-size:11px;color:' + col + ';font-weight:700;">ESTOQUE</span><span style="font-size:16px;color:' + col + ';font-weight:800;">' + s + '</span></div>';
    }

    let actionsHtml = '';
    if (opts.showActions !== false) {
      const acts = opts.actions || [{ label: '✎ Editar', primary: true, onclick: 'openProductEdit(\'' + p.id + '\')' }];
      actionsHtml = '<div class="ds-product-actions">' + acts.map(a => '<button class="' + (a.primary ? 'primary' : '') + '" onclick="' + a.onclick + '" title="' + (a.title || '') + '">' + a.label + '</button>').join('') + '</div>';
    }

    return '<div class="ds-product-card">'
      + '<img class="ds-product-img" src="' + (p.imageUrl || '') + '" onerror="this.style.opacity=\'0.3\'">'
      + '<div class="ds-product-body">'
      + '<div class="ds-product-header">' + brandHtml + '<span class="ds-product-price">' + fmtBRL(p.price) + '</span></div>'
      + '<div class="ds-product-name">' + esc(p.name || '?') + '</div>'
      + '<div class="ds-product-sku">' + esc(p.sku || '') + '</div>'
      + (sizesStr ? '<div class="ds-product-meta">Tam: <strong>' + sizesStr + '</strong></div>' : '')
      + (pillsHtml ? '<div class="ds-product-pills">' + pillsHtml + '</div>' : '')
      + stockHtml
      + (opts.customBadge || '')
      + actionsHtml
      + '</div></div>';
  }

  /**
   * Renderiza linha de CHIPS de filtro.
   * @param {Object} cfg - {label, options: [{value, label, count?}], selected, onClick}
   * @returns {string} HTML
   */
  function chipsRow(cfg) {
    const label = cfg.label ? '<div class="ds-chips-label">' + esc(cfg.label) + '</div>' : '';
    const sel = cfg.selected || '';
    const chips = (cfg.options || []).map(o => {
      const isActive = String(o.value) === String(sel);
      const cnt = o.count != null ? '<span class="ds-chip-cnt">' + o.count + '</span>' : '';
      const onClick = cfg.onClick ? cfg.onClick.replace('{value}', String(o.value).replace(/'/g, "\\'")) : '';
      return '<button class="ds-chip' + (isActive ? ' active' : '') + '" data-val="' + esc(o.value) + '" onclick="' + onClick + '">' + esc(o.label) + cnt + '</button>';
    }).join('');
    return label + '<div class="ds-chips-row">' + chips + '</div>';
  }

  /**
   * Renderiza KPI card.
   */
  function kpiCard(cfg) {
    return '<div class="ds-kpi">'
      + '<div class="ds-kpi-icon" style="background:' + (cfg.bg || '#f5f5f7') + ';color:' + (cfg.color || '#1d1d1f') + ';">' + (cfg.icon || '·') + '</div>'
      + '<div class="ds-kpi-content"><div class="ds-kpi-label">' + esc(cfg.label) + '</div><div class="ds-kpi-value">' + (cfg.value != null ? cfg.value : '—') + '</div></div>'
      + '</div>';
  }

  function kpiGrid(items) {
    return '<div class="ds-kpi-grid">' + items.map(kpiCard).join('') + '</div>';
  }

  /**
   * Renderiza grid de cards de produto.
   */
  function productsGrid(products, opts) {
    if (!products || !products.length) return '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#8e8e93;">Nenhum produto.</div>';
    return '<div class="ds-products-grid">' + products.map(p => productCard(p, opts)).join('') + '</div>';
  }

  return {
    fmtBRL, esc, isNoBrand,
    productCard, productsGrid,
    chipsRow, kpiCard, kpiGrid,
  };
})();
