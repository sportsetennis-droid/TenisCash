-- Financeiro — contas a pagar por loja: despesas fixas (recorrentes), títulos e baixas.
-- Aditivo e idempotente. Valores em centavos inteiros. Nada é apagado: cancela/estorna com motivo.

CREATE TABLE IF NOT EXISTS "FinRecurring" (
  "id" TEXT NOT NULL,
  "storeId" TEXT,
  "natureId" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "payee" TEXT,
  "amountCents" INTEGER NOT NULL,
  "variableAmount" BOOLEAN NOT NULL DEFAULT false,
  "dueDay" INTEGER,
  "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
  "startCompetence" TEXT NOT NULL,
  "endCompetence" TEXT,
  "paymentMethod" TEXT,
  "notes" TEXT,
  "legacyId" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "inactiveReason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinRecurring_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "FinRecurring_legacyId_key" ON "FinRecurring"("legacyId")
-- @statement
CREATE INDEX IF NOT EXISTS "FinRecurring_storeId_active_idx" ON "FinRecurring"("storeId", "active")
-- @statement
CREATE TABLE IF NOT EXISTS "FinTitle" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'PAYABLE',
  "storeId" TEXT,
  "natureId" TEXT NOT NULL,
  "recurringId" TEXT,
  "competence" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "payee" TEXT,
  "documentNumber" TEXT,
  "installment" INTEGER,
  "installments" INTEGER,
  "groupId" TEXT,
  "amountCents" INTEGER NOT NULL,
  "amountConfirmed" BOOLEAN NOT NULL DEFAULT true,
  "paidPrincipalCents" INTEGER NOT NULL DEFAULT 0,
  "discountCents" INTEGER NOT NULL DEFAULT 0,
  "interestCents" INTEGER NOT NULL DEFAULT 0,
  "fineCents" INTEGER NOT NULL DEFAULT 0,
  "dueDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "paymentMethod" TEXT,
  "barcode" TEXT,
  "pixKey" TEXT,
  "notes" TEXT,
  "approvalStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "canceledReason" TEXT,
  "canceledAt" TIMESTAMP(3),
  "legacyId" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinTitle_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "FinTitle_recurringId_competence_key" ON "FinTitle"("recurringId", "competence")
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "FinTitle_legacyId_key" ON "FinTitle"("legacyId")
-- @statement
CREATE INDEX IF NOT EXISTS "FinTitle_status_dueDate_idx" ON "FinTitle"("status", "dueDate")
-- @statement
CREATE INDEX IF NOT EXISTS "FinTitle_storeId_dueDate_idx" ON "FinTitle"("storeId", "dueDate")
-- @statement
CREATE INDEX IF NOT EXISTS "FinTitle_competence_idx" ON "FinTitle"("competence")
-- @statement
CREATE TABLE IF NOT EXISTS "FinSettlement" (
  "id" TEXT NOT NULL,
  "titleId" TEXT NOT NULL,
  "accountId" TEXT,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "principalCents" INTEGER NOT NULL,
  "discountCents" INTEGER NOT NULL DEFAULT 0,
  "interestCents" INTEGER NOT NULL DEFAULT 0,
  "fineCents" INTEGER NOT NULL DEFAULT 0,
  "totalCents" INTEGER NOT NULL,
  "method" TEXT,
  "note" TEXT,
  "reversalOfId" TEXT,
  "reversedAt" TIMESTAMP(3),
  "reason" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FinSettlement_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE INDEX IF NOT EXISTS "FinSettlement_titleId_idx" ON "FinSettlement"("titleId")
-- @statement
CREATE INDEX IF NOT EXISTS "FinSettlement_paidAt_idx" ON "FinSettlement"("paidAt")
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "FinSettlement_reversalOfId_key" ON "FinSettlement"("reversalOfId")
