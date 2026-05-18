// =====================================================================
// PCard — Product Card padronizado em todo o sistema
// =====================================================================
// Mesmo card visual usado em: Catálogo, Estoque, Contagem (loja),
// Curadoria (admin/loja), Etiquetas. Foto + carousel, nome, marca, REF,
// preço destaque, pills (gênero/categoria/modalidade/especialidade),
// tamanhos por loja.
//
// API:
//   PCard.render(product, opts)  → string HTML
//   PCard.renderGrid(products, opts)  → grid completo
//   PCard.escapeHtml(s)
//   PCard.crslNav(carouselId, dir)  (precisa estar window-acessível)
//
// opts:
//   actions: 'admin'|'public'|'count'|null  (default: 'admin')
//   onClick: handler de click no card (string JS, ex: 'showProduct(\'%id%\')')
//   storeColors: { LOJA01: '#0066cc', ... }
//   showStock: bool   (default true)
//   showActions: bool (default true em admin)
//   minWidth: '300px' (default)
// =====================================================================

(function () {
  const PCard = {};
  const DEFAULT_STORE_COLORS = { LOJA01: '#0066cc', LOJA02: '#0a843d', LOJA03: '#b06b00', LOJA04: '#8a2be2', LOJA05: '#d70015', LOJA06: '#1d1d1f' };

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  PCard.escapeHtml = esc;

  function fmtBRL(n) { return 'R$ ' + Number(n || 0).toFixed(2).replace('.', ','); }

  function parseAiCtx(p) {
    try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
    catch { return {}; }
  }

  // Mapeia gênero técnico → label visível
  const GENDER_LABEL = { 'Masculino': 'Homem', 'Feminino': 'Mulher', 'Inf. M': 'Menino', 'Inf. F': 'Menina' };

  // Carousel navegável globalmente
  PCard.crslNav = function (carouselId, dir) {
    const c = document.getElementById(carouselId);
    if (!c) return;
    const total = parseInt(c.dataset.total, 10) || 1;
    let idx = parseInt(c.dataset.idx, 10) || 0;
    idx = (idx + dir + total) % total;
    c.dataset.idx = String(idx);
    c.querySelectorAll('.crsl-img').forEach(img => {
      img.style.display = (parseInt(img.dataset.idx, 10) === idx) ? 'block' : 'none';
    });
    const counter = c.querySelector('.crsl-counter');
    if (counter) counter.textContent = String(idx + 1);
  };
  if (typeof window !== 'undefined') window.crslNav = window.crslNav || PCard.crslNav;

  /**
   * Renderiza UM card de produto.
   */
  PCard.render = function (p, opts) {
    opts = opts || {};
    const actions = opts.actions === undefined ? 'admin' : opts.actions;
    const storeColors = opts.storeColors || DEFAULT_STORE_COLORS;
    const showStock = opts.showStock !== false;
    const showActions = opts.showActions !== false && actions !== 'public';
    const onClick = opts.onClick ? opts.onClick.replace(/%id%/g, p.id) : null;

    const ctx = parseAiCtx(p);
    const cls = ctx.classification || {};
    const brandText = (p.brand || '').trim();
    const hasBrand = brandText && brandText !== 'A DEFINIR';
    const cat = (p.category || '') + (p.subcategory ? ' / ' + p.subcategory : '');
    const desc = (p.shortDescription || '').trim();
    const ref = ctx.supplierRef || '';
    const hasPromo = p.promoPrice && p.promoPrice < p.price;
    const showPrice = hasPromo ? p.promoPrice : p.price;
    const genderLabel = GENDER_LABEL[cls.gender] || cls.gender;

    // Status enriquecido?
    const enriched = !!(p.imageUrl && p.shortDescription);
    const statusBadge = enriched
      ? '<span style="background:#e8f7ee;color:#0a843d;padding:2px 7px;border-radius:6px;font-size:10px;font-weight:700;">✨ COMPLETO</span>'
      : '<span style="background:#fff8e0;color:#b06b00;padding:2px 7px;border-radius:6px;font-size:10px;font-weight:700;">⚠ FALTANTE</span>';

    // Tamanhos por loja
    const byStore = {};
    (p.sizes || []).forEach(sz => {
      (sz.storeStocks || []).forEach(ss => {
        const code = ss.store?.code || ss.storeCode || '?';
        const storeName = ss.store?.name || ss.storeName || code;
        if (!byStore[code]) byStore[code] = { color: storeColors[code] || '#8e8e93', name: storeName, items: [] };
        const qty = ss.stock || 0;
        for (let i = 0; i < qty; i++) byStore[code].items.push(sz.size);
      });
    });
    // Fallback: sem storeStocks, só agregado de tamanhos
    const sizesFlat = !Object.keys(byStore).length && (p.sizes || []).length
      ? (p.sizes || []).map(s => ({ size: s.size, stock: s.stock || 0 })).filter(s => s.stock > 0)
      : [];

    // Fotos
    let photos = [];
    if (p.imageUrl) photos.push(p.imageUrl);
    try {
      const extras = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || []);
      if (Array.isArray(extras)) extras.forEach(u => { if (u && !photos.includes(u)) photos.push(u); });
    } catch {}
    if (!photos.length) photos = [''];
    const carouselId = 'pcrsl-' + p.id;

    let html = '';
    const cardStyle = `background:white;border:1px solid var(--border, #e5e5ea);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:all 0.15s;${onClick ? 'cursor:pointer;' : ''}`;
    const clickAttr = onClick ? ` onclick="${onClick}"` : '';
    html += `<div style="${cardStyle}"${clickAttr} onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 12px 28px rgba(0,0,0,0.08)'" onmouseout="this.style.transform='';this.style.boxShadow=''">`;

    // CARROSSEL
    html += `<div id="${carouselId}" data-idx="0" data-total="${photos.length}" style="position:relative;width:100%;aspect-ratio:4/3;background:#f5f5f7;">`;
    photos.forEach((url, idx) => {
      html += `<img class="crsl-img" data-idx="${idx}" src="${esc(url)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:6px;display:${idx === 0 ? 'block' : 'none'};" onerror="this.style.opacity='0.3'">`;
    });
    if (photos.length > 1) {
      html += `<button type="button" onclick="event.stopPropagation();PCard.crslNav('${carouselId}',-1)" style="position:absolute;left:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);">‹</button>`;
      html += `<button type="button" onclick="event.stopPropagation();PCard.crslNav('${carouselId}',1)" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);">›</button>`;
      html += `<div style="position:absolute;bottom:6px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:white;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;"><span class="crsl-counter">1</span> / ${photos.length}</div>`;
    }
    html += '</div>';

    // CORPO
    html += '<div style="padding:14px;display:flex;flex-direction:column;gap:8px;flex:1;">';
    // Marca + Preço (destaque)
    html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">`;
    html += `<span style="padding:3px 10px;background:${hasBrand ? 'linear-gradient(135deg,#1d1d1f,#3a3a3c)' : '#f5f5f7'};color:${hasBrand ? 'white' : '#d70015'};font-size:11px;font-weight:800;border-radius:6px;letter-spacing:0.5px;${hasBrand ? '' : 'border:1px dashed #d70015;'}">${hasBrand ? esc(brandText) : '⚠ SEM MARCA'}</span>`;
    if (showPrice != null) {
      if (hasPromo) {
        html += `<div style="display:flex;flex-direction:column;align-items:flex-end;line-height:1;">`;
        html += `<span style="font-size:11px;color:#8e8e93;text-decoration:line-through;">${fmtBRL(p.price)}</span>`;
        html += `<span style="font-size:16px;font-weight:800;color:#E5571E;">${fmtBRL(p.promoPrice)}</span>`;
        html += `</div>`;
      } else {
        html += `<span style="font-size:16px;font-weight:800;color:#E5571E;">${fmtBRL(showPrice)}</span>`;
      }
    }
    html += '</div>';

    // Nome
    html += `<div style="font-size:14px;font-weight:700;line-height:1.3;color:#1d1d1f;">${esc(p.name || '?')}</div>`;

    // SKU + REF
    html += `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text2, #8e8e93);font-family:monospace;flex-wrap:wrap;">`;
    if (p.sku) html += `<span title="SKU">📋 ${esc(p.sku)}</span>`;
    if (ref) html += `<span title="Referência do fornecedor" style="background:#FCDAC4;color:#E5571E;padding:1px 6px;border-radius:4px;font-weight:700;">REF: ${esc(ref)}</span>`;
    html += '</div>';

    // Botão specs
    if (actions === 'admin' && p.longDescription) {
      html += `<button type="button" onclick="event.stopPropagation();catShowSpecs && catShowSpecs('${p.id}')" style="padding:7px 10px;background:#fff;border:1.5px solid #E5571E;color:#E5571E;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;text-align:left;display:flex;align-items:center;gap:6px;">📋 Ver descrição técnica</button>`;
    }

    // Descrição
    if (desc) html += `<div style="font-size:11px;color:var(--text2, #8e8e93);line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${esc(desc)}</div>`;

    // Pills (gênero / categoria / modalidade / especialidade)
    let metaPills = '';
    const catNorm = (cat || '').toLowerCase().replace(/[^a-z]/g, '');
    const typeNorm = (cls.type || '').toLowerCase().replace(/[^a-z]/g, '');
    const catIsRedundant = catNorm && typeNorm && (catNorm === typeNorm || catNorm.includes(typeNorm) || typeNorm.includes(catNorm));
    if (cat && !catIsRedundant) metaPills += `<span style="font-size:10px;padding:2px 7px;background:#f5f5f7;color:#1d1d1f;border-radius:6px;font-weight:600;">📂 ${esc(cat)}</span>`;
    if (cls.type) metaPills += `<span style="font-size:10px;padding:2px 7px;background:#FCDAC4;color:#E5571E;border-radius:6px;font-weight:700;">${esc(cls.type)}</span>`;
    if (genderLabel) metaPills += `<span style="font-size:10px;padding:2px 7px;background:#e3f2fd;color:#0066cc;border-radius:6px;font-weight:700;">${esc(genderLabel)}</span>`;
    if (cls.modality) metaPills += `<span style="font-size:10px;padding:2px 7px;background:#f0f0f3;color:#1d1d1f;border-radius:6px;font-weight:600;">${esc(cls.modality)}</span>`;
    if (cls.tier) metaPills += `<span style="font-size:10px;padding:2px 7px;background:#fff8e0;color:#b06b00;border-radius:6px;font-weight:700;">⭐ ${esc(cls.tier)}</span>`;
    if (metaPills) html += `<div style="display:flex;flex-wrap:wrap;gap:4px;">${metaPills}</div>`;

    // TAMANHOS POR LOJA
    if (showStock) {
      const storesArr = Object.keys(byStore).sort();
      if (storesArr.length) {
        const totalUn = storesArr.reduce((s, c) => s + byStore[c].items.length, 0);
        html += `<div style="margin-top:8px;padding:12px;background:linear-gradient(135deg,#fff,#FFEBDC);border-radius:10px;border:2px solid #FCDAC4;">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">`;
        html += `<div style="font-size:11px;color:#E5571E;text-transform:uppercase;letter-spacing:1px;font-weight:800;">📦 Estoque por loja</div>`;
        html += `<div style="font-size:12px;color:#1d1d1f;font-weight:800;">${totalUn} un. total</div>`;
        html += '</div>';
        storesArr.forEach(code => {
          const info = byStore[code];
          const counts = {};
          info.items.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
          const sortedSizes = Object.keys(counts).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
          const pillsHtml = sortedSizes.map(sz => {
            const qty = counts[sz];
            return `<span style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:white;border:2px solid ${info.color};border-radius:10px;font-size:14px;font-weight:800;color:#1d1d1f;">${esc(sz)}${qty > 1 ? `<span style="background:${info.color};color:white;padding:2px 7px;border-radius:7px;font-size:11px;font-weight:700;">×${qty}</span>` : ''}</span>`;
          }).join('');
          html += `<div style="margin-bottom:10px;padding:10px;background:white;border-radius:8px;border-left:4px solid ${info.color};">`;
          html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">`;
          html += `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${info.color};flex-shrink:0;"></span>`;
          html += `<div style="flex:1;min-width:0;">`;
          html += `<div style="font-size:13px;font-weight:800;color:${info.color};line-height:1.2;">${esc(code)}</div>`;
          html += `<div style="font-size:11px;color:#8e8e93;font-weight:600;line-height:1.2;">${esc(info.name)}</div>`;
          html += `</div>`;
          html += `<span style="font-size:13px;font-weight:800;color:${info.color};background:${info.color}15;padding:3px 10px;border-radius:8px;flex-shrink:0;">${info.items.length} un.</span>`;
          html += `</div>`;
          html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">${pillsHtml}</div>`;
          html += '</div>';
        });
        html += '</div>';
      } else if (sizesFlat.length) {
        // Fallback: tamanhos sem loja vinculada
        html += `<div style="margin-top:8px;padding:10px;background:#f5f5f7;border-radius:10px;">`;
        html += `<div style="font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:8px;">📦 Tamanhos disponíveis</div>`;
        html += `<div style="display:flex;flex-wrap:wrap;gap:6px;">`;
        sizesFlat.sort((a, b) => (parseInt(a.size, 10) || 0) - (parseInt(b.size, 10) || 0)).forEach(s => {
          html += `<span style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:white;border:1.5px solid #e5e5ea;border-radius:10px;font-size:14px;font-weight:700;color:#1d1d1f;">${esc(s.size)}${s.stock > 1 ? `<span style="background:#0a843d;color:white;padding:2px 6px;border-radius:6px;font-size:10px;font-weight:700;">×${s.stock}</span>` : ''}</span>`;
        });
        html += '</div></div>';
      } else if (actions === 'admin') {
        html += `<div style="margin-top:8px;padding:14px;background:#fff1f0;border-radius:10px;border:2px dashed #d70015;font-size:13px;color:#d70015;text-align:center;font-weight:700;">⚠ Nenhuma loja vinculada</div>`;
      }
    }

    // Status + ações
    if (actions === 'admin' && showActions) {
      html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">${statusBadge}`;
      html += `<span style="font-size:10px;color:${p.active === false ? '#d70015' : '#0a843d'};font-weight:700;">${p.active === false ? '○ Inativo' : '● Ativo'}</span></div>`;
      html += `<div style="display:flex;gap:6px;margin-top:auto;padding-top:8px;border-top:1px dashed var(--border, #e5e5ea);">`;
      html += `<button type="button" onclick="event.stopPropagation();openCatProductModal && openCatProductModal('${p.id}')" style="flex:1;padding:8px;border-radius:8px;background:linear-gradient(135deg,#E5571E,#EE7240);color:white;border:none;font-size:12px;font-weight:600;cursor:pointer;">✎ Editar</button>`;
      html += `<button type="button" onclick="event.stopPropagation();catShowQRCode && catShowQRCode('${p.id}')" style="padding:8px 10px;border-radius:8px;background:white;border:1px solid var(--border, #e5e5ea);font-size:14px;cursor:pointer;" title="QR Code">📱</button>`;
      html += '</div>';
    } else if (actions === 'count') {
      // Modo Contagem: input pra contar
      html += `<div style="margin-top:auto;padding-top:8px;border-top:1px dashed var(--border, #e5e5ea);display:flex;gap:6px;align-items:center;">`;
      html += `<label style="font-size:11px;color:#8e8e93;font-weight:700;">CONTADO:</label>`;
      html += `<input type="number" min="0" placeholder="0" data-pid="${p.id}" class="js-pcard-count" style="flex:1;padding:8px;border:1.5px solid #E5571E;border-radius:8px;font-size:14px;font-weight:700;background:white;color:#1d1d1f;text-align:center;">`;
      html += '</div>';
    }

    html += '</div></div>';
    return html;
  };

  PCard.renderGrid = function (products, opts) {
    opts = opts || {};
    const minWidth = opts.minWidth || '300px';
    let html = '';
    if (opts.showCount !== false) {
      html += `<p style="font-size:13px;color:var(--text2, #8e8e93);margin-bottom:12px;">${products.length} produtos</p>`;
    }
    html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(${minWidth},1fr));gap:14px;">`;
    products.forEach(p => { html += PCard.render(p, opts); });
    html += '</div>';
    return html;
  };

  if (typeof window !== 'undefined') window.PCard = PCard;
  if (typeof module !== 'undefined' && module.exports) module.exports = PCard;
})();
