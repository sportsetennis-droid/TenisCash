const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../src/services/discountPolicy');

// Execute the real routers with isolated database/network substitutes. No
// production connection, scheduled job or print operation is used by this test.
function load(relative, overrides = {}) {
  const routers = [];
  const effects = [];
  const unexpected = name => new Proxy({}, {
    get(_target, property) {
      return async () => { effects.push(`${name}.${String(property)}`); throw new Error(`Unexpected side effect: ${name}.${String(property)}`); };
    },
  });
  const prisma = new Proxy(overrides.prisma || {}, {
    get(target, property) { return target[property] || unexpected(`prisma.${String(property)}`); },
  });
  function Router() {
    const routes = new Map();
    const router = { routes, use() {} };
    for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
      router[method] = (route, ...handlers) => {
        for (const value of Array.isArray(route) ? route : [route]) routes.set(`${method.toUpperCase()} ${value}`, handlers);
      };
    }
    routers.push(router);
    return router;
  }
  const next = (_req, _res, done) => done();
  const dependencies = {
    express: { Router },
    '../middleware': { prisma, authMiddleware: next, adminMiddleware: next },
    '../services/discountPolicy': policy,
    './discountPolicy': policy,
    '../services/nuvemshop': unexpected('nuvemshop'),
    '../services/nuvemshopHandlers': unexpected('nuvemshopHandlers'),
    '../services/labelGenerator': {
      isSaldoTemplate: template => template?.type === 'PROMOTIONAL',
      isDuplexTemplate: () => false,
      isProductDuplexTemplate: () => true,
      defaultTemplates: () => ({}),
    },
    '../services/brandThirtyOffer': unexpected('brandThirtyOffer'),
    '../services/everlastPaymentOffer': unexpected('everlastPaymentOffer'),
    'node-cron': unexpected('cron'),
    '../routes/qrOffers': unexpected('qrOffers'),
    ...overrides.dependencies,
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), {
    module, exports: module.exports, process: { env: {} }, console,
    Buffer, URL, setTimeout() { effects.push('setTimeout'); },
    require(name) {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name === 'crypto' || name === 'node:crypto') return require(name);
      return {};
    },
  }, { filename: relative });
  return { exports: module.exports, routers, effects };
}

async function request(router, route, body = {}, extra = {}) {
  let status = 200, result;
  const response = {
    status(value) { status = value; return this; },
    json(value) { result = value; return this; },
    send(value) { result = value; return this; },
    sendStatus(value) { status = value; return this; },
    type() { return this; }, set() { return this; },
  };
  const handlers = router.routes.get(route);
  assert.ok(handlers, route);
  for (const handler of handlers) {
    let next = false;
    await handler({ body, params: { id: 'old', plate: '01' }, query: {}, userId: 'owner', ...extra }, response, () => { next = true; });
    if (!next) break;
  }
  return { status, body: result };
}

async function run() {
  assert.equal(policy.DISCOUNTS_ENABLED, false);
  let connectionReads = 0;
  const qr = load('src/routes/qrOffers.js', { dependencies: {
    '../services/nuvemshopHandlers': { getConnection: async () => { connectionReads++; return { nuvemshopUserId: 'store' }; } },
  } });
  for (const route of ['POST /reconcile', 'POST /plates/:plate/sync-category', 'POST /offers', 'PUT /offers/:id', 'POST /offers/:id/publish']) {
    const res = await request(qr.exports.adminRouter, route, { discountPct: 30, productIds: ['product'] });
    assert.equal(res.status, 409, route);
    assert.equal(res.body.code, 'DISCOUNTS_DISABLED');
  }
  assert.equal((await qr.exports.reconcileQROffers()).disabled, true);
  assert.equal((await qr.exports.restoreExclusiveOffers()).disabled, true);
  for (const route of ['GET /qr-ofertas-folha', 'GET /qr-ofertas-folha-legacy']) {
    assert.equal((await request(qr.exports.publicRouter, route)).status, 409);
  }
  const removal = await request(qr.exports.publicRouter, 'POST /api/nuvemshop/discounts/qr-offers', {
    store_id: 'store', currency: 'BRL', products: [{ id: 1, product_id: 123 }],
    promotions: [{ id: 'old-promotion', line_items: [1] }],
  });
  assert.equal(removal.status, 200);
  assert.equal(removal.body.commands.length, 1);
  assert.equal(removal.body.commands[0].command, 'remove_discount');
  assert.equal(removal.body.commands[0].specs.promotion_id, 'old-promotion');
  for (const body of [
    { store_id: 'other-store', promotions: [{ id: 'old-promotion', line_items: [1] }] },
    { store_id: 'store', promotions: [] },
    { store_id: 'store', promotions: [{ id: 'old-promotion', line_items: [1] }], execution_tier: 'cart' },
  ]) {
    assert.equal((await request(qr.exports.publicRouter, 'POST /api/nuvemshop/discounts/qr-offers', body)).status, 204);
  }
  assert.equal(connectionReads, 2);
  const publicOffer = await request(qr.exports.publicRouter, 'GET /api/qr-offers/plates/:plate');
  assert.equal(publicOffer.status, 200);
  assert.equal(publicOffer.body.offer, null);
  const page = await request(qr.exports.publicRouter, 'GET /oferta/:plate');
  assert.equal(page.status, 200);
  assert.match(page.body, /Ver produtos/);
  assert.doesNotMatch(page.body, /30%|OFF|desconto|oferta|coupon|utm_campaign/i);
  const commands = qr.exports._test.buildQrDiscountCommands({
    products: [{ id: 1, product_id: 123 }],
    promotions: [{ id: 'old-promotion', line_items: [1] }],
  }, 'old-promotion', ['123']);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'remove_discount');
  assert.deepEqual(qr.effects, []);

  const cron = load('src/services/qrOffersCron.js');
  cron.exports.startQROffersCron();
  assert.equal((await cron.exports.tick()).disabled, true);
  assert.equal(cron.exports.getQROffersCronState().disabled, true);
  assert.deepEqual(cron.effects, []);

  const promo = load('src/routes/promo.js');
  assert.equal((await request(promo.exports, 'GET /')).body.promos.length, 0);
  assert.equal((await request(promo.exports, 'GET /brands')).body.brands.length, 0);
  assert.deepEqual(promo.effects, []);

  const updates = [];
  const admin = load('src/routes/admin.js', { prisma: { promo: { update: async input => { updates.push(input); return { id: 'old', ...input.data }; } } } });
  assert.equal((await request(admin.exports, 'POST /promos', { percentage: 30 })).status, 409);
  for (const body of [{ active: true }, { percentage: 30 }, { endsAt: '2099-01-01' }]) {
    assert.equal((await request(admin.exports, 'PUT /promos/:id', body)).status, 409);
  }
  assert.equal(updates.length, 0);
  const disabled = await request(admin.exports, 'PUT /promos/:id', { active: false, percentage: 30, endsAt: '2099-01-01' });
  assert.equal(disabled.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(updates[0])), { where: { id: 'old' }, data: { active: false } });
  assert.deepEqual(admin.effects, []);

  const labels = load('src/routes/labels.js');
  for (const route of ['POST /brand-thirty-offer', 'POST /everlast-payment-offer', 'GET /campaign-footwear']) {
    assert.equal((await request(labels.exports, route, { brand: 'EVERLAST' })).status, 409);
  }
  for (const route of ['POST /batches', 'POST /batches/quick', 'POST /batches/auto']) {
    assert.equal((await request(labels.exports, route, { usePromo: true })).status, 409);
    assert.equal((await request(labels.exports, route, { items: [{ promotionalPrice: 50 }] })).status, 409);
  }
  assert.deepEqual(labels.effects, []);

  let created = 0;
  for (const type of ['PROMOTIONAL', 'PRODUCT']) {
    const batch = load('src/routes/labels.js', { prisma: {
      labelTemplate: { findUnique: async () => ({ id: 'template', type }) },
      product: { findMany: async () => [{ id: 'product', price: 100, promoPrice: 70 }] },
      store: { findMany: async () => [{ id: 'store', code: 'LOJA05', name: 'Tambaú' }] },
      labelBatch: { create: async input => {
        created++;
        for (const item of input.data.items.create) assert.equal(item.promotionalPrice, null);
        return { id: 'new', ...input.data };
      } },
    } });
    for (const route of ['POST /batches', 'POST /batches/quick', 'POST /batches/auto']) {
      const res = await request(batch.exports, route, { templateId: 'template', storeId: 'store', productIds: ['product'], items: [{ productId: 'product', price: 100 }] });
      assert.equal(res.status, type === 'PROMOTIONAL' ? 409 : 200, `${route}: ${type}`);
    }
    assert.deepEqual(batch.effects, []);
  }
  assert.equal(created, 3);

  // Exercise the actual historical-label pricing block with a stale active
  // catalog offer: stored prices survive, and current offers are never invoked.
  const labelSource = fs.readFileSync(path.join(__dirname, '../src/routes/labels.js'), 'utf8');
  const start = labelSource.indexOf('      const paymentOffer = DISCOUNTS_ENABLED');
  const end = labelSource.indexOf('      return {', start);
  assert.ok(start > 0 && end > start);
  const pricingSource = labelSource.slice(start, end);
  for (const storedPromo of [null, 60]) {
    const context = {
      DISCOUNTS_ENABLED: false, p: { price: 100, promoPrice: 70 }, it: { price: 90, promotionalPrice: storedPromo },
      productOffer() { throw new Error('A historical label cannot apply a new catalog offer'); },
    };
    const pricing = vm.runInNewContext(`(() => { ${pricingSource}; return { price, promotionalPrice, paymentOffer }; })()`, context);
    assert.equal(pricing.price, 90);
    assert.equal(pricing.promotionalPrice, storedPromo);
    assert.equal(pricing.paymentOffer, null);
  }
  console.log('Disabled promotions: QR routes/cron/callback, promo administration and label guards verified without external effects.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
