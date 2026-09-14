const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { OWNER_RECORD_KEY, getRankingOwner } = require('../src/services/rankingOwner');

const copy = value => structuredClone(value);
function fixture() {
  const now = Date.now();
  return {
    users: [
      { id: 'owner', active: true, role: 'superadmin' },
      { id: 'printbot', active: true, role: 'superadmin' },
      { id: 'seller', active: true, role: 'seller' },
    ],
    configs: [{ key: OWNER_RECORD_KEY, value: JSON.stringify({ userId: 'owner', evidenceId: 'verified-test-owner' }) }],
    products: [
      { id: 'object', price: 100, promoPrice: 80, aiContext: { paymentOffer: { active: true, type: 'PIX', percent: 20 }, classification: { brand: 'Preservar' } } },
      { id: 'string', price: 200, promoPrice: null, aiContext: JSON.stringify({ paymentOffer: { active: true, type: 'CASH', description: 'Preservar' }, unrelated: ['keep'] }) },
      { id: 'malformed', price: 90, promoPrice: 40, aiContext: '{invalid json' },
      { id: 'inactive', price: 40, promoPrice: null, aiContext: { paymentOffer: { active: false, percent: 10 }, other: 12 } },
      { id: 'nonboolean', price: 60, promoPrice: null, aiContext: { paymentOffer: { active: 'true', percent: 5 } } },
      { id: 'primitive', price: 20, promoPrice: null, aiContext: '42' },
      { id: 'array', price: 30, promoPrice: null, aiContext: '[{"active":true}]' },
      { id: 'empty', price: 10, promoPrice: null, aiContext: null },
    ],
    promos: [{ id: 'active-promo', active: true, title: 'Campanha', percent: 15 }, { id: 'inactive-promo', active: false, title: 'Antiga', percent: 20 }],
    qrOffers: [
      { id: 'current', status: 'ACTIVE', startsAt: new Date(now - 86400000), endsAt: new Date(now + 86400000), discountPct: 20 },
      { id: 'future', status: 'SCHEDULED', startsAt: new Date(now + 86400000), endsAt: new Date(now + 172800000), discountPct: 10 },
      { id: 'expired', status: 'ACTIVE', startsAt: new Date(now - 172800000), endsAt: new Date(now - 86400000), discountPct: 30 },
      { id: 'draft', status: 'DRAFT', startsAt: new Date(now), endsAt: new Date(now + 86400000), discountPct: 10 },
      { id: 'cancelled', status: 'CANCELLED', startsAt: new Date(now), endsAt: new Date(now + 86400000), discountPct: 5 },
    ],
    audits: [],
    // No delegate for historical or customer data exists in the test client.
    sales: [{ id: 'historic-sale', totalAmount: 80, discount: 20, tcUsed: 8, items: [{ unitPrice: 80 }] }],
    clients: [{ id: 'client', balance: 200 }],
    commissions: [{ id: 'commission', amount: 0.8 }],
  };
}

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every(part => matches(row, part));
    if (key === 'OR') return expected.some(part => matches(row, part));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === 'in') return value.includes(row[key]);
        if (operator === 'not') return row[key] !== value;
        if (operator === 'gt') return row[key] > value;
        if (operator === 'gte') return row[key] >= value;
        if (operator === 'lt') return row[key] < value;
        if (operator === 'lte') return row[key] <= value;
        throw new Error('Unsupported test condition: ' + operator);
      });
    }
    return row[key] === expected;
  });
}

function select(row, fields) {
  if (!row || !fields) return copy(row);
  return copy(Object.fromEntries(Object.entries(fields).filter(([, enabled]) => enabled).map(([key]) => [key, row[key]])));
}

function database(initial = fixture(), behavior = {}) {
  let state = copy(initial);
  const transactionOptions = [];
  const mutations = [];
  function delegates(next) {
    const model = (collection, allowedFields) => ({
      async findMany({ where, select: fields } = {}) { return next[collection].filter(row => matches(row, where)).map(row => select(row, fields)); },
      async count({ where } = {}) { return next[collection].filter(row => matches(row, where)).length; },
      async updateMany({ where, data }) {
        for (const key of Object.keys(data)) assert.ok(allowedFields.includes(key), 'Unexpected mutation: ' + collection + '.' + key);
        mutations.push({ collection, where: copy(where), data: copy(data) });
        if (behavior.conflict === collection) return { count: 0 };
        const rows = next[collection].filter(row => matches(row, where));
        rows.forEach(row => Object.assign(row, copy(data)));
        return { count: rows.length };
      },
      async update({ where, data }) {
        const rows = next[collection].filter(row => matches(row, where));
        assert.equal(rows.length, 1);
        await this.updateMany({ where, data });
        return copy(rows[0]);
      },
    });
    return {
      user: { findUnique: async ({ where, select: fields }) => select(next.users.find(user => matches(user, where)) || null, fields) },
      config: {
        findUnique: async ({ where }) => copy(next.configs.find(row => matches(row, where)) || null),
        async create({ data }) {
          if (behavior.snapshotFailure) throw new Error('Snapshot storage failed');
          assert.ok(!next.configs.some(row => row.key === data.key), 'Snapshots must have unique immutable keys');
          next.configs.push(copy(data));
          mutations.push({ collection: 'configs', data: copy(data) });
          return copy(data);
        },
      },
      product: model('products', ['promoPrice', 'aiContext']),
      promo: model('promos', ['active']),
      qROffer: model('qrOffers', ['status']),
      adminAction: { async create({ data }) {
        if (behavior.auditFailure) throw new Error('Audit storage failed');
        next.audits.push(copy(data));
        return copy(data);
      } },
    };
  }
  return {
    get state() { return state; }, transactionOptions, mutations,
    config: { findUnique: async (...args) => delegates(state).config.findUnique(...args) },
    user: { findUnique: async (...args) => delegates(state).user.findUnique(...args) },
    async $transaction(callback, options) {
      transactionOptions.push(copy(options));
      if (behavior.transactionError) throw Object.assign(new Error('Transaction failure'), { code: behavior.transactionError });
      const next = copy(state);
      const value = await callback(delegates(next));
      state = next;
      return value;
    },
  };
}

const expectedBefore = { productPromoPrices: 2, paymentOffers: 2, promos: 1, qrOffers: 2 };
const expectedAfter = { productPromoPrices: 0, paymentOffers: 0, promos: 0, qrOffers: 0 };
const { inspectDiscounts, disableDiscounts, AUDIT_KEY_PREFIX } = require('../src/services/disableDiscounts');

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'discounts.js'), 'utf8');
const endpoints = [['GET', '/'], ['POST', '/'], ['GET', '/remote'], ['POST', '/remote'], ['GET', '/remote/status']];
async function request(method, url, ownerId = 'owner', options = {}) {
  const db = database(options.initial);
  const calls = [];
  const routes = new Map();
  const router = {
    get(route, ...handlers) { routes.set('GET ' + route, handlers); },
    post(route, ...handlers) { routes.set('POST ' + route, handlers); },
  };
  const authMiddleware = (req, res, next) => req.userId ? next() : res.status(401).json({ error: 'Authentication required' });
  const resultFor = operation => ({ ok: true, operation });
  const service = name => async (client, payload) => {
    assert.equal(client, db);
    calls.push({ name, payload: copy(payload) });
    if (options.error) throw options.error;
    return resultFor(name);
  };
  vm.runInNewContext(routeSource, {
    module: { exports: {} },
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === '../middleware') return { prisma: db, authMiddleware };
      if (name === '../services/rankingOwner') return { getRankingOwner };
      if (name === '../services/disableDiscounts') return { inspectDiscounts: service('inspect'), disableDiscounts: service('disable') };
      if (name === '../services/disableNuvemshopDiscounts') return {
        inspectRemoteDiscounts: service('inspectRemote'),
        startRemoteDiscountShutdown: service('startRemote'),
        async getRemoteDiscountShutdownState() {
          calls.push({ name: 'remoteStatus' });
          return resultFor('remoteStatus');
        },
      };
      throw new Error('Unexpected route dependency: ' + name);
    },
  }, { filename: 'discounts-route.js' });
  const handlers = routes.get(method + ' ' + url);
  assert.ok(handlers, 'Missing endpoint: ' + method + ' ' + url);
  assert.equal(handlers[0], authMiddleware, 'Every discount endpoint must require authentication');
  let status = 200, body;
  const headers = {};
  const req = { userId: ownerId, userRole: 'superadmin', body: { reason: 'Solicitação do proprietário', ownerId: 'forged-owner' } };
  const res = {
    status(code) { status = code; return this; },
    json(value) { body = value; return this; },
    set(key, value) { headers[key] = value; return this; },
  };
  for (const handler of handlers) {
    let continued = false;
    await handler(req, res, () => { continued = true; });
    if (!continued) break;
  }
  return { status, body, calls, headers };
}

(async () => {
  const original = fixture();
  const db = database(original);
  const inspected = await inspectDiscounts(db, { ownerId: 'owner' });
  assert.equal(inspected.ok, true);
  assert.ok(Number.isFinite(Date.parse(inspected.checkedAt)));
  assert.deepEqual(inspected.counts, expectedBefore);
  assert.deepEqual(db.state, original, 'Inspection must not alter any data');
  assert.equal(db.mutations.length, 0);
  assert.equal(db.transactionOptions[0].isolationLevel, 'Serializable');

  const changed = await disableDiscounts(db, { ownerId: 'owner', reason: '  Remover descontos atuais  ' });
  assert.equal(changed.ok, true);
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.before, expectedBefore);
  assert.deepEqual(changed.after, expectedAfter);
  assert.ok(changed.auditKey.startsWith(AUDIT_KEY_PREFIX));
  assert.equal(db.transactionOptions[1].isolationLevel, 'Serializable');
  const byId = id => db.state.products.find(product => product.id === id);
  assert.equal(byId('object').promoPrice, null);
  assert.equal(byId('malformed').promoPrice, null);
  assert.equal(byId('object').aiContext.paymentOffer.active, false);
  assert.deepEqual(byId('object').aiContext, { paymentOffer: { active: false, type: 'PIX', percent: 20 }, classification: { brand: 'Preservar' } });
  assert.equal(typeof byId('string').aiContext, 'string', 'Legacy JSON string representation must be retained');
  assert.deepEqual(JSON.parse(byId('string').aiContext), { paymentOffer: { active: false, type: 'CASH', description: 'Preservar' }, unrelated: ['keep'] });
  assert.equal(byId('malformed').aiContext, '{invalid json');
  for (const id of ['inactive', 'nonboolean', 'primitive', 'array', 'empty']) {
    assert.deepEqual(byId(id), original.products.find(product => product.id === id));
  }
  assert.deepEqual(db.state.products.map(({ id, price }) => ({ id, price })), original.products.map(({ id, price }) => ({ id, price })));
  assert.equal(db.state.promos[0].active, false);
  assert.deepEqual(db.state.promos[1], original.promos[1]);
  assert.deepEqual(db.state.qrOffers.map(offer => [offer.id, offer.status]), [
    ['current', 'CANCELLED'], ['future', 'CANCELLED'], ['expired', 'ACTIVE'], ['draft', 'DRAFT'], ['cancelled', 'CANCELLED'],
  ]);
  for (const field of ['sales', 'clients', 'commissions', 'users']) assert.deepEqual(db.state[field], original[field]);

  const config = db.state.configs.find(record => record.key === changed.auditKey);
  assert.ok(config);
  assert.equal(config.id, changed.auditKey);
  const audit = JSON.parse(config.value);
  assert.equal(audit.version, 1);
  assert.equal(audit.action, 'disable-current-discounts');
  assert.equal(audit.actorId, 'owner');
  assert.equal(audit.reason, 'Remover descontos atuais');
  assert.deepEqual(audit.before, expectedBefore);
  assert.deepEqual(audit.after, expectedAfter);
  assert.deepEqual(Object.keys(audit).sort(), ['version', 'action', 'actorId', 'createdAt', 'reason', 'before', 'after', 'restore'].sort());
  assert.deepEqual(audit.restore.products.find(product => product.id === 'string').aiContext, original.products[1].aiContext);
  // Applying only the saved original fields must recover all affected records exactly.
  const restored = copy(db.state);
  for (const field of ['products', 'promos', 'qrOffers']) {
    for (const saved of audit.restore[field]) Object.assign(restored[field].find(row => row.id === saved.id), saved);
    assert.deepEqual(restored[field], original[field], 'Snapshot must restore original ' + field);
  }
  const afterFirstCall = copy(db.state);
  const mutationsBeforeRetry = db.mutations.length;
  const repeated = await disableDiscounts(db, { ownerId: 'owner' });
  assert.deepEqual(repeated, { ok: true, changed: false, before: expectedAfter, after: expectedAfter, auditKey: null });
  assert.deepEqual(db.state, afterFirstCall, 'An idempotent retry must not alter the original snapshot');
  assert.equal(db.mutations.length, mutationsBeforeRetry);

  for (const behavior of [{ snapshotFailure: true }, { conflict: 'products' }, { conflict: 'promos' }, { conflict: 'qrOffers' }]) {
    const rollback = database(original, behavior);
    await assert.rejects(disableDiscounts(rollback, { ownerId: 'owner' }));
    assert.deepEqual(rollback.state, original, 'A failed operation must roll back every mutation');
  }
  for (const [transactionError, statusCode] of [['P2034', 409], ['P2028', 503]]) {
    await assert.rejects(disableDiscounts(database(original, { transactionError }), { ownerId: 'owner' }), error => error.statusCode === statusCode);
  }
  for (const reason of ['', 'ab', 'x'.repeat(501), 12]) {
    const invalid = database(original);
    await assert.rejects(disableDiscounts(invalid, { ownerId: 'owner', reason }), error => error.statusCode === 400);
    assert.deepEqual(invalid.state, original);
  }

  const deniedCases = [
    ['printbot', state => state],
    ['seller', state => state],
    ['owner', state => { state.users[0].active = false; return state; }],
    ['owner', state => { state.users[0].role = 'admin'; return state; }],
    ['owner', state => { state.configs[0].value = '{malformed'; return state; }],
    ['owner', state => { state.configs[0].value = JSON.stringify({ userId: 'owner', evidenceId: '' }); return state; }],
    ['owner', state => { state.configs = []; return state; }],
  ];
  for (const [ownerId, modify] of deniedCases) {
    const initial = modify(fixture());
    for (const operation of [inspectDiscounts, disableDiscounts]) {
      const denied = database(initial);
      await assert.rejects(operation(denied, { ownerId }), error => error.statusCode === 403);
      assert.deepEqual(denied.state, initial);
      assert.equal(denied.mutations.length, 0);
    }
    for (const [method, url] of endpoints) {
      const denied = await request(method, url, ownerId, { initial });
      assert.equal(denied.status, 403, method + ' ' + url + ' must require the canonical owner');
      assert.equal(denied.calls.length, 0);
      assert.equal(denied.headers['Cache-Control'], 'private, no-store');
    }
  }

  for (const [method, url] of endpoints) {
    const unauthenticated = await request(method, url, null);
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.calls.length, 0);
    const allowed = await request(method, url);
    assert.equal(allowed.status, method === 'POST' && url === '/remote' ? 202 : 200);
    assert.equal(allowed.calls.length, 1);
    assert.equal(allowed.headers['Cache-Control'], 'private, no-store');
    if (url === '/') {
      assert.equal(allowed.calls[0].payload.ownerId, 'owner', 'Use the authenticated identity, never a body ownerId');
      if (method === 'POST') assert.equal(allowed.calls[0].payload.reason, 'Solicitação do proprietário');
    }
    if (url === '/remote' && method === 'POST') assert.equal(allowed.calls[0].payload, 'owner');
  }
  const conflict = await request('POST', '/', 'owner', { error: Object.assign(new Error('Conflito auditado'), { statusCode: 409 }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'Conflito auditado');
  const unexpected = await request('POST', '/remote', 'owner', { error: new Error('Sensitive internal details') });
  assert.equal(unexpected.status, 500);
  assert.doesNotMatch(unexpected.body.error, /Sensitive internal details/);

  console.log('PASS: canonical-owner discount shutdown, immutable restorable audit, idempotence, rollback, price/history preservation and five authenticated routes');
})().catch(error => { console.error(error); process.exitCode = 1; });
