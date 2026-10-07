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
const { validGtin, learnScannerBarcode } = require('../src/services/scannerReference');
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
      supplierCode: options.supplierCode || 'TEST-REF-' + randomUUID(), description, ean: barcode, quantity: 5, unitValue: 24.6, totalValue: 123, matchStatus: 'matched' } } }, include: { items: true } });
  f.documentIds.push(doc.id); return doc;
}
function officialVariant(barcode, supplierCode, size = 'P') {
  // Synthetic identifiers with the same documented shape as the reviewed Lupo
  // records. The lookup consumes saved evidence; these tests make no HTTP calls.
  return { ean: barcode, supplierCode, size, color: 'Coral', colorLiteralWithCode: 'Coral - 0510', status: 'confirmed_official',
    source: { ean: barcode, type: 'official_exact_ean_and_full_supplier_sku', fullSKU: supplierCode,
      sourceUrl: 'https://www.lsport.com.br/products/manguito-uv-unissex.json', consultedAt: '2026-09-25T11:56:17.733828Z',
      sizeLiteral: size, colorLiteral: 'Coral', colorLiteralWithCode: 'Coral - 0510',
      corroboration: { at: '2026-09-25T11:56:54.8903821Z', ean: barcode, fullSKU: supplierCode,
        sourceUrl: 'https://luposport.vtexcommercestable.com.br/api/catalog_system/pub/products/search?fq=alternateIds_Ean:' + barcode,
        sizeLiteral: [size], colorLiteral: ['Coral - 0510'] } } };
}
async function saveOfficialVariants(p, variants) {
  const current = await db.product.findUnique({ where: { id: p.id } });
  return db.product.update({ where: { id: p.id }, data: { aiContext: { ...(current.aiContext || {}),
    invoicePricing20260925: { preservedReviewNote: 'isolated documented source fixture', variants } } } });
}
async function documentedFiscal(f, size = 'P', options = {}) {
  const p = options.product || f.product, barcode = options.barcode || ean();
  const supplierCode = options.supplierCode || ('15002-001' + String(randomInt(0, 10000000)).padStart(7, '0'));
  const variant = officialVariant(barcode, supplierCode, size);
  await db.product.update({ where: { id: p.id }, data: { brand: 'LUPO' } });
  await saveOfficialVariants(p, [variant]);
  const doc = await fiscal(f, p, barcode, options.description || p.name, { ...options, supplierCode });
  return { p, barcode, supplierCode, variant, doc };
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
  assert.equal(result.requiresSizeConfirmation, /adidas/i.test(result.product.brand), 'Only Adidas requires the separate physical box size check');
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

  await test('existing correctly linked barcode bypasses fiscal learning and redundant manual size entry', async () => {
    const f = await fixture(); await fiscal(f, f.product, f.size.barcode, 'UNRELATED FISCAL DESCRIPTION 38');
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: f.size.barcode });
    publicOnly(result); assert.equal(result.product.productSizeId, f.size.id); assert.equal(result.product.size, '42');
    assert.deepEqual(await snapshot(f), before);
  });

  await test('Adidas still requires the physical BR check even with a confirmed exact barcode', async () => {
    const f = await fixture();
    await db.product.update({ where: { id: f.product.id }, data: { brand: 'Adidas' } });
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: f.size.barcode });
    publicOnly(result); assert.equal(result.requiresSizeConfirmation, true);
    assert.equal(result.product.productSizeId, f.size.id);
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

  await test('documented exact official EAN and full supplier SKU recover P and 37 a 40 without an invoice size suffix', async () => {
    for (const size of ['P', '37 a 40']) {
      const f = await fixture(), evidence = await documentedFiscal(f, size);
      if (size === '37 a 40') {
        evidence.variant.source.sizeLiteral = 'M (Calçados 37 a 40)';
        evidence.variant.source.corroboration.sizeLiteral = ['M (Calçados 37 a 40)'];
        await saveOfficialVariants(f.product, [evidence.variant]);
      }
      const before = await snapshot(f);
      const result = await service.lookup(db, f.actor, { barcode: evidence.barcode }), after = await snapshot(f); publicOnly(result);
      assert.equal(result.product.size, size); assert.equal(result.product.barcode, evidence.barcode);
      const added = after.sizes.filter(s => !before.sizes.some(old => old.id === s.id));
      assert.equal(added.length, 1); assert.equal(added[0].id, result.product.productSizeId);
      assert.equal(added[0].productId, f.product.id); assert.equal(added[0].stock, 0); assert.ok(added[0].sizeConfirmedAt);
      assert.deepEqual(after.sizes.find(s => s.id === f.size.id), f.size, 'Previously linked sizes remain intact');
      const priorContext = before.products.find(p => p.id === f.product.id).aiContext;
      const context = after.products.find(p => p.id === f.product.id).aiContext;
      assert.deepEqual(context.invoicePricing20260925, priorContext.invoicePricing20260925, 'Preserve the reviewed source record');
      assert.equal(context.scannerReferenceEvidence.fiscalItemId, evidence.doc.items[0].id);
      assert.equal(context.scannerReferenceEvidence.barcode, evidence.barcode); assert.equal(context.scannerReferenceEvidence.size, size);
      operationalUnchanged(before, after);
      for (const code of [evidence.barcode, '0' + evidence.barcode]) {
        const again = await service.lookup(db, f.actor, { barcode: code }); publicOnly(again);
        assert.equal(again.product.productSizeId, result.product.productSizeId);
        assert.deepEqual(await snapshot(f), after, 'Reviewed evidence lookup is idempotent across normalized GTINs');
      }
    }
  });

  await test('documented evidence follows the explicit canonical product link and preserves the legacy invoice item', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f);
    const legacy = await product(f, 'LEGACY FISCAL LUPO');
    await db.product.update({ where: { id: legacy.id }, data: { active: false, aiContext: { consolidatedInto: f.product.id } } });
    await db.xmlFiscalItem.update({ where: { id: evidence.doc.items[0].id }, data: { productId: legacy.id } });
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: evidence.barcode }), after = await snapshot(f);
    publicOnly(result); assert.equal(result.product.size, 'P');
    assert.equal(after.sizes.find(s => s.id === result.product.productSizeId).productId, f.product.id);
    assert.deepEqual(after.products.find(p => p.id === legacy.id), before.products.find(p => p.id === legacy.id));
    operationalUnchanged(before, after);
  });

  await test('documented evidence cannot be borrowed from another EAN, SKU, product, status or uncorroborated source', async () => {
    const cases = [
      ['variant-ean', v => { v.ean = ean(); }],
      ['variant-sku', v => { v.supplierCode += '9'; }],
      ['unreviewed-status', v => { v.status = 'pending'; }],
      ['source-type', v => { v.source.type = 'supplier_reference_guess'; }],
      ['source-ean', v => { v.source.ean = ean(); }],
      ['source-sku', v => { v.source.fullSKU += '9'; }],
      ['source-model-reference', v => { v.source.modelReference = '99999-999'; }],
      ['truncated-model-reference', v => { v.source.modelReference = '15002'; }],
      ['source-size', v => { v.source.sizeLiteral = 'M'; }],
      ['source-color', v => { v.source.colorLiteral = 'Preto'; }],
      ['source-url', v => { v.source.sourceUrl = 'https://unrelated.example/products/manguito.json'; }],
      ['source-date', v => { v.source.consultedAt = 'not-a-date'; }],
      ['shopify-without-corroboration', v => { delete v.source.corroboration; }],
      ['corroboration-ean', v => { v.source.corroboration.ean = ean(); }],
      ['corroboration-sku', v => { v.source.corroboration.fullSKU += '9'; }],
      ['corroboration-size', v => { v.source.corroboration.sizeLiteral = ['M']; }],
      ['ambiguous-corroboration-size', v => { v.source.corroboration.sizeLiteral = ['P', 'M']; }],
      ['corroboration-color', v => { v.source.corroboration.colorLiteral = ['Preto - 9999']; }],
      ['corroboration-url', v => { v.source.corroboration.sourceUrl = 'https://unrelated.example/products'; }],
      ['corroboration-date', v => { v.source.corroboration.at = 'not-a-date'; }],
    ];
    for (const [kind, mutate] of cases) {
      const f = await fixture(), evidence = await documentedFiscal(f); mutate(evidence.variant);
      await saveOfficialVariants(f.product, [evidence.variant]);
      try { await rejectedUnchanged(f, { barcode: evidence.barcode }); }
      catch (error) { error.message = kind + ': ' + error.message; throw error; }
    }
    const f = await fixture(), evidence = await documentedFiscal(f), unrelated = await product(f, 'UNRELATED REVIEWED PRODUCT');
    await saveOfficialVariants(unrelated, [evidence.variant]); await saveOfficialVariants(f.product, []);
    await rejectedUnchanged(f, { barcode: evidence.barcode }, /tamanho/);
    const modelOnly = await fixture(), modelEvidence = await documentedFiscal(modelOnly);
    modelEvidence.variant.supplierCode = modelEvidence.variant.source.fullSKU = modelEvidence.variant.source.corroboration.fullSKU = '03350';
    await saveOfficialVariants(modelOnly.product, [modelEvidence.variant]);
    await db.xmlFiscalItem.update({ where: { id: modelEvidence.doc.items[0].id }, data: { supplierCode: '03350' } });
    await rejectedUnchanged(modelOnly, { barcode: modelEvidence.barcode });
  });

  await test('literal fiscal size and conflicting official records block resolution before any catalog write', async () => {
    for (const kind of ['fiscal-size', 'official-size', 'official-product', 'invoice-sku']) {
      const f = await fixture(), evidence = await documentedFiscal(f);
      if (kind === 'fiscal-size') {
        await db.xmlFiscalItem.update({ where: { id: evidence.doc.items[0].id }, data: { description: f.product.name + ' M' } });
      } else if (kind === 'official-size') {
        await saveOfficialVariants(f.product, [evidence.variant, officialVariant(evidence.barcode, evidence.supplierCode, 'M')]);
      } else if (kind === 'official-product') {
        const other = await product(f, 'ANOTHER OFFICIAL PRODUCT');
        await documentedFiscal(f, 'P', { product: other, barcode: evidence.barcode, supplierCode: evidence.supplierCode });
      } else {
        await fiscal(f, f.product, evidence.barcode, f.product.name, { supplierCode: evidence.supplierCode + '9' });
      }
      await rejectedUnchanged(f, { barcode: evidence.barcode });
    }
  });

  await test('a manual product override cannot transfer official fiscal evidence to a different product', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f), unrelated = await product(f, 'UNRELATED MANUAL OVERRIDE');
    const before = await snapshot(f);
    const result = await learnScannerBarcode(db, { barcode: evidence.barcode, confirmedProductId: unrelated.id });
    assert.match(result.reason, /conflict/, 'A product override cannot inherit another canonical product official evidence');
    assert.deepEqual(await snapshot(f), before, 'Rejected manual override must not create or learn any variant');
  });

  await test('a single exact official source resolves renamed invoice products and documented size ranges', async () => {
    const f = await fixture();
    f.product = await db.product.update({ where: { id: f.product.id }, data: { name: 'Meia Lupo AU Dry Fit ' + f.suffix } });
    const evidence = await documentedFiscal(f, '33 a 36', { description: 'Meia LSport AU Inv.Rio Movimento' });
    evidence.variant.source.sourceUrl = evidence.variant.source.corroboration.sourceUrl;
    delete evidence.variant.source.corroboration;
    await saveOfficialVariants(f.product, [evidence.variant]);
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: evidence.barcode }), after = await snapshot(f);
    publicOnly(result); assert.equal(result.product.size, '33 a 36'); assert.equal(result.product.name, f.product.name);
    const added = after.sizes.filter(s => !before.sizes.some(old => old.id === s.id));
    assert.equal(added.length, 1); assert.equal(added[0].stock, 0); assert.equal(added[0].productId, f.product.id);
    operationalUnchanged(before, after);
  });

  await test('an invoice range is compared as a complete literal instead of its final number', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f, '37 a 40', { description: 'RENAMED SOCK MODEL 37 a 40' });
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: evidence.barcode }), after = await snapshot(f);
    publicOnly(result); assert.equal(result.product.size, '37 a 40'); operationalUnchanged(before, after);
    const conflict = await fixture(), otherEvidence = await documentedFiscal(conflict, '33 a 36', { description: 'RENAMED SOCK MODEL 37 a 40' });
    await rejectedUnchanged(conflict, { barcode: otherEvidence.barcode }, /divergentes/);
    const wrappedConflict = await fixture(), wrappedEvidence = await documentedFiscal(wrappedConflict, '33 a 36');
    wrappedEvidence.variant.source.sizeLiteral = 'M (Calçados 37 a 40)';
    wrappedEvidence.variant.source.corroboration.sizeLiteral = ['M (Calçados 37 a 40)'];
    await saveOfficialVariants(wrappedConflict.product, [wrappedEvidence.variant]);
    await rejectedUnchanged(wrappedConflict, { barcode: wrappedEvidence.barcode }, /divergentes/);
  });

  await test('official review does not authorize a transfer invoice, unlinked item or inactive product', async () => {
    for (const kind of ['transfer-invoice', 'unlinked-item', 'inactive-product']) {
      const f = await fixture(), evidence = await documentedFiscal(f, 'P', { docType: kind === 'transfer-invoice' ? 'transferencia' : 'entrada',
        unlinked: kind === 'unlinked-item' });
      if (kind === 'inactive-product') await db.product.update({ where: { id: f.product.id }, data: { active: false } });
      await rejectedUnchanged(f, { barcode: evidence.barcode });
    }
  });

  await test('official evidence never silently aliases another GTIN already occupying the documented size', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f);
    const occupied = await db.productSize.create({ data: { productId: f.product.id, size: 'P', barcode: ean(), stock: 23, sizeConfirmedAt: new Date() } });
    await rejectedUnchanged(f, { barcode: evidence.barcode, confirmedProductId: f.product.id, size: 'P', read: { sku: f.product.sku, tamanho: 'P' } }, /divergentes/);
    const before = await snapshot(f);
    const learned = await learnScannerBarcode(db, { barcode: evidence.barcode, size: 'P', read: { sku: f.product.sku, marca: 'LUPO' } });
    assert.equal(learned.reason, 'size_barcode_conflict', 'Even an exact OCR reference cannot silently alias a different size GTIN');
    assert.deepEqual(await snapshot(f), before, 'Direct scanner learning also preserves the occupied size and evidence');
    const p = await db.product.findUnique({ where: { id: f.product.id } });
    assert.equal(p.aiContext.scannerBarcodeAliases?.[evidence.barcode], undefined);
    assert.deepEqual(await db.productSize.findUnique({ where: { id: occupied.id } }), occupied);
  });

  await test('an occupied variant accepts an alias only when both exact GTINs have matching official and incoming invoice evidence', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f), oldBarcode = ean();
    const occupied = await db.productSize.create({ data: { productId: f.product.id, size: 'P', barcode: oldBarcode, stock: 23, sizeConfirmedAt: new Date() } });
    await saveOfficialVariants(f.product, [evidence.variant, officialVariant(oldBarcode, evidence.supplierCode, 'P')]);
    await fiscal(f, f.product, oldBarcode, f.product.name, { supplierCode: evidence.supplierCode });
    const before = await snapshot(f), result = await service.lookup(db, f.actor, { barcode: evidence.barcode }), after = await snapshot(f);
    publicOnly(result); assert.equal(result.product.productSizeId, occupied.id); assert.equal(result.product.barcode, evidence.barcode);
    assert.deepEqual(after.sizes, before.sizes, 'The primary GTIN and purchased stock remain intact');
    const context = after.products.find(p => p.id === f.product.id).aiContext;
    assert.equal(context.scannerBarcodeAliases[evidence.barcode].size, 'P');
    assert.deepEqual(context.invoicePricing20260925, before.products.find(p => p.id === f.product.id).aiContext.invoicePricing20260925);
    operationalUnchanged(before, after);
    for (const barcode of [evidence.barcode, '0' + evidence.barcode, oldBarcode]) {
      const again = await service.lookup(db, f.actor, { barcode }); publicOnly(again);
      assert.equal(again.product.productSizeId, occupied.id);
      assert.deepEqual(await snapshot(f), after, 'Both documented identifiers remain idempotent');
    }
  });

  await test('alias learning refuses incomplete old-GTIN proof, incompatible color and different documented size', async () => {
    for (const kind of ['no-old-invoice', 'no-old-official', 'different-color', 'different-size']) {
      const f = await fixture(), evidence = await documentedFiscal(f), oldBarcode = ean();
      await db.productSize.create({ data: { productId: f.product.id, size: 'P', barcode: oldBarcode, stock: 23, sizeConfirmedAt: new Date() } });
      const oldEvidence = officialVariant(oldBarcode, evidence.supplierCode, kind === 'different-size' ? 'M' : 'P');
      if (kind === 'different-color') {
        oldEvidence.color = oldEvidence.source.colorLiteral = 'Preto';
        oldEvidence.colorLiteralWithCode = oldEvidence.source.colorLiteralWithCode = 'Preto - 9999';
        oldEvidence.source.corroboration.colorLiteral = ['Preto - 9999'];
      }
      if (kind !== 'no-old-official') await saveOfficialVariants(f.product, [evidence.variant, oldEvidence]);
      if (kind !== 'no-old-invoice') await fiscal(f, f.product, oldBarcode, f.product.name, { supplierCode: evidence.supplierCode });
      await rejectedUnchanged(f, { barcode: evidence.barcode }, /divergentes/);
    }
  });

  await test('incompatible selected shipments reject official fallback before learning a barcode or creating its size', async () => {
    for (const kind of ['other-size', 'other-product']) {
      const f = await fixture(), sent = await shipment(f);
      const p = kind === 'other-product' ? await product(f, 'UNRELATED OFFICIAL MANIFEST ITEM') : f.product;
      const evidence = await documentedFiscal(f, 'P', { product: p });
      await rejectedUnchanged(f, { barcode: evidence.barcode, transferId: sent.id, storeId: f.to.id }, /não pertence/, 409);
    }
  });

  await test('a compatible shipment recovers its existing documented variant while retaining stock and pending receipt', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f, '37 a 40');
    const existing = await db.productSize.create({ data: { productId: f.product.id, size: '37 a 40', stock: 17 } });
    const sent = await shipment(f, existing), before = await snapshot(f);
    const result = await service.lookup(db, f.actor, { barcode: evidence.barcode, transferId: sent.id, storeId: f.to.id }), after = await snapshot(f);
    publicOnly(result); assert.equal(result.product.productSizeId, existing.id); assert.equal(result.product.size, '37 a 40');
    assert.equal(after.sizes.length, before.sizes.length); assert.equal(after.sizes.find(s => s.id === existing.id).stock, 17);
    assert.equal(after.transfers[0].status, 'in_transit'); assert.equal(after.transfers[0].receivedAt, null);
    operationalUnchanged(before, after);
  });

  await test('concurrent lookups of normalized officially documented GTINs return one variant and leave operations untouched', async () => {
    const f = await fixture(), evidence = await documentedFiscal(f, 'P'), before = await snapshot(f);
    const attempts = await Promise.allSettled([evidence.barcode, '0' + evidence.barcode, evidence.barcode, '0' + evidence.barcode]
      .map(barcode => service.lookup(db, f.actor, { barcode })));
    const rejected = attempts.filter(result => result.status === 'rejected');
    assert.equal(rejected.length, 0, 'Every concurrent lookup must resolve: ' + rejected.map(result => result.reason?.message).join('; '));
    const results = attempts.map(result => result.value);
    for (const result of results) { publicOnly(result); assert.equal(result.product.size, 'P'); }
    assert.equal(new Set(results.map(result => result.product.productSizeId)).size, 1);
    const after = await snapshot(f), added = after.sizes.filter(s => !before.sizes.some(old => old.id === s.id));
    assert.equal(added.length, 1); assert.equal(added[0].stock, 0); assert.equal(added[0].id, results[0].product.productSizeId);
    assert.equal(added[0].barcode.replace(/^0+/, ''), evidence.barcode);
    operationalUnchanged(before, after);
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
