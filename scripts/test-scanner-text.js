'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseScannerText, scannerPendingMessage } = require('../src/services/scannerText');
const nike = parseScannerText('NIKE\nWOMENS\nDQ5471-113\nL\n1 96153 34632 1');
assert.equal(nike.sku, 'DQ5471-113');
assert.equal(nike.tamanho, 'L');
assert.equal(nike.ean, '196153346321');
assert.equal(nike.marca, 'NIKE');
assert.ok(parseScannerText('DQ5471 113\nSIZE L').codigos.includes('DQ5471-113'));
assert.equal(parseScannerText('DQ5471-113\nUS 10\nUK 9\nEUR 44\nBR 42').tamanho, 'BR 42');
assert.equal(parseScannerText('DQ5471-113\nUS 10\nUK 9\nEUR 44').tamanho, null);
assert.equal(parseScannerText('DQ5471-113\nL\nM'), null);
assert.equal(parseScannerText('NIKE ADIDAS\nDQ5471-113\nL'), null);
assert.equal(parseScannerText('DQ5471-113\n196153346321\n7909538652084'), null);
assert.equal(parseScannerText('https://example.org/DQ5471-113'), null);
assert.equal(parseScannerText('DQ5471-113\n196153346322').ean, null);
assert.ok(parseScannerText('192974\nL').codigos.includes('192974'));
assert.ok(parseScannerText('CALBFBR-ALLBLACK-M\nM').codigos.includes('CALBFBR-ALLBLACK-M'));
assert.equal(parseScannerText({}), null);
const realPhoto = parseScannerText('Womens\nEl\nSPTCAS\nDD5860-690\nAL\nXL');
assert.equal(realPhoto.sku, 'DD5860-690');
assert.equal(realPhoto.tamanho, 'XL');
assert.equal(parseScannerText('DD5860-690\nAL').tamanho, null, 'Never guess AL means XL');
assert.match(scannerPendingMessage('DD5860-690\nXL', realPhoto, 'reference_not_found'), /DD5860-690 \/ XL.*NF-e/);
assert.match(scannerPendingMessage('', null), /extrair a referência/);
const route = fs.readFileSync(require.resolve('../src/routes/stocktake'), 'utf8');
assert.ok(!/Anthropic|anthropic-ai|messages\.create|OPENAI_API_KEY|ANTHROPIC_API_KEY/.test(route), 'Scanner must never use a paid provider');
for (const file of ['../public/bipar.html', '../public/identificar.html']) {
  const html = fs.readFileSync(require.resolve(file), 'utf8');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (script[1].trim()) new vm.Script(script[1]);
}
(async () => {
  let created = 0, known = true;
  const canvas = { width: 10, height: 10, getContext: () => ({ drawImage() {}, putImageData() {},
    getImageData: () => ({ width: 10, height: 10, data: new Uint8ClampedArray(400).fill(255) }) }) };
  const browser = { window: {}, setTimeout: () => 0, clearTimeout: () => {}, AbortController,
    document: { createElement: () => canvas },
    fetch: async () => ({ ok: true, json: async () => ({ recognized: known }) }) };
  browser.window.ScannerRegions = require('../public/scanner-regions');
  browser.window.Tesseract = { createWorker: async (lang, oem, options) => {
    created++; assert.equal(lang, 'eng'); assert.equal(oem, 1);
    assert.ok(options.workerPath.startsWith('/vendor/ocr/'));
    assert.equal(options.langPath, '/vendor/ocr'); assert.equal(options.corePath, '/vendor/ocr');
    return { setParameters: async () => {}, recognize: async () => ({data:{confidence:90,text:'NIKE\nDQ5471-113\nL'}}), terminate: async () => {} };
  } };
  vm.createContext(browser);
  vm.runInContext(fs.readFileSync(require.resolve('../public/scanner-ocr.js'), 'utf8'), browser);
  assert.equal(await browser.window.ScannerOCR.readForScan('image', '196153346321'), '');
  assert.equal(created, 0, 'Known barcode must not load OCR');
  known = false;
  assert.ok((await browser.window.ScannerOCR.readForScan(canvas, '196153346321')).includes('DQ5471-113'));
  assert.equal(created, 1);
  await browser.window.ScannerOCR.stop();
  browser.window.Tesseract.createWorker = async () => { throw new Error('Unavailable device'); };
  assert.equal(await browser.window.ScannerOCR.readForScan('image', ''), '', 'OCR failure preserves photo upload');

  const html = fs.readFileSync(require.resolve('../public/bipar.html'), 'utf8');
  const code = html.slice(html.indexOf('  async function enviarFila()'), html.indexOf('  async function consultarStatus()'));
  let posted = false;
  const item = {st:'fila',b64:'data:image/jpeg;base64,AA==',ean:'196153346321',storeId:'LOJA04',sellerId:'douglas',sellerName:'Douglas',clientScanId:'same-scan'};
  const queue = {etiqBusy:false,etiqFila:[item],STORAGE_VENDNAME:'name',FormData,
    document:{getElementById:()=>({value:'LOJA05'})},localStorage:{getItem:()=> 'Someone else'},
    window:{ScannerOCR:{readForScan:async()=> 'NIKE\nDQ5471-113\nL'}},
    etiqSave:()=>{},renderEtiqLista:()=>{},renderLista:()=>{},
    fetch:async (url, options)=> {
      if(String(url).startsWith('data:'))return{blob:async()=>new Blob(['photo'])};
      assert.equal(url,'/api/stocktake/etiqueta');posted=true;
      assert.equal(options.body.get('storeId'),'LOJA04'); assert.equal(options.body.get('sellerId'),'douglas');
      assert.equal(options.body.get('clientScanId'),'same-scan'); assert.ok(options.body.get('ocrText').includes('DQ5471-113'));
      return {ok:true,json:async()=>({capId:'saved',appliedToStock:true})};
    }};
  vm.createContext(queue); await vm.runInContext(code+'\nenviarFila()',queue);
  assert.ok(posted);assert.equal(item.st,'salvo');
  console.log('PASS: free OCR parsing, known-code fast path, device failure fallback, capture store isolation, no paid scanner API, page syntax');
})().catch(e => { console.error(e); process.exitCode = 1; });

