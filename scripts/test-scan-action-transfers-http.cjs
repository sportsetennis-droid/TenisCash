'use strict';

// Run after test-scan-action-transfers.cjs exports a fresh fixture. All HTTP and
// database destinations must be explicitly supplied and restricted to localhost.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const url = process.env.TRANSFER_TEST_DATABASE_URL;
const baseUrl = process.env.TRANSFER_TEST_BASE_URL;
const secret = process.env.TRANSFER_TEST_HTTP_SECRET;
const fixturePath = process.env.TRANSFER_TEST_FIXTURE;
const local = value => value && ['localhost', '127.0.0.1'].includes(new URL(value).hostname);
if (!local(url) || !local(baseUrl) || !secret || !fixturePath) throw Error('Provide isolated local database/base URL, test JWT secret and fresh fixture');
process.env.DATABASE_URL = url;
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url } } });
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const report = { startedAt: new Date().toISOString(), baseUrl, checks: [] };
const tokenFor = (userId, extra = {}) => jwt.sign({ userId, ...extra }, secret, { expiresIn: '1h' });
const senderToken = tokenFor(fixture.senderId, { role: 'superadmin' });
const receiverToken = tokenFor(fixture.receiverId, { role: 'superadmin' });

async function request(label, route, body, token, expected, method = 'POST') {
  const started = performance.now();
  const response = await fetch(baseUrl + route, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35000) });
  const result = await response.json();
  report.checks.push({ label, method, route, status: response.status, expected, elapsedMs: Math.round(performance.now() - started), response: result });
  assert.equal(response.status, expected, label + ': ' + JSON.stringify(result));
  assert.ok(!/"(?:costPrice|unitCost|fiscalDocId|fiscalStatus|fiscalError|ncm|pin)"/.test(JSON.stringify(result)), label + ': internal field leaked');
  return result;
}
async function state() {
  const stores = [fixture.fromStoreId, fixture.toStoreId, fixture.otherStoreId];
  const [rounds, bipes, captures, sizes, stocks, transfers, moves, links] = await Promise.all([
    db.stocktakeRound.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stocktakeBipe.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.productCapture.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.productSize.findMany({ where: { productId: fixture.productId }, orderBy: { id: 'asc' } }),
    db.storeStock.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stockTransfer.findMany({ where: { fromStoreId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.storeStockMovement.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
    db.stocktakeTransferScan.findMany({ where: { storeId: { in: stores } }, orderBy: { id: 'asc' } }),
  ]);
  return { rounds, bipes, captures, sizes, stocks, transfers, moves, links };
}

(async () => {
  const before = await state(), input = fixture.input;
  await request('unauthenticated context', '/actions/context', null, null, 401, 'GET');
  await request('unauthenticated shipment preview', '/actions/send-preview', input, null, 401);
  await request('forged privileged claims cannot send from another store', '/actions/send-preview', input,
    tokenFor(fixture.outsiderId, { role: 'superadmin', storeId: fixture.fromStoreId, storeIds: [fixture.fromStoreId] }), 403);
  await db.user.update({ where: { id: fixture.senderId }, data: { role: 'user' } });
  try { await request('real account demotion overrides existing token', '/actions/send-preview', input, senderToken, 403); }
  finally { await db.user.update({ where: { id: fixture.senderId }, data: { role: 'seller' } }); }
  const context = await request('authenticated action context', '/actions/context', null, senderToken, 200, 'GET');
  assert.ok(context.stores.length);
  await request('lookup actual scanned barcode', '/actions/lookup', { barcode: input.scans[0].barcode }, senderToken, 200);
  const review = await request('review shipment', '/actions/send-preview', input, senderToken, 200);
  assert.equal(review.canTransfer, true);
  const sendBody = { ...input, requestId: randomUUID(), reviewToken: review.reviewToken };
  await db.user.update({ where: { id: fixture.senderId }, data: { active: false } });
  try { await request('sender deactivation between preview and confirm', '/actions/send-confirm', sendBody, senderToken, 401); }
  finally { await db.user.update({ where: { id: fixture.senderId }, data: { active: true } }); }
  assert.deepEqual(await state(), before, 'Rejected authorization never moves stock');
  const sent = await request('send confirmed batch', '/actions/send-confirm', sendBody, senderToken, 200);
  assert.equal(sent.transfer.status, 'in_transit'); assert.equal(sent.transfer.qtyTotal, 3);
  const shipped = await state();
  assert.equal(shipped.transfers.length - before.transfers.length, 1);
  assert.equal(shipped.moves.length - before.moves.length, 2);
  const sentAgain = await request('retry send without a second debit', '/actions/send-confirm', sendBody, senderToken, 200);
  assert.equal(sentAgain.alreadySaved, true); assert.deepEqual(await state(), shipped);
  const pending = await request('destination sees pending batch', '/actions/pending?storeId=' + fixture.toStoreId, null, receiverToken, 200, 'GET');
  assert.ok(pending.transfers.some(t => t.id === sent.transfer.id));
  await request('foreign seller cannot list destination consignments', '/actions/pending?storeId=' + fixture.toStoreId, null,
    tokenFor(fixture.outsiderId, { role: 'superadmin' }), 403, 'GET');
  const receipt = fixture.receiptInput, receiptBase = '/actions/' + sent.transfer.id;
  await request('source account cannot receive at destination', receiptBase + '/receive-preview', receipt, senderToken, 403);
  const incomplete = await request('receipt displays missing units', receiptBase + '/receive-preview', { ...receipt, scans: receipt.scans.slice(0, 1) }, receiverToken, 200);
  assert.equal(incomplete.canReceive, false); assert.ok(incomplete.blockers.length);
  await request('incomplete receipt cannot credit stock', receiptBase + '/receive-confirm',
    { ...receipt, scans: receipt.scans.slice(0, 1), requestId: randomUUID(), reviewToken: incomplete.reviewToken }, receiverToken, 409);
  assert.deepEqual(await state(), shipped);
  const receiptReview = await request('complete physical receipt review', receiptBase + '/receive-preview', receipt, receiverToken, 200);
  assert.equal(receiptReview.canReceive, true);
  const receiptBody = { ...receipt, requestId: randomUUID(), reviewToken: receiptReview.reviewToken };
  await db.user.update({ where: { id: fixture.receiverId }, data: { active: false } });
  try { await request('receiver deactivation before confirm', receiptBase + '/receive-confirm', receiptBody, receiverToken, 401); }
  finally { await db.user.update({ where: { id: fixture.receiverId }, data: { active: true } }); }
  const received = await request('complete receipt credits destination once', receiptBase + '/receive-confirm', receiptBody, receiverToken, 200);
  assert.equal(received.transfer.status, 'received');
  const after = await state();
  const receivedAgain = await request('retry receipt without duplicate credit', receiptBase + '/receive-confirm', receiptBody, receiverToken, 200);
  assert.equal(receivedAgain.alreadySaved, true); assert.deepEqual(await state(), after);
  assert.equal(after.moves.length - before.moves.length, 4);
  for (const key of ['rounds', 'bipes', 'captures', 'sizes', 'links']) assert.deepEqual(after[key], before[key], key + ': action modes do not alter inventory or purchased stock');
  for (const size of before.sizes) {
    const quantity = input.scans.filter(scan => scan.productSizeId === size.id).length;
    const balance = (s, storeId) => s.stocks.find(row => row.productSizeId === size.id && row.storeId === storeId)?.stock || 0;
    assert.equal(balance(shipped, fixture.fromStoreId), balance(before, fixture.fromStoreId) - quantity);
    assert.equal(balance(shipped, fixture.toStoreId), balance(before, fixture.toStoreId), 'Destination gets no credit before receipt');
    assert.equal(balance(after, fixture.fromStoreId), balance(shipped, fixture.fromStoreId));
    assert.equal(balance(after, fixture.toStoreId), balance(before, fixture.toStoreId) + quantity);
  }
  const finalPending = await request('received batch leaves pending list', '/actions/pending?storeId=' + fixture.toStoreId, null, receiverToken, 200, 'GET');
  assert.ok(!finalPending.transfers.some(t => t.id === sent.transfer.id));
  report.verification = { transferId: sent.transfer.id, units: 3, variants: 2, transfersCreated: 1, movementsCreated: 4,
    destinationCreditOnlyOnReceipt: true, retriesPreservedState: true, inventoryUnchanged: true, purchasedUnchanged: true, costFiscalFieldsAbsent: true };
  report.passed = true;
  console.log('PASS HTTP: ' + report.checks.length + ' local requests verify send/receive authorization, atomic movements, retries and inventory separation');
})().catch(error => { report.passed = false; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  report.finishedAt = new Date().toISOString();
  if (process.env.TRANSFER_TEST_REPORT) {
    fs.mkdirSync(path.dirname(process.env.TRANSFER_TEST_REPORT), { recursive: true });
    fs.writeFileSync(process.env.TRANSFER_TEST_REPORT, JSON.stringify(report, null, 2));
  }
  await db.$disconnect();
});
