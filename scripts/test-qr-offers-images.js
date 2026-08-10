const assert = require('node:assert/strict');
const { buildCouponPayload } = require('../src/services/nuvemshop');
const { _test: qr } = require('../src/routes/qrOffers');
const { usableImageUrls } = require('../src/services/nuvemshopImageBackfill');
const { isAcceptableImageCandidate } = require('../src/services/curationAgent');
const {
  reviewState,
  shouldAttemptImage,
  stockUnits,
} = require('../src/services/imageRepairCron');

function run() {
  assert.equal(qr.QR_OFFER_DISCOUNT_PCT, 30);
  assert.equal(qr.qrOfferTitle(1), 'Oferta exclusiva da Placa 01 — 30% OFF');
  assert.equal(qr.offerBasePrice({ price: 100, promoPrice: null }), 100);
  assert.equal(qr.offerBasePrice({ price: 100, promoPrice: 80 }), 100);
  assert.equal(qr.offerDiscountedPrice({ price: 100, promoPrice: null }), 70);
  assert.equal(qr.offerDiscountedPrice({ price: 99.99, promoPrice: null }), 69.99);
  assert.equal(qr.offerDiscountedPrice({ price: 120.65, promoPrice: null }), 84.45);
  assert.equal(qr.offerDiscountedPrice({ price: 100, promoPrice: 80 }), 70);
  assert.deepEqual(qr.promotionRows({ result: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(qr.promotionRows({ results: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(qr.promotionRows({ data: [{ id: 3 }] }), [{ id: 3 }]);
  assert.deepEqual(qr.promotionRows(null), []);

  assert.deepEqual(qr.qrMarkerFromCart({ utm: [{
    utm_source: 'teniscash',
    utm_medium: 'qr',
    utm_campaign: 'placa-07',
    utm_content: 'offer-7',
  }] }), { plate: 'placa-07', offerId: 'offer-7' });
  assert.equal(qr.qrMarkerFromCart({ utm: [{ utm_source: 'instagram', utm_campaign: 'placa-07' }] }), null);

  assert.deepEqual(qr.buildQrDiscountCommands({
    currency: 'BRL',
    products: [
      { id: 101, product_id: 9001 },
      { id: 102, product_id: 9002 },
    ],
  }, 'promotion-1', new Set(['9001'])), [{
    command: 'create_or_update_discount',
    specs: {
      promotion_id: 'promotion-1',
      currency: 'BRL',
      display_text: { 'pt-br': '30% OFF exclusivo da placa' },
      line_items: [{
        line_item: '101',
        discount_specs: { type: 'percentage', amount: '30.00' },
      }],
    },
  }]);
  assert.deepEqual(qr.buildQrDiscountCommands({
    promotions: [{ id: 'promotion-1', line_items: ['101'] }],
  }, 'promotion-1', new Set()), [{
    command: 'remove_discount',
    specs: {
      scope: 'line_item',
      promotion_id: 'promotion-1',
      line_items: ['101'],
    },
  }]);

  const quickBuy = qr.quickBuyMarkup({
    id: 'local-product-1',
    storeUrl: 'https://store.example/product',
    quickBuy: {
      action: 'https://store.example/comprar/?utm_source=teniscash',
      productId: '9001',
      variants: [{ size: '39', variantId: '7001' }],
    },
  });
  assert.match(quickBuy, /name="add_to_cart" value="9001"/);
  assert.match(quickBuy, /name="variant_id"/);
  assert.match(quickBuy, /Comprar agora com 30% OFF/);
  assert.match(quickBuy, /data-product-id="local-product-1"/);
  assert.match(quickBuy, /sendBeacon\('\/api\/qr-offers\/track'/);
  assert.doesNotMatch(quickBuy, /coupon/i);
  assert.deepEqual(qr.remoteProductVariants({ variants: [
    { id: 10, values: ['39'], stock: 2 },
    { id: 11, values: ['40'], stock: 0 },
    { id: 12, values: [], sku: 'UNICO', stock: null },
  ] }), [
    { size: '39', variantId: '10' },
    { size: 'UNICO', variantId: '12' },
  ]);
  assert.deepEqual(qr.selectQuickBuyVariants([
    { size: 'UNICO', variantId: 'old-id' },
  ], [
    { size: 'Unico', variantId: 'current-id' },
  ]), [
    { size: 'Unico', variantId: 'current-id' },
  ]);
  assert.deepEqual(qr.selectQuickBuyVariants([
    { size: '39', variantId: 'current-id' },
  ], [
    { size: '39', variantId: 'current-id' },
    { size: '40', variantId: 'other-id' },
  ]), [
    { size: '39', variantId: 'current-id' },
  ]);
  assert.equal(qr.qrCookieValue({ headers: { cookie: 'a=1; tc_qr_vid=visitor-123456789; b=2' } }, 'tc_qr_vid'), 'visitor-123456789');
  assert.equal(qr.isQrBot('Mozilla/5.0 Chrome/128 Safari/537.36'), false);
  assert.equal(qr.isQrBot('Googlebot/2.1'), true);
  assert.equal(qr.qrDeviceType('Mozilla/5.0 (iPhone; Mobile) Safari/604.1'), 'mobile');
  assert.equal(qr.qrDeviceType('Mozilla/5.0 (Windows NT 10.0) Chrome/128'), 'desktop');
  assert.equal(qr.qrBrowserFamily('Mozilla/5.0 Edg/128.0'), 'Edge');
  assert.equal(qr.qrReferrerHost({ get: () => 'https://instagram.com/sports-tennis?campaign=qr' }), 'instagram.com');

  const now = new Date('2026-08-08T12:00:00.000Z');
  assert.equal(qr.offerState({
    startsAt: '2026-08-08T11:00:00.000Z',
    endsAt: '2026-08-08T13:00:00.000Z',
  }, now), 'ACTIVE');
  assert.equal(qr.offerState({
    startsAt: '2026-08-08T13:00:00.000Z',
    endsAt: '2026-08-08T14:00:00.000Z',
  }, now), 'SCHEDULED');
  assert.equal(qr.offerState({
    startsAt: '2026-08-08T10:00:00.000Z',
    endsAt: '2026-08-08T12:00:00.000Z',
  }, now), 'EXPIRED');
  assert.equal(qr.offerState({ startsAt: 'invalid', endsAt: 'invalid' }, now), 'EXPIRED');

  const ids = qr.normalizeProductIds([
    ' a ', 'a', '', null,
    ...Array.from({ length: 30 }, (_, index) => `p${index}`),
  ]);
  assert.equal(ids[0], 'a');
  assert.equal(ids.length, 24);

  const usedIds = new Set(['used']);
  assert.deepEqual(
    qr.allocateExclusiveProductIds(['used', 'a', 'a'], ['b', 'used', 'c'], usedIds, 3),
    ['a', 'b', 'c'],
  );
  assert.equal(qr.physicalStockUnits({ sizes: [
    { storeStocks: [{ stock: 2 }, { stock: -3 }] },
    { storeStocks: [{ stock: '4' }, { stock: null }] },
  ] }), 6);
  assert.equal(qr.remoteProductImage({ images: [
    { src: 'javascript:alert(1)' },
    { src: ' https://cdn.nuvemshop.com.br/product.jpg ' },
  ] }), 'https://cdn.nuvemshop.com.br/product.jpg');
  assert.equal(qr.remoteProductImage({ images: [] }), null);

  assert.deepEqual(
    qr.categoryMembershipDiff(['1', '2', '4'], ['2', '3']),
    { add: ['3'], remove: ['1', '4'] },
  );
  assert.deepEqual(qr.pagesFromResponse({ pages: { results: [{ id: 1 }], lastPage: 1 } }), [{ id: 1 }]);
  assert.deepEqual(qr.pagesFromResponse({ results: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(qr.pagesFromResponse(null), []);

  assert.deepEqual(buildCouponPayload({
    code: 'QR0120260808ABCD',
    discountPct: 35,
    valid: false,
    startDate: '2026-08-08T11:00:00.000Z',
    endDate: '2026-08-09T11:00:00.000Z',
    categories: ['123', 123, 0, -1, 'x'],
  }), {
    code: 'QR0120260808ABCD',
    type: 'percentage',
    value: '35.00',
    valid: false,
    max_uses: null,
    min_price: 0,
    includes_shipping: false,
    combines_with_other_discounts: false,
    start_date: '2026-08-08',
    end_date: '2026-08-09',
    categories: [123],
  });

  assert.deepEqual(buildCouponPayload({
    code: 'QR02PRODUCTS',
    discountPct: 20,
    startDate: '2026-08-09T01:00:00.000Z',
    products: ['10', 10, 11, 0, 'invalid'],
  }), {
    code: 'QR02PRODUCTS',
    type: 'percentage',
    value: '20.00',
    valid: true,
    max_uses: null,
    min_price: 0,
    includes_shipping: false,
    combines_with_other_discounts: false,
    start_date: '2026-08-08',
    products: [10, 11],
  });

  assert.deepEqual(usableImageUrls({ images: [
    { src: 'https://cdn.example/a.jpg' },
    { src: 'https://cdn.example/a.jpg' },
    { src: 'javascript:alert(1)' },
    { src: ' http://cdn.example/b.png ' },
  ] }), ['https://cdn.example/a.jpg', 'http://cdn.example/b.png']);

  assert.equal(isAcceptableImageCandidate({ _score: 10, _isCorrectProduct: false }, 8), false);
  assert.equal(isAcceptableImageCandidate({ _score: 7, _isCorrectProduct: true }, 7), false);
  assert.equal(isAcceptableImageCandidate({ _score: 8, _isCorrectProduct: true }, 8), true);

  assert.equal(shouldAttemptImage({}, now), true);
  assert.equal(shouldAttemptImage({ imageAutoReview: {
    state: 'rejected', attemptedAt: '2026-08-08T11:00:00.000Z',
  } }, now), false);
  assert.equal(shouldAttemptImage({ imageAutoReview: {
    state: 'error', attemptedAt: '2026-08-08T05:59:59.000Z',
  } }, now), true);
  assert.deepEqual(reviewState({ steps: { image: {
    ok: true, url: 'https://cdn.example/product.jpg', score: 9, reason: 'produto exato',
  } } }), { state: 'accepted', reason: 'produto exato', score: 9 });
  assert.equal(reviewState({ steps: { image: { ok: false, reason: 'produto parecido, mas diferente' } } }).state, 'rejected');
  assert.equal(reviewState({ steps: { image: { ok: false, reason: 'Vision falhou' } } }).state, 'error');
  assert.equal(stockUnits({ sizes: [
    { storeStocks: [{ stock: 2 }, { stock: 3 }] },
    { storeStocks: [{ stock: -1 }, { stock: 4 }] },
  ] }), 9);

  console.log('QR offers and image quality tests passed');
}

run();
