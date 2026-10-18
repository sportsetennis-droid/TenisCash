'use strict';
const assert = require('node:assert/strict');
const { createAutomaticRecognizer } = require('../src/services/scannerAutomaticRecognition');

const KNOWN = '4006381333931', UNKNOWN = '5901234123457';
function fixture() {
  const state = { bipes: [], captures: [], round: { id: 'round', storeId: 'store', status: 'counting' },
    size: { id: 'size', productId: 'product', size: '40', sizeConfirmedAt: new Date(), stock: 9,
      product: { id: 'product', name: 'Produto de teste', brand: 'TESTE', sku: 'AB1234-001', active: true } },
    learned: [], stockWrites: 0, nextId: 0 };
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.in) return value.in.includes(row[key]);
    }
    return value === null ? row[key] == null : row[key] === value;
  });
  const copy = x => x == null ? null : structuredClone(x);
  const db = {
    $queryRaw: async () => [],
    stocktakeRound: { findUnique: async ({ where }) => where.id === state.round.id ? copy(state.round) : null },
    stocktakeBipe: {
      findUnique: async ({ where }) => copy(state.bipes.find(row => matches(row, where))),
      findMany: async ({ where }) => copy(state.bipes.filter(row => matches(row, where)).slice().reverse()),
      findFirst: async ({ where }) => copy(state.bipes.filter(row => matches(row, where)).at(-1)),
      create: async ({ data }) => {
        assert(!state.bipes.some(row => row.scanKey === data.scanKey), 'scanKey unique');
        const row = { id: 'bipe-' + (++state.nextId), bipedAt: new Date(), excludedAt: null, ...copy(data) };
        state.bipes.push(row); return copy(row);
      },
      update: async ({ where, data }) => {
        const row = state.bipes.find(row => matches(row, where)); assert(row); Object.assign(row, copy(data)); return copy(row);
      },
    },
    productCapture: {
      findUnique: async ({ where }) => copy(state.captures.find(row => matches(row, where))),
      create: async () => { throw new Error('Automatic recognition must never create a ProductCapture'); },
      update: async ({ where, data }) => {
        assert(Object.keys(data).every(key => ['barcode', 'bipeId', 'status', 'matchedProductId', 'resolvedAt'].includes(key)),
          'existing manual photograph bytes, note and revision must not be changed');
        const row = state.captures.find(row => matches(row, where)); assert(row); Object.assign(row, copy(data)); return copy(row);
      },
    },
    productSize: { findUnique: async ({ where }) => where.id === state.size.id ? copy(state.size) : null },
    storeStock: new Proxy({}, { get: () => () => { state.stockWrites++; throw new Error('No stock movement in automatic recognition'); } }),
  };
  let queue = Promise.resolve();
  db.$transaction = fn => {
    const run = queue.then(async () => {
      const before = copy({ bipes: state.bipes, captures: state.captures });
      try { return await fn(db); }
      catch (error) { state.bipes = before.bipes; state.captures = before.captures; throw error; }
    });
    queue = run.catch(() => {}); return run;
  };
  const normalizeScannedSize = value => value?.match(/^BR (\d{2})$/)?.[1] || null;
  const base = { storeId: 'store', roundId: 'round', sellerId: 'seller-original', sellerName: 'Operador original',
    clientScanId: 'physical-scan-0001', barcode: KNOWN };
  let customLearn;
  const recognize = createAutomaticRecognizer({ db, normalizeScannedSize,
    needsManualSize: (brand, size) => brand === 'ADIDAS' && !size.sizeConfirmedAt,
    sizeOptionsForBipe: async () => [{ size: '40' }],
    learn: async (_db, input) => {
      state.learned.push(copy(input));
      if (customLearn) return customLearn(input);
      if (input.barcode === KNOWN || (input.read?.sku === 'AB1234-001' && input.size === '40'))
        return { reason: 'matched', productId: 'product', productSizeId: 'size' };
      return { reason: 'reference_not_found' };
    },
  });
  return { db, state, base, recognize, setLearn: fn => { customLearn = fn; } };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
async function rejection(promise, status, regex) {
  await assert.rejects(promise, error => error.status === status && (!regex || regex.test(error.message)));
}
(async () => {
  await test('unreadable/invalid codes create no scan and no photograph', async () => {
    const f = fixture();
    for (const barcode of ['', 'AB1234-001', 'https://qr.nike.com/123', '4006381333932']) {
      await assert.rejects(f.recognize({ ...f.base, barcode }), e => e.status === 422 && e.barcodeRequired);
    }
    assert.equal(f.state.bipes.length, 0); assert.equal(f.state.captures.length, 0); assert.equal(f.state.learned.length, 0);
  });
  await test('known code recognizes without ProductCapture or stock writes', async () => {
    const f = fixture(), result = await f.recognize(f.base);
    assert.equal(result.complete, true); assert.equal(result.product.size, '40'); assert.equal(result.photoSaved, false);
    assert.equal(result.appliedToStock, false); assert.equal(result.blockedReason, 'round_count_only');
    assert.equal(f.state.bipes.length, 1); assert.equal(f.state.captures.length, 0); assert.equal(f.state.stockWrites, 0);
  });
  await test('10 concurrent retries retain one scan and the original operator', async () => {
    const f = fixture(), first = await f.recognize(f.base);
    const retries = await Promise.all(Array.from({ length: 10 }, () => f.recognize({ ...f.base, sellerId: 'other', sellerName: 'Other' })));
    assert(retries.every(row => row.bipeId === first.bipeId && row.complete)); assert.equal(f.state.bipes.length, 1);
    assert.equal(f.state.bipes[0].sellerId, 'seller-original'); assert.equal(f.state.bipes[0].sellerName, 'Operador original');
  });
  await test('another physical identical piece is counted without confirmation; same scan retry stays idempotent', async () => {
    const f = fixture(); await f.recognize(f.base);
    const another = { ...f.base, clientScanId: 'physical-scan-0002' };
    const second = await f.recognize(another);
    assert.equal(second.complete, true); assert.equal(f.state.bipes.length, 2);
    const retry = await f.recognize({ ...another, repeatConfirmedCount: 1 });
    assert.equal(retry.bipeId, second.bipeId); assert.equal(f.state.bipes.length, 2);
    assert.equal(f.state.captures.length, 0);
  });
  await test('unknown code stays counted once and later OCR enriches that same scan', async () => {
    const f = fixture(), input = { ...f.base, barcode: UNKNOWN };
    const first = await f.recognize(input);
    assert.equal(first.complete, false); assert.equal(first.pending, true); assert.equal(first.found, false);
    assert(!/foto salva/i.test(first.message)); assert.equal(f.state.captures.length, 0);
    const next = await f.recognize({ ...input, ocrText: 'AB1234-001\nBR 40' });
    assert.equal(next.complete, true); assert.equal(next.bipeId, first.bipeId); assert.equal(f.state.bipes.length, 1);
    assert.equal(f.state.learned.at(-1).size, '40'); assert.equal(f.state.learned.at(-1).read.sku, 'AB1234-001');
  });
  await test('leading-zero EAN alias keeps the first actual read and scan', async () => {
    const f = fixture(), first = await f.recognize(f.base);
    const retry = await f.recognize({ ...f.base, barcode: '0' + KNOWN });
    assert.equal(retry.bipeId, first.bipeId); assert.equal(retry.barcode, KNOWN); assert.equal(f.state.bipes.length, 1);
  });
  await test('same scan cannot be reused for a different code or store', async () => {
    const f = fixture(); await f.recognize(f.base);
    await rejection(f.recognize({ ...f.base, barcode: UNKNOWN }), 409, /Conflito/);
    await rejection(f.recognize({ ...f.base, storeId: 'other-store' }), 409, /não pertence/);
    assert.equal(f.state.bipes.length, 1); assert.equal(f.state.bipes[0].barcode, KNOWN);
  });
  await test('closed round rejects before creating anything', async () => {
    const f = fixture(); f.state.round.status = 'review';
    await rejection(f.recognize(f.base), 409, /encerrada/); assert.equal(f.state.bipes.length, 0);
  });
  await test('excluded scans never reactivate', async () => {
    const f = fixture(); await f.recognize(f.base); f.state.bipes[0].excludedAt = new Date();
    await rejection(f.recognize(f.base), 409, /Conflito/); assert.equal(f.state.bipes.length, 1); assert(f.state.bipes[0].excludedAt);
  });
  await test('existing manual photo links without replacing its frame or revision', async () => {
    const f = fixture();
    const photo = { id: 'manual-photo', storeId: 'store', roundId: 'round', scanKey: 'round:' + f.base.clientScanId,
      photo: 'data:image/webp;base64,ORIGINAL', photos: ['OLDER'], note: 'manual-photo-revision:7', status: 'pendente', barcode: null,
      sellerId: 'manual-original', sellerName: 'Manual original', createdAt: new Date('2026-10-17T18:01:00Z') };
    f.state.captures.push(structuredClone(photo));
    const result = await f.recognize(f.base), saved = f.state.captures[0];
    assert.equal(saved.bipeId, result.bipeId); assert.equal(saved.barcode, KNOWN); assert.equal(f.state.bipes.length, 1);
    for (const key of ['photo', 'photos', 'note']) assert.deepEqual(saved[key], photo[key]);
    assert.equal(saved.status, 'vinculado'); assert.equal(saved.matchedProductId, 'product');
    assert.equal(f.state.bipes[0].sellerId, photo.sellerId); assert.equal(f.state.bipes[0].sellerName, photo.sellerName);
    assert.equal(f.state.bipes[0].bipedAt.toISOString(), photo.createdAt.toISOString());
    assert.equal(f.state.captures.length, 1);
  });
  await test('manual photo arriving during recognition joins the same physical scan', async () => {
    const f = fixture(); f.setLearn(async () => {
      f.state.captures.push({ id: 'manual-during', storeId: 'store', roundId: 'round', scanKey: 'round:' + f.base.clientScanId,
        photo: 'data:image/webp;base64,TAP', note: 'revision:1', status: 'pendente' });
      return { reason: 'matched', productId: 'product', productSizeId: 'size' };
    });
    const result = await f.recognize(f.base);
    assert.equal(f.state.captures[0].bipeId, result.bipeId); assert.equal(f.state.bipes.length, 1);
    assert.equal(f.state.captures[0].photo, 'data:image/webp;base64,TAP');
  });
  await test('excluded or conflicting manual photos cannot create an automatic scan', async () => {
    for (const change of [{ excludedAt: new Date() }, { barcode: UNKNOWN }, { bipeId: 'different-bipe' }]) {
      const f = fixture(); f.state.captures.push({ id: 'photo', storeId: 'store', roundId: 'round',
        scanKey: 'round:' + f.base.clientScanId, ...change });
      await rejection(f.recognize(f.base), 409); assert.equal(f.state.bipes.length, 0);
    }
  });
  await test('explicit conflicting OCR never reports an old match as complete', async () => {
    const f = fixture(); await f.recognize(f.base);
    f.setLearn(async () => ({ reason: 'size_conflict' }));
    const result = await f.recognize({ ...f.base, ocrText: 'AB1234-001\nBR 41' });
    assert.equal(result.complete, false); assert.equal(result.pending, true); assert.equal(result.found, false);
    assert.equal(f.state.bipes[0].found, false); assert.equal(f.state.captures.length, 0);
  });
  await test('late unreadable OCR cannot erase a newer matched scan', async () => {
    const f = fixture(); await f.recognize(f.base); f.setLearn(async () => ({ reason: 'reference_not_found' }));
    const result = await f.recognize(f.base);
    assert.equal(result.complete, false); assert.equal(f.state.bipes[0].found, true); assert.equal(f.state.bipes[0].productSizeId, 'size');
  });
  await test('recognition failure preserves raw scan for a retry', async () => {
    const f = fixture(); f.setLearn(async () => { throw new Error('Temporary resolver failure'); });
    await assert.rejects(f.recognize(f.base), /Temporary resolver failure/);
    assert.equal(f.state.bipes.length, 1); assert.equal(f.state.captures.length, 0);
    f.setLearn(null); const result = await f.recognize(f.base);
    assert.equal(result.complete, true); assert.equal(f.state.bipes.length, 1);
  });
  await test('round closure during OCR prevents late scan mutation', async () => {
    const f = fixture(); f.setLearn(async () => { f.state.round.status = 'review'; return { reason: 'matched', productId: 'product', productSizeId: 'size' }; });
    await rejection(f.recognize(f.base), 409, /encerrada/);
    assert.equal(f.state.bipes.length, 1); assert.equal(f.state.bipes[0].found, false);
  });
  await test('size confirmation requirement is preserved', async () => {
    const f = fixture(); f.state.size.product.brand = 'ADIDAS'; f.state.size.sizeConfirmedAt = null;
    const result = await f.recognize(f.base);
    assert.equal(result.complete, false); assert.equal(result.needsSize, true); assert.deepEqual(result.sizeOptions, [{ size: '40' }]);
  });
  await test('applied stock snapshot cannot be changed by a conflicting retry', async () => {
    const f = fixture(); await f.recognize(f.base); f.state.bipes[0].applied = true;
    f.setLearn(async () => ({ reason: 'size_conflict' }));
    await rejection(f.recognize({ ...f.base, ocrText: 'AB1234-001\nBR 41' }), 409, /aplicada/);
    assert.equal(f.state.bipes[0].productSizeId, 'size'); assert.equal(f.state.bipes[0].applied, true);
    assert.equal(f.state.stockWrites, 0);
  });
  console.log('PASS ' + passed + ' automatic recognition tests');
})().catch(error => { console.error(error); process.exitCode = 1; });
