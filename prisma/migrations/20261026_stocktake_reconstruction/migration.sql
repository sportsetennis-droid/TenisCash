-- Migração aditiva: cria o controle da reconstrução sem alterar os saldos atuais.
-- O delimitador permite executar cada comando em transação sem dividir o bloco DO.
-- @statement
ALTER TABLE "StocktakeRound" ADD COLUMN IF NOT EXISTS "reconstructionId" TEXT;
-- @statement
CREATE TABLE IF NOT EXISTS "StocktakeReconstruction" (
  "id" TEXT NOT NULL,
  "number" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'counting',
  "storeIds" JSONB NOT NULL,
  "catalogFingerprint" TEXT NOT NULL,
  "createdById" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "result" JSONB,
  CONSTRAINT "StocktakeReconstruction_pkey" PRIMARY KEY ("id")
);
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeReconstruction_number_key" ON "StocktakeReconstruction"("number");
-- @statement
CREATE INDEX IF NOT EXISTS "StocktakeReconstruction_status_startedAt_idx" ON "StocktakeReconstruction"("status", "startedAt");
-- @statement
CREATE INDEX IF NOT EXISTS "StocktakeRound_reconstructionId_idx" ON "StocktakeRound"("reconstructionId");
-- @statement
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'StocktakeRound_reconstructionId_fkey'
      AND conrelid = '"StocktakeRound"'::regclass
  ) THEN
    ALTER TABLE "StocktakeRound"
      ADD CONSTRAINT "StocktakeRound_reconstructionId_fkey"
      FOREIGN KEY ("reconstructionId") REFERENCES "StocktakeReconstruction"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
