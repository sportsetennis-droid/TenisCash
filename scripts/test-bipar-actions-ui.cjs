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
    constructor(tag = 'div', id = '') { this.tagName = tag.toUpperCase(); this.id = id; this._value = ''; this.children = []; this.events = {}; this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.textContent = ''; this.classList = { toggle() {}, add() {}, remove() {} }; }
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
    get: id => nodes.get(id), handler: null, play: async () => {}, confirmDuplicate: async () => true };
  const window = { addEventListener() {}, ScannerTransfer: { refresh() {} }, ScannerConfirm: { ask: text => h.confirmDuplicate(text) },
    ScannerView: { markup: () => '__SCANNER__' }, ScannerOCR: { recognize: async () => '' },
    ScannerAuto: { stopDecoder() {}, decodeInWorker: async () => '', create(options) { const scanner = { options, resets: [], stopped: false, tick() {}, reset(value) { this.resets.push(value); }, stop() { this.stopped = true; } }; scannerInstances.push(scanner); return scanner; } },
    fecharScanner() {} };
  const context = vm.createContext({ window, document, localStorage, sessionStorage, console, crypto: { randomUUID }, AbortController,
    navigator: { mediaDevices: { getUserMedia: async () => { const track = { stopped: false, stop() { this.stopped = true; } }; tracks.push(track); return { getTracks: () => [track] }; } } },
    Option: function(text, value) { const option = new Element('option'); option.textContent = text; option.value = value; return option; },
    confirm: () => true, setTimeout: () => nextTimer++, clearTimeout() {}, setInterval: fn => { const id = nextTimer++; intervals.set(id, fn); return id; }, clearInterval: id => intervals.delete(id),
    fetch: async (url, options = {}) => {
      assert.ok(url.startsWith('/api/scan-transfers/actions'), 'New action must never call inventory or an external endpoint: ' + url);
      const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, auth: options.headers?.Authorization };
      requests.push(request);
      if (url.endsWith('/context')) return response({ user: person, stores, allowedStoreIds: [stores[0].id, stores[1].id] });
      if (h.handler) return h.handler(request);
      if (url.endsWith('/lookup')) return response({ product, requiresSizeConfirmation: true });
      throw Error('Unexpected isolated request: ' + url);
    } });
  const exportCode = 'window.__test = { authenticate, openCamera, closeCamera, capture, resolveRead, activeReads, scansPayload, contextChanged, storeChanged, prepare, confirmAction, persist, signature, state:()=>({actor,currentDraft,preview,cameraRead,busy,stream,scanner,generation}) };';
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
  await test('camera identification retry preserves one scan ID; a known barcode still needs this piece size', async () => {
    const h = harness(); await h.boot(); let lookups = 0;
    h.handler = request => { assert.ok(request.url.endsWith('/lookup')); return ++lookups === 1 ? response({ error: 'Try again' }, 503) : response({ product }); };
    await h.api.openCamera(); await h.api.capture({ ean: product.barcode });
    const firstId = h.api.activeReads()[0].clientScanId;
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].product, undefined);
    await h.cameraClick('next');
    assert.equal(lookups, 2); assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].clientScanId, firstId);
    assert.equal(h.get('etiq-confirm-btn').disabled, true); assert.equal(h.api.activeReads()[0].confirmedSize, '');
    const size = h.get('action-camera-size'); size.value = '40'; await size.emit('input');
    assert.equal(h.get('etiq-confirm-btn').disabled, false); await h.cameraClick('next');
    assert.equal(h.api.activeReads().length, 1); assert.equal(h.api.activeReads()[0].confirmedSize, '40');
    assert.equal(h.api.state().cameraRead, null); h.api.closeCamera();
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
    const h = harness(); await h.boot(); await h.scan(product.barcode); await h.size('40');
    h.handler = request => request.url.endsWith('/send-preview') ? response({ canTransfer: true, reviewToken: 'a'.repeat(64), scanCount: 1, items: [], blockers: [] }) : Promise.reject(Error('Network interrupted'));
    await h.api.prepare(); h.get('action-approved').checked = true; await h.api.confirmAction();
    const pending = JSON.parse(h.localStorage.getItem(pendingKey)); assert.ok(pending?.body.requestId);
    assert.equal(h.api.activeReads().length, 1); const firstRequest = h.requests.find(request => request.url.endsWith('/send-confirm'));
    const reloaded = harness(h.localStorage); await reloaded.boot();
    assert.equal(reloaded.api.activeReads().length, 1);
    reloaded.handler = request => { assert.deepEqual(request.body, firstRequest.body); return response({ transfer: { id: request.body.requestId, code: 123, qtyTotal: 1, status: 'in_transit' }, alreadySaved: true }); };
    await reloaded.api.confirmAction(true);
    assert.equal(reloaded.localStorage.getItem(pendingKey), null); assert.equal(reloaded.api.activeReads().length, 0);
    assert.match(reloaded.get('action-result').textContent, /aguardando conferência no destino/);
    assert.equal(reloaded.requests.filter(request => request.url.endsWith('/send-confirm')).length, 1);
  });
  await test('late preview from a different context cannot enable confirmation', async () => {
    const h = harness(); await h.boot(); await h.scan(product.barcode); await h.size('40'); const pending = deferred(); h.handler = () => pending.promise;
    const preparing = h.api.prepare(); h.get('loja').value = stores[2].id; h.api.storeChanged();
    pending.resolve(response({ canTransfer: true, reviewToken: 'b'.repeat(64), scanCount: 1, items: [], blockers: [] })); await preparing;
    assert.equal(h.api.state().preview, null); assert.equal(h.get('action-confirm').disabled, true);
    assert.equal(h.requests.filter(request => request.url.endsWith('/send-confirm')).length, 0);
  });
  console.log('PASS: 7 action UI regression groups; isolated mocks only.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
