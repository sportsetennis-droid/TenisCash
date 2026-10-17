'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
let pw; try { pw = require('playwright'); } catch (_) { pw = require('C:/Users/dougl/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
const root = path.resolve(__dirname, '../public'), results = [], unexpected = [];
let workerMode = 'normal';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' || url.pathname.startsWith('/api/')) { unexpected.push({ method: req.method, path: url.pathname }); res.statusCode = 403; return res.end(); }
  if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); return res.end('<!doctype html><script src="/vendor/barcode/zxing-reader-3.1.4.js"></script><script src="/scanner-regions.js"></script><script src="/scanner-auto.js"></script>'); }
  if (url.pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
  const file = path.join(root, url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  let contents = fs.readFileSync(file);
  if (url.pathname === '/scanner-barcode-worker.js') {
    if (workerMode === 'no-canvas') contents = 'self.OffscreenCanvas=undefined;self.ImageData=undefined;\n' + contents;
    if (workerMode === 'throw') contents = 'throw Error("Synthetic worker initialization failure");';
    if (workerMode === 'error') contents = 'self.onmessage=({data})=>self.postMessage({id:data.id,error:"Synthetic decoder failure"});';
    if (workerMode === 'stall') contents = 'self.onmessage=()=>{};';
    if (workerMode === 'late') contents = 'self.postMessage({ready:true});self.onmessage=({data})=>setTimeout(()=>self.postMessage({id:data.id,code:"7900373256192"}),200);';
    if (workerMode === 'idle-error') contents = contents + '\nconst originalMessage=self.onmessage;self.onmessage=async event=>{await originalMessage(event);setTimeout(()=>{throw Error("Synthetic idle failure")},40);};';
  }
  res.end(contents);
});
async function installFixtures(page) {
  await page.evaluate(() => {
    const left = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    const even = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
    const right = left.map(v => v.replace(/[01]/g, c => c === '0' ? '1' : '0'));
    function draw(ctx, code, x, y, height) {
      const pattern = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'][+code[0]];
      const bits = '101' + [...code.slice(1,7)].map((d,i) => (pattern[i] === 'L' ? left : even)[+d]).join('') + '01010' + [...code.slice(7)].map(d => right[+d]).join('') + '101';
      ctx.fillStyle = 'black'; [...bits].forEach((b,i) => { if (b === '1') ctx.fillRect(x + i * 4, y, 4, height); });
    }
    window.frame = kind => {
      const c = document.createElement('canvas'); c.width = kind === 'multiple' ? 1000 : 720; c.height = kind === 'multiple' ? 800 : 420;
      const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0,0,c.width,c.height);
      if (kind === 'multiple') { draw(ctx,'2922791600581',310,150,180); draw(ctx,'7900373256192',310,460,180); }
      else if (kind !== 'none') draw(ctx,'2922791600581',170,70,270);
      if (kind !== 'portrait') return c;
      const turned = document.createElement('canvas'); turned.width = 420; turned.height = 720;
      const t = turned.getContext('2d'); t.translate(210,360); t.rotate(Math.PI/2); t.drawImage(c,-360,-210); return turned;
    };
  });
}
async function main() {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const engine = process.env.SCANNER_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
  const browser = await pw[engine].launch(engine === 'webkit' ? { headless: true } : { headless: true, channel: 'chrome' });
  try {
    const page = await browser.newPage();
    const open = async mode => { workerMode = mode; await page.goto('http://127.0.0.1:' + server.address().port + '/'); await installFixtures(page); };
    await open('normal');
    for (const kind of ['landscape','portrait','none','multiple']) {
      const result = await page.evaluate(async kind => ({ code: await ScannerAuto.decodeInWorker(frame(kind)), state: ScannerAuto.decoderStatus(), offscreen: typeof OffscreenCanvas }),kind);
      assert.equal(result.code,kind === 'none' || kind === 'multiple' ? '' : '2922791600581');
      assert.equal(result.state.method,'worker'); assert.equal(result.state.ready,true);
      results.push('real WASM worker: ' + kind + ', OffscreenCanvas=' + result.offscreen);
    }
    await open('no-canvas');
    const noCanvas = await page.evaluate(async () => ({ code: await ScannerAuto.decodeInWorker(frame('portrait')), state: ScannerAuto.decoderStatus() }));
    assert.equal(noCanvas.code,'2922791600581'); assert.equal(noCanvas.state.method,'worker');
    results.push('worker reads without either OffscreenCanvas or ImageData constructors');
    await open('idle-error');
    assert.equal(await page.evaluate(() => ScannerAuto.decodeInWorker(frame('landscape'))),'2922791600581');
    await page.waitForFunction(() => !!ScannerAuto.decoderStatus().error);
    const idleRecovered = await page.evaluate(async () => { const start = Date.now(); const code = await ScannerAuto.decodeInWorker(frame('landscape')); return { code, elapsed: Date.now() - start, state: ScannerAuto.decoderStatus() }; });
    assert.equal(idleRecovered.code,'2922791600581'); assert.equal(idleRecovered.state.method,'fallback'); assert(idleRecovered.elapsed < 9000);
    results.push('idle worker crash recovers on the next frame without waiting for a dead-worker timeout');
    for (const mode of ['throw','error','stall']) {
      await open(mode);
      const result = await page.evaluate(async () => ({ code: await ScannerAuto.decodeInWorker(frame('landscape')), state: ScannerAuto.decoderStatus() }));
      assert.equal(result.code,'2922791600581'); assert.equal(result.state.method,'fallback'); assert.equal(result.state.ready,true);
      results.push('worker ' + mode + ' recovers the same frame through bounded fallback');
    }
    await open('normal');
    const absent = await page.evaluate(async () => { window.Worker = undefined; return { code: await ScannerAuto.decodeInWorker(frame('landscape')), state: ScannerAuto.decoderStatus() }; });
    assert.equal(absent.code,'2922791600581'); assert.equal(absent.state.method,'fallback');
    results.push('browser without Worker retains automatic decoding through fallback');
    await open('late');
    const cancellation = await page.evaluate(async () => {
      const decoding = ScannerAuto.decodeInWorker(frame('landscape'));
      await new Promise(resolve => setTimeout(resolve,40)); ScannerAuto.stopDecoder();
      const code = await decoding; await new Promise(resolve => setTimeout(resolve,250)); return code;
    });
    assert.equal(cancellation,'');
    workerMode = 'normal';
    assert.equal(await page.evaluate(() => ScannerAuto.decodeInWorker(frame('landscape'))),'2922791600581');
    results.push('cancelled worker result is discarded and a new scan can decode normally');
    await open('error');
    await page.evaluate(() => {
      window.originalRead = ZXingWASM.readBarcodes;
      ZXingWASM.readBarcodes = () => new Promise(resolve => { window.releaseFallback = resolve; });
      window.pendingFallback = ScannerAuto.decodeInWorker(frame('landscape'));
    });
    await page.waitForFunction(() => typeof window.releaseFallback === 'function');
    const fallbackCancelled = await page.evaluate(async () => { ScannerAuto.stopDecoder(); releaseFallback([{ text: '2922791600581' }]); const code = await pendingFallback; ZXingWASM.readBarcodes = originalRead; return code; });
    assert.equal(fallbackCancelled,'');
    results.push('cancelling fallback prevents its late decoded result from escaping into another scan');
    await open('error');
    const broken = await page.evaluate(async () => {
      window.ZXingWASM = undefined;
      try { await ScannerAuto.decodeInWorker(frame('landscape')); return { rejected: false }; }
      catch (error) { return { rejected: true, code: error.code, state: ScannerAuto.decoderStatus() }; }
    });
    assert.equal(broken.rejected,true); assert.equal(broken.code,'SCANNER_DECODER_UNAVAILABLE'); assert.equal(broken.state.ready,false);
    results.push('failure of both engines is exposed as reader unavailable, never a fake empty-label success');
    assert.deepEqual(unexpected,[]);
    console.log(JSON.stringify({ engine, allPass: true, results, unexpectedRequests: unexpected },null,2));
  } finally { await browser.close(); }
}
main().then(() => server.close()).catch(error => { console.error(error); server.close(); process.exitCode = 1; });
