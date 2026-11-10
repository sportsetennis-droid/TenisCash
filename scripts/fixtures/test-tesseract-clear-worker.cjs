'use strict';
// VM contract tests only: never loads Tesseract/WASM, images, OCR or a database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceFile = path.join(__dirname, 'tesseract-clear-worker.cjs');
const source = fs.readFileSync(sourceFile, 'utf8');
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function fixture({ version = '7.0.0', coreVersion = '7.0.0', fetchPresent = true, autoBoot = false } = {}) {
  const root = path.resolve('diagnostic-fixture-app');
  const packageFile = path.join(root, 'node_modules', 'tesseract.js', 'package.json');
  const calls = [], messages = [], events = [];
  const sentinelReturn = { exactReturn: true }, setError = new Error('set-image failure'), clearError = new Error('clear failure');
  class API {
    Clear() { events.push(['Clear', this]); if (this.failClear) throw clearError; }
    SetImageFile(...args) { events.push(['SetImageFile', this, args]); if (this.failSet) throw setError; return sentinelReturn; }
    End() { throw new Error('Forbidden End'); }
    Init() { throw new Error('Forbidden Init'); }
    ClearAdaptiveClassifier() { throw new Error('Forbidden adaptive reset'); }
    ResetDocumentDictionary() { throw new Error('Forbidden dictionary reset'); }
  }
  const core = { TessBaseAPI: API };
  const factory = async options => { calls.push(['factory', options]); return core; };
  const getCore = async (...args) => { calls.push(['getCore', args]); return factory; };
  const gunzip = value => value, fetch = () => {}, fallbackFetch = () => {};
  const cache = { readCache() {}, writeCache() {}, deleteCache() {} };
  let adapter, handler;
  const dispatcher = {
    setAdapter(value) { calls.push(['setAdapter']); adapter = value; },
    dispatchHandlers(packet, send) { calls.push(['dispatchHandlers', packet]); send(packet.response); },
  };
  const parentPort = {
    on(event, fn) { check(event === 'message', 'Original message event retained'); handler = fn; },
    postMessage(message) { messages.push(message); },
  };
  const requireTesseract = id => {
    calls.push(['requireTesseract', id]);
    if (id === 'tesseract.js-core/package.json') return { version: coreVersion };
    if (id === 'node-fetch') return fallbackFetch;
    if (id.endsWith(path.join('worker-script', 'index.js'))) return dispatcher;
    if (id.endsWith('getCore.js')) return getCore;
    if (id.endsWith('gunzip.js')) return gunzip;
    if (id.endsWith('cache.js')) return cache;
    throw new Error('Unexpected package import: ' + id);
  };
  const requireApp = id => { assert.equal(id, packageFile); return { version }; };
  requireApp.resolve = id => { assert.equal(id, 'tesseract.js/package.json'); return packageFile; };
  const module = { exports: {} };
  const localRequire = id => {
    if (id === 'node:path') return path;
    if (id === 'node:module') return { createRequire: filename => filename === packageFile ? requireTesseract : requireApp };
    if (id === 'node:worker_threads') return { parentPort };
    throw new Error('Unexpected builtin import: ' + id);
  };
  localRequire.main = autoBoot ? module : {};
  vm.runInNewContext(source, {
    require: localRequire, module, exports: module.exports,
    process: { env: {}, cwd: () => root }, global: { fetch: fetchPresent ? fetch : undefined },
  }, { filename: sourceFile });
  return { api: module.exports, core, factory, calls, events, messages, cache, gunzip, fetch, fallbackFetch,
    sentinelReturn, setError, clearError, get adapter() { return adapter; }, dispatch: packet => handler(packet) };
}

(async () => {
  const f = fixture({ autoBoot: true });
  check(f.adapter.gunzip === f.gunzip && f.adapter.fetch === f.fetch, 'Original decompressor and fetch retained');
  for (const key of Object.keys(f.cache)) check(f.adapter[key] === f.cache[key], 'Original cache function retained: ' + key);
  const getArgs = [true, '/unchanged/core-option', { progress() {} }];
  const sameFactory = await f.adapter.getCore(...getArgs);
  const forwarded = f.calls.find(call => call[0] === 'getCore')[1];
  check(forwarded.length === getArgs.length && forwarded.every((value, i) => value === getArgs[i]), 'Core-selection arguments unchanged');
  const options = { TesseractProgress() {}, arbitraryOption: 'preserve' };
  check(await sameFactory(options) === f.core, 'Same module object returned');
  check(f.calls.find(call => call[0] === 'factory')[1] === options, 'Original factory options object retained');
  check(f.events.length === 0, 'Boot/factory do not call Clear, End, Init or reset');
  const api = new f.core.TessBaseAPI();
  const imageArgs = [6, 0.125, { extra: 'unchanged' }];
  check(api.SetImageFile(...imageArgs) === f.sentinelReturn, 'SetImageFile return identity retained');
  check(f.events.map(event => event[0]).join(',') === 'Clear,SetImageFile', 'Clear immediately precedes SetImageFile');
  check(f.events.every(event => event[1] === api), 'Receiver retained for both calls');
  check(f.events[1][2].every((value, i) => value === imageArgs[i]), 'All SetImageFile arguments retained');
  await f.api.wrapCoreFactory(f.factory)({});
  f.events.length = 0;
  api.SetImageFile(1, 0);
  check(f.events.map(event => event[0]).join(',') === 'Clear,SetImageFile', 'A module cannot be decorated twice');
  api.failSet = true;
  assert.throws(() => api.SetImageFile(1, 0), error => error === f.setError); checks++;
  api.failSet = false; api.failClear = true; f.events.length = 0;
  assert.throws(() => api.SetImageFile(1, 0), error => error === f.clearError); checks++;
  check(f.events.map(event => event[0]).join(',') === 'Clear', 'Clear failure prevents image installation');
  const packet = { action: 'recognize', payload: { unchanged: true }, response: { result: 'same' } };
  f.dispatch(packet);
  check(f.calls.find(call => call[0] === 'dispatchHandlers')[1] === packet, 'Original dispatcher receives original packet');
  check(f.messages[0] === packet.response, 'Original response posted unchanged');
  const factoryError = new Error('factory failure');
  await assert.rejects(f.api.wrapCoreFactory(async () => { throw factoryError; })({}), error => error === factoryError); checks++;
  await assert.rejects(f.api.wrapCoreFactory(async () => ({ TessBaseAPI: class {} }))({}), /Clear and SetImageFile/); checks++;
  await assert.rejects(f.api.wrapCoreFactory(async () => ({}))({}), /Clear and SetImageFile/); checks++;
  assert.throws(() => f.api.wrapCoreFactory(null), /core factory/); checks++;
  for (const versions of [{ version: '6.0.1' }, { coreVersion: '7.0.1' }]) {
    const bad = fixture(versions);
    assert.throws(() => bad.api.boot(), /audited 7.0.0 only/); checks++;
    check(!bad.adapter, 'Unaudited versions fail before installing adapter');
  }
  const fallback = fixture({ fetchPresent: false, autoBoot: true });
  check(fallback.adapter.fetch === fallback.fallbackFetch, 'Original Node fetch fallback retained');
  console.log(`PASS: ${checks} diagnostic-worker VM contract checks. No Tesseract/WASM, OCR, images, network, database or production changes.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
