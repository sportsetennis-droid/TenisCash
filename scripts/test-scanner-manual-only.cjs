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
  assert(fs.readFileSync(path.join(root, 'bipar.html'), 'utf8').includes('onCapture: prepared => window.capturaAutomatica(prepared)'));
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
      const overlay = document.createElement('div'); overlay.id = 'etiq-overlay'; overlay.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:black;z-index:99998';
      overlay.innerHTML = window.ScannerView.markup(); document.body.appendChild(overlay);
      const video = document.getElementById('etiq-video'); Object.defineProperty(video, 'videoWidth', { value: 800 }); Object.defineProperty(video, 'videoHeight', { value: 1200 });
      video.play = () => Promise.resolve(); window.__videoColor = '#ff0';
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) { if (source.id === 'etiq-video') { this.fillStyle = window.__videoColor; this.fillRect(0, 0, this.canvas.width, this.canvas.height); } else draw.call(this, source, ...args); };
      window.__ocr = []; window.ScannerOCR.readForScan = (image, barcode) => new Promise(resolve => window.__ocr.push({ resolve, barcode, automatic: typeof image !== 'string' }));
      window.__beeps = 0; etiqBeep = () => { window.__beeps++; };
      etiqAuto = { reset() {}, stop() {} };
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
    const before = await page.evaluate(async () => ({ row: { ...etiqFila[0] }, photos: await window.__photos(), beeps: window.__beeps, status: document.getElementById('etiq-confirm-status').textContent }));
    assert.equal(before.row.b64, null); assert.equal(before.row.autoRecognition, true); assert.equal(before.row.manualPhoto, false); assert.equal(before.photos.length, 0); assert.equal(before.beeps, 0); assert(!before.status.includes('FOTO'));
    assert.equal(reads[0].type, 'application/json'); assert(!JSON.stringify(reads[0]).includes('data:image')); assert.equal(photos.length, 0);
    releaseFirst(); await page.waitForFunction(() => etiqFila[0]?.complete && !etiqBusy && document.getElementById('etiq-confirm-status').textContent === '✅ LEITURA COMPLETA');
    assert.equal(await page.evaluate(() => window.__beeps), 1); assert.equal((await page.evaluate(() => window.__photos())).length, 0);
    results.push('automatic barcode posts metadata only, displays recognition and beeps only after confirmed product and size');
    await page.evaluate(() => { window.proximaEtiqueta(); window.__auto('7900000000002'); });
    await page.waitForFunction(() => window.__ocr.some(x => x.barcode === '7900000000002'));
    const autoId = await page.evaluate(() => etiqFila[1].clientScanId);
    await page.locator('#etiq-capturar').click(); await page.evaluate(() => etiqSave.queue);
    const promoted = await page.evaluate(async () => ({ row: { ...etiqFila[1] }, count: etiqFila.length, photos: await window.__photos(), preview: document.getElementById('etiq-photo-preview').src }));
    assert.equal(promoted.count, 2); assert.equal(promoted.row.clientScanId, autoId); assert.equal(promoted.row.manualPhoto, true); assert.equal(promoted.row.autoRecognition, false); assert.equal(promoted.photos.length, 1); assert.equal(promoted.preview, promoted.row.b64);
    const pixel = await page.evaluate(async b64 => { const image = new Image(); await new Promise(resolve => { image.onload = resolve; image.src = b64; }); const c = document.createElement('canvas'); c.width = c.height = 1; c.getContext('2d').drawImage(image, 0, 0, 1, 1); return [...c.getContext('2d').getImageData(0, 0, 1, 1).data]; }, promoted.row.b64);
    assert(pixel[0] > 240 && pixel[1] > 240 && pixel[2] < 20, 'manual image must show yellow frame at tap, not earlier blue automatic frame');
    await page.evaluate(() => window.__ocr.find(x => x.barcode === '7900000000002').resolve('STALE AUTO OCR'));
    releaseSecond(); await page.waitForFunction(() => etiqFila[1]?.capId === 'manual-cap');
    const after = await page.evaluate(() => ({ ...etiqFila[1] }));
    assert.equal(after.complete, false); assert.equal(after.ocrText, ''); assert.equal(after.b64, promoted.row.b64); assert.equal(photos[0].scan, autoId);
    results.push('manual during automatic HTTP saves the exact tap frame under the same scan ID and ignores old automatic OCR and ACK');
    await page.evaluate(() => { etiqFila[1].st = 'pendente'; window.__auto('7900000000002', 'TPJW2604IN BR 35'); });
    await page.evaluate(() => etiqSave.queue);
    assert.equal(await page.evaluate(() => etiqFila[1].b64), promoted.row.b64); assert.equal((await page.evaluate(() => window.__photos())).length, 1);
    await page.waitForFunction(() => !etiqBusy);
    await page.evaluate(async () => { await consultarStatus(); renderEtiqCaptureState(); });
    assert.equal(await page.locator('#etiq-confirm-det').textContent(), 'Modelo confirmado · tam. 35');
    assert.equal(await page.locator('#etiq-confirm-status').textContent(), '✅ LEITURA COMPLETA');
    results.push('a completed manual status uses its confirmed product and size instead of an old pending capture note');
    await page.evaluate(() => { window.proximaEtiqueta(); window.__auto('7900000000003'); });
    await page.waitForFunction(() => etiqFila[2]?.complete && !etiqBusy && document.getElementById('etiq-confirm-status').textContent === '✅ LEITURA COMPLETA');
    const next = await page.evaluate(async () => ({ row: { ...etiqFila[2] }, hidden: getComputedStyle(document.getElementById('etiq-photo-preview')).display, photos: await window.__photos(), text: document.getElementById('etiq-confirm-status').textContent }));
    assert.equal(next.row.b64, null); assert.equal(next.hidden, 'none'); assert.equal(next.photos.length, 1); assert.equal(next.text, '✅ LEITURA COMPLETA');
    results.push('automatic recognition after a manual piece does not inherit the preview or save another photograph');
    await page.locator('#etiq-capturar').click(); await page.evaluate(() => etiqSave.queue);
    const completedPromotion = await page.evaluate(() => ({ id: etiqFila[2].clientScanId, manual: etiqFila[2].manualPhoto, count: etiqFila.length }));
    assert.equal(completedPromotion.id, next.row.clientScanId); assert.equal(completedPromotion.manual, true); assert.equal(completedPromotion.count, 3);
    await page.waitForFunction(() => !etiqBusy);
    results.push('manual tap also saves an already identified automatic piece using the same scan identity');
    await page.evaluate(() => { etiqFila[2].complete = true; window.proximaEtiqueta(); window.__auto('7900000000004'); });
    await page.waitForFunction(() => etiqFila[3]?.complete && !etiqBusy);
    const retries = reads.filter(x => x.body.barcode === '7900000000004'); assert.equal(retries.length, 2); assert.equal(retries[0].body.clientScanId, retries[1].body.clientScanId);
    results.push('temporary automatic network failure retries the same metadata-only scan without another photo or physical ID');
    await page.evaluate(() => { window.proximaEtiqueta(); window.__auto('7900000000005'); });
    await page.waitForFunction(() => window.__ocr.some(x => x.barcode === '7900000000005'));
    await page.evaluate(() => { window.__version++; }); releaseContext(); await page.waitForFunction(() => !etiqBusy);
    assert.equal(await page.evaluate(() => etiqFila[4].complete), false);
    results.push('automatic response after an action-context change cannot update the newer screen state');
    assert.deepEqual(errors, []); results.forEach(name => console.log('PASS: ' + name));
  } finally { releaseFirst(); releaseSecond(); releaseContext(); await browser.close(); }
}
main().then(() => server.close()).catch(error => { console.error(error); server.close(); process.exitCode = 1; });
