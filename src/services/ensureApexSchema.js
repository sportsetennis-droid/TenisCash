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
  // Liga Aberta F4 — compartilhar e voltar (WhatsApp por tipo, link público do time,
  // convite de vaga recuperável). PRIMEIRO da lista; só roda se a tabela já existe
  // (banco novo: repetido no FIM da lista, depois dos CREATE TABLE). Aditivo, nunca apaga.
  `DO $$ BEGIN IF to_regclass('"ClubNotifyPref"') IS NOT NULL THEN ALTER TABLE "ClubNotifyPref" ADD COLUMN IF NOT EXISTS "whatsapp" JSONB; END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TeamInvite"') IS NOT NULL THEN ALTER TABLE "TeamInvite" ADD COLUMN IF NOT EXISTS "publicToken" TEXT; END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"RosterInvite"') IS NOT NULL THEN ALTER TABLE "RosterInvite" ADD COLUMN IF NOT EXISTS "recoverable" BOOLEAN NOT NULL DEFAULT false; END IF; END $$`,
  // Liga Aberta F5 — arquivos e desempenho (mídia fora do JSON, índices, planos do
  // organizador sem preço). NO INÍCIO da lista (logo depois das 3 da F4); as tabelas novas não dependem de nada e os
  // índices/coluna só rodam se a tabela já existe (banco novo: repetidos no FIM). Aditivo, nunca apaga.
  `CREATE TABLE IF NOT EXISTS "MediaObject" (
     "id" TEXT NOT NULL,
     "sha256" TEXT NOT NULL,
     "mime" TEXT NOT NULL,
     "bytes" BYTEA,
     "size" INTEGER NOT NULL,
     "width" INTEGER,
     "height" INTEGER,
     "storage" TEXT NOT NULL DEFAULT 'db',
     "url" TEXT,
     "source" TEXT NOT NULL DEFAULT 'upload',
     "ownerUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MediaObject_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MediaObject_sha256_key" ON "MediaObject"("sha256")`,
  `CREATE INDEX IF NOT EXISTS "MediaObject_ownerUserId_createdAt_idx" ON "MediaObject"("ownerUserId", "createdAt")`,
  `CREATE TABLE IF NOT EXISTS "OrganizerPlan" (
     "key" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "priceCents" INTEGER,
     "limits" JSONB,
     "active" BOOLEAN NOT NULL DEFAULT true,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "OrganizerPlan_pkey" PRIMARY KEY ("key")
   )`,
  `CREATE TABLE IF NOT EXISTS "OrganizerSubscription" (
     "userId" TEXT NOT NULL,
     "planKey" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "OrganizerSubscription_pkey" PRIMARY KEY ("userId")
   )`,
  `DO $$ BEGIN IF to_regclass('"TournamentPost"') IS NOT NULL THEN ALTER TABLE "TournamentPost" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT; END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"Tournament"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "Tournament_ownerId_idx" ON "Tournament"("ownerId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"Tournament"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "Tournament_visibility_archivedAt_status_idx" ON "Tournament"("visibility", "archivedAt", "status"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentMatch"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentMatch_homeEntryId_idx" ON "TournamentMatch"("homeEntryId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentMatch"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentMatch_awayEntryId_idx" ON "TournamentMatch"("awayEntryId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentMatch"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentMatch_winnerEntryId_idx" ON "TournamentMatch"("winnerEntryId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentMatch"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentMatch_scheduledAt_idx" ON "TournamentMatch"("scheduledAt"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentMatch"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentMatch_categoryId_round_ordering_idx" ON "TournamentMatch"("categoryId", "round", "ordering"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"Club"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "Club_ownerId_idx" ON "Club"("ownerId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"Club"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "Club_originTournamentId_idx" ON "Club"("originTournamentId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"ClubMembership"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "ClubMembership_userId_idx" ON "ClubMembership"("userId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentStanding"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentStanding_tournamentId_idx" ON "TournamentStanding"("tournamentId"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"TournamentPost"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "TournamentPost_tournamentId_pinned_createdAt_idx" ON "TournamentPost"("tournamentId", "pinned", "createdAt"); END IF; END $$`,
  `DO $$ BEGIN IF to_regclass('"PickupAttendance"') IS NOT NULL THEN CREATE INDEX IF NOT EXISTS "PickupAttendance_playerId_idx" ON "PickupAttendance"("playerId"); END IF; END $$`,
  // Liga Aberta F3 — criação em 2 minutos (regras por categoria, racha, link do time).
  // PRIMEIRO da lista (as rotas novas leem essas colunas/tabelas). Aditivo, nunca apaga.
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "gameRules" JSONB`,
  `CREATE TABLE IF NOT EXISTS "TeamInvite" (
     "id" TEXT NOT NULL,
     "tokenHash" TEXT NOT NULL,
     "entryId" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "createdByUserId" TEXT NOT NULL,
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "revokedAt" TIMESTAMP(3),
     "uses" INTEGER NOT NULL DEFAULT 0,
     "lastUsedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash")`,
  `CREATE INDEX IF NOT EXISTS "TeamInvite_entryId_idx" ON "TeamInvite"("entryId")`,
  `CREATE INDEX IF NOT EXISTS "TeamInvite_tournamentId_idx" ON "TeamInvite"("tournamentId")`,
  `CREATE TABLE IF NOT EXISTS "PickupPlayer" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "userId" TEXT,
     "name" TEXT NOT NULL,
     "level" DOUBLE PRECISION,
     "active" BOOLEAN NOT NULL DEFAULT true,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "PickupPlayer_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "PickupPlayer_tournamentId_idx" ON "PickupPlayer"("tournamentId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PickupPlayer_tournamentId_userId_key" ON "PickupPlayer"("tournamentId", "userId")`,
  `CREATE TABLE IF NOT EXISTS "PickupSession" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "categoryId" TEXT NOT NULL,
     "dayKey" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'OPEN',
     "seed" TEXT,
     "teamCount" INTEGER NOT NULL DEFAULT 2,
     "teams" JSONB,
     "drawnAt" TIMESTAMP(3),
     "drawnBy" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "PickupSession_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PickupSession_tournamentId_dayKey_key" ON "PickupSession"("tournamentId", "dayKey")`,
  `CREATE TABLE IF NOT EXISTS "PickupAttendance" (
     "id" TEXT NOT NULL,
     "sessionId" TEXT NOT NULL,
     "playerId" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'IN',
     "byUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "PickupAttendance_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "PickupAttendance_sessionId_playerId_key" ON "PickupAttendance"("sessionId", "playerId")`,
  // Liga Aberta F2 — clube e atleta como identidade. PRIMEIRO da lista (as rotas de torneio
  // passam a ler TournamentEntry.clubId). Aditivo, nunca apaga.
  `ALTER TABLE "TournamentEntry" ADD COLUMN IF NOT EXISTS "clubId" TEXT`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "originTournamentId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "TournamentEntry_clubId_idx" ON "TournamentEntry"("clubId")`,
  `DO $$ BEGIN ALTER TABLE "TournamentEntry" ADD CONSTRAINT "TournamentEntry_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `CREATE INDEX IF NOT EXISTS "RosterPlayer_userId_idx" ON "RosterPlayer"("userId")`,
  `CREATE TABLE IF NOT EXISTS "RosterInvite" (
     "id" TEXT NOT NULL,
     "tokenHash" TEXT NOT NULL,
     "rosterPlayerId" TEXT NOT NULL,
     "entryId" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "createdByUserId" TEXT NOT NULL,
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "usedAt" TIMESTAMP(3),
     "usedByUserId" TEXT,
     "revokedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "RosterInvite_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "RosterInvite_tokenHash_key" ON "RosterInvite"("tokenHash")`,
  `CREATE INDEX IF NOT EXISTS "RosterInvite_rosterPlayerId_idx" ON "RosterInvite"("rosterPlayerId")`,
  `CREATE INDEX IF NOT EXISTS "RosterInvite_tournamentId_idx" ON "RosterInvite"("tournamentId")`,
  `CREATE TABLE IF NOT EXISTS "ProfileMergeRequest" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "otherUserId" TEXT NOT NULL,
     "method" TEXT NOT NULL DEFAULT 'CODE',
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "report" JSONB,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "doneAt" TIMESTAMP(3),
     CONSTRAINT "ProfileMergeRequest_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "ProfileMergeRequest_userId_createdAt_idx" ON "ProfileMergeRequest"("userId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "ProfileMergeRequest_otherUserId_idx" ON "ProfileMergeRequest"("otherUserId")`,
  // Liga Aberta F1 — logo depois da F2 (as rotas de torneio leem essas colunas: quanto antes
  // existirem depois do deploy, menor a janela de erro). Aditivo, nunca apaga.
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3)`,
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "archivedBy" TEXT`,
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "requireRefereeAssignment" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS "TournamentAudit" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "userId" TEXT,
     "action" TEXT NOT NULL,
     "entity" TEXT,
     "entityId" TEXT,
     "before" JSONB,
     "after" JSONB,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentAudit_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "TournamentAudit_tournamentId_createdAt_idx" ON "TournamentAudit"("tournamentId", "createdAt")`,
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
  // RSVP 3 estados (Vou/Talvez/Não vou) — padrão Spond/TeamSnap. confirmed = (rsvp='GOING').
  `ALTER TABLE "TrainingAttendance" ADD COLUMN IF NOT EXISTS "rsvp" TEXT`,
  // Treino recorrente: agrupa a série (toda terça/quinta...).
  `ALTER TABLE "TrainingSession" ADD COLUMN IF NOT EXISTS "recurrenceGroupId" TEXT`,
  `CREATE INDEX IF NOT EXISTS "TrainingSession_recur_idx" ON "TrainingSession" ("recurrenceGroupId")`,
  // PLANO do treino em blocos cronometrados (aquecimento→técnico→tático→coletivo→...).
  // plan = JSON array [{name, minutes, description}]. O atleta já sabe o que vai ser.
  `ALTER TABLE "TrainingSession" ADD COLUMN IF NOT EXISTS "plan" JSONB`,
  // Templates de plano reutilizáveis por clube (padrão Sportplan/Practice Plan).
  `CREATE TABLE IF NOT EXISTS "TrainingTemplate" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "clubName" TEXT NOT NULL,
     "name" TEXT NOT NULL DEFAULT 'Modelo',
     "plan" JSONB NOT NULL DEFAULT '[]',
     "createdByUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TrainingTemplate_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "TrainingTemplate_club_idx" ON "TrainingTemplate" ("tournamentId", "clubName")`,
  // AVALIAÇÃO do atleta — FA Four Corner Model (Técnico/Tático/Físico/Psicológico/Social),
  // nota 1-10 por dimensão + geral. Alimenta a curva de evolução no prontuário.
  `CREATE TABLE IF NOT EXISTS "AthleteEvaluation" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "clubName" TEXT,
     "userId" TEXT NOT NULL,
     "evaluatorId" TEXT,
     "technical" DOUBLE PRECISION,
     "tactical" DOUBLE PRECISION,
     "physical" DOUBLE PRECISION,
     "psychological" DOUBLE PRECISION,
     "social" DOUBLE PRECISION,
     "overall" DOUBLE PRECISION,
     "notes" TEXT,
     "evaluatedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AthleteEvaluation_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "AthleteEvaluation_athlete_idx" ON "AthleteEvaluation" ("tournamentId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "AthleteEvaluation_user_idx" ON "AthleteEvaluation" ("userId")`,
  // Fila de saída do WhatsApp (ponte não-oficial via QR). A ponte externa puxa os
  // PENDING, envia e marca SENT/FAILED. Só é alimentada se WA_BRIDGE_KEY existir.
  `CREATE TABLE IF NOT EXISTS "WhatsAppOutbox" (
     "id" TEXT NOT NULL,
     "phone" TEXT NOT NULL,
     "body" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "error" TEXT,
     "userId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "sentAt" TIMESTAMP(3),
     CONSTRAINT "WhatsAppOutbox_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "WhatsAppOutbox_status_idx" ON "WhatsAppOutbox" ("status", "createdAt")`,
  // CRM da comunicação (WhatsApp/Instagram) — S&T, Baratão e Meta Fardamentos separados por "empresa".
  `CREATE TABLE IF NOT EXISTS "CrmContact" (
     "id" TEXT NOT NULL,
     "empresa" TEXT NOT NULL,
     "phone" TEXT NOT NULL,
     "name" TEXT,
     "nameSource" TEXT,
     "nameState" TEXT,
     "nameAskedAt" TIMESTAMP(3),
     "pendingText" TEXT,
     "profileName" TEXT,
     "instagram" TEXT,
     "firstChannel" TEXT NOT NULL,
     "lastChannel" TEXT NOT NULL,
     "storeCode" TEXT,
     "userId" TEXT,
     "notes" TEXT,
     "messages" INTEGER NOT NULL DEFAULT 0,
     "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "CrmContact_empresa_phone_key" ON "CrmContact" ("empresa", "phone")`,
  `CREATE INDEX IF NOT EXISTS "CrmContact_empresa_lastSeenAt_idx" ON "CrmContact" ("empresa", "lastSeenAt")`,
  // REDE NEURAL DE AGENTES (RNA) — docs/REDE-NEURAL-DE-AGENTES.md
  "CREATE TABLE IF NOT EXISTS \"RnaNeuronio\" (\n    \"id\" TEXT NOT NULL,\n    \"camada\" TEXT NOT NULL,\n    \"ativo\" BOOLEAN NOT NULL DEFAULT true,\n    \"limiar\" DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n    \"acertos\" INTEGER NOT NULL DEFAULT 0,\n    \"erros\" INTEGER NOT NULL DEFAULT 0,\n    \"disparos\" INTEGER NOT NULL DEFAULT 0,\n    \"custoRS\" DOUBLE PRECISION NOT NULL DEFAULT 0,\n    \"ultimoUso\" TIMESTAMP(3),\n    \"atualizadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaNeuronio_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaSinapse\" (\n    \"id\" TEXT NOT NULL,\n    \"origem\" TEXT NOT NULL,\n    \"destino\" TEXT NOT NULL,\n    \"peso\" DOUBLE PRECISION NOT NULL DEFAULT 0.5,\n\n    CONSTRAINT \"RnaSinapse_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaSinal\" (\n    \"id\" TEXT NOT NULL,\n    \"tipo\" TEXT NOT NULL,\n    \"origem\" TEXT NOT NULL,\n    \"forca\" DOUBLE PRECISION NOT NULL,\n    \"impactoRS\" DOUBLE PRECISION,\n    \"loja\" TEXT,\n    \"objetivoId\" TEXT,\n    \"traceId\" TEXT NOT NULL,\n    \"profundidade\" INTEGER NOT NULL DEFAULT 0,\n    \"externo\" BOOLEAN NOT NULL DEFAULT false,\n    \"dados\" JSONB NOT NULL,\n    \"criadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaSinal_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaAtivacao\" (\n    \"id\" TEXT NOT NULL,\n    \"neuronio\" TEXT NOT NULL,\n    \"sinalId\" TEXT NOT NULL,\n    \"traceId\" TEXT NOT NULL,\n    \"status\" TEXT NOT NULL,\n    \"custoRS\" DOUBLE PRECISION NOT NULL DEFAULT 0,\n    \"ms\" INTEGER NOT NULL DEFAULT 0,\n    \"ativacao\" DOUBLE PRECISION,\n    \"saida\" JSONB,\n    \"erro\" TEXT,\n    \"criadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaAtivacao_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaObjetivo\" (\n    \"id\" TEXT NOT NULL,\n    \"texto\" TEXT NOT NULL,\n    \"kpis\" JSONB NOT NULL,\n    \"regiao\" TEXT[] DEFAULT ARRAY[]::TEXT[],\n    \"restricoes\" TEXT[] DEFAULT ARRAY[]::TEXT[],\n    \"orcamento\" JSONB NOT NULL,\n    \"gastoRS\" DOUBLE PRECISION NOT NULL DEFAULT 0,\n    \"ativacoes\" INTEGER NOT NULL DEFAULT 0,\n    \"loja\" TEXT,\n    \"prazo\" TIMESTAMP(3),\n    \"status\" TEXT NOT NULL DEFAULT 'ativo',\n    \"resultado\" JSONB,\n    \"criadoPor\" TEXT NOT NULL,\n    \"criadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaObjetivo_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaQuadro\" (\n    \"id\" TEXT NOT NULL,\n    \"objetivoId\" TEXT NOT NULL,\n    \"chave\" TEXT NOT NULL,\n    \"valor\" JSONB NOT NULL,\n    \"autor\" TEXT NOT NULL,\n    \"criadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaQuadro_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE TABLE IF NOT EXISTS \"RnaAjustePeso\" (\n    \"id\" TEXT NOT NULL,\n    \"alvo\" TEXT NOT NULL,\n    \"de\" DOUBLE PRECISION NOT NULL,\n    \"para\" DOUBLE PRECISION NOT NULL,\n    \"motivo\" TEXT NOT NULL,\n    \"traceId\" TEXT,\n    \"aprovacaoId\" TEXT,\n    \"criadoEm\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,\n\n    CONSTRAINT \"RnaAjustePeso_pkey\" PRIMARY KEY (\"id\")\n)",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"RnaSinapse_origem_destino_key\" ON \"RnaSinapse\"(\"origem\", \"destino\")",
  "CREATE INDEX IF NOT EXISTS \"RnaSinal_traceId_idx\" ON \"RnaSinal\"(\"traceId\")",
  "CREATE INDEX IF NOT EXISTS \"RnaSinal_tipo_criadoEm_idx\" ON \"RnaSinal\"(\"tipo\", \"criadoEm\")",
  "CREATE INDEX IF NOT EXISTS \"RnaSinal_objetivoId_idx\" ON \"RnaSinal\"(\"objetivoId\")",
  "CREATE INDEX IF NOT EXISTS \"RnaAtivacao_traceId_idx\" ON \"RnaAtivacao\"(\"traceId\")",
  "CREATE INDEX IF NOT EXISTS \"RnaAtivacao_neuronio_criadoEm_idx\" ON \"RnaAtivacao\"(\"neuronio\", \"criadoEm\")",
  "CREATE UNIQUE INDEX IF NOT EXISTS \"RnaAtivacao_neuronio_sinalId_key\" ON \"RnaAtivacao\"(\"neuronio\", \"sinalId\")",
  "CREATE INDEX IF NOT EXISTS \"RnaObjetivo_status_idx\" ON \"RnaObjetivo\"(\"status\")",
  "CREATE INDEX IF NOT EXISTS \"RnaQuadro_objetivoId_chave_idx\" ON \"RnaQuadro\"(\"objetivoId\", \"chave\")",
  "CREATE INDEX IF NOT EXISTS \"RnaAjustePeso_alvo_criadoEm_idx\" ON \"RnaAjustePeso\"(\"alvo\", \"criadoEm\")",
  // MEDALHAS DIGITAIS (Open Badges 3.0) — emissor, template por evento, medalha, histórico.
  `CREATE TABLE IF NOT EXISTS "MedalIssuer" (
     "id" TEXT NOT NULL,
     "slug" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "kind" TEXT NOT NULL DEFAULT 'ORGANIZER',
     "ownerUserId" TEXT NOT NULL,
     "signatoryName" TEXT,
     "url" TEXT,
     "logoUrl" TEXT,
     "did" TEXT NOT NULL,
     "publicJwk" JSONB NOT NULL,
     "privateKeySealed" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MedalIssuer_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MedalIssuer_slug_key" ON "MedalIssuer" ("slug")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "MedalIssuer_did_key" ON "MedalIssuer" ("did")`,
  `CREATE INDEX IF NOT EXISTS "MedalIssuer_ownerUserId_idx" ON "MedalIssuer" ("ownerUserId")`,
  `CREATE TABLE IF NOT EXISTS "MedalTemplate" (
     "id" TEXT NOT NULL,
     "issuerId" TEXT NOT NULL,
     "tournamentId" TEXT,
     "name" TEXT NOT NULL,
     "sport" TEXT NOT NULL,
     "circuit" TEXT,
     "design" JSONB NOT NULL,
     "version" INTEGER NOT NULL DEFAULT 1,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MedalTemplate_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "MedalTemplate_issuerId_idx" ON "MedalTemplate" ("issuerId")`,
  `CREATE INDEX IF NOT EXISTS "MedalTemplate_tournamentId_idx" ON "MedalTemplate" ("tournamentId")`,
  `CREATE TABLE IF NOT EXISTS "Medal" (
     "id" TEXT NOT NULL,
     "serial" TEXT NOT NULL,
     "credentialId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "issuerId" TEXT NOT NULL,
     "templateId" TEXT NOT NULL,
     "tournamentId" TEXT,
     "categoryId" TEXT,
     "entryId" TEXT,
     "sport" TEXT NOT NULL,
     "series" TEXT NOT NULL,
     "eventName" TEXT NOT NULL,
     "categoryName" TEXT,
     "achievement" TEXT NOT NULL DEFAULT 'PLACEMENT',
     "tier" TEXT NOT NULL,
     "placement" INTEGER,
     "distinctions" TEXT[] DEFAULT ARRAY[]::TEXT[],
     "editionNumber" INTEGER NOT NULL,
     "editionTotal" INTEGER NOT NULL,
     "recipientName" TEXT NOT NULL,
     "identitySalt" TEXT NOT NULL,
     "identityHash" TEXT NOT NULL,
     "result" JSONB,
     "eventDate" TIMESTAMP(3),
     "credentialJwt" TEXT NOT NULL,
     "verificationCode" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
     "issuedByUserId" TEXT NOT NULL,
     "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "revokedAt" TIMESTAMP(3),
     CONSTRAINT "Medal_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Medal_serial_key" ON "Medal" ("serial")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Medal_credentialId_key" ON "Medal" ("credentialId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Medal_tournamentId_categoryId_userId_achievement_key" ON "Medal" ("tournamentId", "categoryId", "userId", "achievement")`,
  `CREATE INDEX IF NOT EXISTS "Medal_userId_status_idx" ON "Medal" ("userId", "status")`,
  `CREATE INDEX IF NOT EXISTS "Medal_issuerId_idx" ON "Medal" ("issuerId")`,
  `CREATE INDEX IF NOT EXISTS "Medal_series_idx" ON "Medal" ("series")`,
  `CREATE TABLE IF NOT EXISTS "MedalStatusEvent" (
     "id" TEXT NOT NULL,
     "medalId" TEXT NOT NULL,
     "action" TEXT NOT NULL,
     "reason" TEXT,
     "note" TEXT,
     "actorUserId" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "MedalStatusEvent_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "MedalStatusEvent_medalId_createdAt_idx" ON "MedalStatusEvent" ("medalId", "createdAt")`,
  // F2 — Patrocinadores do torneio (faixa na página pública, telão e artes)
  `CREATE TABLE IF NOT EXISTS "TournamentSponsor" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "logoUrl" TEXT,
     "link" TEXT,
     "ordering" INTEGER NOT NULL DEFAULT 0,
     "active" BOOLEAN NOT NULL DEFAULT true,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentSponsor_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "TournamentSponsor_tournamentId_ordering_idx" ON "TournamentSponsor" ("tournamentId", "ordering")`,
  // Número de série sequencial e sem colisão (CST-2026-000123)
  `CREATE SEQUENCE IF NOT EXISTS "MedalSerialSeq" START 1`,
  // Lembrete automático de treino/jogo (~3h antes): marca pra não lembrar 2x.
  `ALTER TABLE "TrainingSession" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3)`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3)`,
  // Calendário da equipe (.ics por vendedor): guarda só a VERSÃO do link pessoal.
  // O token é HMAC(segredo, vendedor+versão) — não fica salvo; trocar a versão invalida o link antigo.
  `CREATE TABLE IF NOT EXISTS "TeamCalendarFeed" (
     "sellerId" TEXT NOT NULL,
     "version" INTEGER NOT NULL DEFAULT 1,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "rotatedAt" TIMESTAMP(3),
     CONSTRAINT "TeamCalendarFeed_pkey" PRIMARY KEY ("sellerId")
   )`,
  // ===================================================================
  // CLUB F3 — inscrição paga, cupom, cobrança PIX, auditoria e check-in.
  // Dinheiro sempre em centavos (INTEGER). Tabelas soltas (sem FK).
  // ===================================================================
  `CREATE TABLE IF NOT EXISTS "TournamentRegistrationConfig" (
     "tournamentId" TEXT NOT NULL,
     "enabled" BOOLEAN NOT NULL DEFAULT false,
     "categories" JSONB,
     "customFields" JSONB,
     "termsText" TEXT,
     "termsVersion" INTEGER NOT NULL DEFAULT 1,
     "holdMinutes" INTEGER NOT NULL DEFAULT 60,
     "waitlistHoldHours" INTEGER NOT NULL DEFAULT 24,
     "allowTenisCash" BOOLEAN NOT NULL DEFAULT true,
     "allowOnsite" BOOLEAN NOT NULL DEFAULT false,
     "cashbackPct" INTEGER NOT NULL DEFAULT 0,
     "paymentStoreId" TEXT,
     "checkinToleranceMin" INTEGER NOT NULL DEFAULT 15,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentRegistrationConfig_pkey" PRIMARY KEY ("tournamentId")
   )`,
  `CREATE TABLE IF NOT EXISTS "TournamentRegistration" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "categoryId" TEXT NOT NULL,
     "kind" TEXT NOT NULL DEFAULT 'ATHLETE',
     "displayName" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
     "userId" TEXT,
     "contactName" TEXT NOT NULL,
     "contactPhone" TEXT NOT NULL,
     "contactEmail" TEXT,
     "athletes" JSONB,
     "roster" JSONB,
     "answers" JSONB,
     "termsVersion" INTEGER,
     "termsHash" TEXT,
     "termsAcceptedAt" TIMESTAMP(3),
     "termsIp" TEXT,
     "termsUserAgent" TEXT,
     "feeCents" INTEGER NOT NULL DEFAULT 0,
     "discountCents" INTEGER NOT NULL DEFAULT 0,
     "couponId" TEXT,
     "couponCode" TEXT,
     "tcCents" INTEGER NOT NULL DEFAULT 0,
     "tcTxId" TEXT,
     "tcRefundTxId" TEXT,
     "paidCents" INTEGER NOT NULL DEFAULT 0,
     "paymentMethod" TEXT,
     "paymentExpiresAt" TIMESTAMP(3),
     "paidAt" TIMESTAMP(3),
     "confirmedAt" TIMESTAMP(3),
     "entryId" TEXT,
     "publicToken" TEXT NOT NULL,
     "checkinToken" TEXT NOT NULL,
     "cashbackCents" INTEGER NOT NULL DEFAULT 0,
     "cashbackUserId" TEXT,
     "cashbackTxId" TEXT,
     "cashbackAt" TIMESTAMP(3),
     "cashbackStatus" TEXT,
     "promotedAt" TIMESTAMP(3),
     "refundStatus" TEXT,
     "refundReason" TEXT,
     "refundRequestedAt" TIMESTAMP(3),
     "refundedAt" TIMESTAMP(3),
     "refundedBy" TEXT,
     "refundNote" TEXT,
     "refundCents" INTEGER NOT NULL DEFAULT 0,
     "canceledAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentRegistration_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentRegistration_publicToken_key" ON "TournamentRegistration" ("publicToken")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentRegistration_checkinToken_key" ON "TournamentRegistration" ("checkinToken")`,
  `CREATE INDEX IF NOT EXISTS "TournamentRegistration_tournamentId_status_idx" ON "TournamentRegistration" ("tournamentId", "status")`,
  `CREATE INDEX IF NOT EXISTS "TournamentRegistration_categoryId_status_idx" ON "TournamentRegistration" ("categoryId", "status")`,
  `CREATE INDEX IF NOT EXISTS "TournamentRegistration_userId_idx" ON "TournamentRegistration" ("userId")`,
  `CREATE TABLE IF NOT EXISTS "TournamentPaymentCharge" (
     "id" TEXT NOT NULL,
     "registrationId" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "provider" TEXT NOT NULL DEFAULT 'pagbank',
     "storeId" TEXT,
     "providerOrderId" TEXT,
     "amountCents" INTEGER NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "qrText" TEXT,
     "qrPngUrl" TEXT,
     "expiresAt" TIMESTAMP(3),
     "paidAt" TIMESTAMP(3),
     "paidCents" INTEGER,
     "e2e" TEXT,
     "lastCheckedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentPaymentCharge_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentPaymentCharge_providerOrderId_key" ON "TournamentPaymentCharge" ("providerOrderId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentPaymentCharge_registrationId_idx" ON "TournamentPaymentCharge" ("registrationId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentPaymentCharge_tournamentId_status_idx" ON "TournamentPaymentCharge" ("tournamentId", "status")`,
  `CREATE TABLE IF NOT EXISTS "TournamentCoupon" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "code" TEXT NOT NULL,
     "kind" TEXT NOT NULL DEFAULT 'PERCENT',
     "value" INTEGER NOT NULL,
     "maxUses" INTEGER,
     "usedCount" INTEGER NOT NULL DEFAULT 0,
     "active" BOOLEAN NOT NULL DEFAULT true,
     "expiresAt" TIMESTAMP(3),
     "createdBy" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentCoupon_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentCoupon_tournamentId_code_key" ON "TournamentCoupon" ("tournamentId", "code")`,
  `CREATE TABLE IF NOT EXISTS "TournamentRegistrationAudit" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "registrationId" TEXT,
     "action" TEXT NOT NULL,
     "actorUserId" TEXT,
     "note" TEXT,
     "data" JSONB,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentRegistrationAudit_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "TournamentRegistrationAudit_tournamentId_createdAt_idx" ON "TournamentRegistrationAudit" ("tournamentId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "TournamentRegistrationAudit_registrationId_idx" ON "TournamentRegistrationAudit" ("registrationId")`,
  `CREATE TABLE IF NOT EXISTS "TournamentCheckin" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "registrationId" TEXT NOT NULL,
     "entryId" TEXT,
     "scopeKey" TEXT NOT NULL,
     "matchId" TEXT,
     "method" TEXT NOT NULL DEFAULT 'QR',
     "checkedBy" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "TournamentCheckin_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "TournamentCheckin_registrationId_scopeKey_key" ON "TournamentCheckin" ("registrationId", "scopeKey")`,
  `CREATE INDEX IF NOT EXISTS "TournamentCheckin_tournamentId_scopeKey_idx" ON "TournamentCheckin" ("tournamentId", "scopeKey")`,
  // ---------------------------------------------------------------
  // F5 — Ranking Glicko-2, push do Club e clube permanente (aditivo)
  // ---------------------------------------------------------------
  // Club/ClubMembership já existem em prod (schema de 05/2026); o CREATE é
  // só rede de segurança idêntica ao que o Prisma criaria.
  `CREATE TABLE IF NOT EXISTS "Club" (
     "id" TEXT NOT NULL,
     "ownerId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "description" TEXT,
     "sportScope" TEXT,
     "privacyLevel" TEXT NOT NULL DEFAULT 'public',
     "city" TEXT,
     "state" TEXT,
     "country" TEXT NOT NULL DEFAULT 'BR',
     "storeId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "Club_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "Club_city_idx" ON "Club" ("city")`,
  `CREATE INDEX IF NOT EXISTS "Club_sportScope_idx" ON "Club" ("sportScope")`,
  `CREATE INDEX IF NOT EXISTS "Club_storeId_idx" ON "Club" ("storeId")`,
  `CREATE TABLE IF NOT EXISTS "ClubMembership" (
     "id" TEXT NOT NULL,
     "clubId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "role" TEXT NOT NULL DEFAULT 'member',
     "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ClubMembership_pkey" PRIMARY KEY ("id"),
     CONSTRAINT "ClubMembership_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE,
     CONSTRAINT "ClubMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ClubMembership_clubId_userId_key" ON "ClubMembership" ("clubId", "userId")`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "slug" TEXT`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "crestUrl" TEXT`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "primaryColor" TEXT`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "secondaryColor" TEXT`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "sports" TEXT[] DEFAULT ARRAY[]::TEXT[]`,
  `ALTER TABLE "Club" ADD COLUMN IF NOT EXISTS "inviteCode" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Club_slug_key" ON "Club" ("slug")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Club_inviteCode_key" ON "Club" ("inviteCode")`,
  `ALTER TABLE "ClubMembership" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE'`,
  `ALTER TABLE "ClubMembership" ADD COLUMN IF NOT EXISTS "invitedByUserId" TEXT`,
  `ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "app" TEXT`,
  `CREATE TABLE IF NOT EXISTS "ClubTournamentLink" (
     "id" TEXT NOT NULL,
     "clubId" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "entryName" TEXT NOT NULL,
     "createdByUserId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ClubTournamentLink_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "ClubTournamentLink_tournamentId_entryName_idx" ON "ClubTournamentLink" ("tournamentId", "entryName")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ClubTournamentLink_clubId_tournamentId_entryName_key" ON "ClubTournamentLink" ("clubId", "tournamentId", "entryName")`,
  `CREATE TABLE IF NOT EXISTS "GlickoRating" (
     "id" TEXT NOT NULL,
     "sport" TEXT NOT NULL,
     "format" TEXT NOT NULL,
     "subjectType" TEXT NOT NULL,
     "subjectKey" TEXT NOT NULL,
     "userId" TEXT,
     "teamName" TEXT,
     "rating" DOUBLE PRECISION NOT NULL DEFAULT 1500,
     "rd" DOUBLE PRECISION NOT NULL DEFAULT 350,
     "volatility" DOUBLE PRECISION NOT NULL DEFAULT 0.06,
     "matches" INTEGER NOT NULL DEFAULT 0,
     "wins" INTEGER NOT NULL DEFAULT 0,
     "draws" INTEGER NOT NULL DEFAULT 0,
     "losses" INTEGER NOT NULL DEFAULT 0,
     "lastPeriod" INTEGER,
     "lastMatchAt" TIMESTAMP(3),
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "GlickoRating_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "GlickoRating_sport_format_rating_idx" ON "GlickoRating" ("sport", "format", "rating")`,
  `CREATE INDEX IF NOT EXISTS "GlickoRating_userId_idx" ON "GlickoRating" ("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "GlickoRating_sport_format_subjectType_subjectKey_key" ON "GlickoRating" ("sport", "format", "subjectType", "subjectKey")`,
  `CREATE TABLE IF NOT EXISTS "ClubNotifyPref" (
     "userId" TEXT NOT NULL,
     "push" BOOLEAN NOT NULL DEFAULT true,
     "types" JSONB,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "ClubNotifyPref_pkey" PRIMARY KEY ("userId")
   )`,
  `CREATE TABLE IF NOT EXISTS "ClubPushLog" (
     "id" TEXT NOT NULL,
     "key" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ClubPushLog_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ClubPushLog_key_key" ON "ClubPushLog" ("key")`,
  // MOTOR DE CAMPEONATO (F1) — tudo aditivo; null/false = comportamento antigo.
  // Temporadas: série/edição ligando as edições do mesmo campeonato.
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "seriesSlug" TEXT`,
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "seriesName" TEXT`,
  `ALTER TABLE "Tournament" ADD COLUMN IF NOT EXISTS "edition" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Tournament_seriesSlug_idx" ON "Tournament" ("seriesSlug")`,
  // Categoria: desempate configurável, semente do sorteio, ida e volta, suspensão, formato.
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "tiebreakers" JSONB`,
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "tiebreakSeed" TEXT`,
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "doubleRound" BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "suspensionRule" JSONB`,
  `ALTER TABLE "TournamentCategory" ADD COLUMN IF NOT EXISTS "formatConfig" JSONB`,
  // Partida: dupla eliminação (chave + destino do perdedor), duplas do Americano, escalação.
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "bracket" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "loserNextMatchId" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "loserNextSlot" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "homeEntry2Id" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "awayEntry2Id" TEXT`,
  `ALTER TABLE "TournamentMatch" ADD COLUMN IF NOT EXISTS "lineup" JSONB`,
  // Classificação: fair play + critério que decidiu a posição.
  `ALTER TABLE "TournamentStanding" ADD COLUMN IF NOT EXISTS "fairPlay" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE "TournamentStanding" ADD COLUMN IF NOT EXISTS "tiebreak" TEXT`,
  // Auditoria: atleta suspenso liberado pelo árbitro/coordenador (com motivo).
  `CREATE TABLE IF NOT EXISTS "SuspensionOverride" (
     "id" TEXT NOT NULL,
     "tournamentId" TEXT NOT NULL,
     "categoryId" TEXT,
     "matchId" TEXT NOT NULL,
     "playerId" TEXT NOT NULL,
     "entryId" TEXT NOT NULL,
     "action" TEXT NOT NULL,
     "eventType" TEXT,
     "reason" TEXT NOT NULL,
     "userId" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "SuspensionOverride_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "SuspensionOverride_tournamentId_idx" ON "SuspensionOverride" ("tournamentId")`,
  `CREATE INDEX IF NOT EXISTS "SuspensionOverride_matchId_idx" ON "SuspensionOverride" ("matchId")`,
  `CREATE INDEX IF NOT EXISTS "SuspensionOverride_playerId_idx" ON "SuspensionOverride" ("playerId")`,
  // ---------------------------------------------------------------
  // F4 — App de atividade (gravar/importar, segmentos, badges, desafios,
  // Beacon, privacidade). As tabelas APEX estavam só no schema: o deploy
  // não roda db push, então elas nascem aqui (IF NOT EXISTS) e as colunas
  // novas entram com ADD COLUMN IF NOT EXISTS caso a tabela já exista.
  // FKs de cascata em DO-block (ignora se já existe ou se há órfão).
  // ---------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS "Activity" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "sportType" TEXT NOT NULL,
     "startedAt" TIMESTAMP(3) NOT NULL,
     "endedAt" TIMESTAMP(3),
     "elapsedTimeS" INTEGER NOT NULL,
     "movingTimeS" INTEGER NOT NULL,
     "distanceM" DOUBLE PRECISION,
     "elevationGainM" DOUBLE PRECISION,
     "elevationLossM" DOUBLE PRECISION,
     "avgHeartRate" INTEGER,
     "maxHeartRate" INTEGER,
     "avgPace" DOUBLE PRECISION,
     "maxSpeed" DOUBLE PRECISION,
     "avgPower" DOUBLE PRECISION,
     "calories" INTEGER,
     "trainingLoad" DOUBLE PRECISION,
     "hrTSS" DOUBLE PRECISION,
     "summaryPolyline" TEXT,
     "visibility" TEXT NOT NULL DEFAULT 'followers',
     "deviceSource" TEXT,
     "rawPayloadRef" TEXT,
     "startPrivacyRadiusM" INTEGER NOT NULL DEFAULT 250,
     "endPrivacyRadiusM" INTEGER NOT NULL DEFAULT 250,
     "processingState" TEXT NOT NULL DEFAULT 'pending',
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     "title" TEXT,
     "description" TEXT,
     "clientId" TEXT,
     "streams" JSONB,
     CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "ActivityLap" (
     "id" TEXT NOT NULL,
     "activityId" TEXT NOT NULL,
     "lapNumber" INTEGER NOT NULL,
     "startedAt" TIMESTAMP(3) NOT NULL,
     "elapsedTimeS" INTEGER NOT NULL,
     "distanceM" DOUBLE PRECISION,
     "avgPace" DOUBLE PRECISION,
     "avgHeartRate" INTEGER,
     CONSTRAINT "ActivityLap_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "ActivityPhoto" (
     "id" TEXT NOT NULL,
     "activityId" TEXT NOT NULL,
     "imageUrl" TEXT NOT NULL,
     "takenAt" TIMESTAMP(3),
     "latitude" DOUBLE PRECISION,
     "longitude" DOUBLE PRECISION,
     CONSTRAINT "ActivityPhoto_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "Segment" (
     "id" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "sportType" TEXT NOT NULL,
     "polyline" TEXT NOT NULL,
     "distanceM" DOUBLE PRECISION NOT NULL,
     "elevationGainM" DOUBLE PRECISION NOT NULL,
     "visibility" TEXT NOT NULL DEFAULT 'public',
     "verificationState" TEXT NOT NULL DEFAULT 'auto',
     "geomHash" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "creatorId" TEXT,
     "sourceActivityId" TEXT,
     "startLat" DOUBLE PRECISION,
     "startLng" DOUBLE PRECISION,
     "endLat" DOUBLE PRECISION,
     "endLng" DOUBLE PRECISION,
     CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "SegmentEffort" (
     "id" TEXT NOT NULL,
     "segmentId" TEXT NOT NULL,
     "activityId" TEXT NOT NULL,
     "athleteId" TEXT NOT NULL,
     "elapsedMs" INTEGER NOT NULL,
     "startedAt" TIMESTAMP(3) NOT NULL,
     "avgHeartRate" INTEGER,
     "avgPower" DOUBLE PRECISION,
     "rankType" TEXT NOT NULL DEFAULT 'user',
     "flaggedFraud" BOOLEAN NOT NULL DEFAULT false,
     CONSTRAINT "SegmentEffort_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "Challenge" (
     "id" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "description" TEXT,
     "ruleType" TEXT NOT NULL,
     "ruleConfig" JSONB NOT NULL,
     "startsAt" TIMESTAMP(3) NOT NULL,
     "endsAt" TIMESTAMP(3) NOT NULL,
     "prizeType" TEXT,
     "prizeValue" DOUBLE PRECISION,
     "sponsorId" TEXT,
     "visibility" TEXT NOT NULL DEFAULT 'public',
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "kind" TEXT NOT NULL DEFAULT 'official',
     "ownerId" TEXT,
     "inviteCode" TEXT,
     "badgeKey" TEXT,
     CONSTRAINT "Challenge_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "ChallengeParticipation" (
     "id" TEXT NOT NULL,
     "challengeId" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "progressValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
     "completedAt" TIMESTAMP(3),
     "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ChallengeParticipation_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "BadgeEarned" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "badgeKey" TEXT NOT NULL,
     "earnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "xpAwarded" INTEGER NOT NULL DEFAULT 0,
     "cashbackAwarded" DOUBLE PRECISION NOT NULL DEFAULT 0,
     "metadata" JSONB,
     CONSTRAINT "BadgeEarned_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "LiveTrackingSession" (
     "id" TEXT NOT NULL,
     "activityId" TEXT NOT NULL,
     "ownerId" TEXT NOT NULL,
     "shareTokenHash" TEXT NOT NULL,
     "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "revokedAt" TIMESTAMP(3),
     "viewerCount" INTEGER NOT NULL DEFAULT 0,
     "lastLat" DOUBLE PRECISION,
     "lastLng" DOUBLE PRECISION,
     "lastAt" TIMESTAMP(3),
     "trail" JSONB,
     CONSTRAINT "LiveTrackingSession_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "SafetyContact" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "name" TEXT NOT NULL,
     "phone" TEXT,
     "email" TEXT,
     "relationship" TEXT,
     "notifyOnLive" BOOLEAN NOT NULL DEFAULT true,
     "notifyOnDistress" BOOLEAN NOT NULL DEFAULT true,
     CONSTRAINT "SafetyContact_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "Consent" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "scope" TEXT NOT NULL,
     "granted" BOOLEAN NOT NULL,
     "version" TEXT NOT NULL,
     "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "revokedAt" TIMESTAMP(3),
     CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "AthleteProfile" (
     "userId" TEXT NOT NULL,
     "username" TEXT,
     "goals" JSONB,
     "experienceLevel" TEXT,
     "zones" JSONB,
     "privacyDefaults" JSONB,
     "birthYear" INTEGER,
     "sex" TEXT,
     "bio" TEXT,
     "avatarUrl" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" TIMESTAMP(3) NOT NULL,
     CONSTRAINT "AthleteProfile_pkey" PRIMARY KEY ("userId")
     );`,
  `CREATE TABLE IF NOT EXISTS "ActivityPrivacyZone" (
     "id" TEXT NOT NULL,
     "userId" TEXT NOT NULL,
     "lat" DOUBLE PRECISION NOT NULL,
     "lng" DOUBLE PRECISION NOT NULL,
     "radiusM" INTEGER NOT NULL DEFAULT 300,
     "label" TEXT,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ActivityPrivacyZone_pkey" PRIMARY KEY ("id")
     );`,
  `CREATE TABLE IF NOT EXISTS "AthleteFollow" (
     "id" TEXT NOT NULL,
     "followerId" TEXT NOT NULL,
     "followeeId" TEXT NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AthleteFollow_pkey" PRIMARY KEY ("id")
     );`,
  `ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "title" TEXT`,
  `ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "description" TEXT`,
  `ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "clientId" TEXT`,
  `ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "streams" JSONB`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "creatorId" TEXT`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "sourceActivityId" TEXT`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "startLat" DOUBLE PRECISION`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "startLng" DOUBLE PRECISION`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "endLat" DOUBLE PRECISION`,
  `ALTER TABLE "Segment" ADD COLUMN IF NOT EXISTS "endLng" DOUBLE PRECISION`,
  `ALTER TABLE "Challenge" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'official'`,
  `ALTER TABLE "Challenge" ADD COLUMN IF NOT EXISTS "ownerId" TEXT`,
  `ALTER TABLE "Challenge" ADD COLUMN IF NOT EXISTS "inviteCode" TEXT`,
  `ALTER TABLE "Challenge" ADD COLUMN IF NOT EXISTS "badgeKey" TEXT`,
  `ALTER TABLE "LiveTrackingSession" ADD COLUMN IF NOT EXISTS "lastLat" DOUBLE PRECISION`,
  `ALTER TABLE "LiveTrackingSession" ADD COLUMN IF NOT EXISTS "lastLng" DOUBLE PRECISION`,
  `ALTER TABLE "LiveTrackingSession" ADD COLUMN IF NOT EXISTS "lastAt" TIMESTAMP(3)`,
  `ALTER TABLE "LiveTrackingSession" ADD COLUMN IF NOT EXISTS "trail" JSONB`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AthleteProfile_username_key" ON "AthleteProfile"("username")`,
  `CREATE INDEX IF NOT EXISTS "Consent_userId_scope_idx" ON "Consent"("userId", "scope")`,
  `CREATE INDEX IF NOT EXISTS "Activity_userId_startedAt_idx" ON "Activity"("userId", "startedAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS "Activity_sportType_startedAt_idx" ON "Activity"("sportType", "startedAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Activity_userId_clientId_key" ON "Activity"("userId", "clientId")`,
  `CREATE INDEX IF NOT EXISTS "Segment_startLat_startLng_idx" ON "Segment"("startLat", "startLng")`,
  `CREATE INDEX IF NOT EXISTS "Segment_sportType_idx" ON "Segment"("sportType")`,
  `CREATE INDEX IF NOT EXISTS "Segment_geomHash_idx" ON "Segment"("geomHash")`,
  `CREATE INDEX IF NOT EXISTS "SegmentEffort_segmentId_elapsedMs_idx" ON "SegmentEffort"("segmentId", "elapsedMs")`,
  `CREATE INDEX IF NOT EXISTS "SegmentEffort_athleteId_idx" ON "SegmentEffort"("athleteId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "SegmentEffort_segmentId_activityId_startedAt_key" ON "SegmentEffort"("segmentId", "activityId", "startedAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "Challenge_inviteCode_key" ON "Challenge"("inviteCode")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ChallengeParticipation_challengeId_userId_key" ON "ChallengeParticipation"("challengeId", "userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "LiveTrackingSession_shareTokenHash_key" ON "LiveTrackingSession"("shareTokenHash")`,
  `CREATE INDEX IF NOT EXISTS "LiveTrackingSession_expiresAt_idx" ON "LiveTrackingSession"("expiresAt")`,
  `CREATE INDEX IF NOT EXISTS "ActivityPrivacyZone_userId_idx" ON "ActivityPrivacyZone"("userId")`,
  `CREATE INDEX IF NOT EXISTS "AthleteFollow_followeeId_idx" ON "AthleteFollow"("followeeId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "AthleteFollow_followerId_followeeId_key" ON "AthleteFollow"("followerId", "followeeId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "BadgeEarned_userId_badgeKey_key" ON "BadgeEarned"("userId", "badgeKey")`,
  `DO $$ BEGIN ALTER TABLE "ActivityLap" ADD CONSTRAINT "ActivityLap_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "ActivityPhoto" ADD CONSTRAINT "ActivityPhoto_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "SegmentEffort" ADD CONSTRAINT "SegmentEffort_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "SegmentEffort" ADD CONSTRAINT "SegmentEffort_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "LiveTrackingSession" ADD CONSTRAINT "LiveTrackingSession_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,
  `DO $$ BEGIN ALTER TABLE "ChallengeParticipation" ADD CONSTRAINT "ChallengeParticipation_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "Challenge"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object OR invalid_foreign_key OR foreign_key_violation THEN NULL; END $$`,  // Liga Aberta F0 — código de verificação do cadastro de atleta (só o HASH do código)
  `CREATE TABLE IF NOT EXISTS "AthleteSignupCode" (
     "id" TEXT NOT NULL,
     "phone" TEXT NOT NULL,
     "codeHash" TEXT NOT NULL,
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "expiresAt" TIMESTAMP(3) NOT NULL,
     "usedAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "AthleteSignupCode_pkey" PRIMARY KEY ("id")
   )`,
  `CREATE INDEX IF NOT EXISTS "AthleteSignupCode_phone_createdAt_idx" ON "AthleteSignupCode"("phone", "createdAt")`,
  // Liga Aberta F5 (repetido para banco novo: as tabelas acima já existem aqui)
  `ALTER TABLE "TournamentPost" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT`,
  `CREATE INDEX IF NOT EXISTS "Tournament_ownerId_idx" ON "Tournament"("ownerId")`,
  `CREATE INDEX IF NOT EXISTS "Tournament_visibility_archivedAt_status_idx" ON "Tournament"("visibility", "archivedAt", "status")`,
  `CREATE INDEX IF NOT EXISTS "TournamentMatch_homeEntryId_idx" ON "TournamentMatch"("homeEntryId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentMatch_awayEntryId_idx" ON "TournamentMatch"("awayEntryId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentMatch_winnerEntryId_idx" ON "TournamentMatch"("winnerEntryId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentMatch_scheduledAt_idx" ON "TournamentMatch"("scheduledAt")`,
  `CREATE INDEX IF NOT EXISTS "TournamentMatch_categoryId_round_ordering_idx" ON "TournamentMatch"("categoryId", "round", "ordering")`,
  `CREATE INDEX IF NOT EXISTS "Club_ownerId_idx" ON "Club"("ownerId")`,
  `CREATE INDEX IF NOT EXISTS "Club_originTournamentId_idx" ON "Club"("originTournamentId")`,
  `CREATE INDEX IF NOT EXISTS "ClubMembership_userId_idx" ON "ClubMembership"("userId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentStanding_tournamentId_idx" ON "TournamentStanding"("tournamentId")`,
  `CREATE INDEX IF NOT EXISTS "TournamentPost_tournamentId_pinned_createdAt_idx" ON "TournamentPost"("tournamentId", "pinned", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "PickupAttendance_playerId_idx" ON "PickupAttendance"("playerId")`,
  // Liga Aberta F4 (repetido para banco novo: as tabelas acima já existem aqui)
  `ALTER TABLE "ClubNotifyPref" ADD COLUMN IF NOT EXISTS "whatsapp" JSONB`,
  `ALTER TABLE "TeamInvite" ADD COLUMN IF NOT EXISTS "publicToken" TEXT`,
  `ALTER TABLE "RosterInvite" ADD COLUMN IF NOT EXISTS "recoverable" BOOLEAN NOT NULL DEFAULT false`,
];

// Busca tolerante a erro (pg_trgm). Extensão + índices GIN de trigram em
// Product.name/brand/sku e ProductSize.barcode. Se o banco não deixar criar a
// extensão (permissão), a busca cai no LIKE — o boot segue normal.
// CONCURRENTLY: não trava gravação de produto/estoque enquanto o índice nasce.
async function ensureSearchIndexes(prisma) {
  const { SEARCH_INDEX_STATEMENTS, resetTrgmCache } = require('./productSearch');
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } catch (e) {
    console.warn('[busca] pg_trgm indisponível — busca de produto usa LIKE simples:', e.message);
    return { trgm: false, indexes: 0 };
  }
  resetTrgmCache();
  let indexes = 0;
  for (const sql of SEARCH_INDEX_STATEMENTS) {
    const name = (sql.match(/"([A-Za-z]+_[A-Za-z]+_trgm_idx)"/) || [])[1];
    try {
      // Um build CONCURRENTLY que caiu no meio deixa índice INVALID; refaz.
      const bad = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relname = $1 AND NOT i.indisvalid`, name);
      if (bad.length) await prisma.$executeRawUnsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
      await prisma.$executeRawUnsafe(sql.replace('CREATE INDEX IF NOT EXISTS', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS'));
      indexes += 1;
    } catch (e) {
      console.error('[busca] índice falhou:', name, e.message);
    }
  }
  return { trgm: true, indexes };
}

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
  try {
    const r = await ensureSearchIndexes(prisma);
    console.log(`[busca] pg_trgm=${r.trgm} índices=${r.indexes}`);
  } catch (e) {
    console.error('[busca] falha ao garantir índices:', e.message);
  }
  return ok;
}

module.exports = { ensureApexSchema, ensureSearchIndexes, STATEMENTS_TOTAL: () => STATEMENTS.length, STATEMENTS };
