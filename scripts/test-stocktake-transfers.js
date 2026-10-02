'use strict';

// Integration tests only: never inherit the application's production datasource.
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const url = process.env.TRANSFER_TEST_DATABASE_URL;
if (!url || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)
  || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) {
  throw Error('Use an isolated local TRANSFER_TEST_DATABASE_URL');
}
process.env.DATABASE_URL = url;
const { PrismaClient } = require('@prisma/client');
const service = require('../src/services/stocktakeTransfers');
const db = new PrismaClient({ datasources: { db: { url } } });

function ean() {
  const digits = '29' + String(randomInt(0, 10000000000)).padStart(10, '0');
  const sum = [...digits].reduce((n, digit, index) => n + Number(digit) * (index % 2 ? 3 : 1), 0);
  return digits + ((10 - sum % 10) % 10);
}

async function fixture({ stock = 8, brand = 'TEST' } = {}) {
  const suffix = randomUUID();
  const stores = [];
  for (const code of ['A', 'B', 'C']) stores.push(await db.store.create({
    data: { name: 'Batch transfer test ' + code + ' ' + suffix, code: code + suffix },
  }));
  const [from, to, other] = stores;
  const actor = await db.user.create({ data: {
    name: 'Batch transfer operator', phone: 'batch-' + suffix, pin: 'isolated-test', role: 'seller', storeId: from.id,
  } });
  const outsider = await db.user.create({ data: {
    name: 'Other store operator', phone: 'batch-other-' + suffix, pin: 'isolated-test', role: 'seller', storeId: other.id,
  } });
  const product = await db.product.create({ data: {
    name: 'Batch transfer product', sku: 'BATCH-' + suffix, brand, category: 'tenis', price: 100, costPrice: 41,
    sizes: { create: [
      { size: '40', barcode: ean(), stock: 77, sizeConfirmedAt: new Date() },
      { size: '41', barcode: ean(), stock: 88, sizeConfirmedAt: new Date() },
    ] },
  }, include: { sizes: { orderBy: { size: 'asc' } } } });
  const [size, secondSize] = product.sizes;
  await db.storeStock.createMany({ data: [
    { storeId: from.id, productSizeId: size.id, stock },
    { storeId: to.id, productSizeId: size.id, stock: 1 },
    { storeId: from.id, productSizeId: secondSize.id, stock: 4 },
  ] });
  const round = await db.stocktakeRound.create({ data: { storeId: from.id, name: 'Selection round', baseline: [] } });
  const laterRound = await db.stocktakeRound.create({ data: { storeId: from.id, name: 'Different round', baseline: [] } });
  const foreignRound = await db.stocktakeRound.create({ data: { storeId: other.id, name: 'Different store', baseline: [] } });
  async function bipe(overrides = {}) {
    const chosenSize = overrides.productSizeId === secondSize.id ? secondSize : size;
    return db.stocktakeBipe.create({ data: {
      storeId: from.id, roundId: round.id, scanKey: round.id + ':' + randomUUID(),
      sellerId: actor.id, sellerName: actor.name, barcode: chosenSize.barcode,
      productId: product.id, productSizeId: chosenSize.id, productName: product.name,
      productSize: chosenSize.size, productBrand: brand, found: true, applied: false,
      bipedAt: new Date(Date.now() - 1000), ...overrides,
    } });
  }
  async function capture(scan, overrides = {}) {
    return db.productCapture.create({ data: {
      storeId: scan.storeId, roundId: scan.roundId, scanKey: scan.scanKey,
      bipeId: scan.id, barcode: scan.barcode, status: 'vinculado', matchedProductId: product.id,
      photo: 'data:image/webp;base64,fixture-only', note: 'Keep original evidence', ...overrides,
    } });
  }
  const input = (bipes, overrides = {}) => ({
    fromStoreId: from.id, toStoreId: to.id, roundId: round.id, bipeIds: bipes.map(b => b.id), ...overrides,
  });
  return { from, to, other, actor, outsider, product, size, secondSize, round, laterRound, foreignRound, bipe, capture, input };
}

async function snapshot(f) {
  const storeIds = [f.from.id, f.to.id, f.other.id];
  const [bipes, captures, sizes, stock, transfers, movements, links] = await Promise.all([
    db.stocktakeBipe.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.productCapture.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.productSize.findMany({ where: { productId: f.product.id }, orderBy: { id: 'asc' } }),
    db.storeStock.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.stockTransfer.findMany({ where: { fromStoreId: { in: storeIds } }, include: { items: true }, orderBy: { id: 'asc' } }),
    db.storeStockMovement.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.stocktakeTransferScan.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
  ]);
  return { bipes, captures, sizes, stock, transfers, movements, links };
}

async function ready(f, input, actor = f.actor) {
  const result = await service.preview(db, actor, input);
  assert.equal(result.canTransfer, true, JSON.stringify(result.blockers));
  assert.equal(result.blockers.length, 0);
  assert.ok(result.reviewToken, 'The preview must provide a token for exactly this review');
  return result;
}

async function blocked(f, input, label, actor = f.actor) {
  const before = await snapshot(f);
  let token = 'invalid-preview';
  try {
    const result = await service.preview(db, actor, input);
    assert.equal(result.canTransfer, false, label);
    assert.ok(result.blockers.length, label + ': explain the blocker');
    token = result.reviewToken;
  } catch (error) {
    assert.ok([400, 403, 404, 409].includes(error.status), label + ': ' + error.stack);
  }
  await assert.rejects(() => service.confirm(db, actor, { ...input, requestId: randomUUID(), reviewToken: token }),
    error => [400, 403, 404, 409].includes(error.status), label + ': confirm must also reject');
  assert.deepEqual(await snapshot(f), before, label + ': failure must leave no partial movement or link');
}

async function test(name, work) {
  await work();
  console.log('PASS: ' + name);
}

(async () => {
  await test('explicit selection, repeated EANs, mixed selectors and eight concurrent retries preserve original evidence', async () => {
    const f = await fixture();
    const a = await f.bipe(), b = await f.bipe(), c = await f.bipe({ productSizeId: f.secondSize.id });
    const unselected = await f.bipe();
    await f.capture(a);
    // An unrelated unresolved capture must not silently expand the explicit selection.
    await f.capture(unselected, { status: 'pendente' });
    const input = f.input([a], { scanKeys: [a.scanKey, b.scanKey, c.scanKey] });
    const before = await snapshot(f), review = await ready(f, input);
    assert.deepEqual(await snapshot(f), before, 'Preview is read-only');
    assert.equal(review.scanCount, 3, 'The same scan selected by ID and scanKey counts once');
    assert.equal(review.items.length, 2);
    assert.equal(review.items.find(i => i.productSizeId === f.size.id).quantity, 2, 'Two physical reads of one EAN count twice');
    assert.equal(review.items.find(i => i.productSizeId === f.size.id).remaining, 6);
    assert.ok(!/costPrice|unitCost|fiscalDocId/.test(JSON.stringify(review)), 'Seller review does not leak internal fiscal/cost fields');
    const request = { ...input, requestId: randomUUID(), reviewToken: review.reviewToken };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.confirm(db, f.actor, request)));
    assert.equal(new Set(results.map(r => r.transfer.id)).size, 1);
    const after = await snapshot(f), saved = after.transfers[0];
    assert.equal(after.transfers.length, 1);
    assert.equal(saved.id, request.requestId);
    assert.equal(saved.status, 'received');
    assert.equal(saved.qtyTotal, 3);
    assert.equal(saved.fiscalStatus, 'skipped');
    assert.equal(saved.fiscalDocId, null);
    assert.equal(saved.items.reduce((sum, i) => sum + i.quantity, 0), 3);
    assert.equal(after.links.length, 3);
    assert.deepEqual(after.links.map(l => l.bipeId).sort(), [a.id, b.id, c.id].sort());
    for (const link of after.links) {
      const scan = [a, b, c].find(row => row.id === link.bipeId);
      assert.equal(link.transferId, saved.id);
      assert.equal(link.storeId, f.from.id);
      assert.equal(link.roundId, f.round.id);
      assert.equal(link.productSizeId, scan.productSizeId);
      assert.equal(link.barcode, scan.barcode);
    }
    assert.deepEqual(after.bipes, before.bipes, 'Transfer does not move, apply, duplicate or edit inventory reads');
    assert.deepEqual(after.captures, before.captures, 'Transfer does not move or edit captures');
    assert.deepEqual(after.sizes, before.sizes, 'Purchased stock and catalog remain unchanged');
    assert.equal(after.stock.find(s => s.storeId === f.from.id && s.productSizeId === f.size.id).stock, 6);
    assert.equal(after.stock.find(s => s.storeId === f.to.id && s.productSizeId === f.size.id).stock, 3);
    assert.equal(after.stock.find(s => s.storeId === f.from.id && s.productSizeId === f.secondSize.id).stock, 3);
    assert.equal(after.stock.find(s => s.storeId === f.to.id && s.productSizeId === f.secondSize.id).stock, 1);
    assert.equal(after.movements.length, 4, 'One out/in movement pair per variant');
    for (const size of [f.size, f.secondSize]) {
      const moves = after.movements.filter(m => m.productSizeId === size.id);
      assert.equal(moves.length, 2);
      assert.equal(moves.reduce((sum, m) => sum + m.quantity, 0), 0);
      for (const move of moves) assert.equal(move.stockAfter - move.stockBefore, move.quantity);
    }
    assert.ok(!/costPrice|unitCost|fiscalDocId/.test(JSON.stringify(results[0])));
    const retried = await service.confirm(db, f.actor, { ...request, bipeIds: [c.id, b.id, a.id], scanKeys: [] });
    assert.equal(retried.alreadySaved, true, 'Equivalent explicit selection can retry after the stock changed');
    assert.deepEqual(await snapshot(f), after);
    await blocked(f, f.input([a]), 'A transferred bipe cannot be transferred under a new request');
    await assert.rejects(() => service.confirm(db, f.actor, { ...request, toStoreId: f.other.id }), e => e.status === 409);
    await assert.rejects(() => service.confirm(db, f.actor, { ...request, bipeIds: [unselected.id], scanKeys: [] }), e => e.status === 409);
    assert.deepEqual(await snapshot(f), after, 'Conflicting request IDs cannot add movements');
  });

  await test('simultaneous requests cannot consume the last available unit twice', async () => {
    const f = await fixture({ stock: 1 }), scans = [await f.bipe(), await f.bipe()];
    const requests = [];
    for (const scan of scans) {
      const input = f.input([scan]), review = await ready(f, input);
      requests.push({ ...input, requestId: randomUUID(), reviewToken: review.reviewToken });
    }
    const results = await Promise.allSettled(requests.map(input => service.confirm(db, f.actor, input)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    const after = await snapshot(f);
    assert.equal(after.transfers.length, 1);
    assert.equal(after.links.length, 1);
    assert.equal(after.movements.length, 2);
    assert.equal(after.stock.find(s => s.storeId === f.from.id && s.productSizeId === f.size.id).stock, 0);
    assert.equal(after.stock.find(s => s.storeId === f.to.id && s.productSizeId === f.size.id).stock, 2);
  });

  await test('overlapping selections with different request IDs cannot reuse one physical scan', async () => {
    const f = await fixture({ stock: 10 }), a = await f.bipe(), b = await f.bipe(), c = await f.bipe();
    const selections = [f.input([a, b]), f.input([b, c])], requests = [];
    for (const input of selections) requests.push({ ...input, requestId: randomUUID(), reviewToken: (await ready(f, input)).reviewToken });
    const results = await Promise.allSettled(requests.map(input => service.confirm(db, f.actor, input)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    const after = await snapshot(f);
    assert.equal(after.links.length, 2);
    assert.equal(after.transfers.length, 1);
    assert.equal(after.stock.find(s => s.storeId === f.from.id && s.productSizeId === f.size.id).stock, 8);
  });

  await test('empty, partial, missing, cross-store and cross-round selection never expands or partially transfers', async () => {
    const f = await fixture(), valid = await f.bipe();
    const otherRound = await f.bipe({ roundId: f.laterRound.id, scanKey: f.laterRound.id + ':' + randomUUID() });
    const foreign = await f.bipe({ storeId: f.other.id, roundId: f.foreignRound.id, scanKey: f.foreignRound.id + ':' + randomUUID() });
    await blocked(f, f.input([]), 'Empty selection');
    await blocked(f, f.input([valid], { bipeIds: [valid.id, 'missing-' + randomUUID()] }), 'Partial unknown IDs');
    await blocked(f, f.input([valid], { scanKeys: [f.round.id + ':' + randomUUID()] }), 'Partial unknown scanKeys');
    await blocked(f, f.input([valid, otherRound]), 'Other round');
    await blocked(f, f.input([valid, foreign]), 'Other store');
    await blocked(f, f.input([valid], { roundId: f.foreignRound.id }), 'Round belongs to another store');
    await blocked(f, f.input([valid], { toStoreId: f.from.id }), 'Same source and destination');
    const orphan = await db.productCapture.create({ data: { storeId: f.from.id, roundId: f.round.id,
      scanKey: f.round.id + ':' + randomUUID(), barcode: f.size.barcode, status: 'pendente' } });
    await blocked(f, f.input([], { scanKeys: [orphan.scanKey] }), 'Selected capture without resolved bipe');
    await ready(f, f.input([valid]));
  });

  await test('real account permissions override forged actor fields and are rechecked at confirm', async () => {
    const f = await fixture(), scan = await f.bipe(), input = f.input([scan]);
    const review = await ready(f, input);
    await blocked(f, input, 'Forged role/source', { ...f.outsider, role: 'superadmin', storeId: f.from.id });
    await blocked(f, input, 'Unknown account', { ...f.actor, id: randomUUID() });
    await db.user.update({ where: { id: f.actor.id }, data: { active: false } });
    await blocked(f, input, 'Inactive real account', { ...f.actor, active: true });
    await assert.rejects(() => service.confirm(db, f.actor, { ...input, requestId: randomUUID(), reviewToken: review.reviewToken }), e => e.status === 403);
    await db.user.update({ where: { id: f.actor.id }, data: { active: true, role: 'user' } });
    await blocked(f, input, 'Customer cannot forge seller role', f.actor);
    await db.user.update({ where: { id: f.actor.id }, data: { role: 'seller', storeId: f.other.id, storeIds: [f.from.id] } });
    await ready(f, input, f.actor);
  });

  await test('unresolved, excluded, ambiguous, applied, invalid barcode and conflicting size reads block the whole batch', async () => {
    const f = await fixture(), good = await f.bipe();
    const invalidReads = [
      ['Unresolved product', { found: false, productId: null, productSizeId: null, productSize: null }],
      ['Excluded', { excludedAt: new Date(), exclusionReason: 'Test exclusion' }],
      ['Ambiguous', { duplicate: true }],
      ['Already applied to inventory', { applied: true }],
      ['Barcode absent', { barcode: '' }],
      ['SEM GTIN is not a scan', { barcode: 'SEM GTIN' }],
      ['Reference is not a barcode', { barcode: 'REF:TEST-40' }],
      ['Barcode belongs to another size', { barcode: f.secondSize.barcode }],
      ['Snapshot size conflicts with variant', { productSize: '42' }],
      ['Missing variant', { productSizeId: null }],
    ];
    for (const [label, overrides] of invalidReads) await blocked(f, f.input([good, await f.bipe(overrides)]), label);
    const input = f.input([good]);
    await db.productSize.update({ where: { id: f.size.id }, data: { size: 'T-PENDING' } });
    await blocked(f, input, 'Technical size placeholder');
    await db.productSize.update({ where: { id: f.size.id }, data: { size: '40' } });
    await db.product.update({ where: { id: f.product.id }, data: { active: false } });
    await blocked(f, input, 'Inactive product');
  });

  await test('pending captures and box-size evidence cannot be bypassed by a previously recognized barcode', async () => {
    const f = await fixture(), scan = await f.bipe(), input = f.input([scan]);
    const capture = await f.capture(scan, { status: 'pendente' });
    await blocked(f, input, 'Pending capture linked by bipe ID');
    await db.productCapture.update({ where: { id: capture.id }, data: { status: 'vinculado' } });
    await ready(f, input);
    const secondCapture = await f.capture(scan, { scanKey: f.round.id + ':' + randomUUID(), status: 'processando' });
    await blocked(f, input, 'One resolved capture must not hide another pending capture');
    await db.productCapture.update({ where: { id: secondCapture.id }, data: { status: 'vinculado' } });
    await db.productCapture.update({ where: { id: capture.id }, data: { storeId: f.other.id, roundId: f.foreignRound.id } });
    await blocked(f, input, 'Capture evidence belongs to a different store and round');
    const nike = await fixture({ brand: 'NIKE' }), nikeScan = await nike.bipe();
    await db.productSize.update({ where: { id: nike.size.id }, data: { sizeConfirmedAt: null } });
    await blocked(nike, nike.input([nikeScan]), 'Nike size lacks evidence');
    const adidas = await fixture({ brand: 'ADIDAS' }), adidasScan = await adidas.bipe();
    await db.productSize.update({ where: { id: adidas.size.id }, data: { sizeConfirmedAt: new Date(+adidasScan.bipedAt - 1000) } });
    await blocked(adidas, adidas.input([adidasScan]), 'Adidas old confirmation is not current box evidence');
  });

  await test('stale balances, changed selection and changed capture evidence require a new review', async () => {
    const f = await fixture(), scan = await f.bipe(), other = await f.bipe(), capture = await f.capture(scan), input = f.input([scan]);
    async function rejectsStale(mutate, restore) {
      const review = await ready(f, input);
      await mutate();
      const before = await snapshot(f);
      await assert.rejects(() => service.confirm(db, f.actor, { ...input, requestId: randomUUID(), reviewToken: review.reviewToken }), e => e.status === 409);
      assert.deepEqual(await snapshot(f), before, 'Stale preview must not mutate anything');
      await restore();
    }
    const fromKey = { storeId_productSizeId: { storeId: f.from.id, productSizeId: f.size.id } };
    const toKey = { storeId_productSizeId: { storeId: f.to.id, productSizeId: f.size.id } };
    await rejectsStale(() => db.storeStock.update({ where: fromKey, data: { stock: 7 } }),
      () => db.storeStock.update({ where: fromKey, data: { stock: 8 } }));
    await rejectsStale(() => db.storeStock.update({ where: toKey, data: { stock: 2 } }),
      () => db.storeStock.update({ where: toKey, data: { stock: 1 } }));
    await rejectsStale(() => db.productCapture.update({ where: { id: capture.id }, data: { status: 'processando' } }),
      () => db.productCapture.update({ where: { id: capture.id }, data: { status: 'vinculado' } }));
    await rejectsStale(() => db.stocktakeBipe.update({ where: { id: scan.id }, data: { productSize: '42' } }),
      () => db.stocktakeBipe.update({ where: { id: scan.id }, data: { productSize: '40' } }));
    const review = await ready(f, input), before = await snapshot(f);
    await assert.rejects(() => service.confirm(db, f.actor, { ...f.input([other]), requestId: randomUUID(), reviewToken: review.reviewToken }), e => e.status === 409);
    await assert.rejects(() => service.confirm(db, f.actor, { ...input, requestId: randomUUID(), reviewToken: '' }), e => [400, 409].includes(e.status));
    assert.deepEqual(await snapshot(f), before);
    await db.storeStock.update({ where: fromKey, data: { stock: 0 } });
    await blocked(f, input, 'Insufficient source stock');
  });

  await test('closed rounds and inactive destinations cannot transfer even previously valid scans', async () => {
    const f = await fixture(), scan = await f.bipe(), input = f.input([scan]);
    await db.stocktakeRound.update({ where: { id: f.round.id }, data: { status: 'applied', appliedAt: new Date() } });
    await blocked(f, input, 'Applied round');
    await db.stocktakeRound.update({ where: { id: f.round.id }, data: { status: 'counting', appliedAt: null } });
    await db.store.update({ where: { id: f.to.id }, data: { active: false } });
    await blocked(f, input, 'Inactive destination');
  });

  await test('a database failure during the destination credit rolls back the source debit and every audit record', async () => {
    const f = await fixture(), scan = await f.bipe(), input = f.input([scan]);
    // PostgreSQL Int overflow fails after transfer/link creation and source debit.
    // This exercises real transaction rollback, without replacing service methods.
    await db.storeStock.update({ where: { storeId_productSizeId: { storeId: f.to.id, productSizeId: f.size.id } },
      data: { stock: 2147483647 } });
    const review = await ready(f, input), before = await snapshot(f);
    await assert.rejects(() => service.confirm(db, f.actor, { ...input, requestId: randomUUID(), reviewToken: review.reviewToken }));
    assert.deepEqual(await snapshot(f), before, 'A failed destination credit must not leave a source debit, transfer, movement or scan link');
  });

  if (process.env.TRANSFER_TEST_FIXTURE) {
    const f = await fixture(), scans = [await f.bipe(), await f.bipe(), await f.bipe({ productSizeId: null, found: false })];
    await f.capture(scans[0]);
    const input = f.input(scans.slice(0, 2));
    await ready(f, input);
    require('node:fs').writeFileSync(process.env.TRANSFER_TEST_FIXTURE, JSON.stringify({
      actorId: f.actor.id, otherId: f.outsider.id, fromStoreId: f.from.id, toStoreId: f.to.id,
      otherStoreId: f.other.id, productId: f.product.id, productSizeId: f.size.id, barcode: f.size.barcode,
      roundId: f.round.id, bipeIds: scans.slice(0, 2).map(b => b.id), scanKeys: scans.slice(0, 2).map(b => b.scanKey),
      pendingBipeId: scans[2].id, request: input,
    }, null, 2));
    console.log('PASS: fresh valid UI/HTTP fixture saved separately from the completed test cases');
  }
  console.log('PASS PostgreSQL: selected batch transfers are atomic, authorized, scoped, idempotent and preserve inventory evidence and purchased stock.');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
