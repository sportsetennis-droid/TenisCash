'use strict';
// Real browser, isolated localhost storage. No accounts or production endpoints.
// Set PLAYWRIGHT_MODULE when Playwright is supplied by an external test runtime.
// SCANNER_TEST_BROWSER=webkit runs the same cases in WebKit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../public/scanner-photo-storage.js'), 'utf8');
let browser, server;
(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', req.url === '/store.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/store.js' ? source : '<!doctype html><script src="/store.js"></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const engine = process.env.SCANNER_TEST_BROWSER || 'chromium';
  browser = await playwright[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chrome' } : {}) });
  for (const scenario of ['close-event', 'silent-close', 'stale-callbacks', 'synchronous-open-failure']) {
    const context = await browser.newContext();
    try {
      await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
      const page = await context.newPage();
      await page.goto(origin);
      const result = await page.evaluate(async scenario => {
        const connections = [];
        let opens = 0;
        const wrapped = { open(...args) {
          opens++;
          if (scenario === 'synchronous-open-failure' && opens === 1) throw new DOMException('Synthetic initial open failure', 'UnknownError');
          const request = indexedDB.open(...args);
          request.addEventListener('success', () => connections.push(request.result));
          return request;
        } };
        const store = ScannerPhotoStorage.create({ indexedDB: wrapped });
        const row = { clientScanId: 'physical-A', roundId: 'local-round', ean: '7900000000001', b64: 'data:image/jpeg;base64,QUJD', st: 'fila' };
        let firstFailure = null;
        if (scenario === 'synchronous-open-failure') {
          try { await store.append(store.identity(row), row); }
          catch (error) { firstFailure = error.name; }
        }
        await store.append(store.identity(row), row);
        const old = connections[0], oldClose = old.onclose, oldVersion = old.onversionchange;
        if (scenario !== 'synchronous-open-failure') {
          old.close();
          if (scenario === 'close-event') old.dispatchEvent(new Event('close'));
        }
        const recovered = await store.read();
        const reopened = connections[connections.length - 1];
        const opensBeforeStale = opens;
        if (scenario === 'stale-callbacks') {
          oldClose(new Event('close'));
          oldVersion(new Event('versionchange'));
        }
        const second = { ...row, clientScanId: 'physical-B' };
        await store.append(store.identity(second), second);
        const final = await store.read();
        return { firstFailure, opens, opensBeforeStale, closeHandler: typeof reopened.onclose,
          recovered: recovered.map(item => ({ id: item.clientScanId, b64: item.b64 })),
          final: final.map(item => ({ id: item.clientScanId, ean: item.ean, b64: item.b64 })) };
      }, scenario);
      assert.deepEqual(result.recovered, [{ id: 'physical-A', b64: 'data:image/jpeg;base64,QUJD' }]);
      assert.deepEqual(result.final.map(item => item.id).sort(), ['physical-A', 'physical-B']);
      assert.ok(result.final.every(item => item.ean === '7900000000001' && item.b64 === 'data:image/jpeg;base64,QUJD'));
      assert.equal(result.closeHandler, 'function');
      assert.equal(result.opens, 2);
      if (scenario === 'stale-callbacks') assert.equal(result.opens, result.opensBeforeStale);
      if (scenario === 'synchronous-open-failure') assert.equal(result.firstFailure, 'UnknownError');
      console.log('PASS ' + scenario + ': photo and physical IDs preserved; repeated EAN remains two pieces');
    } finally { await context.close(); }
  }
  console.log('PASS ' + engine + ' ' + await browser.version() + ': 4 connection recovery scenarios');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
