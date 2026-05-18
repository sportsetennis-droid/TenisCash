// =====================================================================
// PSBar — Product Search Bar reutilizável
// =====================================================================
// Componente padronizado pra busca/filtragem de produtos.
// Mesmo conjunto de filtros (Marca, Categoria, Fornecedor, Gênero,
// Modalidade, Especialidade) usado em: Catálogo, Estoque, Etiquetas,
// Curadoria, Imagens, ERP, Loja.
//
// API:
//   PSBar.mount(prefix, containerEl, opts)
//     - prefix: string única (ex: 'inv', 'lbl', 'img', 'loja')
//     - containerEl: HTMLElement
//     - opts: {
//         showSearch, showBrand, showCategory, showSupplier, showGender,
//         showModality, showTier, showStore, extraButtons, onChange, onClear,
//         compact, theme ('light'|'dark')
//       }
//
//   PSBar.getFilters(prefix) → { search, brand, category, supplier, gender, modality, tier, store }
//   PSBar.setFilters(prefix, obj) — preenche
//   PSBar.clear(prefix)
//   PSBar.filterInMemory(products, filters) → array filtrado
//   PSBar.loadOptions(endpoint?) — pré-carrega (público ou admin)
// =====================================================================

(function () {
  const PSBar = {};
  let _opts = null;
  let _publicOpts = null;

  // ---------- carrega opções ----------
  PSBar.loadOptions = async function (forcePublic = false) {
    // Tenta endpoint admin primeiro, senão público (loja)
    const cached = forcePublic ? _publicOpts : _opts;
    if (cached) return cached;
    const candidates = forcePublic
      ? ['/api/catalog/form-options', '/api/loja/form-options']
      : ['/api/admin/catalog/form-options', '/api/catalog/form-options'];
    for (const url of candidates) {
      try {
        const token = (typeof localStorage !== 'undefined' && localStorage.getItem('jwt')) || '';
        const headers = token ? { Authorization: 'Bearer ' + token } : {};
        const r = await fetch(url, { headers });
        if (!r.ok) continue;
        const data = await r.json();
        if (data && (data.brands || data.categories)) {
          const norm = {
            brands: data.brands || [],
            categories: data.categories || [],
            suppliers: data.suppliers || [],
            stores: data.stores || [],
            genders: data.genders || ['Homem','Mulher','Menino','Menina'],
            tree: data.tree || {
              types: ['Tênis', 'Chuteira', 'Outro'],
              modalities: {
                'Tênis': ['Corrida', 'Caminhada / Treino leve', 'LifeStyle', 'Recuperação', 'Musculação / CrossFit / Hyrox', 'Streetwear', 'Sapatilha'],
                'Chuteira': ['Futsal', 'Society', 'Campo'],
              },
              tiers: {},
            },
          };
          if (forcePublic) _publicOpts = norm; else _opts = norm;
          return norm;
        }
      } catch (_) { /* tenta próximo */ }
    }
    // fallback vazio
    return { brands: [], categories: [], suppliers: [], stores: [], genders: ['Homem','Mulher','Menino','Menina'], tree: { types: ['Tênis','Chuteira','Outro'], modalities: {}, tiers: {} } };
  };

  // ---------- monta a barra ----------
  PSBar.mount = async function (prefix, container, opts) {
    opts = opts || {};
    const el = typeof container === 'string' ? document.getElementById(container) : container;
    if (!el) { console.warn('[PSBar] container não encontrado:', container); return; }
    const show = (k, def) => opts[k] !== false && (def === undefined ? true : def);
    const dark = opts.theme === 'dark';
    const inputBg = dark ? '#1c1c1e' : 'white';
    const inputColor = dark ? '#f5f5f7' : '#1d1d1f';
    const inputBorder = dark ? '#3a3a3c' : '#e5e5ea';
    const placeholder = (txt) => `<option value="">${txt}</option>`;

    const html = [
      '<div class="psbar" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px;padding:12px;background:' + (dark ? 'rgba(255,255,255,0.03)' : 'linear-gradient(135deg,#f9f9fb,#fff)') + ';border:1px solid ' + inputBorder + ';border-radius:12px;">',
      show('showSearch') ? `<input class="psbar-input" id="${prefix}-q" placeholder="🔍 Buscar nome / SKU / referência" style="flex:1;min-width:220px;padding:9px 12px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">` : '',
      show('showBrand') ? `<select class="psbar-input" id="${prefix}-brand" style="min-width:130px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Marca')}</select>` : '',
      show('showCategory') ? `<select class="psbar-input" id="${prefix}-category" style="min-width:130px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Categoria')}</select>` : '',
      show('showSupplier', !opts.publicMode) ? `<select class="psbar-input" id="${prefix}-supplier" style="min-width:150px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Fornecedor')}</select>` : '',
      show('showGender') ? `<select class="psbar-input" id="${prefix}-gender" style="min-width:110px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Gênero')}<option value="Masculino">Homem</option><option value="Feminino">Mulher</option><option value="Inf. M">Menino</option><option value="Inf. F">Menina</option></select>` : '',
      show('showModality') ? `<select class="psbar-input" id="${prefix}-modality" style="min-width:140px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Modalidade')}</select>` : '',
      show('showTier') ? `<select class="psbar-input" id="${prefix}-tier" style="min-width:140px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Especialidade')}</select>` : '',
      show('showStore', false) ? `<select class="psbar-input" id="${prefix}-store" style="min-width:130px;padding:9px;border:1.5px solid ${inputBorder};border-radius:8px;background:${inputBg};color:${inputColor};font-size:13px;">${placeholder('Loja')}</select>` : '',
      `<button type="button" id="${prefix}-search-btn" style="padding:9px 16px;background:linear-gradient(135deg,#FF6D00,#FF9248);color:white;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;">🔎 Buscar</button>`,
      `<button type="button" id="${prefix}-clear-btn" title="Limpar filtros" style="padding:9px 12px;background:transparent;color:${inputColor};border:1.5px solid ${inputBorder};border-radius:8px;font-size:13px;cursor:pointer;">✕</button>`,
      opts.extraButtons || '',
      '</div>',
    ].filter(Boolean).join('');
    el.innerHTML = html;

    // popula selects
    const o = await PSBar.loadOptions(!!opts.publicMode);
    const populate = (id, items, valOf, labelOf) => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const first = sel.options[0];
      sel.innerHTML = '';
      if (first) sel.appendChild(first);
      items.forEach(it => {
        const op = document.createElement('option');
        op.value = valOf ? valOf(it) : it;
        op.textContent = labelOf ? labelOf(it) : it;
        sel.appendChild(op);
      });
    };
    populate(prefix + '-brand', o.brands);
    populate(prefix + '-category', o.categories);
    populate(prefix + '-supplier', o.suppliers, s => s.cnpj || s.id, s => s.companyName);
    const allMods = [...(o.tree.modalities['Tênis'] || []), ...(o.tree.modalities['Chuteira'] || [])];
    populate(prefix + '-modality', allMods);
    const allTiers = [...new Set(Object.values(o.tree.tiers || {}).flat())];
    populate(prefix + '-tier', allTiers);
    populate(prefix + '-store', o.stores, s => s.id, s => (s.code || '') + ' — ' + (s.name || ''));

    // bind eventos
    const searchBtn = document.getElementById(prefix + '-search-btn');
    if (searchBtn && typeof opts.onSearch === 'function') {
      searchBtn.addEventListener('click', () => opts.onSearch(PSBar.getFilters(prefix)));
    }
    const clearBtn = document.getElementById(prefix + '-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        PSBar.clear(prefix);
        if (typeof opts.onClear === 'function') opts.onClear();
        else if (typeof opts.onSearch === 'function') opts.onSearch(PSBar.getFilters(prefix));
      });
    }
    // onChange opcional — dispara quando muda qualquer select/input
    if (typeof opts.onChange === 'function') {
      ['-q','-brand','-category','-supplier','-gender','-modality','-tier','-store'].forEach(suffix => {
        const e = document.getElementById(prefix + suffix);
        if (e) e.addEventListener('change', () => opts.onChange(PSBar.getFilters(prefix)));
      });
    }
    // Enter no campo de busca dispara
    const qEl = document.getElementById(prefix + '-q');
    if (qEl && typeof opts.onSearch === 'function') {
      qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') opts.onSearch(PSBar.getFilters(prefix)); });
    }
    return o;
  };

  PSBar.getFilters = function (prefix) {
    const g = (id) => (document.getElementById(prefix + '-' + id)?.value || '').trim();
    return {
      search: g('q'),
      brand: g('brand'),
      category: g('category'),
      supplier: g('supplier'),
      gender: g('gender'),
      modality: g('modality'),
      tier: g('tier'),
      store: g('store'),
    };
  };

  PSBar.setFilters = function (prefix, obj) {
    obj = obj || {};
    Object.keys(obj).forEach(k => {
      const e = document.getElementById(prefix + '-' + (k === 'search' ? 'q' : k));
      if (e) e.value = obj[k];
    });
  };

  PSBar.clear = function (prefix) {
    ['q','brand','category','supplier','gender','modality','tier','store'].forEach(k => {
      const e = document.getElementById(prefix + '-' + k);
      if (e) e.value = '';
    });
  };

  // Filtra lista de produtos em memória pelos critérios da PSBar.
  // Cada produto pode ter: brand, category, sku, name, aiContext={classification:{gender,modality,tier},supplierCnpj,supplierId}
  PSBar.filterInMemory = function (products, filters) {
    if (!Array.isArray(products)) return products;
    const f = filters || {};
    const q = (f.search || '').toLowerCase();
    return products.filter(p => {
      const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } })();
      const cls = ctx.classification || {};
      if (f.brand && (p.brand || '').toLowerCase() !== f.brand.toLowerCase()) return false;
      if (f.category && (p.category || '').toLowerCase() !== f.category.toLowerCase()) return false;
      if (f.supplier && ctx.supplierCnpj !== f.supplier && ctx.supplierId !== f.supplier) return false;
      if (f.gender && cls.gender !== f.gender) return false;
      if (f.modality && cls.modality !== f.modality) return false;
      if (f.tier && cls.tier !== f.tier) return false;
      if (q) {
        const blob = [p.name, p.sku, p.brand, ctx.supplierRef].filter(Boolean).join(' ').toLowerCase();
        if (!blob.includes(q)) return false;
      }
      return true;
    });
  };

  // ---------- exporta ----------
  if (typeof window !== 'undefined') window.PSBar = PSBar;
  if (typeof module !== 'undefined' && module.exports) module.exports = PSBar;
})();
