'use strict';

// Aplica o SQL do financeiro (aditivo e idempotente) sob trava. O deploy NÃO roda
// `prisma db push`: tabela/coluna nova só entra no banco por aqui.

const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = ['20261112_fin_core', '20261113_stone_connect'];

function splitStatements(sqlText) {
  return sqlText
    .split(/\r?\n-- @statement\s*\r?\n/)
    .map((s) => s.trim())
    // Comentários dentro do comando são válidos no Postgres; só pula bloco vazio.
    .filter((s) => s.split(/\r?\n/).some((line) => line.trim() && !line.trim().startsWith('--')));
}

function loadStatements() {
  return MIGRATIONS.flatMap((name) => splitStatements(
    fs.readFileSync(path.join(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8'),
  ));
}

const statements = loadStatements();

function createFinSchemaReadiness(prisma) {
  let ready = null;
  function ensureFinSchema() {
    if (!ready) {
      ready = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('fin-core-schema'))) AS fin_lock`;
        for (const sql of statements) await tx.$executeRawUnsafe(sql);
      }, { timeout: 30000, maxWait: 10000 }).catch((err) => { ready = null; throw err; });
    }
    return ready;
  }
  // Middleware: 503 enquanto o schema não estiver pronto (nunca responde com tabela faltando).
  ensureFinSchema.middleware = function finSchemaMiddleware(_req, res, next) {
    ensureFinSchema().then(() => next(), (err) => {
      console.error('[finSchema]', err.message);
      res.status(503).json({ error: 'Financeiro indisponível: atualização do banco falhou. Tente de novo em instantes.' });
    });
  };
  return ensureFinSchema;
}

module.exports = { MIGRATIONS, splitStatements, loadStatements, createFinSchemaReadiness };
