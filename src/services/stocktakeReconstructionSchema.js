'use strict';

const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.join(__dirname, '../../prisma/migrations/20261026_stocktake_reconstruction/migration.sql');
const statements = fs.readFileSync(migrationPath, 'utf8')
  .split(/\r?\n-- @statement\s*\r?\n/)
  .map(statement => statement.trim())
  .filter(statement => statement && !statement.startsWith('--'));

function createSchemaReadiness(prisma) {
  let ready = null;
  return function ensureStocktakeReconstructionSchema() {
    if (!ready) {
      ready = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('stocktake-reconstruction-schema-20261026'))) AS stocktake_reconstruction_lock`;
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
      }, { timeout: 30000, maxWait: 10000 }).catch(error => { ready = null; throw error; });
    }
    return ready;
  };
}

module.exports = { createSchemaReadiness };
