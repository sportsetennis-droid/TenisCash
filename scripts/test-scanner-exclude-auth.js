'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync('public/bipar.html', 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
const start = html.indexOf('async function excluirBipeRecente(button)');
const end = html.indexOf('function comprimirFoto', start);
assert(start >= 0 && end > start, 'find recent-bipe exclusion handler');
const source = html.slice(start, end);

async function run({ transferToken = 'session-token', adminToken = 'admin-token', responseOk = true } = {}) {
  const item = { lid: 'scan-1', roundId: 'round-1', bipeId: 'bipe-1', excluded: false };
  const button = { dataset: { round: 'round-1', bipe: 'bipe-1', lid: 'scan-1' }, disabled: false };
  const alerts = [], calls = [];
  let saves = 0, renders = 0;
  const context = {
    sessionStorage: { getItem: key => key === 'tc_transfer_token' ? transferToken : null },
    localStorage: { getItem: key => key === 'tc_admin_token' ? adminToken : null },
    etiqFila: [item], etiqSave: async () => { saves++; }, renderEtiqLista: () => { renders++; },
    alert: message => alerts.push(message), encodeURIComponent, JSON,
    fetch: async (url, options) => {
      calls.push({ url, options });
      return { ok: responseOk, json: async () => responseOk ? { ok: true } : { error: 'Falha teste' } };
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nwindowHandler = excluirBipeRecente;', context);
  await context.windowHandler(button);
  return { item, button, alerts, calls, saves, renders };
}

(async () => {
  const success = await run();
  assert.equal(success.calls.length, 1);
  assert.equal(success.calls[0].url, '/api/stocktake/rounds/round-1/exclude/bipe-1');
  assert.equal(success.calls[0].options.headers.Authorization, 'Bearer session-token');
  assert.equal(success.item.excluded, true);
  assert.equal(success.saves, 1); assert.equal(success.renders, 1); assert.equal(success.alerts.length, 0);

  const failure = await run({ responseOk: false });
  assert.equal(failure.item.excluded, false, 'failure leaves the bipe in the list');
  assert.equal(failure.button.disabled, false, 'failure allows a retry');
  assert.deepEqual(failure.alerts, ['Falha teste']);
  console.log('PASS: bipe exclusion sends the authenticated session token and only updates the list after server success');
})().catch(error => { console.error(error); process.exitCode = 1; });
