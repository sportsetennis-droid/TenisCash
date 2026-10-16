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
    const storage = options.localStorage || root.localStorage;
    const indexed = options.indexedDB === undefined ? root.indexedDB : options.indexedDB;
    const timeoutMs = options.timeoutMs || 15000;
    const refs = new Map();
    let database, opened, migration = Promise.resolve(), observedClock = 0;
    // Unsupported IDB has a single-copy localStorage fallback. If IDB exists but
    // fails/quota is exhausted, do not silently split newer data across backends.
    const fallback = !indexed;

    async function open() {
      if (fallback) return null;
      if (database) return database;
      if (!opened) opened = new Promise((resolve, reject) => {
        const op = indexed.open('teniscash-scanner-photos', 1);
        let expired = false;
        const timer = setTimeout(() => { expired = true; opened = null; reject(Error('O armazenamento de fotos não respondeu. Tente novamente.')); }, timeoutMs);
        op.onupgradeneeded = () => {
          const db = op.result;
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'ref' });
          if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'key' });
        };
        op.onsuccess = () => {
          clearTimeout(timer);
          if (expired) { op.result.close(); return; }
          database = op.result;
          database.onversionchange = () => { database.close(); database = null; opened = null; };
          resolve(database);
        };
        op.onerror = () => { clearTimeout(timer); opened = null; reject(op.error || Error('Não foi possível abrir o armazenamento de fotos')); };
        op.onblocked = () => { clearTimeout(timer); expired = true; opened = null; reject(Error('Armazenamento de fotos ocupado por outra versão da página')); };
      });
      return opened;
    }

    function isMirror(row) {
      if (!row?._photoStorageMirror) return false;
      const value = { ...row }; delete value._photoStorageMirror;
      return signature(JSON.stringify(value)) === row._photoStorageMirror;
    }

    function writeMirror(rows) {
      try {
        const raw = storage.getItem('etiqFila'), existing = JSON.parse(raw || '[]');
        // Never replace an older tab's not-yet-migrated photograph or delta.
        if (!Array.isArray(existing) || existing.some(row => !isMirror(row))) return;
        const thin = rows.map(row => {
          const item = { ...row }; delete item.b64; delete item._photoStorageMirror;
          item._photoStorageMirror = signature(JSON.stringify(item)); return item;
        });
        if (storage.getItem('etiqFila') === raw) storage.setItem('etiqFila', JSON.stringify(thin));
      } catch (_) { /* The authoritative transaction is already committed. */ }
    }

    function legacySources() {
      const sources = [], keys = [];
      observedClock = Math.max(observedClock + 0.001, root.performance?.timeOrigin && root.performance?.now ? root.performance.timeOrigin + root.performance.now() : Date.now());
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key === 'etiqFila' || key?.startsWith(LEGACY) || key?.startsWith(FALLBACK)) keys.push(key); }
      for (const key of keys) {
        const raw = storage.getItem(key); if (!raw) continue;
        let value; try { value = JSON.parse(raw); } catch (_) { continue; }
        if (key === 'etiqFila') {
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
      const db = await open();
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
        const tx = db.transaction(['events', 'photos'], 'readwrite'), done = completed(tx, timeoutMs);
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
        // A stale tab cannot undo confirmation even if it holds an older image.
        // All originals remain in the immutable image store and event history.
        if (row.complete && row.capId && !event.fields.complete && event.fields.st === 'fila') continue;
        if (row.st === 'revisao' && row.msg === 'Repetição cancelada — não contada' && event.fields.st === 'fila') continue;
        Object.assign(row, event.fields); rows.set(event.identity, row);
      }
      return [...rows.values()];
    }

    async function read() {
      if (fallback) return merge(legacySources().flatMap(source => source.events.map(event => ({ ...event, key: source.key }))));
      await migrateLegacy();
      const db = await open(), tx = db.transaction('events', 'readonly'), done = completed(tx, timeoutMs);
      const [events] = await Promise.all([request(tx.objectStore('events').getAll()), done]);
      const merged = merge(events), needed = [...new Set(merged.map(row => row.photoRef).filter(Boolean))];
      // Retain every original on disk without loading superseded recaptures
      // into RAM on each queue poll. Only the current row images are hydrated.
      let images = [];
      if (needed.length) {
        const photosTx = db.transaction('photos', 'readonly'), photosDone = completed(photosTx, timeoutMs);
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

    async function append(id, fields) {
      if (fallback) {
        // The image exists only in this delta, never duplicated in an aggregate.
        let at = Date.now();
        for (const source of legacySources()) for (const event of source.events) at = Math.max(at, (Number(event.at) || 0) + 1);
        const event = { key: FALLBACK + uuid(), identity: id, at, fields: copy(fields) };
        storage.setItem(event.key, JSON.stringify(event)); return copy(fields);
      }
      const db = await open(), prepared = await prepare(fields);
      const tx = db.transaction(['events', 'photos'], 'readwrite'), done = completed(tx, timeoutMs);
      // All writers of this store serialize at the transaction boundary. Choose
      // a monotonic event clock inside that transaction, including other tabs.
      const op = tx.objectStore('events').getAll();
      op.onsuccess = () => {
        let at = Date.now(); for (const event of op.result) at = Math.max(at, (Number(event.at) || 0) + 1);
        for (const image of prepared.images) tx.objectStore('photos').put(image);
        tx.objectStore('events').put({ key: 'delta:' + uuid(), identity: id, at, fields: prepared.fields });
      };
      await done;
      return { ...copy(fields), ...(prepared.fields.photoRef ? { photoRef: prepared.fields.photoRef } : {}) };
    }

    return { read, append, migrateLegacy, identity, backend: fallback ? 'localStorage' : 'IndexedDB' };
  }
  root.ScannerPhotoStorage = { create, identity };
})(typeof window !== 'undefined' ? window : globalThis);
