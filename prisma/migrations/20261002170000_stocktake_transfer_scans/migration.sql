-- Additive: never rewrites existing bipes, rounds, transfers or stock balances.
CREATE TABLE "StocktakeTransferScan" (
  "id" TEXT NOT NULL,
  "bipeId" TEXT NOT NULL,
  "transferId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "productSizeId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StocktakeTransferScan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StocktakeTransferScan_bipeId_key" ON "StocktakeTransferScan"("bipeId");
CREATE INDEX "StocktakeTransferScan_transferId_idx" ON "StocktakeTransferScan"("transferId");
CREATE INDEX "StocktakeTransferScan_roundId_idx" ON "StocktakeTransferScan"("roundId");
ALTER TABLE "StocktakeTransferScan" ADD CONSTRAINT "StocktakeTransferScan_bipeId_fkey" FOREIGN KEY ("bipeId") REFERENCES "StocktakeBipe"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StocktakeTransferScan" ADD CONSTRAINT "StocktakeTransferScan_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
