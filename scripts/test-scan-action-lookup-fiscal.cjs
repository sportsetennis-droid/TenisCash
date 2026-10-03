'use strict';

// Real database coverage for receiving/transfer lookup, never a production target.
// All fixtures use a unique prefix and this script never connects using DATABASE_URL.
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const url = process.env.TRANSFER_TEST_DATABASE_URL;
const target = url && new URL(url);
if (!target || !['postgres:', 'postgresql:'].includes(target.protocol)
  || !['localhost', '127.0.0.1'].includes(target.hostname)
  || target.port !== '55329' || target.pathname !== '/bipar_transfer_20261002') {
  throw Error('Use isolated TRANSFER_TEST_DATABASE_URL on localhost:55329/bipar_transfer_20261002');
}
process.env.DATABASE_URL = url;
const { PrismaClient } = require('@prisma/client');
const service = require('../src/services/scanActionTransfers');
const { validGtin } = require('../src/services/scannerReference');
const db = new PrismaClient({ datasources: { db: { url } } });
const tests = [];
const began = new Date().toISOString();
let failure = null;

function ean() {
  const digits = '29' + String(randomInt(0, 10000000000)).padStart(10, '0');
  const sum = [...digits].reduce((n, d, index) => n + Number(d) * (index % 2 ? 3 : 1), 0);
  return digits + ((10 - sum % 10) % 10);
}
async function fixture() {
  const suffix = randomUUID(), from = await db.store.create({ data: { name: 'Fiscal lookup origin ' + suffix, code: 'LOOKUP-A-' + suffix } });
  const to = await db.store.create({ data: { name: 'Fiscal lookup destination ' + suffix, code: 'LOOKUP-B-' + suffix } });
  const actor = await db.user.create({ data: { name: 'Lookup receiving operator', phone: 'LOOKUP-' + suffix, pin: 'isolated-test', role: 'seller', storeId: to.id } });
  const f = { suffix, from, to, actor, productIds: [], documentIds: [] };
  f.product = await product(f, 'FISCAL LOOKUP SHOE', [{ size: '42', barcode: ean(), stock: 37, sizeConfirmedAt: new Date() }]);
  f.size = f.product.sizes[0];
  await db.storeStock.createMany({ data: [{ storeId: from.id, productSizeId: f.size.id, stock: 7 }, { storeId: to.id, productSizeId: f.size.id, stock: 3 }] });
  f.round = await db.stocktakeRound.create({ data: { storeId: to.id, name: 'Inventory unaffected by lookup', baseline: [{ productSizeId: f.size.id, stock: 3 }] } });
  f.bipe = await db.stocktakeBipe.create({ data: { storeId: to.id, roundId: f.round.id, scanKey: f.round.id + ':' + randomUUID(),
    barcode: f.size.barcode, productId: f.product.id, productSizeId: f.size.id, productName: f.product.name, productSize: f.size.size,
    productBrand: f.product.brand, sellerId: actor.id, found: true, applied: false } });
  await db.productCapture.create({ data: { storeId: to.id, roundId: f.round.id, scanKey: f.bipe.scanKey, bipeId: f.bipe.id,
    barcode: f.size.barcode, status: 'vinculado', matchedProductId: f.product.id, photo: 'data:image/webp;base64,isolated-test' } });
  return f;
}
async function product(f, label, sizes = []) {
  const p = await db.product.create({ data: { name: label + ' ' + randomUUID(), sku: 'FISCAL-LOOKUP-' + randomUUID(),
    brand: 'TEST', category: 'tenis', price: 149, costPrice: 41, sizes: { create: sizes } }, include: { sizes: { orderBy: { size: 'asc' } } } });
  f.productIds.push(p.id); return p;
}
async function fiscal(f, p, barcode, description = p.name + ' 40', options = {}) {
  const doc = await db.xmlFiscalDocument.create({ data: { docType: options.docType || 'entrada', status: 'matched',
    number: 'LOOKUP-' + randomUUID(), issuerName: 'Isolated fiscal supplier', totalValue: 123,
    rawXmlUrl: 'data:application/xml,<isolated-test/>', items: { create: { productId: options.unlinked ? null : p.id,
      supplierCode: 'TEST-REF-' + randomUUID(), description, ean: barcode, quantity: 5, unitValue: 24.6, totalValue: 123, matchStatus: 'matched' } } }, include: { items: true } });
  f.documentIds.push(doc.id); return doc;
}
async function shipment(f, chosen = f.size, p = f.product) {
  // Creates only an isolated manifest; the lookup under test must not move stock.
  const code = 1000000000 + randomInt(0, 1000000000);
  return db.stockTransfer.create({ data: { code, fromStoreId: f.from.id, toStoreId: f.to.id, createdById: f.actor.id,
    status: 'in_transit', qtyTotal: 1, itemsCount: 1, note: JSON.stringify({ source: service.SOURCE, sessionId: randomUUID() }),
    items: { create: { productSizeId: chosen.id, quantity: 1, productName: p.name, brand: p.brand, size: chosen.size, barcode: chosen.barcode } } } });
}
async function snapshot(f) {
  const storeIds = [f.from.id, f.to.id];
  const [products, sizes, stocks, documents, rounds, bipes, captures, movements, transfers, inventoryLinks] = await Promise.all([
    db.product.findMany({ where: { id: { in: f.productIds } }, orderBy: { id: 'asc' } }),
    db.productSize.findMany({ where: { productId: { in: f.productIds } }, orderBy: { id: 'asc' } }),
    db.storeStock.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.xmlFiscalDocument.findMany({ where: { id: { in: f.documentIds } }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    db.stocktakeRound.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.stocktakeBipe.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.productCapture.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.storeStockMovement.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
    db.stockTransfer.findMany({ where: { fromStoreId: f.from.id }, include: { items: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    db.stocktakeTransferScan.findMany({ where: { storeId: { in: storeIds } }, orderBy: { id: 'asc' } }),
  ]);
  return { products, sizes, stocks, documents, rounds, bipes, captures, movements, transfers, inventoryLinks };
}
function operationalUnchanged(before, after) {
  for (const field of ['stocks', 'documents', 'rounds', 'bipes', 'captures', 'movements', 'transfers', 'inventoryLinks']) {
    assert.deepEqual(after[field], before[field], field + ' must not change during product lookup');
  }
  assert.equal(after.products.length, before.products.length, 'Lookup must not invent a product');
  for (const prior of before.sizes) assert.equal(after.sizes.find(s => s.id === prior.id)?.stock, prior.stock, 'Purchased stock must remain unchanged');
}
function publicOnly(result) {
  assert.equal(result.requiresSizeConfirmation, true, 'This piece still requires explicit size confirmation');
  assert.ok(!/"(?:costPrice|unitCost|rawXmlUrl|pin|aiContext)"/.test(JSON.stringify(result)), 'Do not expose internal or fiscal evidence fields');
}
async function rejectedUnchanged(f, input, message, expectedStatus = 404, actor = f.actor) {
  const before = await snapshot(f);
  await assert.rejects(() => service.lookup(db, actor, input), error => error.status === expectedStatus && (!message || message.test(error.message)));
  assert.deepEqual(await snapshot(f), before, 'Rejected lookup cannot write catalog, stock, XML or count records');
}
async function test(name, run) {
  const started = Date.now();
  try { await run(); tests.push({ name, passed: true, elapsedMs: Date.now() - started }); console.log('PASS: ' + name); }
  catch (error) { tests.push({ name, passed: false, elapsedMs: Date.now() - started, error: error.message }); throw error; }
}

(async () => {
  await test('exact incoming invoice creates the missing literal variant with zero purchased stock and preserves all operational records', async () => {
    const f = await fixture(), barcode = ean(), doc = await fiscal(f, f.product, barcode), before = await snapshot(f);
    const result = await service.lookup(db, f.actor, { barcode }); publicOnly(result);
    assert.equal(result.product.size, '40'); assert.equal(result.product.barcode, barcode);
    const after = await snapshot(f), added = after.sizes.filter(s => !before.sizes.some(old => old.id === s.id));
    assert.equal(added.length, 1); assert.equal(added[0].id, result.product.productSizeId);
    assert.equal(added[0].stock, 0); assert.equal(added[0].productId, f.product.id); assert.ok(added[0].sizeConfirmedAt);
    assert.deepEqual(after.sizes.find(s => s.id === f.size.id), f.size, 'Other size and barcode remain intact');
    const evidence = after.products.find(p => p.id === f.product.id).aiContext.scannerReferenceEvidence;
    assert.equal(evidence.fiscalItemId, doc.items[0].id); assert.equal(evidence.barcode, barcode); assert.equal(evidence.size, '40');
    operationalUnchanged(before, after);
    for (const code of [barcode, '0' + barcode, barcode]) {
      const again = await service.lookup(db, f.actor, { barcode: code }); publicOnly(again);
      assert.equal(again.product.productSizeId, result.product.productSizeId);
      assert.deepEqual(await snapshot(f), after, 'Repeated normalized GTIN lookup is idempotent');
    }
  });

  await test('existing correctly linked barcode bypasses fiscal learning and still requires the physical piece size', async () => {
    const f = await fixture(); await fiscal(f, f.product, f.size.barcode, 'UNRELATED FISCAL DESCRIPTION 38');
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: f.size.barcode });
    publicOnly(result); assert.equal(result.product.productSizeId, f.size.id); assert.equal(result.product.size, '42');
    assert.deepEqual(await snapshot(f), before);
  });

  await test('an existing literal variant receives its missing barcode without increasing purchased or store stock', async () => {
    const f = await fixture(), barcode = ean();
    const existing = await db.productSize.create({ data: { productId: f.product.id, size: '40', stock: 19 } });
    await fiscal(f, f.product, barcode); const before = await snapshot(f);
    const result = await service.lookup(db, f.actor, { barcode }), after = await snapshot(f); publicOnly(result);
    assert.equal(result.product.productSizeId, existing.id); assert.equal(after.sizes.length, before.sizes.length);
    const learned = after.sizes.find(s => s.id === existing.id); assert.equal(learned.stock, 19); assert.equal(learned.barcode, barcode);
    operationalUnchanged(before, after);
  });

  await test('missing literal size, size range and incompatible model descriptions remain pending without catalog writes', async () => {
    for (const kind of ['no-size', 'range', 'different-model']) {
      const f = await fixture(), barcode = ean();
      const description = kind === 'no-size' ? f.product.name : kind === 'range' ? f.product.name + ' 38/43' : 'COMPLETELY DIFFERENT PRODUCT 40';
      await fiscal(f, f.product, barcode, description);
      await rejectedUnchanged(f, { barcode }, /tamanho/);
    }
  });

  await test('conflicting fiscal products or literal sizes and duplicate barcode owners cannot be resolved arbitrarily', async () => {
    for (const conflict of ['products', 'sizes', 'owners']) {
      const f = await fixture(), barcode = ean();
      await fiscal(f, f.product, barcode);
      if (conflict === 'sizes') await fiscal(f, f.product, barcode, f.product.name + ' 41');
      else {
        const other = await product(f, 'ANOTHER FISCAL SHOE', conflict === 'owners' ? [{ size: '40', barcode, stock: 4 }] : []);
        if (conflict === 'products') await fiscal(f, other, barcode);
        else await db.productSize.create({ data: { productId: f.product.id, size: '40', barcode, stock: 9 } });
      }
      await rejectedUnchanged(f, { barcode }, conflict === 'owners' ? /mais de uma variante/ : /divergentes/, conflict === 'owners' ? 409 : 404);
    }
  });

  await test('malicious product, size and OCR overrides cannot create variants without fiscal evidence or override the exact fiscal target', async () => {
    const f = await fixture(), barcode = ean(), other = await product(f, 'FORGED TARGET', [{ size: '41', barcode: ean(), stock: 8 }]);
    const malicious = { barcode, productId: other.id, confirmedProductId: other.id, productSizeId: other.sizes[0].id, size: '41', confirmedSize: '41',
      read: { sku: other.sku, marca: other.brand, tamanho: 'BR 41' }, ocrText: other.sku + '\nBR 41', scans: [{ barcode, productSizeId: other.sizes[0].id, confirmedSize: '41' }] };
    await rejectedUnchanged(f, malicious, /não identificado/);
    await fiscal(f, f.product, barcode); const before = await snapshot(f);
    const result = await service.lookup(db, f.actor, malicious), after = await snapshot(f); publicOnly(result);
    const actual = after.sizes.find(s => s.id === result.product.productSizeId);
    assert.equal(actual.productId, f.product.id); assert.equal(actual.size, '40'); assert.equal(actual.stock, 0);
    assert.deepEqual(after.products.find(p => p.id === other.id), before.products.find(p => p.id === other.id));
    assert.deepEqual(after.sizes.filter(s => s.productId === other.id), before.sizes.filter(s => s.productId === other.id));
    operationalUnchanged(before, after);
  });

  await test('invalid checksum, non-purchase invoices, unlinked fiscal items and inactive products do not authorize learning', async () => {
    for (const kind of ['invalid-checksum', 'transfer-invoice', 'unlinked-item', 'inactive-product']) {
      const f = await fixture(); let barcode = ean();
      if (kind === 'invalid-checksum') { barcode = barcode.slice(0, -1) + ((Number(barcode.at(-1)) + 1) % 10); assert.equal(validGtin(barcode), false); }
      await fiscal(f, f.product, barcode, f.product.name + ' 40', { docType: kind === 'transfer-invoice' ? 'transferencia' : 'entrada', unlinked: kind === 'unlinked-item' });
      if (kind === 'inactive-product') await db.product.update({ where: { id: f.product.id }, data: { active: false } });
      await rejectedUnchanged(f, { barcode }, /não identificado/);
    }
  });

  await test('a fiscal barcode for an unrelated product or size cannot mutate the catalog through a selected shipment', async () => {
    for (const kind of ['other-size', 'other-product']) {
      const f = await fixture(), sent = await shipment(f), barcode = ean();
      const p = kind === 'other-product' ? await product(f, 'UNRELATED TO MANIFEST') : f.product;
      await fiscal(f, p, barcode, p.name + ' 40');
      await rejectedUnchanged(f, { barcode, transferId: sent.id, storeId: f.to.id }, /não pertence/, 409);
    }
  });

  await test('a selected shipment can recover the exact sent variant barcode without receiving the shipment or touching stock', async () => {
    const f = await fixture(), barcode = ean(), existing = await db.productSize.create({ data: { productId: f.product.id, size: '40', stock: 11 } });
    await fiscal(f, f.product, barcode); const sent = await shipment(f, existing), before = await snapshot(f);
    const result = await service.lookup(db, f.actor, { barcode, transferId: sent.id, storeId: f.to.id }), after = await snapshot(f); publicOnly(result);
    assert.equal(result.product.productSizeId, existing.id); assert.equal(after.transfers[0].status, 'in_transit');
    assert.equal(after.transfers[0].receivedAt, null); operationalUnchanged(before, after);
  });

  await test('an existing barcode on the same fiscal size is never silently replaced by another GTIN', async () => {
    const f = await fixture(), barcode = ean(), existing = await db.productSize.create({ data: { productId: f.product.id, size: '40', barcode: ean(), stock: 2 } });
    await fiscal(f, f.product, barcode);
    await rejectedUnchanged(f, { barcode, confirmedProductId: f.product.id, size: '40' }, /divergentes/);
    assert.equal((await db.productSize.findUnique({ where: { id: existing.id } })).barcode, existing.barcode);
  });

  await test('missing or disabled operators cannot trigger fiscal barcode learning', async () => {
    const f = await fixture(), barcode = ean(); await fiscal(f, f.product, barcode);
    await rejectedUnchanged(f, { barcode }, /conta pessoal/, 403, {});
    await db.user.update({ where: { id: f.actor.id }, data: { active: false } });
    await rejectedUnchanged(f, { barcode }, /conta pessoal/, 403, { ...f.actor, role: 'superadmin', active: true });
  });
  console.log('PASS PostgreSQL: ' + tests.length + ' fiscal action lookup groups; no production operations.');
})().catch(error => { failure = error.stack || String(error); console.error(failure); process.exitCode = 1; }).finally(async () => {
  if (process.env.TRANSFER_TEST_REPORT) {
    const report = path.resolve(process.env.TRANSFER_TEST_REPORT); fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ began, ended: new Date().toISOString(), passed: !process.exitCode,
      database: { host: target.hostname, port: target.port, name: target.pathname.slice(1) }, tests, failure }, null, 2));
  }
  await db.$disconnect();
});
