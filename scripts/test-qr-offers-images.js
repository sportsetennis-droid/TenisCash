const assert = require('node:assert/strict');
const { buildCouponPayload } = require('../src/services/nuvemshop');
const { _test: qr } = require('../src/routes/qrOffers');
const { usableImageUrls } = require('../src/services/nuvemshopImageBackfill');
const { isAcceptableImageCandidate } = require('../src/services/curationAgent');

function run() {
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

  assert.deepEqual(
    qr.categoryMembershipDiff(['1', '2', '4'], ['2', '3']),
    { add: ['3'], remove: ['1', '4'] },
  );

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
    start_date: '2026-08-08T11:00:00.000Z',
    end_date: '2026-08-09T11:00:00.000Z',
    categories: [123],
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

  console.log('QR offers and image quality tests passed');
}

run();
