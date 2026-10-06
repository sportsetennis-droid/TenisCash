'use strict';

// Only this named local database is allowed. The actual route/Prisma/stock ledger
// are exercised, but every fiscal call is an in-process stub with no transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const url = process.env.EXCHANGE_TEST_DATABASE_URL;
const target = url && new URL(url);
if (!target || !['postgresql:', 'postgres:'].includes(target.protocol) || target.hostname !== '127.0.0.1'
  || target.port !== '55329' || target.pathname !== '/bipar_transfer_20261002') {
  throw Error('Use EXCHANGE_TEST_DATABASE_URL only for 127.0.0.1:55329/bipar_transfer_20261002');
}
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url } } });
const root = path.resolve(__dirname, '..');
const report = { startedAt: new Date().toISOString(), database: { host: target.hostname, port: target.port, name: target.pathname.slice(1) }, checks: [] };
const fixtures = [];

async function fixture() {
  const prefix = 'EXCHANGE-TEST-' + randomUUID();
  const f = { prefix, calls: [], rejectFirstCupom: false, saleAttempts: 0 };
  fixtures.push(f);
  f.issuer = await db.fiscalIssuer.create({ data: { cnpj: prefix, companyName: prefix, environment: 'homologation', nfceNextNumber: 2 } });
  f.store = await db.store.create({ data: { code: prefix, name: prefix, fiscalIssuerId: f.issuer.id, fiscalAgentEnabled: true, fiscalAgentUrl: 'http://invalid.local.test', fiscalAgentToken: 'IN-PROCESS-STUB' } });
  f.actor = await db.user.create({ data: { name: prefix, phone: prefix, pin: 'isolated-fixture', role: 'seller', storeId: f.store.id } });
  f.oldProduct = await db.product.create({ data: { sku: prefix + '-old', name: 'Old test shoe', brand: 'TEST', category: 'tenis', price: 711.11, sizes: { create: { size: '40', barcode: prefix + '-old-code', stock: 10 } } }, include: { sizes: true } });
  f.newProduct = await db.product.create({ data: { sku: prefix + '-new', name: 'New test shoe', brand: 'TEST', category: 'tenis', price: 1299, sizes: { create: { size: '41', barcode: prefix + '-new-code', stock: 20 } } }, include: { sizes: true } });
  f.oldSize = f.oldProduct.sizes[0]; f.newSize = f.newProduct.sizes[0];
  await db.storeStock.createMany({ data: [{ storeId: f.store.id, productSizeId: f.oldSize.id, stock: 0 }, { storeId: f.store.id, productSizeId: f.newSize.id, stock: 5 }] });
  f.originalSale = await db.sale.create({ data: { sellerId: f.actor.id, storeId: f.store.id, totalAmount: 711.11, paymentMethod: 'cash', items: { create: { productId: f.oldProduct.id, productSizeId: f.oldSize.id, productName: f.oldProduct.name, brand: 'TEST', size: '40', quantity: 1, unitPrice: 711.11, totalPrice: 711.11 } } }, include: { items: true } });
  f.originalDoc = await db.fiscalDocument.create({ data: { issuerId: f.issuer.id, docType: 'NFCE', number: 1, serie: 1, status: 'authorized', accessKey: prefix + '-original', totalValue: 711.11, saleId: f.originalSale.id, productIds: [f.oldProduct.id] } });
  f.body = { storeId: f.store.id, originalDocId: f.originalDoc.id, returned: [{ saleItemId: f.originalSale.items[0].id, qty: 1 }], newItems: [{ barcode: f.newSize.barcode, size: '41', qty: 1 }], diffAmount: 100, diffPayment: { tPag: '01' }, customerCpf: '11111111111' };
  const agent = {
    async emitNFe55(_store, payload) { f.calls.push({ type: 'return', payload }); return { ok: true, status: '100', accessKey: prefix + '-return', protocol: 'STUB', xmlSigned: '<isolated-test/>' }; },
    async emitNFCe(_store, payload) {
      f.calls.push({ type: 'sale', payload }); f.saleAttempts++;
      if (f.rejectFirstCupom && f.saleAttempts === 1) return { ok: false, status: '999', accessKey: prefix + '-rejected', motivo: 'Isolated test rejection' };
      // Keep the first concurrent reservation processing while its peer arrives.
      await new Promise(resolve => setTimeout(resolve, 100));
      return { ok: true, status: '100', accessKey: prefix + '-sale', protocol: 'STUB', xmlSigned: '<isolated-test/>' };
    },
  };
  const handlers = {};
  f.synchronizeFirstTransactions = () => {
    let remaining = 2, release;
    const gate = new Promise(resolve => { release = resolve; });
    f.waitAtTransaction = async () => {
      if (remaining <= 0) return;
      if (--remaining === 0) release();
      await gate;
    };
  };
  const routeDb = new Proxy(db, { get(object, key) {
    if (key === '$transaction') return async callback => { if (f.waitAtTransaction) await f.waitAtTransaction(); return db.$transaction(callback); };
    return Reflect.get(object, key, object);
  } });
  const router = { use() {}, put() {}, get(route, handler) { if (route === '/troca/cupons') handlers.cupons = handler; }, post(route, handler) { if (route === '/troca') handlers.exchange = handler; } };
  const context = { module: { exports: {} }, console: { log() {}, warn() {}, error() {} }, process: { env: {} }, __dirname: path.join(root, 'src/routes'), require(name) {
    if (name === 'express') return { Router: () => router };
    if (name === 'node:path') return path;
    if (name === '../middleware') return { prisma: routeDb, authMiddleware() {}, adminMiddleware() {} };
    if (name === '../services/fiscalAgentClient') return agent;
    if (name === '../services/exchangePricing') return require('../src/services/exchangePricing');
    if (name === '../services/storeStockLedger') return require('../src/services/storeStockLedger');
    if (['../services/fiscalApi', '../services/cupomThermal', '../services/ncmRobot'].includes(name)) return {};
    throw Error('Blocked dependency: ' + name);
  } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/routes/fiscal.js'), 'utf8'), context, { filename: 'fiscal.js' });
  f.invoke = async (overrides = {}, kind = 'exchange') => {
    let status = 200, body;
    await handlers[kind]({ body: { ...f.body, ...overrides }, query: { storeId: f.store.id }, userId: f.actor.id, userRole: 'seller', authUser: { storeId: f.store.id, storeIds: [] } }, { status(code) { status = code; return this; }, json(value) { body = JSON.parse(JSON.stringify(value)); return this; } });
    return { status, ...body };
  };
  return f;
}

async function verify(f, saleId) {
  const [sales, docs, moves, stocks, sizes, products] = await Promise.all([
    db.sale.findMany({ where: { storeId: f.store.id }, include: { items: true } }),
    db.fiscalDocument.findMany({ where: { issuerId: f.issuer.id } }),
    db.storeStockMovement.findMany({ where: { storeId: f.store.id } }),
    db.storeStock.findMany({ where: { storeId: f.store.id } }),
    db.productSize.findMany({ where: { id: { in: [f.oldSize.id, f.newSize.id] } } }),
    db.product.findMany({ where: { id: { in: [f.oldProduct.id, f.newProduct.id] } } }),
  ]);
  assert.equal(sales.length, 2);
  const sale = sales.find(s => s.id === saleId);
  assert.equal(sale.totalAmount, 811.11);
  assert.equal(sale.items.reduce((sum, item) => sum + Math.round(item.totalPrice * 100), 0), 81111);
  assert.equal(docs.filter(d => d.docType === 'NFE' && d.status === 'authorized').length, 1);
  assert.equal(docs.filter(d => d.saleId === saleId && d.status === 'authorized').length, 1);
  assert.equal(moves.filter(m => m.type === 'exchange_return').length, 1);
  assert.equal(moves.filter(m => m.type === 'exchange_sale').length, 1);
  assert.equal(stocks.find(s => s.productSizeId === f.oldSize.id).stock, 1);
  assert.equal(stocks.find(s => s.productSizeId === f.newSize.id).stock, 4);
  assert.equal(sizes.find(s => s.id === f.oldSize.id).stock, 10);
  assert.equal(sizes.find(s => s.id === f.newSize.id).stock, 20);
  assert.equal(products.find(p => p.id === f.newProduct.id).price, 1299);
  return { sale, docs, moves };
}

async function cleanFixture(f) {
  if (f.store) {
    const sales = await db.sale.findMany({ where: { storeId: f.store.id }, select: { id: true } });
    await db.storeStockMovement.deleteMany({ where: { storeId: f.store.id } });
    await db.storeStock.deleteMany({ where: { storeId: f.store.id } });
    await db.saleItem.deleteMany({ where: { saleId: { in: sales.map(s => s.id) } } });
    await db.sale.deleteMany({ where: { storeId: f.store.id } });
  }
  if (f.issuer) await db.fiscalDocument.deleteMany({ where: { issuerId: f.issuer.id } });
  for (const p of [f.oldProduct, f.newProduct].filter(Boolean)) {
    await db.productSize.deleteMany({ where: { productId: p.id } });
    await db.product.delete({ where: { id: p.id } });
  }
  if (f.actor) await db.user.delete({ where: { id: f.actor.id } });
  if (f.store) await db.store.delete({ where: { id: f.store.id } });
  if (f.issuer) await db.fiscalIssuer.delete({ where: { id: f.issuer.id } });
}

(async () => {
  const server = await db.$queryRaw`SELECT current_database() AS database, inet_server_port() AS port`;
  assert.equal(server[0].database, 'bipar_transfer_20261002'); assert.equal(server[0].port, 55329);
  const a = await fixture();
  a.synchronizeFirstTransactions();
  const simultaneous = await Promise.all([a.invoke(), a.invoke()]);
  const authorized = simultaneous.find(result => result.ok === true);
  assert.ok(authorized, JSON.stringify(simultaneous));
  assert.equal(simultaneous.filter(result => result.status === 409).length, 1, JSON.stringify(simultaneous));
  await verify(a, authorized.saleId);
  assert.equal(a.calls.filter(c => c.type === 'return').length, 1);
  assert.equal(a.calls.filter(c => c.type === 'sale').length, 1);
  report.checks.push('Concurrent initial requests reserve returned quantity once; one return, one sale, exact totals and stock.');

  const b = await fixture(); b.rejectFirstCupom = true;
  const failed = await b.invoke();
  assert.equal(failed.step, 'cupom'); assert.equal(failed.ok, false);
  // Recreate a recoverable stock transaction that never committed, using only
  // this synthetic fixture: concurrently reclaiming the JSON flag must apply once.
  const dev = await db.fiscalDocument.findUnique({ where: { id: failed.devolucaoDocId } });
  await db.$transaction(async tx => {
    await tx.storeStockMovement.deleteMany({ where: { storeId: b.store.id, type: 'exchange_return' } });
    await tx.storeStock.update({ where: { storeId_productSizeId: { storeId: b.store.id, productSizeId: b.oldSize.id } }, data: { stock: 0 } });
    await tx.fiscalDocument.update({ where: { id: dev.id }, data: { response: { ...dev.response, troca: { ...dev.response.troca, stockApplied: false } } } });
  });
  const retryBody = { devolucaoDocId: failed.devolucaoDocId, saleId: failed.saleId, diffPayment: { tPag: '17' } };
  b.synchronizeFirstTransactions();
  const retries = await Promise.all([b.invoke(retryBody), b.invoke(retryBody)]);
  assert.equal(retries.filter(result => result.ok).length, 1, JSON.stringify(retries));
  assert.equal(retries.filter(result => result.status === 409).length, 1, JSON.stringify(retries));
  const saved = await verify(b, failed.saleId);
  assert.equal(saved.sale.paymentMethod, 'pix');
  assert.equal(b.calls.filter(c => c.type === 'return').length, 1);
  assert.equal(b.calls.filter(c => c.type === 'sale').length, 2, 'One rejected stub + one authorized stub');
  report.checks.push('Concurrent retries claim JSON stockApplied once and reserve one new cupom; cash-to-PIX retry updates the sale.');
  const replay = await b.invoke(retryBody);
  assert.equal(replay.alreadyEmitted, true); await verify(b, failed.saleId);
  assert.equal(b.calls.length, 3);
  const list = await b.invoke({}, 'cupons');
  assert.equal(list.status, 200);
  const original = list.cupons.find(c => c.docId === b.originalDoc.id);
  assert.equal(original.items[0].returnedQuantity, 1); assert.equal(original.items[0].availableQuantity, 0);
  report.checks.push('Authorized retry is read-only; GET cupons exposes returned/available quantities from PostgreSQL JSON predicates.');
  report.passed = true;
})().catch(error => { report.passed = false; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(async () => {
  try { for (const f of fixtures) await cleanFixture(f); report.fixturesCleaned = true; }
  catch (error) { report.fixturesCleaned = false; report.cleanupError = error.message; process.exitCode = 1; }
  report.endedAt = new Date().toISOString();
  const folder = path.join(root, 'artifacts', 'exchange-2026-10-05'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'postgresql-tests.json'), JSON.stringify(report, null, 2) + '\n');
  await db.$disconnect();
  console.log(JSON.stringify(report, null, 2));
});
