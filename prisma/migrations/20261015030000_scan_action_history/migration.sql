-- Additive scan journal. No inventory backfill, stock changes or EAN deduplication.
CREATE TABLE "ScanActionLot" (
  "sessionId" TEXT NOT NULL PRIMARY KEY,
  "mode" TEXT NOT NULL CHECK ("mode" IN ('transfer', 'receipt')),
  "operatorId" TEXT NOT NULL,
  "fromStoreId" TEXT,
  "toStoreId" TEXT NOT NULL,
  "transferId" TEXT,
  "transferHistory" JSONB NOT NULL DEFAULT '[]',
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "payloadHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'archived', 'confirmed')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3)
);
CREATE TABLE "ScanActionRead" (
  "clientScanId" TEXT NOT NULL PRIMARY KEY,
  "lotId" TEXT NOT NULL,
  "barcode" TEXT NOT NULL,
  "originalBarcode" TEXT,
  "barcodeHistory" JSONB NOT NULL DEFAULT '[]',
  "payloadHash" TEXT NOT NULL DEFAULT '',
  "scannedAt" TIMESTAMP(3) NOT NULL,
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "removed" BOOLEAN NOT NULL DEFAULT false,
  "recognized" BOOLEAN NOT NULL DEFAULT false,
  "productSizeId" TEXT,
  "productName" TEXT,
  "brand" TEXT,
  "size" TEXT,
  "confirmedSize" TEXT,
  "requiresSizeConfirmation" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT,
  CONSTRAINT "ScanActionRead_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "ScanActionLot"("sessionId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "ScanActionLot_mode_fromStoreId_createdAt_idx" ON "ScanActionLot"("mode", "fromStoreId", "createdAt");
CREATE INDEX "ScanActionLot_mode_toStoreId_createdAt_idx" ON "ScanActionLot"("mode", "toStoreId", "createdAt");
CREATE INDEX "ScanActionLot_transferId_idx" ON "ScanActionLot"("transferId");
CREATE INDEX "ScanActionLot_confirmedAt_idx" ON "ScanActionLot"("confirmedAt");
CREATE INDEX "ScanActionRead_lotId_scannedAt_idx" ON "ScanActionRead"("lotId", "scannedAt");
CREATE INDEX "ScanActionRead_scannedAt_idx" ON "ScanActionRead"("scannedAt");
