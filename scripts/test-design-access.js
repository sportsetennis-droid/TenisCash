'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/services/designAccess');
const rankingOwner = require('../src/services/rankingOwner');

// Run the complete production middleware and admin router in a VM. Only the
// JWT library boundary, Express registration, and persistence are fixtures.
// This test needs no database, network, installed Prisma client, or secrets.
function harness() {
  const users = new Map([
    { id: 'owner', role: 'superadmin' }, { id: 'automation', role: 'superadmin' },
    { id: 'admin', role: 'admin' }, { id: 'manager', role: 'manager' },
    { id: 'editor', role: 'design' }, { id: 'viewer', role: 'design_view' },
    { id: 'seller', role: 'seller' }, { id: 'store', role: 'store' },
    { id: 'customer', role: 'user' }, { id: 'inactive', role: 'design', active: false },
  ].map(item => [item.id, {
    name: item.id, email: item.id + '@example.test', phone: '000000000',
    active: true, storeId: 'store-a', storeIds: ['store-a', 'store-b'],
    pin: 'unchanged-private-hash', ...item,
  }]));
  const calls = { reads: 0, audits: [], updates: [], transactions: 0, listSelect: null };
  const failure = { database: false, concurrent: false, audit: false, ownerChanged: false };
  let inTransaction = false;
  function project(user, select) {
    if (!user) return null;
    if (!select) return { ...user };
    return Object.fromEntries(Object.keys(select).map(key => [key, user[key]]));
  }
  const prisma = {
    $use() {},
    config: { findUnique: async () => ({
      value: JSON.stringify({ userId: 'owner', evidenceId: 'verified-test-owner' }),
    }) },
    user: {
      findUnique: async ({ where, select }) => {
        calls.reads++;
        if (failure.database) throw new Error('database failure must not leak');
        if (failure.ownerChanged && inTransaction && where.id === 'owner') return null;
        return project(users.get(where.id), select);
      },
      findMany: async ({ where, select }) => {
        calls.listSelect = Object.keys(select);
        return [...users.values()].filter(user => where.role.in.includes(user.role)).map(user => project(user, select));
      },
      updateMany: async ({ where, data }) => {
        const user = users.get(where.id);
        if (failure.concurrent || !user || user.role !== where.role || user.active !== where.active) return { count: 0 };
        calls.updates.push({ where, data });
        users.set(user.id, { ...user, ...data });
        return { count: 1 };
      },
    },
    adminAction: { create: async ({ data }) => {
      if (failure.audit) throw new Error('audit failure');
      calls.audits.push(data);
      return data;
    } },
    $transaction: async callback => {
      calls.transactions++;
      const savedUsers = [...users.entries()].map(([id, user]) => [id, { ...user }]);
      const savedAuditLength = calls.audits.length;
      inTransaction = true;
      try { return await callback(prisma); }
      catch (err) {
        users.clear();
        savedUsers.forEach(([id, user]) => users.set(id, user));
        calls.audits.length = savedAuditLength;
        throw err;
      } finally { inTransaction = false; }
    },
  };
  function execute(file, requires) {
    const sandbox = {
      module: { exports: {} }, exports: {}, console, process: { env: { JWT_SECRET: 'fixture-only' } },
      require(name) {
        if (Object.hasOwn(requires, name)) return requires[name];
        throw new Error('Unexpected dependency ' + name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
    return sandbox.module.exports;
  }
  const middleware = execute('src/middleware.js', {
    jsonwebtoken: { verify(token) {
      if (!token || token === 'invalid') throw new Error('invalid');
      if (token === 'foreign-scope') return { mf: true, id: 'other-system' };
      const [userId, role] = token.split(':');
      return { userId, role };
    } },
    crypto: require('node:crypto'),
    '@prisma/client': { PrismaClient: function PrismaClient() { return prisma; } },
    './services/internalBarcode': { allocateInternalBarcode: async () => 'not-used' },
    './services/designAccess': policy,
  });
  const parentGuards = [];
  const routes = new Map();
  const router = { use(...handlers) { parentGuards.push(...handlers); } };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    router[method] = (route, ...handlers) => routes.set(method.toUpperCase() + ' ' + route, handlers);
  }
  execute('src/routes/admin.js', {
    express: { Router: () => router },
    '../middleware': middleware,
    '../services/sellerRole': require('../src/services/sellerRole'),
    '../services/rankingOwner': rankingOwner,
    '../services/designAccess': policy,
  });
  function request(userId = 'editor', originalUrl = '/api/admin/catalog/products', method = 'GET', body = {}, tokenRole = 'admin') {
    return {
      originalUrl, method, body, headers: { authorization: 'Bearer ' + userId + ':' + tokenRole }, query: {},
      path: originalUrl.split('?')[0].replace(/^\/api\/admin/, ''),
    };
  }
  async function run(req, handlers) {
    const res = { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    let completed = true;
    for (const handler of handlers) {
      let next = false;
      await handler(req, res, () => { next = true; });
      if (!next) { completed = false; break; }
    }
    return { ...res, completed, req };
  }
  const productRequest = req => run(req, [...parentGuards, middleware.authMiddleware, middleware.productAdminMiddleware]);
  const accountRequest = (operator, method, body) => run(
    request(operator, '/api/admin/design-access', method, body),
    [...parentGuards, ...routes.get(method + ' /design-access')],
  );
  return { users, calls, failure, middleware, parentGuards, request, run, productRequest, accountRequest };
}

async function main() {
  const allowed = [
    ['GET', '/api/auth/me'],
    ['GET', '/api/admin/catalog/products?search=tenis'],
    ['GET', '/api/admin/catalog/products/product-1'],
    ['PUT', '/api/admin/catalog/products/product-1'],
    ['POST', '/api/admin/catalog/products'],
    ['GET', '/api/admin/categories/tree/'],
    ['POST', '/api/admin/categories'],
    ['PUT', '/api/admin/categories/category-1'],
    ['DELETE', '/api/admin/categories/category-1'],
    ['POST', '/api/admin/categories/category-1/assign-products'],
    ['POST', '/api/admin/product-images/upload/product-1'],
    ['POST', '/api/admin/product-images/standardize/product-1'],
    ['DELETE', '/api/admin/product-images/video/product-1'],
    ['GET', '/api/admin/inventory/products'],
    ['GET', '/api/stocktake/biped-product-ids'],
    ['GET', '/api/stocktake/located-product-ids'],
    ['GET', '/api/admin/classification/stats'],
    ['PATCH', '/api/admin/classification/product-1'],
    ['PUT', '/api/admin/vitrine/slots'],
    ['GET', '/api/admin/labels/templates'],
    ['POST', '/api/admin/labels/batches/quick'],
    ['GET', '/api/labels/batches/batch-1/pdf'],
    ['GET', '/api/catalog/products/product-1'],
  ];
  for (const [method, originalUrl] of allowed) {
    assert.equal(policy.isDesignRequestAllowed({ userRole: 'design', method, originalUrl }), true, method + ' ' + originalUrl);
    const viewerAllowed = method === 'GET' && !originalUrl.endsWith('/pdf');
    assert.equal(policy.isDesignRequestAllowed({ userRole: 'design_view', method, originalUrl }), viewerAllowed, 'view: ' + originalUrl);
  }
  assert.equal(policy.isDesignRequestAllowed({ userRole: 'design_view', method: 'HEAD', originalUrl: '/api/admin/catalog/products' }), true);

  const forbidden = [
    ['GET', '/api/admin/users'], ['GET', '/api/admin/users/search'], ['GET', '/api/admin/dashboard'],
    ['POST', '/api/admin/credit'], ['POST', '/api/admin/debit'], ['POST', '/api/admin/manager/promote'],
    ['GET', '/api/admin/financial'], ['GET', '/api/admin/fiscal/status'], ['GET', '/api/admin/config/key'],
    ['GET', '/api/admin/pagbank-stores'], ['GET', '/api/admin/suppliers/supplier-1'],
    ['GET', '/api/admin/product-images/diagnose'], ['GET', '/api/admin/product-images/test-key?key=x'],
    ['GET', '/api/admin/catalog/products/product-1/nfe-summary'],
    ['POST', '/api/admin/catalog/meta/connect'], ['GET', '/api/admin/catalog/meta/status'],
    ['POST', '/api/admin/catalog/products/product-1/confirm'], ['POST', '/api/admin/catalog/import-csv'],
    ['DELETE', '/api/admin/catalog/products/product-1'], ['POST', '/api/admin/catalog/enrich-batch'],
    ['POST', '/api/admin/catalog/enrich-cancel'], ['POST', '/api/admin/catalog/products/auto-fill'],
    ['POST', '/api/admin/ai-curation/product/product-1'],
    ['POST', '/api/admin/product-images/backfill-from-nuvemshop'],
    ['POST', '/api/admin/product-images/enrich-supplier/12345678901234'],
    ['POST', '/api/admin/labels/batches/auto'],
    ['GET', '/api/admin/labels/campaign-footwear'], ['HEAD', '/api/labels/campaign-footwear'],
    ['POST', '/api/admin/inventory/adjust'], ['POST', '/api/stocktake/bipe'],
    ['POST', '/api/admin/labels/brand-thirty-offer'], ['POST', '/api/labels/bipe-cadastra'],
    ['GET', '/api/admin/orchestrator/approvals/pending'], ['POST', '/api/admin/anthropic-tools/files/chat'],
    ['GET', '/api/wallet/balance'], ['POST', '/api/transfer/send'], ['GET', '/api/messages'],
    ['POST', '/api/classification/start'], ['GET', '/api/classification/events'],
    ['GET', '/api/admin/design-access'], ['POST', '/api/admin/design-access'],
    ['POST', '/api/admin/categories/tree/extra'], ['PATCH', '/api/admin/catalog/products/product-1'],
    ['GET', '/api/admin/catalog/products-extra'], ['GET', '/api/admin/catalog/products/../users'],
    ['GET', '/api/admin/catalog/products/%2e%2e/users'], ['GET', '/api/admin/catalog/products/x%2Fy'],
    ['GET', '/api/admin/catalog//products'], ['GET', '/api/admin/catalog\\products'],
    ['GET', '//api/admin/catalog/products'], ['OPTIONS', '/api/admin/catalog/products'],
  ];
  for (const role of ['design', 'design_view']) {
    const fixture = harness();
    for (const [method, originalUrl] of forbidden) {
      assert.equal(policy.isDesignRequestAllowed({ userRole: role, method, originalUrl }), false, role + ': ' + originalUrl);
      const result = await fixture.run(fixture.request(role === 'design' ? 'editor' : 'viewer', originalUrl, method), [fixture.middleware.authMiddleware]);
      assert.equal(result.code, 403, 'auth blocks ' + role + ': ' + originalUrl);
    }
    assert.equal(fixture.calls.transactions, 0);
  }

  const fixture = harness();
  for (const token of [null, 'invalid', 'foreign-scope']) {
    const state = harness();
    const req = state.request();
    req.headers = token ? { authorization: 'Bearer ' + token } : {};
    const result = await state.run(req, [state.middleware.designIsolationMiddleware]);
    assert.equal(result.completed, true, 'global isolation defers missing/invalid/non-app auth to the route');
    assert.equal(state.calls.reads, 0);
  }
  const global = harness();
  assert.equal((await global.run(global.request('editor', '/api/ai/conversations'), [global.middleware.designIsolationMiddleware])).code, 403,
    'global guard blocks legacy optional-auth endpoints before they decode a stale admin JWT');
  assert.equal((await global.run(global.request('inactive', '/api/ai/conversations'), [global.middleware.designIsolationMiddleware])).code, 401);
  assert.equal((await global.run(global.request('owner', '/api/ai/conversations'), [global.middleware.designIsolationMiddleware])).completed, true);
  const cached = harness();
  assert.equal((await cached.run(cached.request(), [cached.middleware.designIsolationMiddleware, ...cached.parentGuards,
    cached.middleware.authMiddleware, cached.middleware.productAdminMiddleware])).completed, true);
  assert.equal(cached.calls.reads, 1, 'global isolation and nested routers reuse the same request identity');
  const stale = fixture.request('editor'); // signed admin role, current Design role
  assert.equal((await fixture.productRequest(stale)).completed, true, 'parent mount must pass permitted products');
  assert.equal(stale.userRole, 'design', 'current role replaces JWT claim');
  assert.equal(fixture.calls.reads, 1, 'repeated mounts reuse identity only within this request');
  stale.userRole = 'admin';
  stale.originalUrl = '/api/admin/financial';
  assert.equal((await fixture.run(stale, [fixture.middleware.authMiddleware])).code, 403, 'cache cannot bypass current route restriction');
  assert.equal(stale.userRole, 'design', 'request role tampering cannot affect cached verified identity');
  assert.equal((await fixture.productRequest(fixture.request('viewer', undefined, 'PUT'))).code, 403);
  for (const id of ['inactive', 'missing']) {
    assert.equal((await fixture.productRequest(fixture.request(id))).code, 401);
  }
  const invalid = fixture.request();
  invalid.headers.authorization = 'Bearer invalid';
  assert.equal((await fixture.productRequest(invalid)).code, 401);
  const absent = fixture.request();
  absent.headers = {};
  assert.equal((await fixture.productRequest(absent)).code, 401);
  const query = fixture.request();
  query.headers = {};
  query.query.token = 'editor:admin';
  assert.equal((await fixture.productRequest(query)).completed, true);
  fixture.failure.database = true;
  const failed = await fixture.productRequest(fixture.request());
  assert.equal(failed.code, 503);
  assert.equal(JSON.stringify(failed.body).includes('database failure'), false);
  fixture.failure.database = false;
  fixture.users.get('editor').role = 'user';
  assert.equal((await fixture.productRequest(fixture.request('editor'))).code, 403, 'revocation applies on the next request');
  for (const id of ['owner', 'admin', 'manager']) {
    assert.equal((await fixture.run(fixture.request(id, '/api/admin/users'), [...fixture.parentGuards])).completed, true, id + ' retains admin');
  }
  for (const id of ['seller', 'store']) {
    assert.equal((await fixture.run(fixture.request(id, '/api/admin/fiscal/status'), fixture.parentGuards)).completed, true, id + ' retains fiscal parent exception');
    assert.equal((await fixture.productRequest(fixture.request(id))).code, 403);
  }

  for (const operator of ['automation', 'admin', 'manager', 'editor', 'viewer', 'seller', 'customer']) {
    const state = harness();
    const result = await state.accountRequest(operator, 'POST', { userId: 'seller', mode: 'edit', expectedRole: 'seller' });
    assert.equal(result.code, 403, operator + ' is not the verified owner');
    assert.equal(state.calls.updates.length, 0);
  }
  const accounts = harness();
  const listing = await accounts.accountRequest('owner', 'GET');
  assert.equal(listing.code, 200);
  assert.deepEqual(listing.body.users.map(user => user.id).sort(), ['editor', 'inactive', 'viewer']);
  assert.equal(accounts.calls.listSelect.some(key => ['pin', 'balance', 'storeIds', 'cpf'].includes(key)), false);
  for (const target of ['owner', 'automation', 'store']) {
    const result = await accounts.accountRequest('owner', 'POST', { userId: target, mode: 'edit', expectedRole: accounts.users.get(target).role });
    assert.equal(result.code, 400, 'protected target: ' + target);
  }
  assert.equal((await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'edit' })).code, 400);
  assert.equal((await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'edit', expectedRole: 'admin' })).code, 409);
  assert.equal((await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'none', expectedRole: 'seller' })).code, 400);
  assert.equal((await accounts.accountRequest('owner', 'POST', { userId: 'inactive', mode: 'edit', expectedRole: 'design' })).code, 400);
  const before = JSON.parse(JSON.stringify(accounts.users.get('seller')));
  const granted = await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'edit', expectedRole: 'seller' });
  assert.equal(granted.body.user.role, 'design');
  assert.deepEqual(accounts.users.get('seller'), { ...before, role: 'design' });
  assert.deepEqual(Object.keys(accounts.calls.updates[0].data), ['role']);
  assert.deepEqual(JSON.parse(accounts.calls.audits[0].metadata), { previousRole: 'seller', role: 'design', mode: 'edit' });
  const repeated = await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'edit', expectedRole: 'design' });
  assert.equal(repeated.body.changed, false);
  assert.equal(accounts.calls.audits.length, 1);
  const view = await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'view', expectedRole: 'design' });
  assert.equal(view.body.user.role, 'design_view');
  const revoked = await accounts.accountRequest('owner', 'POST', { userId: 'seller', mode: 'none', expectedRole: 'design_view' });
  assert.equal(revoked.body.user.role, 'user', 'revocation never restores a previous administrative role');
  assert.deepEqual(accounts.users.get('seller'), { ...before, role: 'user' });

  for (const [failure, status] of [['concurrent', 409], ['audit', 500], ['ownerChanged', 403]]) {
    const state = harness();
    state.failure[failure] = true;
    const result = await state.accountRequest('owner', 'POST', { userId: 'seller', mode: 'edit', expectedRole: 'seller' });
    assert.equal(result.code, status, failure);
    assert.equal(state.users.get('seller').role, 'seller', failure + ' must not leave a role change');
    assert.equal(state.calls.audits.length, 0);
  }
  console.log('Design access: policy, current identity, nested guards, owner-only role changes, concurrency and rollback passed.');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
