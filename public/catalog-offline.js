/* Catálogo offline do vendedor (MiniSearch 7.2.0 + IndexedDB).
 * - sync(token): baixa /api/search/catalog-snapshot (If-None-Match/ETag) e guarda no IndexedDB.
 * - search(q): busca no catálogo salvo, tolerante a erro (fuzzy) e por parte do EAN.
 * - Devolve produtos no MESMO formato da busca online (sizes[].storeStocks[]),
 *   pra tela reaproveitar o card. Estoque = físico localizado na hora do sync.
 * Sem custo: o snapshot nem traz. */
(function (root) {
  'use strict';
  var DB_NAME = 'tc-catalog-offline';
  var STORE = 'snapshot';
  var KEY = 'v1';
  var MIN_SYNC_MS = 10 * 60 * 1000;

  var state = { snap: null, index: null, savedAt: null, etag: null, syncing: null, lastSyncTry: 0 };

  function fold(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  // Snapshot compacto → objetos no formato da API.
  function expand(snap) {
    var stores = (snap.stores || []).map(function (s) { return { id: s[0], code: s[1], name: s[2] }; });
    return (snap.products || []).map(function (p) {
      var sizes = (p[7] || []).map(function (s) {
        return {
          size: s[0],
          barcode: s[1] || null,
          storeStocks: (s[2] || []).map(function (st) {
            var store = stores[st[0]] || {};
            return { storeId: store.id, storeCode: store.code, storeName: store.name, stock: st[1] };
          }),
        };
      });
      var physical = sizes.reduce(function (sum, s) { return sum + s.storeStocks.reduce(function (a, b) { return a + (b.stock || 0); }, 0); }, 0);
      return { id: p[0], name: p[1], brand: p[2], sku: p[3], color: p[4], price: p[5], promoPrice: p[6], sizes: sizes, physicalStock: physical, offline: true };
    });
  }

  function buildIndex(MiniSearch, products) {
    if (!MiniSearch) return null;
    var ms = new MiniSearch({
      idField: 'id',
      fields: ['name', 'brand', 'sku', 'color', 'barcodes'],
      storeFields: ['id'],
      processTerm: function (t) { var f = fold(t); return f.length ? f : null; },
      searchOptions: { boost: { name: 2, brand: 1.5, sku: 1.5 }, fuzzy: 0.25, prefix: true, combineWith: 'AND' },
    });
    ms.addAll(products.map(function (p) {
      return { id: p.id, name: p.name, brand: p.brand, sku: p.sku, color: p.color || '', barcodes: p.sizes.map(function (s) { return s.barcode || ''; }).join(' ') };
    }));
    return ms;
  }

  function load(snap, savedAt, etag, MiniSearch) {
    var products = expand(snap);
    var byId = {};
    products.forEach(function (p) { byId[p.id] = p; });
    state.snap = { products: products, byId: byId, generatedAt: snap.generatedAt || null };
    state.index = buildIndex(MiniSearch || root.MiniSearch, products);
    state.savedAt = savedAt || null;
    state.etag = etag || null;
    return products.length;
  }

  function search(q, limit) {
    if (!state.snap) return [];
    var max = limit || 30;
    var raw = String(q || '').trim();
    if (!raw) return [];
    var digits = raw.replace(/\D/g, '');
    var out = [];
    var seen = {};
    // Parte do EAN (4+ dígitos): procura dentro do código, não só no começo.
    if (/^[\d\s.-]+$/.test(raw) && digits.length >= 4) {
      state.snap.products.forEach(function (p) {
        if (out.length >= max) return;
        if (p.sizes.some(function (s) { return s.barcode && s.barcode.indexOf(digits) !== -1; })) { out.push(p); seen[p.id] = 1; }
      });
    }
    if (state.index) {
      var hits = state.index.search(raw);
      if (!hits.length) hits = state.index.search(raw, { combineWith: 'OR' });
      for (var i = 0; i < hits.length && out.length < max; i++) {
        if (seen[hits[i].id]) continue;
        var p = state.snap.byId[hits[i].id];
        if (p) { out.push(p); seen[p.id] = 1; }
      }
    } else {
      // MiniSearch não carregou: busca simples por palavra (sem perdão de erro).
      var words = fold(raw).split(/\s+/).filter(Boolean);
      state.snap.products.forEach(function (p) {
        if (out.length >= max || seen[p.id]) return;
        var hay = fold([p.name, p.brand, p.sku, p.color].join(' '));
        if (words.every(function (w) { return hay.indexOf(w) !== -1; })) out.push(p);
      });
    }
    return out;
  }

  // ---------------- IndexedDB (navegador) ----------------
  function idb() {
    return new Promise(function (resolve, reject) {
      if (!root.indexedDB) return reject(new Error('sem IndexedDB'));
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet() {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbPut(value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, KEY);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function restore() {
    if (state.snap) return Promise.resolve(true);
    return idbGet().then(function (row) {
      if (!row || !row.data) return false;
      load(row.data, row.savedAt, row.etag);
      return true;
    }).catch(function () { return false; });
  }

  // Baixa o snapshot se mudou (ETag). force ignora o intervalo mínimo.
  function sync(token, opts) {
    opts = opts || {};
    if (state.syncing) return state.syncing;
    if (!opts.force && Date.now() - state.lastSyncTry < MIN_SYNC_MS && state.snap) return Promise.resolve({ ok: true, skipped: true });
    state.lastSyncTry = Date.now();
    state.syncing = restore().then(function () {
      var headers = {};
      if (token) headers.Authorization = 'Bearer ' + token;
      if (state.etag && state.snap) headers['If-None-Match'] = state.etag;
      return fetch('/api/search/catalog-snapshot', { headers: headers, cache: 'no-store' });
    }).then(function (res) {
      if (res.status === 304) return { ok: true, unchanged: true };
      if (!res.ok) return { ok: false, status: res.status };
      var etag = res.headers.get('ETag');
      return res.json().then(function (data) {
        var savedAt = new Date().toISOString();
        load(data, savedAt, etag);
        return idbPut({ data: data, etag: etag, savedAt: savedAt }).catch(function () { return false; })
          .then(function () { return { ok: true, count: state.snap.products.length }; });
      });
    }).catch(function (e) { return { ok: false, error: e && e.message }; })
      .then(function (r) { state.syncing = null; return r; });
    return state.syncing;
  }

  var api = {
    sync: sync,
    restore: restore,
    search: search,
    ready: function () { return !!state.snap; },
    savedAt: function () { return state.savedAt; },
    count: function () { return state.snap ? state.snap.products.length : 0; },
    // usados pelos testes (Node)
    _load: load,
    _expand: expand,
    _reset: function () { state = { snap: null, index: null, savedAt: null, etag: null, syncing: null, lastSyncTry: 0 }; },
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CatalogOffline = api;
})(typeof window !== 'undefined' ? window : globalThis);
