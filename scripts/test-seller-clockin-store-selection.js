const assert = require('node:assert/strict');
const {
  sellerAssignedStoreIds,
  sellerWorksInStore,
  resolveSellerClockInStore,
} = require('../src/services/sellerStoreAssignment');

const store05 = { id: 'store-05', name: 'Loja 05', latitude: -7.12, longitude: -34.85 };
const store07 = { id: 'store-07', name: 'Loja 07', latitude: -7.11, longitude: -34.84 };
const seller = { storeId: 'store-05', storeIds: ['store-05', 'store-07'] };
const distanceMeters = (lat1, lon1, lat2, lon2) => Math.hypot(lat1 - lat2, lon1 - lon2) * 111000;

assert.deepEqual(sellerAssignedStoreIds(seller), ['store-05', 'store-07']);
assert.equal(sellerWorksInStore(seller, 'store-07'), true);

const near07 = resolveSellerClockInStore({
  seller,
  stores: [store05, store07],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
});
assert.equal(near07.ok, true);
assert.equal(near07.store.id, 'store-07');

const explicitly07 = resolveSellerClockInStore({
  seller,
  requestedStoreId: 'store-07',
  stores: [store05, store07],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
});
assert.equal(explicitly07.ok, true);
assert.equal(explicitly07.store.id, 'store-07');

const singleStoreSeller = { storeId: 'store-07', storeIds: ['store-07'] };
const singleStoreResult = resolveSellerClockInStore({
  seller: singleStoreSeller,
  stores: [store07],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
});
assert.equal(singleStoreResult.ok, true);
assert.equal(singleStoreResult.store.id, 'store-07');

const secondaryOnlySeller = { storeId: null, storeIds: ['store-07'] };
const secondaryOnlyResult = resolveSellerClockInStore({
  seller: secondaryOnlySeller,
  stores: [store07],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
});
assert.equal(secondaryOnlyResult.ok, true);
assert.equal(secondaryOnlyResult.store.id, 'store-07');

assert.equal(resolveSellerClockInStore({
  seller,
  requestedStoreId: 'store-08',
  stores: [store05, store07],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
}).reason, 'unassigned_store');

const farAway = resolveSellerClockInStore({
  seller,
  stores: [store05, store07],
  latitude: -7,
  longitude: -34,
  distanceMeters,
});
assert.equal(farAway.reason, 'too_far');
assert.equal(farAway.store.id, 'store-07');

assert.equal(resolveSellerClockInStore({
  seller,
  stores: [{ ...store07, latitude: null, longitude: null }],
  latitude: store07.latitude,
  longitude: store07.longitude,
  distanceMeters,
}).reason, 'missing_coordinates');

console.log('Seller clock-in store selection tests passed.');
