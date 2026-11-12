-- Stone Connect 2.0 (maquininha integrada via API Pagar.me). Aditivo e idempotente.
-- Tabelas próprias: NÃO adiciona coluna em Store/Sale (o Prisma seleciona toda coluna
-- dessas tabelas em cada consulta; coluna faltando derrubaria a venda inteira).

CREATE TABLE IF NOT EXISTS "StoneConfig" (
  "id" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "secretKey" TEXT,
  "serviceRefererName" TEXT,
  "deviceSerials" TEXT,
  "webhookToken" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoneConfig_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StoneConfig_storeId_key" ON "StoneConfig"("storeId")
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StoneConfig_webhookToken_key" ON "StoneConfig"("webhookToken")
-- @statement
CREATE TABLE IF NOT EXISTS "StonePosOrder" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "deviceSerial" TEXT NOT NULL,
  "paymentType" TEXT NOT NULL,
  "installments" INTEGER NOT NULL DEFAULT 1,
  "amountCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "paidCents" INTEGER,
  "chargeId" TEXT,
  "nsu" TEXT,
  "authCode" TEXT,
  "brand" TEXT,
  "fundingSource" TEXT,
  "paidInstallments" INTEGER,
  "terminalSerial" TEXT,
  "paidAt" TIMESTAMP(3),
  "customerCpf" TEXT,
  "customerName" TEXT,
  "fiscalDocumentId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StonePosOrder_pkey" PRIMARY KEY ("id")
)
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StonePosOrder_saleId_key" ON "StonePosOrder"("saleId")
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StonePosOrder_orderId_key" ON "StonePosOrder"("orderId")
-- @statement
CREATE INDEX IF NOT EXISTS "StonePosOrder_storeId_status_idx" ON "StonePosOrder"("storeId", "status")
