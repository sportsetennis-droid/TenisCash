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
  // Vínculo ATLETA ↔ TIME (clube) — convite/aceite nos dois sentidos.
  // O clube é UM só em várias categorias, então o vínculo é por NOME do clube (clubName).
  // status: PENDING | ACTIVE | DECLINED | REMOVED · initiatedBy: ATHLETE | TEAM
  `CREATE TABLE IF NOT EXISTS "TeamMembership" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "clubName" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "initiatedBy" TEXT NOT NULL DEFAULT 'ATHLETE',
     "invitedByUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "respondedAt" TIMESTAMP(3),
     CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TeamMembership_uniq" ON "TeamMembership" ("tournamentId", "clubName", "userId")`,
  `CREATE INDEX IF NOT EXISTS "TeamMembership_tournament_idx" ON "TeamMembership" ("tournamentId")`,
  `CREATE INDEX IF NOT EXISTS "TeamMembership_user_idx" ON "TeamMembership" ("userId")`,
  // TREINO = atividade OFICIAL do time (mesmo status do jogo), criada pelo treinador.
  // Tem súmula própria: chamada/presença + o que foi feito. Não entra em classificação.
  // Escopo por NOME do clube (clube = um só em várias categorias).
  // status: SCHEDULED | DONE | CANCELED
  `CREATE TABLE IF NOT EXISTS "TrainingSession" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "clubName" TEXT NOT NULL,
     "title" TEXT NOT NULL DEFAULT 'Treino',
     "focus" TEXT,
     "scheduledAt" TIMESTAMP(3),
     "location" TEXT,
     "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
     "notes" TEXT,
     "createdByUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TrainingSession_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "TrainingSession_tournament_idx" ON "TrainingSession" ("tournamentId")`,
  `CREATE INDEX IF NOT EXISTS "TrainingSession_club_idx" ON "TrainingSession" ("tournamentId", "clubName")`,
  // Presença/chamada do treino. confirmed = atleta confirmou (RSVP); present = chamada do treinador.
  `CREATE TABLE IF NOT EXISTS "TrainingAttendance" (
     "id" TEXT NOT NULL,
     "sessionId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "confirmed" BOOLEAN NOT NULL DEFAULT false,
     "present" BOOLEAN,
     "note" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TrainingAttendance_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TrainingAttendance_uniq" ON "TrainingAttendance" ("sessionId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "TrainingAttendance_session_idx" ON "TrainingAttendance" ("sessionId")`,
  `CREATE INDEX IF NOT EXISTS "TrainingAttendance_user_idx" ON "TrainingAttendance" ("userId")`,
  // PRODUÇÃO por atleta no treino (prontuário): gols (coletivo), passes,
  // eficiência (0-100%), nota do treinador (0-10). Observação usa a coluna "note".
  `ALTER TABLE "TrainingAttendance" ADD COLUMN IF NOT EXISTS "goals" INTEGER`,
  `ALTER TABLE "TrainingAttendance" ADD COLUMN IF NOT EXISTS "passes" INTEGER`,
  `ALTER TABLE "TrainingAttendance" ADD COLUMN IF NOT EXISTS "efficiency" INTEGER`,
  `ALTER TABLE "TrainingAttendance" ADD COLUMN IF NOT EXISTS "rating" DOUBLE PRECISION`,
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
