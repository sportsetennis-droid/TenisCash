'use strict';
// Runs the actual clock UI in memory. Every API/GPS response is controlled;
// this regression suite never connects to a server or records a real clock-in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public/loja.html'), 'utf8');
const start = html.indexOf('// ============== PONTO ==============');
const end = html.indexOf('// ============== RANKING', start);
assert.ok(start >= 0 && end > start, 'Real clock UI block is present');
const escaping = html.match(/^function escPreco\(s\).*$/m)?.[0];
assert.ok(escaping, 'The real escaping helper is present');
const source = escaping + '\n' + html.slice(start, end);

class Element {
  constructor(id) {
    this.id = id; this.style = {}; this.dataset = {}; this.disabled = false;
    this.hidden = false; this.type = id === 'clockPin' ? 'password' : '';
    this.value = ''; this._html = ''; this.focusCount = 0;
    this.classes = new Set(id === 'page-clockin' ? ['show'] : []);
    this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x), contains: x => this.classes.has(x) };
  }
  set innerHTML(value) {
    this._html = String(value);
    if (this.id === 'clockVendor') this.value = this.options.find(option => option.selected)?.value || this.options[0]?.value || '';
  }
  get innerHTML() { return this._html; }
  set textContent(value) { this._html = String(value); }
  get textContent() { return this._html.replace(/<[^>]*>/g, ''); }
  get options() {
    return [...this._html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(match => ({
      value: (match[1].match(/value=["']([^"']*)["']/) || [])[1] || '',
      textContent: match[2], selected: /\bselected\b/.test(match[1]),
    }));
  }
  focus() { this.focusCount++; }
  setAttribute(name, value) { this[name] = String(value); }
  removeAttribute(name) { delete this[name]; }
  addEventListener() {}
}

function setup(now = '2026-10-02T16:00:00Z') {
  let time = +new Date(now);
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [time])); }
    static now() { return time; }
  }
  const elements = new Map(), requests = [], gps = [], alerts = [], events = new Map(), intervals = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const addEvent = (surface, type, fn) => { const key = surface + ':' + type; if (!events.has(key)) events.set(key, []); events.get(key).push(fn); };
  const document = { hidden: false, visibilityState: 'visible', getElementById: get, activeElement: null,
    addEventListener: (type, fn) => addEvent('document', type, fn),
    querySelectorAll: () => [],
  };
  const context = {
    Date: TestDate, Intl, Promise, Set, Map, URLSearchParams, AbortController,
    token: 'memory-test-token', me: { id: 'operator', role: 'superadmin' }, activeStore: { id: 'store-a', name: 'Loja A' },
    document, window: { addEventListener: (type, fn) => addEvent('window', type, fn) },
    navigator: { geolocation: { getCurrentPosition: (success, failure) => gps.push({ success, failure }) } },
    console, confirm: () => true, alert: message => alerts.push(message),
    setInterval: (fn, milliseconds) => { intervals.push({ fn, milliseconds }); return intervals.length; }, clearInterval() {},
    setTimeout: fn => { Promise.resolve().then(fn); return 1; }, clearTimeout() {},
    fetch() { throw Error('Regression test must never use the network'); },
    api(url, options = {}) {
      const method = options.method || 'GET';
      assert.ok(method === 'GET' || (method === 'POST' && url === '/api/seller/clockin-as'), 'Unexpected mutation request');
      return new Promise((resolve, reject) => {
        const call = { url, options, method, settled: false,
          resolve(data) { call.settled = true; resolve(data); }, reject(error) { call.settled = true; reject(error); } };
        requests.push(call);
      });
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'loja.html:clock' });
  return { context, get, requests, gps, alerts, events, intervals,
    advance(value) { time = +new Date(value); },
    next(fragment) { const call = requests.find(request => !request.settled && request.url.includes(fragment)); assert.ok(call, 'Expected request: ' + fragment); return call; },
  };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const sellers = [{ id: 'seller-a', name: 'Sian' }, { id: 'seller-b', name: 'Outro vendedor' }];
function day(allowedNext = ['entry'], workedMinutes = 0, points = []) {
  return { points, summary: { hasEntry: allowedNext[0] !== 'entry', hasExit: false,
    inBreak: allowedNext.includes('break_end'), workedMinutes, breakMinutes: 0, allowedNext } };
}
function enabled(h, type) {
  const tag = (h.get('clockButtons').innerHTML.match(/<button\b[^>]*>/g) || []).find(value => value.includes("doClockIn('" + type + "')"));
  assert.ok(tag, 'Action rendered: ' + type);
  return !/\bdisabled(?:\s|=|>)/.test(tag);
}
async function initial(h, vendorId = 'seller-a', response = day()) {
  const loading = h.context.loadClockin(); h.next('/store-sellers').resolve({ sellers }); await loading;
  h.get('clockVendor').value = vendorId;
  const selecting = h.context.onClockVendorChange(); h.next('/today-of').resolve(response); await selecting;
}
async function resolveRefresh(h, response = day()) {
  for (let turn = 0; turn < 8; turn++) {
    await flush();
    const pending = h.requests.filter(request => !request.settled);
    if (!pending.length) return;
    for (const request of pending) {
      assert.equal(request.method, 'GET', 'Refresh must not record an event');
      if (request.url.includes('/store-sellers')) request.resolve({ sellers });
      else if (request.url.includes('/today-of')) request.resolve(response);
      else assert.fail('Unexpected refresh endpoint: ' + request.url);
    }
  }
  assert.fail('Refresh did not settle');
}

const deadline = setTimeout(() => { console.error('FAIL: clock UI regression did not settle its mocked requests'); process.exitCode = 1; }, 10000);
(async () => {
  // Out-of-order requests must never show sellers from the previous store.
  {
    const h = setup(), first = h.context.loadClockin(), oldRequest = h.next('/store-sellers');
    h.context.activeStore = { id: 'store-b', name: 'Bessa' }; h.context.resetClockState();
    const second = h.context.loadClockin(), newRequest = h.requests.at(-1);
    newRequest.resolve({ sellers: [sellers[0]] }); await second;
    oldRequest.resolve({ sellers: [sellers[1]] }); await first;
    assert.match(h.get('clockVendor').innerHTML, /Sian/);
    assert.doesNotMatch(h.get('clockVendor').innerHTML, /Outro vendedor/);
  }
  // A slower response for A cannot replace the status of selected vendor B.
  {
    const h = setup(), loading = h.context.loadClockin(); h.next('/store-sellers').resolve({ sellers }); await loading;
    h.get('clockVendor').value = 'seller-a'; const first = h.context.onClockVendorChange(), older = h.next('seller-a');
    h.get('clockVendor').value = 'seller-b'; const second = h.context.onClockVendorChange();
    h.next('seller-b').resolve(day(['break_start', 'exit'], 90)); await second;
    older.resolve(day()); await first;
    assert.equal(h.get('clockVendor').value, 'seller-b');
    assert.equal(enabled(h, 'entry'), false); assert.equal(enabled(h, 'break_start'), true);
  }
  // Network failures must remove old actionable state and become visible.
  {
    const h = setup(); await initial(h, 'seller-a', day(['break_end', 'exit'], 300));
    const loading = h.context.onClockVendorChange({ preservePin: true });
    h.next('/today-of').reject(Error('Falha de rede controlada')); await loading;
    assert.equal(h.get('clockButtons').innerHTML, '');
    assert.match(h.get('clockStatus').textContent + h.get('clockToday').textContent, /Falha de rede controlada/);
    const retry = h.context.loadClockin(); h.next('/store-sellers').reject(Error('Lista indisponível')); await retry;
    assert.equal(h.get('clockVendor').value, '');
    assert.doesNotMatch(h.get('clockVendor').innerHTML, /Sian/);
    assert.match(h.get('clockStatus').textContent + h.get('clockListMessage').textContent, /Lista indisponível/);
  }
  // Passive refresh keeps the selected vendor and a password already typed.
  {
    const h = setup(); await initial(h);
    h.get('clockPin').value = 'Senha-digitada';
    const focusBefore = h.get('clockPin').focusCount;
    const refreshing = h.context.loadClockin({ silent: true }); await resolveRefresh(h); await refreshing;
    assert.equal(h.get('clockVendor').value, 'seller-a');
    assert.equal(h.get('clockPin').value, 'Senha-digitada');
    assert.equal(h.get('clockPin').focusCount, focusBefore, 'Passive refresh must not steal focus');
  }
  // The Recife day changes at 03:00 UTC: yesterday's lunch cannot stay actionable.
  {
    const h = setup('2026-10-03T02:59:50Z'); await initial(h, 'seller-a', day(['break_end', 'exit'], 400));
    assert.equal(enabled(h, 'entry'), false);
    h.advance('2026-10-03T03:00:05Z'); const before = h.requests.length;
    assert.ok(h.intervals.length, 'Visible clock has a day-change timer');
    const ticking = h.intervals.map(timer => timer.fn()); await resolveRefresh(h, day()); await Promise.all(ticking);
    assert.ok(h.requests.slice(before).some(request => request.url.includes('/today-of')));
    assert.equal(enabled(h, 'entry'), true); assert.equal(enabled(h, 'break_end'), false);
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
    assert.ok(h.events.has('window:focus')); assert.ok(h.events.has('document:visibilitychange'));
  }
  // A response requested yesterday cannot render yesterday's actions today.
  {
    const h = setup('2026-10-03T02:59:50Z'); await initial(h, 'seller-a', day(['break_end', 'exit'], 400));
    h.get('clockPin').value = 'Senha-preservada';
    const refreshing = h.context.onClockVendorChange({ preservePin: true });
    const yesterday = h.next('/today-of');
    h.advance('2026-10-03T03:00:05Z');
    yesterday.resolve(day(['break_end', 'exit'], 401)); await flush();
    const today = h.next('/today-of');
    assert.notEqual(today, yesterday, 'Day rollover during response requires a new current-day request');
    assert.equal(h.get('clockButtons').innerHTML, '', 'Yesterday actions stay unavailable while today is loading');
    today.resolve(day()); await refreshing;
    assert.equal(enabled(h, 'entry'), true); assert.equal(enabled(h, 'break_end'), false);
    assert.equal(h.get('clockPin').value, 'Senha-preservada');
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 0);
  }
  // Double clicks while GPS or POST is pending must result in one event only.
  {
    const h = setup(); await initial(h); h.get('clockPin').value = 'Senha-pessoal';
    const submitting = h.context.doClockIn('entry'); h.context.doClockIn('entry');
    assert.equal(h.gps.length, 1, 'Only one GPS request during pending submission');
    const before = h.requests.length;
    const passive = h.context.refreshVisibleClock(); await flush();
    assert.equal(h.requests.length, before, 'Passive refresh is suspended during clock submission');
    await passive;
    assert.equal(h.get('clockPin').value, 'Senha-pessoal');
    const send = h.gps[0].success({ coords: { latitude: -7.1, longitude: -34.8 } }); await flush();
    const posted = h.next('/clockin-as'); h.context.doClockIn('entry');
    assert.equal(h.gps.length, 1, 'POST pending must also block a second GPS request');
    const payload = JSON.parse(posted.options.body);
    assert.equal(payload.vendorId, 'seller-a'); assert.equal(payload.storeId, 'store-a'); assert.equal(payload.pin, 'Senha-pessoal');
    posted.resolve({ vendor: { name: 'Sian' }, type: 'entry' });
    await resolveRefresh(h, day(['break_start', 'exit'])); await send; await submitting;
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  }
  // A store switch before the GPS callback invalidates the whole pending action.
  {
    const h = setup(); await initial(h); h.get('clockPin').value = 'Senha-pessoal'; const submitting = h.context.doClockIn('entry');
    h.context.activeStore = { id: 'store-b', name: 'Bessa' }; h.context.resetClockState();
    await h.gps[0].success({ coords: { latitude: -7.1, longitude: -34.8 } }); await resolveRefresh(h); await submitting;
    assert.equal(h.requests.filter(request => request.method === 'POST').length, 0, 'Never post the old vendor in the newly selected store');
  }
  // Returning to a hidden clock page must not poll or change another screen.
  {
    const h = setup(); await initial(h); const before = h.requests.length;
    h.context.document.hidden = true; h.context.document.visibilityState = 'hidden';
    const hiddenRefresh = h.context.refreshVisibleClock(); await flush(); assert.equal(h.requests.length, before); await hiddenRefresh;
    h.context.document.hidden = false; h.context.document.visibilityState = 'visible'; h.get('page-clockin').classes.delete('show');
    const otherPageRefresh = h.context.refreshVisibleClock(); await flush(); assert.equal(h.requests.length, before); await otherPageRefresh;
  }
  const selectStore = html.slice(html.indexOf('function selectStore('), html.indexOf('function changeStore('));
  const logout = html.slice(html.indexOf('function logout()'), html.indexOf('async function checkSession()'));
  assert.match(selectStore, /resetClockState\(/); assert.match(logout, /resetClockState\(/);
  console.log('PASS: clock UI store/vendor races, visible failures, selection/password preservation, day rollover including late responses, GPS/POST dedupe, store-change abort and passive refresh; all API calls mocked');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
