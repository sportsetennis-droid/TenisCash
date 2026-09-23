'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const barcodeInput = require('../src/services/barcodeInput');
const ledger = require('../src/services/storeStockLedger');
const { isWebsiteBarcode, WEBSITE_BARCODE_ERROR, WEBSITE_BARCODE_ERROR_CODE } = barcodeInput;

const qrInputs = [
  'HTTPS://QR.NIKE.COM/05M71S96C6681',
  ' https://qr.nike.com/05M71S96C6681 ',
  'http://example.com/item',
  '//qr.nike.com/05M71S96C6681',
  'www.nike.com/item',
  'qr.nike.com/05M71S96C6681',
  'QR.NIKE.COM',
  'qr.nike.com?code=05M71S96C6681',
  'qr.nike.com:443/item',
  'https:qr.nike.com/item',
  'ftp://example.com/item',
  'javascript:alert(1)',
  'data:text/html,example',
  'mailto:example@example.com',
  'tel:123456',
];
const ordinaryCodes = ['196153346321', '0196153346321', '78912345', 'ST-AB/001', 'DM3982-010', 'TC:ABC', 'REF.123', 'qr.nike.com-model', '', null];

// Load the real route bodies, replacing only external wiring and the database.
// No database URL, production client, network server, background job or writes.
function loadRoute(file, db, method, routePath) {
  const routes = [];
  const router = { use() {} };
  for (const verb of ['get', 'post', 'put', 'patch', 'delete']) {
    router[verb] = (url, ...handlers) => routes.push({ verb, url, handlers });
  }
  const upload = () => ({ single: () => () => {}, array: () => () => {} });
  upload.memoryStorage = () => ({});
  const ctx = {
    require(name) {
      if (name === 'express') return { Router: () => router };
      if (name === 'multer') return upload;
      if (name === 'crypto') return require('node:crypto');
      if (name === 'sharp') return () => { throw new Error('Unexpected image operation'); };
      if (name === '../middleware') return { prisma: db };
      if (name === '../services/barcodeInput') return barcodeInput;
      if (name === '../services/storeStockLedger') return ledger;
      if (name === '../services/scannerCatalog') return require('../src/services/scannerCatalog');
      if (name.startsWith('../services/') || name === './stocktakeRounds' || name === 'qrcode') return {};
      throw new Error(`Unexpected import: ${name}`);
    },
    module: { exports: {} }, console, Buffer,
    setInterval: () => 0, setTimeout: () => 0,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/routes', file), 'utf8'), ctx, { filename: file });
  const route = routes.find((entry) => entry.verb === method && entry.url === routePath);
  assert.ok(route, `Missing route ${method} ${routePath}`);
  return route.handlers.at(-1);
}

async function invoke(handler, req) {
  const res = {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(req, res);
  return res;
}

function assertBlocked(res) {
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, WEBSITE_BARCODE_ERROR_CODE);
  assert.equal(res.body.error, WEBSITE_BARCODE_ERROR);
}

async function main() {
  const product = {
    id: 'nike-existing', name: 'Existing Nike product',
    sizes: [{ id: 'size-40', size: '40', barcode: '196153346321', stock: 7 }],
  };
  const original = JSON.stringify(product);
  let dbTouches = 0;
  const forbiddenDb = new Proxy({}, { get() { dbTouches++; throw new Error('QR request must not touch the database'); } });
  const lookup = loadRoute('stocktake.js', forbiddenDb, 'get', '/lookup/:barcode');
  const sale = loadRoute('seller.js', forbiddenDb, 'post', '/sale');
  for (const barcode of qrInputs) {
    assert.equal(isWebsiteBarcode(barcode), true, barcode);
    assertBlocked(await invoke(lookup, { params: { barcode } }));
    for (const isNewBarcode of [false, true]) {
      for (const existingVariant of [false, true]) {
        const item = {
          productId: product.id, barcode, isNewBarcode, quantity: 1, unitPrice: 99,
          size: existingVariant ? '40' : '41', sellerSize: existingVariant ? '40' : '41',
          productSizeId: existingVariant ? 'size-40' : null, isNewSize: !existingVariant,
        };
        const isQrError = (err) => err instanceof ledger.SaleStockError
          && err.statusCode === 400 && err.code === WEBSITE_BARCODE_ERROR_CODE;
        assert.throws(() => ledger.resolveProductSize(product, item), isQrError);
        assert.throws(() => ledger.planSaleProductSize(product, item), isQrError,
          'A rejected URL must not fall back to creating a manual variant');
        assertBlocked(await invoke(sale, { userId: 'operator', body: { items: [item] } }));
      }
    }
  }
  // The complete cart is checked before processing even its valid first item.
  assertBlocked(await invoke(sale, { userId: 'operator', body: { items: [
    { productId: product.id, barcode: '196153346321', sellerSize: '40' },
    { productId: product.id, barcode: qrInputs[0], isNewBarcode: false, sellerSize: '40' },
  ] } }));
  assert.equal(dbTouches, 0, 'No reads, updates, learned barcode, stock movement or sale may occur for QR input');
  assert.equal(JSON.stringify(product), original, 'Existing identifiers and purchased stock stay unchanged');

  for (const code of ordinaryCodes) assert.equal(isWebsiteBarcode(code), false, String(code));
  assert.equal(ledger.resolveProductSize(product, { barcode: '196153346321' }).id, 'size-40');
  assert.equal(ledger.resolveProductSize(product, { barcode: 'ST-AB/001', sellerSize: '40' }).id, 'size-40');
  assert.equal(ledger.planSaleProductSize(product, {
    barcode: 'REF.123', isNewBarcode: true, isNewSize: true, size: '41', sellerSize: '41',
  }).needsNewProductSize, true, 'Manual/internal barcode behavior is preserved');

  let normalReads = 0;
  const db = {
    productSize: { async findMany({ where }) {
      normalReads++;
      return where.barcode.in.includes('0196153346321')
        ? [{ ...product.sizes[0], product: { ...product, active: true, price: 99 } }] : [];
    } },
    async $queryRaw() { normalReads++; return []; },
    product: { async findFirst({ where }) {
      normalReads++;
      return where.internalBarcode.in.includes('ST-AB/001')
        ? { ...product, active: true, internalBarcode: 'ST-AB/001', price: 99 } : null;
    } },
    xmlFiscalItem: { async findFirst() { normalReads++; return null; } },
  };
  const normalLookup = loadRoute('stocktake.js', db, 'get', '/lookup/:barcode');
  for (const barcode of ['196153346321', '0196153346321', 'ST-AB/001']) {
    const res = await invoke(normalLookup, { params: { barcode } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recognized, true);
    assert.equal(res.body.product.id, product.id);
  }
  const missing = await invoke(normalLookup, { params: { barcode: 'REF.123' } });
  assert.equal(missing.statusCode, 200);
  assert.equal(missing.body.recognized, false, 'Unknown internal identifiers retain ordinary lookup behavior');
  assert.ok(normalReads > 0);

  let operatorLookups = 0;
  const ordinarySale = loadRoute('seller.js', { user: { async findUnique() { operatorLookups++; return null; } } }, 'post', '/sale');
  for (const barcode of ['196153346321', 'ST-AB/001']) {
    const res = await invoke(ordinarySale, { userId: 'missing-test-operator', body: { items: [{ barcode }] } });
    assert.equal(res.statusCode, 404, 'Ordinary sales continue to the existing operator validation');
    assert.equal(res.body.error, 'Operador não encontrado');
  }
  assert.equal(operatorLookups, 2);
  console.log('PASS QR barcode backend: website inputs blocked before DB, legacy sale flags cannot bypass, no variant fallback, EAN/UPC leading zeros and internal codes preserved');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
