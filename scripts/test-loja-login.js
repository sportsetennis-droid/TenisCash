const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja.html'), 'utf8');
const loginStart = html.indexOf('async function doLogin() {');
const loginEnd = html.indexOf('// Entrar com o rosto', loginStart);
const clockStart = html.indexOf('async function doClockIn(type) {');
const clockEnd = html.indexOf('// ============== RANKING', clockStart);
assert.ok(loginStart >= 0 && loginEnd > loginStart);
assert.ok(clockStart >= 0 && clockEnd > clockStart);

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

  console.log('ALL_PASS loja login (e-mail, WhatsApp, senha completa, acesso restrito e senha do ponto)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
