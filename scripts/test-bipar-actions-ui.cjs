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
  return { getItem: key => data.has(key) ? data.get(key) : null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
}
function harness(shared) {
  const nodes = new Map(), requests = [], scannerInstances = [], tracks = [], intervals = new Map();
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
    querySelectorAll(selector) { const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]); return all.filter(child => selector === '*' || selector === 'input' && child.tagName === 'INPUT' || selector === '[data-scan-size]' && child.dataset.scanSize); }
    focus() { document.activeElement = this; }
    setSelectionRange() {}
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
  const body = new Element('body');
  document = { body, hidden: false, activeElement: body, events: {}, getElementById: id => nodes.get(id) || null,
    createElement: tag => new Element(tag), addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
  const h = { requests, nodes, localStorage, sessionStorage, scannerInstances, tracks, intervals, document,
    get: id => nodes.get(id), handler: null, play: async () => {}, recognize: async () => '', decode: async () => '', confirmDuplicate: async () => true };
  const window = { addEventListener() {}, ScannerTransfer: { refresh() {} }, ScannerConfirm: { ask: text => h.confirmDuplicate(text) },
    ScannerView: { markup: () => '__SCANNER__' }, ScannerOCR: { recognize: canvas => h.recognize(canvas) },
    ScannerAuto: { stopDecoder() {}, decodeInWorker: canvas => h.decode(canvas), create(options) { const scanner = { options, resets: [], stopped: false, tick() {}, reset(value) { this.resets.push(value); this.stopped = false; }, stop() { this.stopped = true; } }; scannerInstances.push(scanner); return scanner; } },
    fecharScanner() {} };
  const context = vm.createContext({ window, document, localStorage, sessionStorage, console, crypto: { randomUUID }, AbortController,
    navigator: { mediaDevices: { getUserMedia: async () => { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track] }; } } },
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    confirm: () => true, setTimeout: () => nextTimer++, clearTimeout() {}, setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    fetch: async (url, options = {}) => {
      assert.ok(url.startsWith('/api/scan-transfers/actions') || url === '/api/auth/login', 'New action must never call inventory or an external endpoint: ' + url);
      const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, auth: options.headers?.Authorization };
      requests.push(request);
      if (url === '/api/auth/login') return response({ token: 'isolated-login-token' });
      if (url.endsWith('/context')) return response({ user: person, stores, allowedStoreIds: [stores[0].id, stores[1].id] });
      if (h.handler) return h.handler(request);
      if (url.endsWith('/lookup')) return response({ product, requiresSizeConfirmation: true });
      if (url.includes('/pending?')) return response({ transfers: [] });
      throw Error('Unexpected isolated request: ' + url);
    } });
  const exportCode = 'window.__test = { authenticate, loadShipments, openCamera, closeCamera, capture, resolveRead, activeReads, scansPayload, contextChanged, storeChanged, prepare, confirmAction, persist, signature, state:()=>({actor,currentDraft,preview,cameraRead,cameraRetry,busy,stream,scanner,generation}) };';
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
  await test('resolved Lupo keeps duplicate physical-piece confirmation and cancels without counting', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: false });
    await h.scan(lupo.barcode); const firstId = h.api.activeReads()[0].clientScanId, questions = [];
    h.confirmDuplicate = async text => { questions.push(text); return false; };
    assert.equal(await h.scan(lupo.barcode), null); assert.equal(h.api.activeReads().length, 1);
    h.confirmDuplicate = async text => { questions.push(text); return true; }; await h.scan(lupo.barcode);
    assert.equal(h.api.activeReads().length, 2); assert.equal(h.api.activeReads()[0].clientScanId, firstId);
    assert.equal(h.api.activeReads()[1].duplicateConfirmed, true); assert.notEqual(h.api.activeReads()[1].clientScanId, firstId);
    assert.ok(questions.every(text => /outra peça física/.test(text))); assert.ok(h.api.scansPayload().every(scan => scan.confirmedSize === '' && scan.resolvedSize === 'P'));
  });
  await test('Adidas and a lookup without an explicit exemption retain physical size confirmation', async () => {
    for (const result of [{ product, requiresSizeConfirmation: false }, { product: lupo }, { product: lupo, requiresSizeConfirmation: true }]) {
      const h = harness(); await h.boot(); h.handler = () => response(result);
      await h.api.openCamera(); await h.api.capture({ ean: result.product.barcode });
      assert.ok(h.get('action-camera-size')); assert.equal(h.get('etiq-confirm-btn').disabled, true);
      assert.equal(h.get('etiq-confirm-status').textContent, 'Confira o tamanho na etiqueta');
      await h.cameraClick('next'); assert.ok(h.api.state().cameraRead); assert.equal(h.api.activeReads()[0].confirmedSize, '');
      const before = h.requests.length; await h.api.prepare(); assert.equal(h.requests.length, before);
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
      throw Error('Resolved saved variant does not need a new lookup: ' + request.url);
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
    const before = reloaded.requests.length; await reloaded.api.prepare(); assert.equal(reloaded.requests.length, before);
    assert.equal(reloaded.get('action-confirm').disabled, true);
  });
  await test('an existing physical-size discrepancy is not erased by a catalog-resolved variant', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ product: lupo, requiresSizeConfirmation: true }); await h.scan(lupo.barcode); await h.size('G');
    h.handler = () => response({ product: lupo, requiresSizeConfirmation: false }); await h.api.resolveRead(h.api.state().currentDraft, h.api.activeReads()[0]);
    assert.equal(h.api.activeReads()[0].confirmedSize, 'G'); assert.equal(h.get('action-readings').querySelectorAll('[data-scan-size]').length, 1);
    const before = h.requests.length; await h.api.prepare(); assert.equal(h.requests.length, before);
    assert.equal(h.api.scansPayload()[0].confirmedSize, 'G'); assert.equal(h.api.scansPayload()[0].resolvedSize, 'P');
  });
  await test('camera retry actually rescans the same piece, preserving one scan ID and still requiring its size', async () => {
    const h = harness(); await h.boot(); let lookups = 0;
    h.handler = request => { assert.ok(request.url.endsWith('/lookup')); return ++lookups === 1 ? response({ error: 'Try again' }, 503) : response({ product }); };
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode });
    const firstId = h.api.activeReads()[0].clientScanId;
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].product, undefined);
    assert.match(h.get('etiq-confirm-det').textContent, new RegExp(product.barcode));
    await h.cameraClick('next');
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
    await h.cameraClick('next'); await h.api.capture({ ean: product.barcode });
    assert.equal(item.barcode, wrong); assert.equal(h.api.activeReads().length, 1); assert.equal(item.ocrText, 'OLD LABEL TEXT');
    assert.match(questions[0], /MESMA peça física/); assert.ok(questions[0].includes(wrong) && questions[0].includes(product.barcode));
    h.confirmDuplicate = async text => { questions.push(text); return true; };
    await h.cameraClick('next'); await h.api.capture({ ean: product.barcode });
    assert.equal(h.api.activeReads()[0], item); assert.equal(item.barcode, product.barcode); assert.equal(item.ocrText, '');
    assert.equal(item.barcodeCorrections[0].previous, wrong); assert.equal(item.confirmedSize, '');
    assert.equal(h.api.state().currentDraft.sessionId, session); assert.equal(h.api.activeReads().length, 1); h.api.closeCamera();
  });
  await test('corrected retry code matching an earlier piece requires other-physical-piece confirmation without adding a scan', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); const wrong = '7891234567888';
    h.handler = request => request.body.barcode === wrong ? response({ error: 'Unknown code' }, 404) : response({ product });
    await h.api.openCamera(); await h.api.capture({ ean: wrong }); const item = h.api.activeReads()[1]; let questions = [];
    h.confirmDuplicate = async text => { questions.push(text); return questions.length === 1; };
    await h.cameraClick('next'); await h.api.capture({ ean: product.barcode });
    assert.equal(item.barcode, wrong); assert.equal(h.api.activeReads().length, 2); assert.match(questions[1], /OUTRA peça física/);
    questions = []; h.confirmDuplicate = async text => { questions.push(text); return true; };
    await h.cameraClick('next'); await h.api.capture({ ean: product.barcode });
    assert.equal(item.barcode, product.barcode); assert.equal(item.duplicateConfirmed, true); assert.equal(h.api.activeReads().length, 2);
    assert.equal(questions.length, 2); h.api.closeCamera();
  });
  await test('explicit pending-next keeps the unresolved piece and camera available, but prevents final review and stock writes', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404);
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode });
    assert.match(h.get('action-camera-pending').textContent, /MANTER PENDENTE/); const item = h.api.activeReads()[0];
    await h.cameraClick('next-pending');
    assert.equal(h.api.activeReads().length, 1); assert.ok(item.pendingAcknowledgedAt); assert.equal(h.api.state().cameraRead, null);
    assert.match(h.get('action-message').textContent, /mantida como pendente/);
    assert.ok(h.tracks.every(track => !track.stopped)); assert.equal(h.scannerInstances[0].stopped, false);
    assert.equal(h.scannerInstances[0].resets.at(-1).afterCode, product.barcode);
    const before = h.requests.length; await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
    assert.equal(h.requests.length, before); assert.equal(h.get('action-confirm').disabled, true);
    await h.api.capture({ ean: '7891234567888' }); assert.equal(h.api.activeReads().length, 2, 'Only the deliberate next piece adds another scan');
    h.api.closeCamera();
  });
  await test('saved pending card can reopen the camera to decode a fresh frame for that same scan', async () => {
    const h = harness(); await h.boot(); h.handler = () => response({ error: 'Unknown code' }, 404); await h.scan(product.barcode);
    const item = h.api.activeReads()[0]; const reloaded = harness(h.localStorage); await reloaded.boot();
    const retry = reloaded.get('action-readings').querySelectorAll('*').find(node => node.textContent === 'Ler novamente esta peça');
    assert.ok(retry); await retry.onclick(); assert.equal(reloaded.api.state().cameraRetry.clientScanId, item.clientScanId);
    let decoded = 0, recognized = 0; reloaded.decode = async () => { decoded++; return product.barcode; }; reloaded.recognize = async () => { recognized++; return 'ADIDAS BR 40'; };
    await reloaded.cameraClick('capture');
    assert.equal(decoded, 1); assert.equal(recognized, 1); assert.equal(reloaded.api.activeReads().length, 1);
    assert.equal(reloaded.api.activeReads()[0].clientScanId, item.clientScanId); assert.equal(reloaded.api.activeReads()[0].confirmedSize, ''); reloaded.api.closeCamera();
  });
  await test('manual capture directly retries an unresolved camera piece without needing a separate retry click', async () => {
    const h = harness(); await h.boot(); let lookups = 0;
    h.handler = () => ++lookups === 1 ? response({ error: 'Unknown code' }, 404) : response({ product });
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode }); const id = h.api.activeReads()[0].clientScanId;
    h.decode = async () => product.barcode; await h.cameraClick('capture');
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
    h.confirmDuplicate = () => question.promise; await h.cameraClick('next'); const recapturing = h.api.capture({ ean: product.barcode });
    await flush(); h.get('loja').value = stores[2].id; h.api.storeChanged(); question.resolve(true); await recapturing;
    assert.equal(original.scans.length, 1); assert.equal(original.scans[0].barcode, wrong); assert.equal(h.api.activeReads().length, 0);
    assert.equal(h.get('action-camera'), undefined); assert.ok(h.tracks.every(track => track.stopped));
  });
  await test('late lookup stays in its original store draft and account changes reject stale lookup data', async () => {
    const h = harness(); await h.boot(); const pending = deferred(); h.handler = () => pending.promise;
    const read = h.scan(product.barcode), original = h.api.state().currentDraft;
    h.get('loja').value = stores[2].id; h.api.storeChanged();
    pending.resolve(response({ product })); await read;
    assert.equal(h.api.activeReads().length, 0); assert.equal(original.scans.length, 1); assert.equal(original.scans[0].product.productSizeId, product.productSizeId);
    h.get('loja').value = stores[1].id; h.api.storeChanged(); assert.equal(h.api.activeReads().length, 1);
    const late = deferred(); h.handler = () => late.promise; const second = h.scan('7891234567888'), oldDraft = h.api.state().currentDraft;
    h.get('action-switch-user').onclick(); late.resolve(response({ product })); await second;
    assert.equal(h.api.activeReads().length, 0); assert.equal(oldDraft.scans[1].product, undefined);
    assert.match(oldDraft.scans[1].error, /conta mudou/); assert.equal(h.api.state().actor, null);
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
      h.handler = request => request.url.endsWith('/send-preview') ? response({ canTransfer: true, reviewToken: 'a'.repeat(64), scanCount: 1, items: [], blockers: [] }) : Promise.reject(Error('Network interrupted'));
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
    lookup.resolve(response({ product })); await scanning;
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, id);
    assert.equal(h.api.activeReads()[0].product.productSizeId, product.productSizeId);
    await h.api.resolveRead(h.api.state().currentDraft, h.api.activeReads()[0]);
    const reboundLookup = h.requests.filter(request => request.url.endsWith('/lookup')).at(-1);
    assert.equal(reboundLookup.body.transferId, receipts[0].id, 'Retries after binding use the selected shipment, including variants disabled after dispatch');
    assert.equal(h.api.activeReads().length, 1); await h.size('40');
    h.handler = request => request.url.endsWith('/receive-preview') ? response({ canReceive: true, reviewToken: 'c'.repeat(64), transfer: receipts[0], scanCount: 1, items: [], blockers: [] }) : response({ transfers: receipts });
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
  console.log('PASS: 29 action UI regression groups; isolated mocks only.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
