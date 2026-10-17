'use strict';
const assert = require('node:assert/strict');
const { savePhoto, photoNote, visibleNote, revisionOf } = require('../src/services/scannerCapturePhoto');
function database() {
  const rows = [];
  const db = { $queryRaw: async () => [], stocktakeRound: { findUnique: async ({ where }) => ({ id: where.id, storeId: 'store', status: 'counting' }) },
    productCapture: {
      findUnique: async ({ where }) => rows.find(row => where.id ? row.id === where.id : row.scanKey === where.scanKey),
      create: async ({ data }) => { const row = { id: 'cap' + rows.length, ...data }; rows.push(row); return structuredClone(row); },
      update: async ({ where, data }) => { const row = rows.find(row => row.id === where.id); Object.assign(row, data); return structuredClone(row); },
    } };
  let queue = Promise.resolve();
  db.$transaction = fn => { const run = queue.then(() => fn(db)); queue = run.catch(() => {}); return run; };
  return { db, rows };
}
(async () => {
  const { db, rows } = database();
  const base = { roundId: 'round', storeId: 'store', scanKey: 'round:manual-0001', photo: 'data:image/webp;base64,FRAME1', photoRevision: '100', sellerName: 'Tester' };
  const first = await savePhoto(db, base);
  assert.equal(first.capture.status, 'pendente');
  assert.equal(first.capture.barcode, null);
  assert.equal(first.capture.bipeId, undefined);
  const retries = await Promise.all(Array.from({ length: 10 }, () => savePhoto(db, base)));
  assert.equal(new Set(retries.map(x => x.capture.id)).size, 1);
  assert.equal(rows.length, 1); assert.equal(rows[0].photos.length, 0);
  const second = await savePhoto(db, { ...base, photo: 'data:image/webp;base64,FRAME2', photoRevision: '101' });
  assert.equal(second.capture.id, first.capture.id);
  assert.equal(second.capture.photo, 'data:image/webp;base64,FRAME2');
  assert.deepEqual(second.capture.photos, [base.photo]);
  const stale = await savePhoto(db, { ...base, photo: 'data:image/webp;base64,OLDFRAME', photoRevision: '99' });
  assert.equal(stale.stale, true); assert.equal(stale.photoRevision, '101');
  assert.equal(stale.capture.photo, second.capture.photo);
  assert.deepEqual(stale.capture.photos, [base.photo, 'data:image/webp;base64,OLDFRAME']);
  await savePhoto(db, { ...base, photo: second.capture.photo, photoRevision: '102' });
  assert.equal(rows[0].photos.length, 2, 'Identical original is stored once');
  assert.equal(rows[0].storeId, 'store'); assert.equal(rows[0].roundId, 'round');
  rows[0].barcode = '0196153346321';
  await savePhoto(db, { ...base, photoRevision: '103', barcode: '196153346321' });
  await assert.rejects(savePhoto(db, { ...base, barcode: '7909434597410' }), /Código diferente/);
  assert.equal(rows.length, 1);
  await assert.rejects(savePhoto(db, { ...base, storeId: 'other' }), /não pertence/);
  rows[0].excludedAt = new Date();
  await assert.rejects(savePhoto(db, base), /não pertence/);
  const note = photoNote(rows[0].note, 'etiqueta ' + 'a'.repeat(1000));
  assert.equal(note.length, 480); assert.equal(revisionOf(note), '103');
  assert.equal(visibleNote(note).includes('scanner-photo-revision'), false);
  const legacy = database();
  await savePhoto(legacy.db, { ...base, photoRevision: undefined });
  assert.equal(revisionOf(legacy.rows[0].note), '0');
  const upgraded = await savePhoto(legacy.db, { ...base, photo: 'data:image/webp;base64,NEW', photoRevision: '1' });
  assert.equal(upgraded.stale, false); assert.equal(upgraded.capture.photo, 'data:image/webp;base64,NEW');
  await assert.rejects(savePhoto(legacy.db, { ...base, photoRevision: 'not-a-number' }), /inválido/);
  console.log('PASS: photograph saved without barcode, 10 concurrent retries one capture, recapture originals, stale revision, exact photo dedupe, identity/context/conflict guards and bounded invisible revision metadata.');
})().catch(error => { console.error(error); process.exitCode = 1; });
