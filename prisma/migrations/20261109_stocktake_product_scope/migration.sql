-- Additive only. Existing counts keep their original whole-store scope.
-- @statement
ALTER TABLE "StocktakeRound" ADD COLUMN IF NOT EXISTS "productScope" JSONB NOT NULL DEFAULT '{"type":"all"}'::jsonb;
-- @statement
ALTER TABLE "StocktakeRound" ADD COLUMN IF NOT EXISTS "operationType" TEXT NOT NULL DEFAULT 'inventory';
-- @statement
ALTER TABLE "StocktakeRound" ADD COLUMN IF NOT EXISTS "activeReplacementStoreId" TEXT;
-- @statement
CREATE UNIQUE INDEX IF NOT EXISTS "StocktakeRound_activeReplacementStoreId_key" ON "StocktakeRound"("activeReplacementStoreId");
-- @statement
CREATE TABLE IF NOT EXISTS "StockReplacementCheck" (
  "bipeId" TEXT NOT NULL PRIMARY KEY REFERENCES "StocktakeBipe"(id) ON DELETE RESTRICT,
  "roundId" TEXT NOT NULL REFERENCES "StocktakeRound"(id) ON DELETE RESTRICT,
  "status" TEXT NOT NULL DEFAULT 'pending', "reason" TEXT, "evidence" JSONB, "imageReview" JSONB,
  "appliedProductSizeId" TEXT, "appliedAt" TIMESTAMP(3), "reversedAt" TIMESTAMP(3),
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- @statement
CREATE INDEX IF NOT EXISTS "StockReplacementCheck_roundId_status_idx" ON "StockReplacementCheck"("roundId","status");
