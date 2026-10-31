function sellerWorksInStore(seller, storeId) {
  if (!seller || !storeId) return false;
  return seller.storeId === storeId || (Array.isArray(seller.storeIds) && seller.storeIds.includes(storeId));
}

function sellerAssignedStoreIds(seller) {
  if (!seller) return [];
  return [...new Set([seller.storeId, ...(Array.isArray(seller.storeIds) ? seller.storeIds : [])].filter(Boolean))];
}

function resolveSellerClockInStore({
  seller,
  requestedStoreId,
  stores,
  latitude,
  longitude,
  distanceMeters,
  maxDistanceMeters = 150,
}) {
  const assignedIds = sellerAssignedStoreIds(seller);
  if (!assignedIds.length) return { ok: false, reason: 'no_assigned_store' };

  const requestedId = requestedStoreId == null ? '' : String(requestedStoreId).trim();
  if (requestedId && !assignedIds.includes(requestedId)) {
    return { ok: false, reason: 'unassigned_store' };
  }

  const assignedStores = (Array.isArray(stores) ? stores : []).filter((store) => assignedIds.includes(store.id));
  if (!assignedStores.length) return { ok: false, reason: 'store_not_found' };

  const candidates = requestedId
    ? assignedStores.filter((store) => store.id === requestedId)
    : assignedStores;
  if (!candidates.length) return { ok: false, reason: 'store_not_found' };

  const withCoordinates = candidates.filter((store) =>
    Number.isFinite(store.latitude) && Number.isFinite(store.longitude));
  if (!withCoordinates.length) return { ok: false, reason: 'missing_coordinates' };

  if (typeof distanceMeters !== 'function') throw new TypeError('distanceMeters é obrigatório');
  const ranked = withCoordinates
    .map((store) => ({
      store,
      distanceM: distanceMeters(latitude, longitude, store.latitude, store.longitude),
    }))
    .sort((a, b) => a.distanceM - b.distanceM);
  const nearest = ranked[0];
  if (nearest.distanceM > maxDistanceMeters) {
    return { ok: false, reason: 'too_far', ...nearest };
  }
  return { ok: true, ...nearest };
}

module.exports = { sellerWorksInStore, sellerAssignedStoreIds, resolveSellerClockInStore };
