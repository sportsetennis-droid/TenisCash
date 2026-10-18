'use strict';
const assert = require('node:assert/strict');
const { createRoundBipe } = require('../src/services/stocktakeRounds');
const rows = [];
const db = {
  $queryRaw: async () => [],
  stocktakeRound: { findUnique: async () => ({ id: 'r', storeId: 's', status: 'counting' }) },
  stocktakeBipe: {
    findUnique: async ({ where }) => rows.find(row => row.scanKey === where.scanKey),
    create: async ({ data }) => {
      assert(!('repeatConfirmedCount' in data));
      assert(!('requireRepeatConfirmation' in data));
      const row = { id: String(rows.length), ...data };
      rows.push(row);
      return row;
    },
  },
};
db.$transaction = fn => fn(db);
const data = { storeId: 's', roundId: 'r', barcode: '7909434597410', scanKey: 'scan-0001', requireRepeatConfirmation: true };
(async () => {
  const first = await createRoundBipe(db, data);
  const second = await createRoundBipe(db, { ...data, scanKey: 'scan-0002' });
  assert.equal(rows.length, 2, 'each distinct scan ID counts one physical unit with the same barcode');
  assert.equal(first.barcode, second.barcode);
  const retry = await createRoundBipe(db, { ...data, scanKey: 'scan-0002' });
  assert.equal(retry.id, second.id);
  assert.equal(rows.length, 2, 'retrying one scan ID stays idempotent');
  await createRoundBipe(db, { ...data, scanKey: 'scan-0003', repeatConfirmedCount: 2 });
  assert.equal(rows.length, 3, 'legacy confirmation fields do not restore the confirmation gate');
  console.log('PASS: identical physical products count by scan ID; same-scan retries remain idempotent');
})().catch(error => { console.error(error); process.exitCode = 1; });
