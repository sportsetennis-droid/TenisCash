'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/bipar.html', 'utf8');
const view = fs.readFileSync('public/scanner-view.js', 'utf8');
assert.match(view, /#etiq-lista\{height:160px;max-height:160px!important/);
assert.match(view, /#etiq-lista\{display:block!important;height:auto!important;max-height:calc\(44vh - 95px\)!important/);
assert.doesNotMatch(view, /#etiq-lista\{display:none/);
const start = html.indexOf('  function renderEtiqLista()');
const end = html.indexOf('function comprimirFoto', start);
assert(start >= 0 && end > start, 'find recent-read renderer');
const code = html.slice(start, end);
const nodes = { 'etiq-contador': { textContent: '' }, 'etiq-lista': { innerHTML: '' } };
const rows = Array.from({ length: 10 }, (_, i) => ({
  roundId: 'round-A', ean: '79000000000' + String(i).padStart(2, '0'), complete: true, bipeId: 'bipe-' + i,
  product: { name: 'Tênis teste ' + i, brand: 'Marca ' + i, size: String(35 + i), sku: 'REF-' + i },
}));
rows.push({ roundId: 'old-round', ean: '0000000000000', complete: true, product: { name: 'Não exibir' } });
const context = {
  etiqFila: rows, window: { ScannerRound: { id: () => 'round-A' } },
  document: { getElementById: id => nodes[id] }, etiqPhotoDurable: () => false,
};
vm.runInNewContext(code + '\nrenderEtiqLista();', context, { filename: 'public/bipar.html#renderEtiqLista' });
const list = nodes['etiq-lista'].innerHTML;
assert.match(list, /ÚLTIMOS BIPES · 10/);
assert.match(list, /Tênis teste 9[\s\S]*Marca 9[\s\S]*Tam\. 44[\s\S]*REF-9[\s\S]*7900000000009[\s\S]*IDENTIFICADO/);
assert.match(list, /data-click="exclude-recent-bipe"[\s\S]*data-bipe="bipe-9"[\s\S]*aria-label="Excluir este bipe"/);
assert.ok(list.indexOf('Tênis teste 9') < list.indexOf('Tênis teste 8'), 'latest scans appear first');
assert.ok(!list.includes('Tênis teste 1'), 'list is limited to the eight most recent items');
assert.ok(!list.includes('Não exibir'), 'other rounds remain isolated');
assert.match(nodes['etiq-contador'].textContent, /identificadas 10/);
const xss = rows[9]; xss.product.name = '<img src=x onerror=alert(1)>';
vm.runInNewContext(code + '\nrenderEtiqLista();', context, { filename: 'public/bipar.html#renderEtiqLista-xss' });
assert.ok(!nodes['etiq-lista'].innerHTML.includes('<img src=x'), 'product data is HTML-escaped');
rows[9].excluded = true;
vm.runInNewContext(code + '\nrenderEtiqLista();', context, { filename: 'public/bipar.html#renderEtiqLista-excluded' });
assert.ok(!nodes['etiq-lista'].innerHTML.includes('Tênis teste 9'), 'excluded scans leave the active recent list');
assert.match(nodes['etiq-contador'].textContent, /identificadas 9/);
console.log('PASS: recent scan list shows product, brand, size, reference, barcode, status; newest first; isolated by round; HTML escaped');

