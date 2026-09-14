const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const jwt = require('jsonwebtoken');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
const loginStart = html.indexOf('async function doLogin() {');
const loginEnd = html.indexOf('// Entrar com o rosto', loginStart);
const clockStart = html.indexOf('async function doClockIn(type) {');
const clockEnd = html.indexOf('// ============== RANKING', clockStart);
const sessionStart = html.indexOf('async function checkSession() {');
const sessionEnd = html.indexOf('async function showStoreSelector()', sessionStart);
const apiStart = html.indexOf('async function api(path, opts = {}) {');
const apiEnd = html.indexOf('// ============== NAV', apiStart);
assert.ok(loginStart >= 0 && loginEnd > loginStart);
assert.ok(clockStart >= 0 && clockEnd > clockStart);
assert.ok(sessionStart >= 0 && sessionEnd > sessionStart);
assert.ok(apiStart >= 0 && apiEnd > apiStart);

function inputAttributes(id) {
  const input = html.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(input, `Campo ${id} existe`);
  return Object.fromEntries([...input[0].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
}

function enterText(id, value) {
  const maxLength = Number(inputAttributes(id).maxlength);
  return Number.isFinite(maxLength) ? value.slice(0, maxLength) : value;
}

function setup({ identifier = '', password = '', role = 'seller', error = null } = {}) {
  const elements = new Map();
  const requests = [];
  const storage = new Map();
  const gpsWork = [];
  let storeSelectorOpened = false;
  const context = {
    API: '',
    token: null,
    me: null,
    activeStore: { id: 'assigned-store' },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          value: '', disabled: false, textContent: '', focus() {},
          classList: { add() {}, remove() {} },
        });
        return elements.get(id);
      },
    },
    localStorage: { setItem(key, value) { storage.set(key, value); } },
    showStoreSelector() { storeSelectorOpened = true; },
    async fetch(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: !error, async json() {
        return error ? { error } : { user: { id: 'seller-id', role }, token: 'test-session' };
      } };
    },
    navigator: { geolocation: { getCurrentPosition(callback) {
      gpsWork.push(callback({ coords: { latitude: -7.1, longitude: -34.8 } }));
    } } },
    confirm() { return true; },
    alert() {},
    onClockVendorChange() {},
    async api(url, options) {
      requests.push({ url, body: JSON.parse(options.body) });
      return { vendor: { name: 'Vendedor de teste' } };
    },
  };
  context.document.getElementById('loginPhone').value = enterText('loginPhone', identifier);
  context.document.getElementById('loginPin').value = enterText('loginPin', password);
  context.document.getElementById('clockPin').value = enterText('clockPin', password);
  context.document.getElementById('clockVendor').value = 'seller-id';
  vm.createContext(context);
  vm.runInContext(html.slice(loginStart, loginEnd) + '\n' + html.slice(clockStart, clockEnd), context);
  return { context, requests, elements, storage, gpsWork, opened: () => storeSelectorOpened };
}

async function checkPromotedSession({ savedStore = 'assigned-store', role = 'seller', sessionValid = true } = {}) {
  const secret = 'loja-session-regression-test-only';
  const oldToken = jwt.sign({ userId: 'seller-test', role: 'user' }, secret);
  const freshToken = jwt.sign({ userId: 'seller-test', role }, secret);
  const storage = new Map([['loja_token', oldToken]]);
  if (savedStore) storage.set('loja_activeStore', JSON.stringify({ id: savedStore }));
  const requests = [];
  const dependentWork = [];
  let loggedOut = false;
  let opened = null;
  const context = {
    API: '', token: oldToken, me: null,
    activeStore: savedStore ? { id: savedStore } : null,
    localStorage: {
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); },
    },
    logout() { loggedOut = true; context.token = null; storage.delete('loja_token'); },
    showApp() {
      opened = 'app';
      dependentWork.push(context.api('/api/seller/clockin/today-of?vendorId=seller-test'));
    },
    showStoreSelector() {
      opened = 'stores';
      dependentWork.push(context.api('/api/seller/stores'));
    },
    async fetch(url, options) {
      const authorization = options.headers.Authorization;
      const claims = jwt.verify(authorization.replace(/^Bearer /, ''), secret);
      requests.push({ url, role: claims.role });
      if (url === '/api/auth/me') {
        return { ok: sessionValid, async json() {
          return { token: freshToken, user: { id: 'seller-test', role, storeId: 'assigned-store', storeIds: ['assigned-store'] } };
        } };
      }
      const allowed = claims.role === 'seller';
      return { ok: allowed, status: allowed ? 200 : 403, async json() {
        return allowed ? { points: [], stores: [{ id: 'assigned-store' }] } : { error: 'Acesso restrito ao vendedor / loja' };
      } };
    },
  };
  vm.createContext(context);
  vm.runInContext(html.slice(sessionStart, sessionEnd) + '\n' + html.slice(apiStart, apiEnd), context);
  await context.checkSession();
  await Promise.all(dependentWork);
  return { context, storage, requests, freshToken, loggedOut, opened };
}

async function main() {
  assert.equal(inputAttributes('loginPhone').type, 'text', 'Identificação aceita telefone e e-mail');
  assert.equal(inputAttributes('loginPhone').autocomplete, 'username');
  for (const id of ['loginPin', 'clockPin']) {
    assert.equal(inputAttributes(id).type, 'password');
    assert.notEqual(inputAttributes(id).inputmode, 'numeric', `${id} permite senha com letras`);
  }

  const password = 'Senha@Cadastro2026!';
  const byEmail = setup({ identifier: ' vendedor@example.com ', password });
  await byEmail.context.doLogin();
  assert.deepEqual(byEmail.requests, [{ url: '/api/auth/login', body: { email: 'vendedor@example.com', password } }]);
  assert.equal(byEmail.opened(), true);
  assert.equal(byEmail.storage.get('loja_token'), 'test-session');
  assert.equal(byEmail.elements.get('loginBtn').disabled, false);

  const byPhone = setup({ identifier: '(83) 91234-5678', password: '9877' });
  await byPhone.context.doLogin();
  assert.deepEqual(byPhone.requests[0].body, { phone: '83912345678', password: '9877' });
  assert.equal(byPhone.opened(), true);

  for (const identifier of ['', '1234', 'vendedor@', 'vendedor @example.com']) {
    const invalid = setup({ identifier, password });
    await invalid.context.doLogin();
    assert.equal(invalid.requests.length, 0, `Não envia identificação inválida: ${identifier}`);
    assert.equal(invalid.opened(), false);
  }

  const rejected = setup({ identifier: 'vendedor@example.com', password, error: 'Senha incorreta' });
  await rejected.context.doLogin();
  assert.equal(rejected.elements.get('loginErr').textContent, 'Senha incorreta');
  assert.equal(rejected.elements.get('loginBtn').disabled, false);
  assert.equal(rejected.opened(), false);

  const customer = setup({ identifier: 'cliente@example.com', password, role: 'customer' });
  await customer.context.doLogin();
  assert.equal(customer.opened(), false, 'Login não amplia acesso ao portal para clientes');
  assert.equal(customer.storage.has('loja_token'), false);

  const clock = setup({ password });
  await clock.context.doClockIn('entry');
  await Promise.all(clock.gpsWork);
  assert.deepEqual(clock.requests, [{ url: '/api/seller/clockin-as', body: {
    vendorId: 'seller-id', pin: password, type: 'entry', storeId: 'assigned-store', latitude: -7.1, longitude: -34.8,
  } }], 'Ponto envia senha completa e preserva vendedor, loja, evento e localização');
  assert.equal(clock.elements.get('clockPin').value, '');

  for (const savedStore of ['assigned-store', null, 'old-store']) {
    const promoted = await checkPromotedSession({ savedStore });
    assert.equal(promoted.context.token, promoted.freshToken, 'Sessão usa papel renovado pelo servidor');
    assert.equal(promoted.storage.get('loja_token'), promoted.freshToken, 'Próxima abertura preserva o token renovado');
    assert.equal(promoted.loggedOut, false);
    assert.deepEqual(promoted.requests.map(request => request.role), ['user', 'seller'], 'Primeira consulta de ponto/lojas usa JWT de vendedor após a promoção');
    assert.equal(promoted.opened, savedStore === 'assigned-store' ? 'app' : 'stores');
    if (savedStore === 'old-store') assert.equal(promoted.storage.has('loja_activeStore'), false, 'Renovação preserva a restrição de lojas vinculadas');
  }
  for (const options of [{ role: 'user' }, { sessionValid: false }]) {
    const denied = await checkPromotedSession(options);
    assert.equal(denied.loggedOut, true);
    assert.equal(denied.opened, null, 'Conta sem permissão ou sessão inválida não abre o painel');
    assert.equal(denied.requests.length, 1, 'Não consulta ponto ou lojas após recusa da sessão');
    assert.equal(denied.storage.has('loja_token'), false);
  }

  console.log('ALL_PASS loja login (e-mail, WhatsApp, senha completa, acesso restrito, ponto e renovação após promoção)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
