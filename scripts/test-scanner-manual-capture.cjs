'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch (_) { playwright = require('C:/Users/dougl/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const uploads = [], results = [], errors = [];
let releaseFirst;
const firstReply = new Promise(resolve => { releaseFirst = resolve; });
const root = path.resolve(__dirname, '../public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/stocktake/stores') return res.end(JSON.stringify({ stores: [{ id: 'test-store', code: 'TEST', name: 'Loja de teste' }] }));
    if (url.pathname === '/api/stocktake/sellers') return res.end(JSON.stringify({ sellers: [] }));
    if (url.pathname === '/api/stocktake/rounds/current') return res.end(JSON.stringify({ round: { id: 'test-round', status: 'open' } }));
    if (url.pathname === '/api/stocktake/etiqueta-status') return res.end(JSON.stringify({ rows: [{ id: 'test-cap', photoRevision: 1, complete: true, barcode: 'STALE-CODE', status: 'vinculado' }] }));
    if (url.pathname === '/api/stocktake/etiqueta') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('latin1');
      const field = name => body.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)'))?.[1] || '';
      const entry = { revision: Number(field('photoRevision')), scan: field('clientScanId'), ean: field('eanLocal'), ocr: field('ocrText') }; uploads.push(entry);
      if (uploads.length === 1) await firstReply;
      return res.end(JSON.stringify({ capId: 'test-cap', photoSaved: true, salvo: true, photoRevision: entry.revision, barcodeRequired: !entry.ean }));
    }
    return res.end('{}');
  }
  const file = path.join(root, url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript'); res.end(fs.readFileSync(file));
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const engine = process.env.SCANNER_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await playwright[engine].launch(engine === 'webkit' ? { headless: true } : { channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port + '/bipar.html');
    await page.evaluate(async () => {
      await etiqRestorePromise;
      window.BiparActions.isInventory = () => true; window.BiparActions.version = () => 1;
      window.ScannerRound.requireRound = () => 'test-round'; window.ScannerRound.id = () => 'test-round';
      const store = document.getElementById('loja'); store.innerHTML = '<option value="test-store">Teste</option>'; store.value = 'test-store';
      const overlay = document.createElement('div'); overlay.id = 'etiq-overlay'; overlay.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:black;z-index:99998'; overlay.innerHTML = window.ScannerView.markup(); document.body.appendChild(overlay);
      const video = document.getElementById('etiq-video'); Object.defineProperty(video, 'videoWidth', { value: 800 }); Object.defineProperty(video, 'videoHeight', { value: 1200 }); video.play = () => Promise.resolve();
      window.__frame = '#c00'; const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) { if (source.id === 'etiq-video') { this.fillStyle = window.__frame; this.fillRect(0, 0, this.canvas.width, this.canvas.height); } else draw.call(this, source, ...args); };
      window.__ocr = []; window.ScannerOCR.readForScan = () => new Promise(resolve => window.__ocr.push(resolve));
      etiqAuto = { reset() {}, stop() {} }; etiqBusy = true;
    });
    await page.locator('#etiq-capturar').click();
    const first = await page.evaluate(async () => { await etiqSave.queue; return { item: { ...etiqFila[0] }, saved: etiqPhotoDurable(etiqFila[0]), text: document.getElementById('etiq-confirm-status').textContent, skip: !!document.getElementById('etiq-skip-unreadable'), preview: document.getElementById('etiq-photo-preview').src, counter: document.getElementById('etiq-contador').textContent }; });
    assert.equal(first.saved, true); assert.equal(first.item.ean, ''); assert.equal(first.item.photoRevision, 1); assert.equal(first.skip, false); assert.equal(first.preview, first.item.b64); assert.equal(first.text, '✓ FOTO SALVA');
    assert.equal(first.counter, 'fotos salvas 1 · enviadas 0 · peças identificadas 0');
    results.push('manual tap during busy state immediately saves the exact image without EAN and shows its durable preview');
    await page.evaluate(() => { etiqBusy = false; window.__upload1 = enviarFila(); });
    await page.waitForFunction(() => window.__ocr.length === 1);
    assert.equal(uploads.length, 1); assert.equal(uploads[0].ean, '');
    results.push('image upload starts without awaiting unresolved OCR');
    await page.evaluate(() => { window.__frame = '#00c'; }); await page.locator('#etiq-capturar').click();
    const second = await page.evaluate(async () => { await etiqSave.queue; return { item: { ...etiqFila[0] }, saved: etiqPhotoDurable(etiqFila[0]), count: etiqFila.length, busy: etiqBusy }; });
    assert.equal(second.count, 1); assert.equal(second.item.clientScanId, first.item.clientScanId); assert.equal(second.item.photoRevision, 2); assert.notEqual(second.item.b64, first.item.b64); assert.equal(second.saved, true); assert.equal(second.busy, true);
    results.push('recapture during pending HTTP preserves the same physical ID and saves a different revision');
    await page.locator('#etiq-controls [data-click="close"]').click();
    assert.equal(await page.locator('#etiq-overlay').count(), 0);
    await page.evaluate(() => { window.__ocr[0]('OLD OCR MUST NOT WIN'); }); releaseFirst(); await page.evaluate(() => window.__upload1);
    const afterOld = await page.evaluate(() => ({ ocr: etiqFila[0].ocrText, cap: etiqFila[0].capId, revision: etiqFila[0].photoRevision }));
    assert.equal(afterOld.ocr, ''); assert.equal(afterOld.cap, undefined); assert.equal(afterOld.revision, 2);
    // No camera and no explicit send call: the second revision must leave the
    // durable outbox automatically when the first request releases its lock.
    await page.waitForFunction(() => etiqFila[0].capIdPhotoRevision === 2);
    assert.equal(uploads.length, 2); assert.equal(uploads[0].scan, uploads[1].scan); assert.equal(uploads[1].revision, 2);
    results.push('closing during an earlier upload still sends the newer revision automatically with the same physical ID');
    const uploaded = await page.evaluate(async () => { await etiqSave.queue; return { ...etiqFila[0] }; });
    assert.equal(uploaded.capId, 'test-cap'); assert.equal(uploaded.capIdPhotoRevision, 2); assert.equal(uploaded.st, 'pendente'); assert.equal(uploaded.complete, false);
    await page.evaluate(() => consultarStatus());
    const polled = await page.evaluate(() => ({ complete: etiqFila[0].complete, code: etiqFila[0].ean }));
    assert.equal(polled.complete, false); assert.equal(polled.code, '');
    results.push('stale OCR, upload acknowledgement and status cannot identify or overwrite the newer frame');
    await page.evaluate(() => {
      const overlay = document.createElement('div'); overlay.id = 'etiq-overlay'; overlay.style.cssText = 'position:fixed;inset:0;display:flex;flex-direction:column;background:black;z-index:99998'; overlay.innerHTML = window.ScannerView.markup(); document.body.appendChild(overlay);
      etiqAtivo = etiqFila[0].lid; etiqAuto = { reset() {}, stop() {} }; renderEtiqCaptureState();
    });
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const visible = await page.evaluate(() => {
        renderEtiqCaptureState(); const photo = document.getElementById('etiq-photo-preview'), detail = document.getElementById('etiq-confirm-det'), box = photo.getBoundingClientRect();
        return { display: getComputedStyle(photo).display, detail: getComputedStyle(detail).display, width: box.width, height: box.height, top: box.top, bottom: box.bottom, viewport: innerHeight, pendingNext: document.getElementById('etiq-confirm-btn').disabled };
      });
      assert.notEqual(visible.display, 'none'); assert.notEqual(visible.detail, 'none'); assert(visible.width > 0 && visible.height > 0 && visible.top >= 0 && visible.bottom <= visible.viewport); assert.equal(visible.pendingNext, true);
    }
    results.push('saved preview and pending explanation remain visible in portrait and landscape');
    await page.reload(); await page.evaluate(() => etiqRestorePromise);
    const restored = await page.evaluate(async () => {
      const row = etiqFila[0]; const open = indexedDB.open('teniscash-scanner-photos', 1);
      const photos = await new Promise((resolve, reject) => { open.onsuccess = () => { const op = open.result.transaction('photos').objectStore('photos').getAll(); op.onsuccess = () => { resolve(op.result.map(x => x.b64)); open.result.close(); }; op.onerror = () => reject(op.error); }; });
      return { row, photos };
    });
    assert.equal(restored.row.clientScanId, first.item.clientScanId); assert.equal(restored.row.photoRevision, 2); assert.equal(restored.row.b64, second.item.b64); assert(restored.photos.includes(first.item.b64)); assert(restored.photos.includes(second.item.b64));
    results.push('reload restores the current pending image and both original revisions remain on disk');
    await page.evaluate(() => {
      window.BiparActions.isInventory = () => true; window.ScannerRound.requireRound = () => 'test-round'; window.ScannerRound.id = () => 'test-round';
      const overlay = document.createElement('div'); overlay.id = 'etiq-overlay'; overlay.innerHTML = window.ScannerView.markup(); document.body.appendChild(overlay);
      const video = document.getElementById('etiq-video'); Object.defineProperty(video, 'videoWidth', { value: 800 }); Object.defineProperty(video, 'videoHeight', { value: 1200 });
      CanvasRenderingContext2D.prototype.drawImage = function () { this.fillStyle = '#ff0'; this.fillRect(0, 0, this.canvas.width, this.canvas.height); };
      etiqAtivo = etiqFila[0].lid; etiqAuto = { reset() {}, stop() {} }; etiqBusy = true;
      window.__realAppend = etiqPhotoStorage.append; etiqPhotoStorage.append = async () => { throw Error('Synthetic quota failure'); };
      window.capturaManual();
    });
    const failed = await page.evaluate(async () => { await etiqSave.queue; return { failed: etiqStorageFailed, durable: etiqPhotoDurable(etiqFila[0]), pending: etiqPendingFrames.length, text: document.getElementById('etiq-confirm-status').textContent }; });
    assert.equal(failed.failed, true); assert.equal(failed.durable, false); assert.equal(failed.pending, 1); assert.equal(failed.text, 'FOTO AGUARDANDO SALVAMENTO');
    const retried = await page.evaluate(async () => { etiqPhotoStorage.append = window.__realAppend; await etiqSave(); return { failed: etiqStorageFailed, durable: etiqPhotoDurable(etiqFila[0]), pending: etiqPendingFrames.length, id: etiqFila[0].clientScanId, revision: etiqFila[0].photoRevision, count: etiqFila.length }; });
    assert.equal(retried.failed, false); assert.equal(retried.durable, true); assert.equal(retried.pending, 0); assert.equal(retried.id, first.item.clientScanId); assert.equal(retried.revision, 3); assert.equal(retried.count, 1);
    results.push('failed persistence preserves the unsaved frame without a false success and retry commits it with the same physical ID');
    assert.deepEqual(errors, []);
    for (const name of results) console.log('PASS: ' + name);
  } finally { releaseFirst(); await browser.close(); }
}
main().then(() => server.close()).catch(error => { console.error(error); server.close(); process.exitCode = 1; });
