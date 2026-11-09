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
  `ALTER TABLE "TournamentEntry" ADD COLUMN IF NOT EXISTS "logoUrl" TEXT`,
  // Súmula oficial — arbitragem + desempate por pênaltis (mata-mata)
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "referee1" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "referee2" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "scorer" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "homePenalties" INTEGER`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "awayPenalties" INTEGER`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "decidedByPenalties" BOOLEAN NOT NULL DEFAULT false`,
  // Mata-mata: rótulo da vaga quando o time ainda não está definido ("Vencedor Semifinal 1", "1º Grupo A")
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "homeSourceLabel" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "awaySourceLabel" TEXT`,
  // Elenco — comissão técnica (técnico/auxiliar levam cartão) + titular/banco
  `ALTER TABLE "RosterPlayer" ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'PLAYER'`,
  `ALTER TABLE "RosterPlayer" ADD COLUMN IF NOT EXISTS "started" BOOLEAN NOT NULL DEFAULT false`,
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
  // Arbitragem: cronometrista + 3º árbitro (quadro oficial de futsal = 2 árbitros + mesa + cronometrista)
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "referee3" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "timekeeper" TEXT`,
  // CONTAS/PAPÉIS do torneio (genérico pra TODO torneio) — quem alimenta cada parte.
  // role: FOUNDER | COORDINATOR | TEAM_ADMIN | COACH | REFEREE | PLAYER
  // entryId: preenchido quando o papel é por time (TEAM_ADMIN/COACH/PLAYER); null = torneio inteiro.
  `CREATE TABLE IF NOT EXISTS "TournamentRole" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "role" TEXT NOT NULL,
     "entryId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentRole_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentRole_uniq" ON "TournamentRole" ("tournamentId", "userId", "role", COALESCE("entryId", ''))`,
  `CREATE INDEX IF NOT EXISTS "TournamentRole_tournament_idx" ON "TournamentRole" ("tournamentId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentRole_user_idx" ON "TournamentRole" ("userId")`,
  // Nomeação da arbitragem por jogo (quem apita cada partida): REF1|REF2|REF3|SCORER|TIMEKEEPER
  `CREATE TABLE IF NOT EXISTS "MatchOfficial" (
     "id" TEXT NOT NULL,
     "matchId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "role" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MatchOfficial_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MatchOfficial_uniq" ON "MatchOfficial" ("matchId", "userId", "role")`,
  `CREATE INDEX IF NOT EXISTS "MatchOfficial_match_idx" ON "MatchOfficial" ("matchId")`,
  `CREATE INDEX IF NOT EXISTS "MatchOfficial_user_idx" ON "MatchOfficial" ("userId")`,
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
