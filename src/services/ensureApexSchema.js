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
  // Número de série sequencial e sem colisão (CST-2026-000123)
  `CREATE SEQUENCE IF NOT EXISTS "MedalSerialSeq" START 1`,
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
