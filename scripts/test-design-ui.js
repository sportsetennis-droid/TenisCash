'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const UI = require('../public/design-access');
const { isDesignRequestAllowed } = require('../src/services/designAccess');

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.style = { display: '' }; this.attrs = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  prepend(...nodes) { for (const node of nodes.reverse()) { node.parent = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { this.children.forEach(n => { n.parent = null; }); this.children = []; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] || null; }
  addEventListener(event, fn) { (this.listeners[event] ||= []).push(fn); }
  async click() { if (this.disabled) return; for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() {} }); if (this.onclick) await this.onclick(); }
  showModal() { this.open = true; }
  close() { this.open = false; for (const fn of this.listeners.close || []) fn(); }
  matches(selector) {
    if (selector === 'button') return this.tagName === 'BUTTON';
    if (selector === 'dialog') return this.tagName === 'DIALOG';
    if (selector === '[data-design-display]') return this.dataset.designDisplay !== undefined;
    if (selector === '[data-dialog-error]') return this.dataset.dialogError !== undefined;
    if (selector.startsWith('.')) return (this.className || '').split(' ').includes(selector.slice(1));
    return false;
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent ? this.parent.closest(selector) : null; }
  get isConnected() { return this.tagName === 'DOCUMENT' || !!(this.parent && this.parent.isConnected); }
}
function fakeDocument() {
  const doc = new Element('document'); doc.head = new Element('head'); doc.body = new Element('body'); doc.append(doc.head, doc.body);
  doc.createElement = tag => new Element(tag);
  const all = n => [n, ...n.children.flatMap(all)];
  doc.getElementById = id => all(doc).find(n => n.id === id) || null;
  return doc;
}
function textOf(n) { return [n.textContent, ...n.children.map(textOf)].join(' '); }
function findButton(n, text) { return n.querySelectorAll('button').find(b => b.textContent === text); }
function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

async function main() {
  // Missing or cached roles may never unlock a legacy dashboard.
  UI.setRole(null); assert.equal(UI.canNavigateLegacy(), false);
  assert.equal(UI.allowRequest(null, '/admin/users', 'GET'), false);
  assert.equal(UI.allowRequest(null, '/auth/me', 'GET'), true);
  for (const role of ['design', 'design_view']) {
    UI.setRole(role); assert.equal(UI.canNavigateLegacy(), false);
    for (const endpoint of ['/admin/users', '/admin/transactions', '/admin/ai/stats', '/admin/catalog/meta/status', '/admin/catalog/products/p/nfe-summary', '/admin/product-images/diagnose', '/classification/status', '/admin/inventory/adjust']) {
      assert.equal(UI.allowRequest(role, endpoint, 'GET'), false, role + ' must reject ' + endpoint);
    }
    for (const endpoint of ['/admin/catalog/products?active=all&page=2', '/admin/catalog/products/p1', '/admin/categories/tree', '/admin/labels/batches', '/admin/vitrine/slots']) {
      assert.equal(UI.allowRequest(role, endpoint, 'GET'), true);
      assert.equal(isDesignRequestAllowed({ userRole: role, method: 'GET', originalUrl: '/api' + endpoint }), true, 'UI/backend contract: ' + endpoint);
    }
  }
  for (const [method, endpoint] of [['PUT', '/admin/catalog/products/p1'], ['POST', '/admin/categories/c1/assign-products'], ['POST', '/admin/product-images/upload/p1'], ['DELETE', '/admin/product-images/video/p1'], ['PUT', '/admin/vitrine/slots'], ['POST', '/admin/labels/batches/quick']]) {
    assert.equal(UI.allowRequest('design', endpoint, method), true);
    assert.equal(UI.allowRequest('design_view', endpoint, method), false);
    assert.equal(isDesignRequestAllowed({ userRole: 'design', method, originalUrl: '/api' + endpoint }), true, 'UI/backend mutation contract: ' + endpoint);
  }
  assert.equal(UI.allowRequest('design_view', '/admin/labels/batches/b1/pdf', 'GET'), false);
  const payload = UI.productPayload({ sku: 'REF', name: 'Produto', brand: 'Marca', category: 'Tênis', price: '189.90', color: 'Azul', gender: 'Homem', features: '{"tecido":"malha"}', stock: 500, sizes: [{ stock: 500 }], costPrice: 20, promoPrice: 1, source: 'xml', ncm: 'fake', aiContext: { secret: 'sentinel' } });
  assert.equal(payload.price, 189.9); assert.equal(payload.aiContext.color, 'Azul');
  for (const key of ['stock', 'sizes', 'costPrice', 'promoPrice', 'source', 'ncm']) assert.equal(Object.hasOwn(payload, key), false);
  assert.equal(payload.aiContext.secret, undefined);
  assert.throws(() => UI.productPayload({ price: '-1' }), /preço/);
  assert.throws(() => UI.productPayload({ price: '3', features: '[]' }), /objeto JSON/);

  const network = [], browser = { document: {}, location: { href: 'https://shop.example/admin.html', origin: 'https://shop.example' }, URL, Response, fetch: async (input, options) => { network.push([input, options]); return new Response('{}'); } };
  browser.window = browser; vm.createContext(browser); vm.runInContext(read('public/design-access.js'), browser);
  assert.equal((await browser.fetch('/api/admin/users')).status, 403); assert.equal(network.length, 0);
  await browser.fetch('/api/auth/me'); assert.equal(network.length, 1);
  browser.DesignAccess.setRole('design');
  assert.equal((await browser.fetch('/api/admin/transactions')).status, 403);
  await browser.fetch('/api/admin/catalog/products'); assert.equal(network.length, 2);
  browser.DesignAccess.setRole('design_view');
  assert.equal((await browser.fetch('/api/admin/catalog/products/p1', { method: 'PUT' })).status, 403); assert.equal(network.length, 2);

  // Execute the real showDashboard function with a stale administrator and a
  // fresh Design role. No HR/finance bootstrap can run before the server reply.
  const admin = read('public/admin.html');
  const dashboardFn = admin.slice(admin.indexOf('async function showDashboard() {'), admin.indexOf('// LOAD ALL DATA'));
  const calls = [], dashboardDoc = fakeDocument();
  for (const id of ['login-screen', 'dashboard', 'admin-name']) { const e = new Element('div'); e.id = id; dashboardDoc.body.append(e); }
  const context = {
    document: dashboardDoc, adminUser: { role: 'superadmin' }, token: 'old',
    api: async p => { calls.push(p); return { token: 'fresh', user: { id: 'u1', name: 'Designer', role: 'design' } }; },
    DesignAccess: { ...UI, mount: async o => { calls.push('mount:' + o.user.role); } },
    localStorage: { setItem(k, v) { calls.push(k + ':' + v); } },
    doLogout() { throw Error('unexpected logout'); },
    initAdminMobileNavigation() { calls.push('legacy-nav'); },
    mountAdminBiometricEntry() { calls.push('legacy-bio'); return Promise.resolve(); },
    loadDashboard() { calls.push('legacy-data'); },
  };
  vm.createContext(context); vm.runInContext(dashboardFn, context); await context.showDashboard();
  assert.deepEqual(calls, ['/auth/me', 'tc_admin_token:fresh', 'mount:design']);
  assert.equal(context.adminUser.role, 'design');
  for (const match of admin.matchAll(/window\.switchTab(?:ByName)?\s*=\s*function\s*\([^)]*\)\s*\{([^]*?)(?:\n|\r)/g)) {
    const tail = admin.slice(match.index + match[0].length, match.index + match[0].length + 110);
    assert.match(tail, /DesignAccess\.canNavigateLegacy\(\)/, 'each wrapper must stop its own extra side effects');
  }
  const index = read('public/index.html');
  const homeFunction = index.slice(index.indexOf('function goHomeByRole() {'), index.indexOf('function showScreen(id) {'));
  for (const role of ['design', 'design_view']) {
    const actions = [], c = { user: { role }, token: 'current', localStorage: { setItem(k, v) { actions.push([k, v]); } }, window: { location: { replace(u) { actions.push(u); } } }, isPartner: () => false, isSeller: () => false, showScreen(s) { actions.push(s); } };
    vm.createContext(c); vm.runInContext(homeFunction, c); c.goHomeByRole();
    assert.deepEqual(actions, [['tc_admin_token', 'current'], '/admin.html']);
  }

  // Render the actual workspace with a tiny DOM and mocked API. Verify visible
  // modules, product pagination, view-only controls and forbidden navigation.
  global.document = fakeDocument();
  const dashboard = new Element('div'); dashboard.id = 'dashboard';
  const legacy = new Element('section'); legacy.textContent = 'Sensitive legacy content'; dashboard.append(legacy); document.body.append(dashboard);
  const traffic = [];
  const fakeApi = async (p, m, b) => {
    traffic.push([p, m, b]);
    if (p === '/admin/classification/stats') return { total: 125, classified: 100, pending: 25 };
    if (p.startsWith('/admin/catalog/products?')) return { products: [{ id: 'p1', sku: 'REF1', name: 'Tênis azul', brand: 'Marca', category: 'Tênis', price: 100, sizes: [] }], total: 125, page: Number(new URLSearchParams(p.split('?')[1]).get('page')), pages: 3 };
    if (p === '/admin/labels/batches') return { batches: [{ id: 'batch1', name: 'Lote', totalLabels: 12, template: { name: 'Modelo' } }] };
    throw Error('Unexpected API call: ' + p);
  };
  await UI.mount({ user: { name: 'Designer', role: 'design_view' }, api: fakeApi, token: () => 't', logout() {} });
  assert.equal(legacy.style.display, 'none');
  assert.equal(traffic.length, 1); assert.equal(traffic[0][0], '/admin/classification/stats');
  const host = document.getElementById('design-workspace');
  assert.doesNotMatch(textOf(host), /Transações|Vendedores|Financeiro|Clientes TenisCash/);
  assert.match(textOf(host), /Somente consulta/);
  assert.equal(await UI.navigate('users'), false); assert.equal(traffic.length, 1);
  await UI.navigate('catalog');
  assert.match(traffic.at(-1)[0], /active=all/); assert.match(traffic.at(-1)[0], /page=1/);
  for (const b of host.querySelectorAll('button').filter(b => b.dataset.designMutation)) { assert.equal(b.hidden, true); assert.equal(b.disabled, true); }
  await findButton(host, 'Próxima').click(); assert.match(traffic.at(-1)[0], /page=2/);
  await UI.navigate('labels'); assert.equal(findButton(host, 'Gerar PDF'), undefined); assert.equal(findButton(host, 'Gerar lote'), undefined);
  UI.reset(); assert.equal(legacy.style.display, ''); assert.equal(host.hidden, true);
  await UI.mount({ user: { name: 'Designer', role: 'design' }, api: fakeApi, token: () => 't', logout() {} });
  await UI.navigate('catalog'); assert.equal(findButton(host, 'Criar produto').hidden, false);
  await findButton(host, 'Criar produto').click();
  const d = document.querySelector('.da-dialog'); assert(d);
  const all = n => [n, ...n.children.flatMap(all)];
  const names = all(d).map(e => e.name).filter(Boolean);
  assert(names.includes('price')); assert(names.includes('modality'));
  for (const forbidden of ['sizes', 'stock', 'costPrice', 'source', 'ncm', 'promoPrice']) assert.equal(names.includes(forbidden), false);
  assert.equal(traffic.some(([p]) => /users|transactions|suppliers|finance|messages|ai\/stats/.test(p)), false);

  // Owner controls operate on a selected existing account and submit the role
  // observed during selection, rather than guessing or creating credentials.
  const sellers = new Element('section'); sellers.id = 'tab-sellers'; document.body.append(sellers);
  const roleCalls = [], account = { id: 'existing-1', name: 'Pessoa', phone: '123', role: 'user' };
  const roleApi = async (p, method, body) => { roleCalls.push([p, method, body]); return p.startsWith('/admin/users?') ? { users: [account] } : { users: [] }; };
  UI.ownerPanel({ role: 'manager' }, roleApi); assert.equal(document.getElementById('design-owner-access'), null);
  UI.ownerPanel({ role: 'superadmin' }, roleApi); assert.equal(roleCalls.length, 0);
  const owner = document.getElementById('design-owner-access'); all(owner).find(e => e.name === 'user').value = 'Pessoa';
  await findButton(owner, 'Buscar conta').click(); await findButton(owner, 'Pessoa · 123 · user').click(); await findButton(owner, 'Aplicar permissão').click();
  assert.deepEqual(roleCalls.find(([, method]) => method === 'POST'), ['/admin/design-access', 'POST', { userId: 'existing-1', mode: 'edit', expectedRole: 'user' }]);

  // Syntax-check the real inline scripts without executing their legacy UI.
  for (const file of ['public/admin.html', 'public/index.html']) {
    let n = 0;
    for (const match of read(file).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
      if (!match[1].trim()) continue;
      new vm.Script(match[1], { filename: file + ':inline-' + (++n) });
    }
  }
  console.log('Design UI: role refresh, restricted navigation, API policy contract, pagination, editor payload and view-only DOM passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
