'use strict';

const fs = require('node:fs');
const path = require('node:path');
const statements = fs.readFileSync(path.join(__dirname, '../../prisma/migrations/20261026_mf_daily_production/migration.sql'), 'utf8')
  .split(';').map(s => s.trim()).filter(s => s && !/^(BEGIN|COMMIT)$/i.test(s));

// Migração aditiva e restrita ao módulo Meta. Não usa db push nem altera tabelas da S&T.
function createSchemaReadiness(prisma) {
  let ready = null;
  return function ensureSchema() {
    if (!ready) {
      ready = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('mf-daily-production-20261026'))) AS mf_daily_lock`;
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
      }, { timeout: 30000, maxWait: 10000 }).catch(err => { ready = null; throw err; });
    }
    return ready;
  };
}
module.exports = { createSchemaReadiness };
