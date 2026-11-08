// =====================================================================
// Migração ADITIVA e IDEMPOTENTE do módulo de torneios (APEX).
// ---------------------------------------------------------------------
// O deploy NÃO roda `prisma db push` (decisão deliberada — commit
// 96d9e0e "start app without destructive schema push" — pra evitar push
// destrutivo). Então as colunas/tabelas NOVAS e ADITIVAS do APEX são
// garantidas aqui no boot, com IF NOT EXISTS: nunca apaga nem altera nada
// que já existe, só cria o que falta. Seguro rodar em todo boot.
// =====================================================================

const STATEMENTS = [
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "cashEnabled" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "prizePaidAt" TIMESTAMP(3)`,
  `ALTER TABLE "TournamentEntry" ADD COLUMN IF NOT EXISTS "entryTxId" TEXT`,
  `CREATE TABLE IF NOT EXISTS "AppNotification" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "type" TEXT NOT NULL DEFAULT 'info',
     "title" TEXT,
     "body" TEXT NOT NULL DEFAULT '',
     "link" TEXT,
     "read" BOOLEAN NOT NULL DEFAULT false,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AppNotification_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "AppNotification_userId_read_createdAt_idx" ON "AppNotification" ("userId", "read", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "RosterPlayer" (
     "id" TEXT NOT NULL,
     "entryId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "number" INTEGER,
     "isGoalkeeper" BOOLEAN NOT NULL DEFAULT false,
     "isCaptain" BOOLEAN NOT NULL DEFAULT false,
     "userId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "RosterPlayer_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "RosterPlayer_entryId_idx" ON "RosterPlayer" ("entryId")`,
  `CREATE TABLE IF NOT EXISTS "MatchEvent" (
     "id" TEXT NOT NULL,
     "matchId" TEXT NOT NULL,
     "entryId" TEXT NOT NULL,
     "playerId" TEXT,
     "type" TEXT NOT NULL,
     "minute" INTEGER,
     "period" INTEGER,
     "note" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MatchEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "MatchEvent_matchId_idx" ON "MatchEvent" ("matchId")`,
  `CREATE INDEX IF NOT EXISTS "MatchEvent_playerId_idx" ON "MatchEvent" ("playerId")`,
];

async function ensureApexSchema(prisma) {
  let ok = 0;
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      ok += 1;
    } catch (e) {
      console.error('[ensureApexSchema] statement falhou:', e.message);
    }
  }
  console.log(`[ensureApexSchema] ok (${ok}/${STATEMENTS.length} aplicados/verificados)`);
  return ok;
}

module.exports = { ensureApexSchema };
