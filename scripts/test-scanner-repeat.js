'use strict';
const assert = require('node:assert/strict');
const { createRoundBipe } = require('../src/services/stocktakeRounds');
const rows = [];
const matches = (row, where) => row.roundId === where.roundId && row.storeId === where.storeId &&
  !row.excludedAt && where.barcode.in.includes(row.barcode);
const db = {
  $queryRaw: async () => [],
  stocktakeRound: { findUnique: async () => ({ id: 'r', storeId: 's', status: 'counting', operationType: 'replacement' }) },
  stocktakeBipe: {
    findUnique: async ({ where }) => rows.find(row => row.scanKey === where.scanKey),
    count: async ({ where }) => rows.filter(row => matches(row, where)).length,
    findFirst: async ({ where }) => rows.findLast(row => matches(row, where)),
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
const data = { storeId: 's', roundId: 'r', barcode: '0196989405971', scanKey: 'scan-0001',
  productName: 'Produto de teste', productSize: '40' };
(async () => {
  const first = await createRoundBipe(db, data);
  assert.equal(rows.length, 1, 'the first physical unit does not need a repeat confirmation');
  const secondData = { ...data, barcode: '196989405971', scanKey: 'scan-0002' };
  const isRepeat = count => error => error.status === 409 && error.repeat?.count === count &&
    error.repeat.product.name === data.productName && error.repeat.product.size === data.productSize;
  await assert.rejects(() => createRoundBipe(db, secondData), isRepeat(1));
  assert.equal(rows.length, 1, 'another scan ID of the same UPC/EAN identity is not counted before confirmation');
  for (const invalid of [null, 0, -1, 1.5, true, '1x', Infinity]) {
    await assert.rejects(() => createRoundBipe(db, { ...secondData, repeatConfirmedCount: invalid }), isRepeat(1));
  }
  const second = await createRoundBipe(db, { ...secondData, repeatConfirmedCount: 1 });
  assert.equal(rows.length, 2, 'an explicit confirmation of the current count allows the other physical unit');
  const retry = await createRoundBipe(db, secondData);
  assert.equal(retry.id, second.id);
  assert.equal((await createRoundBipe(db, { ...data, repeatConfirmedCount: 0 })).id, first.id);
  assert.equal(rows.length, 2, 'retrying the same scan ID stays idempotent without a new confirmation');
  const thirdData = { ...data, scanKey: 'scan-0003' };
  await assert.rejects(() => createRoundBipe(db, { ...thirdData, repeatConfirmedCount: 1 }), isRepeat(2));
  await createRoundBipe(db, { ...thirdData, repeatConfirmedCount: '2' });
  assert.equal(rows.length, 3, 'stale confirmation is rejected and the current count is accepted');
  await assert.rejects(() => createRoundBipe(db, { ...data, barcode: '5901234123457' }), /Conflito no identificador/);
  first.excludedAt = new Date();
  await assert.rejects(() => createRoundBipe(db, data), /Conflito no identificador/);
  await assert.rejects(() => createRoundBipe(db, { ...data, scanKey: 'scan-0004', repeatConfirmedCount: 3 }), isRepeat(2));
  await createRoundBipe(db, { ...data, scanKey: 'scan-0004', repeatConfirmedCount: 2 });
  assert.equal(rows.length, 4, 'only active previous units determine the confirmation count');
  console.log('PASS: repeated UPC/EAN units require current-count confirmation; same-scan retries stay idempotent; stale/invalid confirmations and excluded or conflicting scan IDs are rejected.');
})().catch(error => { console.error(error); process.exitCode = 1; });
