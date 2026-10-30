function sellerWorksInStore(seller, storeId) {
  if (!seller || !storeId) return false;
  return seller.storeId === storeId || (Array.isArray(seller.storeIds) && seller.storeIds.includes(storeId));
}

module.exports = { sellerWorksInStore };
