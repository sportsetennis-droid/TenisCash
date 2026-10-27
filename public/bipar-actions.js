(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const settingsKey = 'tc_bipar_actions_settings_v1', pendingKey = 'tc_bipar_actions_pending_v1';
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch (_) { return fallback; } };
  const stable = value => JSON.stringify(value, function (_, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item; });
  const settings = read(settingsKey, { mode: 'inventory', stores: {}, origin: '' });
  settings.stores = settings.stores || {};
  let action = ['inventory', 'transfer', 'receipt'].includes(settings.mode) ? settings.mode : 'inventory';
  let token = sessionStorage.getItem('tc_transfer_token') || localStorage.getItem('loja_token') || localStorage.getItem('tc_token') || localStorage.getItem('tc_admin_token') || '';
  let actor = null, stores = [], allowed = [], shipments = [], generation = 0, shipmentRequest = 0, busy = false, storageFailed = false, preview = null, interaction = false;
  let expiredActor = null, authenticationRecoveryTimer = null, authenticationRecovery = null;
  const automaticAuthenticationAttempts = new Set();
  let currentDraft = null, stream = null, scanner = null, cameraTimer = null, cameraGeneration = 0, cameraAttempt = 0, cameraRead = null, cameraRetry = null, cameraPendingRead = null;
  const cameraOcrReads = new Map();
  const inflight = new Set(), drafts = new Map(), lookups = new Map();
  const syncJobs = new Map(), draftBases = new Map(), archivePrefix = 'tc_bipar_action_archive_v1:';
  let legacyRecoveryInventory = [];
  const recoveryConflicts = new Map();
  let historyMode = action === 'receipt' ? 'receipt' : 'transfer', historyPage = 1, historyRequest = 0, historyData = null, historyBusy = false, historyRefreshTimer = null;
  const lookupConcurrency = 3;
  const lookupQueue = [];
  let runningLookups = 0;
  function lookupSlot() {
    return new Promise(resolve => {
      const start = () => {
        runningLookups++;
        resolve(() => { runningLookups--; lookupQueue.shift()?.(); });
      };
      if (runningLookups < lookupConcurrency) start(); else lookupQueue.push(start);
    });
  }
  $('bipar-action').value = action;
  function isInventory() { return action === 'inventory'; }
  function store(id) { return stores.find(item => item.id === id); }
  function storeName(id) { const item = store(id); return item ? item.name + (item.code ? ' (' + item.code + ')' : '') : 'Loja não selecionada'; }
  function normalizedSize(value) { const size = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/^BR\s*/, '').replace(',', '.').trim(); return ['U', 'UNICO'].includes(size) ? 'UNICO' : size; }
  function sizeConflict(item) { return !!item.confirmedSize && normalizedSize(item.confirmedSize) !== normalizedSize(item.product?.size); }
  function requiresSizeInput(item) { return item.requiresSizeConfirmation !== false || /ADIDAS/i.test(item.product?.brand || '') || sizeConflict(item); }
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
  function newDraft(key) { return { key, sessionId: crypto.randomUUID(), scans: [], context: context(), revision: 0, syncedRevision: 0, status: 'open' }; }
  function getDraft() {
    const key = contextKey();
    if (!drafts.has(key)) {
      const saved = read(draftKey(key), null);
      drafts.set(key, saved && saved.key === key && saved.context?.actorId === actor?.id && contextKey(saved.context) === key && Array.isArray(saved.scans) ? saved : newDraft(key));
      draftBases.set(drafts.get(key).sessionId, new Map(drafts.get(key).scans.map(item => [item.clientScanId, JSON.stringify(item)])));
    }
    const draft = drafts.get(key);
    if (draft.context?.mode === 'receipt' && draft.context.transferId !== context().transferId) { draft.context.transferId = context().transferId; if (draft.scans.length) persist(draft); }
    return draft;
  }
  function draftStorageKey(draft) { return draft.status === 'archived' || draft.status === 'confirmed' ? archivePrefix + draft.sessionId : draftKey(draft.key); }
  function supersededBySyncedArchive(key, snapshot) {
    if (!snapshot?.sessionId || key === archivePrefix + snapshot.sessionId || !Array.isArray(snapshot.scans) || !snapshot.scans.length) return false;
    const canonical = read(archivePrefix + snapshot.sessionId, null);
    if (!['archived', 'confirmed'].includes(canonical?.status) || Number(canonical.syncedRevision || 0) < (Number(snapshot.revision) || 1)) return false;
    const canonicalScans = new Map((canonical.scans || []).map(item => [item.clientScanId, stable(item)]));
    return snapshot.scans.every(item => canonicalScans.get(item.clientScanId) === stable(item));
  }
  function pruneSyncedClosedDraftCopy(protectedSessionIds = []) {
    const protectedIds = new Set(protectedSessionIds.filter(Boolean));
    const candidates = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith('tc_bipar_action_draft_v1:') && !key?.startsWith(archivePrefix)) continue;
      const snapshot = read(key, null), revision = Number(snapshot?.revision) || 1;
      if (!snapshot?.sessionId || protectedIds.has(snapshot.sessionId) || snapshot.context?.actorId !== actor?.id || recoveryConflicts.has(snapshot.sessionId)) continue;
      let safelyReplaceable = ['archived', 'confirmed'].includes(snapshot.status) && Number(snapshot.syncedRevision || 0) >= revision;
      // Archiving moves the primary copy from the context key to the session
      // archive key. The old context-key copy can remain marked "open". It is
      // safe to remove only when the canonical archived copy contains every
      // scan ID and its server-acknowledged revision covers this stale copy.
      // Conflict/recovery snapshots are deliberately excluded from eviction.
      if (!safelyReplaceable) safelyReplaceable = supersededBySyncedArchive(key, snapshot);
      if (!safelyReplaceable) continue;
      const firstScan = (snapshot.scans || []).map(item => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] || 0;
      candidates.push({ key, firstScan });
    }
    candidates.sort((a, b) => a.firstScan - b.firstScan);
    if (!candidates.length) return false;
    // Only evict a closed local copy after its latest revision was acknowledged
    // by the server. Open, unsynced, conflicting and other operators' lots stay.
    localStorage.removeItem(candidates[0].key);
    return true;
  }
  function setDraftSnapshot(key, value, protectedSessionIds = []) {
    for (;;) {
      try { localStorage.setItem(key, value); return true; }
      catch (error) {
        const quotaExceeded = error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014;
        if (!quotaExceeded || !pruneSyncedClosedDraftCopy(protectedSessionIds)) throw error;
      }
    }
  }
  function persist(draft = currentDraft) {
    if (!draft) return false;
    if (recoveryConflicts.has(draft.sessionId)) { storageFailed = true; message('Este lote está sendo recuperado com segurança. Aguarde a conferência das cópias antes de continuar bipando.', true); return false; }
    draft.status ||= 'open';
    try {
      const saved = read(draftStorageKey(draft), null), base = draftBases.get(draft.sessionId) || new Map();
      if (saved?.sessionId && saved.sessionId !== draft.sessionId && saved.scans?.length) {
        const checkpoint = read(archivePrefix + saved.sessionId, null);
        if (!checkpoint || Number(checkpoint.revision || 0) < Number(saved.revision || 0)) {
          const savedRevision = Number(saved.revision) || 1;
          const alreadySynced = Number(saved.syncedRevision || 0) >= savedRevision;
          if (!alreadySynced) setDraftSnapshot(archivePrefix + saved.sessionId, JSON.stringify(saved), [saved.sessionId, draft.sessionId]);
        }
      }
      if (saved?.sessionId === draft.sessionId) {
        const merged = new Map((saved.scans || []).map(item => [item.clientScanId, item]));
        for (const item of draft.scans) {
          const remote = merged.get(item.clientScanId);
          if (remote && base.get(item.clientScanId) === JSON.stringify(item)) {
            for (const key of Object.keys(item)) if (!(key in remote)) delete item[key];
            Object.assign(item, remote);
          }
          merged.set(item.clientScanId, item);
        }
        // Another tab may have appended a repeated product. Its distinct scan ID
        // must survive this tab's next write, even when the revision was equal.
        draft.scans = [...merged.values()];
      }
      draft.revision = Math.max(Number(draft.revision) || 0, Number(saved?.sessionId === draft.sessionId ? saved.revision : 0) || 0) + 1;
      // A session checkpoint survives another tab replacing the active context.
      // Its status stays open; saving a checkpoint is not archiving the lot.
      const serialized = JSON.stringify(draft), primaryKey = draftStorageKey(draft), checkpointKey = archivePrefix + draft.sessionId;
      // Save the active lot first. Its mirrored checkpoint is a recovery aid;
      // failure to write that second copy must not block scanning or misreport
      // an already saved lot as lost.
      setDraftSnapshot(primaryKey, serialized, [draft.sessionId, saved?.sessionId]);
      if (checkpointKey !== primaryKey) {
        try { localStorage.setItem(checkpointKey, serialized); } catch (_) { /* active draft is already durable */ }
      }
      draftBases.set(draft.sessionId, new Map(draft.scans.map(item => [item.clientScanId, JSON.stringify(item)])));
      storageFailed = false; queueSync(draft); return true;
    }
    catch (_) { storageFailed = true; message('Não foi possível guardar o lote neste aparelho. Libere espaço no navegador e tente salvar novamente.', true); return false; }
  }
  function syncPayload(draft) {
    return { sessionId: draft.sessionId, mode: draft.context.mode, fromStoreId: draft.context.fromStoreId || '', toStoreId: draft.context.toStoreId, transferId: draft.context.transferId || '', revision: draft.revision, status: draft.status === 'archived' ? 'archived' : 'open', scans: draft.scans.map(item => ({ clientScanId: item.clientScanId, barcode: item.barcode, createdAt: item.createdAt, removed: !!item.removed, product: item.product, confirmedSize: item.confirmedSize || '', requiresSizeConfirmation: item.requiresSizeConfirmation !== false, error: item.error || '' })) };
  }
  function canRecoverOthers() { return ['admin', 'superadmin'].includes(actor?.role); }
  function canRecoverDraft(draft) { return !!actor && !!draft?.context?.actorId && (draft.context.actorId === actor.id || canRecoverOthers()); }
  function canSyncDraft(draft) { return canRecoverDraft(draft) && !recoveryConflicts.has(draft.sessionId); }
  function syncStatus() {
    const visibleOwner = actor || expiredActor;
    const own = [...syncJobs.values()].filter(job => job.draft.status !== 'confirmed' && (canSyncDraft(job.draft) || !actor && visibleOwner && (job.draft.context.actorId === visibleOwner.id || ['admin', 'superadmin'].includes(visibleOwner.role))));
    const pending = own.filter(job => Number(job.draft.syncedRevision || 0) < Number(job.draft.revision || 1));
    const status = $('action-sync-status');
    status.hidden = !visibleOwner || isInventory();
    status.textContent = !actor && expiredActor ? (pending.length ? 'Sincronização pendente: sessão expirada. Os bipes estão guardados; entre novamente para salvá-los no sistema.' : 'Sessão expirada. Entre novamente para continuar.') : !pending.length ? 'Bipes salvos no sistema.' : pending.some(job => job.needsReview) ? 'Sincronização pendente: ' + pending.find(job => job.needsReview).error : pending.some(job => job.error) ? 'Sincronização pendente. Os bipes estão guardados e serão enviados ao sistema quando a conexão voltar.' : 'Salvando os bipes no sistema…';
    const conflicts = [...recoveryConflicts.values()].filter(item => item.operatorId === actor?.id || canRecoverOthers());
    if (conflicts.length) status.textContent = 'Recuperação pendente: ' + conflicts.length + ' lote(s) têm cópias divergentes. Todas as cópias foram preservadas para conferir as leituras; não foi escolhido um lote incompleto.';
    if (canRecoverOthers() && legacyRecoveryInventory.length) status.textContent += ' Há ' + legacyRecoveryInventory.length + ' fonte(s) antiga(s) preservada(s) para conferência; nenhuma movimentação foi reenviada.';
    status.className = 'transfer-message' + (expiredActor || conflicts.length || pending.some(job => job.error) ? ' transfer-error' : '');
    $('action-sync-retry').hidden = !expiredActor && !conflicts.length && !pending.some(job => job.error);
  }
  function queueSync(draft, immediate = false) {
    if (!draft?.scans?.length || !['transfer', 'receipt'].includes(draft.context?.mode) || draft.status === 'confirmed') return;
    let job = syncJobs.get(draft.sessionId);
    if (!job) { job = { draft, timer: null, running: null, error: '' }; syncJobs.set(draft.sessionId, job); }
    job.draft = draft; clearTimeout(job.timer); syncStatus();
    if (!canSyncDraft(draft)) return;
    if (immediate) return flushSync(draft);
    job.timer = setTimeout(() => { void flushSync(job.draft); }, 250);
  }
  async function flushSync(draft) {
    const job = syncJobs.get(draft?.sessionId);
    if (recoveryConflicts.has(draft?.sessionId)) return false;
    if (!job || draft.status === 'confirmed') return true;
    if (job.running) { await job.running; return canSyncDraft(draft) && Number(draft.syncedRevision || 0) >= Number(draft.revision || 1); }
    if (!canSyncDraft(draft) || !token) return false;
    clearTimeout(job.timer);
    const authToken = token, owner = actor.id, originalOperatorId = draft.context.actorId, recoveringOther = owner !== originalOperatorId;
    let conflictRetry = false;
    job.running = (async () => {
      while (actor?.id === owner && token === authToken && draft.context.actorId === originalOperatorId && canSyncDraft(draft) && draft.status !== 'confirmed' && Number(draft.syncedRevision || 0) < Number(draft.revision || 1)) {
        const body = syncPayload(draft), revision = body.revision;
        try {
          const data = await api(recoveringOther ? '/drafts/recover' : '/drafts/sync', recoveringOther ? { originalOperatorId, ...body } : body, authToken);
          if (actor?.id !== owner || token !== authToken || recoveryConflicts.has(draft.sessionId)) return false;
          if (data.lot?.status === 'confirmed') {
            const result = await api('/history/' + encodeURIComponent(draft.sessionId), undefined, authToken);
            if (actor?.id !== owner || token !== authToken || recoveryConflicts.has(draft.sessionId)) return false;
            const savedIds = new Set((result.scans || []).map(item => item.clientScanId));
            if (draft.scans.some(item => !savedIds.has(item.clientScanId))) { const conflict = Error('Este lote foi concluído em outra sessão. Há novos bipes guardados localmente que ainda não entraram no histórico; mantenha esta página aberta e confira o lote.'); conflict.status = 409; throw conflict; }
            draft.status = 'confirmed'; draft.syncedRevision = revision;
          } else if (!data.synced || Number(data.lot?.revision) < revision) { const conflict = Error('O lote mudou em outra sessão. Atualize o histórico antes de continuar.'); conflict.status = 409; throw conflict; }
          else draft.syncedRevision = revision;
          // An acknowledgement must never overwrite a newer tab's local copy.
          const saved = read(draftStorageKey(draft), null);
          if (saved?.sessionId === draft.sessionId && Number(saved.revision) === revision && JSON.stringify(syncPayload(saved)) === JSON.stringify(body)) {
            saved.syncedRevision = Math.max(Number(saved.syncedRevision) || 0, revision);
            const serialized = JSON.stringify(saved), primaryKey = draftStorageKey(draft), checkpointKey = archivePrefix + draft.sessionId;
            setDraftSnapshot(primaryKey, serialized, [draft.sessionId]);
            if (checkpointKey !== primaryKey) {
              try { localStorage.setItem(checkpointKey, serialized); } catch (_) { /* server acknowledgement and active copy are preserved */ }
            }
          }
          job.error = ''; job.needsReview = false; syncStatus();
          clearTimeout(historyRefreshTimer); historyRefreshTimer = setTimeout(() => { if (actor?.id === owner && token === authToken) void loadHistory(historyPage); }, 750);
          if (job.draft !== draft) draft = job.draft;
        } catch (error) {
          // Recovery preserves a different operator's snapshot. A conflicting
          // lot is left for review, never edited or merged under the admin.
          if (!recoveringOther && error.status === 409 && !conflictRetry && actor?.id === owner && token === authToken) {
            conflictRetry = true;
            try {
              const latest = await api('/history/' + encodeURIComponent(draft.sessionId), undefined, authToken);
              if (actor?.id !== owner || token !== authToken || latest.lot?.operator?.id !== owner || latest.lot?.status !== 'open') throw error;
              const merged = new Map((latest.scans || []).map(item => [item.clientScanId, item]));
              for (const item of draft.scans) { if (merged.get(item.clientScanId)?.removed) item.removed = true; merged.set(item.clientScanId, item); }
              draft.scans = [...merged.values()]; draft.revision = Math.max(draft.revision, Number(latest.lot.revision) || 0);
              if (!persist(draft)) throw error;
              continue;
            } catch (_) { /* Preserve the complete local lot for an explicit retry. */ }
          }
          job.error = error.message || 'Sem conexão'; job.needsReview = [400, 403, 404, 409, 422].includes(error.status); syncStatus();
          if (actor?.id === owner && token === authToken && ![400, 403, 404, 409, 422].includes(error.status)) job.timer = setTimeout(() => { void flushSync(draft); }, 15000);
          return false;
        }
      }
      if (draft.status === 'confirmed' && currentDraft === draft && !read(pendingKey, null)) return startNewLot('confirmed');
      return Number(draft.syncedRevision || 0) >= Number(draft.revision || 1);
    })();
    try { return await job.running; } finally { job.running = null; syncStatus(); }
  }
  function recoverDrafts() {
    if (!actor) return;
    // Preserve the original operator, context, IDs and timestamps of older lots.
    const recovered = new Map(); legacyRecoveryInventory = []; recoveryConflicts.clear();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (canRecoverOthers() && (['tc_bipar_transfer_sequence_v1', 'tc_bipar_transfer_pending_v1', pendingKey, 'tc_bipe_retry_queue', 'etiqFila'].includes(key) || key?.startsWith('tc_transfer_pending_'))) {
        const value = read(key, null);
        const entries = Array.isArray(value) ? value : value ? [value] : [];
        const type = key === 'tc_bipar_transfer_sequence_v1' ? 'inventory_sequence' : key === 'tc_bipe_retry_queue' ? 'inventory_retry_queue' : key === 'etiqFila' ? 'inventory_photo_queue' : key.startsWith('tc_transfer_pending_') ? 'pending_single_transfer' : 'pending_confirmation';
        // Counts describe stored records only, never confirmed physical pieces.
        if (entries.length) legacyRecoveryInventory.push({ key, type, recordCount: Array.isArray(value) ? value.length : type === 'pending_single_transfer' ? 1 : (value.body?.scans || value.payload?.scanKeys || []).length, operatorId: value.actorId || null, sessionId: value.sessionId || null, requestId: value.body?.requestId || value.payload?.requestId || value.requestId || null, needsReview: true });
        continue;
      }
      if (!key?.startsWith('tc_bipar_action_draft_v1:') && !key?.startsWith(archivePrefix)) continue;
      const draft = read(key, null);
      // Closing a lot moves its canonical copy to the archive key. Older
      // context-key snapshots may still say "open"; once the archived copy
      // has the same scan IDs and its revision is acknowledged by the server,
      // discard that redundant shadow instead of treating it as a conflicting
      // unsaved lot on the next page load.
      if (supersededBySyncedArchive(key, draft)) { localStorage.removeItem(key); continue; }
      if (!draft?.context?.actorId && canRecoverOthers()) { legacyRecoveryInventory.push({ key, type: 'unidentified_draft', recordCount: Array.isArray(draft?.scans) ? draft.scans.length : null, needsReview: true }); continue; }
      if (!canRecoverDraft(draft) || !Array.isArray(draft.scans) || !draft.scans.length || draft.status === 'confirmed') continue;
      draft.revision = Number(draft.revision) || 1; draft.status ||= 'open';
      if (!recovered.has(draft.sessionId)) recovered.set(draft.sessionId, []);
      recovered.get(draft.sessionId).push(draft);
    }
    for (const [sessionId, copies] of recovered) {
      const first = copies[0];
      const header = draft => stable({ context: draft.context, status: draft.status || 'open' });
      const evidence = new Map(); let conflicting = copies.some(copy => header(copy) !== header(first));
      for (const copy of copies) {
        const ownIds = new Set();
        for (const item of copy.scans) {
          const value = stable(item);
          if (ownIds.has(item.clientScanId) || evidence.has(item.clientScanId) && evidence.get(item.clientScanId) !== value) conflicting = true;
          ownIds.add(item.clientScanId); evidence.set(item.clientScanId, value);
        }
      }
      const revision = Math.max(...copies.map(copy => Number(copy.revision) || 1));
      // Storage order is not evidence. Only an intact, compatible superset at
      // the newest revision can represent every copy without losing a scan.
      const target = copies.find(copy => (Number(copy.revision) || 1) === revision && copy.scans.length === evidence.size);
      if (conflicting || !target) {
        const issue = { sessionId, operatorId: first.context.actorId, type: 'conflicting_action_copies', recordCount: evidence.size, copyCount: copies.length, needsReview: true };
        recoveryConflicts.set(sessionId, issue); legacyRecoveryInventory.push(issue);
        // The original copies are already intact in local storage. Do not add
        // another full copy here: it consumes quota and can falsely block the
        // scanner. Reconcile only against the server-acknowledged lot below.
        const job = syncJobs.get(sessionId); if (job) { clearTimeout(job.timer); job.error = 'Há cópias divergentes deste lote. As leituras precisam ser conferidas antes de sincronizar.'; job.needsReview = true; }
        continue;
      }
      target.revision = revision; queueSync(target, true);
    }
    syncStatus();
    void reconcileConflictsFromServer();
  }
  async function reconcileConflictsFromServer() {
    const authToken = token, owner = actor?.id;
    for (const [sessionId, issue] of [...recoveryConflicts]) {
      if (issue.reconciling || token !== authToken || actor?.id !== owner) continue;
      issue.reconciling = true;
      try {
        const copies = [];
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index), copy = key?.startsWith('tc_bipar_action_draft_v1:') || key?.startsWith(archivePrefix) ? read(key, null) : null;
          if (copy?.sessionId === sessionId && Array.isArray(copy.scans)) copies.push({ key, copy });
        }
        if (!copies.length) throw Error('As cópias locais do lote não estão disponíveis.');
        const latestRevision = Math.max(...copies.map(({ copy }) => Number(copy.revision) || 1));
        const result = await api('/history/' + encodeURIComponent(sessionId), undefined, authToken);
        if (token !== authToken || actor?.id !== owner || recoveryConflicts.get(sessionId) !== issue) continue;
        const lot = result.lot, serverScans = Array.isArray(result.scans) ? result.scans : [];
        if (!lot || lot.sessionId !== sessionId || lot.operator?.id !== issue.operatorId || Number(lot.revision) < latestRevision || !['open', 'archived', 'confirmed'].includes(lot.status)) throw Error('O histórico do servidor ainda não confirma todas as revisões locais.');
        const serverById = new Map(serverScans.map(scan => [scan.clientScanId, scan]));
        const remoteFromStore = lot.fromStoreId || '';
        for (const { copy } of copies) {
          const context = copy.context || {};
          if (context.actorId !== lot.operator.id || context.mode !== lot.mode || (context.fromStoreId || '') !== remoteFromStore || context.toStoreId !== lot.toStoreId || Number(copy.revision || 1) > Number(lot.revision)) throw Error('A ação, loja ou revisão difere do lote salvo no servidor.');
          if (Number(copy.revision || 1) === Number(lot.revision) && ((copy.status || 'open') !== lot.status || (context.transferId || '') !== (lot.transferId || ''))) throw Error('A última revisão local difere do status ou da transferência salva no servidor.');
          const localIds = new Set();
          for (const scan of copy.scans) {
            if (localIds.has(scan.clientScanId)) throw Error('Uma cópia contém identificadores de bipe repetidos.');
            localIds.add(scan.clientScanId);
            const saved = serverById.get(scan.clientScanId);
            if (!saved || Date.parse(scan.createdAt) !== Date.parse(saved.createdAt)) throw Error('Há bipes locais ausentes ou com horário diferente no servidor.');
            if (Number(copy.revision || 1) === Number(lot.revision)) {
              const localProductId = scan.product?.productSizeId || '';
              const savedProductId = saved.product?.productSizeId || '';
              if (scan.barcode !== saved.barcode || !!scan.removed !== !!saved.removed || String(scan.confirmedSize || '').trim() !== String(saved.confirmedSize || '').trim() || localProductId !== savedProductId || String(scan.error || '') !== String(saved.error || '')) throw Error('A última revisão contém bipes diferentes do histórico confirmado.');
            }
          }
        }
        // The server has acknowledged at least the newest local revision and
        // contains every local scan ID with its immutable timestamp. Use its
        // canonical physical fields, retaining only local OCR/correction
        // annotations that are not part of the server record.
        const copiesByRevision = copies.map(({ copy }) => copy).sort((a, b) => (Number(b.revision) || 1) - (Number(a.revision) || 1));
        const context = { ...(copiesByRevision[0].context || {}), actorId: lot.operator.id, mode: lot.mode, fromStoreId: lot.fromStoreId || '', toStoreId: lot.toStoreId, transferId: lot.transferId || '' };
        const canonical = { ...copiesByRevision[0], key: contextKey(context), sessionId, context, status: lot.status, revision: Number(lot.revision), syncedRevision: Number(lot.revision), scans: serverScans.map(saved => {
          const local = copiesByRevision.flatMap(copy => copy.scans).find(scan => scan.clientScanId === saved.clientScanId) || {};
          return { ...local, clientScanId: saved.clientScanId, barcode: saved.barcode, createdAt: saved.createdAt, removed: !!saved.removed, product: saved.product || undefined,
            confirmedSize: saved.confirmedSize || '', requiresSizeConfirmation: saved.requiresSizeConfirmation !== false, error: saved.error || '' };
        }) };
        const primaryKey = draftStorageKey(canonical), serialized = JSON.stringify(canonical);
        try { localStorage.setItem(primaryKey, serialized); }
        catch (error) {
          if (!pruneSyncedClosedDraftCopy([sessionId])) throw error;
          localStorage.setItem(primaryKey, serialized);
        }
        if (primaryKey !== archivePrefix + sessionId) { try { localStorage.setItem(archivePrefix + sessionId, serialized); } catch (_) { /* primary canonical lot already saved */ } }
        for (let index = localStorage.length - 1; index >= 0; index--) {
          const key = localStorage.key(index), copy = key === primaryKey ? null : (key?.startsWith('tc_bipar_action_draft_v1:') || key?.startsWith(archivePrefix) ? read(key, null) : null);
          if (copy?.sessionId === sessionId) localStorage.removeItem(key);
        }
        recoveryConflicts.delete(sessionId); legacyRecoveryInventory = legacyRecoveryInventory.filter(item => item.sessionId !== sessionId);
        const job = syncJobs.get(sessionId); if (job) { clearTimeout(job.timer); job.error = ''; job.needsReview = false; job.draft = canonical; }
        drafts.set(canonical.key, canonical); draftBases.set(sessionId, new Map(canonical.scans.map(scan => [scan.clientScanId, JSON.stringify(scan)])));
        if (currentDraft?.sessionId === sessionId) {
          currentDraft = canonical; storageFailed = false; message('Lote recuperado do histórico sincronizado. As leituras foram preservadas.');
          if (lot.status === 'confirmed') startNewLot('confirmed');
          else { renderReadings(); refresh(); }
        }
      } catch (error) {
        if (token !== authToken || actor?.id !== owner || recoveryConflicts.get(sessionId) !== issue) continue;
        issue.reconciling = false; issue.error = error.message || 'Não foi possível conferir o lote no servidor.';
        if (currentDraft?.sessionId === sessionId) { storageFailed = true; message('O lote continua preservado, mas há diferenças que o servidor não confirmou. Novas leituras ficam pausadas para evitar perda de bipes.', true); refresh(); }
        syncStatus();
      }
    }
  }
  function startNewLot(status = 'archived') {
    const previous = currentDraft, key = contextKey(), oldStatus = previous?.status;
    if (previous?.scans.length) {
      previous.status = status;
      if (!persist(previous)) { previous.status = oldStatus; return false; }
    }
    const next = newDraft(key);
    if (!persist(next)) {
      if (previous) { previous.status = oldStatus; try { localStorage.setItem(archivePrefix + previous.sessionId, JSON.stringify(previous)); } catch (_) {} }
      return false;
    }
    currentDraft = next; drafts.set(key, next); invalidate(); renderReadings(); refresh(); return true;
  }
  function invalidate() { preview = null; $('action-review').hidden = true; $('action-approved').checked = false; }
  function validContext() {
    if (isInventory() || !actor || !store($('loja').value)) return false;
    if (action === 'transfer') return !!store($('action-origin').value) && allowed.includes($('action-origin').value) && $('action-origin').value !== $('loja').value;
    return allowed.includes($('loja').value);
  }
  function hasShipment() { return action !== 'receipt' || shipments.some(item => item.id === $('action-shipment').value); }
  function scansPayload(draft = currentDraft) {
    return activeReads(draft).map(item => ({ clientScanId: item.clientScanId, barcode: item.barcode, productSizeId: item.product?.productSizeId, confirmedSize: item.confirmedSize || '', ...(item.requiresSizeConfirmation === false ? { resolvedSize: item.product?.size || '' } : {}), ...(item.duplicateConfirmed ? { duplicateConfirmed: true } : {}) }));
  }
  function signature() { return JSON.stringify([contextKey(), context().transferId, currentDraft?.sessionId, scansPayload()]); }
  function localPending() { return activeReads().some(item => inflight.has(item.clientScanId) || !item.product || (requiresSizeInput(item) && (!item.confirmedSize || sizeConflict(item)))); }
  function refreshLegacyReads() {
    if (!validContext() || busy || read(pendingKey, null)) return;
    // Failed lookups are saved too. A repaired catalog must recover those same
    // readings instead of forcing a new physical scan or keeping an old error.
    void refreshIdentifications(false);
  }
  async function refreshIdentifications(all) {
    if (!validContext() || read(pendingKey, null)) return false;
    const draft = currentDraft, gen = generation, selected = JSON.stringify(context());
    const reads = activeReads(draft).filter(item => all || !item.product || typeof item.requiresSizeConfirmation !== 'boolean');
    const current = () => currentDraft === draft && generation === gen && selected === JSON.stringify(context()) && validContext() && !read(pendingKey, null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(lookupConcurrency, reads.length) }, async () => {
      while (current() && next < reads.length) await resolveRead(draft, reads[next++]);
    }));
    return current();
  }
  function setOptions(select, options, placeholder, selected) {
    select.replaceChildren(new Option(placeholder, ''));
    for (const item of options) select.add(new Option(item.label, item.id));
    if (options.some(item => item.id === selected)) select.value = selected;
  }
  function refresh() {
    $('round-box').hidden = !isInventory(); $('inventory-readings').hidden = !isInventory(); $('inventory-seller-wrap').hidden = !isInventory();
    $('action-setup').hidden = isInventory(); $('action-workspace').hidden = isInventory();
    $('action-history').hidden = isInventory(); syncStatus();
    $('bipar-store-label').textContent = isInventory() ? 'LOJA DO INVENTÁRIO' : action === 'transfer' ? 'LOJA DE DESTINO' : 'LOJA QUE ESTÁ RECEBENDO';
    window.ScannerTransfer?.refresh();
    if (isInventory()) return;
    $('action-login').hidden = !!actor; $('action-switch-user').hidden = !actor;
    $('action-person').textContent = actor ? 'Operador: ' + actor.name : '';
    $('action-origin-wrap').hidden = action !== 'transfer'; $('action-shipment-wrap').hidden = action !== 'receipt';
    $('action-explanation').textContent = action === 'transfer'
      ? 'Escolha a origem e o destino. Bipe cada peça, confira o lote e envie. O destino confirma a chegada ao receber.'
      : 'Escolha a loja e bipe as peças que chegaram. Você pode começar antes de a transferência aparecer. Depois, selecione a remessa para conferir e confirmar o recebimento.';
    const ready = validContext(), pending = read(pendingKey, null);
    $('bipe-box').classList.toggle('locked', !ready || busy || !!pending);
    $('codigo').disabled = !ready || busy || !!pending;
    $('codigo').placeholder = ready ? 'Bipe ou digite o código de barras…' : 'Selecione o contexto desta ação…';
    $('setup-status').className = 'setup-status ' + (ready ? 'status-ok' : 'status-warn');
    $('setup-status').textContent = ready ? (action === 'transfer' ? 'Transferência: ' + storeName($('action-origin').value) + ' → ' : 'Pronto para bipar o recebimento: ') + storeName($('loja').value) : !actor ? 'Entre com sua conta pessoal para continuar.' : action === 'receipt' ? 'Escolha uma loja vinculada à sua conta para bipar.' : 'Escolha a loja de origem e a loja de destino.';
    $('action-title').textContent = action === 'transfer' ? 'Lote para transferência' : 'Conferência do recebimento';
    $('action-context').textContent = ready ? activeReads().length + ' peça(s) neste lote · ' + (action === 'transfer' ? storeName($('action-origin').value) + ' → ' : '') + storeName($('loja').value) : 'Transferência e recebimento têm lotes e históricos separados.';
    $('action-preview').disabled = busy || !ready || storageFailed || !!pending || (action === 'transfer' && !activeReads().length) || activeReads().some(item => inflight.has(item.clientScanId));
    $('action-clear').disabled = busy || !!pending || activeReads().some(item => inflight.has(item.clientScanId));
    $('action-confirm').disabled = busy || !hasShipment() || storageFailed || !!pending || !preview?.allowed || !preview || preview.signature !== signature() || !$('action-approved').checked || localPending();
    $('action-confirm').textContent = action === 'transfer' ? 'Enviar mercadoria para a loja de destino' : 'Confirmar mercadoria recebida';
    $('action-pending').hidden = !pending; $('action-retry').disabled = busy || !actor || (pending && pending.actorId !== actor.id);
    $('action-refresh-shipments').disabled = busy || !actor;
    $('action-origin').disabled = busy; $('action-shipment').disabled = busy; $('bipar-action').disabled = busy; $('loja').disabled = busy;
    for (const input of $('action-readings').querySelectorAll('input')) input.disabled = busy || !!pending || inflight.has(input.dataset.scanSize);
    for (const button of $('action-readings').querySelectorAll('button')) button.disabled = busy || !!pending || inflight.has(button.dataset.scanId);
    updateCameraSummary();
    $('action-storage-retry').hidden = !storageFailed;
  }
  function renderReadings() {
    const active = document.activeElement, focusId = active?.dataset?.scanSize, selection = focusId ? [active.selectionStart, active.selectionEnd] : null;
    const area = $('action-readings'); area.replaceChildren();
    if (!activeReads().length) { const empty = document.createElement('p'); empty.textContent = action === 'receipt' ? 'Bipe as peças recebidas. “Conferir lote” mostra também o que ainda falta.' : 'Os bipes desta transferência aparecerão aqui.'; area.append(empty); }
    for (const item of activeReads()) {
      const card = document.createElement('div'); card.className = 'action-reading';
      const title = document.createElement('strong'); title.textContent = item.product ? item.product.name + ' · ' + item.product.brand : inflight.has(item.clientScanId) ? 'Identificando o produto' : 'Leitura pendente — produto não identificado';
      const detail = document.createElement('p'); detail.textContent = 'Código: ' + item.barcode + (item.product ? ' · Cadastro: tamanho ' + item.product.size : '');
      card.append(title, detail);
      if (item.error) { const error = document.createElement('p'); error.className = 'transfer-error'; error.textContent = item.error; card.append(error); }
      if (item.product && requiresSizeInput(item)) {
        const label = document.createElement('label'); label.textContent = /ADIDAS/i.test(item.product.brand) ? 'Tamanho BR na etiqueta desta caixa' : 'Tamanho escrito na etiqueta desta peça';
        const size = document.createElement('input'); size.type = 'text'; size.maxLength = 20; size.autocomplete = 'off'; size.dataset.scanSize = item.clientScanId; size.value = item.confirmedSize || ''; size.placeholder = 'Leia na etiqueta e digite aqui'; size.setAttribute('aria-label', label.textContent + ' · ' + item.barcode);
        size.addEventListener('input', () => { if (busy || read(pendingKey, null) || inflight.has(item.clientScanId)) return; item.confirmedSize = size.value.trim(); invalidate(); persist(); refresh(); });
        const hint = document.createElement('small'); hint.textContent = 'Em calçados, use BR. Se a etiqueta divergir do cadastro, separe a peça para corrigir antes de enviar.';
        label.append(size); card.append(label, hint);
      } else if (!item.product) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-secondary'; retry.textContent = 'Ler novamente esta peça'; retry.dataset.scanId = item.clientScanId; retry.disabled = busy || inflight.has(item.clientScanId) || !!read(pendingKey, null); retry.onclick = () => openCamera(item); card.append(retry);
      }
      const update = document.createElement('button'); update.type = 'button'; update.className = 'btn btn-secondary'; update.textContent = inflight.has(item.clientScanId) ? 'Atualizando identificação…' : 'Atualizar identificação'; update.dataset.scanId = item.clientScanId; update.disabled = busy || inflight.has(item.clientScanId) || !!read(pendingKey, null); update.onclick = async () => { if (busy || read(pendingKey, null)) return; await resolveRead(currentDraft, item); }; card.append(update);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Retirar esta leitura do lote'; remove.dataset.scanId = item.clientScanId; remove.disabled = busy || inflight.has(item.clientScanId) || !!read(pendingKey, null); remove.onclick = () => { if (busy || read(pendingKey, null) || inflight.has(item.clientScanId) || !confirm('Retirar somente esta leitura deste lote? Nenhum estoque será alterado.')) return; item.removed = true; invalidate(); persist(); renderReadings(); refresh(); }; card.append(remove); area.append(card);
    }
    if (focusId) { const input = [...area.querySelectorAll('[data-scan-size]')].find(item => item.dataset.scanSize === focusId); if (input) { input.focus({ preventScroll: true }); if (selection) input.setSelectionRange(...selection); } }
  }
  function contextChanged() {
    generation++; invalidate(); closeCamera(); clearTimeout(window._bipeAutoSubmitTimer); $('codigo').value = '';
    $('action-result').hidden = true;
    message('');
    currentDraft = getDraft(); renderReadings(); refresh(); refreshLegacyReads();
  }
  async function api(path, body, authToken = token) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch('/api/scan-transfers/actions' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + authToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { if (response.status === 401 && authToken === token) expireAuthentication(authToken, path !== '/context'); const error = new Error(data.error || 'Não foi possível concluir a consulta.'); error.status = response.status; throw error; }
      return data;
    } finally { clearTimeout(timer); }
  }
  function tokenSubject(value) {
    try { const encoded = String(value).split('.')[1]; if (!encoded) return ''; const payload = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='))); return typeof payload.userId === 'string' ? payload.userId : ''; } catch (_) { return ''; }
  }
  function expireAuthentication(authToken, retryAutomatically) {
    if (authToken !== token) return;
    expiredActor ||= actor || (tokenSubject(authToken) ? { id: tokenSubject(authToken) } : null);
    actor = null; closeCamera(); invalidate(); refresh();
    message('Sua sessão expirou. Os bipes guardados ainda precisam ser sincronizados. Entre novamente para continuar.', true);
    if (retryAutomatically && expiredActor && !automaticAuthenticationAttempts.has(authToken)) {
      automaticAuthenticationAttempts.add(authToken); clearTimeout(authenticationRecoveryTimer);
      // Wait until the rejected sync has left its running state. Recovery only
      // sends saved scan drafts; it never repeats a stock confirmation.
      authenticationRecoveryTimer = setTimeout(() => { if (token === authToken && !actor) void resumeAuthentication(); }, 0);
    }
  }
  async function resumeAuthentication() {
    if (actor || !expiredActor || !token) return;
    if (authenticationRecovery) return authenticationRecovery;
    const expectedUserId = expiredActor.id;
    authenticationRecovery = authenticate({ expectedUserId });
    try { await authenticationRecovery; } finally { authenticationRecovery = null; }
  }
  async function authenticate(options = {}) {
    const authToken = token, expectedUserId = options.expectedUserId || actor?.id || tokenSubject(authToken);
    let operationToken = authToken;
    try {
      const candidates = [authToken];
      // A stale tab token must not hide a newer login for the same person.
      // JWT decoding only selects candidates; /context verifies each identity.
      if (options.allowFallback !== false && expectedUserId) for (const key of ['loja_token', 'tc_token', 'tc_admin_token']) {
        const candidate = localStorage.getItem(key);
        if (candidate && !candidates.includes(candidate) && tokenSubject(candidate) === expectedUserId) candidates.push(candidate);
      }
      let data, verifiedToken;
      for (let index = 0; index < candidates.length; index++) {
        try {
          const result = await api('/context', undefined, candidates[index]); if (token !== authToken) return;
          if ((index || options.expectedUserId) && result.user?.id !== expectedUserId) throw Object.assign(Error('A sessão encontrada pertence a outra conta. Entre com a conta do operador para continuar.'), { status: 403 });
          data = result; verifiedToken = candidates[index]; break;
        } catch (error) { if (token !== authToken) return; if (error.status !== 401 || index === candidates.length - 1) throw error; }
      }
      token = verifiedToken; operationToken = verifiedToken;
      actor = data.user; expiredActor = null; clearTimeout(authenticationRecoveryTimer); stores = data.stores || []; allowed = data.allowedStoreIds || [];
      // Preserve every stored copy before getDraft, shipment rebinding or a
      // fast catalog refresh can write the normal session checkpoint.
      recoverDrafts();
      if (!isInventory()) setOptions($('loja'), stores.map(item => ({ id: item.id, label: storeName(item.id) })), 'Selecione a loja', settings.stores[action] || $('loja').value);
      sessionStorage.setItem('tc_transfer_token', token);
      const personalStore = read('loja_activeStore', null)?.id;
      const origin = [settings.origin, settings.stores.inventory, personalStore].find(id => id && allowed.includes(id) && store(id)) || '';
      setOptions($('action-origin'), stores.filter(item => allowed.includes(item.id)).map(item => ({ id: item.id, label: storeName(item.id) })), 'Selecione a loja de origem', origin);
      settings.origin = origin; saveSettings(); contextChanged(); if (action === 'receipt') await loadShipments();
      setupHistory(); void loadHistory(1);
    } catch (error) { if (token !== operationToken) return; actor = null; message(error.status === 401 ? 'Entre com sua conta pessoal para continuar.' : error.message, true); refresh(); }
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
      if (currentDraft?.context?.mode === 'receipt' && currentDraft.context.toStoreId === selectedStore && currentDraft.context.transferId !== $('action-shipment').value) { currentDraft.context.transferId = $('action-shipment').value; if (currentDraft.scans.length) persist(); }
      invalidate(); renderReadings(); refresh(); refreshLegacyReads();
    } catch (error) { if (request === shipmentRequest && action === 'receipt' && $('loja').value === selectedStore && token === authToken) { setOptions($('action-shipment'), [], 'Falha na consulta — atualize', ''); message(error.message + ' Você pode continuar bipando; atualize a lista antes de confirmar.', true); refresh(); } }
  }
  async function resolveRead(draft, item, ocrText = '') {
    if (!draft || currentDraft !== draft || item.removed || !activeReads(draft).includes(item) || !validContext() || read(pendingKey, null)) return false;
    const authToken = token, owner = actor?.id, gen = generation, cameraAtRequest = cameraGeneration, barcode = item.barcode, selected = JSON.stringify(context());
    const current = () => currentDraft === draft && generation === gen && selected === JSON.stringify(context()) && owner === draft.context.actorId && token === authToken && actor?.id === owner && item.barcode === barcode && !item.removed && activeReads(draft).includes(item) && validContext() && !read(pendingKey, null);
    const existing = lookups.get(item.clientScanId);
    if (existing) {
      if (existing.gen === gen && existing.selected === selected && existing.barcode === barcode && existing.authToken === authToken && !String(ocrText).trim()) return existing.promise;
      await existing.promise;
      if (!current()) return false;
      return resolveRead(draft, item, ocrText);
    }
    if (String(ocrText).trim()) item.ocrText = String(ocrText).trim().slice(0, 12000);
    inflight.add(item.clientScanId); item.error = ''; invalidate(); refresh();
    const job = { gen, selected, barcode, authToken };
    job.promise = (async () => { const release = await lookupSlot(); try {
      if (!current()) return false;
      const transferId = draft.context.mode === 'receipt' && currentDraft === draft && action === 'receipt' && hasShipment() ? context().transferId : '';
      const body = { barcode, ...(item.ocrText ? { ocrText: item.ocrText } : {}), ...(transferId ? { transferId, storeId: draft.context.toStoreId } : {}) };
      const data = await api('/lookup', body, authToken);
      if (!current()) return false;
      item.product = data.product;
      item.requiresSizeConfirmation = data.requiresSizeConfirmation !== false || /ADIDAS/i.test(data.product?.brand || '');
      delete item.ocrSize;
      const br = String(item.ocrText || '').match(/\bBR\s*0*(\d{2}(?:[.,]5)?)\b/i);
      if (br && normalizedSize(br[1]) === normalizedSize(data.product.size)) item.ocrSize = br[1];
      persist(draft);
      // A fast lookup may finish after this piece was safely queued and the
      // camera already advanced. Report its result without stealing focus from
      // a newer piece or claiming a pending size has been confirmed.
      if (item.pendingAutoContinuedAt && cameraAtRequest === cameraGeneration && $('action-camera') && !cameraRead) {
        const detail = requiresSizeInput(item) ? ' · confira o tamanho na lista' : ' · Tam. ' + item.product.size;
        window.ScannerCamera.feedback((requiresSizeInput(item) ? 'Confira: ' : '✓ ') + item.product.name + detail);
      }
      return true;
    } catch (error) {
      if (!current()) return false;
      delete item.product; delete item.requiresSizeConfirmation; delete item.ocrSize; item.error = error.message || 'Identificação interrompida. Tente novamente com esta mesma leitura.';
      persist(draft); return false;
    } finally { release(); inflight.delete(item.clientScanId); if (lookups.get(item.clientScanId) === job) lookups.delete(item.clientScanId); if (currentDraft === draft) { renderReadings(); refresh(); } } })();
    lookups.set(item.clientScanId, job);
    return job.promise;
  }
  async function scan(barcode, ocrText = '', options = {}) {
    if (storageFailed || (currentDraft && recoveryConflicts.has(currentDraft.sessionId))) { message('O lote ainda está sendo recuperado. Aguarde a conferência antes de continuar bipando.', true); return null; }
    if (isInventory() || !validContext() || busy || read(pendingKey, null)) { message('Escolha a ação, entre na sua conta e confira as lojas antes de bipar.', true); return null; }
    barcode = String(barcode || '').trim(); if (!/^\d{8}$|^\d{12,14}$/.test(barcode)) { message('Leia o código de barras numérico da etiqueta. A referência do modelo não substitui o código.', true); return null; }
    const draft = currentDraft;
    if (draft.scans.length >= 500) { message('Este lote chegou a 500 leituras, incluindo as retiradas. Confira e conclua ou comece outro lote; o histórico será preservado.', true); return null; }
    // Every intentional scan is one physical piece. The camera engine still
    // suppresses repeated frames; retryRead retains the existing scan identity.
    const duplicateConfirmed = true;
    const item = { clientScanId: crypto.randomUUID(), barcode, confirmedSize: '', duplicateConfirmed, ocrText: String(ocrText || '').trim().slice(0, 12000), createdAt: new Date().toISOString() };
    draft.scans.push(item); invalidate(); if (!persist(draft)) { renderReadings(); refresh(); return null; }
    renderReadings(); refresh();
    if (options.background === true) { void resolveRead(draft, item, ocrText); return item; }
    await resolveRead(draft, item, ocrText); return item;
  }
  function previewBody() {
    const c = context();
    return action === 'transfer' ? { sessionId: currentDraft.sessionId, fromStoreId: c.fromStoreId, toStoreId: c.toStoreId, scans: scansPayload() } : { sessionId: currentDraft.sessionId, storeId: c.toStoreId, scans: scansPayload() };
  }
  async function prepare() {
    if (!validContext() || busy || storageFailed || read(pendingKey, null)) return;
    if (!hasShipment()) { message('Os bipes estão salvos neste aparelho. Selecione a transferência para conferir o lote. Se ela ainda não apareceu, a loja de origem precisa confirmar o envio; depois toque em “Atualizar transferências”.', true); return; }
    const draft = currentDraft, gen = generation, selected = JSON.stringify(context());
    busy = true; invalidate(); refresh(); message('Atualizando a identificação das peças…');
    try {
      if (!await refreshIdentifications(true) || currentDraft !== draft || gen !== generation || selected !== JSON.stringify(context()) || read(pendingKey, null)) return;
      if (localPending()) { message('Ainda há leituras pendentes. Confira a informação indicada em cada peça.', true); return; }
      const snapshot = signature(), body = previewBody(), path = action === 'transfer' ? '/send-preview' : '/' + encodeURIComponent(context().transferId) + '/receive-preview';
      message('Conferindo o lote e o estoque…');
      const data = await api(path, body);
      if (snapshot !== signature() || gen !== generation || read(pendingKey, null)) { message('O contexto mudou. Confira novamente antes de confirmar.', true); return; }
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
      pending = { actorId: actor.id, mode: action, draftKey: currentDraft.key, sessionId: currentDraft.sessionId, sent: false, path: preview.path, body: { ...preview.body, requestId: crypto.randomUUID(), reviewToken: preview.data.reviewToken } };
      try { localStorage.setItem(pendingKey, JSON.stringify(pending)); } catch (_) { message('Não foi possível salvar a confirmação. Nenhuma movimentação foi enviada.', true); return; }
    }
    if (!pending || pending.actorId !== actor.id) { message('Entre com a mesma conta usada no envio pendente.', true); return; }
    busy = true; closeCamera(); refresh(); message('Confirmando a operação…');
    try {
      const draft = drafts.get(pending.draftKey) || read(draftKey(pending.draftKey), null);
      if (draft?.sessionId === pending.sessionId && draft.status !== 'confirmed') {
        queueSync(draft);
        if (!await flushSync(draft)) throw Error('Os bipes ainda precisam ser salvos no sistema antes de concluir a operação.');
      }
      if (pending.sent === false && draft && JSON.stringify(scansPayload(draft)) !== JSON.stringify(pending.body.scans)) {
        localStorage.removeItem(pendingKey); invalidate(); message('O lote recebeu alterações em outra sessão. Confira novamente todas as peças antes de confirmar.', true); return;
      }
      pending.sent = true; localStorage.setItem(pendingKey, JSON.stringify(pending));
      const data = await api(pending.path, pending.body), transfer = data.transfer;
      if (draft?.sessionId === pending.sessionId) {
        // Keep the confirmed snapshot intact: completed pieces are not removed.
        draft.status = 'confirmed'; draft.transferId = transfer.id;
        if (draft === currentDraft) { if (!startNewLot('confirmed')) throw Error('Operação confirmada no servidor, mas não foi possível preparar o próximo lote. Verifique o mesmo envio novamente.'); }
        else if (!persist(draft)) throw Error('Operação confirmada no servidor, mas o registro local não foi atualizado. Verifique o mesmo envio novamente.');
      }
      localStorage.removeItem(pendingKey); invalidate();
      $('action-result').hidden = false; $('action-result').textContent = pending.mode === 'transfer'
        ? 'Transferência #' + transfer.code + ' enviada. ' + transfer.qtyTotal + ' peça(s) aguardando conferência no destino.'
        : 'Transferência #' + transfer.code + ' recebida e conferida. ' + transfer.qtyTotal + ' peça(s) registradas na loja de destino.';
      message(data.alreadySaved ? 'Resultado recuperado. A mesma operação não foi repetida.' : 'Operação confirmada.');
      renderReadings(); if (action === 'receipt') await loadShipments(); void loadHistory(1);
      $('action-result').hidden = false;
    } catch (error) {
      if ([400, 403, 404, 409, 422].includes(error.status)) { localStorage.removeItem(pendingKey); invalidate(); message(error.message + ' Confira o lote novamente.', true); }
      else message((error.message || 'Conexão interrompida.') + ' Use “Verificar envio pendente”; o mesmo identificador será preservado.', true);
    } finally { busy = false; refresh(); }
  }
  function historyDate(value, withTime = false) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}) });
  }
  function todayBR() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = type => parts.find(item => item.type === type).value;
    return part('year') + '-' + part('month') + '-' + part('day');
  }
  function setupHistory() {
    const selected = $('action-history-store').value;
    setOptions($('action-history-store'), stores.filter(item => allowed.includes(item.id)).map(item => ({ id: item.id, label: storeName(item.id) })), 'Todas as lojas permitidas', selected);
    if (!$('action-history-from').value) { const today = todayBR(); $('action-history-from').value = today.slice(0, 7) + '-01'; $('action-history-to').value = today; }
    $('action-history-status').value ||= 'all';
    $('action-history-transfer').setAttribute('aria-pressed', String(historyMode === 'transfer'));
    $('action-history-receipt').setAttribute('aria-pressed', String(historyMode === 'receipt'));
  }
  function historyFilters() {
    return { mode: historyMode, storeId: $('action-history-store').value, from: $('action-history-from').value, to: $('action-history-to').value, status: $('action-history-status').value || 'all' };
  }
  function historyQuery(filters, page) { return '/history?' + new URLSearchParams({ ...filters, page: String(page), pageSize: '50' }).toString(); }
  function lotStatus(lot) { return lot.status === 'confirmed' ? lot.mode === 'receipt' ? 'Recebido' : 'Enviada' : lot.status === 'archived' ? 'Arquivado sem confirmação' : 'Em bipagem'; }
  function historyStore(item, fallback) { return item?.name ? item.name + (item.code ? ' (' + item.code + ')' : '') : fallback || '—'; }
  function lotDescription(lot) {
    return historyStore(lot.fromStore, lot.mode === 'receipt' ? 'Origem aguardando remessa' : '') + ' → ' + historyStore(lot.toStore);
  }
  function historyMessage(text, error = false) {
    $('action-history-message').textContent = text;
    $('action-history-message').className = 'transfer-message' + (error ? ' transfer-error' : '');
    $('action-history-message').hidden = !text;
  }
  function renderHistory(data) {
    historyData = data; const area = $('action-history-list'); area.replaceChildren();
    const totals = data.totals || {};
    $('action-history-summary').textContent = (totals.scans || 0) + ' peças bipadas no período · ' + (totals.lots || data.totalLots || 0) + ' lote(s) · ' + (totals.confirmedLots || 0) + (historyMode === 'receipt' ? ' recebimento(s) confirmado(s)' : ' envio(s) confirmado(s)') + ' · ' + (totals.confirmedScans || 0) + ' peças confirmadas';
    $('action-history-pending').textContent = (totals.recognized || 0) + ' identificadas · ' + (totals.pending || 0) + ' pendentes · ' + (totals.removed || 0) + ' leituras retiradas';
    if (!(data.lots || []).length) { const empty = document.createElement('p'); empty.textContent = 'Nenhum lote salvo neste histórico para o período e os filtros escolhidos.'; area.append(empty); }
    for (const lot of data.lots || []) {
      const card = document.createElement('article'); card.className = 'action-reading';
      const title = document.createElement('strong'); title.textContent = lotStatus(lot) + (lot.transferCode ? ' · #' + lot.transferCode : '') + ' · ' + lot.scanCount + ' peça(s) no período';
      const route = document.createElement('p'); route.textContent = lotDescription(lot);
      const operator = document.createElement('p'); operator.textContent = 'Operador: ' + (lot.operator?.name || 'Não informado');
      const dates = document.createElement('p'); dates.textContent = 'Bipes: ' + historyDate(lot.firstScannedAt, true) + ' a ' + historyDate(lot.lastScannedAt, true) + (lot.confirmedAt ? ' · Confirmado: ' + historyDate(lot.confirmedAt, true) : '');
      const counts = document.createElement('small'); counts.textContent = (lot.recognizedCount || 0) + ' identificadas · ' + (lot.pendingCount || 0) + ' pendentes · ' + (lot.removedCount || 0) + ' retiradas · Lote completo: ' + (lot.totalScanCount ?? lot.scanCount) + ' peças';
      const details = document.createElement('button'); details.type = 'button'; details.className = 'btn btn-secondary'; details.textContent = 'Ver cada bipe'; details.onclick = () => showHistoryDetail(lot.sessionId);
      card.append(title, route, operator, dates, counts, details); area.append(card);
    }
    const pages = Math.max(1, Number(data.totalPages) || 1);
    $('action-history-page').textContent = 'Página ' + historyPage + ' de ' + pages;
    $('action-history-previous').disabled = historyPage <= 1; $('action-history-next').disabled = historyPage >= pages;
    $('action-history-copy').disabled = !(data.totalLots || data.lots?.length);
  }
  async function loadHistory(page = 1) {
    const request = ++historyRequest, authToken = token, owner = actor?.id, filters = historyFilters(); historyPage = page;
    $('action-history-copy-text').value = ''; $('action-history-copy-text').hidden = true;
    $('action-history-detail').hidden = true; $('action-history-list').replaceChildren(); $('action-history-summary').textContent = ''; $('action-history-pending').textContent = '';
    $('action-history-copy').disabled = true; $('action-history-previous').disabled = true; $('action-history-next').disabled = true;
    if (!owner) { historyMessage('Entre com sua conta para consultar os históricos.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.from) || !/^\d{4}-\d{2}-\d{2}$/.test(filters.to) || filters.from > filters.to) { historyMessage('Escolha um período válido: a data inicial deve vir antes da final.', true); return; }
    historyBusy = true; historyMessage('Consultando ' + (filters.mode === 'receipt' ? 'recebimentos' : 'transferências') + '…');
    try {
      const data = await api(historyQuery(filters, page), undefined, authToken);
      if (request !== historyRequest || token !== authToken || actor?.id !== owner || JSON.stringify(filters) !== JSON.stringify(historyFilters())) return;
      renderHistory(data); historyMessage('');
    } catch (error) { if (request === historyRequest && token === authToken && actor?.id === owner) historyMessage(error.message, true); }
    finally { if (request === historyRequest) historyBusy = false; }
  }
  async function showHistoryDetail(sessionId) {
    const request = historyRequest, authToken = token, owner = actor?.id;
    historyMessage('Carregando cada bipe do lote…');
    try {
      const data = await api('/history/' + encodeURIComponent(sessionId), undefined, authToken);
      if (request !== historyRequest || token !== authToken || actor?.id !== owner) return;
      const area = $('action-history-detail-list'); area.replaceChildren();
      $('action-history-detail-title').textContent = lotStatus(data.lot) + ' · ' + lotDescription(data.lot);
      for (const [index, scan] of (data.scans || []).entries()) {
        const row = document.createElement('p'); row.className = 'action-history-scan';
        row.textContent = (index + 1) + '. ' + historyDate(scan.createdAt, true) + ' · ' + scan.barcode + ' · ' + (scan.product?.name || 'Produto pendente') + (scan.product?.size ? ' · Tam. ' + scan.product.size : '') + ' · ' + (scan.removed ? 'Retirada' : scan.recognized ? 'Identificada' : 'Pendente') + (scan.error ? ' · ' + scan.error : '');
        area.append(row);
      }
      $('action-history-detail-note').textContent = 'Detalhe completo do lote, inclusive leituras fora do período filtrado e retiradas. Códigos repetidos aparecem uma vez por bipe.';
      $('action-history-detail').hidden = false; historyMessage('');
    } catch (error) { if (request === historyRequest && token === authToken && actor?.id === owner) historyMessage(error.message, true); }
  }
  async function copyHistory() {
    if (!actor || historyBusy) return;
    const request = historyRequest, filters = historyFilters(), authToken = token, owner = actor.id;
    $('action-history-copy').disabled = true; historyMessage('Preparando a relação completa do período…');
    try {
      // One server snapshot avoids omissions or repeated lots when other stores
      // scan while an export is being prepared.
      const data = await api(historyQuery(filters, 1) + '&export=1', undefined, authToken);
      if (request !== historyRequest || token !== authToken || actor?.id !== owner || JSON.stringify(filters) !== JSON.stringify(historyFilters())) return;
      const lots = data.lots || [], totals = data.totals || {};
      const lines = ['*SPORTS & TENNIS — ' + (filters.mode === 'receipt' ? 'RECEBIMENTOS' : 'TRANSFERÊNCIAS') + '*', filters.from.split('-').reverse().join('/') + ' a ' + filters.to.split('-').reverse().join('/'), '', 'Peças bipadas: ' + (totals.scans || 0), 'Lotes: ' + (totals.lots || lots.length), (filters.mode === 'receipt' ? 'Recebimentos' : 'Envios') + ' confirmados: ' + (totals.confirmedLots || 0) + ' · Peças confirmadas: ' + (totals.confirmedScans || 0), 'Identificadas: ' + (totals.recognized || 0) + ' · Pendentes: ' + (totals.pending || 0) + ' · Retiradas: ' + (totals.removed || 0), ''];
      for (const [index, lot] of lots.entries()) lines.push((index + 1) + '. ' + lotStatus(lot) + (lot.transferCode ? ' #' + lot.transferCode : ''), lotDescription(lot), 'Operador: ' + (lot.operator?.name || 'Não informado'), 'Bipes: ' + historyDate(lot.firstScannedAt, true) + ' a ' + historyDate(lot.lastScannedAt, true), 'Peças no período: ' + lot.scanCount + ' · Pendentes: ' + (lot.pendingCount || 0), ...(lot.confirmedAt ? ['Confirmado: ' + historyDate(lot.confirmedAt, true)] : []), '');
      const text = lines.join('\n');
      $('action-history-copy-text').value = text; $('action-history-copy-text').hidden = false;
      try { await navigator.clipboard.writeText(text); historyMessage('Relação completa copiada. Pronta para colar no WhatsApp.'); }
      catch (_) { $('action-history-copy-text').focus(); $('action-history-copy-text').select(); historyMessage('Relação completa pronta no campo abaixo. Selecione e copie o texto.'); }
    } catch (error) { if (request === historyRequest && token === authToken && actor?.id === owner) historyMessage(error.message, true); }
    finally { if (request === historyRequest) $('action-history-copy').disabled = false; }
  }
  function closeCamera() {
    cameraGeneration++; cameraTimer?.stop(); cameraTimer = null; scanner?.stop(); scanner = null; window.ScannerAuto?.stopDecoder(); stream?.getTracks().forEach(track => track.stop()); stream = null; cameraRead = null; cameraRetry = null; cameraPendingRead = null; cameraOcrReads.clear(); $('action-camera')?.remove();
  }
  function frame() {
    return window.ScannerCamera.snapshot($('etiq-video'));
  }
  async function capture(reading) {
    if (cameraRead || !stream || storageFailed) return;
    const cameraId = cameraGeneration, attempt = ++cameraAttempt, draft = currentDraft, retry = cameraRetry, gen = generation, authToken = token;
    if (!reading.ean) { $('etiq-hint').textContent = 'Falta ler o código de barras. Aproxime a etiqueta inteira e mantenha parada.'; scanner?.reset(); return; }
    cameraRead = { working: true }; scanner?.stop();
    if (retry) cameraOcrReads.delete(retry.clientScanId);
    $('action-camera-size')?.remove(); $('action-camera-pending')?.remove();
    $('etiq-confirm').style.display = 'flex'; $('etiq-confirm-status').textContent = 'Identificando a peça…'; $('etiq-confirm-btn').disabled = true;
    $('etiq-confirm-det').textContent = 'Código lido: ' + reading.ean;
    // Start resolving the exact barcode immediately. Give very fast responses
    // a brief chance to show size confirmation before advancing; slow lookups
    // stay pending while the camera proceeds to the next physical piece.
    const item = retry ? await retryRead(draft, retry, reading.ean, reading.ocrText || '', cameraId) : await scan(reading.ean, reading.ocrText || '', { background: true });
    if (cameraId !== cameraGeneration || !$('action-camera')) return;
    if (storageFailed) { pauseCameraStorage(); return; }
    if (!item) {
      if (retry && !retry.removed && currentDraft === draft) showCameraRead(retry);
      else { cameraRead = null; $('etiq-confirm').style.display = 'none'; scanner?.reset({ afterCode: reading.ean }); updateCameraSummary(); }
      return;
    }
    cameraRetry = null;
    const needsOcr = !item.product || requiresSizeInput(item);
    // Let the exact EAN lookup decide whether OCR is needed. The scan is
    // already persisted and the camera can continue, so waiting here only
    // gates optional OCR work—not the next physical piece.
    const exactLookup = lookups.get(item.clientScanId)?.promise || Promise.resolve();
    if (!item.product) await new Promise(resolve => {
      let settled = false;
      const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
      const timer = setTimeout(finish, 100);
      exactLookup.then(finish, finish);
    });
    if (cameraId !== cameraGeneration || !$('action-camera')) return;
    const textPromise = reading.ocrText ? Promise.resolve(reading.ocrText) : needsOcr && reading.frame
      ? Promise.resolve(exactLookup).then(() => item.product && !requiresSizeInput(item) ? '' : window.ScannerOCR.recognize(reading.frame)).catch(() => '')
      : Promise.resolve('');
    const frameToken = {}, barcode = item.barcode, backgroundResolution = !item.product;
    cameraOcrReads.set(item.clientScanId, frameToken);
    showCameraRead(item);
    // Pending barcode reads continue automatically. Their own captured OCR may
    // still resolve in the background, without reopening or changing a later piece.
    const currentFrame = () => cameraId === cameraGeneration && gen === generation && token === authToken && currentDraft === draft && cameraOcrReads.get(item.clientScanId) === frameToken && item.barcode === barcode && !item.removed && activeReads(draft).includes(item) && !read(pendingKey, null) && !!$('action-camera');
    const sameRead = () => currentFrame() && attempt === cameraAttempt && cameraRead === item;
    void textPromise.then(async value => {
      const text = String(value || '').trim().slice(0, 12000);
      if (!text || !currentFrame() || (!sameRead() && !backgroundResolution) || text === item.ocrText) return;
      if (!item.product) {
        await resolveRead(draft, item, text);
        if (sameRead()) showCameraRead(item);
        else if (currentFrame()) { if (storageFailed) pauseCameraStorage(); else updateCameraSummary(); }
      } else {
        item.ocrText = text;
        const br = text.match(/\bBR\s*0*(\d{2}(?:[.,]5)?)\b/i);
        if (br && normalizedSize(br[1]) === normalizedSize(item.product.size)) item.ocrSize = br[1];
        if (!persist(draft)) { pauseCameraStorage(); return; }
        if (sameRead()) cameraDetails(item); // Do not replace a size the operator is typing.
        else updateCameraSummary();
      }
    }).catch(() => {});
  }
  function pauseCameraStorage() {
    scanner?.stop(); cameraRead = { working: true, storageError: true };
    $('etiq-confirm').style.display = 'flex'; $('etiq-confirm-status').textContent = 'Não foi possível guardar o lote';
    $('etiq-confirm-det').textContent = 'A leitura não foi salva. A câmera foi pausada para não perder peças. Feche a câmera e resolva o aviso do lote antes de continuar.';
    $('etiq-confirm-btn').disabled = true; $('etiq-confirm-btn').textContent = 'LEITURA PAUSADA';
    $('action-camera-size')?.remove(); $('action-camera-pending')?.remove();
  }
  function updateCameraSummary() {
    if (!$('action-camera')) return;
    const readings = activeReads(), pending = readings.filter(item => inflight.has(item.clientScanId) || !item.product || (requiresSizeInput(item) && (!item.confirmedSize || sizeConflict(item))));
    $('etiq-contador').textContent = 'Lote desta ação · ' + readings.length + ' peça(s)' + (pending.length ? ' · ' + pending.length + ' pendente(s)' : '');
    const notice = $('action-camera-notice'); if (!notice) return;
    const lastPending = cameraPendingRead && pending.includes(cameraPendingRead) && !cameraPendingRead.product ? cameraPendingRead : null;
    notice.hidden = !lastPending;
    if (lastPending) {
      $('action-camera-notice-text').textContent = 'Código ' + lastPending.barcode + ' guardado como pendente. Pode bipar a próxima peça.';
      $('action-camera-retry').disabled = !!cameraRead || !!cameraRetry || inflight.has(lastPending.clientScanId) || storageFailed;
    }
  }
  async function retryRead(draft, item, barcode, ocrText, cameraId) {
    barcode = String(barcode || '').trim();
    if (!/^\d{8}$|^\d{12,14}$/.test(barcode) || item.removed || !activeReads(draft).includes(item)) return null;
    const unchanged = () => cameraId === cameraGeneration && currentDraft === draft && validContext() && !item.removed;
    if (!unchanged()) return null;
    if (barcode !== item.barcode) {
      const correction = await window.ScannerConfirm.ask('CÓDIGO DIFERENTE NA NOVA LEITURA\n\nAnterior: ' + item.barcode + '\nLido agora: ' + barcode + '\n\nÉ a MESMA peça física, com o código anterior lido incorretamente? Confirmar corrige esta leitura, sem acrescentar outra peça. Se trocou a peça, cancele e continue bipando.');
      if (!correction || !unchanged()) return null;
      const duplicateConfirmed = true;
      (item.barcodeCorrections ||= []).push({ previous: item.barcode, barcode, correctedAt: new Date().toISOString() });
      item.barcode = barcode; item.duplicateConfirmed = duplicateConfirmed; item.confirmedSize = ''; delete item.product; delete item.requiresSizeConfirmation; delete item.ocrSize; item.ocrText = '';
      invalidate(); if (!persist(draft)) return null;
    }
    await resolveRead(draft, item, ocrText); return item;
  }
  function retryCameraRead(item) {
    if (!item || item.removed || !activeReads().includes(item) || inflight.has(item.clientScanId)) return;
    cameraOcrReads.delete(item.clientScanId);
    cameraRetry = item; cameraRead = null;
    $('action-camera-size')?.remove(); $('action-camera-pending')?.remove(); $('etiq-confirm').style.display = 'none';
    $('etiq-hint').textContent = 'Releia a etiqueta inteira da MESMA peça. Código anterior: ' + item.barcode + '. Esta tentativa não acrescenta outra peça.';
    scanner?.reset(); // No afterCode: this is the same physical piece, not the next one.
    updateCameraSummary();
  }
  function nextCameraRead(pending = false) {
    const item = cameraRead;
    if (!item || item.working || !item.barcode || (inflight.has(item.clientScanId) && pending !== 'automatic')) return;
    const previousAutoContinuedAt = item.pendingAutoContinuedAt;
    if (pending === true) {
      item.pendingAcknowledgedAt = new Date().toISOString();
      message('Leitura ' + item.barcode + ' mantida como pendente. O lote só poderá ser confirmado depois de identificar o produto e conferir o tamanho.', true);
    } else if (pending === 'automatic') {
      item.pendingAutoContinuedAt = new Date().toISOString();
      cameraPendingRead = item;
    }
    if (!persist()) {
      item.pendingAutoContinuedAt = previousAutoContinuedAt;
      if (cameraPendingRead === item) cameraPendingRead = null;
      pauseCameraStorage(); return;
    }
    invalidate(); cameraRead = null; cameraRetry = null; $('action-camera-size')?.remove(); $('action-camera-pending')?.remove(); $('etiq-confirm').style.display = 'none';
    renderReadings(); refresh(); updateCameraSummary();
    scanner?.reset({ afterCode: item.barcode });
  }
  function showCameraRead(item) {
    $('action-camera-size')?.remove(); $('action-camera-pending')?.remove(); cameraRead = item;
    if (!item.product) { nextCameraRead('automatic'); return; }
    if (!requiresSizeInput(item)) {
      nextCameraRead();
      if (!storageFailed && !cameraRead) window.ScannerCamera.feedback('✓ ' + item.product.name + ' · Tam. ' + item.product.size);
      return;
    }
    $('etiq-confirm').style.display = 'flex';
    cameraDetails(item);
    const needsSize = item.product && requiresSizeInput(item);
    const size = document.createElement('input'); size.id = 'action-camera-size'; size.type = 'text'; size.maxLength = 20; size.placeholder = /ADIDAS/i.test(item.product?.brand) ? 'Digite o BR desta caixa' : 'Digite o tamanho da etiqueta'; size.value = item.ocrSize || ''; size.setAttribute('aria-label', size.placeholder); size.style.cssText = 'display:block;min-height:48px;width:100%;max-width:320px;padding:10px;font-size:20px;margin:8px auto;color:#111;background:white;border-radius:8px';
    if (needsSize) $('etiq-confirm-det').after(size);
    const button = $('etiq-confirm-btn'); button.textContent = item.product ? needsSize ? 'TAMANHO CONFERIDO — PRÓXIMA PEÇA' : 'PRÓXIMA PEÇA' : 'RELER A MESMA PEÇA'; button.disabled = !item.product || (needsSize && normalizedSize(size.value) !== normalizedSize(item.product.size)); button.style.background = item.product ? '#167541' : '#925400';
    size.addEventListener('input', () => { button.disabled = !size.value.trim() || normalizedSize(size.value) !== normalizedSize(item.product?.size); });
    if (!item.product) button.disabled = false;
    if (!item.product || needsSize) {
      const pending = document.createElement('button'); pending.id = 'action-camera-pending'; pending.type = 'button'; pending.dataset.click = 'next-pending'; pending.textContent = 'PRÓXIMA PEÇA — MANTER PENDENTE'; pending.style.cssText = 'width:100%;max-width:340px;min-height:48px;margin-top:12px;padding:10px;font-size:15px;font-weight:800;color:white;background:#555;border:1px solid #aaa;border-radius:12px'; button.after(pending);
    }
    updateCameraSummary();
  }
  function cameraDetails(item) {
    $('etiq-confirm-status').textContent = item.product ? requiresSizeInput(item) ? 'Confira o tamanho na etiqueta' : 'Peça identificada' : 'Peça ainda não identificada';
    $('etiq-confirm-det').textContent = 'Código lido: ' + item.barcode + ' · ' + (item.product ? item.product.name + ' · Cadastro: ' + item.product.size : (item.error || 'Identificação pendente. Releia a etiqueta inteira desta peça.'));
    $('etiq-confirm-det').style.setProperty('display', 'block', 'important');
    if (item.product && requiresSizeInput(item) && item.ocrSize) $('etiq-confirm-det').textContent += ' · OCR sugeriu BR ' + item.ocrSize + '; confira na caixa.';
  }
  async function openCamera(retryItem = null) {
    if (currentDraft && recoveryConflicts.has(currentDraft.sessionId)) { message('O lote está sendo conferido no histórico sincronizado. Aguarde antes de continuar bipando.', true); return; }
    // Retry persistence on the next scan attempt. A transient full-storage
    // condition must not leave the scanner permanently disabled after the
    // operator closes the camera or removes an old acknowledged copy.
    if (storageFailed && currentDraft && persist(currentDraft)) refresh();
    if (!validContext() || busy || storageFailed || read(pendingKey, null)) { message(storageFailed ? 'O lote ainda não foi salvo. Resolva o aviso antes de continuar bipando.' : 'Selecione o contexto desta ação antes de abrir a câmera.', true); return; }
    if (retryItem && (!activeReads().includes(retryItem) || inflight.has(retryItem.clientScanId))) return;
    window.fecharScanner?.(); closeCamera(); const cameraId = cameraGeneration;
    const overlay = document.createElement('div'); overlay.id = 'action-camera'; overlay.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99998;display:flex;flex-direction:column'; overlay.innerHTML = window.ScannerView.markup(); document.body.append(overlay);
    const notice = document.createElement('div'); notice.id = 'action-camera-notice'; notice.hidden = true; notice.setAttribute('role', 'status'); notice.style.cssText = 'position:absolute;top:48px;left:12px;right:12px;padding:8px 10px;border-radius:8px;background:rgba(45,34,3,.9);color:#ffe29a;font-size:12px;line-height:1.35;z-index:1';
    const noticeText = document.createElement('span'); noticeText.id = 'action-camera-notice-text';
    const noticeRetry = document.createElement('button'); noticeRetry.id = 'action-camera-retry'; noticeRetry.type = 'button'; noticeRetry.dataset.click = 'retry-pending'; noticeRetry.textContent = 'Reler última pendente'; noticeRetry.style.cssText = 'margin-left:8px;padding:6px;border:1px solid #ffe29a;border-radius:6px;background:transparent;color:inherit;font-size:12px';
    notice.append(noticeText, noticeRetry); $('etiq-hint').after(notice);
    overlay.addEventListener('click', async event => {
      event.stopPropagation(); const command = event.target.closest('[data-click]')?.dataset.click;
      if (command === 'close') return closeCamera();
      if (command === 'retry-pending') { if (!cameraRead && !cameraRetry && !storageFailed && cameraPendingRead && !cameraPendingRead.product) retryCameraRead(cameraPendingRead); return; }
      if (command === 'capture') {
        if (cameraRead && !cameraRead.working && !cameraRead.product) retryCameraRead(cameraRead);
        if (!cameraRead) { const captured = frame(); if (captured) { const ean = await window.ScannerAuto.decodeInWorker(captured); if (cameraId === cameraGeneration && $('action-camera')) await capture({ ean: typeof ean === 'string' ? ean : ean?.text || '', frame: captured }); } }
        return;
      }
      if (command === 'next-pending') return nextCameraRead(true);
      if (command !== 'next' || !cameraRead || cameraRead.working) return;
      if (!cameraRead.product) { retryCameraRead(cameraRead); return; }
      if (requiresSizeInput(cameraRead)) {
        const size = $('action-camera-size')?.value.trim() || ''; if (!size || normalizedSize(size) !== normalizedSize(cameraRead.product.size)) return;
        cameraRead.confirmedSize = size;
      }
      nextCameraRead();
    });
    try {
      window.ScannerCamera.warmup();
      const opened = await navigator.mediaDevices.getUserMedia(window.ScannerCamera.constraints);
      if (cameraId !== cameraGeneration) { opened.getTracks().forEach(track => track.stop()); return; }
      stream = opened; $('etiq-video').srcObject = stream; await $('etiq-video').play();
      if (cameraId !== cameraGeneration || !$('action-camera')) { opened.getTracks().forEach(track => track.stop()); return; }
      void window.ScannerCamera.tune(stream);
      $('etiq-contador').textContent = 'Lote desta ação · ' + activeReads().length + ' peça(s)'; $('etiq-lista').textContent = 'O estoque só muda depois da conferência e confirmação do lote.';
      scanner = window.ScannerAuto.create({ snapshot: frame, decode: canvas => window.ScannerAuto.decodeInWorker(canvas), recognize: canvas => window.ScannerOCR.recognize(canvas), recognizeMissing: false, canRead: () => !!stream && !cameraRead && !storageFailed && cameraId === cameraGeneration, onHint: text => { if ($('action-camera')) $('etiq-hint').textContent = text; }, onCapture: capture });
      if (retryItem) retryCameraRead(retryItem);
      updateCameraSummary();
      cameraTimer = window.ScannerCamera.start($('etiq-video'), scanner);
    } catch (error) { closeCamera(); message('Não foi possível abrir a câmera: ' + error.message, true); }
  }
  function storesReady() {
    if (!settings.stores.inventory) settings.stores.inventory = $('loja').value || '';
    if (!isInventory()) $('loja').value = settings.stores[action] || '';
    saveSettings(); contextChanged(); if (token && !actor) authenticate();
  }
  function storeChanged() { settings.stores[action] = $('loja').value; saveSettings(); contextChanged(); if (action === 'receipt') loadShipments(); }
  $('bipar-action').addEventListener('change', () => {
    if (busy) { $('bipar-action').value = action; return; }
    settings.stores[action] = $('loja').value; window.fecharScanner?.(); $('manual-overlay')?.remove(); $('size-overlay')?.remove();
    action = $('bipar-action').value; settings.mode = action;
    if (!isInventory()) { historyMode = action; setupHistory(); if (actor) void loadHistory(1); }
    $('loja').value = settings.stores[action] || (isInventory() ? localStorage.getItem('sports_tennis_bipar_loja') || '' : '');
    if (action === 'transfer' && !settings.origin && allowed.includes(settings.stores.inventory)) { settings.origin = settings.stores.inventory; $('action-origin').value = settings.origin; }
    saveSettings(); contextChanged();
    if (isInventory()) { if (typeof carregarLojas === 'function') carregarLojas(); }
    else if (!actor && token) authenticate(); else if (action === 'receipt') loadShipments();
  });
  $('action-origin').addEventListener('change', () => { settings.origin = $('action-origin').value; saveSettings(); contextChanged(); });
  $('action-shipment').addEventListener('change', () => { settings.shipment = $('action-shipment').value; saveSettings(); contextChanged(); });
  $('action-refresh-shipments').onclick = loadShipments; $('action-preview').onclick = prepare; $('action-approved').onchange = refresh; $('action-confirm').onclick = () => confirmAction(); $('action-retry').onclick = () => confirmAction(true);
  $('action-clear').onclick = () => { if (busy || read(pendingKey, null) || inflight.size) return; if (!confirm('Começar outro lote? Este ficará arquivado no histórico, com todas as leituras preservadas. Nenhum estoque será alterado.')) return; if (startNewLot()) void loadHistory(1); };
  $('action-sync-retry').onclick = async () => { if (!actor && expiredActor) await resumeAuthentication(); recoverDrafts(); for (const job of syncJobs.values()) if (canSyncDraft(job.draft)) void flushSync(job.draft); };
  $('action-history-transfer').onclick = () => { historyMode = 'transfer'; setupHistory(); void loadHistory(1); };
  $('action-history-receipt').onclick = () => { historyMode = 'receipt'; setupHistory(); void loadHistory(1); };
  $('action-history-refresh').onclick = () => loadHistory(1);
  $('action-history-month').onclick = () => { const today = todayBR(); $('action-history-from').value = today.slice(0, 7) + '-01'; $('action-history-to').value = today; return loadHistory(1); };
  $('action-history-previous').onclick = () => loadHistory(Math.max(1, historyPage - 1));
  $('action-history-next').onclick = () => loadHistory(historyPage + 1);
  $('action-history-copy').onclick = copyHistory;
  $('action-history-close-detail').onclick = () => { $('action-history-detail').hidden = true; };
  for (const id of ['action-history-store', 'action-history-status', 'action-history-from', 'action-history-to']) $(id).addEventListener('change', () => { $('action-history-copy-text').hidden = true; void loadHistory(1); });
  $('action-storage-retry').onclick = () => { if (persist()) message('Lote salvo neste aparelho.'); refresh(); };
  $('action-switch-user').onclick = () => { if (busy) return; actor = null; expiredActor = null; clearTimeout(authenticationRecoveryTimer); token = ''; historyRequest++; historyData = null; $('action-history-list').replaceChildren(); $('action-history-detail').hidden = true; $('action-history-copy-text').value = ''; $('action-history-copy-text').hidden = true; $('action-history-summary').textContent = ''; $('action-history-pending').textContent = ''; historyMessage('Entre com sua conta para consultar os históricos.'); sessionStorage.removeItem('tc_transfer_token'); contextChanged(); refresh(); $('action-identity').focus(); };
  $('action-login').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; busy = true; $('action-login-button').disabled = true;
    try { const identity = $('action-identity').value.trim(); const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...(identity.includes('@') ? { email: identity } : { phone: identity.replace(/\D/g, '') }), password: $('action-password').value }) }); const data = await response.json(); if (!response.ok) throw Error(data.error || 'Não foi possível entrar.'); token = data.token; $('action-password').value = ''; await authenticate({ allowFallback: false }); }
    catch (error) { message(error.message, true); }
    finally { busy = false; $('action-login-button').disabled = false; refresh(); refreshLegacyReads(); }
  });
  document.addEventListener('pointerdown', event => { interaction = !!event.target.closest('#action-setup,#action-workspace,#action-camera,#action-history'); });
  document.addEventListener('focusin', event => { if (event.target !== document.body) interaction = !!event.target.closest('#action-setup,#action-workspace,#action-camera,#action-history'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) closeCamera(); else { if (!actor && expiredActor) void resumeAuthentication(); refreshLegacyReads(); recoverDrafts(); } });
  window.addEventListener('online', () => { if (!actor && expiredActor) void resumeAuthentication(); else recoverDrafts(); });
  window.addEventListener('storage', event => {
    if (['loja_token', 'tc_token', 'tc_admin_token'].includes(event.key) && !actor && expiredActor) void resumeAuthentication();
    if (event.key === pendingKey) refresh();
    if (currentDraft && event.key === draftKey(currentDraft.key) && !busy) {
      const incoming = read(event.key, null);
      if (incoming?.sessionId === currentDraft.sessionId) {
        const ownIds = new Set(currentDraft.scans.map(item => item.clientScanId));
        const foreignIds = new Set((incoming.scans || []).map(item => item.clientScanId));
        if (currentDraft.scans.some(item => !foreignIds.has(item.clientScanId)) || incoming.scans.some(item => !ownIds.has(item.clientScanId))) persist(currentDraft);
        else if (!inflight.size && Number(incoming.revision || 0) > Number(currentDraft.revision || 0)) { drafts.delete(currentDraft.key); currentDraft = getDraft(); queueSync(currentDraft); }
      } else if (incoming && !inflight.size) { drafts.delete(currentDraft.key); currentDraft = getDraft(); }
      invalidate(); renderReadings(); refresh(); refreshLegacyReads();
    }
  });
  window.BiparActions = { mode: () => action, version: () => generation, isInventory, refresh, scan, openCamera, closeCamera, storesReady, storeChanged, recoveryInventory: () => canRecoverOthers() ? legacyRecoveryInventory.map(item => ({ ...item })) : [], hasFocus: () => interaction };
  refresh();
})();
