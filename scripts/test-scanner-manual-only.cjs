'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch (_) { playwright = require('C:/Users/dougl/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const root = path.resolve(__dirname, '../public'), reads = [], photos = [], errors = [], results = [];
let releaseFirst, releaseSecond, releaseContext;
const first = new Promise(resolve => { releaseFirst = resolve; }), second = new Promise(resolve => { releaseSecond = resolve; }), context = new Promise(resolve => { releaseContext = resolve; });
const attempts = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/stocktake/stores') return res.end(JSON.stringify({ stores: [{ id: 'test-store', name: 'Teste' }] }));
    if (url.pathname === '/api/stocktake/sellers') return res.end('{"sellers":[]}');
    if (url.pathname === '/api/stocktake/rounds/current') return res.end('{"round":{"id":"test-round","status":"open"}}');
    if (url.pathname === '/api/stocktake/etiqueta-status') return res.end(JSON.stringify({ rows: [{ id: 'manual-cap',
      photoRevision: photos.at(-1)?.revision, complete: true, status: 'vinculado', barcode: photos.at(-1)?.barcode,
      bipeId: 'bipe-' + photos.at(-1)?.scan, mensagem: 'Foto salva. Aguardando leitura.', product: { name: 'Modelo confirmado', size: '35' } }] }));
    if (url.pathname === '/api/stocktake/recognize') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)); reads.push({ body, type: req.headers['content-type'] });
      if (body.barcode === '7900000000001') await first;
      if (body.barcode === '7900000000002') await second;
      if (body.barcode === '7900000000005') await context;
      const n = (attempts.get(body.clientScanId) || 0) + 1; attempts.set(body.clientScanId, n);
      if (body.barcode === '7900000000004' && n === 1) { res.statusCode = 503; return res.end('{"error":"temporary"}'); }
      return res.end(JSON.stringify({ ok: true, bipeId: 'bipe-' + body.clientScanId, barcode: body.barcode, complete: true, found: true,
        product: { name: 'Modelo de teste', size: '35' }, message: 'Modelo de teste · tam. 35', photoSaved: false }));
    }
    if (url.pathname === '/api/stocktake/etiqueta') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('latin1');
      const field = name => text.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)'))?.[1] || '';
      const photo = { scan: field('clientScanId'), revision: Number(field('photoRevision')), barcode: field('eanLocal') }; photos.push(photo);
      return res.end(JSON.stringify({ ok: true, capId: 'manual-cap', bipeId: 'bipe-' + photo.scan, photoSaved: true, photoRevision: photo.revision }));
    }
    return res.end('{}');
  }
  const file = path.join(root, url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript'); res.end(fs.readFileSync(file));
});
async function main() {
  assert.match(fs.readFileSync(path.join(root, 'bipar.html'), 'utf8'), /onCapture: prepared => \{ if \(cameraCurrent\(\)\) window\.capturaAutomatica\(prepared\); \}/);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = process.env.SCANNER_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await playwright[engine].launch(engine === 'webkit' ? { headless: true } : { channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/bipar.html');
    await page.evaluate(async () => {
      await etiqRestorePromise;
      window.__version = 1; window.BiparActions.isInventory = () => true; window.BiparActions.version = () => window.__version;
      window.ScannerRound.requireRound = () => 'test-round'; window.ScannerRound.id = () => 'test-round';
      document.getElementById('loja').innerHTML = '<option value="test-store">Teste</option>';
      document.getElementById('vendedor').innerHTML = '<option value="test-seller">Operador de teste</option>';
      localStorage.setItem('sports_tennis_bipar_vendedor_nome', 'Operador de teste');
      const overlay = document.createElement('div'); overlay.id = 'etiq-overlay'; overlay.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:black;z-index:99998';
      overlay.innerHTML = window.ScannerView.markup(); document.body.appendChild(overlay);
      const video = document.getElementById('etiq-video'); Object.defineProperty(video, 'videoWidth', { value: 800 }); Object.defineProperty(video, 'videoHeight', { value: 1200 });
      video.play = () => Promise.resolve(); window.__videoColor = '#ff0';
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) { if (source.id === 'etiq-video') { this.fillStyle = window.__videoColor; this.fillRect(0, 0, this.canvas.width, this.canvas.height); } else draw.call(this, source, ...args); };
      window.__ocr = []; window.ScannerOCR.readForScan = (image, barcode) => new Promise(resolve => window.__ocr.push({ resolve, barcode, automatic: typeof image !== 'string' }));
      window.__beeps = 0; etiqBeep = () => { window.__beeps++; };
      window.__autoResets = []; etiqAuto = { reset(options) { window.__autoResets.push(options); }, stop() {} };
      window.__auto = (code, text = '') => {
        const frame = document.createElement('canvas'); frame.width = 100; frame.height = 200;
        frame.getContext('2d').fillStyle = '#00c'; frame.getContext('2d').fillRect(0, 0, 100, 200);
        etiqRetryAt = 0; window.capturaAutomatica({ ean: code, frame, ocrText: text });
      };
      window.__photos = () => new Promise((resolve, reject) => {
        const open = indexedDB.open('teniscash-scanner-photos', 1); open.onerror = () => reject(open.error);
        open.onsuccess = () => { const op = open.result.transaction('photos').objectStore('photos').getAll(); op.onsuccess = () => { resolve(op.result); open.result.close(); }; };
      });
    });
    await page.evaluate(() => { window.__auto('', 'TPJW2604IN BR 35'); window.__auto('', 'TPJW2604IN BR 35'); });
    assert.equal(await page.evaluate(() => etiqFila.length), 0); assert.equal((await page.evaluate(() => window.__photos())).length, 0); assert.equal(reads.length, 0); assert.equal(photos.length, 0);
    results.push('automatic reference without barcode keeps reading without a saved photo or invented piece');
    await page.evaluate(() => window.__auto('7900000000001'));
    await page.waitForFunction(() => window.__ocr.length === 1);
    for (let i = 0; i < 200 && reads.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(reads.length, 1);
    const before = await page.evaluate(async () => ({ row: { ...etiqFila[0] }, photos: await window.__photos(), beeps: window.__beeps,
      active: etiqAtivo, paused: etiqPausado, panel: getComputedStyle(document.getElementById('etiq-confirm')).display,
      hint: document.getElementById('etiq-hint').textContent }));
    assert.equal(before.row.b64, null); assert.equal(before.row.autoRecognition, true); assert.equal(before.row.manualPhoto, false);
    assert.equal(before.photos.length, 0); assert.equal(before.beeps, 0); assert.equal(before.active, null); assert.equal(before.paused, false);
    assert.equal(before.panel, 'none'); assert.match(before.hint, /próxima etiqueta/);
    assert.equal(reads[0].type, 'application/json'); assert(!JSON.stringify(reads[0]).includes('data:image')); assert.equal(photos.length, 0);
    const firstId = before.row.clientScanId;
    await page.evaluate(() => window.__auto('7900000000002'));
    await page.waitForFunction(() => etiqFila.length === 2 && etiqFila[1].ean === '7900000000002');
    const queued = await page.evaluate(() => ({ ids: etiqFila.map(x => x.clientScanId), complete: etiqFila.map(x => x.complete), active: etiqAtivo }));
    assert.notEqual(queued.ids[0], queued.ids[1]); assert.deepEqual(queued.complete, [false, false]); assert.equal(queued.active, null);
    assert.equal(reads.length, 1, 'the second piece stays safely queued behind the in-flight server request');
    releaseFirst();
    for (let i = 0; i < 200 && !reads.some(x => x.body.barcode === '7900000000002'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(reads.some(x => x.body.barcode === '7900000000002'), 'queued second scan must reach server after the first acknowledgment');
    await page.waitForFunction(() => etiqFila[0]?.complete && etiqBusy);
    assert.equal(await page.evaluate(() => etiqFila[0].clientScanId), firstId);
    assert.equal(await page.evaluate(() => document.getElementById('etiq-confirm').style.display), 'none');
    assert.equal(await page.evaluate(() => window.__beeps), 0); assert.equal((await page.evaluate(() => window.__photos())).length, 0);
    releaseSecond(); await page.waitForFunction(() => etiqFila[1]?.complete && !etiqBusy);
    assert.equal(await page.evaluate(() => etiqFila.every(x => x.complete)), true);
    assert.equal(await page.evaluate(() => etiqFila.map(x => x.product.size).join(',')), '35,35');
    assert.equal(await page.evaluate(() => document.getElementById('etiq-confirm').style.display), 'none');
    results.push('two metadata-only scans advance immediately, queue sequentially, and confirm product/size in the background without a modal or photo');
    await page.evaluate(() => { window.__videoColor = '#ff0'; window.capturaManual(); });
    await page.waitForFunction(() => etiqFila.length === 3 && etiqFila[2].manualPhoto && etiqFila[2].capId === 'manual-cap');
    const manual = await page.evaluate(async () => ({ row: { ...etiqFila[2] }, photos: await window.__photos(), preview: document.getElementById('etiq-photo-preview').src,
      status: document.getElementById('etiq-confirm-status').textContent }));
    assert.equal(manual.row.manualPhoto, true); assert.equal(manual.photos.length, 1); assert.equal(manual.preview, manual.row.b64);
    assert.equal(manual.status, '✓ FOTO SALVA');
    const pixel = await page.evaluate(async b64 => { const image = new Image(); await new Promise(resolve => { image.onload = resolve; image.src = b64; }); const c = document.createElement('canvas'); c.width = c.height = 1; c.getContext('2d').drawImage(image, 0, 0, 1, 1); return [...c.getContext('2d').getImageData(0, 0, 1, 1).data]; }, manual.row.b64);
    assert(pixel[0] > 240 && pixel[1] > 240 && pixel[2] < 20, 'manual button stores the exact frame at the tap');
    results.push('manual button still saves the frame only when explicitly tapped');
    assert.deepEqual(errors, []); results.forEach(name => console.log('PASS: ' + name));
  } finally { releaseFirst(); releaseSecond(); releaseContext(); await browser.close(); }
}
main().then(() => server.close()).catch(error => { console.error(error); server.close(); process.exitCode = 1; });
