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

  // Carousel navegável globalmente — pula imgs que falharam
  PCard.crslNav = function (carouselId, dir) {
    const c = document.getElementById(carouselId);
    if (!c) return;
    const imgs = Array.from(c.querySelectorAll('.crsl-img')).filter(i => !i.dataset.failed);
    if (!imgs.length) return;
    const currentIdx = imgs.findIndex(i => i.style.display === 'block');
    let next = (currentIdx + dir + imgs.length) % imgs.length;
    imgs.forEach((img, i) => { img.style.display = (i === next) ? 'block' : 'none'; });
    const counter = c.querySelector('.crsl-counter');
    if (counter) counter.textContent = String(next + 1);
    const total = c.querySelector('.crsl-total');
    if (total) total.textContent = String(imgs.length);
  };
  if (typeof window !== 'undefined') window.crslNav = window.crslNav || PCard.crslNav;

  // Fallback de imagem: marca a img como falha e ativa a próxima do carrossel
  PCard.imgFail = function (img) {
    img.dataset.failed = '1';
    img.style.display = 'none';
    const c = img.closest('[id^="pcrsl-"]');
    if (!c) return;
    // Se era a img visível, ativa a próxima que não falhou
    const goodImgs = Array.from(c.querySelectorAll('.crsl-img')).filter(i => !i.dataset.failed);
    if (goodImgs.length) {
      goodImgs.forEach((i, idx) => { i.style.display = idx === 0 ? 'block' : 'none'; });
      const counter = c.querySelector('.crsl-counter');
      if (counter) counter.textContent = '1';
      const total = c.querySelector('.crsl-total');
      if (total) total.textContent = String(goodImgs.length);
    } else {
      // Todas falharam — esconde controles do carrossel
      c.querySelectorAll('.crsl-ctrl').forEach(b => b.style.display = 'none');
      const badge = c.querySelector('.crsl-badge');
      if (badge) badge.style.display = 'none';
    }
  };
  if (typeof window !== 'undefined') window.PCard = window.PCard || PCard;

  // ============================================================
  // Variantes de cor do mesmo modelo (lazy, dispara quando card entra na viewport)
  // Renderiza fileira de miniaturas estilo On Running / e-commerce
  // ============================================================
  PCard._colorVariantsCache = {};
  PCard.loadColorVariants = async function (productId) {
    const slot = document.querySelector('.pcard-colorvar-slot[data-pid="' + productId + '"]');
    if (!slot || slot.dataset.loaded === '1' || slot.dataset.loading === '1') return;
    slot.dataset.loading = '1';
    try {
      let data = PCard._colorVariantsCache[productId];
      if (!data) {
        const token = localStorage.getItem('tc_admin_token') || '';
        const r = await fetch('/api/admin/catalog/products/' + productId + '/color-variants', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!r.ok) { slot.dataset.loaded = '1'; return; }
        data = await r.json();
        PCard._colorVariantsCache[productId] = data;
      }
      const variants = (data.variants || []).filter(v => !v.isCurrent); // tira o atual da fileira
      if (variants.length === 0) { slot.dataset.loaded = '1'; return; }

      const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      let html = '<div style="margin-top:10px;padding-top:10px;border-top:1px dashed #e5e5ea;">';
      html += '<div style="font-size:10px;font-weight:700;color:#8e8e93;letter-spacing:0.5px;margin-bottom:6px;text-transform:uppercase;">🎨 ' + variants.length + ' OUTRA' + (variants.length > 1 ? 'S CORES DESSE MODELO' : ' COR DESSE MODELO') + '</div>';
      html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
      variants.slice(0, 8).forEach(v => {
        const img = v.imageUrl
          ? `<img src="${esc(v.imageUrl)}" referrerpolicy="no-referrer-when-downgrade" style="width:100%;height:100%;object-fit:contain;background:#fafafa;" onerror="this.style.display='none';this.parentElement.style.background='#eee';">`
          : '<div style="width:100%;height:100%;background:#eee;display:flex;align-items:center;justify-content:center;font-size:18px;color:#c0c0c5;">📷</div>';
        const titleAttr = esc(v.color || v.ref || '');
        html += `<a href="#" data-vid="${esc(v.id)}" title="${titleAttr}" class="pcard-colorvar-thumb" style="width:64px;height:64px;border-radius:10px;border:2px solid #e5e5ea;overflow:hidden;cursor:pointer;transition:all 0.15s;flex-shrink:0;display:block;text-decoration:none;background:#fff;" onmouseover="this.style.borderColor='#E5571E';this.style.transform='scale(1.08)';this.style.boxShadow='0 4px 12px rgba(229,87,30,0.25)';" onmouseout="this.style.borderColor='#e5e5ea';this.style.transform='';this.style.boxShadow='';">${img}</a>`;
      });
      if (variants.length > 8) html += `<div style="width:64px;height:64px;border-radius:10px;border:2px dashed #c0c0c5;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#8e8e93;flex-shrink:0;">+${variants.length - 8}</div>`;
      html += '</div></div>';
      slot.innerHTML = html;
      slot.dataset.loaded = '1';
      // Click handler: SUBSTITUI INLINE o card pela variante clicada (estilo On Running)
      slot.querySelectorAll('.pcard-colorvar-thumb').forEach(el => {
        el.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const vid = el.dataset.vid;
          PCard.swapCardInline(productId, vid);
        };
      });
    } catch (e) {
      console.warn('[PCard] color-variants fail:', e.message);
      slot.dataset.loaded = '1';
    } finally {
      slot.dataset.loading = '';
    }
  };

  // ============================================================
  // Índice global de productIds bipados (Set carregado 1x, cache 5min)
  // Qualquer card renderizado consulta esse Set pra mostrar badge "BIPADO"
  // ============================================================
  PCard._bipedSet = null;
  PCard._bipedSetLoadedAt = 0;
  PCard._bipedSetPromise = null;
  PCard.loadBipedIndex = async function (force) {
    const now = Date.now();
    if (!force && PCard._bipedSet && (now - PCard._bipedSetLoadedAt) < 5 * 60 * 1000) return PCard._bipedSet;
    if (PCard._bipedSetPromise) return PCard._bipedSetPromise;
    PCard._bipedSetPromise = (async () => {
      try {
        const token = localStorage.getItem('tc_admin_token') || '';
        const r = await fetch('/api/stocktake/biped-product-ids', { headers: { 'Authorization': 'Bearer ' + token } });
        if (!r.ok) { PCard._bipedSet = PCard._bipedSet || new Set(); return PCard._bipedSet; }
        const d = await r.json();
        PCard._bipedSet = new Set(d.productIds || []);
        PCard._bipedSetLoadedAt = Date.now();
      } catch {
        PCard._bipedSet = PCard._bipedSet || new Set();
      } finally {
        PCard._bipedSetPromise = null;
      }
      // Re-renderiza badges nos cards já no DOM (caso loadBipedIndex tenha sido chamado depois dos renders)
      try {
        document.querySelectorAll('.pcard-biped-slot[data-pid]').forEach(slot => {
          const pid = slot.getAttribute('data-pid');
          const isBiped = PCard._bipedSet && PCard._bipedSet.has(pid);
          slot.innerHTML = isBiped ? PCard._bipedBadgeHtml() : '';
        });
      } catch {}
      return PCard._bipedSet;
    })();
    return PCard._bipedSetPromise;
  };
  PCard.isBiped = function (productId) {
    return !!(PCard._bipedSet && PCard._bipedSet.has(productId));
  };
  PCard._bipedBadgeHtml = function () {
    return '<span title="Produto bipado em loja — confirmado em estoque físico" style="background:#e8f7ee;color:#0a843d;padding:2px 7px;border-radius:6px;font-size:10px;font-weight:700;display:inline-flex;align-items:center;gap:3px;">📍 BIPADO</span>';
  };

  // ============================================================
  // swapCardInline: substitui o conteudo de UM card pela info de
  // outra variante (cor), sem abrir modal nem navegar.
  // Estilo On Running: vc clica numa miniatura -> a imagem grande
  // e os dados do card mudam pra essa cor.
  // ============================================================
  PCard.swapCardInline = async function (currentProductId, newProductId) {
    if (currentProductId === newProductId) return;
    // Acha o nó do card atual (pelo carrossel ID)
    const carrossel = document.getElementById('pcrsl-' + currentProductId);
    const cardWrap = carrossel ? carrossel.parentElement : null;
    if (!cardWrap) { console.warn('[PCard] swap: card atual nao achado pid=' + currentProductId); return; }

    // Loading visual
    cardWrap.style.opacity = '0.55';
    cardWrap.style.pointerEvents = 'none';
    try {
      // Busca produto novo (endpoint admin)
      const token = localStorage.getItem('tc_admin_token') || '';
      const r = await fetch('/api/admin/catalog/products/' + newProductId, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      const newProd = d.product;
      if (!newProd) throw new Error('produto nao retornado');

      // Re-renderiza com os mesmos opts (extrai do cardWrap... ou usa default 'admin')
      const newHtml = PCard.render(newProd, { actions: 'admin', showStock: true });
      // Substitui o outerHTML do card
      const wrapper = document.createElement('div');
      wrapper.innerHTML = newHtml;
      const newNode = wrapper.firstElementChild;
      if (newNode && cardWrap.parentNode) {
        cardWrap.parentNode.replaceChild(newNode, cardWrap);
        // Re-agenda observers (NFe summary) + força carregamento IMEDIATO das variantes
        // de cor (o card já está na viewport, não precisa esperar IntersectionObserver)
        PCard._scheduleObserve();
        // Carrega variantes JÁ — sem esperar observer (evita slot ficar vazio)
        setTimeout(() => {
          try { PCard.loadColorVariants(newProductId); } catch (e) { console.warn('[PCard] swap loadColorVariants:', e.message); }
        }, 50);
      }
    } catch (err) {
      console.error('[PCard] swap fail:', err);
      cardWrap.style.opacity = '';
      cardWrap.style.pointerEvents = '';
      alert('Erro ao trocar variante: ' + err.message);
    }
  };

  // Auto-load índice de bipados ao carregar a página (admin/bipes/etc)
  if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { try { PCard.loadBipedIndex(); } catch {} });
    } else {
      setTimeout(() => { try { PCard.loadBipedIndex(); } catch {} }, 100);
    }
  }

  // ============================================================
  // Carrega entrada de NFe automaticamente quando card entra na viewport
  // ============================================================
  PCard.loadNfeSummary = async function (productId) {
    const container = document.querySelector(`.pcard-nfe-content[data-pid="${productId}"]`);
    if (!container || container.dataset.loaded === '1' || container.dataset.loading === '1') return;
    container.dataset.loading = '1';
    try {
      const token = localStorage.getItem('tc_admin_token') || '';
      const r = await fetch('/api/admin/catalog/products/' + productId + '/nfe-summary', { headers: { 'Authorization': 'Bearer ' + token } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const t = d.totals || {};
      let html = '';
      // Resumo totais (4 colunas: COMPRADO · VENDIDO · ESTOQUE · DIFERENÇA)
      const dif = t.diferenca || 0;
      const difColor = dif > 0 ? '#d70015' : dif < 0 ? '#b06b00' : '#0a843d';
      const difSign = dif > 0 ? '−' : dif < 0 ? '+' : '';
      const difLabel = dif === 0 ? '✓' : `${difSign}${Math.abs(dif)}`;
      // Helper pra mostrar breakdown por loja (microline cinza embaixo do número)
      const bd = d.breakdown || {};
      const breakLine = (arr) => {
        if (!arr || arr.length === 0) return '';
        const txt = arr.slice(0, 4).map(x => `${esc(x.loja)} ${x.qtd}`).join(' · ');
        return `<div style="font-size:9px;color:#8e8e93;font-weight:600;margin-top:2px;line-height:1.1;">${esc(txt)}</div>`;
      };
      // Grid responsivo: 4 colunas se couber, senão quebra pra 2x2 automaticamente
      html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(82px,1fr));gap:5px;margin-bottom:10px;">`;
      html += `<div style="background:white;padding:6px 4px;border-radius:6px;text-align:center;min-width:0;"><div style="font-size:9px;color:#8e8e93;font-weight:700;letter-spacing:0.3px;">COMPRADO</div><div style="font-size:17px;font-weight:800;color:#0066cc;">${t.comprado || 0}</div>${breakLine(bd.compradoPorLoja)}</div>`;
      html += `<div style="background:white;padding:6px 4px;border-radius:6px;text-align:center;min-width:0;"><div style="font-size:9px;color:#8e8e93;font-weight:700;letter-spacing:0.3px;">VENDIDO</div><div style="font-size:17px;font-weight:800;color:#0a843d;">${t.vendido || 0}</div>${breakLine(bd.vendidoPorLoja)}</div>`;
      html += `<div style="background:white;padding:6px 4px;border-radius:6px;text-align:center;min-width:0;"><div style="font-size:9px;color:#8e8e93;font-weight:700;letter-spacing:0.3px;">ESTOQUE</div><div style="font-size:17px;font-weight:800;color:#E5571E;">${t.emEstoque || 0}</div>${breakLine(bd.estoquePorLoja)}</div>`;
      html += `<div style="background:white;padding:6px 4px;border-radius:6px;text-align:center;min-width:0;"><div style="font-size:9px;color:#8e8e93;font-weight:700;letter-spacing:0.3px;">PERDA</div><div style="font-size:17px;font-weight:800;color:${difColor};">${difLabel}</div></div>`;
      html += `</div>`;
      if (t.diferenca > 0) {
        html += `<div style="background:#fff1f0;padding:6px 10px;border-radius:6px;font-size:11px;color:#d70015;margin-bottom:8px;">⚠ ${t.comprado} comprado − ${t.vendido || 0} vendido − ${t.emEstoque} estoque = <b>${t.diferenca} sumiram</b> (perda / não bipado)</div>`;
      } else if (t.diferenca === 0 && (t.comprado > 0)) {
        html += `<div style="background:#e8f7ee;padding:6px 10px;border-radius:6px;font-size:11px;color:#0a843d;margin-bottom:8px;">✓ Tudo bate: comprado = vendido + estoque</div>`;
      }
      if (t.receita) {
        html += `<div style="background:white;padding:5px 10px;border-radius:6px;font-size:11px;color:#0a843d;margin-bottom:8px;text-align:right;font-weight:700;">💰 Receita: R$ ${Number(t.receita).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</div>`;
      }
      // Lista de entradas
      const entradas = d.entradas || [];
      if (entradas.length === 0) {
        html += `<div style="color:#8e8e93;font-size:11px;text-align:center;padding:10px;">Nenhuma entrada via NFe registrada pra esse produto</div>`;
      } else {
        html += `<div style="font-size:10px;color:#0066cc;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${entradas.length} entrada${entradas.length > 1 ? 's' : ''}</div>`;
        html += `<div style="max-height:220px;overflow-y:auto;background:white;border-radius:6px;">`;
        entradas.slice(0, 30).forEach(e => {
          const data = e.data ? new Date(e.data).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }) : '?';
          html += `<div style="padding:8px 10px;border-bottom:1px solid #f0f0f5;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">`;
          html += `<div style="flex:1;min-width:0;">`;
          html += `<div style="font-weight:600;">${data} · <span style="color:#0066cc">${e.lojaDestino || '?'}</span></div>`;
          html += `<div style="font-size:11px;color:#0a0a0a;margin-top:2px;"><b>NF ${esc(e.numero || '?')}</b></div>`;
          html += `<div style="font-size:10px;color:#8e8e93;">${esc((e.fornecedor || '').slice(0, 40))}</div>`;
          if (e.ref) html += `<div style="font-size:10px;color:#8e8e93;">Ref fornec: ${esc(e.ref)}</div>`;
          html += `</div>`;
          html += `<div style="text-align:right;flex-shrink:0;">`;
          html += `<div style="font-weight:800;color:#0066cc;font-size:14px;">${e.quantidade} un</div>`;
          if (e.valorUnit) html += `<div style="font-size:10px;color:#8e8e93;">R$ ${Number(e.valorUnit).toFixed(2)} ea</div>`;
          if (e.valorTotal) html += `<div style="font-size:10px;color:#8e8e93;">total R$ ${Number(e.valorTotal).toFixed(2)}</div>`;
          html += `</div>`;
          html += `</div>`;
        });
        html += `</div>`;
      }
      // VENDAS — lista detalhada
      const vendas = d.vendas || [];
      if (vendas.length > 0) {
        html += `<div style="font-size:10px;color:#0a843d;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-top:10px;margin-bottom:4px;">💰 ${vendas.length} venda${vendas.length > 1 ? 's' : ''}</div>`;
        html += `<div style="max-height:200px;overflow-y:auto;background:white;border-radius:6px;">`;
        vendas.slice(0, 20).forEach(v => {
          const data = v.data ? new Date(v.data).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }) : '?';
          html += `<div style="padding:6px 10px;border-bottom:1px solid #f0f0f5;display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">`;
          html += `<div style="flex:1;min-width:0;font-size:11px;">`;
          html += `<div style="font-weight:600;">${data}${v.loja ? ' · <span style="color:#0a843d">' + esc(v.loja) + '</span>' : ''}${v.tamanho ? ' · Tam ' + esc(v.tamanho) : ''}</div>`;
          html += `</div>`;
          html += `<div style="text-align:right;flex-shrink:0;font-size:11px;">`;
          html += `<div style="font-weight:800;color:#0a843d;">${v.quantidade} un</div>`;
          if (v.valorTotal) html += `<div style="font-size:10px;color:#8e8e93;">R$ ${Number(v.valorTotal).toFixed(2)}</div>`;
          html += `</div>`;
          html += `</div>`;
        });
        html += `</div>`;
      }

      // Transferências movidas pra fora deste bloco — agora têm card próprio
      container.innerHTML = html;
      container.dataset.loaded = '1';
      container.dataset.loading = '';

      // Preenche TAMBÉM o card laranja de transferências (separado)
      const transfContainer = document.querySelector(`.pcard-transf-content[data-pid="${productId}"]`);
      if (transfContainer) {
        const transferencias = d.transferencias || [];
        if (transferencias.length === 0) {
          transfContainer.innerHTML = `<div style="color:#8e8e93;font-size:11px;text-align:center;padding:6px;">Nenhuma transferência interna pra esse produto</div>`;
        } else {
          let th = `<div style="font-size:10px;color:#cc6a00;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">${transferencias.length} transferência${transferencias.length > 1 ? 's' : ''} · ${transferencias.reduce((s,t)=>s+(t.quantidade||0),0)} un total</div>`;
          th += `<div style="background:white;border-radius:6px;max-height:160px;overflow-y:auto;">`;
          transferencias.slice(0, 20).forEach(t => {
            const data = t.data ? new Date(t.data).toLocaleDateString('pt-BR', { timeZone: 'America/Fortaleza' }) : '?';
            th += `<div style="padding:6px 10px;border-bottom:1px solid #f0f0f5;display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:11px;">`;
            th += `<div style="flex:1;min-width:0;">`;
            th += `<div style="font-weight:600;">${data}</div>`;
            th += `<div style="font-size:10px;color:#8e8e93;">${esc((t.de || '').slice(0,25))} → <span style="color:#cc6a00;font-weight:700;">${esc(t.para || '?')}</span></div>`;
            th += `</div>`;
            th += `<div style="font-weight:800;color:#cc6a00;flex-shrink:0;">${t.quantidade} un</div>`;
            th += `</div>`;
          });
          th += `</div>`;
          transfContainer.innerHTML = th;
        }
      }
    } catch (e) {
      container.innerHTML = `<div style="color:#d70015;font-size:11px;">Erro ao carregar: ${e.message}</div>`;
      container.dataset.loading = '';
      const tc = document.querySelector(`.pcard-transf-content[data-pid="${productId}"]`);
      if (tc) tc.innerHTML = `<div style="color:#d70015;font-size:11px;">Erro ao carregar</div>`;
    }
  };

  // IntersectionObserver: carrega NFe quando card aparece na viewport
  // (sem MutationObserver — caller deve chamar PCard.observeNfeContainers() após inserir cards no DOM)
  if (typeof window !== 'undefined' && 'IntersectionObserver' in window) {
    try {
      PCard._observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const pid = e.target.dataset.pid;
            if (pid) PCard.loadNfeSummary(pid);
            try { PCard._observer.unobserve(e.target); } catch {}
          }
        }
      }, { rootMargin: '200px' });
    } catch (err) { console.warn('[PCard] IntersectionObserver init falhou:', err); }
  }

  PCard.observeNfeContainers = function (root) {
    if (!PCard._observer) return;
    const scope = root || document;
    try {
      scope.querySelectorAll('.pcard-nfe-content[data-pid]:not([data-loaded="1"]):not([data-loading="1"])').forEach(el => {
        try { PCard._observer.observe(el); } catch {}
      });
    } catch {}
  };

  // Observer separado pra variantes de cor (load lazy)
  if (typeof window !== 'undefined' && 'IntersectionObserver' in window) {
    try {
      PCard._colorVarObserver = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const pid = e.target.dataset.pid;
            if (pid) PCard.loadColorVariants(pid);
            try { PCard._colorVarObserver.unobserve(e.target); } catch {}
          }
        }
      }, { rootMargin: '200px' });
    } catch {}
  }
  PCard.observeColorVariants = function (root) {
    if (!PCard._colorVarObserver) return;
    const scope = root || document;
    try {
      scope.querySelectorAll('.pcard-colorvar-slot[data-pid]:not([data-loaded="1"]):not([data-loading="1"])').forEach(el => {
        try { PCard._colorVarObserver.observe(el); } catch {}
      });
    } catch {}
  };

  // Auto-observe debounced: cada vez que render() é chamado, agenda 1 varredura
  // 250ms depois. Múltiplos render() em sequência (renderGrid) só geram 1 scan.
  PCard._scheduleObserve = function () {
    if (PCard._scanTimer) clearTimeout(PCard._scanTimer);
    PCard._scanTimer = setTimeout(() => {
      PCard._scanTimer = null;
      PCard.observeNfeContainers();
      PCard.observeColorVariants();
    }, 250);
  };

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

    // Badge BIPADO — preenchido dinamicamente via PCard._bipedSet (carregado 1x)
    // Slot vazio enquanto o Set não chega; loadBipedIndex re-renderiza ao carregar.
    const isBipedNow = PCard.isBiped(p.id);
    const bipedSlotHtml = `<span class="pcard-biped-slot" data-pid="${p.id}">${isBipedNow ? PCard._bipedBadgeHtml() : ''}</span>`;

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
    const hasPhotos = photos.length > 0;
    if (!hasPhotos) photos = [''];
    const carouselId = 'pcrsl-' + p.id;

    let html = '';
    const cardStyle = `background:white;border:1px solid var(--border, #e5e5ea);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:all 0.15s;${onClick ? 'cursor:pointer;' : ''}`;
    const clickAttr = onClick ? ` onclick="${onClick}"` : '';
    html += `<div style="${cardStyle}"${clickAttr} onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 12px 28px rgba(0,0,0,0.08)'" onmouseout="this.style.transform='';this.style.boxShadow=''">`;

    // Placeholder visual SEMPRE atrás do carrossel — aparece quando não há foto OU img falha
    const placeholderSvg = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:linear-gradient(135deg,#f5f5f7,#ebebeb);color:#8e8e93;pointer-events:none;"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span style="font-size:10px;font-weight:600;letter-spacing:1px;text-transform:uppercase;">Sem foto</span></div>`;

    // CARROSSEL
    html += `<div id="${carouselId}" style="position:relative;width:100%;aspect-ratio:4/5;background:#f5f5f7;">`;
    // Placeholder sempre presente no fundo. Se TODAS as imgs falharem, ele aparece naturalmente.
    html += placeholderSvg;
    if (hasPhotos) {
      photos.forEach((url, idx) => {
        // loading="lazy" omitido propositalmente: com 500+ produtos × 5 imgs,
        // IntersectionObserver do Chrome trava (não dispara load mesmo dentro
        // da viewport). Imgs idx>0 ficam display:none e só geram request quando
        // o usuário navega o carrossel.
        const lazyAttr = idx === 0 ? '' : ' loading="lazy"';
        html += `<img class="crsl-img" src="${esc(url)}" referrerpolicy="no-referrer-when-downgrade"${lazyAttr} style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:6px;background:#f5f5f7;display:${idx === 0 ? 'block' : 'none'};z-index:1;" onerror="PCard.imgFail(this)">`;
      });
    }
    if (photos.length > 1) {
      html += `<button type="button" class="crsl-ctrl" onclick="event.stopPropagation();PCard.crslNav('${carouselId}',-1)" style="position:absolute;left:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:2;">‹</button>`;
      html += `<button type="button" class="crsl-ctrl" onclick="event.stopPropagation();PCard.crslNav('${carouselId}',1)" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:16px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.15);z-index:2;">›</button>`;
      html += `<div class="crsl-badge" style="position:absolute;bottom:6px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.6);color:white;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;z-index:2;"><span class="crsl-counter">1</span> / <span class="crsl-total">${photos.length}</span></div>`;
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

    // Linha de badges (BIPADO + outros indicadores universais — visível em TODO card)
    html += `<div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;min-height:18px;">${bipedSlotHtml}</div>`;

    // Nome
    html += `<div style="font-size:14px;font-weight:700;line-height:1.3;color:#1d1d1f;">${esc(p.name || '?')}</div>`;

    // Identificação do card: REFERÊNCIA + COR (não é SKU — SKU é por tamanho)
    // Campo Product.sku = referência do modelo. Campo aiContext.color = cor do modelo.
    const colorTag = (ctx.color || '').trim();
    html += `<div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:var(--text2, #8e8e93);font-family:monospace;flex-wrap:wrap;">`;
    if (p.sku) html += `<span title="Referência do modelo (1 ref por modelo+cor)" style="background:#f5f5f7;color:#1d1d1f;padding:1px 6px;border-radius:4px;font-weight:700;">REF: ${esc(p.sku)}</span>`;
    if (ref && ref !== p.sku) html += `<span title="Referência do fornecedor" style="background:#FCDAC4;color:#E5571E;padding:1px 6px;border-radius:4px;font-weight:700;">FORN: ${esc(ref)}</span>`;
    if (colorTag) html += `<span title="Cor do modelo" style="background:#fff;color:#1d1d1f;padding:1px 6px;border-radius:4px;font-weight:700;border:1px solid #e5e5ea;">🎨 ${esc(colorTag)}</span>`;
    html += '</div>';

    // SLOT de variantes de cor — carregado lazy via PCard.loadColorVariants
    // Só faz sentido se o produto tem modelGroup definido (Converse + outras marcas com padrão identificado)
    if (ctx.modelGroup) {
      html += `<div class="pcard-colorvar-slot" data-pid="${p.id}" data-modelgroup="${esc(ctx.modelGroup)}"></div>`;
    }

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
    // 2ª classificação (opcional) — etiqueta roxa com a cadeia completa
    const cls2 = ctx.classification2 || null;
    if (cls2) {
      const parts2 = [cls2.category || cls2.type, cls2.subcategory || cls2.gender, cls2.modality, cls2.tier].filter(Boolean);
      if (parts2.length) metaPills += `<span title="2ª classificação" style="font-size:10px;padding:2px 7px;background:#ede7f6;color:#5e35b1;border-radius:6px;font-weight:700;">2ª: ${esc(parts2.join(' › '))}</span>`;
    }
    if (metaPills) html += `<div style="display:flex;flex-wrap:wrap;gap:4px;">${metaPills}</div>`;

    // TAMANHOS POR LOJA (estoque físico do último bipe — info mais importante, sobe pro topo)
    if (showStock) {
      // ESTOQUE COMPRADO (total) — visível em TODO card não-admin (loja: Preços/Vender/Curadoria/Estoque).
      // p.stockTotal = Σ ProductSize.stock = comprado (NFe entrada). Custo NUNCA aparece aqui.
      // No admin o comprado já aparece no bloco azul de NFe, então não duplica.
      if (actions !== 'admin') {
        const compradoTotal = p.stockTotal != null ? p.stockTotal : (p.sizes || []).reduce((a, s) => a + (s.stock || 0), 0);
        const compColor = compradoTotal > 0 ? '#0066cc' : '#8e8e93';
        html += `<div style="margin-top:8px;padding:9px 12px;background:#eef6ff;border:1.5px solid #cfe0ff;border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;"><span style="font-size:11px;color:#0066cc;text-transform:uppercase;letter-spacing:0.5px;font-weight:800;">📦 Estoque comprado</span><span style="font-size:16px;font-weight:800;color:${compColor};">${compradoTotal} un</span></div>`;
      }
      const storesArr = Object.keys(byStore).sort();
      if (storesArr.length) {
        const totalUn = storesArr.reduce((s, c) => s + byStore[c].items.length, 0);
        html += `<div style="margin-top:8px;padding:12px;background:linear-gradient(135deg,#fff,#FFEBDC);border-radius:10px;border:2px solid #FCDAC4;">`;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">`;
        html += `<div style="font-size:11px;color:#E5571E;text-transform:uppercase;letter-spacing:1px;font-weight:800;">🏪 Estoque físico por loja (último bipe)</div>`;
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

    // BLOCO NFe (COMPRADO/VENDIDO/ESTOQUE/PERDA + transferências) — lazy-load no viewport.
    // Aparece em telas de ADMIN (actions:'admin') OU quando opts.showNfe === true
    // (telas internas que usam estilo 'public' mas precisam ver o comprado: classificação, imagens).
    // NUNCA aparece pro cliente (loja.html usa actions:'public' SEM showNfe).
    // opts.hideNfeAndTransfers = true força esconder.
    if ((actions === 'admin' || opts.showNfe) && !opts.hideNfeAndTransfers) {
      // AZUL: Entradas via NFe (compra de fornecedor) — conta como estoque novo
      html += `<div style="margin-top:8px;padding:10px 12px;background:#f0f6ff;border:1.5px solid #cfe0ff;border-radius:10px;">`;
      html += `<div style="font-size:11px;color:#0066cc;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin-bottom:6px;">📦 Entradas via NFe <span style="color:#8e8e93;font-weight:600;text-transform:none;letter-spacing:0;">— compra de fornecedor</span></div>`;
      html += `<div class="pcard-nfe-content" data-pid="${p.id}" style="font-size:12px;color:#1d1d1f;"><div style="color:#8e8e93;font-size:11px;">⏳ Carregando...</div></div>`;
      html += `</div>`;

      // LARANJA: Transferências internas (NÃO conta como estoque novo — só move entre lojas)
      html += `<div style="margin-top:6px;padding:10px 12px;background:#fff6ef;border:1.5px solid #ffd6a8;border-radius:10px;">`;
      html += `<div style="font-size:11px;color:#cc6a00;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin-bottom:6px;">🔄 Transferências internas <span style="color:#8e8e93;font-weight:600;text-transform:none;letter-spacing:0;">— não gera estoque novo</span></div>`;
      html += `<div class="pcard-transf-content" data-pid="${p.id}" style="font-size:12px;color:#1d1d1f;"><div style="color:#8e8e93;font-size:11px;">⏳ Carregando...</div></div>`;
      html += `</div>`;
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
    // Agenda varredura pra ativar IntersectionObserver nos novos containers NFe
    if ((actions === 'admin' || opts.showNfe) && PCard._scheduleObserve) PCard._scheduleObserve();
    return html;
  };

  PCard.renderGrid = function (products, opts) {
    opts = opts || {};
    const minWidth = opts.minWidth || '360px';
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
