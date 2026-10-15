'use strict';
// Execute the real action UI with isolated DOM, network, storage and camera mocks.
// No browser, database, credentials or production requests are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../public/bipar-actions.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../public/bipar.html'), 'utf8');
const settingsKey = 'tc_bipar_actions_settings_v1', pendingKey = 'tc_bipar_actions_pending_v1';
const stores = [1, 2, 3].map(n => ({ id: '00000000-0000-4000-8000-00000000000' + n, name: 'Store ' + n, code: '0' + n, active: true }));
const person = { id: '10000000-0000-4000-8000-000000000001', name: 'Isolated operator', role: 'seller', storeId: stores[0].id };
const product = { productSizeId: '20000000-0000-4000-8000-000000000001', name: 'Test shoe', brand: 'Adidas', size: '40', barcode: '7891234567895' };
const lupo = { productSizeId: '20000000-0000-4000-8000-000000000002', name: 'Manguito Lupo AU UV Unissex', brand: 'LUPO', size: 'P', barcode: '7900373256192' };
const receipts = [1, 2].map(n => ({ id: '30000000-0000-4000-8000-00000000000' + n, code: 100 + n, fromStore: stores[0], toStore: stores[1], qtyTotal: 1, status: 'in_transit' }));
function receiptStorage(storeId = stores[1].id) { return storage({ [settingsKey]: JSON.stringify({ mode: 'receipt', stores: { receipt: storeId }, origin: stores[0].id }) }); }
function deferred() { let resolve, reject; const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { get length() { return data.size; }, key: index => [...data.keys()][index] || null, getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}
function harness(shared) {
  const nodes = new Map(), requests = [], historyRequests = [], scannerInstances = [], tracks = [], intervals = new Map(), timers = new Map();
  let nextTimer = 1;
  const localStorage = shared || storage({ [settingsKey]: JSON.stringify({ mode: 'transfer', stores: { transfer: stores[1].id }, origin: stores[0].id }) });
  const sessionStorage = storage({ tc_transfer_token: 'isolated-token' });
  let document;
  class Element {
    constructor(tag = 'div', id = '') { this.tagName = tag.toUpperCase(); this.id = id; this._value = ''; this.children = []; this.events = {}; this.dataset = {}; this.style = { setProperty(name, value) { this[name] = value; } }; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; this.classList = { toggle() {}, add() {}, remove() {} }; }
    get value() { return this._value; }
    set value(value) { this._value = this.tagName === 'SELECT' && !this.children.some(child => child.value === String(value)) ? '' : String(value); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); attach(child); } }
    add(child) { this.append(child); }
    replaceChildren(...children) { for (const child of this.children) detach(child); this.children = []; this.append(...children); if (this.tagName === 'SELECT') this._value = children[0]?.value || ''; }
    remove() { detach(this); if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    after(child) { if (this.parent) this.parent.append(child); else attach(child); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) { (this.events[name] ||= []).push(listener); }
    async emit(name, event = {}) { event.target ||= this; event.preventDefault ||= () => {}; event.stopPropagation ||= () => {}; for (const fn of this.events[name] || []) await fn(event); if (this['on' + name]) await this['on' + name](event); }
    querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return all.filter(child => selector === '*' || selector === 'input' && child.tagName === 'INPUT' || selector === 'button' && child.tagName === 'BUTTON' || selector === '[data-scan-size]' && child.dataset.scanSize); }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
    select() {}
    getContext() { return { drawImage() {} }; }
    closest() { return null; }
    set innerHTML(value) {
      this.replaceChildren();
      if (value !== '__SCANNER__') return;
      for (const id of ['etiq-video', 'etiq-hint', 'etiq-confirm', 'etiq-confirm-status', 'etiq-confirm-det', 'etiq-confirm-btn', 'etiq-contador', 'etiq-lista']) {
        const child = new Element(id === 'etiq-video' ? 'video' : 'div', id);
        if (id === 'etiq-video') { child.videoWidth = 100; child.videoHeight = 100; child.play = () => h.play(); }
        this.append(child);
      }
    }
  }
  function attach(node) { if (node.id) nodes.set(node.id, node); for (const child of node.children) attach(child); }
  function detach(node) { if (node.id && nodes.get(node.id) === node) nodes.delete(node.id); for (const child of node.children) detach(child); }
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) nodes.set(match[2], new Element(match[1], match[2]));
  for (const match of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) for (const option of match[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) { const element = new Element('option'); element.value = option[1]; element.textContent = option[2]; nodes.get(match[1]).append(element); }
  const body = new Element('body');
  document = { body, hidden: false, activeElement: body, events: {}, getElementById: id => nodes.get(id) || null,
    createElement: tag => new Element(tag), addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
  const h = { requests, historyRequests, nodes, localStorage, sessionStorage, scannerInstances, tracks, intervals, timers, document,
    get: id => nodes.get(id), handler: null, historyHandler: null, play: async () => {}, recognize: async () => '', decode: async () => '', confirmDuplicate: async () => true };
  const window = { events: {}, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }, ScannerTransfer: { refresh() {} }, ScannerConfirm: { ask: text => h.confirmDuplicate(text) },
    ScannerView: { markup: () => '__SCANNER__' }, ScannerOCR: { recognize: canvas => h.recognize(canvas) },
    ScannerAuto: { stopDecoder() {}, decodeInWorker: canvas => h.decode(canvas), create(options) { const scanner = { options, resets: [], stopped: false, tick() {}, reset(value) { this.resets.push(value); this.stopped = false; }, stop() { this.stopped = true; } }; scannerInstances.push(scanner); return scanner; } },
    fecharScanner() {} };
  const context = vm.createContext({ window, document, localStorage, sessionStorage, console, crypto: { randomUUID }, AbortController, URLSearchParams,
    navigator: { clipboard: { writeText: async text => { h.copiedText = text; } }, mediaDevices: { getUserMedia: async () => { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track] }; } } },
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    confirm: () => true, setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id), setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    fetch: async (url, options = {}) => {
      assert.ok(url.startsWith('/api/scan-transfers/actions') || url === '/api/auth/login', 'New action must never call inventory or an external endpoint: ' + url);
      const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, auth: options.headers?.Authorization };
      if (url.includes('/drafts/sync') || url.includes('/history')) {
        historyRequests.push(request);
        if (h.historyHandler) return h.historyHandler(request);
        if (url.endsWith('/drafts/sync')) return response({ synced: true, lot: { sessionId: request.body.sessionId, revision: request.body.revision, status: request.body.status } });
        return response({ lots: [], totals: {}, page: 1, totalPages: 1, totalLots: 0 });
      }
      requests.push(request);
      if (url === '/api/auth/login') return response({ token: 'isolated-login-token' });
      if (url.endsWith('/context')) return response({ user: person, stores, allowedStoreIds: [stores[0].id, stores[1].id] });
      if (h.handler) return h.handler(request);
      if (url.endsWith('/lookup')) return response({ product, requiresSizeConfirmation: true });
      if (url.includes('/pending?')) return response({ transfers: [] });
      throw Error('Unexpected isolated request: ' + url);
    } });
  const exportCode = 'window.__test = { authenticate, loadShipments, openCamera, closeCamera, capture, resolveRead, refreshIdentifications, activeReads, scansPayload, contextChanged, storeChanged, prepare, confirmAction, persist, signature, flushSync, queueSync, recoverDrafts, startNewLot, loadHistory, showHistoryDetail, copyHistory, syncPayload, historyFilters, state:()=>({actor,currentDraft,preview,cameraRead,cameraRetry,busy,stream,scanner,generation,syncJobs,historyData,historyPage,historyMode}) };';
  assert.ok(source.endsWith('})();\n') || source.trimEnd().endsWith('})();'));
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, exportCode + '\n})();'), context, { filename: 'public/bipar-actions.js' });
  h.api = window.__test; h.window = window; h.boot = () => h.api.authenticate();
  h.scan = barcode => window.BiparActions.scan(barcode);
  h.cameraClick = command => h.get('action-camera').emit('click', { target: { closest: () => ({ dataset: { click: command } }) } });
  h.size = async value => { const input = h.get('action-readings').querySelectorAll('[data-scan-size]')[0]; input.value = value; await input.emit('input'); };
  return h;
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function test(name, fn) { await fn(); console.log('PASS: ' + name); }

(async () => {
  await test('reload in transfer mode loads destination options and keeps the selected origin and destination', async () => {
    const h = harness(); await h.boot();
    assert.equal(h.get('loja').value, stores[1].id); assert.equal(h.get('action-origin').value, stores[0].id);
    assert.equal(h.get('loja').children.length, 4); assert.equal(h.get('codigo').disabled, false);
    assert.equal(h.api.state().currentDraft.context.toStoreId, stores[1].id);
  });
  await test('camera without an EAN keeps reading and neither adds a piece nor sends a lookup', async () => {
    const h = harness(); await h.boot(); await h.api.openCamera(); const before = h.requests.length;
    await h.api.capture({ ean: '', ocrText: 'ADIDAS IF1405 BR 40' });
    assert.equal(h.requests.length, before); assert.equal(h.api.activeReads().length, 0);
    assert.match(h.get('etiq-hint').textContent, /Falta ler o código/); assert.equal(h.scannerInstances[0].resets.length, 1);
    assert.equal(h.api.state().cameraRead, null); h.api.closeCamera();
  });
  await test('resolved Lupo advances without a size prompt and never fabricates physical confirmation', async () => {
    const h = harness(); await h.boot(); const ocr = deferred(); h.recognize = () => ocr.promise;
    h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await h.api.openCamera(); await h.api.capture({ ean: lupo.barcode, frame: {} });
    const item = h.api.activeReads()[0];
    assert.equal(h.get('action-camera-size'), undefined); assert.equal(h.get('action-camera-pending'), undefined);
    assert.equal(h.get('etiq-confirm-status').textContent, 'Peça identificada');
    assert.equal(h.get('etiq-confirm-btn').textContent, 'PRÓXIMA PEÇA'); assert.equal(h.get('etiq-confirm-btn').disabled, false);
    assert.equal(h.get('action-readings').querySelectorAll('[data-scan-size]').length, 0);
    ocr.resolve('LUPO TAM P'); await flush();
    assert.equal(h.get('action-camera-size'), undefined); assert.equal(h.get('etiq-confirm-status').textContent, 'Peça identificada');
    await h.cameraClick('next');
    assert.equal(item.confirmedSize, ''); assert.equal(h.api.scansPayload()[0].confirmedSize, '');
    assert.equal(h.api.scansPayload()[0].resolvedSize, 'P'); assert.equal(h.api.state().cameraRead, null);
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.scannerInstances[0].resets.at(-1).afterCode, lupo.barcode);
    const before = h.api.signature(); item.product.size = 'M'; assert.notEqual(h.api.signature(), before, 'Catalog snapshot participates in the reviewed payload');
    item.product.size = 'P'; h.api.closeCamera();
  });
  await test('each intentional repeated Lupo barcode counts one piece without a duplicate prompt', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await h.scan(lupo.barcode); const firstId = h.api.activeReads()[0].clientScanId, questions = [];
    h.confirmDuplicate = async text => { questions.push(text); return false; };
    await h.scan(lupo.barcode);
    assert.equal(h.api.activeReads().length, 2); assert.equal(h.api.activeReads()[0].clientScanId, firstId);
    assert.equal(h.api.activeReads()[1].duplicateConfirmed, true); assert.notEqual(h.api.activeReads()[1].clientScanId, firstId);
    assert.equal(questions.length, 0); assert.ok(h.api.scansPayload().every(scan => scan.confirmedSize === '' && scan.resolvedSize === 'P'));
  });
  await test('Adidas and a lookup without an explicit exemption retain physical size confirmation', async () => {
    for (const result of [{ product, requiresSizeConfirmation: false }, { product: lupo }, { product: lupo, requiresSizeConfirmation: true }]) {
      const h = harness(); await h.boot(); h.handler = () => response(result);
      await h.api.openCamera(); await h.api.capture({ ean: result.product.barcode });
      assert.ok(h.get('action-camera-size')); assert.equal(h.get('etiq-confirm-btn').disabled, true);
      assert.equal(h.get('etiq-confirm-status').textContent, 'Confira o tamanho na etiqueta');
      await h.cameraClick('next'); assert.ok(h.api.state().cameraRead); assert.equal(h.api.activeReads()[0].confirmedSize, '');
      const before = h.requests.length; await h.api.prepare(); assert.equal(h.requests.length, before + 1);
      assert.ok(h.requests.at(-1).url.endsWith('/lookup')); assert.equal(h.api.state().preview, null);
      h.api.closeCamera();
    }
  });
  await test('resolved receiving draft survives reload and submits its catalog snapshot with no physical size claim', async () => {
    const h = harness(receiptStorage()); h.handler = request => request.url.includes('/pending?') ? response({ transfers: receipts }) : response({ product: lupo, requiresSizeConfirmation: false }); await h.boot();
    await h.scan(lupo.barcode); const scanId = h.api.activeReads()[0].clientScanId, sessionId = h.api.state().currentDraft.sessionId;
    const reloaded = harness(h.localStorage); reloaded.handler = request => {
      if (request.url.includes('/pending?')) return response({ transfers: receipts });
      if (request.url.endsWith('/receive-preview')) return response({ canReceive: true, reviewToken: 'd'.repeat(64), transfer: receipts[0], scanCount: 1, items: [], blockers: [] });
      if (request.url.endsWith('/receive-confirm')) return response({ transfer: { ...receipts[0], status: 'received' } });
      if (request.url.endsWith('/lookup')) return response({ product: lupo, requiresSizeConfirmation: false });
      throw Error('Unexpected request: ' + request.url);
    };
    await reloaded.boot(); assert.equal(reloaded.api.activeReads()[0].clientScanId, scanId); assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId);
    assert.equal(reloaded.get('action-readings').querySelectorAll('[data-scan-size]').length, 0);
    reloaded.get('action-shipment').value = receipts[0].id; await reloaded.get('action-shipment').emit('change'); await reloaded.api.prepare();
    assert.equal(reloaded.api.state().preview.allowed, true); reloaded.get('action-approved').checked = true; await reloaded.api.confirmAction();
    const submitted = reloaded.requests.find(request => request.url.endsWith('/receive-confirm'));
    assert.ok(submitted); assert.equal(submitted.body.scans[0].clientScanId, scanId);
    assert.equal(submitted.body.scans[0].confirmedSize, ''); assert.equal(submitted.body.scans[0].resolvedSize, 'P');
    assert.equal(reloaded.api.activeReads().length, 0); assert.equal(reloaded.localStorage.getItem(pendingKey), null);
  });
  await test('legacy recognized draft refreshes its lookup without changing scan identity or counting again', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0], sessionId = h.api.state().currentDraft.sessionId; delete item.requiresSizeConfirmation; h.api.persist();
    const reloaded = harness(h.localStorage); reloaded.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await reloaded.boot(); await flush();
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 1);
    assert.equal(reloaded.api.activeReads().length, 1); assert.equal(reloaded.api.activeReads()[0].clientScanId, item.clientScanId);
    assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId); assert.equal(reloaded.api.activeReads()[0].requiresSizeConfirmation, false);
    assert.equal(reloaded.get('action-readings').querySelectorAll('[data-scan-size]').length, 0);
    assert.equal(reloaded.api.scansPayload()[0].confirmedSize, ''); assert.equal(reloaded.api.scansPayload()[0].resolvedSize, 'P');
  });
  await test('manual login refreshes a legacy draft after busy clears but preserves uncertain requests', async () => {
    for (const uncertain of [false, true]) {
      const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
      const item = h.api.activeReads()[0], sessionId = h.api.state().currentDraft.sessionId; delete item.requiresSizeConfirmation; h.api.persist();
      const pending = JSON.stringify({ actorId: person.id, mode: 'transfer', body: { requestId: randomUUID(), scans: JSON.parse(JSON.stringify(h.api.scansPayload())) } });
      if (uncertain) h.localStorage.setItem(pendingKey, pending);
      const reloaded = harness(h.localStorage); reloaded.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
      reloaded.get('action-identity').value = 'isolated@example.test'; reloaded.get('action-password').value = 'isolated-test-value';
      await reloaded.get('action-login').emit('submit'); await flush();
      assert.equal(reloaded.api.state().busy, false); assert.equal(reloaded.get('action-login-button').disabled, false);
      assert.equal(reloaded.api.activeReads().length, 1); assert.equal(reloaded.api.activeReads()[0].clientScanId, item.clientScanId);
      assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId);
      assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, uncertain ? 0 : 1);
      if (uncertain) assert.equal(reloaded.localStorage.getItem(pendingKey), pending, 'Login cannot rewrite an uncertain confirmation');
      else {
        assert.equal(reloaded.api.activeReads()[0].requiresSizeConfirmation, false);
        assert.equal(reloaded.get('action-readings').querySelectorAll('[data-scan-size]').length, 0);
        assert.equal(reloaded.api.scansPayload()[0].confirmedSize, ''); assert.equal(reloaded.api.scansPayload()[0].resolvedSize, 'P');
      }
    }
  });
  await test('failed legacy lookup preserves the same pending scan and cannot use its stale product', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0]; delete item.requiresSizeConfirmation; h.api.persist();
    const reloaded = harness(h.localStorage); reloaded.handler = () => response({ error: 'Conflicting variant' }, 409); await reloaded.boot(); await flush();
    assert.equal(reloaded.api.activeReads().length, 1); assert.equal(reloaded.api.activeReads()[0].clientScanId, item.clientScanId);
    assert.equal(reloaded.api.activeReads()[0].product, undefined); assert.match(reloaded.api.activeReads()[0].error, /Conflicting variant/);
    const before = reloaded.requests.length; await reloaded.api.prepare(); assert.equal(reloaded.requests.length, before + 1);
    assert.ok(reloaded.requests.at(-1).url.endsWith('/lookup')); assert.equal(reloaded.api.state().preview, null);
    assert.equal(reloaded.get('action-confirm').disabled, true);
  });
  await test('an existing physical-size discrepancy is not erased by a catalog-resolved variant', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: true }); await h.scan(lupo.barcode); await h.size('G');
    h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.api.resolveRead(h.api.state().currentDraft, h.api.activeReads()[0]);
    assert.equal(h.api.activeReads()[0].confirmedSize, 'G'); assert.equal(h.get('action-readings').querySelectorAll('[data-scan-size]').length, 1);
    const before = h.requests.length; await h.api.prepare(); assert.equal(h.requests.length, before + 1);
    assert.ok(h.requests.at(-1).url.endsWith('/lookup')); assert.equal(h.api.state().preview, null);
    assert.equal(h.api.scansPayload()[0].confirmedSize, 'G'); assert.equal(h.api.scansPayload()[0].resolvedSize, 'P');
  });
  await test('camera retry actually rescans the same piece, preserving one scan ID and still requiring its size', async () => {
    const h = harness(); await h.boot(); let lookups = 0;
    h.handler = request => { assert.ok(request.url.endsWith('/lookup')); return ++lookups === 1 ? response({ error: 'Try again' }, 503) : response({ product }); };
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode });
    const firstId = h.api.activeReads()[0].clientScanId;
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].product, undefined);
    assert.match(h.get('action-camera-notice-text').textContent, new RegExp(product.barcode));
    assert.equal(h.get('etiq-confirm').style.display, 'none');
    await h.cameraClick('retry-pending');
    assert.equal(lookups, 1, 'Retry must resume camera, not repeat the failed query without a fresh frame');
    assert.equal(h.api.state().cameraRead, null); assert.equal(h.api.state().cameraRetry.clientScanId, firstId);
    assert.equal(h.scannerInstances[0].stopped, false); assert.equal(h.scannerInstances[0].resets.at(-1), undefined, 'Same piece may retain the same code');
    assert.match(h.get('etiq-hint').textContent, /MESMA peça/);
    await h.api.capture({ ean: product.barcode });
    assert.equal(lookups, 2); assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, firstId);
    assert.equal(h.get('etiq-confirm-btn').disabled, true); assert.equal(h.api.activeReads()[0].confirmedSize, '');
    const size = h.get('action-camera-size'); size.value = '40'; await size.emit('input');
    assert.equal(h.get('etiq-confirm-btn').disabled, false); await h.cameraClick('next');
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].confirmedSize, '40');
    assert.equal(h.api.state().cameraRead, null); h.api.closeCamera();
  });
  await test('barcode lookup starts before OCR finishes; same-frame OCR is saved and sent without confirming a size', async () => {
    const h = harness(); await h.boot(); const ocr = deferred(), canvas = { marker: 'same physical label' }; let frameSeen;
    h.recognize = frame => { frameSeen = frame; return ocr.promise; };
    h.handler = request => request.body?.ocrText ? response({ product }) : response({ error: 'Unknown code' }, 404);
    await h.api.openCamera(); const capturing = h.api.capture({ ean: product.barcode, frame: canvas }); await flush();
    assert.equal(h.requests.filter(r => r.url.endsWith('/lookup')).length, 1); assert.equal(frameSeen, canvas);
    assert.equal(h.api.activeReads().length, 1); const id = h.api.activeReads()[0].clientScanId;
    ocr.resolve('ADIDAS IF1405 BR 40'); await capturing;
    assert.equal(h.requests.filter(r => r.url.endsWith('/lookup')).at(-1).body.ocrText, 'ADIDAS IF1405 BR 40');
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, id);
    assert.equal(h.api.activeReads()[0].confirmedSize, '', 'OCR must never certify the physical size by itself');
    assert.equal(h.get('action-confirm').disabled, true); assert.equal(h.api.activeReads()[0].ocrText, 'ADIDAS IF1405 BR 40');
    const reloaded = harness(h.localStorage); await reloaded.boot();
    assert.equal(reloaded.api.activeReads()[0].ocrText, 'ADIDAS IF1405 BR 40');
    await reloaded.api.resolveRead(reloaded.api.state().currentDraft, reloaded.api.activeReads()[0]);
    assert.equal(reloaded.requests.at(-1).body.ocrText, 'ADIDAS IF1405 BR 40'); h.api.closeCamera();
  });
  await test('slow OCR never delays a known product or overwrites the physical size being typed', async () => {
    const h = harness(); await h.boot(); const ocr = deferred(); h.recognize = () => ocr.promise;
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode, frame: {} });
    assert.equal(h.api.state().cameraRead.product.productSizeId, product.productSizeId);
    const size = h.get('action-camera-size'); size.value = '4'; await size.emit('input');
    assert.equal(h.get('etiq-confirm-btn').disabled, true);
    const lookups = h.requests.filter(r => r.url.endsWith('/lookup')).length;
    ocr.resolve('ADIDAS BR 40'); await flush();
    assert.equal(h.get('action-camera-size'), size); assert.equal(size.value, '4');
    assert.equal(h.requests.filter(r => r.url.endsWith('/lookup')).length, lookups, 'Known barcode needs no duplicate query for OCR');
    assert.equal(h.api.activeReads()[0].confirmedSize, ''); assert.equal(h.api.activeReads()[0].ocrText, 'ADIDAS BR 40');
    size.value = '40'; await size.emit('input'); await h.cameraClick('next');
    assert.equal(h.api.activeReads()[0].confirmedSize, '40'); h.api.closeCamera();
  });
  await test('late OCR after deliberate advance or closing never contaminates another piece or reopens a confirmation', async () => {
    for (const finish of ['advance', 'close']) {
      const h = harness(); await h.boot(); const ocr = deferred(); h.recognize = () => ocr.promise;
      await h.api.openCamera(); await h.api.capture({ ean: product.barcode, frame: {} });
      const first = h.api.activeReads()[0];
      if (finish === 'advance') {
        const size = h.get('action-camera-size'); size.value = '40'; await size.emit('input'); await h.cameraClick('next');
        await h.api.capture({ ean: '7891234567888' });
      } else h.api.closeCamera();
      const before = h.requests.length; ocr.resolve('OLD FRAME BR 41'); await flush();
      assert.equal(h.requests.length, before); assert.equal(first.ocrText, '');
      if (finish === 'advance') {
        assert.equal(h.api.state().cameraRead.barcode, '7891234567888'); assert.equal(h.api.activeReads()[1].ocrText, ''); h.api.closeCamera();
      } else assert.equal(h.get('action-camera'), undefined);
    }
  });
  await test('changed retry barcode requires explicit same-piece correction, and cancellation preserves original pending scan', async () => {
    const h = harness(); await h.boot(); const wrong = '7891234567888', questions = [];
    h.handler = request => request.body.barcode === wrong ? response({ error: 'Unknown code' }, 404) : response({ product });
    await h.api.openCamera(); await h.api.capture({ ean: wrong, ocrText: 'OLD LABEL TEXT' });
    const item = h.api.activeReads()[0], session = h.api.state().currentDraft.sessionId;
    h.confirmDuplicate = async text => { questions.push(text); return false; };
    await h.cameraClick('retry-pending'); await h.api.capture({ ean: product.barcode });
    assert.equal(item.barcode, wrong); assert.equal(h.api.activeReads().length, 1); assert.equal(item.ocrText, 'OLD LABEL TEXT');
    assert.match(questions[0], /MESMA peça física/); assert.ok(questions[0].includes(wrong) && questions[0].includes(product.barcode));
    h.confirmDuplicate = async text => { questions.push(text); return true; };
    await h.cameraClick('retry-pending'); await h.api.capture({ ean: product.barcode });
    assert.equal(h.api.activeReads()[0], item); assert.equal(item.barcode, product.barcode); assert.equal(item.ocrText, '');
    assert.equal(item.barcodeCorrections[0].previous, wrong); assert.equal(item.confirmedSize, '');
    assert.equal(h.api.state().currentDraft.sessionId, session); assert.equal(h.api.activeReads().length, 1); h.api.closeCamera();
  });
  await test('corrected retry code matching an earlier piece keeps its scan ID without another duplicate prompt', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); const wrong = '7891234567888';
    h.handler = request => request.body.barcode === wrong ? response({ error: 'Unknown code' }, 404) : response({ product });
    await h.api.openCamera(); await h.api.capture({ ean: wrong }); const item = h.api.activeReads()[1]; let questions = [];
    h.confirmDuplicate = async text => { questions.push(text); return questions.length === 1; };
    await h.cameraClick('retry-pending'); await h.api.capture({ ean: product.barcode });
    assert.equal(item.barcode, product.barcode); assert.equal(item.duplicateConfirmed, true); assert.equal(h.api.activeReads().length, 2);
    assert.equal(questions.length, 1); assert.match(questions[0], /MESMA peça física/); h.api.closeCamera();
  });
  await test('unresolved EAN advances automatically with a small pending notice, but prevents final review and stock writes', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404);
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode });
    assert.equal(h.get('action-camera-pending'), undefined); const item = h.api.activeReads()[0];
    assert.equal(h.get('etiq-confirm').style.display, 'none');
    assert.equal(h.api.activeReads().length, 1); assert.ok(item.pendingAutoContinuedAt); assert.equal(item.pendingAcknowledgedAt, undefined); assert.equal(h.api.state().cameraRead, null);
    assert.match(h.get('action-camera-notice-text').textContent, /guardado como pendente/);
    assert.ok(h.tracks.every(track => !track.stopped)); assert.equal(h.scannerInstances[0].stopped, false);
    assert.equal(h.scannerInstances[0].resets.at(-1).afterCode, product.barcode);
    const before = h.requests.length; await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
    assert.equal(h.requests.length, before + 1); assert.ok(h.requests.at(-1).url.endsWith('/lookup')); assert.equal(h.get('action-confirm').disabled, true);
    await h.api.capture({ ean: '7891234567888' }); assert.equal(h.api.activeReads().length, 2, 'The next physical label can be read without an extra next button');
    assert.equal(h.get('etiq-confirm').style.display, 'none'); assert.equal(h.api.state().cameraRead, null);
    assert.equal(h.scannerInstances[0].resets.at(-1).afterCode, '7891234567888');
    h.api.closeCamera();
  });
  await test('saved pending card can reopen the camera to decode a fresh frame for that same scan', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); await h.scan(product.barcode);
    const item = h.api.activeReads()[0]; const reloaded = harness(h.localStorage); reloaded.handler = () => response({ error: 'Unknown code' }, 404); await reloaded.boot(); await flush();
    const retry = reloaded.get('action-readings').querySelectorAll('*').find(node => node.textContent === 'Ler novamente esta peça');
    assert.ok(retry); await retry.onclick(); assert.equal(reloaded.api.state().cameraRetry.clientScanId, item.clientScanId);
    reloaded.handler = () => response({ product });
    let decoded = 0, recognized = 0; reloaded.decode = async () => { decoded++; return product.barcode; }; reloaded.recognize = async () => { recognized++; return 'ADIDAS BR 40'; };
    await reloaded.cameraClick('capture');
    assert.equal(decoded, 1); assert.equal(recognized, 1); assert.equal(reloaded.api.activeReads().length, 1);
    assert.equal(reloaded.api.activeReads()[0].clientScanId, item.clientScanId); assert.equal(reloaded.api.activeReads()[0].confirmedSize, ''); reloaded.api.closeCamera();
  });
  await test('explicit pending retry then manual capture uses the same physical scan ID', async () => {
    const h = harness(); await h.boot(); let lookups = 0;
    h.handler = () => ++lookups === 1 ? response({ error: 'Unknown code' }, 404) : response({ product });
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode }); const id = h.api.activeReads()[0].clientScanId;
    await h.cameraClick('retry-pending'); h.decode = async () => product.barcode; await h.cameraClick('capture');
    assert.equal(lookups, 2); assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, id);
    assert.equal(h.api.state().cameraRead.product.productSizeId, product.productSizeId); h.api.closeCamera();
  });
  await test('late manual camera decode cannot insert the old frame into a newly selected store', async () => {
    const h = harness(); await h.boot(); await h.api.openCamera(); const decoded = deferred(); h.decode = () => decoded.promise;
    const capturing = h.cameraClick('capture'); await flush(); h.get('loja').value = stores[0].id; h.api.storeChanged();
    // Change back to a valid transfer context and reopen, preserving the stale promise.
    h.get('loja').value = stores[1].id; h.api.storeChanged(); await h.api.openCamera(); const before = h.requests.length;
    decoded.resolve(product.barcode); await capturing;
    assert.equal(h.requests.length, before); assert.equal(h.api.activeReads().length, 0); h.api.closeCamera();
  });
  await test('switching store while a barcode correction awaits confirmation never edits either store draft', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); const wrong = '7891234567888';
    await h.api.openCamera(); await h.api.capture({ ean: wrong }); const original = h.api.state().currentDraft, question = deferred();
    h.confirmDuplicate = () => question.promise; await h.cameraClick('retry-pending'); const recapturing = h.api.capture({ ean: product.barcode });
    await flush(); h.get('loja').value = stores[2].id; h.api.storeChanged(); question.resolve(true); await recapturing;
    assert.equal(original.scans.length, 1); assert.equal(original.scans[0].barcode, wrong); assert.equal(h.api.activeReads().length, 0);
    assert.equal(h.get('action-camera'), undefined); assert.ok(h.tracks.every(track => track.stopped));
  });
  await test('store and account changes reject stale lookup data without editing either draft', async () => {
    const h = harness(); await h.boot(); const pending = deferred(); h.handler = () => pending.promise;
    const read = h.scan(product.barcode), original = h.api.state().currentDraft;
    h.get('loja').value = stores[2].id; h.api.storeChanged();
    pending.resolve(response({ product })); await read;
    assert.equal(h.api.activeReads().length, 0); assert.equal(original.scans.length, 1); assert.equal(original.scans[0].product, undefined);
    h.get('loja').value = stores[1].id; h.api.storeChanged(); await flush(); assert.equal(h.api.activeReads().length, 1);
    const late = deferred(); h.handler = () => late.promise; const second = h.scan('7891234567888'), oldDraft = h.api.state().currentDraft;
    h.get('action-switch-user').onclick(); late.resolve(response({ product })); await second;
    assert.equal(h.api.activeReads().length, 0); assert.equal(oldDraft.scans[1].product, undefined);
    assert.equal(oldDraft.scans[1].error, ''); assert.equal(h.api.state().actor, null);
  });
  await test('closing camera during video.play prevents a late scanner or timer from being installed', async () => {
    const h = harness(); await h.boot(); const play = deferred(); h.play = () => play.promise;
    const opening = h.api.openCamera(); await flush(); h.api.closeCamera(); play.resolve(); await opening;
    assert.equal(h.scannerInstances.length, 0); assert.equal(h.intervals.size, 0); assert.equal(h.get('action-camera'), undefined);
    assert.ok(h.tracks.every(track => track.stopped)); h.play = async () => {}; await h.api.openCamera();
    assert.equal(h.scannerInstances.length, 1); h.api.closeCamera();
  });
  await test('failed confirmation survives reload with the exact request ID and payload, then archives those reads', async () => {
    for (const chosen of [product, lupo]) {
      const h = harness(); await h.boot(); h.handler = () => response({ product: chosen, requiresSizeConfirmation: chosen === product });
      await h.scan(chosen.barcode); if (chosen === product) await h.size('40');
      h.handler = request => request.url.endsWith('/lookup') ? response({ product: chosen, requiresSizeConfirmation: chosen === product }) : request.url.endsWith('/send-preview') ? response({ canTransfer: true, reviewToken: 'a'.repeat(64), scanCount: 1, items: [], blockers: [] }) : Promise.reject(Error('Network interrupted'));
      await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
      const pending = JSON.parse(h.localStorage.getItem(pendingKey)); assert.ok(pending?.body.requestId);
      assert.equal(h.api.activeReads().length, 1); const firstRequest = h.requests.find(request => request.url.endsWith('/send-confirm'));
      if (chosen === lupo) { assert.equal(firstRequest.body.scans[0].confirmedSize, ''); assert.equal(firstRequest.body.scans[0].resolvedSize, 'P'); }
      // Even an old draft needing policy refresh must not rewrite an uncertain request.
      delete h.api.activeReads()[0].requiresSizeConfirmation; h.api.persist();
      const reloaded = harness(h.localStorage); await reloaded.boot();
      assert.equal(reloaded.api.activeReads().length, 1); assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 0);
      reloaded.handler = request => { assert.deepEqual(request.body, firstRequest.body); return response({ transfer: { id: request.body.requestId, code: 123, qtyTotal: 1, status: 'in_transit' }, alreadySaved: true }); };
      await reloaded.api.confirmAction(true);
      assert.equal(reloaded.localStorage.getItem(pendingKey), null); assert.equal(reloaded.api.activeReads().length, 0);
      assert.match(reloaded.get('action-result').textContent, /aguardando conferência no destino/);
      assert.equal(reloaded.requests.filter(request => request.url.endsWith('/send-confirm')).length, 1);
    }
  });
  await test('late preview from a different context cannot enable confirmation', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); await h.size('40'); const pending = deferred(); h.handler = () => pending.promise;
    const preparing = h.api.prepare(); h.get('loja').value = stores[2].id; h.api.storeChanged();
    pending.resolve(response({ canTransfer: true, reviewToken: 'b'.repeat(64), scanCount: 1, items: [], blockers: [] })); await preparing;
    assert.equal(h.api.state().preview, null); assert.equal(h.get('action-confirm').disabled, true);
    assert.equal(h.requests.filter(request => request.url.endsWith('/send-confirm')).length, 0);
  });
  await test('receipt with no pending shipment unlocks manual scans and camera, but cannot preview or confirm stock', async () => {
    const h = harness(receiptStorage()); await h.boot();
    assert.equal(h.get('loja').value, stores[1].id); assert.equal(h.get('action-shipment').value, '');
    assert.equal(h.get('codigo').disabled, false, 'A receiving store is sufficient to begin scanning');
    await h.api.openCamera(); assert.ok(h.get('action-camera')); assert.equal(h.scannerInstances.length, 1);
    const pendingList = deferred(), camera = h.get('action-camera'), scanner = h.api.state().scanner;
    h.handler = request => request.url.includes('/pending?') ? pendingList.promise : response({ product });
    const refreshing = h.api.loadShipments();
    assert.equal(h.get('action-camera'), camera); assert.equal(h.get('codigo').disabled, false);
    await h.api.capture({ ean: product.barcode }); assert.equal(h.api.activeReads().length, 1);
    const scanId = h.api.activeReads()[0].clientScanId;
    pendingList.resolve(response({ transfers: [] })); await refreshing;
    assert.equal(h.get('action-camera'), camera, 'Refreshing the shipment list must not close an active camera');
    assert.equal(h.api.state().scanner, scanner); assert.equal(h.api.activeReads()[0].clientScanId, scanId);
    assert.ok(h.tracks.every(track => !track.stopped), 'Camera tracks stay available while refreshing shipments');
    const lookup = h.requests.find(request => request.url.endsWith('/lookup'));
    assert.ok(lookup); assert.ok(!lookup.body.transferId, 'Unbound draft cannot guess an incoming transfer');
    h.api.closeCamera(); await h.size('40');
    const before = h.requests.length;
    await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
    assert.equal(h.requests.length, before, 'No preview or stock write may be sent without a transfer');
    assert.equal(h.get('action-confirm').disabled, true); assert.equal(h.localStorage.getItem(pendingKey), null);
    assert.equal(h.api.activeReads().length, 1, 'Scanning without a shipment remains a saved draft');
  });
  await test('receipt draft survives reload, shipment binding and refreshing pending shipments without losing scan IDs', async () => {
    const h = harness(receiptStorage()); await h.boot(); await h.scan(product.barcode); await h.size('40');
    const original = JSON.stringify(h.api.scansPayload()), sessionId = h.api.state().currentDraft.sessionId;
    const reloaded = harness(h.localStorage); await reloaded.boot();
    assert.equal(JSON.stringify(reloaded.api.scansPayload()), original); assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId);
    reloaded.handler = request => request.url.includes('/pending?') ? response({ transfers: receipts }) : response({ product });
    await reloaded.api.loadShipments(); const unboundSignature = reloaded.api.signature();
    reloaded.get('action-shipment').value = receipts[0].id; await reloaded.get('action-shipment').emit('change');
    assert.notEqual(reloaded.api.signature(), unboundSignature, 'The selected shipment must be part of the review signature');
    assert.equal(JSON.stringify(reloaded.api.scansPayload()), original); assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId);
    const boundSignature = reloaded.api.signature(); await reloaded.api.loadShipments();
    assert.equal(reloaded.get('action-shipment').value, receipts[0].id); assert.equal(reloaded.api.signature(), boundSignature);
    assert.equal(JSON.stringify(reloaded.api.scansPayload()), original); assert.equal(reloaded.api.state().currentDraft.sessionId, sessionId);
    reloaded.get('action-shipment').value = receipts[1].id; await reloaded.get('action-shipment').emit('change');
    assert.notEqual(reloaded.api.signature(), boundSignature); assert.equal(JSON.stringify(reloaded.api.scansPayload()), original);
    const again = harness(reloaded.localStorage); again.handler = request => request.url.includes('/pending?') ? response({ transfers: receipts }) : response({ product }); await again.boot();
    assert.equal(again.get('action-shipment').value, receipts[1].id); assert.equal(JSON.stringify(again.api.scansPayload()), original);
    assert.equal(again.api.state().currentDraft.sessionId, sessionId);
  });
  await test('late receipt lookup is retained when a shipment appears; refreshed or changed shipment invalidates previous review', async () => {
    const h = harness(receiptStorage()); await h.boot(); const lookup = deferred();
    h.handler = request => request.url.endsWith('/lookup') ? lookup.promise : response({ transfers: receipts });
    const scanning = h.scan(product.barcode), draft = h.api.state().currentDraft, id = draft.scans[0].clientScanId;
    await h.api.loadShipments(); h.get('action-shipment').value = receipts[0].id; await h.get('action-shipment').emit('change');
    lookup.resolve(response({ product })); await scanning; await flush();
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, id);
    assert.equal(h.api.activeReads()[0].product.productSizeId, product.productSizeId);
    await h.api.resolveRead(h.api.state().currentDraft, h.api.activeReads()[0]);
    const reboundLookup = h.requests.filter(request => request.url.endsWith('/lookup')).at(-1);
    assert.equal(reboundLookup.body.transferId, receipts[0].id, 'Retries after binding use the selected shipment, including variants disabled after dispatch');
    assert.equal(h.api.activeReads().length, 1); await h.size('40');
    h.handler = request => request.url.endsWith('/lookup') ? response({ product }) : request.url.endsWith('/receive-preview') ? response({ canReceive: true, reviewToken: 'c'.repeat(64), transfer: receipts[0], scanCount: 1, items: [], blockers: [] }) : response({ transfers: receipts });
    await h.api.prepare(); assert.ok(h.api.state().preview?.allowed);
    h.get('action-approved').checked = true;
    const before = h.requests.length; h.get('action-shipment').value = receipts[1].id;
    await h.api.confirmAction(); assert.equal(h.requests.length, before, 'Different shipment cannot reuse the previous signed review');
    await h.get('action-shipment').emit('change'); assert.equal(h.api.state().preview, null); assert.equal(h.get('action-confirm').disabled, true);
    await h.api.prepare(); assert.ok(h.api.state().preview?.allowed); await h.api.loadShipments();
    assert.equal(h.api.state().preview, null); assert.equal(h.api.activeReads()[0].clientScanId, id);
  });
  await test('missing, unauthorized and unknown receiving stores keep scanning and camera blocked', async () => {
    for (const id of ['', stores[2].id, '99999999-9999-4999-8999-999999999999']) {
      const h = harness(receiptStorage(id)); await h.boot(); const before = h.requests.length;
      assert.equal(h.get('codigo').disabled, true);
      assert.equal(await h.scan(product.barcode), null); await h.api.openCamera(); await h.api.prepare();
      h.get('action-approved').checked = true; await h.api.confirmAction();
      assert.equal(h.api.activeReads().length, 0); assert.equal(h.scannerInstances.length, 0); assert.equal(h.get('action-camera'), undefined);
      assert.equal(h.requests.length, before, 'Invalid destination must not trigger lookup, review or stock confirmation');
    }
  });
  await test('reloading repaired pending codes preserves the exact two physical readings, session and duplicate consent', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Há informações divergentes para este código.' }, 404);
    await h.scan(lupo.barcode); await h.scan(lupo.barcode);
    const original = h.api.activeReads().map(item => ({ id: item.clientScanId, duplicate: item.duplicateConfirmed, barcode: item.barcode, createdAt: item.createdAt }));
    const session = h.api.state().currentDraft.sessionId;
    const reloaded = harness(h.localStorage); reloaded.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await reloaded.boot(); await flush(); await flush();
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 2);
    assert.equal(reloaded.api.activeReads().length, 2); assert.equal(reloaded.api.state().currentDraft.sessionId, session);
    assert.equal(JSON.stringify(reloaded.api.activeReads().map(item => ({ id: item.clientScanId, duplicate: item.duplicateConfirmed, barcode: item.barcode, createdAt: item.createdAt }))), JSON.stringify(original));
    assert.ok(reloaded.api.activeReads().every(item => item.product.productSizeId === lupo.productSizeId && item.error === '' && item.confirmedSize === '' && item.requiresSizeConfirmation === false));
    assert.equal(reloaded.scannerInstances.length, 0); assert.equal(reloaded.requests.filter(request => request.url.includes('-confirm')).length, 0);
  });
  await test('updating identification reuses the barcode and reading without camera access or another piece', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0], session = h.api.state().currentDraft.sessionId;
    h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    const button = h.get('action-readings').querySelectorAll('button').find(node => node.textContent === 'Atualizar identificação');
    assert.ok(button); await button.onclick();
    assert.equal(h.api.activeReads()[0], item); assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.state().currentDraft.sessionId, session);
    assert.equal(item.product.productSizeId, lupo.productSizeId); assert.equal(item.confirmedSize, ''); assert.equal(h.scannerInstances.length, 0);
    assert.equal(h.requests.at(-1).body.barcode, lupo.barcode); assert.equal(h.requests.filter(request => request.url.endsWith('/lookup')).length, 2);
  });
  await test('review refreshes every saved product snapshot and identification updates invalidate earlier approval', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0], originalId = item.clientScanId;
    const corrected = { ...lupo, productSizeId: '20000000-0000-4000-8000-000000000003', name: 'Corrected canonical variant', size: 'M' };
    h.handler = request => request.url.endsWith('/lookup') ? response({ product: corrected, requiresSizeConfirmation: false }) : response({ canTransfer: true, reviewToken: 'e'.repeat(64), scanCount: 1, items: [], blockers: [] });
    await h.api.prepare();
    const reviewed = h.requests.find(request => request.url.endsWith('/send-preview'));
    assert.ok(reviewed); assert.equal(reviewed.body.scans[0].productSizeId, corrected.productSizeId); assert.equal(reviewed.body.scans[0].resolvedSize, 'M');
    assert.equal(reviewed.body.scans[0].confirmedSize, ''); assert.equal(reviewed.body.scans[0].clientScanId, originalId); assert.equal(item.product.productSizeId, corrected.productSizeId);
    assert.ok(h.api.state().preview?.allowed); h.get('action-approved').checked = true;
    await h.get('action-readings').querySelectorAll('button').find(node => node.textContent === 'Atualizar identificação').onclick();
    assert.equal(h.api.state().preview, null); assert.equal(h.get('action-approved').checked, false); assert.equal(h.get('action-confirm').disabled, true);
  });
  await test('automatic recovery limits lookup concurrency to three and skips removed reads', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404);
    for (let i = 0; i < 9; i++) await h.scan(lupo.barcode);
    h.api.activeReads()[8].removed = true; h.api.persist();
    const ids = h.api.activeReads().map(item => item.clientScanId), session = h.api.state().currentDraft.sessionId;
    const reloaded = harness(h.localStorage), waiting = []; let active = 0, maxActive = 0;
    reloaded.handler = request => { assert.ok(request.url.endsWith('/lookup')); active++; maxActive = Math.max(maxActive, active); const done = deferred(); waiting.push(() => { active--; done.resolve(response({ product: lupo, requiresSizeConfirmation: false })); }); return done.promise; };
    await reloaded.boot(); await flush(); assert.equal(active, 3);
    for (let i = 0; i < 8; i++) { assert.ok(waiting.length); waiting.shift()(); await flush(); await flush(); }
    assert.equal(maxActive, 3); assert.equal(active, 0); assert.equal(waiting.length, 0);
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 8);
    assert.equal(JSON.stringify(reloaded.api.activeReads().map(item => item.clientScanId)), JSON.stringify(ids)); assert.equal(reloaded.api.state().currentDraft.sessionId, session);
    assert.ok(reloaded.api.activeReads().every(item => item.product?.productSizeId === lupo.productSizeId));
    assert.equal(reloaded.api.state().currentDraft.scans.length, 9); assert.equal(reloaded.api.state().currentDraft.scans[8].removed, true);
  });
  await test('context change stops queued recovery and discards all responses from the previous store', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404);
    for (let i = 0; i < 7; i++) await h.scan(lupo.barcode);
    const reloaded = harness(h.localStorage), waiting = [];
    reloaded.handler = () => { const done = deferred(); waiting.push(done); return done.promise; };
    await reloaded.boot(); await flush(); const original = reloaded.api.state().currentDraft;
    assert.equal(waiting.length, 3); reloaded.get('loja').value = stores[2].id; reloaded.api.storeChanged();
    for (const done of waiting) done.resolve(response({ product: lupo, requiresSizeConfirmation: false })); await flush(); await flush();
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 3); assert.equal(reloaded.api.activeReads().length, 0);
    assert.ok(original.scans.every(item => !item.product)); assert.equal(original.scans.length, 7);
  });
  await test('a late response for a corrected barcode cannot overwrite the same reading with the old product', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0], oldResponse = deferred(), newCode = '7900373353679';
    h.handler = request => request.body.barcode === lupo.barcode ? oldResponse.promise : response({ product: { ...lupo, barcode: newCode, size: 'M' }, requiresSizeConfirmation: false });
    const oldLookup = h.api.resolveRead(h.api.state().currentDraft, item); await flush();
    item.barcode = newCode; delete item.product; const newLookup = h.api.resolveRead(h.api.state().currentDraft, item);
    oldResponse.resolve(response({ product: lupo, requiresSizeConfirmation: false })); await oldLookup; await newLookup;
    assert.equal(item.barcode, newCode); assert.equal(item.product.barcode, newCode); assert.equal(item.product.size, 'M'); assert.equal(h.api.activeReads().length, 1);
    assert.equal(item.confirmedSize, ''); assert.equal(h.requests.at(-1).body.barcode, newCode);
  });
  await test('an uncertain confirmation blocks recovery, update buttons and preview without changing saved data', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); await h.scan(lupo.barcode);
    const draftBefore = JSON.stringify(h.api.state().currentDraft), pending = JSON.stringify({ actorId: person.id, mode: 'transfer', body: { requestId: randomUUID(), scans: [{ original: 'frozen request' }] } });
    h.localStorage.setItem(pendingKey, pending);
    const reloaded = harness(h.localStorage); reloaded.handler = () => { throw Error('Uncertain confirmation must not be reinterpreted'); }; await reloaded.boot(); await flush();
    const button = reloaded.get('action-readings').querySelectorAll('button').find(node => node.textContent === 'Atualizar identificação');
    assert.equal(button.disabled, true); await button.onclick(); await reloaded.api.prepare(); await reloaded.api.refreshIdentifications(true);
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/lookup')).length, 0); assert.equal(reloaded.requests.filter(request => request.url.includes('-preview')).length, 0);
    assert.equal(reloaded.localStorage.getItem(pendingKey), pending);
    const after = { ...reloaded.api.state().currentDraft, syncedRevision: 0 };
    assert.equal(JSON.stringify(after), draftBefore, 'Synchronization metadata may change; the uncertain operation and its pieces remain intact');
  });
  await test('a confirmation appearing while lookup is pending prevents new identification and review', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0], late = deferred(), pending = JSON.stringify({ actorId: person.id, body: { requestId: randomUUID() } }); h.handler = () => late.promise;
    const preparing = h.api.prepare(); await flush(); h.localStorage.setItem(pendingKey, pending);
    late.resolve(response({ product: { ...lupo, size: 'G' }, requiresSizeConfirmation: false })); await preparing;
    assert.equal(item.product.size, 'P'); assert.equal(h.api.state().preview, null); assert.equal(h.localStorage.getItem(pendingKey), pending);
    assert.equal(h.requests.filter(request => request.url.endsWith('/send-preview')).length, 0);
  });
  await test('receipt review rechecks the selected manifest and does not bypass a server rejection', async () => {
    const h = harness(receiptStorage()); h.handler = request => request.url.includes('/pending?') ? response({ transfers: receipts }) : response({ product: lupo, requiresSizeConfirmation: false }); await h.boot(); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0]; h.get('action-shipment').value = receipts[0].id; await h.get('action-shipment').emit('change');
    h.handler = request => { assert.equal(request.body.transferId, receipts[0].id); assert.equal(request.body.storeId, stores[1].id); return response({ error: 'Esta peça não pertence à transferência selecionada.' }, 409); };
    await h.api.prepare(); assert.equal(item.product, undefined); assert.match(item.error, /não pertence/);
    assert.equal(h.requests.filter(request => request.url.endsWith('/receive-preview')).length, 0); assert.equal(h.get('action-confirm').disabled, true); assert.equal(h.api.activeReads().length, 1);
  });
  await test('successful identification keeps a real stock blocker and never confirms the transfer', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    h.handler = request => request.url.endsWith('/lookup') ? response({ product: lupo, requiresSizeConfirmation: false }) : response({ canTransfer: false, reviewToken: 'f'.repeat(64), scanCount: 1, items: [{ productName: lupo.name, size: 'P', quantity: 1, available: 0, remaining: -1 }], blockers: [{ code: 'insufficient_stock', message: 'Somente 0 no estoque da origem.' }] });
    await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
    assert.equal(h.api.state().preview.allowed, false); assert.equal(h.get('action-confirm').disabled, true);
    assert.equal(h.requests.filter(request => request.url.endsWith('/send-confirm')).length, 0); assert.equal(h.api.activeReads().length, 1);
  });
  await test('expired authentication during revalidation cannot authorize a stale preview', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.scan(lupo.barcode);
    h.handler = () => response({ error: 'Entre novamente.' }, 401); await h.api.prepare();
    assert.equal(h.api.state().actor, null); assert.equal(h.api.state().preview, null); assert.equal(h.get('action-confirm').disabled, true);
    assert.equal(h.requests.filter(request => request.url.endsWith('/send-preview')).length, 0); assert.equal(h.api.activeReads().length, 1);
  });
  await test('returning to the page recovers a pending code using its original reading', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); await h.scan(lupo.barcode);
    const item = h.api.activeReads()[0]; h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    h.document.hidden = false; for (const fn of h.document.events.visibilitychange) fn(); await flush(); await flush();
    assert.equal(h.api.activeReads()[0], item); assert.equal(item.product?.productSizeId, lupo.productSizeId); assert.equal(h.api.activeReads().length, 1);
  });
  await test('continuous pending reads preserve all 106 existing physical scans, session, store and duplicate consent', async () => {
    const h = harness(); await h.boot();
    const draft = h.api.state().currentDraft;
    for (let n = 0; n < 106; n++) draft.scans.push({ clientScanId: randomUUID(), barcode: String(7900000000000 + n), confirmedSize: '', duplicateConfirmed: n % 2 === 0, createdAt: '2026-10-14T19:20:00.000Z' });
    h.api.persist(); const before = JSON.stringify(draft.scans), session = draft.sessionId, context = JSON.stringify(draft.context);
    h.handler = () => response({ error: 'Código encontrado na nota, mas o tamanho ainda precisa ser confirmado no cadastro.' }, 422);
    await h.api.openCamera(); await h.api.capture({ ean: '7909392206157' });
    assert.equal(h.api.activeReads().length, 107); assert.equal(JSON.stringify(draft.scans.slice(0, 106)), before);
    assert.equal(draft.sessionId, session); assert.equal(JSON.stringify(draft.context), context);
    assert.match(h.get('etiq-contador').textContent, /107 peça\(s\).*107 pendente/); assert.equal(h.get('etiq-confirm').style.display, 'none');
    const saved = JSON.parse(h.localStorage.getItem('tc_bipar_action_draft_v1:' + draft.key));
    assert.equal(saved.scans.length, 107); assert.equal(JSON.stringify(saved.scans.slice(0, 106)), before); h.api.closeCamera();
  });
  await test('pending same-frame OCR can resolve in the background without changing the next Adidas confirmation', async () => {
    const h = harness(); await h.boot(); const ocr = deferred(); h.recognize = () => ocr.promise;
    h.handler = request => request.body?.barcode === product.barcode ? response({ product }) : request.body?.ocrText ? response({ product: lupo, requiresSizeConfirmation: false }) : response({ error: 'Size pending' }, 422);
    await h.api.openCamera(); await h.api.capture({ ean: lupo.barcode, frame: {} }); const first = h.api.activeReads()[0];
    assert.equal(h.api.state().cameraRead, null); assert.equal(h.get('etiq-confirm').style.display, 'none');
    await h.api.capture({ ean: product.barcode }); const second = h.api.activeReads()[1], size = h.get('action-camera-size'); size.value = '4'; await size.emit('input');
    ocr.resolve('LUPO TAM P'); await flush(); await flush();
    assert.equal(first.product?.productSizeId, lupo.productSizeId); assert.equal(first.ocrText, 'LUPO TAM P'); assert.equal(first.confirmedSize, '');
    assert.equal(h.api.state().cameraRead, second); assert.equal(h.get('action-camera-size'), size); assert.equal(size.value, '4');
    assert.equal(second.ocrText, ''); assert.equal(second.confirmedSize, ''); assert.equal(h.get('etiq-confirm-btn').disabled, true);
    assert.equal(h.api.activeReads().length, 2); assert.equal(h.get('action-confirm').disabled, true); h.api.closeCamera();
  });
  await test('a new physical piece with the same unresolved code counts separately without a duplicate prompt', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Size pending' }, 422);
    await h.api.openCamera(); await h.api.capture({ ean: lupo.barcode }); const firstId = h.api.activeReads()[0].clientScanId, questions = [];
    h.confirmDuplicate = async text => { questions.push(text); return false; }; await h.api.capture({ ean: lupo.barcode });
    assert.equal(h.api.state().cameraRead, null);
    assert.equal(h.api.activeReads().length, 2); assert.equal(h.api.activeReads()[0].clientScanId, firstId); assert.equal(h.api.activeReads()[1].duplicateConfirmed, true);
    assert.notEqual(h.api.activeReads()[1].clientScanId, firstId); assert.equal(questions.length, 0);
    assert.equal(h.get('etiq-confirm').style.display, 'none'); h.api.closeCamera();
  });
  await test('failure to save a newly captured EAN pauses scanning and never claims the reading was stored', async () => {
    const h = harness(); await h.boot(); await h.api.openCamera(); const before = h.requests.length;
    h.localStorage.setItem = () => { throw Error('Quota exceeded'); };
    await h.api.capture({ ean: lupo.barcode });
    assert.equal(h.requests.length, before); assert.equal(h.api.state().scanner.stopped, true); assert.equal(h.api.state().scanner.options.canRead(), false);
    assert.equal(h.api.state().cameraRead.storageError, true); assert.match(h.get('etiq-confirm-status').textContent, /Não foi possível guardar/);
    assert.equal(h.get('action-camera-notice').hidden, true); assert.equal(h.get('etiq-confirm-btn').disabled, true);
    await h.api.capture({ ean: product.barcode }); assert.equal(h.api.activeReads().length, 1); assert.equal(h.get('action-confirm').disabled, true); h.api.closeCamera();
  });
  await test('a storage failure after pending lookup cannot silently resume the camera', async () => {
    const h = harness(); await h.boot(); await h.api.openCamera(); const originalSet = h.localStorage.setItem.bind(h.localStorage); let saves = 0;
    h.localStorage.setItem = (key, value) => { if (key.startsWith('tc_bipar_action_draft_v1:') && ++saves > 1) throw Error('Quota exceeded'); originalSet(key, value); };
    h.handler = () => response({ error: 'Size pending' }, 422); await h.api.capture({ ean: lupo.barcode });
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.state().cameraRead.storageError, true); assert.equal(h.api.state().scanner.stopped, true);
    assert.equal(h.api.state().scanner.options.canRead(), false); assert.equal(h.api.activeReads()[0].pendingAutoContinuedAt, undefined);
    assert.equal(h.get('etiq-confirm-btn').disabled, true); assert.equal(h.get('action-camera-notice').hidden, true); h.api.closeCamera();
  });
  await test('central synchronization retains repeated barcodes as distinct pieces and never calls stock confirmation', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await h.scan(lupo.barcode); await h.scan(lupo.barcode); const draft = h.api.state().currentDraft;
    assert.equal(await h.api.flushSync(draft), true);
    const saved = h.historyRequests.filter(r => r.url.endsWith('/drafts/sync')).at(-1).body;
    assert.equal(saved.scans.length, 2); assert.equal(new Set(saved.scans.map(s => s.clientScanId)).size, 2);
    assert.equal(saved.scans[0].barcode, saved.scans[1].barcode); assert.equal(saved.mode, 'transfer');
    assert.equal(saved.fromStoreId, stores[0].id); assert.equal(saved.toStoreId, stores[1].id);
    assert.equal(saved.sessionId, draft.sessionId); assert.ok(saved.scans.every(s => s.createdAt));
    assert.equal(h.requests.some(r => /confirm$/.test(r.url)), false);
    assert.equal(draft.syncedRevision, draft.revision); assert.match(h.get('action-sync-status').textContent, /salvos no sistema/);
  });
  await test('network failure leaves all scans locally and camera available, then retries the same IDs', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await h.scan(lupo.barcode); const draft = h.api.state().currentDraft, id = draft.scans[0].clientScanId;
    h.historyHandler = () => { throw Error('Network offline'); };
    assert.equal(await h.api.flushSync(draft), false); assert.match(h.get('action-sync-status').textContent, /Sincronização pendente/);
    await h.api.openCamera(); assert.ok(h.get('action-camera')); assert.equal(h.get('codigo').disabled, false); h.api.closeCamera();
    const local = JSON.parse(h.localStorage.getItem('tc_bipar_action_draft_v1:' + draft.key)); assert.equal(local.scans[0].clientScanId, id);
    h.historyHandler = request => response({ synced: true, lot: { revision: request.body.revision, status: 'open' } });
    assert.equal(await h.api.flushSync(draft), true); assert.equal(h.api.activeReads().length, 1);
    assert.equal(h.historyRequests.filter(r => r.url.endsWith('/drafts/sync')).at(-1).body.scans[0].clientScanId, id);
  });
  await test('legacy recovery restores every own action lot while excluding a different operator', async () => {
    const h = harness(); await h.boot(); const first = h.api.state().currentDraft;
    for (let n = 0; n < 106; n++) first.scans.push({ clientScanId: randomUUID(), barcode: lupo.barcode, createdAt: '2026-10-14T19:20:00.000Z', confirmedSize: '' });
    h.api.persist(first); const original = JSON.stringify(first.scans.map(s => [s.clientScanId, s.createdAt]));
    const ownReceipt = { ...JSON.parse(JSON.stringify(first)), key: 'own-receipt', sessionId: randomUUID(), context: { ...first.context, mode: 'receipt', fromStoreId: '' }, scans: [{ clientScanId: randomUUID(), barcode: lupo.barcode, createdAt: '2026-10-03T10:00:00Z' }] };
    const other = { ...ownReceipt, key: 'other-operator', sessionId: randomUUID(), context: { ...ownReceipt.context, actorId: randomUUID() } };
    h.localStorage.setItem('tc_bipar_action_draft_v1:own-receipt', JSON.stringify(ownReceipt)); h.localStorage.setItem('tc_bipar_action_draft_v1:other-operator', JSON.stringify(other));
    h.api.recoverDrafts(); await flush();
    const posts = h.historyRequests.filter(r => r.url.endsWith('/drafts/sync'));
    assert.ok(posts.some(r => r.body.sessionId === first.sessionId && r.body.scans.length === 106));
    assert.ok(posts.some(r => r.body.sessionId === ownReceipt.sessionId && r.body.mode === 'receipt'));
    assert.equal(posts.some(r => r.body.sessionId === other.sessionId), false);
    assert.equal(JSON.stringify(first.scans.map(s => [s.clientScanId, s.createdAt])), original);
  });
  await test('late synchronization acknowledgement after account change cannot mark another account saved', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); const draft = h.api.state().currentDraft, late = deferred();
    h.historyHandler = () => late.promise; const sending = h.api.flushSync(draft); await flush();
    h.get('action-switch-user').onclick(); late.resolve(response({ synced: true, lot: { revision: draft.revision, status: 'open' } }));
    assert.equal(await sending, false); assert.equal(draft.syncedRevision, 0); assert.equal(h.api.state().actor, null);
    assert.equal(h.get('action-sync-status').hidden, true); assert.equal(h.get('action-history-list').children.length, 0);
  });
  await test('new lot archives its complete snapshot without treating every piece as removed', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); await h.scan(product.barcode); const old = h.api.state().currentDraft;
    await h.get('action-clear').onclick(); assert.notEqual(h.api.state().currentDraft.sessionId, old.sessionId); assert.equal(h.api.activeReads().length, 0);
    const archived = JSON.parse(h.localStorage.getItem('tc_bipar_action_archive_v1:' + old.sessionId));
    assert.equal(archived.status, 'archived'); assert.equal(archived.scans.length, 2); assert.ok(archived.scans.every(s => !s.removed));
    await h.api.flushSync(old); const sent = h.historyRequests.filter(r => r.url.endsWith('/drafts/sync')).at(-1).body;
    assert.equal(sent.status, 'archived'); assert.ok(sent.scans.every(s => s.removed === false));
  });
  await test('the 500-reading limit includes removed rows and retains the earlier history', async () => {
    const h = harness(); await h.boot(); const draft = h.api.state().currentDraft;
    for (let n = 0; n < 500; n++) draft.scans.push({ clientScanId: randomUUID(), barcode: lupo.barcode, createdAt: new Date().toISOString(), removed: n === 0 });
    h.api.persist(); const before = h.requests.length; assert.equal(await h.scan(lupo.barcode), null);
    assert.equal(h.requests.length, before); assert.equal(draft.scans.length, 500); assert.equal(h.api.activeReads().length, 499); assert.match(h.get('action-message').textContent, /incluindo as retiradas/);
  });
  await test('two tabs appending to the same session preserve each distinct scan and cannot lose it to a late acknowledgement', async () => {
    const a = harness(); await a.boot(); await a.scan(product.barcode); const b = harness(a.localStorage); await b.boot(); await flush();
    const late = deferred(); a.historyHandler = () => late.promise; const sending = a.api.flushSync(a.api.state().currentDraft); await flush();
    await b.scan(lupo.barcode); const bId = b.api.activeReads().at(-1).clientScanId;
    late.resolve(response({ synced: true, lot: { revision: a.api.state().currentDraft.revision, status: 'open' } })); await sending;
    await a.scan('7891234567888'); const saved = JSON.parse(a.localStorage.getItem('tc_bipar_action_draft_v1:' + a.api.state().currentDraft.key));
    assert.equal(saved.scans.length, 3); assert.ok(saved.scans.some(s => s.clientScanId === bId)); assert.equal(new Set(saved.scans.map(s => s.clientScanId)).size, 3);
  });
  await test('two first-time offline tabs retain separate session checkpoints even when the active context changes', async () => {
    const a = harness(), b = harness(a.localStorage); await a.boot(); await b.boot();
    await a.scan(product.barcode); await b.scan(lupo.barcode); const sa = a.api.state().currentDraft.sessionId, sb = b.api.state().currentDraft.sessionId;
    assert.notEqual(sa, sb);
    assert.equal(JSON.parse(a.localStorage.getItem('tc_bipar_action_archive_v1:' + sa)).scans.length, 1);
    assert.equal(JSON.parse(a.localStorage.getItem('tc_bipar_action_archive_v1:' + sb)).scans.length, 1);
    const reloaded = harness(a.localStorage); await reloaded.boot(); await flush();
    const recovered = new Set(reloaded.historyRequests.filter(r => r.url.endsWith('/drafts/sync')).map(r => r.body.sessionId));
    assert.ok(recovered.has(sa) && recovered.has(sb));
  });
  await test('stale server revision recovers the other session reads, unions their IDs and retries once at a higher revision', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); const draft = h.api.state().currentDraft, other = { clientScanId: randomUUID(), barcode: product.barcode, createdAt: '2026-10-02T10:00:00Z' }; let posts = 0;
    h.historyHandler = request => {
      if (request.url.includes('/history/')) return response({ lot: { sessionId: draft.sessionId, revision: 20, status: 'open', operator: person }, scans: [other] });
      if (++posts === 1) return response({ synced: false, lot: { revision: 20, status: 'open' } });
      return response({ synced: true, lot: { revision: request.body.revision, status: 'open' } });
    };
    assert.equal(await h.api.flushSync(draft), true); assert.equal(posts, 2); assert.ok(draft.revision > 20);
    assert.equal(draft.scans.length, 2); assert.ok(draft.scans.some(s => s.clientScanId === other.clientScanId));
  });
  await test('separate action history filters paginate and WhatsApp export includes every page', async () => {
    const h = harness(); await h.boot(); h.get('action-history-from').value = '2026-10-01'; h.get('action-history-to').value = '2026-10-15';
    const lot = number => ({ sessionId: randomUUID(), mode: 'receipt', status: number === 1 ? 'open' : 'confirmed', fromStore: stores[0], toStore: stores[1], operator: { name: 'Operator ' + number }, firstScannedAt: '2026-10-02T10:00:00Z', lastScannedAt: '2026-10-02T10:30:00Z', scanCount: number, totalScanCount: number, pendingCount: 0 });
    h.historyHandler = request => { const query = new URL(request.url, 'https://example.test').searchParams; assert.equal(query.get('mode'), 'receipt'); assert.equal(query.get('from'), '2026-10-01'); const page = Number(query.get('page')); return response({ lots: query.get('export') === '1' ? [lot(1), lot(2)] : [lot(page)], totals: { scans: 3, lots: 2, confirmedLots: 1, confirmedScans: 2, recognized: 3 }, page, totalLots: 2, totalPages: 2 }); };
    await h.get('action-history-receipt').onclick(); await flush();
    assert.equal(h.get('action-history-next').disabled, false); assert.match(h.get('action-history-summary').textContent, /3 peças bipadas/);
    await h.get('action-history-next').onclick(); assert.equal(h.api.state().historyPage, 2); assert.equal(h.get('action-history-next').disabled, true);
    await h.api.copyHistory(); assert.match(h.copiedText, /RECEBIMENTOS/); assert.match(h.copiedText, /Operator 1/); assert.match(h.copiedText, /Operator 2/); assert.match(h.copiedText, /Peças bipadas: 3/);
    assert.equal(h.get('action-history-transfer')['aria-pressed'], 'false'); assert.equal(h.get('action-history-receipt')['aria-pressed'], 'true');
  });
  await test('late history responses cannot replace the selected action or expose details after logout', async () => {
    const h = harness(); await h.boot(); const late = deferred(); h.historyHandler = () => late.promise;
    const loading = h.api.loadHistory(); await flush(); h.get('action-switch-user').onclick();
    late.resolve(response({ lots: [{ scanCount: 999, operator: { name: 'Old actor data' } }], totals: { scans: 999 }, totalPages: 1 })); await loading;
    assert.equal(h.get('action-history-list').children.length, 0); assert.equal(h.get('action-history-summary').textContent, '');
  });
  await test('a new history query immediately clears a copied report from the previous action or filters', async () => {
    const h = harness(); await h.boot();
    for (const run of [() => h.get('action-history-receipt').onclick(), () => h.get('action-history-transfer').onclick(), () => h.get('action-history-store').emit('change'), () => h.get('action-history-refresh').onclick()]) {
      h.get('action-history-copy-text').value = '*RECEBIMENTOS*\nTexto anterior'; h.get('action-history-copy-text').hidden = false;
      await run();
      assert.equal(h.get('action-history-copy-text').value, ''); assert.equal(h.get('action-history-copy-text').hidden, true);
    }
  });
  console.log('PASS: 58 action UI regression groups; isolated mocks only.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
