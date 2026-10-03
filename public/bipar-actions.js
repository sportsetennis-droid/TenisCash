(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const settingsKey = 'tc_bipar_actions_settings_v1', pendingKey = 'tc_bipar_actions_pending_v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (_) { return fallback; } };
  const settings = read(settingsKey, { mode: 'inventory', stores: {}, origin: '' });
  settings.stores = settings.stores || {};
  let action = ['inventory', 'transfer', 'receipt'].includes(settings.mode) ? settings.mode : 'inventory';
  let token = sessionStorage.getItem('tc_transfer_token') || localStorage.getItem('loja_token') || localStorage.getItem('tc_token') || localStorage.getItem('tc_admin_token') || '';
  let actor = null, stores = [], allowed = [], shipments = [], generation = 0, shipmentRequest = 0, busy = false, storageFailed = false, preview = null, interaction = false;
  let currentDraft = null, stream = null, scanner = null, cameraTimer = null, cameraGeneration = 0, cameraRead = null;
  const inflight = new Set(), drafts = new Map();
  $('bipar-action').value = action;
  function isInventory() { return action === 'inventory'; }
  function store(id) { return stores.find(item => item.id === id); }
  function storeName(id) { const item = store(id); return item ? item.name + (item.code ? ' (' + item.code + ')' : '') : 'Loja não selecionada'; }
  function normalizedSize(value) { const size = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/^BR\s*/, '').replace(',', '.').trim(); return ['U', 'UNICO'].includes(size) ? 'UNICO' : size; }
  function message(text, error = false) { $('action-message').textContent = text; $('action-message').hidden = !text; $('action-message').className = 'transfer-message' + (error ? ' transfer-error' : ''); }
  function saveSettings() { try { localStorage.setItem(settingsKey, JSON.stringify(settings)); } catch (_) {} }
  function context() {
    const selected = $('loja').value;
    return { actorId: actor?.id || '', mode: action, fromStoreId: action === 'transfer' ? $('action-origin').value : '', toStoreId: selected, transferId: action === 'receipt' ? $('action-shipment').value : '' };
  }
  // Receiving starts at a store before a shipment is necessarily available.
  // Selecting or refreshing the shipment must not replace the physical lot.
  function contextKey(value = context()) { return JSON.stringify([value.actorId, value.mode, value.fromStoreId, value.toStoreId, value.mode === 'receipt' ? '' : value.transferId]); }
  function draftKey(key) { return 'tc_bipar_action_draft_v1:' + key; }
  function activeReads(draft = currentDraft) { return (draft?.scans || []).filter(item => !item.removed); }
  function newDraft(key) { return { key, sessionId: crypto.randomUUID(), scans: [], context: context() }; }
  function getDraft() {
    const key = contextKey();
    if (!drafts.has(key)) {
      const saved = read(draftKey(key), null);
      drafts.set(key, saved && saved.key === key && Array.isArray(saved.scans) ? saved : newDraft(key));
    }
    return drafts.get(key);
  }
  function persist(draft = currentDraft) {
    if (!draft) return false;
    try { localStorage.setItem(draftKey(draft.key), JSON.stringify(draft)); storageFailed = false; return true; }
    catch (_) { storageFailed = true; message('Não foi possível guardar o lote neste aparelho. Libere espaço no navegador e tente salvar novamente.', true); return false; }
  }
  function invalidate() { preview = null; $('action-review').hidden = true; $('action-approved').checked = false; }
  function validContext() {
    if (isInventory() || !actor || !store($('loja').value)) return false;
    if (action === 'transfer') return !!store($('action-origin').value) && allowed.includes($('action-origin').value) && $('action-origin').value !== $('loja').value;
    return allowed.includes($('loja').value);
  }
  function hasShipment() { return action !== 'receipt' || shipments.some(item => item.id === $('action-shipment').value); }
  function scansPayload(draft = currentDraft) {
    return activeReads(draft).map(item => ({ clientScanId: item.clientScanId, barcode: item.barcode, productSizeId: item.product?.productSizeId, confirmedSize: item.confirmedSize || '', ...(item.duplicateConfirmed ? { duplicateConfirmed: true } : {}) }));
  }
  function signature() { return JSON.stringify([contextKey(), context().transferId, currentDraft?.sessionId, scansPayload()]); }
  function localPending() { return activeReads().some(item => inflight.has(item.clientScanId) || !item.product || !item.confirmedSize || normalizedSize(item.confirmedSize) !== normalizedSize(item.product.size)); }
  function setOptions(select, options, placeholder, selected) {
    select.replaceChildren(new Option(placeholder, ''));
    for (const item of options) select.add(new Option(item.label, item.id));
    if (options.some(item => item.id === selected)) select.value = selected;
  }
  function refresh() {
    $('round-box').hidden = !isInventory(); $('inventory-readings').hidden = !isInventory(); $('inventory-seller-wrap').hidden = !isInventory();
    $('action-setup').hidden = isInventory(); $('action-workspace').hidden = isInventory();
    $('bipar-store-label').textContent = isInventory() ? 'LOJA DO INVENTÁRIO' : action === 'transfer' ? 'LOJA DE DESTINO' : 'LOJA QUE ESTÁ RECEBENDO';
    window.ScannerTransfer?.refresh();
    if (isInventory()) return;
    $('action-login').hidden = !!actor; $('action-switch-user').hidden = !actor;
    $('action-person').textContent = actor ? 'Operador: ' + actor.name : '';
    $('action-origin-wrap').hidden = action !== 'transfer'; $('action-shipment-wrap').hidden = action !== 'receipt';
    $('action-explanation').textContent = action === 'transfer'
      ? 'Escolha a origem e o destino. Bipe cada peça, confira o tamanho na etiqueta e envie o lote. O destino confirma a chegada ao receber.'
      : 'Escolha a loja e bipe as peças que chegaram. Você pode começar antes de a transferência aparecer. Depois, selecione a remessa para conferir e confirmar o recebimento.';
    const ready = validContext(), pending = read(pendingKey, null);
    $('bipe-box').classList.toggle('locked', !ready || busy || !!pending);
    $('codigo').disabled = !ready || busy || !!pending;
    $('codigo').placeholder = ready ? 'Bipe ou digite o código de barras…' : 'Selecione o contexto desta ação…';
    $('setup-status').className = 'setup-status ' + (ready ? 'status-ok' : 'status-warn');
    $('setup-status').textContent = ready ? (action === 'transfer' ? 'Transferência: ' + storeName($('action-origin').value) + ' → ' : 'Pronto para bipar o recebimento: ') + storeName($('loja').value) : !actor ? 'Entre com sua conta pessoal para continuar.' : action === 'receipt' ? 'Escolha uma loja vinculada à sua conta para bipar.' : 'Escolha a loja de origem e a loja de destino.';
    $('action-title').textContent = action === 'transfer' ? 'Lote para transferência' : 'Conferência do recebimento';
    $('action-context').textContent = ready ? activeReads().length + ' peça(s) neste lote · ' + (action === 'transfer' ? storeName($('action-origin').value) + ' → ' : '') + storeName($('loja').value) : 'Cada ação mantém seu próprio lote neste aparelho.';
    $('action-preview').disabled = busy || !ready || storageFailed || !!pending || (action === 'transfer' && !activeReads().length) || activeReads().some(item => inflight.has(item.clientScanId));
    $('action-clear').disabled = busy || !!pending || activeReads().some(item => inflight.has(item.clientScanId));
    $('action-confirm').disabled = busy || !hasShipment() || storageFailed || !!pending || !preview?.allowed || !preview || preview.signature !== signature() || !$('action-approved').checked || localPending();
    $('action-confirm').textContent = action === 'transfer' ? 'Enviar mercadoria para a loja de destino' : 'Confirmar mercadoria recebida';
    $('action-pending').hidden = !pending; $('action-retry').disabled = busy || !actor || (pending && pending.actorId !== actor.id);
    $('action-refresh-shipments').disabled = busy || !actor;
    $('action-origin').disabled = busy; $('action-shipment').disabled = busy; $('bipar-action').disabled = busy; $('loja').disabled = busy;
    for (const input of $('action-readings').querySelectorAll('input')) input.disabled = busy;
    $('action-storage-retry').hidden = !storageFailed;
  }
  function renderReadings() {
    const active = document.activeElement, focusId = active?.dataset?.scanSize, selection = focusId ? [active.selectionStart, active.selectionEnd] : null;
    const area = $('action-readings'); area.replaceChildren();
    if (!activeReads().length) { const empty = document.createElement('p'); empty.textContent = action === 'receipt' ? 'Bipe as peças recebidas. “Conferir lote” mostra também o que ainda falta.' : 'Os bipes desta transferência aparecerão aqui.'; area.append(empty); }
    for (const item of activeReads()) {
      const card = document.createElement('div'); card.className = 'action-reading';
      const title = document.createElement('strong'); title.textContent = item.product ? item.product.name + ' · ' + item.product.brand : 'Identificando o produto';
      const detail = document.createElement('p'); detail.textContent = 'Código: ' + item.barcode + (item.product ? ' · Cadastro: tamanho ' + item.product.size : '');
      card.append(title, detail);
      if (item.error) { const error = document.createElement('p'); error.className = 'transfer-error'; error.textContent = item.error; card.append(error); }
      if (item.product) {
        const label = document.createElement('label'); label.textContent = /ADIDAS/i.test(item.product.brand) ? 'Tamanho BR na etiqueta desta caixa' : 'Tamanho escrito na etiqueta desta peça';
        const size = document.createElement('input'); size.type = 'text'; size.maxLength = 20; size.autocomplete = 'off'; size.dataset.scanSize = item.clientScanId; size.value = item.confirmedSize || ''; size.placeholder = 'Leia na etiqueta e digite aqui'; size.setAttribute('aria-label', label.textContent + ' · ' + item.barcode);
        size.addEventListener('input', () => { item.confirmedSize = size.value.trim(); invalidate(); persist(); refresh(); });
        const hint = document.createElement('small'); hint.textContent = 'Em calçados, use BR. Se a etiqueta divergir do cadastro, separe a peça para corrigir antes de enviar.';
        label.append(size); card.append(label, hint);
      } else {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-secondary'; retry.textContent = inflight.has(item.clientScanId) ? 'Identificando…' : 'Tentar identificar novamente'; retry.disabled = inflight.has(item.clientScanId); retry.onclick = () => resolveRead(currentDraft, item); card.append(retry);
      }
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Retirar esta leitura do lote'; remove.disabled = busy || inflight.has(item.clientScanId); remove.onclick = () => { if (busy || inflight.has(item.clientScanId) || !confirm('Retirar somente esta leitura deste lote? Nenhum estoque será alterado.')) return; item.removed = true; invalidate(); persist(); renderReadings(); refresh(); }; card.append(remove); area.append(card);
    }
    if (focusId) { const input = [...area.querySelectorAll('[data-scan-size]')].find(item => item.dataset.scanSize === focusId); if (input) { input.focus({ preventScroll: true }); if (selection) input.setSelectionRange(...selection); } }
  }
  function contextChanged() {
    generation++; invalidate(); closeCamera(); clearTimeout(window._bipeAutoSubmitTimer); $('codigo').value = '';
    $('action-result').hidden = true;
    message('');
    currentDraft = getDraft(); renderReadings(); refresh();
  }
  async function api(path, body, authToken = token) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/scan-transfers/actions' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { if (response.status === 401 && authToken === token) actor = null; const error = new Error(data.error || 'Não foi possível concluir a consulta.'); error.status = response.status; throw error; }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function authenticate() {
    const authToken = token;
    try {
      const data = await api('/context', undefined, authToken); if (token !== authToken) return;
      actor = data.user; stores = data.stores || []; allowed = data.allowedStoreIds || [];
      if (!isInventory()) setOptions($('loja'), stores.map(item => ({ id: item.id, label: storeName(item.id) })), 'Selecione a loja', settings.stores[action] || $('loja').value);
      sessionStorage.setItem('tc_transfer_token', token);
      const personalStore = read('loja_activeStore', null)?.id;
      const origin = [settings.origin, settings.stores.inventory, personalStore].find(id => id && allowed.includes(id) && store(id)) || '';
      setOptions($('action-origin'), stores.filter(item => allowed.includes(item.id)).map(item => ({ id: item.id, label: storeName(item.id) })), 'Selecione a loja de origem', origin);
      settings.origin = origin; saveSettings(); contextChanged(); if (action === 'receipt') await loadShipments();
    } catch (error) { if (token !== authToken) return; actor = null; message(error.status === 401 ? 'Entre com sua conta pessoal para continuar.' : error.message, true); refresh(); }
  }
  async function loadShipments() {
    const request = ++shipmentRequest, selectedStore = $('loja').value, authToken = token, selectedShipment = $('action-shipment').value || settings.shipment;
    shipments = []; setOptions($('action-shipment'), [], 'Consultando transferências…', ''); invalidate(); refresh();
    if (!actor || action !== 'receipt' || !selectedStore) { setOptions($('action-shipment'), [], 'Selecione a loja que recebe', ''); refresh(); return; }
    try {
      const data = await api('/pending?storeId=' + encodeURIComponent(selectedStore), undefined, authToken);
      if (request !== shipmentRequest || action !== 'receipt' || $('loja').value !== selectedStore || token !== authToken) return;
      shipments = data.transfers || [];
      setOptions($('action-shipment'), shipments.map(item => ({ id: item.id, label: '#' + item.code + ' · ' + (item.fromStore?.name || 'Origem') + ' · ' + item.qtyTotal + ' peça(s)' })), shipments.length ? 'Selecione a transferência para conferir o lote' : 'Nenhuma pendente — você já pode bipar', selectedShipment);
      invalidate(); renderReadings(); refresh();
    } catch (error) { if (request === shipmentRequest && action === 'receipt' && $('loja').value === selectedStore && token === authToken) { setOptions($('action-shipment'), [], 'Falha na consulta — atualize', ''); message(error.message + ' Você pode continuar bipando; atualize a lista antes de confirmar.', true); refresh(); } }
  }
  async function resolveRead(draft, item, ocrText = '') {
    if (inflight.has(item.clientScanId) || item.removed) return;
    const authToken = token, owner = actor?.id;
    inflight.add(item.clientScanId); item.error = ''; invalidate(); refresh();
    try {
      const transferId = draft.context.mode === 'receipt' && currentDraft === draft && action === 'receipt' && hasShipment() ? context().transferId : '';
      const body = { barcode: item.barcode, ...(transferId ? { transferId, storeId: draft.context.toStoreId } : {}) };
      const data = await api('/lookup', body, authToken);
      if (owner !== draft.context.actorId || token !== authToken || actor?.id !== owner) { item.error = 'A conta mudou. Entre novamente e confira esta leitura.'; return; }
      item.product = data.product;
      const br = String(ocrText).match(/\bBR\s*0*(\d{2}(?:[.,]5)?)\b/i);
      if (br && normalizedSize(br[1]) === normalizedSize(data.product.size)) item.ocrSize = br[1];
    } catch (error) { item.error = error.message || 'Identificação interrompida. Tente novamente com esta mesma leitura.'; }
    finally { inflight.delete(item.clientScanId); persist(draft); if (currentDraft?.key === draft.key) { renderReadings(); refresh(); } }
  }
  async function scan(barcode, ocrText = '') {
    if (isInventory() || !validContext() || busy || read(pendingKey, null)) { message('Escolha a ação, entre na sua conta e confira as lojas antes de bipar.', true); return null; }
    barcode = String(barcode || '').trim(); if (!/^\d{8}$|^\d{12,14}$/.test(barcode)) { message('Leia o código de barras numérico da etiqueta. A referência do modelo não substitui o código.', true); return null; }
    const draft = currentDraft, key = contextKey(), gen = generation, count = activeReads(draft).filter(item => item.barcode.replace(/^0+/, '') === barcode.replace(/^0+/, '')).length;
    if (activeReads(draft).length >= 500) { message('Este lote já tem 500 peças. Confira e conclua antes de iniciar outro lote.', true); return null; }
    let duplicateConfirmed = false;
    if (count) {
      duplicateConfirmed = await window.ScannerConfirm.ask('CÓDIGO JÁ BIPADO NESTE LOTE\n\nCódigo: ' + barcode + '\nQuantidade anterior: ' + count + '\n\nÉ outra peça física? Confirmar acrescenta 1. Cancelar não conta novamente.');
      if (!duplicateConfirmed || key !== contextKey() || gen !== generation) return null;
    }
    const item = { clientScanId: crypto.randomUUID(), barcode, confirmedSize: '', duplicateConfirmed, createdAt: new Date().toISOString() };
    draft.scans.push(item); invalidate(); if (!persist(draft)) { renderReadings(); refresh(); return null; }
    renderReadings(); refresh(); await resolveRead(draft, item, ocrText); return item;
  }
  function previewBody() {
    const c = context();
    return action === 'transfer' ? { sessionId: currentDraft.sessionId, fromStoreId: c.fromStoreId, toStoreId: c.toStoreId, scans: scansPayload() } : { storeId: c.toStoreId, scans: scansPayload() };
  }
  async function prepare() {
    if (!validContext() || busy || storageFailed || read(pendingKey, null)) return;
    if (!hasShipment()) { message('Os bipes estão salvos neste aparelho. Selecione a transferência para conferir o lote. Se ela ainda não apareceu, a loja de origem precisa confirmar o envio; depois toque em “Atualizar transferências”.', true); return; }
    if (localPending()) { message('Confirme o código, o produto e o tamanho literal de cada peça antes de conferir o lote.', true); return; }
    const snapshot = signature(), gen = generation, body = previewBody(), path = action === 'transfer' ? '/send-preview' : '/' + encodeURIComponent(context().transferId) + '/receive-preview';
    busy = true; invalidate(); refresh(); message('Conferindo o lote e o estoque…');
    try {
      const data = await api(path, body);
      if (snapshot !== signature() || gen !== generation) { message('O contexto mudou. Confira novamente antes de confirmar.', true); return; }
      preview = { data, body, signature: snapshot, path: path.replace(/-preview$/, '-confirm'), allowed: action === 'transfer' ? data.canTransfer : data.canReceive };
      $('action-review').hidden = false; $('action-approved').checked = false;
      $('action-review-summary').textContent = action === 'transfer' ? data.scanCount + ' peça(s): ' + storeName(context().fromStoreId) + ' → ' + storeName(context().toStoreId) : 'Conferência da transferência #' + (data.transfer?.code || '');
      const list = $('action-review-items'); list.replaceChildren();
      for (const item of data.items || []) {
        const row = document.createElement('div'); row.className = 'action-reading';
        const title = document.createElement('strong'); title.textContent = (item.productName || item.name) + ' · Tam. ' + item.size;
        const detail = document.createElement('p'); detail.textContent = action === 'transfer' ? 'Enviar: ' + item.quantity + ' · Saldo na origem: ' + item.available + ' · Após envio: ' + item.remaining : 'Esperado: ' + item.expected + ' · Bipado: ' + item.scanned + ' · Faltam: ' + item.missing + ' · A mais: ' + item.excess;
        row.append(title, detail); list.append(row);
      }
      const blockers = $('action-blockers'); blockers.replaceChildren();
      for (const item of data.blockers || []) { const li = document.createElement('li'); li.textContent = item.message || String(item); blockers.append(li); }
      message(preview.allowed ? 'Confira os itens e marque a confirmação abaixo.' : 'Resolva as diferenças ou pendências indicadas antes de confirmar.', !preview.allowed);
    } catch (error) { message(error.message, true); }
    finally { busy = false; refresh(); }
  }
  async function confirmAction(retry = false) {
    if (busy || !actor) return;
    let pending = read(pendingKey, null);
    if (!retry) {
      if (pending || !validContext() || !hasShipment() || !preview?.allowed || preview.signature !== signature() || !$('action-approved').checked || localPending()) return;
      pending = { actorId: actor.id, mode: action, draftKey: currentDraft.key, sessionId: currentDraft.sessionId, path: preview.path, body: { ...preview.body, requestId: crypto.randomUUID(), reviewToken: preview.data.reviewToken } };
      try { localStorage.setItem(pendingKey, JSON.stringify(pending)); } catch (_) { message('Não foi possível salvar a confirmação. Nenhuma movimentação foi enviada.', true); return; }
    }
    if (!pending || pending.actorId !== actor.id) { message('Entre com a mesma conta usada no envio pendente.', true); return; }
    busy = true; closeCamera(); refresh(); message('Confirmando a operação…');
    try {
      const data = await api(pending.path, pending.body), transfer = data.transfer;
      const draft = drafts.get(pending.draftKey) || read(draftKey(pending.draftKey), null);
      if (draft?.sessionId === pending.sessionId) { for (const item of draft.scans) item.removed = true; if (!persist(draft)) throw Error('Operação confirmada no servidor, mas a limpeza local falhou. Verifique o mesmo envio novamente.'); }
      localStorage.removeItem(pendingKey); invalidate();
      $('action-result').hidden = false; $('action-result').textContent = pending.mode === 'transfer'
        ? 'Transferência #' + transfer.code + ' enviada. ' + transfer.qtyTotal + ' peça(s) aguardando conferência no destino.'
        : 'Transferência #' + transfer.code + ' recebida e conferida. ' + transfer.qtyTotal + ' peça(s) registradas na loja de destino.';
      message(data.alreadySaved ? 'Resultado recuperado. A mesma operação não foi repetida.' : 'Operação confirmada.');
      renderReadings(); if (action === 'receipt') await loadShipments();
      $('action-result').hidden = false;
    } catch (error) {
      if ([400, 403, 404, 409, 422].includes(error.status)) { localStorage.removeItem(pendingKey); invalidate(); message(error.message + ' Confira o lote novamente.', true); }
      else message((error.message || 'Conexão interrompida.') + ' Use “Verificar envio pendente”; o mesmo identificador será preservado.', true);
    } finally { busy = false; refresh(); }
  }
  function closeCamera() {
    cameraGeneration++; clearInterval(cameraTimer); scanner?.stop(); scanner = null; window.ScannerAuto?.stopDecoder(); stream?.getTracks().forEach(track => track.stop()); stream = null; cameraRead = null; $('action-camera')?.remove();
  }
  function frame() {
    const video = $('etiq-video'); if (!video?.videoWidth) return null;
    const canvas = document.createElement('canvas'), scale = Math.min(1, 1800 / Math.max(video.videoWidth, video.videoHeight)); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale); canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height); return canvas;
  }
  async function capture(read) {
    if (cameraRead || !stream) return;
    const cameraId = cameraGeneration;
    if (!read.ean) { $('etiq-hint').textContent = 'Falta ler o código de barras. Aproxime a etiqueta inteira e mantenha parada.'; scanner?.reset(); return; }
    cameraRead = { working: true }; scanner?.stop();
    $('etiq-confirm').style.display = 'flex'; $('etiq-confirm-status').textContent = 'Identificando a peça…'; $('etiq-confirm-btn').disabled = true;
    const item = await scan(read.ean, read.ocrText || '');
    if (cameraId !== cameraGeneration || !$('action-camera')) return;
    if (!item) { cameraRead = null; $('etiq-confirm').style.display = 'none'; scanner?.reset({ afterCode: read.ean }); return; }
    showCameraRead(item);
  }
  function showCameraRead(item) {
    $('action-camera-size')?.remove(); cameraRead = item;
    $('etiq-confirm-status').textContent = item.product ? 'Confira o tamanho na etiqueta' : 'Peça ainda não identificada';
    $('etiq-confirm-det').textContent = item.product ? item.product.name + ' · Código ' + item.barcode + ' · Cadastro: ' + item.product.size : item.error;
    if (item.product && item.ocrSize) $('etiq-confirm-det').textContent += ' · OCR sugeriu BR ' + item.ocrSize + '; confira na caixa.';
    const size = document.createElement('input'); size.id = 'action-camera-size'; size.type = 'text'; size.maxLength = 20; size.placeholder = /ADIDAS/i.test(item.product?.brand) ? 'Digite o BR desta caixa' : 'Digite o tamanho da etiqueta'; size.value = item.ocrSize || ''; size.setAttribute('aria-label', size.placeholder); size.style.cssText = 'display:block;min-height:48px;width:100%;max-width:320px;padding:10px;font-size:20px;margin:8px auto;color:#111;background:white;border-radius:8px';
    if (item.product) $('etiq-confirm-det').after(size);
    const button = $('etiq-confirm-btn'); button.textContent = item.product ? 'TAMANHO CONFERIDO — PRÓXIMA PEÇA' : 'TENTAR IDENTIFICAR NOVAMENTE'; button.disabled = !item.product || normalizedSize(size.value) !== normalizedSize(item.product.size); button.style.background = '#167541';
    size.addEventListener('input', () => { button.disabled = !size.value.trim() || normalizedSize(size.value) !== normalizedSize(item.product?.size); });
    if (!item.product) button.disabled = false;
  }
  async function openCamera() {
    if (!validContext() || busy || read(pendingKey, null)) { message('Selecione o contexto desta ação antes de abrir a câmera.', true); return; }
    window.fecharScanner?.(); closeCamera(); const cameraId = cameraGeneration;
    const overlay = document.createElement('div'); overlay.id = 'action-camera'; overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99998;display:flex;flex-direction:column'; overlay.innerHTML = window.ScannerView.markup(); document.body.append(overlay);
    overlay.addEventListener('click', async event => {
      event.stopPropagation(); const command = event.target.closest('[data-click]')?.dataset.click;
      if (command === 'close') return closeCamera();
      if (command === 'capture' && !cameraRead) { const captured = frame(); if (captured) { const ean = await window.ScannerAuto.decodeInWorker(captured); await capture({ ean: typeof ean === 'string' ? ean : ean?.text || '', frame: captured }); } }
      if (command !== 'next' || !cameraRead || cameraRead.working) return;
      if (!cameraRead.product) { const item = cameraRead, cameraId = cameraGeneration; await resolveRead(currentDraft, item); if (cameraId === cameraGeneration && $('action-camera')) showCameraRead(item); return; }
      const size = $('action-camera-size')?.value.trim() || ''; if (!size || normalizedSize(size) !== normalizedSize(cameraRead.product.size)) return;
      cameraRead.confirmedSize = size; persist(); invalidate(); const code = cameraRead.barcode; cameraRead = null; $('action-camera-size')?.remove(); $('etiq-confirm').style.display = 'none'; renderReadings(); refresh(); scanner?.reset({ afterCode: code });
    });
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (cameraId !== cameraGeneration) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened; $('etiq-video').srcObject = stream; await $('etiq-video').play();
      if (cameraId !== cameraGeneration || !$('action-camera')) { opened.getTracks().forEach(track => track.stop()); return; }
      $('etiq-contador').textContent = 'Lote desta ação · ' + activeReads().length + ' peça(s)'; $('etiq-lista').textContent = 'O estoque só muda depois da conferência e confirmação do lote.';
      scanner = window.ScannerAuto.create({ snapshot: frame, decode: canvas => window.ScannerAuto.decodeInWorker(canvas), recognize: canvas => window.ScannerOCR.recognize(canvas), canRead: () => !!stream && !cameraRead && cameraId === cameraGeneration, onHint: text => { if ($('action-camera')) $('etiq-hint').textContent = text; }, onCapture: capture });
      cameraTimer = setInterval(() => scanner?.tick(), 350);
    } catch (error) { closeCamera(); message('Não foi possível abrir a câmera: ' + error.message, true); }
  }
  function storesReady() {
    if (!settings.stores.inventory) settings.stores.inventory = $('loja').value || '';
    if (!isInventory()) $('loja').value = settings.stores[action] || '';
    saveSettings(); contextChanged(); if (!isInventory() && token && !actor) authenticate();
  }
  function storeChanged() { settings.stores[action] = $('loja').value; saveSettings(); contextChanged(); if (action === 'receipt') loadShipments(); }
  $('bipar-action').addEventListener('change', () => {
    if (busy) { $('bipar-action').value = action; return; }
    settings.stores[action] = $('loja').value; window.fecharScanner?.(); $('manual-overlay')?.remove(); $('size-overlay')?.remove();
    action = $('bipar-action').value; settings.mode = action;
    $('loja').value = settings.stores[action] || (isInventory() ? localStorage.getItem('sports_tennis_bipar_loja') || '' : '');
    if (action === 'transfer' && !settings.origin && allowed.includes(settings.stores.inventory)) { settings.origin = settings.stores.inventory; $('action-origin').value = settings.origin; }
    saveSettings(); contextChanged();
    if (isInventory()) { if (typeof carregarLojas === 'function') carregarLojas(); }
    else if (!actor && token) authenticate(); else if (action === 'receipt') loadShipments();
  });
  $('action-origin').addEventListener('change', () => { settings.origin = $('action-origin').value; saveSettings(); contextChanged(); });
  $('action-shipment').addEventListener('change', () => { settings.shipment = $('action-shipment').value; saveSettings(); contextChanged(); });
  $('action-refresh-shipments').onclick = loadShipments; $('action-preview').onclick = prepare; $('action-approved').onchange = refresh; $('action-confirm').onclick = () => confirmAction(); $('action-retry').onclick = () => confirmAction(true);
  $('action-clear').onclick = () => { if (busy || read(pendingKey, null)) return; if (!confirm('Começar outro lote neste contexto? As leituras locais deste lote serão retiradas. Nenhum estoque será alterado.')) return; const key = contextKey(); currentDraft = newDraft(key); drafts.set(key, currentDraft); persist(); invalidate(); renderReadings(); refresh(); };
  $('action-storage-retry').onclick = () => { if (persist()) message('Lote salvo neste aparelho.'); refresh(); };
  $('action-switch-user').onclick = () => { if (busy) return; actor = null; token = ''; sessionStorage.removeItem('tc_transfer_token'); contextChanged(); refresh(); $('action-identity').focus(); };
  $('action-login').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; $('action-login-button').disabled = true;
    try { const identity = $('action-identity').value.trim(); const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(identity.includes('@') ? { email: identity } : { phone: identity.replace(/\D/g, '') }), password: $('action-password').value }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || 'Não foi possível entrar.'); token = data.token; $('action-password').value = ''; await authenticate(); }
    catch (error) { message(error.message, true); }
    finally { busy = false; $('action-login-button').disabled = false; refresh(); }
  });
  document.addEventListener('pointerdown', event => { interaction = !!event.target.closest('#action-setup,#action-workspace,#action-camera'); });
  document.addEventListener('focusin', event => { if (event.target !== document.body) interaction = !!event.target.closest('#action-setup,#action-workspace,#action-camera'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); });
  window.addEventListener('storage', event => { if (event.key === pendingKey) refresh(); if (currentDraft && event.key === draftKey(currentDraft.key) && !busy && !inflight.size) { drafts.delete(currentDraft.key); currentDraft = getDraft(); invalidate(); renderReadings(); refresh(); } });
  window.BiparActions = { mode: () => action, version: () => generation, isInventory, refresh, scan, openCamera, closeCamera, storesReady, storeChanged, hasFocus: () => interaction };
  refresh();
})();
