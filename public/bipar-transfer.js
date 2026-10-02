(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const storageKey = 'tc_bipar_transfer_sequence_v1';
  const pendingKey = 'tc_bipar_transfer_pending_v1';
  let records = read(storageKey, []), actor = null, preview = null, busy = false, revision = 0, storageReady = true, interacting = false;
  let token = sessionStorage.getItem('tc_transfer_token') || localStorage.getItem('tc_token') || localStorage.getItem('tc_admin_token') || '';
  const activities = new Map();
  function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (_) { return fallback; } }
  function normalized(value) { return Array.isArray(value) ? value.filter(item => item && typeof item.scanKey === 'string' && item.storeId && item.roundId) : []; }
  records = normalized(records);
  function syncRecords() { if (storageReady) records = normalized(read(storageKey, [])); }
  function scope() { const storeId = $('loja')?.value || '', round = window.ScannerRound?.current(); return { storeId, roundId: round?.storeId === storeId && ['counting', 'review'].includes(round.status) ? round.id : '' }; }
  function keyOf(item) { return item.scanKey || (item.roundId && item.clientScanId ? item.roundId + ':' + item.clientScanId : ''); }
  function inScope(item, current) { return item.storeId === current.storeId && item.roundId === current.roundId; }
  function selected(current = scope()) { return records.filter(item => !item.archived && inScope(item, current)); }
  function inFlight(current = scope()) { return [...activities.values()].filter(item => inScope(item, current)).length; }
  function outstanding(current = scope()) { return selected(current).filter(item => !item.saved).length; }
  function signature() { const current = scope(); return JSON.stringify([current.storeId, current.roundId, $('transfer-destination').value, selected().map(item => [item.scanKey, item.bipeId || '', !!item.saved]).sort()]); }
  function notice(text, error = false) { $('transfer-message').textContent = text; $('transfer-message').hidden = !text; $('transfer-message').className = 'transfer-message' + (error ? ' transfer-error' : ''); }
  function invalidate() { preview = null; $('transfer-review').hidden = true; $('transfer-checked').checked = false; }
  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(records)); storageReady = true; return true; }
    catch (_) { storageReady = false; notice('Não foi possível guardar a sequência neste aparelho. Libere espaço no navegador antes de transferir.', true); return false; }
  }
  function change() { revision++; invalidate(); persist(); refresh(); }
  function start(item) {
    // New scans use the explicit action selected before scanning. Keep only legacy batches here.
    syncRecords(); refresh();
  }
  function update(item, state = {}) {
    syncRecords();
    const scanKey = keyOf(item), row = records.find(entry => entry.scanKey === scanKey);
    if (!row || row.archived) return;
    const next = { ...row, ...state }; if (JSON.stringify(next) === JSON.stringify(row)) return;
    Object.assign(row, next); change();
  }
  function discard(item) { syncRecords(); const key = keyOf(item), row = records.find(item => item.scanKey === key); if (row && !row.archived) { row.archived = true; change(); } }
  function activity(id, item) { if (item) activities.set(id, item); else activities.delete(id); invalidate(); refresh(); }
  function refresh() {
    const current = scope(), count = selected(current).length, waiting = outstanding(current), sending = inFlight(current), round = window.ScannerRound?.current();
    const store = $('loja')?.selectedOptions[0]?.textContent || '';
    $('transfer-scope').textContent = current.roundId ? store + ' · Rodada #' + round.number + ' · ' + count + ' leitura(s) nesta sequência deste aparelho.' : 'Selecione uma loja com rodada aberta para reunir uma sequência.';
    $('transfer-local-pending').textContent = sending ? 'Há envio(s) em andamento. Aguarde para conferir a transferência.' : waiting ? waiting + ' leitura(s) ainda não têm gravação confirmada neste aparelho. Use “Conferir mercadoria e estoque” para consultar o servidor; pendências impedem a transferência.' : '';
    $('transfer-local-pending').hidden = !waiting && !sending;
    const destination = $('transfer-destination'), previous = destination.value;
    const options = [...($('loja')?.options || [])].filter(option => option.value && option.value !== current.storeId);
    const optionSignature = JSON.stringify(options.map(option => [option.value, option.textContent]));
    if (destination.dataset.options !== optionSignature) {
      destination.replaceChildren(new Option('Selecione a loja de destino', ''));
      for (const option of options) destination.add(new Option(option.textContent, option.value));
      destination.value = options.some(option => option.value === previous) ? previous : '';
      destination.dataset.options = optionSignature;
    }
    if (preview && preview.signature !== signature()) invalidate();
    const pending = read(pendingKey, null);
    const legacy = $('legacy-inventory-transfer');
    if (legacy) legacy.hidden = (window.BiparActions && !window.BiparActions.isInventory()) || (!records.some(item => !item.archived) && !pending);
    $('transfer-pending').hidden = !pending;
    $('transfer-retry').disabled = busy || !actor || (pending && actor.id !== pending.actorId);
    $('transfer-preview').disabled = busy || !storageReady || !!pending || !actor || !current.roundId || !count || !!sending || !destination.value;
    $('transfer-confirm').disabled = busy || !storageReady || !!pending || !preview?.data.canTransfer || !$('transfer-checked').checked || !!sending;
    $('transfer-reset').disabled = busy || !!pending || !count || !!sending;
    destination.disabled = busy || !!pending;
    $('transfer-login').hidden = !!actor;
    $('transfer-person').hidden = !actor;
    $('transfer-storage-retry').hidden = storageReady;
    $('transfer-change-account').hidden = !actor;
    $('transfer-person').textContent = actor ? 'Operador da transferência: ' + actor.name : '';
  }
  async function api(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/scan-transfers' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(data.error || 'Não foi possível concluir. Tente novamente.'); error.status = response.status; throw error; }
      return data;
    } finally { clearTimeout(timer); }
  }
  async function authenticate() {
    try { const data = await api('/me'); actor = data.user; sessionStorage.setItem('tc_transfer_token', token); }
    catch (error) { actor = null; if (error.status !== 401) notice(error.message, true); }
    refresh();
  }
  function errorMessage(error) { if (error.status === 401) { actor = null; return 'Entre novamente com sua conta pessoal para continuar.'; } return error.message || 'Sem conexão. Tente novamente.'; }
  function payload() {
    const current = scope(), items = selected(current);
    return { fromStoreId: current.storeId, toStoreId: $('transfer-destination').value, roundId: current.roundId, scanKeys: items.map(item => item.scanKey), bipeIds: [...new Set(items.map(item => item.bipeId).filter(Boolean))] };
  }
  function renderPreview(data) {
    $('transfer-review').hidden = false;
    $('transfer-review-summary').textContent = data.scanCount + ' peça(s): ' + data.fromStore.name + ' → ' + data.toStore.name + '.';
    const body = $('transfer-items'); body.replaceChildren();
    for (const item of data.items || []) {
      const row = document.createElement('tr');
      const values = [item.productName + (item.brand ? ' · ' + item.brand : ''), item.size, item.quantity, item.available, item.remaining];
      for (let index = 0; index < values.length; index++) {
        const cell = document.createElement('td'); cell.dataset.label = ['Produto', 'Tamanho', 'Transferir', 'Saldo origem', 'Saldo após'][index]; cell.textContent = String(values[index] ?? '—'); row.append(cell);
      }
      body.append(row);
    }
    const blockers = $('transfer-blockers'); blockers.replaceChildren();
    for (const blocker of data.blockers || []) { const item = document.createElement('li'); item.textContent = typeof blocker === 'string' ? blocker : blocker.message; blockers.append(item); }
    blockers.hidden = !blockers.children.length;
    $('transfer-checked').checked = false;
    $('transfer-approval').hidden = !data.canTransfer;
    refresh();
  }
  async function prepare() {
    syncRecords();
    if (busy || !storageReady || inFlight() || !actor || read(pendingKey, null)) return;
    const captured = payload(), capturedSignature = signature(), capturedRevision = revision;
    if (!captured.roundId || !captured.scanKeys.length || !captured.toStoreId) return;
    busy = true; invalidate(); notice('Conferindo cada leitura e o saldo da origem…'); refresh();
    try {
      const data = await api('/batch-preview', captured);
      if (capturedSignature !== signature() || capturedRevision !== revision) { notice('A sequência mudou durante a consulta. Confira novamente antes de transferir.', true); return; }
      if (data.canTransfer) {
        const included = new Set(captured.scanKeys);
        for (const item of records) if (included.has(item.scanKey)) item.saved = true;
        if (!persist()) return;
      }
      preview = { data, payload: captured, signature: signature() }; renderPreview(data);
      notice(data.canTransfer ? 'Confira todos os produtos, tamanhos e quantidades abaixo.' : 'A transferência está bloqueada pelas pendências abaixo.', !data.canTransfer);
    } catch (error) { notice(errorMessage(error), true); }
    finally { busy = false; refresh(); }
  }
  async function confirmBatch(retry = false) {
    if (busy || !actor) return;
    let pending = read(pendingKey, null);
    if (!retry) {
      syncRecords();
      if (pending || !storageReady || !preview?.data.canTransfer || preview.signature !== signature() || inFlight() || !$('transfer-checked').checked) return;
      pending = { actorId: actor.id, payload: { ...preview.payload, requestId: crypto.randomUUID(), reviewToken: preview.data.reviewToken } };
      try { localStorage.setItem(pendingKey, JSON.stringify(pending)); }
      catch (_) { notice('Não foi possível preservar a confirmação neste aparelho. Nenhuma transferência foi enviada.', true); return; }
    }
    if (!pending || pending.actorId !== actor.id) { notice('Entre com a mesma conta usada na confirmação pendente.', true); return; }
    busy = true; notice('Confirmando a transferência…'); refresh();
    try {
      const result = await api('/batch-confirm', pending.payload), transfer = result.transfer;
      const sent = new Set(pending.payload.scanKeys), ids = new Set(pending.payload.bipeIds);
      syncRecords();
      for (const item of records) if (item.roundId === pending.payload.roundId && item.storeId === pending.payload.fromStoreId && (sent.has(item.scanKey) || ids.has(item.bipeId))) item.archived = true;
      const saved = persist(); if (saved) localStorage.removeItem(pendingKey); invalidate(); revision++;
      $('transfer-result').hidden = false;
      $('transfer-result').textContent = 'Transferência #' + transfer.code + ' concluída: ' + transfer.qtyTotal + ' peça(s), ' + transfer.fromStore.name + ' → ' + transfer.toStore.name + '. Comprovante: ' + transfer.id + '. Os bipes originais permanecem no histórico.';
      notice(!saved ? 'Transferência concluída, mas a sequência local não pôde ser atualizada. Use “Verificar envio pendente” depois de liberar espaço; o envio não será duplicado.' : result.alreadySaved ? 'Resultado confirmado. Esta transferência já estava salva; nenhuma peça foi transferida novamente.' : 'Sequência anterior concluída. Para outro lote, escolha a ação Transferência no alto da página.', !saved);
      window.ScannerRound?.refresh();
    } catch (error) {
      if ([400, 403, 404, 409, 422].includes(error.status)) { localStorage.removeItem(pendingKey); invalidate(); notice(errorMessage(error) + ' Confira a sequência novamente.', true); }
      else { notice(errorMessage(error) + ' O resultado ainda não está confirmado. Use “Verificar envio pendente”; a mesma confirmação será reutilizada sem duplicar.', true); }
    } finally { busy = false; refresh(); }
  }
  $('transfer-login-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; $('transfer-login-button').disabled = true; notice('Verificando acesso…');
    try {
      const identity = $('transfer-identity').value.trim();
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(identity.includes('@') ? { email: identity } : { phone: identity.replace(/\D/g, '') }), password: $('transfer-password').value }) });
      const data = await response.json(); if (!response.ok) throw Error(data.error || 'Não foi possível entrar.');
      token = data.token; $('transfer-password').value = ''; await authenticate(); if (actor) notice('Conta pessoal verificada. Escolha o destino para conferir a sequência.');
    } catch (error) { notice(error.message, true); }
    finally { busy = false; $('transfer-login-button').disabled = false; refresh(); }
  });
  $('transfer-preview').addEventListener('click', prepare);
  $('transfer-storage-retry').addEventListener('click', () => { if (persist()) notice('Sequência salva neste aparelho. Confira o lote antes de transferir.'); refresh(); });
  $('transfer-change-account').addEventListener('click', () => { if (busy) return; actor = null; token = ''; sessionStorage.removeItem('tc_transfer_token'); invalidate(); refresh(); $('transfer-identity').focus(); });
  $('transfer-confirm').addEventListener('click', () => confirmBatch(false));
  $('transfer-retry').addEventListener('click', () => confirmBatch(true));
  $('transfer-destination').addEventListener('change', () => { invalidate(); refresh(); });
  $('transfer-checked').addEventListener('change', refresh);
  $('transfer-reset').addEventListener('click', () => {
    if (busy || inFlight() || read(pendingKey, null)) return;
    if (!window.confirm('Começar uma nova sequência neste aparelho?\nOs bipes atuais continuam no inventário e no histórico, mas deixam de fazer parte deste lote para transferência. Nenhuma mercadoria será movimentada.')) return;
    syncRecords(); const current = scope(); for (const item of records) if (inScope(item, current)) item.archived = true; change(); notice('Nova sequência iniciada. Os próximos bipes entrarão neste lote. Leituras anteriores e pendências continuam preservadas no inventário.');
  });
  $('loja').addEventListener('change', () => { invalidate(); refresh(); });
  document.addEventListener('pointerdown', event => { interacting = $('bipar-transfer').contains(event.target); });
  document.addEventListener('focusin', event => { if (event.target !== document.body) interacting = $('bipar-transfer').contains(event.target); });
  window.addEventListener('storage', event => { if (event.key === storageKey && storageReady) { records = normalized(read(storageKey, [])); revision++; invalidate(); } if ([storageKey, pendingKey].includes(event.key)) refresh(); });
  window.ScannerTransfer = { start, update, discard, activity, refresh, hasFocus: () => interacting || $('bipar-transfer').contains(document.activeElement) };
  refresh(); if (token) authenticate();
})();
