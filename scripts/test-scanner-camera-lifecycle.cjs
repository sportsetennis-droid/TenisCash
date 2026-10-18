'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../public/bipar.html'), 'utf8');
const source = html.slice(html.indexOf('  function etiqInventoryContext()'), html.indexOf('  // Mesma peça até o servidor confirmar'));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness({ slowPlay = false } = {}) {
  const nodes = new Map(), cameras = [], engines = [], captures = [], alerts = [], timers = new Map();
  const mode = { inventory: true, version: 1, round: 'round-a', name: 'Operador A' };
  let timerId = 0;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { id, value: id === 'loja' ? 'store-a' : id === 'vendedor' ? 'seller-a' : '', style: {}, textContent: '' });
    return nodes.get(id);
  }
  const playing = deferred();
  const video = node('etiq-video'); video.videoWidth = 1200; video.videoHeight = 800;
  video.play = () => slowPlay ? playing.promise : Promise.resolve();
  const window = { BiparActions: { isInventory: () => mode.inventory, version: () => mode.version, openCamera() {} },
    ScannerRound: { requireRound: store => { if (!mode.round || store !== node('loja').value) throw Error('no round'); return mode.round; } },
    ScannerView: { markup: () => '<video></video>' }, ScannerOCR: { recognize: async () => '' }, ScannerConfirm: { cancel() {} },
    ScannerCamera: { constraints: { audio: false, video: true }, warmup() {}, tune: async () => {}, snapshot: () => ({ width: 1200, height: 800 }), start(video, engine) { return { engine, stop() {} }; } },
    ScannerAuto: { create(options) { const engine = { options, stopped: false, ticks: 0, stop() { this.stopped = true; },
      tick() { this.ticks++; if (!this.stopped && options.canRead()) options.onCapture({ ean:'4006381333931', frame:options.snapshot() }); } }; engines.push(engine); return engine; },
      stopDecoder() {}, decodeInWorker: async () => '4006381333931' }, capturaAutomatica: prepared => captures.push(prepared) };
  const ZXing = { DecodeHintType: { POSSIBLE_FORMATS:1, TRY_HARDER:2 }, BarcodeFormat: {}, MultiFormatReader: class { setHints() {} } };
  window.ZXing = ZXing;
  const context = vm.createContext({ window, ZXing, Map, Promise, Object,
    document: { getElementById: id => id === 'etiq-overlay' ? nodes.get(id) || null : node(id),
      createElement(tag) { return { style: {}, width:0, height:0, getContext: () => ({ drawImage() {} }),
        remove() { if (nodes.get(this.id) === this) nodes.delete(this.id); } }; },
      body: { appendChild(element) { nodes.set(element.id, element); } } },
    navigator: { mediaDevices: { getUserMedia() { const wait = deferred(), track = { stopped:0, stop() { this.stopped++; }, getCapabilities: () => ({}) };
      const stream = { getTracks: () => [track], getVideoTracks: () => [track] }; cameras.push({ wait, stream, track }); return wait.promise; } } },
    localStorage: { getItem: () => mode.name }, STORAGE_VENDNAME:'name', alert: text => alerts.push(text),
    etiqRestorePromise: Promise.resolve(), etiqStorageReady:true, etiqStorageFailed:false, etiqSave:async()=>true,
    etiqCameraEpoch:0, etiqCameraContext:null, etiqStream:null, etiqReader:null, etiqAuto:null, etiqLoop:null, etiqPoll:null,
    etiqSendTimer:null, etiqWatch:null, etiqAtivo:null, etiqRetryAt:0, etiqIgnoredCode:'', etiqIgnoreUntil:0,
    etiqPausado:true, etiqLeituraArmada:false, etiqBusy:false, renderEtiqLista(){}, renderEtiqCaptureState(){}, consultarStatus(){}, enviarFila(){},
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  return { context, mode, nodes, node, window, cameras, engines, captures, alerts, playing };
}
async function flush() { for (let n = 0; n < 10; n++) await Promise.resolve(); }
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
(async () => {
  await test('authentication generation and display-name refresh do not strand an opening camera', async () => {
    const h = harness(), opened = h.window.fotografarEtiqueta(); await flush();
    assert.equal(h.cameras.length, 1); h.mode.version++; h.mode.name = 'Nome hidratado';
    h.cameras[0].wait.resolve(h.cameras[0].stream); await opened;
    assert.equal(h.engines.length, 1); assert.equal(h.captures.length, 0, 'opening the camera does not read before Próximo'); assert.equal(h.cameras[0].track.stopped, 0);
    assert.equal(h.engines[0].options.canRead(), false);
    assert.equal(h.captures.length, 0, 'opening the camera leaves scanning paused until Próximo');
    h.context.etiqBusy = true; assert.equal(h.engines[0].options.canRead(), false, 'a slow upload never bypasses the explicit Próximo click');
  });
  for (const changed of ['store', 'round', 'seller']) await test('real ' + changed + ' change during camera permission stops the stale stream and removes overlay', async () => {
    const h = harness(), opened = h.window.fotografarEtiqueta(); await flush();
    if (changed === 'store') h.node('loja').value = 'store-b';
    if (changed === 'round') h.mode.round = 'round-b';
    if (changed === 'seller') h.node('vendedor').value = 'seller-b';
    h.cameras[0].wait.resolve(h.cameras[0].stream); await opened;
    assert.equal(h.engines.length, 0); assert(h.cameras[0].track.stopped > 0); assert(!h.nodes.has('etiq-overlay'));
    assert.equal(h.captures.length, 0); assert.match(h.node('setup-status').textContent, /contexto mudou/);
  });
  await test('manual operator name is identity and cannot silently change during permission', async () => {
    const h = harness(); h.node('vendedor').value = '__manual__';
    const opened = h.window.fotografarEtiqueta(); await flush(); h.mode.name = 'Outro operador';
    h.cameras[0].wait.resolve(h.cameras[0].stream); await opened;
    assert.equal(h.engines.length, 0); assert(h.cameras[0].track.stopped > 0);
  });
  await test('closing before getUserMedia resolves never resurrects the camera', async () => {
    const h = harness(), opened = h.window.fotografarEtiqueta(); await flush(); h.window.fecharScanner();
    h.cameras[0].wait.resolve(h.cameras[0].stream); await opened;
    assert.equal(h.engines.length, 0); assert(h.cameras[0].track.stopped > 0); assert(!h.nodes.has('etiq-overlay'));
  });
  await test('two concurrent opens keep only the newest session even when the old permission resolves last', async () => {
    const h = harness(), first = h.window.fotografarEtiqueta(); await flush();
    const second = h.window.fotografarEtiqueta(); await flush(); assert.equal(h.cameras.length, 2);
    h.cameras[1].wait.resolve(h.cameras[1].stream); await second;
    const overlay = h.nodes.get('etiq-overlay'); h.cameras[0].wait.resolve(h.cameras[0].stream); await first;
    assert.equal(h.engines.length, 1); assert.equal(h.nodes.get('etiq-overlay'), overlay);
    assert(h.cameras[0].track.stopped > 0); assert.equal(h.cameras[1].track.stopped, 0); assert.equal(h.captures.length, 0);
  });
  await test('context change while video.play waits cannot start the engine', async () => {
    const h = harness({ slowPlay:true }), opened = h.window.fotografarEtiqueta(); await flush();
    h.cameras[0].wait.resolve(h.cameras[0].stream); await flush(); h.mode.round = 'round-b'; h.playing.resolve(); await opened;
    assert.equal(h.engines.length, 0); assert(h.cameras[0].track.stopped > 0); assert(!h.nodes.has('etiq-overlay'));
  });
  await test('late decoder callback after store change cannot create a scan under the new selection', async () => {
    const h = harness(), opened = h.window.fotografarEtiqueta(); await flush(); h.cameras[0].wait.resolve(h.cameras[0].stream); await opened;
    const before = h.captures.length; h.node('loja').value = 'store-b'; h.engines[0].options.onCapture({ ean:'5901234123457' });
    assert.equal(h.captures.length, before); assert(!h.nodes.has('etiq-overlay')); assert(h.cameras[0].track.stopped > 0);
  });
  await test('failed camera request leaves no dead overlay and the next open starts automatically', async () => {
    const h = harness(), failed = h.window.fotografarEtiqueta(); await flush(); h.cameras[0].wait.reject(Error('camera unavailable')); await failed;
    assert(!h.nodes.has('etiq-overlay')); assert.equal(h.alerts.length, 1);
    const retry = h.window.fotografarEtiqueta(); await flush(); h.cameras[1].wait.resolve(h.cameras[1].stream); await retry;
    assert.equal(h.engines.length, 1); assert.equal(h.captures.length, 0);
  });
  await test('no selected operator is explained before camera access instead of quarantining a new scan', async () => {
    const h = harness(); h.node('vendedor').value = ''; await h.window.fotografarEtiqueta();
    assert.equal(h.cameras.length, 0); assert.equal(h.engines.length, 0); assert(!h.nodes.has('etiq-overlay'));
    assert.match(h.alerts[0], /Selecione o vendedor/);
  });
  console.log('PASS ' + passed + ' camera lifecycle tests');
})().catch(error => { console.error(error); process.exitCode = 1; });
