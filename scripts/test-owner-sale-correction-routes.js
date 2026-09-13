const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { OWNER_RECORD_KEY, getRankingOwner } = require('../src/services/rankingOwner');
const { salesVisibility } = require('../src/services/salesVisibility');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/routes/seller.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/loja.html'), 'utf8');
function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing source section: ${startMarker}`);
  return text.slice(start, end);
}
const routeSource = section(source, "router.get('/sales'", "router.get('/rankings'");
const sellerOnlySource = section(source, 'function sellerOnly(', 'function commissionReviewerOnly(');
const marker = { value: JSON.stringify({ userId: 'owner', evidenceId: 'verified-owner-repair' }) };
const fixtureUsers = [
  { id: 'owner', name: 'Douglas', role: 'superadmin', active: true, storeId: null, storeIds: [] },
  { id: 'primary', name: 'Ana', role: 'seller', active: true, storeId: 'a', storeIds: [] },
  { id: 'additional', name: 'Bia', role: 'seller', active: true, storeId: 'b', storeIds: ['a'] },
  { id: 'other-store', name: 'Carlos', role: 'seller', active: true, storeId: 'b', storeIds: [] },
  { id: 'unassigned', name: 'Sem loja', role: 'seller', active: true, storeId: null, storeIds: [] },
  { id: 'inactive', name: 'Inativo', role: 'seller', active: false, storeId: 'a', storeIds: [] },
  { id: 'store', name: 'Caixa', role: 'store', active: true, storeId: 'a', storeIds: [] },
  { id: 'admin', name: 'Administrador', role: 'admin', active: true, storeId: 'a', storeIds: [] },
  { id: 'manager', name: 'Gerente', role: 'manager', active: true, storeId: 'a', storeIds: [] },
  { id: 'printbot', name: 'PrintBot', role: 'superadmin', active: true, storeId: null, storeIds: [] },
  { id: 'second-admin', name: 'Outro superadmin', role: 'superadmin', active: true, storeId: 'a', storeIds: [] },
  { id: 'customer', name: 'Cliente', role: 'user', active: true, storeId: 'a', storeIds: [] },
];
const fixtureSale = {
  id: 'sale-a', sellerId: 'primary', storeId: 'a', status: 'completed',
  createdAt: new Date('2026-09-13T14:00:00-03:00'), totalAmount: 100,
  tcEarned: 0, tcUsed: 0, items: [{ productName: 'Tênis', quantity: 1, unitPrice: 100 }],
};

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some(condition => matches(row, condition));
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(condition => matches(row, condition));
    if (expected !== null && typeof expected === 'object') {
      if ('in' in expected) return expected.in.includes(row[key]);
      if ('has' in expected) return (row[key] || []).includes(expected.has);
      throw new Error('Unsupported fixture query: ' + key);
    }
    return row[key] === expected;
  });
}
function select(row, fields) {
  if (!row || !fields) return row;
  return Object.fromEntries(Object.keys(fields).map(key => [key, row[key]]));
}

// Execute the real route bodies and sellerOnly middleware, with the real owner
// identity resolver. Database and correction writes are replaced by fixtures.
async function request(method, route, operatorId, options = {}) {
  const users = fixtureUsers.map(user => user.id === 'owner' ? { ...user, ...options.owner } : { ...user });
  const operator = users.find(user => user.id === operatorId);
  const sale = options.sale === null ? null : { ...fixtureSale, ...options.sale };
  const calls = { saleReads: 0, saleLists: 0, userLists: 0, correction: [] };
  const prisma = {
    config: { findUnique: async ({ where }) => {
      assert.equal(where.key, 'repair-owner-access-20260910');
      return Object.hasOwn(options, 'marker') ? options.marker : marker;
    } },
    user: {
      findUnique: async ({ where, select: fields }) => select(users.find(user => user.id === where.id) || null, fields),
      findMany: async ({ where, select: fields }) => {
        calls.userLists++;
        return users.filter(user => matches(user, where)).sort((a, b) => a.name.localeCompare(b.name)).map(user => select(user, fields));
      },
    },
    sale: {
      findUnique: async ({ where }) => {
        calls.saleReads++;
        if (!sale || sale.id !== where.id) return null;
        return { ...sale, seller: { name: users.find(user => user.id === sale.sellerId)?.name } };
      },
      findMany: async ({ where }) => {
        calls.saleLists++;
        return sale && matches(sale, where) ? [{ ...sale }] : [];
      },
    },
    fiscalDocument: { findMany: async () => [] },
    sellerClient: { findMany: async () => [] },
  };
  const routes = new Map();
  vm.runInNewContext(sellerOnlySource + routeSource, {
    prisma, getRankingOwner, salesVisibility,
    console: { error() {} },
    correctSaleSeller: async (client, payload) => {
      assert.equal(client, prisma);
      calls.correction.push(JSON.parse(JSON.stringify(payload)));
      if (options.serviceError) throw options.serviceError;
      return { ok: true, changed: true, sale: { id: payload.saleId, sellerId: payload.sellerId } };
    },
    router: {
      get(url, ...handlers) { routes.set('GET ' + url, handlers); },
      post(url, ...handlers) { routes.set('POST ' + url, handlers); },
    },
  });
  let status = 200, result;
  const headers = {};
  const req = {
    userId: operatorId, userRole: options.tokenRole || operator?.role,
    params: { id: options.saleId || 'sale-a' }, query: options.query || {}, body: options.body || {},
    scope: { isStoreLocked: operator?.role === 'store', storeId: operator?.storeId },
  };
  const res = {
    status(code) { status = code; return this; },
    json(value) { result = value; return this; },
    set(key, value) { headers[key] = value; return this; },
  };
  const handlers = routes.get(method + ' ' + route);
  assert.ok(handlers, `Missing route: ${method} ${route}`);
  for (let index = 0; index < handlers.length; index++) {
    let nextCalled = false;
    await handlers[index](req, res, () => { nextCalled = true; });
    if (!nextCalled) break;
  }
  return { status, result, calls, headers };
}

const correctionRoute = '/sale/:id/seller-correction';
const validBody = { sellerId: 'additional', expectedSellerId: 'primary', reason: 'Vendedor selecionado por engano' };
async function assertDenied(operatorId, options = {}) {
  for (const method of ['GET', 'POST']) {
    const response = await request(method, correctionRoute, operatorId, { body: validBody, ...options });
    assert.equal(response.status, 403, `${method}: ${operatorId} ${JSON.stringify(options)}`);
    assert.equal(response.calls.saleReads, 0, 'Denied correction must not read a sale');
    assert.equal(response.calls.userLists, 0, 'Denied correction must not enumerate sellers');
    assert.equal(response.calls.correction.length, 0, 'Denied correction must not call the service');
  }
}

async function checkFrontend() {
  const listSource = section(html, 'async function loadSalesList()', 'function closeSaleModal(');
  const detailSource = section(html, 'function showSaleDetail(', 'async function openSaleSellerCorrection(');
  const correctionSource = section(html, 'async function openSaleSellerCorrection(', 'function reprintSale(');
  const escapeSource = html.match(/function escPreco\(s\)\s*\{[^\n]+\}/)?.[0];
  assert.ok(escapeSource, 'Missing shared HTML escape helper');
  const grants = [...html.matchAll(/_canCorrectSales\s*=(?!=)([^;]+);/g)].map(match => match[1].trim());
  assert.ok(grants.includes('d.canCorrectSales === true'));
  assert.ok(grants.every(value => ['false', 'd.canCorrectSales === true'].includes(value)), 'Only a server boolean may grant correction access');
  assert.match(listSource, /_canCorrectSales && s\.status === 'completed'/);
  assert.match(detailSource, /_canCorrectSales && s\.status === 'completed'/);
  assert.match(correctionSource, /if \(!_canCorrectSales\) return;/);
  assert.doesNotMatch(correctionSource, /me\.role|userRole|superadmin/);

  for (const allowed of [false, true]) {
    let submit, dashboardReloads = 0;
    const apiCalls = [];
    const selectedName = 'Bia <img src=x onerror=alert(1)> & "Loja"';
    const currentName = 'Ana <script>alert(1)</script>';
    const targetId = 'additional" onfocus="alert(1)';
    const fields = {
      '#saleCorrectSeller': { value: targetId, options: [{ textContent: selectedName }], selectedIndex: 0 },
      '#saleCorrectionReason': { value: '  Vendedor selecionado por engano  ' },
      '#saleCorrectionSave': { style: {} }, '#saleCorrectionMessage': { style: {}, textContent: '' },
    };
    const summary = { textContent: currentName + ' · Dinheiro' };
    const area = {
      isConnected: true, innerHTML: '', textContent: '', style: {},
      querySelector(selector) {
        if (selector === 'form') return { addEventListener(event, handler) { assert.equal(event, 'submit'); submit = handler; } };
        return fields[selector];
      },
    };
    const overlay = { dataset: { saleId: 'sale/a' }, firstElementChild: { children: [null, summary] } };
    const sandbox = {
      _canCorrectSales: allowed,
      document: { getElementById(id) { return id === 'saleModalOverlay' ? overlay : id === 'saleSellerCorrection' ? area : null; } },
      showSaleDetail() { throw new Error('Existing matching sale modal should be reused'); },
      loadDashboard() { dashboardReloads++; },
      api: async (url, options) => {
        apiCalls.push({ url, options });
        if (options) return { ok: true };
        return { sale: { sellerId: 'primary', sellerName: currentName }, sellers: [
          { id: 'primary', name: currentName }, { id: targetId, name: selectedName },
        ] };
      },
    };
    vm.createContext(sandbox);
    vm.runInContext(escapeSource + '\n' + correctionSource, sandbox);
    await sandbox.openSaleSellerCorrection('sale/a');
    if (!allowed) {
      assert.equal(apiCalls.length, 0);
      assert.equal(area.innerHTML, '');
      continue;
    }
    assert.equal(apiCalls[0].url, '/api/seller/sale/sale%2Fa/seller-correction');
    assert.ok(area.innerHTML.includes('Ana &lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(area.innerHTML.includes('Bia &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Loja&quot;'));
    assert.ok(area.innerHTML.includes('value="additional&quot; onfocus=&quot;alert(1)"'));
    assert.ok(!area.innerHTML.includes('<option value="primary"'), 'Current seller must not be offered as a replacement');
    assert.doesNotMatch(area.innerHTML, /<script>|<img /);
    assert.equal(typeof submit, 'function');
    await submit({ preventDefault() {} });
    assert.equal(apiCalls[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(apiCalls[1].options.body), {
      sellerId: targetId, expectedSellerId: 'primary', reason: 'Vendedor selecionado por engano',
    });
    assert.doesNotMatch(area.innerHTML, /<img /);
    assert.ok(area.innerHTML.includes('&lt;img'));
    assert.equal(dashboardReloads, 1);
  }
}

async function checkOwnerRecordImmutability() {
  const adminSource = fs.readFileSync(path.join(root, 'src/routes/admin.js'), 'utf8');
  const configRoute = section(adminSource, "router.post('/config'", "router.get('/config/:key'");
  assert.equal(OWNER_RECORD_KEY, 'repair-owner-access-20260910');
  for (const user of fixtureUsers) {
    let handler, status = 200, result, writes = 0, audits = 0;
    const sandbox = {
      OWNER_RECORD_KEY,
      router: { post(url, callback) { assert.equal(url, '/config'); handler = callback; } },
      prisma: {
        config: { upsert: async ({ where, create, update }) => {
          writes++;
          assert.equal(where.key, 'store-display-label');
          assert.equal(create.key, where.key);
          assert.equal(update.value, 'Loja de teste');
          return create;
        } },
        adminAction: { create: async () => { audits++; return {}; } },
      },
    };
    vm.runInNewContext(configRoute, sandbox);
    const res = {
      status(code) { status = code; return this; },
      json(value) { result = value; return this; },
    };
    // Exercise the handler's immutable-record guard even for callers normally
    // stopped by adminMiddleware; no role can bypass the guard inside the route.
    await handler({ userId: user.id, userRole: user.role, body: {
      key: OWNER_RECORD_KEY, value: JSON.stringify({ userId: user.id, evidenceId: 'forged' }),
    } }, res);
    assert.equal(status, 403, 'Protected owner record: ' + user.id);
    assert.equal(writes, 0, 'Protected owner identity must be blocked before upsert');
    assert.equal(audits, 0);
    if (['admin', 'manager', 'superadmin'].includes(user.role)) {
      status = 200;
      await handler({ userId: user.id, userRole: user.role, body: { key: 'store-display-label', value: 'Loja de teste' } }, res);
      assert.equal(status, 200);
      assert.equal(result.success, true);
      assert.equal(writes, 1);
      assert.equal(audits, 1);
    }
  }
}

(async () => {
  for (const user of fixtureUsers.filter(user => user.id !== 'owner')) {
    await assertDenied(user.id);
    // A forged/stale elevated token does not turn another account into the owner.
    await assertDenied(user.id, { tokenRole: 'superadmin' });
  }
  await assertDenied('missing-user', { tokenRole: 'superadmin' });
  await assertDenied('owner', { owner: { active: false }, tokenRole: 'superadmin' });
  await assertDenied('owner', { owner: { role: 'seller' }, tokenRole: 'superadmin' });
  for (const invalidMarker of [null, { value: '{broken' }, { value: '{}' },
    { value: JSON.stringify({ userId: 'owner' }) },
    { value: JSON.stringify({ userId: 'owner', evidenceId: ' ' }) },
    { value: JSON.stringify({ userId: ' ', evidenceId: 'evidence' }) },
    { value: JSON.stringify({ userId: 'missing-user', evidenceId: 'evidence' }) },
  ]) {
    await assertDenied('owner', { marker: invalidMarker });
    const list = await request('GET', '/sales', 'owner', { marker: invalidMarker });
    assert.equal(list.status, 200);
    assert.equal(list.result.canCorrectSales, false, 'Invalid identity must never grant UI permission');
  }

  const options = await request('GET', correctionRoute, 'owner');
  assert.equal(options.status, 200);
  assert.deepEqual(Array.from(options.result.sellers, seller => seller.id).sort(), ['additional', 'owner', 'primary']);
  assert.deepEqual(JSON.parse(JSON.stringify(options.result.sale)), { id: 'sale-a', sellerId: 'primary', sellerName: 'Ana' });
  assert.equal(options.headers['Cache-Control'], 'private, no-store');
  for (const [sale, expectedStatus] of [[null, 404], [{ status: 'canceled' }, 409], [{ status: 'pending_payment' }, 409], [{ storeId: null }, 409]]) {
    const response = await request('GET', correctionRoute, 'owner', { sale });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.calls.userLists, 0, 'Invalid sale must not enumerate replacement sellers');
  }
  for (const user of fixtureUsers) {
    const response = await request('GET', '/sales', user.id);
    if (!user.active || user.role === 'user') assert.equal(response.status, 403);
    else {
      assert.equal(response.status, 200);
      assert.equal(response.result.canCorrectSales, user.id === 'owner', user.id);
    }
  }
  const inactiveList = await request('GET', '/sales', 'owner', { owner: { active: false } });
  assert.equal(inactiveList.status, 403);
  assert.equal(inactiveList.calls.saleLists, 0);

  for (const key of ['totalAmount', 'items', 'quantity', 'unitPrice', 'discount', 'tcEarned', 'tcUsed',
    'storeId', 'status', 'customerUserId', 'paymentMethod', 'ownerId', 'saleId', 'commissions', 'fiscal']) {
    const response = await request('POST', correctionRoute, 'owner', { body: { ...validBody, [key]: 'must-not-be-accepted' } });
    assert.equal(response.status, 400, key);
    assert.equal(response.calls.correction.length, 0, 'Forbidden fields must be rejected before service dispatch');
  }
  const corrected = await request('POST', correctionRoute, 'owner', { body: validBody });
  assert.equal(corrected.status, 200);
  assert.deepEqual(corrected.calls.correction, [{ ownerId: 'owner', saleId: 'sale-a', ...validBody }]);
  assert.equal(corrected.headers['Cache-Control'], 'private, no-store');
  for (const statusCode of [400, 403, 404, 409]) {
    const serviceError = Object.assign(new Error('Conflito validado pelo serviço'), { statusCode });
    const response = await request('POST', correctionRoute, 'owner', { body: validBody, serviceError });
    assert.equal(response.status, statusCode);
    assert.equal(response.result.error, serviceError.message);
  }
  const unexpected = await request('POST', correctionRoute, 'owner', { body: validBody, serviceError: new Error('internal database secret') });
  assert.equal(unexpected.status, 500);
  assert.doesNotMatch(unexpected.result.error, /internal database secret/);
  await checkFrontend();
  await checkOwnerRecordImmutability();
  console.log('PASS: canonical owner correction routes, denied identities before sale/service access, store-linked options, request whitelist, server-only UI permission, escaped correction form and immutable owner record; no real sale modified');
})().catch(error => { console.error(error); process.exitCode = 1; });
