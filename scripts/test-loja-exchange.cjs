/* Exercises the real exchange UI with a fake DOM/API. Never emits a document. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/loja.html'), 'utf8');
const source = html.slice(html.indexOf('let _troca = null;'), html.indexOf('async function loadDashboard()'));
assert(source.includes('async function emitTroca()'));
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);

function harness() {
  const elements = new Map();
  const calls = [], alerts = [];
  let sheet = '';
  function element(id) {
    const el = { id, value: '', style: {}, disabled: false, textContent: '', focus() {}, remove() { elements.delete(id); } };
    Object.defineProperty(el, 'innerHTML', { get() { return this.markup || ''; }, set(value) { this.markup = value; parse(value); } });
    elements.set(id, el);
    return el;
  }
  function parse(markup) {
    for (const m of markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
      const el = element(m[1]);
      el.value = (m[0].match(/\bvalue="([^"]*)"/) || [,''])[1];
      el.disabled = /\sdisabled(?:\s|>)/.test(m[0]);
    }
  }
  const context = {
    console, Intl, setTimeout, clearTimeout,
    window: { innerWidth: 1280 },
    document: { getElementById(id) { return elements.get(id); } },
    activeStore: { id: 'test-store' },
    fmt: v => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
    escPreco: v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    alert: text => alerts.push(text), reprintSale() {}, loadSalesList() {},
    _promptManualSellerSize: () => context.answer || '41',
    api: async (route, options) => {
      if (!options) return { recognized: true, needsSize: true, product: { name: 'Produto novo', price: 1299 }, sizeOptions: [{ size: '41' }, { size: '42' }] };
      calls.push(JSON.parse(options.body));
      return context.response || { ok: false, step: 'cupom', devolucaoDocId: 'return-1', saleId: 'exchange-1', error: 'Simulação' };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  context._fiscalSheet = markup => { elements.clear(); element('fiscalModalOverlay'); sheet = markup; parse(markup); };
  function setState(extra = {}) {
    const state = {
      orig: { docId: 'original', number: 10001, totalValue: 711.11, createdAt: '2026-10-01T12:00:00Z', items: [{ saleItemId: 'old-1', productName: 'Tênis original', unitPrice: 711.11, quantity: 1, size: '38' }] },
      returned: { 'old-1': 1 }, novos: [{ barcode: 'test-barcode', size: '41', name: 'Produto novo', qty: 1, price: 1299 }],
      pay: { tPag: '17', cardAuthCode: '' }, cpf: '12345678901', retryIds: null, busy: false, ...extra,
    };
    context.initial = state;
    vm.runInContext('_troca = initial;', context);
    context.renderTrocaModal();
    return state;
  }
  return { context, calls, alerts, elements, setState, get sheet() { return sheet; } };
}

async function main() {
  let checks = 0;
  const h = harness(), c = h.context;
  for (const [input, expected] of [['100,00',100],['1.234,56',1234.56],['100.25',100.25],['-50,01',-50.01],['0',0],['1.299',1299]]) { assert.equal(c.trocaParseDifference(input),expected); checks++; }
  for (const input of ['', 'abc', '1e3', '2,333', 'Infinity', '--20', '1,2.3']) { assert(Number.isNaN(c.trocaParseDifference(input))); checks++; }
  h.setState();
  assert.equal(c._trocaTotais().diff,587.89); checks++;
  c.trocaSetDifference('100,00');
  assert.equal(c._trocaTotais().nov,811.11);
  assert.equal(h.elements.get('trocaEmitBtn').disabled,false); checks++;
  assert.match(h.elements.get('trocaPaymentDetails').innerHTML,/NSU\) — opcional/); checks++;
  c.trocaSetDifference(''); assert.equal(h.elements.get('trocaEmitBtn').disabled,true); checks++;
  c.trocaSetDifference('-711,11'); assert.equal(h.elements.get('trocaEmitBtn').disabled,true); checks++;
  c.trocaSetDifference('0'); assert.equal(c._trocaTotais().nov,711.11); assert.match(h.elements.get('trocaPaymentDetails').innerHTML,/Troca exata/); checks++;
  c.trocaSetDifference('-50,00'); assert.equal(c._trocaTotais().nov,661.11); assert.match(h.elements.get('trocaPaymentDetails').innerHTML,/a favor do cliente/); checks++;
  c.trocaResetDifference(); assert.equal(c._trocaTotais().diff,587.89); checks++;
  for (const method of ['01','17','03','04']) {
    h.calls.length = 0;
    const state = h.setState({ pay: { tPag: method, cardAuthCode: 'old-autofill' } });
    c.trocaSetDifference('100,00');
    if (method !== '01') h.elements.get('trocaAuthCode').value = '';
    await c.emitTroca();
    assert.equal(h.calls.length,1);
    assert.equal(h.calls[0].diffAmount,100);
    assert.equal(h.calls[0].newItems[0].size,'41');
    assert.equal(h.calls[0].diffPayment.tPag,method);
    assert.equal(h.calls[0].diffPayment.cardAuthCode,undefined);
    assert.equal(state.retryIds.saleId,'exchange-1');
    assert.equal(h.elements.get('trocaDifference').disabled,true);
    c.trocaSetDifference('200'); assert.equal(c._trocaTotais().diff,100);
    c.trocaRetQty('old-1',-1,1); assert.equal(state.returned['old-1'],1);
    c.trocaRmNovo(0); assert.equal(state.novos.length,1);
    await c.emitTroca(); assert.equal(h.calls[1].saleId,'exchange-1'); assert.equal(h.calls[1].diffAmount,100);
    checks++;
  }
  h.calls.length = 0; h.setState(); await c.emitTroca(); assert.equal(h.calls[0].diffAmount,undefined); checks++;
  for (const extra of [{ returned: {} },{ novos: [] },{ diffInput: 'invalid' }]) {
    h.calls.length = 0; h.setState(extra); assert(h.elements.get('trocaEmitBtn').disabled); await c.emitTroca(); assert.equal(h.calls.length,0); checks++;
  }
  let state = h.setState({ novos: [] });
  h.elements.get('trocaBipeInput').value = 'internal-model'; c.answer = '41'; await c.trocaBipe();
  h.elements.get('trocaBipeInput').value = 'internal-model'; c.answer = '42'; await c.trocaBipe();
  assert.equal(state.novos.length,2); assert.equal(state.novos[0].size,'41'); assert.equal(state.novos[1].size,'42'); checks++;
  state = h.setState(); state.orig.items[0].unitPrice = 10/3; state.orig.items[0].returnedQuantity = 1;
  assert.equal(c._trocaTotais().dev,3.34); checks++;
  h.calls.length=0; state=h.setState(); c.response={ok:false,pendingConfirmation:true,step:'cupom',documentId:'pending-1',devolucaoDocId:'return-1',saleId:'exchange-1'};
  await c.emitTroca(); assert.equal(state.pendingConfirmation,'pending-1'); assert(h.elements.get('trocaEmitBtn').disabled); assert(h.elements.get('trocaDifference').disabled);
  await c.emitTroca(); assert.equal(h.calls.length,1); checks++;
  delete c.response;
  console.log('ALL_PASS exchange UI: ' + checks + ' checks; no network, sales, stock or fiscal documents changed.');

  const fixture = process.argv[2];
  if (fixture) {
    // Render only the real modal and styles with an isolated in-browser API stub.
    const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(m=>m[0]).join('\n');
    const init = h.setState(); init.orig.items[0].unitPrice=711.11; init.orig.items[0].returnedQuantity=0; init.returned={}; init.novos=[];
    const helpers = `const activeStore={id:'preview-only'};const fmt=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});const escPreco=${c.escPreco.toString()};function closeSaleModal(){}function loadSalesList(){}function reprintSale(){}function _promptManualSellerSize(){return '41';}async function api(route,opts){if(!opts)return {recognized:true,product:{name:'Tênis novo — demonstração',size:'41',price:1299}};document.getElementById('previewResult').textContent='Simulação local: '+opts.body;return {ok:false,error:'Simulação local concluída. Nenhuma venda ou nota emitida.'};}`;
    fs.mkdirSync(path.dirname(path.resolve(fixture)),{recursive:true});
    fs.writeFileSync(fixture,`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body><div id="previewResult" style="padding:16px">Prévia isolada — sem acesso ao sistema de vendas</div><script>${helpers}\n${source}\n_troca=${JSON.stringify(init)};renderTrocaModal();</script></body></html>`);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
