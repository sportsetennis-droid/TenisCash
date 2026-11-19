-- Contracheque digital (folha do varejo). Aditivo e idempotente; valores em centavos.
-- Nada aqui apaga dado: fechamento gera versão; correção gera nova versão; cancelamento tem motivo.

-- Dados de contrato do funcionário (o vendedor/gerente é o User; aqui fica o vínculo).
CREATE TABLE IF NOT EXISTS "PayrollEmployeeProfile" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "issuerId" TEXT,
  "storeId" TEXT,
  "registration" TEXT,
  "jobTitle" TEXT,
  "cbo" TEXT,
  "contractType" TEXT NOT NULL DEFAULT 'MENSALISTA',
  "registered" BOOLEAN NOT NULL DEFAULT true,
  "admissionDate" TEXT,
  "terminationDate" TEXT,
  "baseSalaryCents" INTEGER,
  "hourlyRateCents" INTEGER,
  "weeklyMinutes" INTEGER NOT NULL DEFAULT 2640,
  "workDaysPerWeek" INTEGER NOT NULL DEFAULT 6,
  "shiftMinutes" INTEGER,
  "apprenticeContractRef" TEXT,
  "timeBankAgreementRef" TEXT,
  "irrfDependents" INTEGER NOT NULL DEFAULT 0,
  "familyAllowanceChildren" INTEGER NOT NULL DEFAULT 0,
  "vtOptIn" BOOLEAN NOT NULL DEFAULT false,
  "unionName" TEXT,
  "cctRef" TEXT,
  "cpfEnc" TEXT,
  "cpfLast4" TEXT,
  "bankEnc" TEXT,
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollEmployeeProfile_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollEmployeeProfile_userId_key" ON "PayrollEmployeeProfile"("userId")
-- @statement
-- Parâmetros legais e da convenção com vigência (INSS, IRRF, FGTS, VT, domingo, feriado...).
CREATE TABLE IF NOT EXISTS "PayrollParam" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "validFrom" TEXT NOT NULL,
  "validTo" TEXT,
  "issuerId" TEXT,
  "storeId" TEXT,
  "locality" TEXT,
  "unionName" TEXT,
  "category" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "source" TEXT,
  "documentRef" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollParam_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollParam_key_validFrom_idx" ON "PayrollParam"("key", "validFrom")
-- @statement
CREATE TABLE IF NOT EXISTS "PayrollHoliday" (
  "id" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL DEFAULT 'NACIONAL',
  "locality" TEXT,
  "storeId" TEXT,
  "source" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollHoliday_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "PayrollHoliday_date_scope_locality_key" ON "PayrollHoliday"("date", "scope", "locality")
-- @statement
-- Regras de comissão configuráveis (faixas, itens especiais, vigência, escopo).
CREATE TABLE IF NOT EXISTS "PayrollCommissionRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "validFrom" TEXT NOT NULL,
  "validTo" TEXT,
  "issuerId" TEXT,
  "storeId" TEXT,
  "userId" TEXT,
  "config" JSONB NOT NULL,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "previousId" TEXT,
  "notes" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollCommissionRule_pkey" PRIMARY KEY ("id")
)
-- @statement
-- Adiantamentos, vales, passagens, benefícios entregues, domingos/feriados pagos antes,
-- compras e descontos autorizados. Um lançamento só entra uma vez (competência própria).
CREATE TABLE IF NOT EXISTS "PayrollEntry" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "issuerId" TEXT,
  "storeId" TEXT,
  "competence" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "description" TEXT,
  "referenceDate" TEXT,
  "receiptRef" TEXT,
  "origin" TEXT,
  "pixRef" TEXT,
  "authorized" BOOLEAN NOT NULL DEFAULT false,
  "authorizationRef" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ATIVO',
  "canceledReason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollEntry_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollEntry_userId_competence_idx" ON "PayrollEntry"("userId", "competence")
-- @statement
-- Marcações de dia: folga, folga compensatória (ligada ao domingo/feriado), atestado,
-- abono, falta confirmada, férias, afastamento.
CREATE TABLE IF NOT EXISTS "PayrollDayMark" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "minutes" INTEGER,
  "refDate" TEXT,
  "status" TEXT NOT NULL DEFAULT 'APROVADO',
  "note" TEXT,
  "attachmentRef" TEXT,
  "createdById" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollDayMark_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollDayMark_userId_date_idx" ON "PayrollDayMark"("userId", "date")
-- @statement
-- Pedido de correção de ponto: a batida original nunca é alterada; aprovado vira uma
-- batida nova marcada com a origem "correcao".
CREATE TABLE IF NOT EXISTS "PayrollClockCorrection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "storeId" TEXT,
  "date" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "claimedTime" TEXT NOT NULL,
  "justification" TEXT NOT NULL,
  "attachment" BYTEA,
  "attachmentMime" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDENTE',
  "reviewNote" TEXT,
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "clockInId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollClockCorrection_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollClockCorrection_userId_date_idx" ON "PayrollClockCorrection"("userId", "date")
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollClockCorrection_status_idx" ON "PayrollClockCorrection"("status")
-- @statement
ALTER TABLE "ClockIn" ADD COLUMN IF NOT EXISTS "source" TEXT
-- @statement
ALTER TABLE "ClockIn" ADD COLUMN IF NOT EXISTS "correctionId" TEXT
-- @statement
-- Contracheque por funcionário + competência + versão. Fechado = congelado: snapshot
-- (dados de entrada) e result (cálculo) não mudam; correção cria a versão seguinte.
CREATE TABLE IF NOT EXISTS "Payslip" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "issuerId" TEXT,
  "storeId" TEXT,
  "competence" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'MENSAL',
  "version" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'EM_CONFERENCIA',
  "snapshot" JSONB,
  "result" JSONB,
  "grossCents" INTEGER NOT NULL DEFAULT 0,
  "deductionsCents" INTEGER NOT NULL DEFAULT 0,
  "netCents" INTEGER NOT NULL DEFAULT 0,
  "inputHash" TEXT,
  "verifyCode" TEXT,
  "paymentDate" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "closedById" TEXT,
  "closedAt" TIMESTAMP(3),
  "paidById" TEXT,
  "paidAt" TIMESTAMP(3),
  "paymentRef" TEXT,
  "supersedesId" TEXT,
  "supersededById" TEXT,
  "reason" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "Payslip_userId_competence_kind_version_key" ON "Payslip"("userId", "competence", "kind", "version")
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "Payslip_verifyCode_key" ON "Payslip"("verifyCode")
-- @statement
CREATE INDEX IF NOT EXISTS "Payslip_competence_status_idx" ON "Payslip"("competence", "status")
-- @statement
-- PDF oficial salvo (não é gerado de novo): bytes + hash.
CREATE TABLE IF NOT EXISTS "PayslipFile" (
  "id" TEXT NOT NULL,
  "payslipId" TEXT NOT NULL,
  "mime" TEXT NOT NULL DEFAULT 'application/pdf',
  "fileName" TEXT NOT NULL,
  "content" BYTEA NOT NULL,
  "sha256" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayslipFile_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "PayslipFile_payslipId_key" ON "PayslipFile"("payslipId")
-- @statement
CREATE TABLE IF NOT EXISTS "PayslipAcknowledgment" (
  "id" TEXT NOT NULL,
  "payslipId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "ip" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayslipAcknowledgment_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "PayslipAcknowledgment_payslipId_userId_key" ON "PayslipAcknowledgment"("payslipId", "userId")
-- @statement
CREATE TABLE IF NOT EXISTS "PayrollDispute" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "payslipId" TEXT,
  "competence" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ABERTA',
  "response" TEXT,
  "respondedById" TEXT,
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollDispute_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollDispute_userId_idx" ON "PayrollDispute"("userId")
-- @statement
-- Auditoria da folha: alteração, fechamento, reabertura, pagamento, visualização, exportação, envio.
CREATE TABLE IF NOT EXISTS "PayrollAuditLog" (
  "id" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "subjectUserId" TEXT,
  "actorId" TEXT,
  "actorRole" TEXT,
  "before" JSONB,
  "after" JSONB,
  "reason" TEXT,
  "ip" TEXT,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayrollAuditLog_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollAuditLog_entity_entityId_idx" ON "PayrollAuditLog"("entity", "entityId")
-- @statement
CREATE INDEX IF NOT EXISTS "PayrollAuditLog_subjectUserId_at_idx" ON "PayrollAuditLog"("subjectUserId", "at")
