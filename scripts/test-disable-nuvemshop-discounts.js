const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

(async () => {
  const events = [];
  let badShape = false;
  let variants = [{ id: 12, promotional_price: '60.00', price: '100.00', stock: 4 }];
  let promotions = [{ id: 1, active: true, name: 'TenisCash QR exclusivo 30%' }];
  let coupons = [{ id: 2, code: 'PROMO', valid: true }, { id: 3, code: 'TC1', valid: true },
    { id: 4, code: 'TC123ABCD', valid: true, max_uses: 1, max_discount_amount: 5 }];
  const connection = { nuvemshopUserId: 'store' };
  const ns = {
    listProducts: async () => [{ id: 10, variants }],
    fetchAllPages: async () => coupons,
    setCouponValid: async (conn, id, valid) => {
      assert.equal(conn, connection); assert.equal(id, '2'); assert.equal(valid, false);
      events.push('coupon'); coupons[0].valid = false;
    },
    nuvemshopApi: async (conn, method, url, body) => {
      assert.equal(conn, connection);
      if (method === 'GET') {
        if (url.startsWith('/products?')) return badShape ? { unexpected: true } : [{ id: 10, variants }];
        if (url.startsWith('/coupons?')) return coupons;
        assert.match(url, /^\/promotions\?/); return { data: promotions };
      }
      assert.ok(events.includes('snapshot'), 'Snapshot must precede external writes');
      if (method === 'PATCH') {
        assert.equal(url, '/promotions/1'); assert.equal(JSON.stringify(body), '{"active":false}');
        promotions[0].active = false; events.push('promotion'); return;
      }
      assert.equal(method, 'PUT'); assert.equal(url, '/products/10/variants/12');
      assert.equal(JSON.stringify(body), '{"promotional_price":null}');
      variants[0].promotional_price = null; events.push('variant');
    },
  };
  const prisma = {
    cashbackRedemption: { findMany: async () => [{ nsCouponId: '3', couponCode: 'TC1' }] },
    config: {
      create: async ({ data }) => { const audit = JSON.parse(data.value); assert.equal(audit.actorId, 'owner'); events.push('snapshot'); },
      update: async () => { events.push('audit-completed'); },
    },
  };
  const context = { module: { exports: {} }, require: name => {
    if (name === './discountPolicy') return { DISCOUNTS_ENABLED: false };
    if (name === './nuvemshop') return ns;
    if (name === './nuvemshopHandlers') return { getConnection: async () => connection };
    throw new Error(name);
  }, console, Set, Date, JSON, Math, Error };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/services/disableNuvemshopDiscounts.js'), 'utf8'), context);
  const service = context.module.exports;
  const before = await service.inspectRemoteDiscounts(prisma);
  assert.equal(before.promotionalVariants, 1); assert.equal(before.activePromotions, 1); assert.equal(before.activeDiscountCoupons, 1);
  service.startRemoteDiscountShutdown(prisma, 'owner');
  for (let i = 0; i < 100 && service.getRemoteDiscountShutdownState().running; i++) await new Promise(setImmediate);
  const result = service.getRemoteDiscountShutdownState();
  assert.equal(result.phase, 'complete'); assert.equal(result.processed, 3);
  assert.equal(coupons[1].valid, true, 'Cashback credit must be preserved');
  assert.equal(coupons[2].valid, true, 'Concurrent redemption must be preserved');
  assert.equal(variants[0].price, '100.00'); assert.equal(variants[0].stock, 4);
  assert.equal(events[0], 'snapshot'); assert.equal(events.at(-1), 'audit-completed');
  const oldMutations = events.filter(e => ['promotion', 'coupon', 'variant'].includes(e)).length;
  service.startRemoteDiscountShutdown(prisma, 'owner');
  for (let i = 0; i < 100 && service.getRemoteDiscountShutdownState().running; i++) await new Promise(setImmediate);
  assert.equal(service.getRemoteDiscountShutdownState().phase, 'complete');
  assert.equal(events.filter(e => ['promotion', 'coupon', 'variant'].includes(e)).length, oldMutations);
  badShape = true;
  const beforeFailure = events.length;
  service.startRemoteDiscountShutdown(prisma, 'owner');
  for (let i = 0; i < 100 && service.getRemoteDiscountShutdownState().running; i++) await new Promise(setImmediate);
  assert.equal(service.getRemoteDiscountShutdownState().phase, 'failed');
  assert.equal(events.length, beforeFailure, 'Unexpected remote payload must fail before mutations');
  console.log('PASS remote discount shutdown: audited, narrow, verified, idempotent; credit and stock unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; });
