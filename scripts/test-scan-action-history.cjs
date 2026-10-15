'use strict';

// Real PostgreSQL only, explicitly restricted to an isolated localhost database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID, randomInt } = require('node:crypto');
const url = process.env.TRANSFER_TEST_DATABASE_URL;
if (!url || !['postgres:', 'postgresql:'].includes(new URL(url).protocol) || !['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw Error('Use an isolated local TRANSFER_TEST_DATABASE_URL');
process.env.DATABASE_URL = url;
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url } } });
const history = require('../src/services/scanActionHistory');
const actions = require('../src/services/scanActionTransfers');
const report = { startedAt: new Date().toISOString(), checks: [] };
const test = async (name, run) => { const before = performance.now(); await run(); report.checks.push({ name, elapsedMs: Math.round(performance.now() - before), passed: true }); console.log('PASS: ' + name); };
function ean() { const s = '29' + String(randomInt(0, 10000000000)).padStart(10, '0'); return s + ((10 - [...s].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0) % 10) % 10); }
async function fixture() {
  const suffix = randomUUID(), stores = [];
  for (const code of ['A', 'B', 'C']) stores.push(await db.store.create({ data: { name: 'History test ' + code, code: 'HISTORY-' + code + suffix } }));
  const [from, to, other] = stores;
  const sender = await db.user.create({ data: { name: 'History sender', phone: 'HS' + suffix, pin: 'test', role: 'seller', storeId: from.id } });
  const receiver = await db.user.create({ data: { name: 'History receiver', phone: 'HR' + suffix, pin: 'test', role: 'seller', storeId: to.id } });
  const product = await db.product.create({ data: { name: 'Repeated socks', sku: 'HISTORY-' + suffix, brand: 'LUPO', price: 59.99, category: 'meias', sizes: { create: { size: 'M', barcode: ean(), stock: 400 } } }, include: { sizes: true } });
  const size = product.sizes[0];
  await db.storeStock.create({ data: { storeId: from.id, productSizeId: size.id, stock: 400 } });
  const scan = overrides => ({ clientScanId: randomUUID(), barcode: size.barcode, createdAt: new Date().toISOString(), product: { productSizeId: size.id, name: 'UNTRUSTED NAME', size: '99' }, confirmedSize: '', ...overrides });
  const lot = scans => ({ sessionId: randomUUID(), mode: 'transfer', fromStoreId: from.id, toStoreId: to.id, revision: 1, scans });
  return { from, to, other, sender, receiver, product, size, scan, lot };
}
const movementState = async f => ({
  sizes: await db.productSize.findMany({ where: { productId: f.product.id }, orderBy: { id: 'asc' } }),
  stocks: await db.storeStock.findMany({ where: { storeId: { in: [f.from.id, f.to.id] } }, orderBy: { id: 'asc' } }),
  moves: await db.storeStockMovement.findMany({ where: { storeId: { in: [f.from.id, f.to.id] } }, orderBy: { id: 'asc' } }),
  transfers: await db.stockTransfer.findMany({ where: { fromStoreId: f.from.id }, orderBy: { id: 'asc' } }),
});
const confirmScan = (f, s) => ({ clientScanId: s.clientScanId, barcode: s.barcode, productSizeId: f.size.id, confirmedSize: '', resolvedSize: f.size.size });
const recoveryAdmin = (role = 'admin') => db.user.create({ data: { name: 'Recovery administrator', phone: 'HA' + randomUUID(), pin: 'test', role } });

(async () => {
  await test('106 identical EANs remain 106 pieces; replay does not duplicate; snapshots are server sourced and sync never moves stock', async () => {
    const f = await fixture(), before = await movementState(f), input = f.lot(Array.from({ length: 106 }, () => f.scan()));
    const result = await history.sync(db, f.sender, input);
    assert.equal(result.lot.scanCount, 106); assert.equal(result.lot.recognizedCount, 106);
    const read = await history.detail(db, f.sender, input.sessionId);
    assert.ok(read.scans.every(s => s.product.name === f.product.name && s.product.size === 'M'));
    assert.equal((await history.sync(db, f.sender, input)).lot.scanCount, 106);
    const updated = { ...input, revision: 2, scans: [...input.scans, f.scan()] };
    const started = performance.now(), next = await history.sync(db, f.sender, updated);
    report.incremental107Ms = Math.round(performance.now() - started);
    assert.equal(next.lot.scanCount, 107); assert.deepEqual(await movementState(f), before);
    assert.equal(await db.scanActionRead.count({ where: { lotId: input.sessionId } }), 107);
    const late = await history.sync(db, f.sender, input); assert.equal(late.synced, false); assert.equal(late.lot.scanCount, 107);
  });

  await test('unknown scans, removed scans and barcode corrections are saved without inventing stock or losing original evidence', async () => {
    const f = await fixture(), before = await movementState(f), pending = f.scan({ barcode: 'UNREAD-123', product: null, error: 'Código não identificado' }), input = f.lot([pending]);
    assert.equal((await history.sync(db, f.sender, input)).lot.pendingCount, 1);
    const correction = { ...pending, barcode: f.size.barcode, product: { productSizeId: f.size.id }, error: '' };
    const fixed = await history.sync(db, f.sender, { ...input, revision: 2, scans: [correction] });
    assert.equal(fixed.lot.recognizedCount, 1);
    const row = await db.scanActionRead.findUnique({ where: { clientScanId: pending.clientScanId } });
    assert.equal(row.originalBarcode, 'UNREAD-123'); assert.equal(row.barcodeHistory.length, 1);
    const removed = await history.sync(db, f.sender, { ...input, revision: 3, scans: [{ ...correction, removed: true }] });
    assert.equal(removed.lot.scanCount, 0); assert.equal(removed.lot.removedCount, 1);
    assert.deepEqual(await movementState(f), before);
    await assert.rejects(() => history.sync(db, f.sender, { ...input, revision: 4, scans: [] }), e => e.status === 409);
  });

  await test('transfer and receipt journals are separate; matching shipment and receipt each move stock once', async () => {
    const f = await fixture(), scans = [f.scan(), f.scan()], input = f.lot(scans);
    await history.sync(db, f.sender, input);
    const send = { sessionId: input.sessionId, fromStoreId: f.from.id, toStoreId: f.to.id, scans: scans.map(s => confirmScan(f, s)) };
    const preview = await actions.sendPreview(db, f.sender, send); assert.equal(preview.canTransfer, true);
    const sent = await actions.sendConfirm(db, f.sender, { ...send, requestId: randomUUID(), reviewToken: preview.reviewToken });
    const afterSend = await movementState(f);
    assert.equal((await history.detail(db, f.sender, input.sessionId)).lot.status, 'confirmed');
    assert.equal((await history.sync(db, f.sender, { ...input, revision: 2, scans: [] })).synced, false);
    assert.deepEqual(await movementState(f), afterSend);
    const receiptScans = [f.scan(), f.scan()], receiptInput = { sessionId: randomUUID(), mode: 'receipt', fromStoreId: '', toStoreId: f.to.id, transferId: '', revision: 1, scans: receiptScans };
    const noRemittance = await history.sync(db, f.receiver, receiptInput); assert.equal(noRemittance.lot.scanCount, 2);
    await history.sync(db, f.receiver, { ...receiptInput, transferId: sent.transfer.id, revision: 2 });
    const receive = { sessionId: receiptInput.sessionId, storeId: f.to.id, scans: receiptScans.map(s => confirmScan(f, s)) };
    const receivePreview = await actions.receivePreview(db, f.receiver, sent.transfer.id, receive); assert.equal(receivePreview.canReceive, true);
    const request = { ...receive, requestId: randomUUID(), reviewToken: receivePreview.reviewToken };
    await actions.receiveConfirm(db, f.receiver, sent.transfer.id, request);
    assert.equal((await actions.receiveConfirm(db, f.receiver, sent.transfer.id, request)).alreadySaved, true);
    const sentHistory = await history.history(db, f.sender, { mode: 'transfer', storeId: f.from.id });
    const receivedHistory = await history.history(db, f.receiver, { mode: 'receipt', storeId: f.to.id });
    assert.equal(sentHistory.totals.scans, 2); assert.equal(sentHistory.totals.confirmedLots, 1); assert.equal(sentHistory.totals.confirmedScans, 2);
    assert.equal(receivedHistory.totals.scans, 2); assert.equal(receivedHistory.totals.confirmedLots, 1); assert.equal(receivedHistory.lots[0].fromStore.id, f.from.id);
    assert.equal(receivedHistory.lots[0].operator.id, f.receiver.id);
    const stock = await db.storeStock.findUnique({ where: { storeId_productSizeId: { storeId: f.to.id, productSizeId: f.size.id } } }); assert.equal(stock.stock, 2);
  });

  await test('changing receipt remittance preserves the same readings and audits the previous binding', async () => {
    const f = await fixture();
    async function shipment() {
      const scan = f.scan(), input = { sessionId: randomUUID(), fromStoreId: f.from.id, toStoreId: f.to.id, scans: [confirmScan(f, scan)] };
      const preview = await actions.sendPreview(db, f.sender, input);
      return (await actions.sendConfirm(db, f.sender, { ...input, requestId: randomUUID(), reviewToken: preview.reviewToken })).transfer;
    }
    const first = await shipment(), second = await shipment(), scan = f.scan();
    const input = { sessionId: randomUUID(), mode: 'receipt', toStoreId: f.to.id, fromStoreId: '', transferId: first.id, revision: 1, scans: [scan] };
    await history.sync(db, f.receiver, input);
    const before = await movementState(f);
    const switched = await history.sync(db, f.receiver, { ...input, transferId: second.id, revision: 2 });
    assert.equal(switched.lot.transferId, second.id); assert.equal(switched.lot.scanCount, 1);
    const saved = await db.scanActionLot.findUnique({ where: { sessionId: input.sessionId } });
    assert.equal(saved.transferHistory.length, 1); assert.equal(saved.transferHistory[0].from, first.id); assert.equal(saved.transferHistory[0].to, second.id);
    assert.deepEqual(await movementState(f), before);
    await assert.rejects(() => history.sync(db, f.receiver, { ...input, sessionId: randomUUID(), fromStoreId: f.other.id, transferId: '' }), e => e.status === 400);
  });

  await test('monthly rows include current confirmations of earlier scans without inflating current scanned quantity', async () => {
    const f = await fixture(), input = f.lot([f.scan({ createdAt: '2026-09-30T23:59:59-03:00' })]);
    await history.sync(db, f.sender, input);
    const send = { sessionId: input.sessionId, fromStoreId: f.from.id, toStoreId: f.to.id, scans: input.scans.map(s => confirmScan(f, s)) };
    const review = await actions.sendPreview(db, f.sender, send);
    await actions.sendConfirm(db, f.sender, { ...send, requestId: randomUUID(), reviewToken: review.reviewToken });
    const month = await history.history(db, f.sender, { mode: 'transfer', from: '2026-10-01', to: '2026-10-31', storeId: f.from.id });
    assert.equal(month.lots.length, 1); assert.equal(month.totals.scans, 0); assert.equal(month.totals.confirmedScans, 1);
    assert.equal(month.lots[0].scanCount, 0); assert.equal(month.lots[0].totalScanCount, 1);
    const previous = await history.history(db, f.sender, { mode: 'transfer', from: '2026-09-01', to: '2026-09-30', storeId: f.from.id });
    assert.equal(previous.totals.scans, 1); assert.equal(previous.totals.confirmedLots, 0);
  });

  await test('actual current permissions scope history and detail and prohibit adopting another operator lot', async () => {
    const f = await fixture(), input = f.lot([f.scan()]); await history.sync(db, f.sender, input);
    assert.equal((await history.detail(db, f.receiver, input.sessionId)).lot.scanCount, 1, 'Destination can review a transfer arriving there');
    await assert.rejects(() => history.sync(db, f.receiver, input), e => e.status === 403);
    await db.user.update({ where: { id: f.sender.id }, data: { storeId: f.other.id } });
    await assert.rejects(() => history.detail(db, { ...f.sender, role: 'superadmin' }, input.sessionId), e => e.status === 404);
    await assert.rejects(() => history.history(db, { ...f.sender, role: 'superadmin' }, { mode: 'transfer', storeId: f.from.id }), e => e.status === 403);
    await assert.rejects(() => history.sync(db, f.sender, input), e => e.status === 403);
  });

  await test('administrative recovery preserves repeated pieces, original operator and evidence with one atomic audit and no stock changes', async () => {
    const f = await fixture(), admin = await recoveryAdmin(), before = await movementState(f);
    const scans = Array.from({ length: 106 }, () => f.scan({ createdAt: '2026-10-02T15:30:00-03:00' }));
    scans.push(f.scan({ removed: true }), f.scan({ barcode: 'UNREAD-RECOVERY', product: null, error: 'Ainda pendente' }));
    const input = { ...f.lot(scans), originalOperatorId: f.sender.id };
    const [first, replay] = await Promise.all([history.recover(db, admin, input), history.recover(db, admin, input)]);
    assert.equal(first.lot.operator.id, f.sender.id); assert.equal(replay.lot.scanCount, 107);
    assert.equal(first.lot.recognizedCount, 106); assert.equal(first.lot.pendingCount, 1); assert.equal(first.lot.removedCount, 1);
    const rows = await db.scanActionRead.findMany({ where: { lotId: input.sessionId } });
    assert.equal(rows.length, 108); assert.equal(rows.filter(s => s.scannedAt.toISOString() === '2026-10-02T18:30:00.000Z').length, 106);
    const audits = await db.adminAction.findMany({ where: { action: 'scan_action_draft_recovered', metadata: { contains: input.sessionId } } });
    assert.equal(audits.length, 1); assert.equal(audits[0].adminId, admin.id);
    const audit = JSON.parse(audits[0].metadata); assert.equal(audit.originalOperatorId, f.sender.id); assert.equal(audit.stockChanged, false); assert.equal(audit.readCount, 108);
    await history.sync(db, f.sender, input);
    assert.deepEqual(await movementState(f), before);
  });

  await test('recovery rejects privilege claims, changed ownership, removed-read revival and conflicting saved evidence', async () => {
    const f = await fixture(), admin = await recoveryAdmin(), manager = await recoveryAdmin('manager'), read = f.scan({ removed: true }), input = { ...f.lot([read]), originalOperatorId: f.sender.id };
    for (const actor of [f.sender, { ...f.sender, role: 'superadmin' }, manager]) await assert.rejects(() => history.recover(db, actor, input), e => e.status === 403);
    await history.recover(db, admin, input);
    const before = await movementState(f), saved = await db.scanActionLot.findUnique({ where: { sessionId: input.sessionId }, include: { scans: true } });
    await assert.rejects(() => history.recover(db, admin, { ...input, revision: 2, scans: [{ ...read, removed: false }] }), e => e.status === 409);
    await assert.rejects(() => history.recover(db, admin, { ...input, revision: 2, scans: [{ ...read, barcode: 'OTHER' }] }), e => e.status === 409);
    await assert.rejects(() => history.recover(db, admin, { ...input, revision: 2, originalOperatorId: f.receiver.id }), e => e.status === 403);
    await assert.rejects(() => history.recover(db, admin, { ...input, revision: 2, toStoreId: f.other.id }), e => e.status === 409);
    await db.user.update({ where: { id: admin.id }, data: { role: 'seller' } });
    await assert.rejects(() => history.recover(db, { ...admin, role: 'superadmin' }, input), e => e.status === 403);
    await db.user.update({ where: { id: admin.id }, data: { role: 'admin' } });
    await db.user.update({ where: { id: f.sender.id }, data: { storeId: f.other.id } });
    await assert.rejects(() => history.recover(db, admin, input), e => e.status === 403);
    assert.deepEqual(await db.scanActionLot.findUnique({ where: { sessionId: input.sessionId }, include: { scans: true } }), saved);
    assert.deepEqual(await movementState(f), before);
  });

  await test('HTTP routes authenticate, scope drafts and return independent complete history exports', async () => {
    process.env.JWT_SECRET = 'local-test-' + randomUUID();
    const express = require('express'), jwt = require('jsonwebtoken'), app = express();
    app.use(express.json()); app.use('/api/scan-transfers', require('../src/routes/scanTransfers'));
    const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = 'http://127.0.0.1:' + server.address().port + '/api/scan-transfers';
    const f = await fixture(), token = jwt.sign({ userId: f.sender.id }, process.env.JWT_SECRET), body = f.lot([f.scan(), f.scan()]);
    async function request(route, expected, payload, bearer = token) {
      const res = await fetch(base + route, { method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      const value = await res.json(); assert.equal(res.status, expected, JSON.stringify(value)); assert.equal(res.headers.get('cache-control'), expected === 401 ? null : 'no-store');
      assert.ok(!/"(?:pin|costPrice|unitCost|payloadHash)"/.test(JSON.stringify(value))); return value;
    }
    try {
      await request('/actions/history?mode=transfer', 401, null, '');
      await request('/actions/drafts/sync', 401, body, '');
      await request('/actions/drafts/sync', 200, body);
      await request('/actions/history/' + body.sessionId, 200);
      await request('/actions/history?mode=transfer&storeId=' + f.other.id, 403);
      await request('/actions/drafts/sync', 403, body, jwt.sign({ userId: f.receiver.id, role: 'superadmin' }, process.env.JWT_SECRET));
      for (let n = 0; n < 3; n++) await history.sync(db, f.sender, f.lot([f.scan()]));
      const first = await request('/actions/history?mode=transfer&pageSize=1', 200);
      assert.equal(first.lots.length, 1); assert.equal(first.totals.lots, 4); assert.equal(first.totals.scans, 5);
      const exported = await request('/actions/history?mode=transfer&export=1&pageSize=1', 200);
      assert.equal(exported.lots.length, 4); assert.equal(exported.totals.scans, 5); assert.ok(exported.exportedAt);
      const receipt = await request('/actions/history?mode=receipt', 200); assert.equal(receipt.totals.scans, 0);
      const admin = await recoveryAdmin(), recovery = { ...f.lot([f.scan()]), originalOperatorId: f.sender.id };
      await request('/actions/drafts/recover', 401, recovery, '');
      await request('/actions/drafts/recover', 403, recovery);
      const restored = await request('/actions/drafts/recover', 200, recovery, jwt.sign({ userId: admin.id }, process.env.JWT_SECRET));
      assert.equal(restored.lot.operator.id, f.sender.id); assert.equal(restored.lot.scanCount, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await require('../src/middleware').prisma.$disconnect();
    }
  });

  report.finishedAt = new Date().toISOString();
  if (process.env.TRANSFER_TEST_REPORT) fs.writeFileSync(process.env.TRANSFER_TEST_REPORT, JSON.stringify(report, null, 2));
  console.log('PASS PostgreSQL: separate scan journals preserve repeated pieces, permissions and atomic stock confirmation.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
