'use strict';

// Real Express mounts and JWT verification, isolated in-memory persistence.
// No production server, database, external service or live credentials are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const policy = require('../src/services/designAccess');
const productData = require('../src/services/designProductData');

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const secret = 'design-products-local-fixture-secret';

function project(row, select) {
  if (!row) return null;
  return clone(select ? Object.fromEntries(Object.keys(select).filter(key => select[key]).map(key => [key, row[key]])) : row);
}

// Interpret only the Prisma predicates exercised here; unknown predicates fail
// loudly rather than accidentally making a broken route pass the fixture.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'AND') return expected.every(condition => matches(row, condition));
    if (key === 'OR') return expected.some(condition => matches(row, condition));
    if (key === 'NOT') return !matches(row, expected);
    let actual = row[key];
    if (!expected || typeof expected !== 'object') return actual === expected;
    if (expected.some) return (actual || []).some(item => matches(item, expected.some));
    if (expected.path) {
      if (typeof actual === 'string') actual = JSON.parse(actual);
      actual = expected.path.reduce((value, field) => value?.[field], actual);
    }
    const normalize = value => expected.mode === 'insensitive' ? String(value ?? '').toLowerCase() : value;
    return Object.entries(expected).every(([operator, value]) => {
      if (operator === 'path' || operator === 'mode') return true;
      if (operator === 'equals') return normalize(actual) === normalize(value);
      if (operator === 'contains' || operator === 'string_contains') return String(normalize(actual) ?? '').includes(normalize(value));
      if (operator === 'in') return value.includes(actual);
      if (operator === 'notIn') return !value.includes(actual);
      if (operator === 'gt') return actual > value;
      throw new Error('Unsupported fixture predicate: ' + operator);
    });
  });
}

function fixture() {
  const context = {
    color: 'Azul', supplierRef: 'MODEL-40', supplierCnpj: '00000000000000',
    classification: { gender: 'Homem', modality: 'Corrida', editedBy: 'PRIVATE_STAFF', internalAudit: 'PRIVATE_AUDIT' },
    nfeKey: 'PRIVATE_INVOICE', fiscal: { tax: 'PRIVATE_TAX' },
    lastSale: { cpf: 'PRIVATE_CUSTOMER' }, staffNotes: 'PRIVATE_STAFF_NOTES',
    releaseToNuvemshop: false,
  };
  const products = new Map(Array.from({ length: 627 }, (_, index) => {
    const suffix = String(index + 1).padStart(4, '0');
    const product = {
      id: 'product-' + suffix, sku: 'SKU-' + suffix, internalBarcode: 'LOCAL-' + suffix,
      name: 'Tênis ' + suffix, brand: 'Marca', category: 'Tênis', subcategory: 'Corrida',
      price: 299.9, costPrice: 130, ncm: '64041100', active: index < 601,
      imageUrl: 'https://example.test/product.png', updatedAt: '2026-09-22T00:00:00.000Z',
      createdById: 'PRIVATE_STAFF_ID', createdBy: { id: 'PRIVATE_STAFF_ID', name: 'PRIVATE_STAFF' },
      aiContext: index === 1 ? JSON.stringify(context) : clone(context),
      sizes: [{ id: 'size-' + suffix, productId: 'product-' + suffix, size: '40', barcode: 'EAN-' + suffix,
        stock: 4, internalAudit: 'PRIVATE_SIZE_AUDIT',
        storeStocks: [{ id: 'stock-' + suffix, storeId: 'store-a', stock: 4, invoiceItemId: 'PRIVATE_INVOICE_ITEM',
          store: { id: 'store-a', code: '01', name: 'Loja A', ownerCpf: 'PRIVATE_OWNER_CPF' } }],
      }],
    };
    return [product.id, product];
  }));
  const users = new Map(['design', 'design_view', 'admin', 'user'].map(role => [role, {
    id: role, role, active: true, storeId: null, storeIds: [],
  }]));
  users.set('inactive', { id: 'inactive', role: 'design', active: false, storeId: null, storeIds: [] });
  const nodes = new Map([['category-1', { id: 'category-1', name: 'Tênis', level: 'CATEGORY', parentId: null, position: 0, active: true }]]);
  const calls = { lists: [], writes: [], sizeDeletes: [], categoryWrites: [], userLists: 0, userReads: 0, forbiddenEndpoint: 0 };
  const failures = { database: false };
  const prisma = {
    $use() {},
    user: {
      findUnique: async ({ where, select }) => {
        calls.userReads++;
        if (failures.database) throw new Error('PRIVATE_DATABASE_FAILURE');
        return project(users.get(where.id), select);
      },
      findMany: async () => { calls.userLists++; return [...users.values()].map(clone); },
      count: async () => users.size,
    },
    product: {
      findUnique: async ({ where, select }) => project(products.get(where.id), select),
      findMany: async (query = {}) => {
        calls.lists.push(clone(query));
        let result = [...products.values()].filter(row => matches(row, query.where));
        const order = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy || { id: 'asc' }];
        result.sort((left, right) => {
          for (const clause of order) {
            const [field, direction] = Object.entries(clause)[0];
            const difference = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
            if (difference) return direction === 'desc' ? -difference : difference;
          }
          return 0;
        });
        return result.slice(query.skip || 0, (query.skip || 0) + (query.take ?? result.length)).map(row => project(row, query.select));
      },
      count: async ({ where } = {}) => [...products.values()].filter(row => matches(row, where)).length,
      update: async ({ where, data }) => {
        calls.writes.push(clone({ where, data }));
        const updated = { ...products.get(where.id), ...clone(data) };
        if (data.sizes?.create) updated.sizes = data.sizes.create.map((size, index) => ({ id: 'updated-size-' + index, ...clone(size) }));
        products.set(where.id, updated);
        return clone(updated);
      },
      create: async ({ data }) => {
        calls.writes.push(clone({ data }));
        const product = { id: 'new-product', ...clone(data), sizes: data.sizes.create.map((size, index) => ({ id: 'new-size-' + index, ...size })) };
        products.set(product.id, product);
        return clone(product);
      },
    },
    productSize: { deleteMany: async query => { calls.sizeDeletes.push(clone(query)); return { count: 1 }; } },
    productLifecycle: { findMany: async () => [] },
    nuvemshopProductMapping: { findMany: async () => [], findUnique: async () => null },
    nuvemshopConnection: { findFirst: async () => null },
    tiktokShopProductMapping: { findMany: async () => [] },
    categoryNode: {
      findMany: async () => [...nodes.values()].map(clone),
      findUnique: async ({ where }) => clone(nodes.get(where.id) || null),
      create: async ({ data }) => {
        const node = { id: 'new-category', active: true, ...clone(data) };
        nodes.set(node.id, node); calls.categoryWrites.push(clone(data)); return clone(node);
      },
      update: async ({ where, data }) => {
        const node = { ...nodes.get(where.id), ...clone(data) };
        nodes.set(where.id, node); calls.categoryWrites.push(clone(data)); return clone(node);
      },
    },
  };

  function execute(file, dependencies) {
    const sandbox = {
      module: { exports: {} }, exports: {}, console,
      process: { env: { JWT_SECRET: secret } }, setImmediate, setTimeout, clearTimeout, URL, Buffer,
      require(name) {
        if (own(dependencies, name)) return dependencies[name];
        throw new Error('Unexpected dependency in isolated test: ' + file + ' -> ' + name);
      },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox, { filename: file });
    return sandbox.module.exports;
  }
  const middleware = execute('src/middleware.js', {
    jsonwebtoken: jwt, crypto: require('node:crypto'),
    '@prisma/client': { PrismaClient: function PrismaClient() { return prisma; } },
    './services/internalBarcode': { allocateInternalBarcode: async () => { throw new Error('Unexpected barcode allocation'); } },
    './services/designAccess': policy,
  });
  const common = {
    express, '../middleware': middleware,
    '../services/designAccess': policy, '../services/designProductData': productData,
    '../services/nuvemshopHandlers': { pushProductToNuvemshop: async () => { throw new Error('External sync forbidden in tests'); } },
  };
  const admin = execute('src/routes/admin.js', {
    ...common, '../services/sellerRole': require('../src/services/sellerRole'),
    '../services/rankingOwner': { OWNER_RECORD_KEY: 'fixture-owner', getRankingOwner: async () => null },
  });
  const catalog = execute('src/routes/adminCatalog.js', {
    ...common, multer: require('multer'), papaparse: {},
    '@anthropic-ai/sdk': function Anthropic() { throw new Error('External AI forbidden in tests'); },
    '../services/metaCatalogSync': {},
  });
  const metadata = execute('src/routes/products.js', common);
  const categories = execute('src/routes/categories.js', common);
  const inventory = execute('src/routes/inventory.js', {
    ...common, '../services/stockVerification': {
      loadVerification: async () => ({ rows: [], orphanPending: 0, unidentifiedPending: 0 }),
      attachVerification() {}, matchesVerification: () => true,
    },
  });
  const publicCatalog = execute('src/routes/catalog.js', {
    ...common, jsonwebtoken: jwt,
    '../services/stockVerification': {}, '../services/catalogSearch': {},
  });
  const optionalCatalogAuth = publicCatalog.stack.find(layer => layer.route?.path === '/products').route.stack[0].handle;
  assert.equal(optionalCatalogAuth.name, 'optionalCatalogAuth', 'load the real public catalog authentication handler');
  const app = express();
  app.use(express.json());
  // Exercise the optional handler itself before the global guard so a guard
  // rejection cannot hide an accidental anonymous fallback inside this handler.
  app.get('/api/catalog/products', (req, _res, next) => {
    req.userId = 'untrusted-old-identity'; req.userRole = 'admin'; next();
  }, optionalCatalogAuth, (req, res) => res.json({ userId: req.userId, userRole: req.userRole }));
  app.use('/api', middleware.designIsolationMiddleware);
  // Preserve src/index.js mount order: the broad admin router runs first.
  app.use('/api/admin', admin);
  app.use('/api/admin/catalog', catalog);
  app.use('/api/admin/categories', categories);
  app.use('/api/admin/inventory', inventory);
  app.use('/api/admin/products', metadata);
  // Sentinels prove forbidden requests cannot fall through the parent guard.
  app.all(['/api/admin/fiscal/status', '/api/admin/inventory/adjust'], (_req, res) => {
    calls.forbiddenEndpoint++; res.json({ sentinel: true });
  });
  return { app, products, calls, context, failures };
}

function assertPrivateFieldsAbsent(product) {
  assert.ok(product && product.id, 'expected a real product response');
  for (const field of ['createdBy', 'createdById', 'ncm', 'cest', 'cfop', 'source']) {
    assert.equal(own(product, field), false, 'private product field: ' + field);
  }
  assert.equal(JSON.stringify(product).includes('PRIVATE_'), false, 'nested staff/fiscal/customer metadata must be absent');
}

async function main() {
  const state = fixture();
  const server = http.createServer(state.app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + server.address().port;
  let requests = 0;
  async function request(role, method, route, body, options = {}) {
    requests++;
    const token = own(options, 'token') ? options.token : jwt.sign({ userId: role, role: 'admin' }, secret, { expiresIn: '5m' });
    const response = await fetch(base + route, {
      method, headers: {
        ...(token === null ? {} : { authorization: 'Bearer ' + token }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  const catalog = '/api/admin/catalog/products';
  const firstId = 'product-0001';
  try {
    const expired = jwt.sign({ userId: 'design', role: 'admin' }, secret, { expiresIn: -1 });
    const missingIdentity = jwt.sign({ role: 'admin' }, secret, { expiresIn: '5m' });
    for (const token of [null, 'invalid-token', expired, missingIdentity]) {
      const readsBefore = state.calls.userReads;
      const visitor = await request(null, 'GET', '/api/catalog/products', undefined, { token });
      assert.equal(visitor.status, 200, 'public catalog remains accessible without a valid session');
      assert.deepEqual(visitor.body, { userId: null, userRole: null }, 'invalid optional identity is cleared');
      assert.equal(state.calls.userReads, readsBefore, 'anonymous catalog does not query account identity');
    }
    const readsBefore = state.calls.userReads;
    const currentDesign = await request('design', 'GET', '/api/catalog/products');
    assert.equal(currentDesign.status, 200);
    assert.deepEqual(currentDesign.body, { userId: 'design', userRole: 'design' }, 'valid old admin JWT uses the current Design role');
    assert.equal(state.calls.userReads, readsBefore + 1);
    const inactive = await request('inactive', 'GET', '/api/catalog/products');
    assert.equal(inactive.status, 401, 'valid inactive account is rejected, never converted to an anonymous visitor');
    assert.ok(inactive.body.error);
    state.failures.database = true;
    const unavailable = await request('design', 'GET', '/api/catalog/products');
    state.failures.database = false;
    assert.equal(unavailable.status, 503, 'database validation failure is rejected, never converted to anonymous');
    assert.ok(unavailable.body.error);
    assert.equal(JSON.stringify(unavailable.body).includes('PRIVATE_DATABASE_FAILURE'), false);

    for (const role of ['design', 'design_view']) {
      const page1 = await request(role, 'GET', catalog + '?active=all&page=1&pageSize=500');
      const page2 = await request(role, 'GET', catalog + '?active=all&page=2&pageSize=500');
      assert.equal(page1.status, 200, role + ' survives parent and child guards');
      assert.equal(page2.status, 200);
      assert.deepEqual([page1.body.total, page1.body.pages, page1.body.products.length, page2.body.products.length], [627, 2, 500, 127]);
      const combined = [...page1.body.products, ...page2.body.products];
      assert.equal(new Set(combined.map(product => product.id)).size, 627, 'all catalog rows reachable without overlap');
      assert.equal(combined.filter(product => !product.active).length, 26, 'active=all includes inactive products');
      combined.forEach(assertPrivateFieldsAbsent);
      assert.equal(state.calls.lists.at(-1).include.createdBy, undefined, 'Design must not query staff relation');

      const defaults = await request(role, 'GET', catalog);
      assert.equal(defaults.body.total, 601);
      assert.equal(defaults.body.products.length, 60);
      assert.ok(defaults.body.products.every(product => product.active));
      const searched = await request(role, 'GET', catalog + '?active=all&search=SKU-0627');
      assert.deepEqual(searched.body.products.map(product => product.id), ['product-0627'], 'search reaches rows beyond the original 500 cap');

      const detail = await request(role, 'GET', catalog + '/' + firstId);
      assert.equal(detail.status, 200);
      assertPrivateFieldsAbsent(detail.body.product);
      assert.equal(detail.body.product.aiContext.color, 'Azul');
      assert.equal(detail.body.product.sizes[0].storeStocks[0].stock, 4, 'read-only stock remains visible');
      const category = await request(role, 'GET', '/api/admin/categories/category-1/products');
      assert.equal(category.status, 200);
      category.body.products.forEach(assertPrivateFieldsAbsent);
      assert.equal((await request(role, 'GET', '/api/admin/categories/tree')).status, 200);
      const inventory = await request(role, 'GET', '/api/admin/inventory/products?search=SKU-0001');
      assert.equal(inventory.status, 200);
      assertPrivateFieldsAbsent(inventory.body.products[0]);

      for (const [method, route, body] of [
        ['GET', '/api/admin/users'], ['GET', '/api/admin/fiscal/status'],
        ['GET', catalog + '/' + firstId + '/nfe-summary'],
        ['POST', '/api/admin/inventory/adjust', { productId: firstId, stock: 99 }],
        ['POST', catalog + '/' + firstId + '/release', { release: true }],
        ['DELETE', catalog + '/' + firstId],
      ]) assert.equal((await request(role, method, route, body)).status, 403, role + ': ' + method + ' ' + route);
    }
    assert.equal(state.calls.userLists, 0);
    assert.equal(state.calls.forbiddenEndpoint, 0);
    assert.equal(state.calls.writes.length, 0);

    for (const [method, route, body] of [
      ['PUT', catalog + '/' + firstId, { name: 'Não permitido' }],
      ['POST', catalog, { sku: 'NEW', name: 'Tênis', brand: 'Marca', category: 'Tênis', price: 99 }],
      ['POST', '/api/admin/products/' + firstId + '/classification', { color: 'Vermelho' }],
      ['POST', '/api/admin/categories', { name: 'Nova', level: 'CATEGORY' }],
      ['PUT', '/api/admin/categories/category-1', { name: 'Nova' }],
      ['POST', '/api/admin/categories/category-1/assign-products', { productIds: [firstId] }],
    ]) assert.equal((await request('design_view', method, route, body)).status, 403, 'viewer write: ' + route);
    assert.equal(state.calls.writes.length, 0);
    assert.equal(state.calls.categoryWrites.length, 0);
    assert.equal((await request('user', 'GET', catalog)).status, 403, 'unrelated users do not gain catalog administration');

    const before = clone(state.products.get(firstId));
    for (const body of [
      { sizes: [{ size: '40', stock: 99 }] }, { stock: 99 }, { ncm: '00000000' },
      { aiContext: { nfeKey: 'altered' } }, { aiContext: { supplierCnpj: '11111111111111' } },
      { aiContext: { classification: { editedBy: 'attacker' } } }, { createdById: 'attacker' },
    ]) assert.equal((await request('design', 'PUT', catalog + '/' + firstId, body)).status, 403, 'restricted body: ' + JSON.stringify(body));
    assert.deepEqual(state.products.get(firstId), before);
    assert.equal(state.calls.sizeDeletes.length, 0, 'rejected stock edits never destroy existing variants');
    assert.equal(state.calls.writes.length, 0);

    const edited = await request('design', 'PUT', catalog + '/' + firstId, {
      name: 'Tênis atualizado', longDescription: 'Descrição revisada',
      aiContext: { color: 'Preto', classification: { modality: 'Caminhada' } },
    });
    assert.equal(edited.status, 200);
    assertPrivateFieldsAbsent(edited.body.product);
    let saved = state.products.get(firstId);
    assert.equal(saved.name, 'Tênis atualizado');
    assert.deepEqual(saved.aiContext, { ...before.aiContext, color: 'Preto', classification: { ...before.aiContext.classification, modality: 'Caminhada' } });
    assert.deepEqual(saved.sizes, before.sizes);
    assert.equal(saved.ncm, before.ncm);

    for (const body of [
      { aiContext: null }, { aiContext: [] }, { aiContext: 'invalid-json' },
      { aiContext: { classification: null } }, { aiContext: { classification: [] } },
    ]) {
      const result = await request('design', 'PUT', catalog + '/' + firstId, body);
      assert.ok([200, 400, 403].includes(result.status), 'context validation must complete without a server error');
      saved = state.products.get(firstId);
      assert.equal(saved.aiContext?.nfeKey, before.aiContext.nfeKey, 'empty/malformed context cannot erase invoice metadata: ' + JSON.stringify(body));
      assert.equal(saved.aiContext?.classification?.editedBy, before.aiContext.classification.editedBy, 'empty classification cannot erase internal audit metadata');
      assert.deepEqual(saved.sizes, before.sizes);
    }

    const metadata = await request('design', 'POST', '/api/admin/products/' + firstId + '/classification', { color: 'Branco' });
    assert.equal(metadata.status, 200);
    assert.equal(metadata.body.aiContext.color, 'Branco');
    assert.equal(JSON.stringify(metadata.body).includes('PRIVATE_'), false, 'metadata endpoint must apply the same response projection');
    assert.equal(state.products.get(firstId).aiContext.nfeKey, before.aiContext.nfeKey);

    const category = await request('design', 'POST', '/api/admin/categories', { name: 'Acessórios', level: 'CATEGORY' });
    assert.equal(category.status, 200);
    const renamed = await request('design', 'PUT', '/api/admin/categories/' + category.body.node.id, { name: 'Vestuário' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.node.name, 'Vestuário');

    const createBody = { sku: 'NEW-ZERO', name: 'Novo tênis', brand: 'Marca', category: 'Tênis', price: 199, sizes: [{ size: '41', barcode: 'EAN-NEW', stock: 0 }] };
    assert.equal((await request('design', 'POST', catalog, { ...createBody, sizes: [{ size: '41', stock: 1 }] })).status, 403);
    const created = await request('design', 'POST', catalog, createBody);
    assert.equal(created.status, 200);
    assert.equal(created.body.product.sizes[0].stock, 0);
    assertPrivateFieldsAbsent(created.body.product);

    // Existing administrator behavior keeps unrestricted catalog data and writes.
    const adminList = await request('admin', 'GET', catalog);
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.products.length, 500);
    assert.equal(own(adminList.body, 'page'), false, 'legacy non-paginated admin response remains compatible');
    assert.ok(state.calls.lists.at(-1).include.createdBy);
    const adminDetail = await request('admin', 'GET', catalog + '/' + firstId);
    assert.equal(adminDetail.body.product.createdBy.id, before.createdBy.id);
    assert.equal(adminDetail.body.product.aiContext.nfeKey, before.aiContext.nfeKey);
    const adminEdit = await request('admin', 'PUT', catalog + '/' + firstId, { ncm: '64041190', sizes: [{ size: '40', stock: 7 }] });
    assert.equal(adminEdit.status, 200);
    assert.equal(adminEdit.body.product.ncm, '64041190');
    assert.equal(adminEdit.body.product.sizes[0].stock, 7);
    assert.equal(state.calls.sizeDeletes.length, 1);
    assert.equal((await request('admin', 'GET', '/api/admin/fiscal/status')).status, 200);
    assert.equal(state.calls.forbiddenEndpoint, 1);
    console.log('Design product integration: ' + requests + ' real HTTP requests passed; optional public auth, nested mounts, catalog pagination, projections, read-only roles, metadata preservation and admin compatibility.');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
