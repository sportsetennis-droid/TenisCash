'use strict';
// Execute the exact PostgreSQL guard in session-local temporary tables only.
// Every paid provider/curation entry point is mocked; never use DATABASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('pg');
const openClients = new Set();
const testUrl = process.env.IMAGE_REPAIR_TEST_DATABASE_URL || process.env.ROUND_TEST_DATABASE_URL;
assert.ok(testUrl, 'Set IMAGE_REPAIR_TEST_DATABASE_URL to the isolated local test PostgreSQL');
const parsedUrl = new URL(testUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname), 'Test PostgreSQL must be local');
assert.ok(/test/i.test(parsedUrl.pathname) || ['/stock_replacement_live_20261109', '/stock_replacement_ci'].includes(parsedUrl.pathname), 'Use the isolated test database');

async function fixture() {
  const db = new Client({ connectionString: testUrl });
  await db.connect();
  openClients.add(db);
  await db.query(`
    CREATE TEMP TABLE "StocktakeRound" (id TEXT PRIMARY KEY, "operationType" TEXT, status TEXT);
    CREATE TEMP TABLE "StocktakeBipe" (id TEXT PRIMARY KEY, "roundId" TEXT, "productId" TEXT, "productSizeId" TEXT, "excludedAt" TEXT);
    CREATE TEMP TABLE "ProductCapture" (id TEXT PRIMARY KEY, "roundId" TEXT, "matchedProductId" TEXT, "createdProductId" TEXT, "bipeId" TEXT, "excludedAt" TEXT, barcode TEXT, status TEXT DEFAULT 'pendente');
    CREATE TEMP TABLE "ProductSize" (id TEXT PRIMARY KEY, "productId" TEXT, barcode TEXT);
    INSERT INTO "StocktakeRound" VALUES ('open','replacement','counting'),('review','replacement','review'),
      ('closed','replacement','closed'),('cancelled','replacement','cancelled'),('inventory','inventory','counting');
    INSERT INTO "StocktakeBipe" VALUES
      ('b-open','open','direct','size-owner',NULL),('b-review','review','review-product',NULL,NULL),
      ('b-closed','closed','closed-product',NULL,NULL),('b-other','inventory','inventory-product',NULL,NULL),
      ('b-cancelled','cancelled','cancelled-product',NULL,NULL),('b-old',NULL,'history-product',NULL,NULL),
      ('b-excluded','open','excluded-product',NULL,'2026-11-09'),
      ('b-linked',NULL,'linked-product','linked-size',NULL),
      ('b-linked-excluded',NULL,'linked-excluded-product',NULL,'2026-11-09');
    INSERT INTO "ProductSize" (id,"productId") VALUES ('size-owner','variant-product'),('linked-size','linked-variant');
    INSERT INTO "ProductCapture" (id,"roundId","matchedProductId","createdProductId","bipeId","excludedAt") VALUES
      ('c-open','open','capture-match','capture-created','b-linked',NULL),
      ('c-repeat','open','direct',NULL,'b-open',NULL),
      ('c-closed','closed','closed-capture',NULL,NULL,NULL),
      ('c-inventory','inventory','inventory-capture',NULL,NULL,NULL),
      ('c-excluded','open','excluded-capture',NULL,NULL,'2026-11-09'),
      ('c-excluded-bipe','open',NULL,NULL,'b-linked-excluded',NULL);
    INSERT INTO "ProductSize" VALUES ('go-original-size','go-original','197976711426'),
      ('ref-size','reference-owner','ABC976711426'),('discarded-size','discarded-owner','197976711427'),
      ('closed-size','closed-barcode-owner','197976711428'),('short-size','short-owner','1234567');
    INSERT INTO "ProductCapture" (id,"roundId","matchedProductId",barcode,status) VALUES
      ('go-capture','open','go-old-consolidated','0197976711426','vinculado'),
      ('reference-capture','open',NULL,'ABC976711426','pendente'),
      ('discarded-capture','open','discarded-product','0197976711427','descartado'),
      ('closed-barcode-capture','closed',NULL,'0197976711428','pendente'),
      ('short-capture','open',NULL,'1234567','pendente');
  `);
  return db;
}

function harness(db, productIds = [], afterSelection = null) {
  const calls = { queries: [], selections: [], curated: [], updates: [] };
  const products = productIds.map((id) => ({ id, active: true, sku: id, aiContext: {}, sizes: [], updatedAt: new Date(0) }));
  const prisma = {
    $queryRaw: async (strings, ...values) => {
      calls.queries.push(values);
      const sql = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
      return (await db.query(sql, values)).rows;
    },
    product: {
      findMany: async ({ where }) => {
        calls.selections.push(where);
        assert.equal(where.active, true);
        const selected = products.filter((product) => !where.id.notIn.includes(product.id));
        if (afterSelection) await afterSelection();
        return selected;
      },
      findUnique: async ({ where }) => products.find((product) => product.id === where.id),
      update: async ({ where }) => { calls.updates.push(where.id); },
      count: async () => products.length,
    },
    nuvemshopProductMapping: { findMany: async () => [] },
  };
  const mocks = {
    'node-cron': { schedule() { throw Error('Cron scheduling is not allowed in this test'); } },
    '../middleware': { prisma },
    './curationAgent': { curateProduct: async (id) => {
      calls.curated.push(id);
      return { costBRL: 0, steps: { image: { ok: true, url: 'mock-image', score: 9 } } };
    } },
    './serperImageSearch': { isConfigured: () => true },
    './visionValidator': { isConfigured: () => true, providerStatus: () => ({ anthropic: true }) },
  };
  const sandbox = {
    module: { exports: {} }, process: { env: {} }, console,
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected module: ${name}`);
      return mocks[name];
    },
  };
  const filename = path.join(__dirname, '../src/services/imageRepairCron.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  return { service: sandbox.module.exports, prisma, calls };
}

async function run() {
  {
    const db = await fixture();
    const { service } = harness(db);
    const ids = [...await service.replacementProductIds()].sort();
    assert.deepEqual(ids, ['capture-created', 'capture-match', 'direct', 'go-old-consolidated', 'go-original', 'linked-product', 'linked-variant', 'review-product', 'variant-product']);
    assert.deepEqual([...await service.replacementProductIds('variant-product')], ['variant-product']);
    for (const id of ['closed-product', 'cancelled-product', 'inventory-product', 'history-product', 'excluded-product',
      'closed-capture', 'inventory-capture', 'excluded-capture', 'linked-excluded-product', 'reference-owner',
      'discarded-owner', 'discarded-product', 'closed-barcode-owner', 'short-owner']) {
      assert.equal((await service.replacementProductIds(id)).length, 0, id);
    }
    await db.end();
    openClients.delete(db);
    console.log('PASS PostgreSQL SQL: open/review, bipe/variant/capture links, restored GO original UPC/EAN owner, closed/other/excluded/discarded scope');
  }
  {
    const db = await fixture();
    const { service, calls } = harness(db,
      ['direct', 'go-original', 'queued-bipe', 'queued-capture', 'unrelated', 'closed-product', 'inventory-product', 'excluded-product'],
      () => db.query(`BEGIN;
        INSERT INTO "StocktakeBipe" VALUES ('b-new','open','queued-bipe',NULL,NULL);
        UPDATE "ProductCapture" SET "matchedProductId"='queued-capture' WHERE id='c-open';
        COMMIT;`));
    const result = await service.runImageRepairBatch();
    assert.ok(calls.selections[0].id.notIn.includes('direct'));
    assert.ok(calls.selections[0].id.notIn.includes('go-original'));
    assert.deepEqual(calls.curated, ['unrelated', 'closed-product', 'inventory-product', 'excluded-product']);
    assert.deepEqual(calls.updates, calls.curated);
    assert.equal(result.skippedReplacement, 2);
    assert.equal(result.processed, 4);
    assert.equal(result.costBRL, 0);
    assert.deepEqual(calls.queries.slice(1).map((values) => values[0]),
      ['queued-bipe', 'queued-capture', 'unrelated', 'closed-product', 'inventory-product', 'excluded-product']);
    await db.end();
    openClients.delete(db);
    console.log('PASS selection + fresh per-candidate recheck after committed bipe/capture link; unrelated curation preserved');
  }
  {
    const db = await fixture();
    const { service, calls, prisma } = harness(db, ['queued']);
    const query = prisma.$queryRaw;
    prisma.$queryRaw = async (...args) => {
      if (calls.queries.length) throw Error('guard database unavailable');
      return query(...args);
    };
    await assert.rejects(service.runImageRepairBatch(), /guard database unavailable/);
    assert.deepEqual(calls.curated, []);
    assert.deepEqual(calls.updates, []);
    assert.equal(service.getImageRepairCronState().running, false);
    await db.end();
    openClients.delete(db);
    console.log('PASS guard failure aborts before paid entry point or attempt write');
  }
  {
    const db = await fixture();
    const { service, calls } = harness(db, ['direct']);
    await service.runImageRepairBatch();
    assert.deepEqual(calls.curated, []);
    await db.query(`UPDATE "StocktakeRound" SET status='closed' WHERE id='open'`);
    await service.runImageRepairBatch();
    assert.deepEqual(calls.curated, ['direct']);
    await db.end();
    openClients.delete(db);
    console.log('PASS closed replacement releases product back to existing curation');
  }
  console.log('image-repair replacement guard: PASS (all providers mocked, isolated PostgreSQL temporary tables only)');
}
run().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => Promise.allSettled([...openClients].map((db) => db.end())));
