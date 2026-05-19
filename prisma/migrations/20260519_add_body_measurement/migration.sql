-- =====================================================================
-- Body Measurement / Size Recommendation
-- =====================================================================
-- Adiciona 4 tabelas novas + colunas em User e Product.
-- Pra aplicar: `npm run db:push` (recomendado, projeto usa db:push)
-- Ou:        `npx prisma migrate deploy` (se preferir migration versionada)
-- =====================================================================

-- 1. Colunas novas em User (cache do último scan)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastScanId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastScanAt" TIMESTAMP(3);

-- 2. Colunas novas em Product
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "garmentType" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "garmentFit" TEXT;
CREATE INDEX IF NOT EXISTS "Product_garmentType_idx" ON "Product"("garmentType");

-- 3. BodyScan
CREATE TABLE IF NOT EXISTS "BodyScan" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "heightCm" DOUBLE PRECISION NOT NULL,
  "weightKg" DOUBLE PRECISION,
  "sex" TEXT,
  "keypointsFront" JSONB,
  "keypointsSide" JSONB,
  "keypointsBack" JSONB,
  "scaleFactor" DOUBLE PRECISION,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "reviewedByAi" BOOLEAN NOT NULL DEFAULT false,
  "reviewNotes" TEXT,
  "photosStored" BOOLEAN NOT NULL DEFAULT false,
  "photoUrls" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BodyScan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BodyScan_userId_idx" ON "BodyScan"("userId");
CREATE INDEX IF NOT EXISTS "BodyScan_capturedAt_idx" ON "BodyScan"("capturedAt");

-- 4. BodyMeasurement
CREATE TABLE IF NOT EXISTS "BodyMeasurement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "scanId" TEXT NOT NULL,
  "measureType" TEXT NOT NULL,
  "valueCm" DOUBLE PRECISION NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  CONSTRAINT "BodyMeasurement_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "BodyScan"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "BodyMeasurement_scanId_measureType_idx" ON "BodyMeasurement"("scanId", "measureType");

-- 5. SizeChart
CREATE TABLE IF NOT EXISTS "SizeChart" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "brand" TEXT,
  "garmentType" TEXT NOT NULL,
  "gender" TEXT,
  "supplierId" TEXT,
  "productId" TEXT,
  "sizes" JSONB NOT NULL,
  "source" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending_review',
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SizeChart_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SizeChart_productId_fkey"  FOREIGN KEY ("productId")  REFERENCES "Product"("id")  ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "SizeChart_brand_garmentType_gender_idx" ON "SizeChart"("brand", "garmentType", "gender");
CREATE INDEX IF NOT EXISTS "SizeChart_productId_idx" ON "SizeChart"("productId");
CREATE INDEX IF NOT EXISTS "SizeChart_status_idx" ON "SizeChart"("status");

-- 6. SizeRecommendation
CREATE TABLE IF NOT EXISTS "SizeRecommendation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "sizeChartId" TEXT NOT NULL,
  "recommendedSize" TEXT NOT NULL,
  "alternativeSize" TEXT,
  "fitProfile" TEXT NOT NULL DEFAULT 'regular',
  "scores" JSONB NOT NULL,
  "reasoning" TEXT,
  "actualBoughtSize" TEXT,
  "fitFeedback" TEXT,
  "feedbackAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SizeRecommendation_userId_fkey"      FOREIGN KEY ("userId")      REFERENCES "User"("id")      ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "SizeRecommendation_scanId_fkey"      FOREIGN KEY ("scanId")      REFERENCES "BodyScan"("id")  ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "SizeRecommendation_productId_fkey"   FOREIGN KEY ("productId")   REFERENCES "Product"("id")   ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "SizeRecommendation_sizeChartId_fkey" FOREIGN KEY ("sizeChartId") REFERENCES "SizeChart"("id") ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "SizeRecommendation_userId_idx" ON "SizeRecommendation"("userId");
CREATE INDEX IF NOT EXISTS "SizeRecommendation_productId_idx" ON "SizeRecommendation"("productId");
CREATE INDEX IF NOT EXISTS "SizeRecommendation_scanId_idx" ON "SizeRecommendation"("scanId");
