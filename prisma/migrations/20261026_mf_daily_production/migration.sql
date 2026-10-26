BEGIN;

ALTER TABLE "MfEmployee" ADD COLUMN IF NOT EXISTS "canRecordProduction" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MfTimeEntry" ADD COLUMN IF NOT EXISTS "requestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "MfTimeEntry_requestId_key" ON "MfTimeEntry"("requestId");

CREATE TABLE IF NOT EXISTS "MfProductionEntry" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "recorderId" TEXT NOT NULL,
  "product" TEXT NOT NULL,
  "activity" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL CHECK ("quantity" > 0),
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMP(3),
  "voidedById" TEXT,
  CONSTRAINT "MfProductionEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfProductionEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "MfEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "MfProductionEntry_recorderId_fkey" FOREIGN KEY ("recorderId") REFERENCES "MfEmployee"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "MfProductionEntry_requestId_key" ON "MfProductionEntry"("requestId");
CREATE INDEX IF NOT EXISTS "MfProductionEntry_day_employeeId_idx" ON "MfProductionEntry"("day", "employeeId");

COMMIT;
