(function (root) {
  'use strict';
  const LEGACY = 'tc_bipe_photo_checkpoint_v1:';
  const FALLBACK = 'tc_bipe_photo_event_v2:';
  const copy = value => JSON.parse(JSON.stringify(value));
  const identity = item => item.clientScanId ? 'id:' + (item.roundId || '') + ':' + item.clientScanId : item.lid ? 'lid:' + item.lid : 'legacy:' + JSON.stringify(item);
  const uuid = () => root.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const request = operation => new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error || Error('Falha ao ler armazenamento de fotos')); });
  const signature = text => {
    let a = 2166136261, b = 2246822507;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 3266489909); }
    return (a >>> 0).toString(16) + '-' + (b >>> 0).toString(16) + '-' + text.length;
  };
  const completed = (transaction, timeoutMs) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { transaction.abort(); } catch (_) {} reject(Error('O armazenamento de fotos não respondeu. Tente novamente.')); }, timeoutMs);
    transaction.oncomplete = () => { clearTimeout(timer); resolve(); };
    transaction.onabort = transaction.onerror = () => { clearTimeout(timer); reject(transaction.error || Error('Falha ao salvar foto')); };
  });

  function create(options = {}) {
    // Separate action photos from inventory queues while reusing durable storage.
    const namespace = options.namespace ? String(options.namespace).replace(/[^a-z0-9-]/gi, '') : '';
    const queueKey = namespace ? 'tc_' + namespace + '_photo_queue_v1' : 'etiqFila';
    const legacyPrefix = namespace ? 'tc_' + namespace + '_photo_checkpoint_v1:' : LEGACY;
    const fallbackPrefix = namespace ? 'tc_' + namespace + '_photo_event_v2:' : FALLBACK;
    const databaseName = namespace ? 'teniscash-' + namespace + '-photos' : 'teniscash-scanner-photos';
    const storage = options.localStorage || root.localStorage;
    const indexed = options.indexedDB === undefined ? root.indexedDB : options.indexedDB;
    const timeoutMs = options.timeoutMs || 15000;
    const refs = new Map();
    let database, opened, migration = Promise.resolve(), observedClock = 0;
    // Unsupported IDB has a single-copy localStorage fallback. If IDB exists but
    // fails/quota is exhausted, do not silently split newer data across backends.
    const fallback = !indexed;
    const storageHealth = { backend: fallback ? 'localStorage' : 'IndexedDB', persisted: null, persistenceSupported: false, usage: null, quota: null, persistenceRequested: false };

    async function status(options = {}) {
      const manager = root.navigator?.storage;
      storageHealth.persistenceSupported = typeof manager?.persisted === 'function';
      // Request from the explicit camera-opening gesture. A denial is not a
      // failed photograph, and a grant never guarantees immunity from deletion.
      if (options.requestPersistence && !storageHealth.persistenceRequested && typeof manager?.persist === 'function') {
        storageHealth.persistenceRequested = true;
        try { storageHealth.persisted = !!(await manager.persist()); } catch (_) { storageHealth.persisted = null; }
      }
      if (storageHealth.persistenceSupported) {
        try { storageHealth.persisted = !!(await manager.persisted()); } catch (_) { storageHealth.persisted = null; }
      }
      if (typeof manager?.estimate === 'function') {
        try {
          const estimate = await manager.estimate();
          storageHealth.usage = Number.isFinite(estimate.usage) ? estimate.usage : null;
          storageHealth.quota = Number.isFinite(estimate.quota) ? estimate.quota : null;
        } catch (_) { /* Quota estimates are optional, not proof of a write. */ }
      }
      return { ...storageHealth };
    }

    function explainError(error) {
      if (error?.name === 'QuotaExceededError') return 'Sem espaço disponível para salvar esta leitura no navegador. Não limpe os dados deste site: as fotos anteriores ainda podem aguardar envio.';
      if (error?.name === 'SecurityError' || error?.name === 'NotAllowedError') return 'O navegador não permitiu guardar a leitura neste aparelho.';
      return error?.message || 'Não foi possível confirmar a gravação da leitura neste aparelho.';
    }

    function forgetConnection(connection) {
      // A delayed close/versionchange from an old connection must not discard
      // the replacement that another retry has already opened.
      if (database !== connection) return;
      database = null; opened = null;
    }

    async function open() {
      if (fallback) return null;
      if (database) return database;
      if (!opened) {
        const pending = new Promise((resolve, reject) => {
          const op = indexed.open(databaseName, 1);
          let expired = false;
          const timer = setTimeout(() => { expired = true; reject(Error('O armazenamento de fotos não respondeu. Tente novamente.')); }, timeoutMs);
          op.onupgradeneeded = () => {
            const db = op.result;
            if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'ref' });
            if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'key' });
          };
          op.onsuccess = () => {
            clearTimeout(timer);
            if (expired) { op.result.close(); return; }
            const connection = op.result;
            database = connection;
            connection.onclose = () => forgetConnection(connection);
            connection.onversionchange = () => { forgetConnection(connection); connection.close(); };
            resolve(connection);
          };
          op.onerror = () => { clearTimeout(timer); expired = true; reject(op.error || Error('Não foi possível abrir o armazenamento de fotos')); };
          op.onblocked = () => { clearTimeout(timer); expired = true; reject(Error('Armazenamento de fotos ocupado por outra versão da página')); };
        });
        opened = pending;
        pending.catch(() => { if (opened === pending) opened = null; });
      }
      return opened;
    }

    async function beginTransaction(stores, mode) {
      const connection = await open();
      const start = db => {
        if (mode !== 'readwrite') return db.transaction(stores, mode);
        try { return db.transaction(stores, mode, { durability: 'strict' }); }
        catch (error) {
          // Older WebKit may not accept the durability option. Its normal
          // transaction still must complete and pass the independent readback.
          if (error?.name !== 'TypeError') throw error;
          return db.transaction(stores, mode);
        }
      };
      try { return start(connection); }
      catch (error) {
        if (error?.name !== 'InvalidStateError') throw error;
        // Some browsers expose a closed connection before dispatching close.
        // Retry only transaction creation: no writes have started at this point.
        forgetConnection(connection);
        try { connection.close(); } catch (_) {}
        return start(await open());
      }
    }

    function isMirror(row) {
      if (!row?._photoStorageMirror) return false;
      const value = { ...row }; delete value._photoStorageMirror;
      return signature(JSON.stringify(value)) === row._photoStorageMirror;
    }

    function writeMirror(rows) {
      try {
        const raw = storage.getItem(queueKey), existing = JSON.parse(raw || '[]');
        // Never replace an older tab's not-yet-migrated photograph or delta.
        if (!Array.isArray(existing) || existing.some(row => !isMirror(row))) return;
        const thin = rows.map(row => {
          const item = { ...row }; delete item.b64; delete item._photoStorageMirror;
          item._photoStorageMirror = signature(JSON.stringify(item)); return item;
        });
        if (storage.getItem(queueKey) === raw) storage.setItem(queueKey, JSON.stringify(thin));
      } catch (_) { /* The authoritative transaction is already committed. */ }
    }

    function legacySources() {
      const sources = [], keys = [];
      observedClock = Math.max(observedClock + 0.001, root.performance?.timeOrigin && root.performance?.now ? root.performance.timeOrigin + root.performance.now() : Date.now());
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key === queueKey || key?.startsWith(legacyPrefix) || key?.startsWith(fallbackPrefix)) keys.push(key); }
      for (const key of keys) {
        const raw = storage.getItem(key); if (!raw) continue;
        let value; try { value = JSON.parse(raw); } catch (_) { continue; }
        if (key === queueKey) {
          if (Array.isArray(value)) sources.push({ key, raw, events: value.filter(fields => !isMirror(fields)).map((fields, index) => ({ identity: identity(fields), at: observedClock, base: true, index, fields })) });
        } else if (value?.identity && value.fields && typeof value.fields === 'object') sources.push({ key, raw, events: [value] });
      }
      return sources;
    }

    async function fingerprint(text) {
      if (root.crypto?.subtle && root.TextEncoder) {
        const digest = await root.crypto.subtle.digest('SHA-256', new root.TextEncoder().encode(text));
        return 'sha256:' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
      }
      return 'hash:' + signature(text);
    }

    async function photoRef(b64) {
      if (root.crypto?.subtle && root.TextEncoder) return fingerprint(b64);
      if (refs.has(b64)) return refs.get(b64);
      // Reusing the same immutable photo reference makes retrying a transaction
      // idempotent. Different recaptures retain their own original image.
      const ref = 'photo:' + uuid();
      refs.set(b64, ref); return ref;
    }

    async function prepare(fields) {
      const result = copy(fields), images = [];
      if (typeof result.b64 === 'string' && result.b64) {
        result.photoRef = await photoRef(result.b64);
        images.push({ ref: result.photoRef, b64: result.b64 });
        delete result.b64;
      } else if ('b64' in result) {
        // Clearing an in-memory preview never destroys its saved original.
        delete result.b64;
      }
      return { fields: result, images };
    }

    async function migrateOnce() {
      if (fallback) return;
      await open();
      for (const source of legacySources()) {
        const prepared = [];
        if (!source.events.length) continue;
        const sourceRef = await fingerprint(source.key + '\0' + source.raw);
        for (const event of source.events) {
          const data = await prepare(event.fields);
          delete data.fields._photoStorageMirror;
          prepared.push({ event: { ...event, key: 'migrated:' + source.key + ':' + sourceRef + ':' + (event.index || 0), fields: data.fields }, images: data.images });
        }
        if (!prepared.length) continue;
        const tx = await beginTransaction(['events', 'photos'], 'readwrite'), done = completed(tx, timeoutMs);
        for (const data of prepared) {
          for (const image of data.images) tx.objectStore('photos').put(image);
          const existing = tx.objectStore('events').get(data.event.key);
          existing.onsuccess = () => {
            // The exact same legacy snapshot imported twice keeps its original
            // observation order, including retries and competing browser tabs.
            if (!existing.result) tx.objectStore('events').put(data.event);
          };
        }
        await done;
        // An old tab may have appended data while the IDB transaction committed.
        // Only the exact source snapshot that was committed can be removed.
        if (storage.getItem(source.key) === source.raw) storage.removeItem(source.key);
      }
    }

    function migrateLegacy() {
      const next = migration.catch(() => {}).then(migrateOnce); migration = next; return next;
    }

    function merge(events) {
      const rows = new Map();
      events.sort((a, b) => Number(!a.base) - Number(!b.base) || (Number(a.at) || 0) - (Number(b.at) || 0) || String(a.key || '').localeCompare(String(b.key || '')));
      for (const event of events) {
        const row = rows.get(event.identity) || {};
        const currentRevision = Number(row.photoRevision || 0);
        const eventRevision = event.fields.photoRevision == null ? currentRevision : Number(event.fields.photoRevision || 0);
        // A stale tab cannot undo confirmation even if it holds an older image.
        // All originals remain in the immutable image store and event history.
        // Old unversioned deltas cannot prove which image they describe after
        // a recapture. Preserve the event, but recheck that revision remotely.
        if (currentRevision > 1 && event.fields.photoRevision == null) continue;
        if (eventRevision < currentRevision) continue;
        if (eventRevision === currentRevision && row.complete && row.capId && !event.fields.complete && event.fields.st === 'fila') continue;
        if (row.st === 'revisao' && row.msg === 'Repetição cancelada — não contada' && event.fields.st === 'fila') continue;
        Object.assign(row, event.fields); rows.set(event.identity, row);
      }
      return [...rows.values()];
    }

    async function read(options = {}) {
      const filter = options.filter || (() => true);
      if (fallback) return merge(legacySources().flatMap(source => source.events.map(event => ({ ...event, key: source.key })))).filter(filter);
      await migrateLegacy();
      const tx = await beginTransaction('events', 'readonly'), done = completed(tx, timeoutMs);
      const [events] = await Promise.all([request(tx.objectStore('events').getAll()), done]);
      const merged = merge(events).filter(filter);
      if (options.includeImages === false) { writeMirror(merged); return merged; }
      const needed = [...new Set(merged.map(row => row.photoRef).filter(Boolean))];
      // Retain every original on disk without loading superseded recaptures
      // into RAM on each queue poll. Only the current row images are hydrated.
      let images = [];
      if (needed.length) {
        const photosTx = await beginTransaction('photos', 'readonly'), photosDone = completed(photosTx, timeoutMs);
        [images] = await Promise.all([Promise.all(needed.map(ref => request(photosTx.objectStore('photos').get(ref)))), photosDone]);
      }
      images = images.filter(Boolean);
      const photos = new Map(images.map(image => [image.ref, image.b64]));
      const rows = merged.map(row => {
        if (row.photoRef) {
          if (!photos.has(row.photoRef)) throw Error('Uma foto salva não foi encontrada; o lote foi preservado para recuperação');
          row.b64 = photos.get(row.photoRef);
        }
        return row;
      });
      writeMirror(rows); return rows;
    }

    async function readPhoto(ref) {
      if (!ref || fallback) throw Error('Foto local indisponível para esta referência');
      const tx = await beginTransaction('photos', 'readonly'), done = completed(tx, timeoutMs);
      const [photo] = await Promise.all([request(tx.objectStore('photos').get(ref)), done]);
      if (!photo?.b64) throw Error('Uma foto salva não foi encontrada; a leitura foi preservada para recuperação');
      return photo.b64;
    }

    async function append(id, fields) {
      if (fallback) {
        // The image exists only in this delta, never duplicated in an aggregate.
        let at = Date.now();
        for (const source of legacySources()) for (const event of source.events) at = Math.max(at, (Number(event.at) || 0) + 1);
        const event = { key: fallbackPrefix + uuid(), identity: id, at, fields: copy(fields) };
        const serialized = JSON.stringify(event);
        storage.setItem(event.key, serialized);
        if (storage.getItem(event.key) !== serialized) throw Error('A releitura da foto e do código não confirmou a gravação. A peça continua aguardando salvamento.');
        return copy(fields);
      }
      const prepared = await prepare(fields);
      const tx = await beginTransaction(['events', 'photos'], 'readwrite'), done = completed(tx, timeoutMs);
      const eventKey = 'delta:' + uuid();
      // All writers of this store serialize at the transaction boundary. Choose
      // a monotonic event clock inside that transaction, including other tabs.
      const op = tx.objectStore('events').getAll();
      op.onsuccess = () => {
        let at = Date.now(); for (const event of op.result) at = Math.max(at, (Number(event.at) || 0) + 1);
        for (const image of prepared.images) tx.objectStore('photos').put(image);
        tx.objectStore('events').put({ key: eventKey, identity: id, at, fields: prepared.fields });
      };
      await done;
      // Commit acknowledgement alone is not our UI receipt. Read the exact
      // delta and original back in a new transaction before enabling Next.
      const check = await beginTransaction(['events', 'photos'], 'readonly'), checked = completed(check, timeoutMs);
      const [event, photo] = await Promise.all([
        request(check.objectStore('events').get(eventKey)),
        prepared.fields.photoRef ? request(check.objectStore('photos').get(prepared.fields.photoRef)) : Promise.resolve(null),
        checked,
      ]);
      if (event?.identity !== id || JSON.stringify(event.fields) !== JSON.stringify(prepared.fields) ||
          (prepared.fields.photoRef && (!photo?.b64 || (fields.b64 && photo.b64 !== fields.b64)))) {
        throw Error('A releitura da foto e do código não confirmou a gravação. A peça continua aguardando salvamento.');
      }
      return { ...copy(fields), ...(prepared.fields.photoRef ? { photoRef: prepared.fields.photoRef } : {}) };
    }

    return { read, readPhoto, append, migrateLegacy, identity, status, explainError, backend: fallback ? 'localStorage' : 'IndexedDB' };
  }
  root.ScannerPhotoStorage = { create, identity };
})(typeof window !== 'undefined' ? window : globalThis);
