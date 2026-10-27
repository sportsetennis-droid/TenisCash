'use strict';

// Exercises the real recovery service without a database. The PostgreSQL suite
// remains the authoritative integration test when an isolated test DB is set.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const history = require('../src/services/scanActionHistory');

const operatorId = randomUUID(), adminId = randomUUID(), storeId = randomUUID(), sessionId = randomUUID();
const savedIds = Array.from({ length: 78 }, () => randomUUID());
const oldScans = savedIds.map((clientScanId, index) => ({
  clientScanId, lotId: sessionId, barcode: index === 77 ? '1234567890123' : 'SAVED-' + index,
  scannedAt: new Date(Date.parse('2026-10-02T15:30:00Z') + index * 1000), productSizeId: null,
  productName: null, brand: null, size: null, recognized: index < 77, requiresSizeConfirmation: false,
  confirmedSize: '', removed: false, error: index === 77 ? 'Código ou variante ainda não identificado.' : null,
  payloadHash: 'original-request-hash-' + index, originalBarcode: index === 77 ? '1234567890123' : 'SAVED-' + index,
}));
const original = { id: operatorId, name: 'Original operator', role: 'seller', active: true, storeId, storeIds: [] };
const admin = { id: adminId, name: 'Administrator', role: 'admin', active: true, storeId, storeIds: [] };
const store = { id: storeId, code: 'LOJA07', name: 'SPORTS & TENNIS (LOJA 07)', active: true };
const users = new Map([[operatorId, original], [adminId, admin]]);
const lot = { sessionId, mode: 'receipt', operatorId, fromStoreId: null, toStoreId: storeId, transferId: null,
  revision: 78, status: 'open', payloadHash: 'previous-lot-hash', scans: oldScans, createdAt: new Date(), updatedAt: new Date(), confirmedAt: null };
const writes = [];
const tx = {
  $queryRaw: async () => [],
  user: {
    findUnique: async ({ where }) => users.get(where.id) || null,
    findMany: async ({ where }) => where.id.in.map(id => users.get(id)).filter(Boolean).map(({ id, name }) => ({ id, name })),
  },
  store: { findMany: async ({ where }) => where.id.in.map(id => id === storeId ? store : null).filter(Boolean) },
  stockTransfer: { findMany: async () => [] },
  productSize: { findMany: async () => [] },
  scanActionLot: {
    findUnique: async () => lot,
    update: async ({ data }) => { Object.assign(lot, data); lot.updatedAt = new Date(); return lot; },
  },
  scanActionRead: {
    findFirst: async () => null,
    upsert: async ({ where, create, update }) => {
      const prior = lot.scans.find(scan => scan.clientScanId === where.clientScanId);
      if (prior) Object.assign(prior, update); else { lot.scans.push(create); writes.push(create.clientScanId); }
    },
  },
  adminAction: { upsert: async () => ({}) },
};
const db = { ...tx, $transaction: async callback => callback(tx) };

(async () => {
  const persistedRows = lot.scans.slice();
  const oldSnapshot = new Map(persistedRows.map(scan => [scan.clientScanId, JSON.stringify(scan)]));
  const scans = oldScans.map(scan => ({ clientScanId: scan.clientScanId, barcode: scan.barcode,
    createdAt: scan.scannedAt.toISOString(), removed: false, confirmedSize: '', error: scan.error || '' }));
  scans[0].barcode = 'STALE-LOCAL-CODE'; scans[10].removed = true;
  for (let index = 0; index < 24; index++) scans.push({ clientScanId: randomUUID(), barcode: 'LOCAL-' + index,
    createdAt: new Date(Date.parse('2026-10-03T10:00:00Z') + index * 1000).toISOString(), removed: false, confirmedSize: '', error: '' });
  const request = { sessionId, mode: 'receipt', fromStoreId: '', toStoreId: storeId, transferId: '', revision: 103,
    status: 'open', originalOperatorId: operatorId, scans };
  const result = await history.recover(db, admin, request);
  assert.equal(result.lot.scanCount, 102);
  assert.equal(result.lot.recognizedCount, 77);
  assert.equal(result.lot.pendingCount, 25);
  assert.equal(lot.revision, 103);
  assert.equal(lot.scans.length, 102);
  assert.equal(writes.length, 24, 'only the 24 IDs absent from the server are inserted');
  for (const scan of persistedRows) assert.equal(JSON.stringify(scan), oldSnapshot.get(scan.clientScanId), 'a saved read is byte-for-byte unchanged');
  assert.deepEqual(new Set(writes), new Set(scans.slice(78).map(scan => scan.clientScanId)));
  assert.equal(lot.scans.find(scan => scan.clientScanId === savedIds[0]).barcode, oldScans[0].barcode);
  assert.equal(lot.scans.find(scan => scan.clientScanId === savedIds[10]).removed, false);
  const replay = await history.recover(db, admin, request);
  assert.equal(replay.synced, true, 'retry after an acknowledgement loss succeeds without rewriting saved rows');
  assert.equal(lot.scans.length, 102);
  assert.equal(writes.length, 24, 'retry does not create duplicate physical pieces');
  console.log('PASS real recovery service: saved reads immutable, 24 missing IDs appended, retry idempotent, no stock writes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
