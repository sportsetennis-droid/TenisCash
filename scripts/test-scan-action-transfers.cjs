'use strict';

// Real PostgreSQL integration, restricted to an explicitly selected local database.
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const fs = require('node:fs');
const url = process.env.TRANSFER_TEST_DATABASE_URL;
if (!url || !['postgres:', 'postgresql:'].includes(new URL(url).protocol)
  || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) {
  throw Error('Use an isolated local TRANSFER_TEST_DATABASE_URL');
}
process.env.DATABASE_URL = url;
const { PrismaClient } = require('@prisma/client');
const service = require('../src/services/scanActionTransfers');
const db = new PrismaClient({ datasources: { db: { url } } });
const results = [];

function ean() {
  const digits = '28' + String(randomInt(0, 10000000000)).padStart(10, '0');
  const sum = [...digits].reduce((n, d, index) => n + Number(d) * (index % 2 ? 3 : 1), 0);
  return digits + ((10 - sum % 10) % 10);
}

async function fixture(stock = 6) {
  const suffix = randomUUID(), stores = [];
  for (const code of ['A', 'B', 'C']) stores.push(await db.store.create({ data: {
    name: 'Action test ' + code + ' ' + suffix, code: 'ACTION-' + code + suffix,
  } }));
  const [from, to, other] = stores;
  async function account(name, store) {
    return db.user.create({ data: { name, phone: name + '-' + suffix, pin: 'isolated-test', role: 'seller', storeId: store.id } });
  }
  const sender = await account('Sender', from), receiver = await account('Receiver', to), outsider = await account('Outsider', other);
  const product = await db.product.create({ data: {
    name: 'Action transfer product', sku: 'ACTION-' + suffix, brand: 'TEST', category: 'tenis', price: 149, costPrice: 41,
    sizes: { create: [{ size: '40', barcode: ean(), stock: 77, sizeConfirmedAt: new Date() },
      { size: '41', barcode: ean(), stock: 88, sizeConfirmedAt: new Date() }] },
  }, include: { sizes: { orderBy: { size: 'asc' } } } });
  const [size, secondSize] = product.sizes;
  await db.storeStock.createMany({ data: [
    { storeId: from.id, productSizeId: size.id, stock },
    { storeId: to.id, productSizeId: size.id, stock: 1 },
    { storeId: from.id, productSizeId: secondSize.id, stock: 3 },
  ] });
  // Existing inventory evidence deliberately shares stores/products with transfers.
  const round = await db.stocktakeRound.create({ data: { storeId: from.id, name: 'Inventory must stay separate', baseline: [{ productSizeId: size.id, stock }] } });
  const bipe = await db.stocktakeBipe.create({ data: { storeId: from.id, roundId: round.id, scanKey: round.id + ':' + randomUUID(),
    barcode: size.barcode, productId: product.id, productSizeId: size.id, productName: product.name, productSize: size.size,
    productBrand: product.brand, sellerId: sender.id, found: true, applied: false } });
  await db.productCapture.create({ data: { storeId: from.id, roundId: round.id, scanKey: bipe.scanKey, bipeId: bipe.id,
    barcode: size.barcode, status: 'vinculado', matchedProductId: product.id, photo: 'data:image/webp;base64,test-only' } });
  const sessionId = randomUUID();
  const scan = (chosenSize = size, overrides = {}) => ({ clientScanId: randomUUID(), barcode: chosenSize.barcode,
    productSizeId: chosenSize.id, confirmedSize: chosenSize.size, ...overrides });
  const send = (scans, overrides = {}) => ({ sessionId, fromStoreId: from.id, toStoreId: to.id, scans, ...overrides });
  const receive = (scans, overrides = {}) => ({ storeId: to.id, scans, ...overrides });
  return { from, to, other, sender, receiver, outsider, product, size, secondSize, round, bipe, sessionId, scan, send, receive };
}

async function snapshot(f) {
  const stores = [f.from.id, f.to.id, f.other.id];
  const [rounds, bipes, captures, sizes, stocks, transfers, movements, inventoryLinks] = await Promise.all([
    db.stocktakeRound.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stocktakeBipe.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.productCapture.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.productSize.findMany({ where: { productId: f.product.id }, orderBy: { id: 'asc' } }),
    db.storeStock.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stockTransfer.findMany({ where: { fromStoreId: { in: stores } }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    db.storeStockMovement.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stocktakeTransferScan.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
  ]);
  return { rounds, bipes, captures, sizes, stocks, transfers, movements, inventoryLinks };
}

function untouchedInventory(before, after) {
  for (const key of ['rounds', 'bipes', 'captures', 'sizes', 'inventoryLinks']) assert.deepEqual(after[key], before[key], key + ' must remain unchanged');
}
function publicOnly(value) {
  assert.ok(!/"(?:costPrice|unitCost|fiscalDocId|fiscalStatus|fiscalError|ncm|pin)"/.test(JSON.stringify(value)), 'No internal cost, fiscal or password fields in public response');
}
function stock(state, storeId, productSizeId) { return state.stocks.find(s => s.storeId === storeId && s.productSizeId === productSizeId)?.stock || 0; }
async function sendReview(f, input, actor = f.sender) {
  const review = await service.sendPreview(db, actor, input);
  assert.equal(review.canTransfer, true, JSON.stringify(review.blockers));
  assert.equal(review.blockers.length, 0); assert.ok(review.reviewToken); publicOnly(review); return review;
}
async function receiveReview(f, transferId, input, actor = f.receiver) {
  const review = await service.receivePreview(db, actor, transferId, input);
  assert.equal(review.canReceive, true, JSON.stringify(review.blockers));
  assert.equal(review.blockers.length, 0); assert.ok(review.reviewToken); publicOnly(review); return review;
}
async function sendOne(f, scans = [f.scan()]) {
  const input = f.send(scans), review = await sendReview(f, input);
  const request = { ...input, requestId: randomUUID(), reviewToken: review.reviewToken };
  return { ...(await service.sendConfirm(db, f.sender, request)), request };
}
async function blocked(f, direction, input, label, { actor, transferId } = {}) {
  actor ||= direction === 'send' ? f.sender : f.receiver;
  const before = await snapshot(f);
  const preview = direction === 'send' ? body => service.sendPreview(db, actor, body) : body => service.receivePreview(db, actor, transferId, body);
  const confirm = direction === 'send' ? body => service.sendConfirm(db, actor, body) : body => service.receiveConfirm(db, actor, transferId, body);
  let reviewToken = '0'.repeat(64);
  try {
    const review = await preview(input);
    assert.equal(review[direction === 'send' ? 'canTransfer' : 'canReceive'], false, label);
    assert.ok(review.blockers.length, label + ': needs an explanation');
    reviewToken = review.reviewToken; publicOnly(review);
  } catch (error) { assert.ok([400, 401, 403, 404, 409].includes(error.status), label + ': ' + error.stack); }
  await assert.rejects(() => confirm({ ...input, requestId: randomUUID(), reviewToken }), e => [400, 401, 403, 404, 409].includes(e.status), label);
  assert.deepEqual(await snapshot(f), before, label + ': rejection must not partially change stock or audit records');
}
async function test(name, work) {
  const start = Date.now(); await work(); results.push({ name, passed: true, elapsedMs: Date.now() - start }); console.log('PASS: ' + name);
}

(async () => {
  await test('send stays in transit until complete receipt; six concurrent retries create each stock movement once', async () => {
    const f = await fixture(), before = await snapshot(f);
    const scans = [f.scan(), f.scan(f.size, { duplicateConfirmed: true }), f.scan(f.secondSize)];
    const input = f.send(scans), review = await sendReview(f, input);
    assert.deepEqual(await snapshot(f), before, 'Preview is read-only');
    const request = { ...input, requestId: randomUUID(), reviewToken: review.reviewToken };
    const sent = await Promise.all(Array.from({ length: 6 }, () => service.sendConfirm(db, f.sender, request)));
    assert.equal(new Set(sent.map(r => r.transfer.id)).size, 1); sent.forEach(publicOnly);
    const transferId = sent[0].transfer.id, inTransit = await snapshot(f);
    assert.equal(sent[0].transfer.status, 'in_transit');
    assert.equal(inTransit.transfers.length, 1); assert.equal(inTransit.transfers[0].qtyTotal, 3);
    assert.equal(inTransit.transfers[0].receivedAt, null);
    assert.equal(stock(inTransit, f.from.id, f.size.id), 4); assert.equal(stock(inTransit, f.to.id, f.size.id), 1);
    assert.equal(stock(inTransit, f.from.id, f.secondSize.id), 2); assert.equal(stock(inTransit, f.to.id, f.secondSize.id), 0);
    assert.equal(inTransit.movements.length, 2); assert.ok(inTransit.movements.every(m => m.quantity < 0 && m.storeId === f.from.id));
    untouchedInventory(before, inTransit);
    const pending = await service.pending(db, f.receiver, { storeId: f.to.id }); publicOnly(pending);
    assert.ok(pending.transfers.some(t => t.id === transferId));
    const receivedScans = [f.scan(), f.scan(f.size, { duplicateConfirmed: true }), f.scan(f.secondSize)];
    const receipt = f.receive(receivedScans), receiptReview = await receiveReview(f, transferId, receipt);
    const receiptRequest = { ...receipt, requestId: randomUUID(), reviewToken: receiptReview.reviewToken };
    const received = await Promise.all(Array.from({ length: 6 }, () => service.receiveConfirm(db, f.receiver, transferId, receiptRequest)));
    assert.equal(new Set(received.map(r => r.transfer.id)).size, 1); received.forEach(publicOnly);
    const after = await snapshot(f);
    assert.equal(after.transfers.length, 1); assert.equal(after.transfers[0].status, 'received'); assert.ok(after.transfers[0].receivedAt);
    assert.equal(stock(after, f.from.id, f.size.id), 4); assert.equal(stock(after, f.to.id, f.size.id), 3);
    assert.equal(stock(after, f.from.id, f.secondSize.id), 2); assert.equal(stock(after, f.to.id, f.secondSize.id), 1);
    assert.equal(after.movements.length, 4);
    for (const size of [f.size, f.secondSize]) assert.equal(after.movements.filter(m => m.productSizeId === size.id).reduce((sum, m) => sum + m.quantity, 0), 0);
    untouchedInventory(before, after);
    assert.equal((await service.sendConfirm(db, f.sender, request)).alreadySaved, true);
    assert.equal((await service.receiveConfirm(db, f.receiver, transferId, receiptRequest)).alreadySaved, true);
    assert.deepEqual(await snapshot(f), after, 'Late send/receive retries do not repeat movement');
    assert.ok(!(await service.pending(db, f.receiver, { storeId: f.to.id })).transfers.some(t => t.id === transferId));
  });

  await test('missing, excess, foreign variant and mismatched receipt size cannot close the consignment', async () => {
    const f = await fixture(), sent = await sendOne(f, [f.scan(), f.scan(f.size, { duplicateConfirmed: true })]);
    const options = { transferId: sent.transfer.id };
    await blocked(f, 'receive', f.receive([]), 'Empty receipt', options);
    await blocked(f, 'receive', f.receive([f.scan()]), 'Missing unit', options);
    await blocked(f, 'receive', f.receive([f.scan(), f.scan(f.size, { duplicateConfirmed: true }), f.scan(f.size, { duplicateConfirmed: true })]), 'Excess unit', options);
    await blocked(f, 'receive', f.receive([f.scan(), f.scan(f.secondSize)]), 'Different variant than shipment', options);
    await blocked(f, 'receive', f.receive([f.scan(), f.scan(f.size, { duplicateConfirmed: true, confirmedSize: '41' })]), 'Wrong box size', options);
    await blocked(f, 'receive', f.receive([f.scan(), f.scan(f.size, { duplicateConfirmed: true, barcode: '' })]), 'Receipt requires an actually scanned barcode', options);
    await receiveReview(f, sent.transfer.id, f.receive([f.scan(), f.scan(f.size, { duplicateConfirmed: true })]));
  });

  await test('source and destination authorization comes from the current database account', async () => {
    const f = await fixture(), input = f.send([f.scan()]);
    publicOnly(await service.context(db, f.sender, {}));
    const lookup = await service.lookup(db, f.sender, { barcode: f.size.barcode }); publicOnly(lookup);
    await blocked(f, 'send', input, 'Foreign source with forged admin claim', { actor: { ...f.outsider, role: 'superadmin', storeId: f.from.id } });
    await db.user.update({ where: { id: f.sender.id }, data: { active: false } });
    await blocked(f, 'send', input, 'Disabled sender', { actor: { ...f.sender, active: true } });
    await db.user.update({ where: { id: f.sender.id }, data: { active: true, role: 'user' } });
    await blocked(f, 'send', input, 'Customer forges seller role');
    await db.user.update({ where: { id: f.sender.id }, data: { role: 'seller' } });
    const sent = await sendOne(f), receipt = f.receive([f.scan()]);
    await blocked(f, 'receive', receipt, 'Source seller cannot act for destination', { transferId: sent.transfer.id, actor: { ...f.sender, role: 'superadmin', storeId: f.to.id } });
    await blocked(f, 'receive', f.receive([f.scan()], { storeId: f.other.id }), 'Wrong destination', { transferId: sent.transfer.id, actor: f.outsider });
    await assert.rejects(() => service.pending(db, { ...f.outsider, role: 'superadmin' }, { storeId: f.to.id }), e => e.status === 403);
    const review = await receiveReview(f, sent.transfer.id, receipt);
    await db.user.update({ where: { id: f.receiver.id }, data: { active: false } });
    const before = await snapshot(f);
    await assert.rejects(() => service.receiveConfirm(db, f.receiver, sent.transfer.id, { ...receipt, requestId: randomUUID(), reviewToken: review.reviewToken }), e => [401, 403].includes(e.status));
    assert.deepEqual(await snapshot(f), before);
  });

  await test('barcode, confirmed box size, ambiguity and repeated physical scan validation precede every send', async () => {
    const f = await fixture();
    await blocked(f, 'send', f.send([]), 'Empty shipment');
    await blocked(f, 'send', f.send([f.scan()], { toStoreId: f.from.id }), 'Same source and destination');
    await blocked(f, 'send', f.send([f.scan(f.size, { barcode: '' })]), 'Missing barcode');
    await blocked(f, 'send', f.send([f.scan(f.size, { barcode: 'SEM GTIN' })]), 'SEM GTIN');
    await blocked(f, 'send', f.send([f.scan(f.size, { barcode: f.secondSize.barcode })]), 'Barcode belongs to another variant');
    await blocked(f, 'send', f.send([f.scan(f.size, { confirmedSize: '' })]), 'Missing box size');
    await blocked(f, 'send', f.send([f.scan(f.size, { confirmedSize: '42' })]), 'Different box size');
    await blocked(f, 'send', f.send([f.scan(), f.scan()]), 'Repeated EAN without physical confirmation');
    await blocked(f, 'send', f.send([f.scan(), f.scan(f.size, { barcode: '0' + f.size.barcode })]), 'Normalized EAN repeated without physical confirmation');
    const repeatedId = f.scan();
    await blocked(f, 'send', f.send([repeatedId, { ...repeatedId, barcode: f.secondSize.barcode, productSizeId: f.secondSize.id, confirmedSize: '41' }]), 'One scan ID cannot describe two pieces');
    await db.productSize.update({ where: { id: f.size.id }, data: { size: 'T-PENDING' } });
    await blocked(f, 'send', f.send([f.scan(f.size, { confirmedSize: 'T-PENDING' })]), 'Technical placeholder is not a box size');
    await db.productSize.update({ where: { id: f.size.id }, data: { size: '40' } });
    await db.product.create({ data: { name: 'Ambiguous barcode owner', sku: 'AMB-' + randomUUID(), brand: 'OTHER', category: 'tenis', price: 1,
      sizes: { create: { size: '40', barcode: f.size.barcode, stock: 0 } } } });
    await blocked(f, 'send', f.send([f.scan()]), 'Same barcode assigned to two active products');
  });

  await test('a scan cannot be sent again under a different request; request IDs cannot change their content', async () => {
    const f = await fixture(), scan = f.scan(), sent = await sendOne(f, [scan]);
    await blocked(f, 'send', f.send([scan]), 'Already sent scan in the same session');
    const before = await snapshot(f);
    await assert.rejects(() => service.sendConfirm(db, f.sender, { ...sent.request, toStoreId: f.other.id }), e => e.status === 409);
    await assert.rejects(() => service.sendConfirm(db, f.sender, { ...sent.request, scans: [f.scan(f.secondSize)] }), e => e.status === 409);
    assert.deepEqual(await snapshot(f), before);
    // A genuinely new physical scan of the same EAN is allowed in the next shipment.
    await sendReview(f, f.send([f.scan()]));
  });

  await test('concurrent shipments compete for the last unit without negative stock or orphan audit records', async () => {
    const f = await fixture(1), inputs = [f.send([f.scan()]), f.send([f.scan()])], requests = [];
    for (const input of inputs) requests.push({ ...input, requestId: randomUUID(), reviewToken: (await sendReview(f, input)).reviewToken });
    const competing = await Promise.allSettled(requests.map(request => service.sendConfirm(db, f.sender, request)));
    assert.equal(competing.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(competing.find(r => r.status === 'rejected').reason.status, 409);
    const after = await snapshot(f);
    assert.equal(after.transfers.length, 1); assert.equal(after.movements.length, 1);
    assert.equal(stock(after, f.from.id, f.size.id), 0); assert.equal(stock(after, f.to.id, f.size.id), 1);
  });

  await test('stale source balance and stale destination balance require a new review', async () => {
    const f = await fixture(), input = f.send([f.scan()]), review = await sendReview(f, input);
    await db.storeStock.update({ where: { storeId_productSizeId: { storeId: f.from.id, productSizeId: f.size.id } }, data: { stock: 5 } });
    let before = await snapshot(f);
    await assert.rejects(() => service.sendConfirm(db, f.sender, { ...input, requestId: randomUUID(), reviewToken: review.reviewToken }), e => e.status === 409);
    assert.deepEqual(await snapshot(f), before);
    const sent = await sendOne(f), receipt = f.receive([f.scan()]), receiptReview = await receiveReview(f, sent.transfer.id, receipt);
    await db.storeStock.update({ where: { storeId_productSizeId: { storeId: f.to.id, productSizeId: f.size.id } }, data: { stock: 2 } });
    before = await snapshot(f);
    await assert.rejects(() => service.receiveConfirm(db, f.receiver, sent.transfer.id, { ...receipt, requestId: randomUUID(), reviewToken: receiptReview.reviewToken }), e => e.status === 409);
    assert.deepEqual(await snapshot(f), before);
  });

  await test('destination credit failure rolls back receipt status and all credits while leaving the shipment in transit', async () => {
    const f = await fixture(), sent = await sendOne(f, [f.scan(), f.scan(f.secondSize)]);
    await db.storeStock.update({ where: { storeId_productSizeId: { storeId: f.to.id, productSizeId: f.size.id } }, data: { stock: 2147483647 } });
    const receipt = f.receive([f.scan(), f.scan(f.secondSize)]), review = await receiveReview(f, sent.transfer.id, receipt), before = await snapshot(f);
    await assert.rejects(() => service.receiveConfirm(db, f.receiver, sent.transfer.id, { ...receipt, requestId: randomUUID(), reviewToken: review.reviewToken }));
    assert.deepEqual(await snapshot(f), before, 'Database overflow must roll back received status, metadata, credits and movement records');
  });

  await test('physical scan IDs cannot move stock twice across sessions, shipment/receipt or separate consignments', async () => {
    const f = await fixture(), sentScan = f.scan(), first = await sendOne(f, [sentScan]);
    await blocked(f, 'send', f.send([sentScan], { sessionId: randomUUID() }), 'Same physical scan in a new session');
    await blocked(f, 'receive', f.receive([sentScan]), 'Receipt must scan the physical piece again', { transferId: first.transfer.id });
    const second = await sendOne(f), receiptScan = f.scan(), receipt = f.receive([receiptScan]);
    const review = await receiveReview(f, first.transfer.id, receipt);
    await service.receiveConfirm(db, f.receiver, first.transfer.id, { ...receipt, requestId: randomUUID(), reviewToken: review.reviewToken });
    await blocked(f, 'receive', f.receive([receiptScan]), 'One physical receipt scan cannot receive two consignments', { transferId: second.transfer.id });
    await receiveReview(f, second.transfer.id, f.receive([f.scan()]));
  });

  await test('an item made inactive after dispatch can still be received as the exact shipped variant', async () => {
    const f = await fixture(), sent = await sendOne(f);
    await db.product.update({ where: { id: f.product.id }, data: { active: false } });
    await blocked(f, 'send', f.send([f.scan()]), 'Inactive product cannot start another shipment');
    const lookup = await service.lookup(db, f.receiver, { barcode: f.size.barcode, transferId: sent.transfer.id, storeId: f.to.id });
    publicOnly(lookup);
    const receipt = f.receive([f.scan()]), review = await receiveReview(f, sent.transfer.id, receipt), before = await snapshot(f);
    const result = await service.receiveConfirm(db, f.receiver, sent.transfer.id, { ...receipt, requestId: randomUUID(), reviewToken: review.reviewToken });
    assert.equal(result.transfer.status, 'received');
    const after = await snapshot(f); untouchedInventory(before, after);
    assert.equal(stock(after, f.to.id, f.size.id), stock(before, f.to.id, f.size.id) + 1);
    assert.equal((await db.product.findUnique({ where: { id: f.product.id } })).active, false, 'Receiving does not reactivate or replace the product');
  });

  if (process.env.TRANSFER_TEST_FIXTURE) {
    const f = await fixture(), input = f.send([f.scan(), f.scan(f.size, { duplicateConfirmed: true }), f.scan(f.secondSize)]);
    await sendReview(f, input);
    fs.writeFileSync(process.env.TRANSFER_TEST_FIXTURE, JSON.stringify({ senderId: f.sender.id, receiverId: f.receiver.id,
      outsiderId: f.outsider.id, fromStoreId: f.from.id, toStoreId: f.to.id, otherStoreId: f.other.id, productId: f.product.id,
      productSizeIds: [f.size.id, f.secondSize.id], inventoryRoundId: f.round.id, input,
      receiptInput: f.receive([f.scan(), f.scan(f.size, { duplicateConfirmed: true }), f.scan(f.secondSize)]) }, null, 2));
    console.log('PASS: fresh send/receive fixture saved for isolated HTTP or browser verification');
  }
  console.log('PASS PostgreSQL: action transfer shipments and receipts are atomic, scoped and independent of inventory counts.');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (process.env.TRANSFER_TEST_REPORT) fs.writeFileSync(process.env.TRANSFER_TEST_REPORT, JSON.stringify({ at: new Date().toISOString(), passed: !process.exitCode, tests: results }, null, 2));
  await db.$disconnect();
});
