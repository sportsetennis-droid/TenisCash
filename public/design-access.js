/* Product-only workspace in the existing admin shell. Server policy is authoritative. */
(function (root) {
  'use strict';
  const PRODUCT_ROLES = ['design', 'design_view'];
  const ADMIN_ROLES = ['admin', 'superadmin', 'manager'];
  const MODULES = [
    ['home', 'Início'], ['catalog', 'Catálogo'], ['categories', 'Categorias'],
    ['productImages', 'Imagens e vídeos'], ['images', 'Buscar imagens'],
    ['classification', 'Classificação'], ['vitrine', 'Vitrine'],
    ['labels', 'Etiquetas'], ['stock', 'Estoque · consulta'],
  ];
  let verifiedRole = null;
  let workspace = null;
  const restricted = role => PRODUCT_ROLES.includes(role);
  const canEdit = role => role === 'design';
  const accepts = role => restricted(role) || ADMIN_ROLES.includes(role);
  const readMethod = method => ['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
  function normalizedPath(input) {
    try { return new URL(String(input), 'https://teniscash.invalid').pathname.replace(/^\/api(?=\/)/, '').replace(/\/$/, '') || '/'; }
    catch (_) { return ''; }
  }
  function allowRequest(role, input, method) {
    const p = normalizedPath(input);
    const m = String(method || 'GET').toUpperCase();
    if (/^\/(auth|webauthn)\//.test(p)) return true;
    if (ADMIN_ROLES.includes(role)) return true;
    if (!restricted(role) || (!readMethod(m) && !canEdit(role))) return false;
    if (role === 'design_view' && /\/labels\/batches\/[^/]+\/pdf$/.test(p)) return false;
    if (readMethod(m)) return [
      /^\/admin\/catalog\/form-options$/,
      /^\/admin\/catalog\/products(?:\/[^/]+(?:\/color-variants)?)?$/,
      /^\/admin\/inventory\/products$/,
      /^\/admin\/categories\/(?:tree|[^/]+\/products)$/,
      /^\/admin\/classification\/(?:tree|products|brands|stats)$/,
      /^\/admin\/product-images\/(?:status|pending|pipeline-status|search\/[^/]+)$/,
      /^\/admin\/vitrine\/(?:slots|candidates)$/,
      /^\/admin\/labels\/(?:templates|options|batches(?:\/[^/]+(?:\/pdf)?)?)$/,
      /^\/stocktake\/(?:biped-product-ids|located-product-ids)$/,
    ].some(pattern => pattern.test(p));
    if (m === 'POST' && p === '/admin/catalog/products') return true;
    if (m === 'PUT' && /^\/admin\/catalog\/products\/[^/]+$/.test(p)) return true;
    if (['POST', 'PUT', 'DELETE'].includes(m) && /^\/admin\/categories(?:\/[^/]+(?:\/assign-products)?)?$/.test(p)) return true;
    if (m === 'PATCH' && /^\/admin\/classification\/[^/]+$/.test(p)) return true;
    if (m === 'POST' && /^\/admin\/product-images\/(?:upload|video|standardize|select)\/[^/]+$/.test(p)) return true;
    if (m === 'DELETE' && /^\/admin\/product-images\/(?:video|select)\/[^/]+$/.test(p)) return true;
    if (m === 'PUT' && p === '/admin/vitrine/slots') return true;
    return m === 'POST' && p === '/admin/labels/batches/quick';
  }
  function setRole(role) { verifiedRole = accepts(role) ? role : null; return verifiedRole; }
  function installFetchGuard() {
    if (!root.fetch || root.__designFetchGuard) return;
    root.__designFetchGuard = true;
    const original = root.fetch.bind(root);
    root.fetch = function (input, options) {
      const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const url = new URL(raw, root.location.href);
      const method = options && options.method || input && input.method || 'GET';
      if (url.origin === root.location.origin && url.pathname.startsWith('/api/') && !allowRequest(verifiedRole, url.pathname, method)) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Área indisponível para este acesso.' }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
      }
      return original(input, options);
    };
  }
  const parseContext = p => {
    try { const v = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : p.aiContext; return v && typeof v === 'object' ? v : {}; }
    catch (_) { return {}; }
  };
  // Construct a field allowlist; never spread the product or round-trip hidden financial/stock fields.
  function productPayload(values) {
    const out = {};
    for (const key of ['sku', 'name', 'brand', 'category', 'subcategory', 'shortDescription', 'longDescription']) out[key] = String(values[key] || '').trim();
    const price = Number(values.price);
    if (!Number.isFinite(price) || price < 0) throw new Error('Informe um preço de venda válido.');
    out.price = price;
    out.aiContext = { color: String(values.color || '').trim(), classification: {} };
    for (const key of ['gender', 'type', 'modality', 'tier']) out.aiContext.classification[key] = String(values[key] || '').trim();
    for (const key of ['recommendedFor', 'notRecommendedFor']) out[key] = String(values[key] || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (values.features) {
      try { out.features = JSON.parse(values.features); } catch (_) { throw new Error('Características técnicas: informe um objeto JSON válido.'); }
      if (!out.features || Array.isArray(out.features) || typeof out.features !== 'object') throw new Error('Características técnicas: informe um objeto JSON.');
    }
    return out;
  }
  function safeImage(url) { return /^(https?:\/\/|data:image\/(png|jpeg|webp|gif);base64,|\/[^/])/i.test(String(url || '')) ? String(url) : ''; }
  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function button(text, action, mutate, state) {
    const b = el('button', text, 'da-button'); b.type = 'button';
    if (mutate) { b.dataset.designMutation = 'true'; if (!canEdit((state || workspace).user.role)) { b.hidden = true; b.disabled = true; } }
    b.addEventListener('click', async () => {
      if (mutate && !canEdit((state || workspace).user.role)) return;
      b.disabled = true;
      try { await action(); } catch (error) {
        const dialog = b.closest && b.closest('dialog');
        if (dialog) { let local = dialog.querySelector('[data-dialog-error]'); if (!local) { local = el('p', '', 'da-error'); local.dataset.dialogError = 'true'; local.setAttribute('role', 'alert'); dialog.append(local); } local.textContent = error.message; }
        else notice(error.message, true);
      }
      finally { b.disabled = false; }
    });
    return b;
  }
  function field(container, name, label, value, type) {
    const wrap = el('label', null, 'da-field'); wrap.append(el('span', label));
    const input = el(type === 'textarea' ? 'textarea' : 'input');
    input.name = name; input.value = value == null ? '' : String(value);
    if (type && type !== 'textarea') input.type = type;
    if (type === 'number') { input.min = '0'; input.step = '0.01'; }
    wrap.append(input); container.append(wrap); return input;
  }
  function select(container, label, choices, value) {
    const wrap = el('label', null, 'da-field'); wrap.append(el('span', label));
    const node = el('select');
    for (const choice of choices) { const option = el('option', choice.label); option.value = choice.value; node.append(option); }
    node.value = value || ''; wrap.append(node); container.append(wrap); return node;
  }
  function notice(message, error) {
    const target = workspace && workspace.message;
    if (target) { target.textContent = message; target.className = error ? 'da-message da-error' : 'da-message'; }
  }
  async function request(path, method, body) {
    const s = workspace;
    if (!allowRequest(s.user.role, path, method)) throw new Error('Ação indisponível para este acesso.');
    const result = await s.api(path, method || 'GET', body);
    if (!result || result.error) throw new Error(result && result.error || 'Resposta indisponível.');
    return result;
  }
  async function binary(path) {
    if (!allowRequest(workspace.user.role, path, 'GET')) return;
    const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + workspace.token() } });
    if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(data.error || 'Não foi possível abrir o PDF.'); }
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', 'Baixar PDF das etiquetas', 'da-button'); a.href = url; a.download = 'etiquetas.pdf';
    workspace.content.prepend(a); a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function installStyle() {
    if (document.getElementById('design-access-style')) return;
    const style = el('style'); style.id = 'design-access-style';
    style.textContent = '.da[hidden],.da [hidden],#design-owner-access[hidden]{display:none!important}.da{max-width:1320px;margin:auto;color:#252525;font:15px system-ui,sans-serif}.da-head,.da-toolbar,.da-nav,.da-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.da-head{justify-content:space-between;margin:12px 0 22px}.da h1{font-size:26px;margin:0}.da h2{font-size:21px;margin:0 0 16px}.da p{line-height:1.5}.da-nav{margin:18px 0}.da-button,.da select,.da input,.da textarea{font:inherit;border:1px solid #d8d8dd;border-radius:9px;padding:10px;background:#fff;color:#252525;max-width:100%}.da-button{cursor:pointer;text-decoration:none}.da-button:hover,.da-button[aria-current=page]{border-color:#E5571E;background:#fff3ee}.da-button:disabled{opacity:.5;cursor:default}.da-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.da-card{border:1px solid #e5e5ea;border-radius:14px;padding:16px;background:#fff;overflow:hidden}.da-card img{width:100%;height:210px;object-fit:contain;background:#fafafa;margin-bottom:12px}.da-card h3{font-size:16px;margin:8px 0}.da-muted{font-size:13px;color:#666}.da-field{display:flex;flex-direction:column;gap:6px;margin:10px 0;min-width:0}.da-field>span{font-size:13px;font-weight:600}.da-field input,.da-field textarea,.da-field select{width:100%}.da-field textarea{min-height:100px}.da-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.da-message{min-height:26px;margin:12px 0;color:#16633a}.da-error{color:#a32222}.da-content{padding-bottom:40px}.da-count{background:#fff3ee;border-radius:10px;padding:16px}.da-count strong{display:block;font-size:28px}.da-tree{list-style:none;padding-left:20px}.da-tree>li{margin:10px 0}.da table{width:100%;border-collapse:collapse;font-size:13px}.da td,.da th{padding:8px;text-align:left;border-bottom:1px solid #eee}.da-scroll{overflow:auto}.da-dialog{max-width:820px;width:calc(100% - 28px);max-height:90vh;overflow:auto;border:1px solid #ddd;border-radius:14px;padding:22px}.da-dialog::backdrop{background:#0007}.da-dialog form{margin-top:16px}.da-dialog .da-actions{margin-top:16px}.da-toolbar{margin-bottom:18px}.da-toolbar input{min-width:210px;flex:1}.da-card .da-actions{margin-top:12px}.da label:has(input[type=checkbox]){display:flex;gap:8px;align-items:center}.da-meta{white-space:pre-wrap;line-height:1.55}.da label input[type=checkbox]{width:auto}#design-owner-access{margin-top:18px;padding:18px;border:1px solid #e5e5ea;border-radius:14px;background:white}@media(max-width:640px){.da-form-grid{grid-template-columns:1fr}.da h1{font-size:22px}.da-nav .da-button{flex:1}.da-dialog{padding:14px}}';
    document.head.append(style);
  }
  function modal(title) {
    const d = el('dialog', null, 'da da-dialog'); d.append(el('h2', title));
    d.append(button('Fechar', () => d.close()));
    d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
  }
  function photo(p) { const image = el('img'); image.alt = p.name || 'Produto'; image.loading = 'lazy'; image.src = safeImage(p.imageUrl); image.addEventListener('error', () => image.remove(), { once: true }); return image; }
  function table(headers, rows) {
    const wrap = el('div', null, 'da-scroll'), t = el('table'), head = el('tr');
    headers.forEach(x => head.append(el('th', x))); t.append(head);
    rows.forEach(row => { const tr = el('tr'); row.forEach(x => tr.append(el('td', x == null ? '—' : x))); t.append(tr); });
    wrap.append(t); return wrap;
  }
  function stockRows(p) {
    return (p.sizes || []).flatMap(s => (s.storeStocks || []).length
      ? s.storeStocks.map(ss => [s.size, s.barcode || '—', ss.store && (ss.store.code + ' · ' + ss.store.name) || ss.storeId, ss.stock])
      : [[s.size, s.barcode || '—', 'Cadastro do produto', s.stock]]);
  }
  async function home(target) {
    const data = await request('/admin/classification/stats');
    const stats = el('div', null, 'da-grid');
    for (const [label, value] of [['Produtos ativos', data.total], ['Classificados', data.classified], ['Classificação pendente', data.pending]]) {
      const c = el('div', null, 'da-count'); c.append(el('strong', value == null ? '—' : value), el('span', label)); stats.append(c);
    }
    target.append(stats, el('p', canEdit(workspace.user.role) ? 'Edite o catálogo, organize categorias e prepare imagens, vitrines e etiquetas.' : 'Consulte o catálogo, categorias, imagens, vitrines, etiquetas e estoque. Acesso somente para consulta.'));
    const grid = el('div', null, 'da-grid');
    MODULES.filter(m => m[0] !== 'home').forEach(([id, name]) => { const c = el('div', null, 'da-card'); c.append(button(name, () => navigate(id))); grid.append(c); });
    target.append(grid);
  }
  async function productDetail(id) {
    const { product: p } = await request('/admin/catalog/products/' + encodeURIComponent(id));
    const d = modal(p.name);
    const photos = el('div', null, 'da-grid');
    [...new Set([p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter(Boolean))].forEach(url => photos.append(photo({ name: p.name, imageUrl: url })));
    d.append(photos);
    d.append(el('p', [p.brand, p.sku, p.category, p.subcategory].filter(Boolean).join(' · ')), el('p', p.longDescription || p.shortDescription || 'Sem descrição.', 'da-meta'));
    const cls = parseContext(p).classification || {};
    d.append(el('p', [cls.gender, cls.type, cls.modality, cls.tier].filter(Boolean).join(' · ')));
    if (p.price != null) d.append(el('p', 'Preço de venda: ' + Number(p.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })));
    if (p.features && typeof p.features === 'object') d.append(table(['Característica', 'Informação'], Object.entries(p.features).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])));
    if (Array.isArray(p.recommendedFor) && p.recommendedFor.length) d.append(el('p', 'Indicado para: ' + p.recommendedFor.join(' · ')));
    if (Array.isArray(p.notRecommendedFor) && p.notRecommendedFor.length) d.append(el('p', 'Não indicado para: ' + p.notRecommendedFor.join(' · ')));
    if (p.videoUrl) { const video = el('video'); video.controls = true; video.src = safeImage(p.videoUrl); video.style.maxWidth = '100%'; d.append(video); }
    d.append(table(['Tamanho', 'Código', 'Loja', 'Estoque cadastrado'], stockRows(p)));
    if (canEdit(workspace.user.role)) d.append(button('Editar dados do produto', async () => { d.close(); await editProduct(p); }, true));
  }
  async function editProduct(existing) {
    const p = existing || {}, context = parseContext(p), cls = context.classification || {};
    const d = modal(existing ? 'Editar produto' : 'Criar produto');
    const form = el('form'), grid = el('div', null, 'da-form-grid'), inputs = {};
    for (const [name, label, value, type] of [
      ['sku', 'Referência / SKU', p.sku], ['name', 'Nome', p.name], ['brand', 'Marca', p.brand],
      ['category', 'Categoria', p.category], ['subcategory', 'Subcategoria', p.subcategory], ['color', 'Cor', context.color],
      ['price', 'Preço de venda (R$)', p.price, 'number'], ['gender', 'Público', cls.gender],
      ['type', 'Tipo', cls.type], ['modality', 'Modalidade', cls.modality], ['tier', 'Especialidade', cls.tier],
    ]) inputs[name] = field(grid, name, label, value, type);
    for (const k of ['sku', 'name', 'brand', 'category', 'price']) inputs[k].required = true;
    form.append(grid);
    for (const [name, label, value] of [
      ['shortDescription', 'Descrição curta', p.shortDescription], ['longDescription', 'Descrição completa', p.longDescription],
      ['features', 'Características técnicas (JSON)', p.features ? JSON.stringify(p.features, null, 2) : ''],
      ['recommendedFor', 'Indicado para (uma indicação por linha)', Array.isArray(p.recommendedFor) ? p.recommendedFor.join('\n') : p.recommendedFor || ''],
      ['notRecommendedFor', 'Não indicado para (uma indicação por linha)', Array.isArray(p.notRecommendedFor) ? p.notRecommendedFor.join('\n') : p.notRecommendedFor || ''],
    ]) inputs[name] = field(form, name, label, value, 'textarea');
    const error = el('p', '', 'da-error'); error.setAttribute('role', 'alert'); form.append(error);
    const save = el('button', 'Salvar produto', 'da-button'); save.type = 'submit'; save.dataset.designMutation = 'true'; form.append(save);
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!canEdit(workspace.user.role)) return;
      save.disabled = true;
      try {
        const values = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
        const payload = productPayload(values);
        await request('/admin/catalog/products' + (p.id ? '/' + encodeURIComponent(p.id) : ''), p.id ? 'PUT' : 'POST', payload);
        d.close(); await navigate(workspace.module); notice('Produto salvo.');
      } catch (err) { error.textContent = err.message; } finally { save.disabled = false; }
    });
    d.append(form);
  }
  function productCard(p, module) {
    const c = el('article', null, 'da-card');
    if (p.imageUrl) c.append(photo(p));
    c.append(el('h3', p.name), el('p', [p.brand, p.sku].filter(Boolean).join(' · '), 'da-muted'));
    c.append(el('p', [p.category, p.subcategory].filter(Boolean).join(' / ')));
    if (p.active === false) c.append(el('p', 'Produto inativo', 'da-muted'));
    if (p.price != null) c.append(el('p', Number(p.price).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })));
    const actions = el('div', null, 'da-actions'); actions.append(button('Ver produto', () => productDetail(p.id)));
    if (module === 'stock') c.append(table(['Tam.', 'Código', 'Loja', 'Qtd.'], stockRows(p)));
    else if (module === 'productImages' || module === 'images') actions.append(button(module === 'images' ? 'Pesquisar imagens' : 'Editar mídia', () => mediaEditor(p, module === 'images'), true));
    else actions.append(button('Editar', () => editProduct(p), true));
    c.append(actions); return c;
  }
  async function products(target, module) {
    const toolbar = el('form', null, 'da-toolbar'), search = el('input');
    search.placeholder = 'Buscar nome, referência, marca ou código'; search.setAttribute('aria-label', search.placeholder); search.value = workspace.search || '';
    const go = el('button', 'Buscar', 'da-button'); go.type = 'submit'; toolbar.append(search, go);
    if (module === 'catalog') toolbar.append(button('Criar produto', () => editProduct(null), true));
    toolbar.addEventListener('submit', e => { e.preventDefault(); workspace.search = search.value.trim(); workspace.page = 1; navigate(module); });
    target.append(toolbar);
    const query = new URLSearchParams({ active: 'all', page: String(workspace.page || 1), pageSize: '60' });
    if (workspace.search) query.set('search', workspace.search);
    const data = await request('/admin/catalog/products?' + query);
    if (!target.isConnected) return;
    const rows = data.products || [], grid = el('div', null, 'da-grid');
    rows.forEach(p => grid.append(productCard(p, module)));
    target.append(el('p', `${data.total == null ? rows.length : data.total} produtos · página ${data.page || workspace.page || 1} de ${data.pages || 1}`, 'da-muted'), grid);
    if (!rows.length) target.append(el('p', 'Nenhum produto encontrado.'));
    const pager = el('div', null, 'da-actions');
    const prev = button('Anterior', () => { workspace.page = Math.max(1, (data.page || workspace.page) - 1); return navigate(module); });
    prev.disabled = (data.page || workspace.page || 1) <= 1;
    const next = button('Próxima', () => { workspace.page = (data.page || workspace.page || 1) + 1; return navigate(module); });
    next.disabled = (data.page || workspace.page || 1) >= (data.pages || 1); pager.append(prev, next); target.append(pager);
  }
  async function mediaEditor(p, searchMode) {
    const d = modal(p.name), area = el('div'); d.append(area);
    const data = await request('/admin/catalog/products/' + encodeURIComponent(p.id)); p = data.product;
    const gallery = el('div', null, 'da-grid');
    const urls = [...new Set([p.imageUrl, ...(Array.isArray(p.imageUrls) ? p.imageUrls : [])].filter(Boolean))];
    urls.forEach(url => { const card = el('div', null, 'da-card'); card.append(photo({ name: p.name, imageUrl: url })); gallery.append(card); }); area.append(gallery);
    const imageUrl = field(area, 'imageUrl', 'URL da imagem principal', p.imageUrl, 'url');
    area.append(button('Salvar imagem principal', async () => { await request('/admin/product-images/select/' + encodeURIComponent(p.id), 'POST', { imageUrl: imageUrl.value.trim(), additionalImages: p.imageUrls || [] }); notice('Imagem salva.'); d.close(); await navigate(workspace.module); }, true));
    const files = field(area, 'files', 'Enviar até 10 imagens (15 MB por arquivo)', '', 'file'); files.accept = 'image/*'; files.multiple = true;
    area.append(button('Enviar e padronizar imagens', async () => { if (!files.files.length) throw new Error('Selecione as imagens.'); const body = new FormData(); Array.from(files.files).forEach(f => body.append('files', f)); await upload('/admin/product-images/upload/' + encodeURIComponent(p.id), body); d.close(); await navigate(workspace.module); notice('Imagens enviadas.'); }, true));
    const video = field(area, 'video', 'Vídeo MP4 (até 80 MB)', '', 'file'); video.accept = 'video/mp4';
    area.append(button('Enviar vídeo', async () => { if (!video.files[0]) throw new Error('Selecione o vídeo.'); const body = new FormData(); body.append('video', video.files[0]); await upload('/admin/product-images/video/' + encodeURIComponent(p.id), body); notice('Vídeo enviado.'); d.close(); }, true));
    if (p.videoUrl) {
      const v = el('video'); v.controls = true; v.src = safeImage(p.videoUrl); v.style.maxWidth = '100%'; area.append(v);
      area.append(button('Remover vídeo', async () => { if (!confirm('Remover o vídeo deste produto?')) return; await request('/admin/product-images/video/' + encodeURIComponent(p.id), 'DELETE'); d.close(); notice('Vídeo removido.'); }, true));
    }
    const q = field(area, 'query', 'Pesquisar imagens por marca e referência', [p.brand, p.sku, p.name].filter(Boolean).join(' '));
    const results = el('div', null, 'da-grid');
    const find = async () => {
      results.replaceChildren(el('p', 'Buscando imagens…'));
      const found = await request('/admin/product-images/search/' + encodeURIComponent(p.id) + '?q=' + encodeURIComponent(q.value));
      results.replaceChildren();
      for (const item of found.items || []) {
        const url = item.imageUrl || item.url || item.link || item.original;
        if (!safeImage(url)) continue;
        const c = el('div', null, 'da-card'); c.append(photo({ name: item.title || p.name, imageUrl: url }), el('p', item.title || item.source || 'Imagem encontrada', 'da-muted'));
        c.append(button('Usar esta imagem', async () => { await request('/admin/product-images/select/' + encodeURIComponent(p.id), 'POST', { imageUrl: url }); d.close(); await navigate(workspace.module); notice('Imagem selecionada.'); }, true)); results.append(c);
      }
      if (!results.children.length) results.append(el('p', 'Nenhuma imagem encontrada.'));
    };
    area.append(button('Pesquisar', find), results);
    if (searchMode) await find();
  }
  async function upload(path, body) {
    if (!allowRequest(workspace.user.role, path, 'POST')) throw new Error('Acesso somente para consulta.');
    const result = await fetch('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + workspace.token() }, body });
    const data = await result.json(); if (!result.ok || data.error) throw new Error(data.error || 'Falha no envio.'); return data;
  }
  async function categories(target) {
    const data = await request('/admin/categories/tree');
    const create = async parent => {
      const name = prompt(parent ? 'Nome da nova classificação:' : 'Nome da categoria:'); if (!name || !name.trim()) return;
      const levels = ['CATEGORY', 'SUBCATEGORY', 'MODALITY', 'SPECIALTY'];
      await request('/admin/categories', 'POST', { name: name.trim(), level: parent ? levels[levels.indexOf(parent.level) + 1] : 'CATEGORY', parentId: parent ? parent.id : null }); await navigate('categories');
    };
    target.append(button('Criar categoria', () => create(null), true));
    const tree = nodes => {
      const ul = el('ul', null, 'da-tree');
      for (const node of nodes) {
        const li = el('li'), row = el('div', null, 'da-actions'); row.append(el('strong', node.name));
        row.append(button('Produtos', () => categoryProducts(node)));
        row.append(button('Renomear', async () => { const name = prompt('Novo nome:', node.name); if (name && name.trim()) { await request('/admin/categories/' + encodeURIComponent(node.id), 'PUT', { name: name.trim() }); await navigate('categories'); } }, true));
        if (node.level !== 'SPECIALTY') row.append(button('Adicionar abaixo', () => create(node), true));
        row.append(button('Excluir', async () => { if (!confirm('Excluir a categoria “' + node.name + '” e seus níveis inferiores?')) return; await request('/admin/categories/' + encodeURIComponent(node.id), 'DELETE'); await navigate('categories'); }, true));
        li.append(row); if (node.children && node.children.length) li.append(tree(node.children)); ul.append(li);
      }
      return ul;
    };
    target.append(tree(data.tree || []));
  }
  async function categoryProducts(node) {
    const d = modal('Produtos · ' + node.name), current = await request('/admin/categories/' + encodeURIComponent(node.id) + '/products');
    const list = el('div', null, 'da-grid'); (current.products || []).forEach(p => list.append(productCard(p, 'catalog'))); d.append(list);
    if (!canEdit(workspace.user.role)) return;
    const form = el('form', null, 'da-toolbar'), q = field(form, 'search', 'Buscar produtos para classificar', ''), go = el('button', 'Buscar', 'da-button'); go.type = 'submit'; form.append(go); d.append(form);
    const results = el('div'), selected = new Set(); d.append(results);
    form.addEventListener('submit', async e => {
      e.preventDefault(); if (!q.value.trim()) return;
      try {
        const found = await request('/admin/catalog/products?active=all&page=1&pageSize=60&search=' + encodeURIComponent(q.value)); results.replaceChildren(); selected.clear();
        for (const p of found.products || []) { const label = el('label'), cb = el('input'); cb.type = 'checkbox'; cb.addEventListener('change', () => cb.checked ? selected.add(p.id) : selected.delete(p.id)); label.append(cb, el('span', [p.name, p.sku, p.brand].filter(Boolean).join(' · '))); results.append(label); }
        results.append(button('Aplicar categoria aos selecionados', async () => { if (!selected.size) throw new Error('Selecione os produtos.'); await request('/admin/categories/' + encodeURIComponent(node.id) + '/assign-products', 'POST', { productIds: Array.from(selected), slot: 1 }); d.close(); notice('Categoria aplicada.'); }, true));
      } catch (err) { results.textContent = err.message; }
    });
  }
  async function classification(target) {
    const stats = await request('/admin/classification/stats');
    target.append(el('p', `${stats.classified || 0} classificados · ${stats.pending || 0} pendentes · ${stats.lowConfidenceCount || 0} para revisão.`));
    target.append(button('Organizar categorias', () => navigate('categories')));
    target.append(el('p', 'A classificação de cada produto pode ser editada em seus dados de público, tipo, modalidade e especialidade.'));
    await products(target, 'classification');
  }
  async function vitrine(target) {
    const data = await request('/admin/vitrine/slots'), selection = JSON.parse(JSON.stringify(data.selection && (data.selection.selection || data.selection) || {}));
    const grid = el('div', null, 'da-grid'); target.append(grid);
    for (const gender of data.genders || []) for (const slot of data.slots || []) {
      const value = selection[gender] && selection[gender][slot.id] || {}, c = el('div', null, 'da-card');
      c.append(el('h3', gender + ' · ' + slot.label), el('p', slot.ratio + ' · ' + slot.dims, 'da-muted'));
      const current = el('p', value.productId ? 'Carregando produto…' : 'Sem produto'); c.append(current);
      if (value.productId) request('/admin/catalog/products/' + encodeURIComponent(value.productId)).then(d => { current.textContent = d.product.name; if (d.product.imageUrl) c.prepend(photo(d.product)); }).catch(e => { current.textContent = e.message; });
      const phrase = field(c, 'phrase', 'Frase', value.phrase || ''); phrase.disabled = !canEdit(workspace.user.role);
      phrase.addEventListener('input', () => { selection[gender] = selection[gender] || {}; selection[gender][slot.id] = { ...(selection[gender][slot.id] || {}), phrase: phrase.value }; });
      c.append(button('Escolher produto', async () => {
        const d = modal('Escolher · ' + gender + ' · ' + slot.label), q = field(d, 'q', 'Nome ou referência', ''), results = el('div', null, 'da-grid');
        d.append(button('Buscar', async () => {
          const found = await request('/admin/vitrine/candidates?limit=60&q=' + encodeURIComponent(q.value)); results.replaceChildren();
          for (const p of found.products || []) { const item = el('div', null, 'da-card'); if (p.imageUrl) item.append(photo(p)); item.append(el('p', p.name), el('p', p.sku, 'da-muted')); item.append(button('Selecionar', () => { selection[gender] = selection[gender] || {}; selection[gender][slot.id] = { productId: p.id, phrase: phrase.value, name: p.name, ref: p.sku, brand: p.brand, thumb: p.imageUrl, sizes: p.sizes || [], totalStock: p.totalStock || 0 }; current.textContent = p.name; d.close(); }, true)); results.append(item); }
        }), results);
      }, true)); grid.append(c);
    }
    target.append(button('Salvar vitrine', async () => { await request('/admin/vitrine/slots', 'PUT', { selection }); notice('Vitrine salva.'); }, true));
  }
  async function labels(target) {
    const data = await request('/admin/labels/batches');
    if (canEdit(workspace.user.role)) {
      const templates = await request('/admin/labels/templates'), box = el('div', null, 'da-card'); box.append(el('h3', 'Preparar lote de etiquetas'));
      const template = select(box, 'Modelo', (templates.templates || []).map(t => ({ label: t.name, value: t.id })), templates.templates && templates.templates[0] && templates.templates[0].id);
      const name = field(box, 'name', 'Nome do lote', ''), q = field(box, 'q', 'Buscar produtos', ''), results = el('div'), chosen = new Map(), selected = el('p', 'Nenhum produto selecionado.');
      box.append(button('Buscar', async () => { const found = await request('/admin/catalog/products?active=all&page=1&pageSize=60&search=' + encodeURIComponent(q.value)); results.replaceChildren(); for (const p of found.products || []) { const row = el('div', null, 'da-actions'), qty = el('input'); qty.type = 'number'; qty.min = '0'; qty.max = '1000'; qty.value = String(chosen.get(p.id) || 0); qty.setAttribute('aria-label', 'Quantidade de etiquetas: ' + p.name); qty.style.width = '85px'; qty.addEventListener('change', () => { const n = Math.max(0, Math.min(1000, Math.trunc(Number(qty.value) || 0))); if (n) chosen.set(p.id, n); else chosen.delete(p.id); selected.textContent = chosen.size + ' produtos selecionados.'; }); row.append(el('span', p.name + ' · ' + p.sku), qty); results.append(row); } }), results, selected);
      box.append(button('Gerar lote', async () => { if (!chosen.size) throw new Error('Selecione produtos e quantidades.'); await request('/admin/labels/batches/quick', 'POST', { templateId: template.value, name: name.value, usePromo: false, selections: Array.from(chosen, ([productId, quantity]) => ({ productId, quantity })) }); await navigate('labels'); notice('Lote criado. Abra o PDF para conferir.'); }, true)); target.append(box);
    }
    const list = el('div', null, 'da-grid');
    for (const b of data.batches || []) {
      const c = el('div', null, 'da-card');
      c.append(el('h3', b.name || 'Lote'), el('p', `${b.totalLabels || 0} etiquetas · ${b.template && b.template.name || ''}`));
      c.append(button('Ver itens', async () => {
        const detail = await request('/admin/labels/batches/' + encodeURIComponent(b.id)), d = modal(b.name || 'Lote de etiquetas');
        const items = detail.batch && detail.batch.items || [];
        d.append(table(['Produto / referência', 'Quantidade', 'Preço', 'Texto'], items.map(item => [item.description || item.barcode || item.productId, item.quantity, item.price, item.customText])));
      }));
      if (canEdit(workspace.user.role)) c.append(button('Gerar PDF', () => binary('/admin/labels/batches/' + encodeURIComponent(b.id) + '/pdf'), true));
      list.append(c);
    }
    target.append(list);
  }
  async function navigate(module) {
    if (!workspace || !MODULES.some(m => m[0] === module)) return false;
    const s = workspace; s.module = module;
    s.nav.querySelectorAll('button').forEach(b => { if (b.dataset.module === module) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    s.content.replaceChildren(); s.message.textContent = '';
    const title = MODULES.find(m => m[0] === module)[1], target = el('div'); s.content.append(el('h2', title), target);
    const loading = el('p', 'Carregando…'); target.append(loading);
    try {
      if (module === 'home') await home(target);
      else if (module === 'categories') await categories(target);
      else if (module === 'classification') await classification(target);
      else if (module === 'vitrine') await vitrine(target);
      else if (module === 'labels') await labels(target);
      else await products(target, module);
    } catch (err) { target.append(el('p', err.message, 'da-error')); }
    finally { loading.remove(); }
    return true;
  }
  async function mount(options) {
    installStyle(); setRole(options.user.role);
    if (!restricted(verifiedRole)) return false;
    const dashboard = document.getElementById('dashboard');
    Array.from(dashboard.children).forEach(n => { if (n.id !== 'design-workspace') { if (!Object.hasOwn(n.dataset, 'designDisplay')) n.dataset.designDisplay = n.style.display; n.style.display = 'none'; } });
    let host = document.getElementById('design-workspace'); if (!host) { host = el('section', null, 'da'); host.id = 'design-workspace'; dashboard.append(host); }
    host.hidden = false; host.replaceChildren();
    const head = el('header', null, 'da-head'), intro = el('div'); intro.append(el('h1', 'Design · Produtos'), el('p', options.user.name + ' · ' + (canEdit(verifiedRole) ? 'Edição de produtos' : 'Somente consulta'), 'da-muted'));
    head.append(intro, button('Sair', options.logout, false, options)); host.append(head);
    const nav = el('nav', null, 'da-nav'); nav.setAttribute('aria-label', 'Áreas de produtos'); host.append(nav);
    const message = el('div', '', 'da-message'); message.setAttribute('role', 'status'); host.append(message);
    const content = el('main', null, 'da-content'); host.append(content);
    workspace = { ...options, host, nav, message, content, module: 'home', page: 1, search: '' };
    MODULES.forEach(([id, label]) => { const b = button(label, () => { if (workspace.module !== id) { workspace.page = 1; workspace.search = ''; } return navigate(id); }); b.dataset.module = id; nav.append(b); });
    await navigate('home'); return true;
  }
  function restore() {
    document.querySelectorAll('[data-design-display]').forEach(n => { n.style.display = n.dataset.designDisplay; delete n.dataset.designDisplay; });
    const host = document.getElementById('design-workspace'); if (host) host.hidden = true;
    document.querySelectorAll('.da-dialog').forEach(d => d.remove()); workspace = null;
  }
  function reset() { setRole(null); restore(); }
  function ownerPanel(user, api) {
    const previous = document.getElementById('design-owner-access'); if (previous) previous.remove();
    if (!user || user.role !== 'superadmin') return;
    installStyle(); const host = document.getElementById('tab-sellers'); if (!host) return;
    const box = el('section', null, 'da'); box.id = 'design-owner-access'; box.append(el('h2', 'Acesso Design'), el('p', 'Atribua acesso a uma conta já cadastrada. Edição permite alterar produtos; consulta permite apenas visualizar.'));
    const search = field(box, 'user', 'Buscar usuário por nome ou telefone', ''), results = el('div'), status = el('p'); status.setAttribute('role', 'status');
    const mode = select(box, 'Permissão', [{ value: 'edit', label: 'Design · edição' }, { value: 'view', label: 'Design · somente consulta' }, { value: 'none', label: 'Remover acesso Design' }], 'edit');
    let selected = null; const picked = el('p', 'Selecione uma conta.');
    const act = (label, action) => { const b = el('button', label, 'da-button'); b.type = 'button'; b.onclick = async () => { b.disabled = true; status.textContent = ''; try { await action(); } catch (e) { status.textContent = e.message; } finally { b.disabled = false; } }; return b; };
    const reload = async () => {
      const data = await api('/admin/design-access'); if (data.error) throw new Error(data.error);
      const list = data.users || data.accounts || [];
      results.replaceChildren(el('h3', 'Acessos atuais'));
      list.forEach(u => results.append(act(u.name + ' · ' + u.role, () => { selected = u; picked.textContent = u.name + ' · ' + u.role; mode.value = u.role === 'design_view' ? 'view' : 'edit'; })));
      if (!list.length) results.append(el('p', 'Nenhuma conta com acesso Design.'));
    };
    box.append(act('Buscar conta', async () => {
      if (!search.value.trim()) throw new Error('Informe um nome ou telefone.');
      selected = null; picked.textContent = 'Selecione uma conta.';
      const data = await api('/admin/users?search=' + encodeURIComponent(search.value.trim())); if (data.error) throw new Error(data.error);
      results.replaceChildren(); (data.users || []).slice(0, 20).forEach(u => results.append(act([u.name, u.phone, u.role].filter(Boolean).join(' · '), () => { selected = u; picked.textContent = [u.name, u.phone, u.role].filter(Boolean).join(' · '); })));
      if (!(data.users || []).length) results.append(el('p', 'Nenhuma conta encontrada.'));
    }), act('Listar acessos atuais', reload), results, picked, act('Aplicar permissão', async () => {
      if (!selected) throw new Error('Selecione a conta existente.');
      const data = await api('/admin/design-access', 'POST', { userId: selected.id, mode: mode.value, expectedRole: selected.role });
      if (data.error) throw new Error(data.error);
      selected = null; picked.textContent = 'Selecione uma conta.'; await reload(); status.textContent = 'Permissão atualizada.';
    }), status); host.prepend(box);
  }
  const exported = { restricted, canEdit, accepts, allowRequest, setRole, productPayload, normalizedPath, modules: MODULES, mount, navigate, reset, restore, ownerPanel,
    isRestricted: () => restricted(verifiedRole), isReady: () => verifiedRole != null, role: () => verifiedRole,
    canNavigateLegacy: () => verifiedRole != null && !restricted(verifiedRole), installFetchGuard };
  root.DesignAccess = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (root.document && root.location) installFetchGuard();
})(typeof window !== 'undefined' ? window : globalThis);
