ALTER TABLE "ScanActionRead" ADD COLUMN "photoRequired" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "ScanActionPhoto" (
  "id" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "image" BYTEA NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "barcode" TEXT NOT NULL,
  "ocrText" TEXT NOT NULL DEFAULT '',
  "capturedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedById" TEXT NOT NULL,
  CONSTRAINT "ScanActionPhoto_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScanActionPhoto_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "ScanActionRead"("clientScanId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ScanActionPhoto_scanId_sha256_key" ON "ScanActionPhoto"("scanId", "sha256");
CREATE INDEX "ScanActionPhoto_scanId_capturedAt_idx" ON "ScanActionPhoto"("scanId", "capturedAt");
