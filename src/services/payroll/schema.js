'use strict';

// Garante as tabelas da folha (SQL aditivo/idempotente) e as sementes legais. O deploy
// não roda `prisma db push`: tabela nova só entra no banco por aqui.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { splitStatements } = require('../finSchema');
const { SEED_PARAMS, SEED_HOLIDAYS_2026, SEED_COMMISSION_RULE, SEED_UPDATES } = require('./params');

const MIGRATION = '20261116_payroll';
const statements = splitStatements(fs.readFileSync(path.join(__dirname, '../../../prisma/migrations', MIGRATION, 'migration.sql'), 'utf8'));
const id = () => 'c' + crypto.randomBytes(12).toString('hex');

async function seed(tx) {
  for (const p of SEED_PARAMS) {
    let storeId = null;
    if (p.storeCode) {
      const st = await tx.store.findFirst({ where: { code: p.storeCode }, select: { id: true } });
      if (!st) continue;
      storeId = st.id;
    }
    const exists = await tx.payrollParam.findFirst({ where: { key: p.key, validFrom: p.validFrom, issuerId: null, storeId }, select: { id: true } });
    if (!exists) await tx.payrollParam.create({ data: { id: id(), key: p.key, value: p.value, validFrom: p.validFrom, status: p.status || 'ACTIVE', source: p.source, createdById: 'seed', ...(storeId ? { storeId } : {}) } });
  }
  for (const u of SEED_UPDATES || []) {
    let storeId = null;
    if (u.storeCode) {
      const st = await tx.store.findFirst({ where: { code: u.storeCode }, select: { id: true } });
      if (!st) continue;
      storeId = st.id;
    }
    await tx.payrollParam.updateMany({ where: { key: u.key, validFrom: u.validFrom, issuerId: null, storeId, createdById: 'seed', source: u.oldSource }, data: u.set });
  }
  for (const h of SEED_HOLIDAYS_2026) {
    const exists = await tx.payrollHoliday.findFirst({ where: { date: h.date, scope: h.scope, locality: h.locality }, select: { id: true } });
    if (!exists) await tx.payrollHoliday.create({ data: { id: id(), ...h, createdById: 'seed' } });
  }
  const rule = await tx.payrollCommissionRule.findFirst({ select: { id: true } });
  if (!rule) await tx.payrollCommissionRule.create({ data: { id: id(), ...SEED_COMMISSION_RULE, createdById: 'seed' } });
}

function createPayrollSchemaReadiness(prisma) {
  let ready = null;
  function ensure() {
    if (!ready) {
      ready = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('payroll-schema'))) AS payroll_lock`;
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
        await seed(tx);
      }, { timeout: 30000, maxWait: 10000 }).catch((err) => { ready = null; throw err; });
    }
    return ready;
  }
  ensure.middleware = function payrollSchemaMiddleware(_req, res, next) {
    ensure().then(() => next(), (err) => {
      console.error('[payrollSchema]', err.message);
      res.status(503).json({ error: 'Contracheque indisponível: atualização do banco falhou. Tente de novo em instantes.' });
    });
  };
  return ensure;
}

module.exports = { MIGRATION, statements, createPayrollSchemaReadiness, seed };
