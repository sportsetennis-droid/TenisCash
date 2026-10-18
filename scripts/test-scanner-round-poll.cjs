'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const nodes = new Map(['loja', 'round-title', 'round-detail', 'round-box', 'refresh-round']
  .map(id => [id, { id, value: 'store-05', textContent: '', dataset: {}, addEventListener() {} }]));
const replies = [];
const context = vm.createContext({
  window: { BiparActions: { isInventory: () => true } },
  document: { getElementById: id => nodes.get(id) },
  fetch: async () => {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  },
  setInterval() {},
  URLSearchParams,
});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../public/scanner-round.js'), 'utf8'), context);

const response = (round, ok = true) => ({ ok, json: async () => ({ round, totals: { total: 101, pending: 0 } }) });
(async () => {
  const round = { id: 'round-05', number: 12, name: 'Conferência', storeId: 'store-05', status: 'counting', startedAt: '2026-10-18T12:00:00Z' };
  replies.push(response(round));
  await context.window.ScannerRound.refresh();
  assert.equal(context.window.ScannerRound.requireRound('store-05'), 'round-05');

  replies.push(new Error('temporary network failure'));
  await context.window.ScannerRound.refresh();
  assert.equal(context.window.ScannerRound.requireRound('store-05'), 'round-05', 'a failed background poll must not close the scanner session');
  assert.equal(nodes.get('round-box').dataset.ready, 'true');

  replies.push(response(null));
  await context.window.ScannerRound.refresh();
  assert.throws(() => context.window.ScannerRound.requireRound('store-05'), /rodada aberta/,
    'an authoritative response with no round must invalidate the cached round');

  replies.push(response({ ...round, status: 'review' }));
  await context.window.ScannerRound.refresh();
  assert.throws(() => context.window.ScannerRound.requireRound('store-05'), /rodada aberta/,
    'an authoritative closed-for-counting status must invalidate the round');

  console.log('PASS: temporary round polling failures preserve the last verified open round; authoritative closure invalidates it');
})().catch(error => { console.error(error); process.exitCode = 1; });
