const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function isoForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');

  const products = await prisma.product.findMany({
    where: { brand: { contains: 'ADIDAS', mode: 'insensitive' } },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
  });
  const productIds = products.map((row) => row.id);

  const productSizes = await prisma.productSize.findMany({
    where: { productId: { in: productIds } },
    orderBy: [{ productId: 'asc' }, { size: 'asc' }],
  });
  const productSizeIds = productSizes.map((row) => row.id);
  const barcodes = [...new Set(productSizes.map((row) => row.barcode).filter(Boolean))];

  const [
    storeStocks,
    stockMovements,
    stocktakeBipes,
    saleItems,
    productMappings,
    variantMappings,
    xmlFiscalItems,
  ] = await Promise.all([
    prisma.storeStock.findMany({ where: { productSizeId: { in: productSizeIds } } }),
    prisma.storeStockMovement.findMany({ where: { productSizeId: { in: productSizeIds } } }),
    prisma.stocktakeBipe.findMany({
      where: {
        OR: [
          { productId: { in: productIds } },
          { productSizeId: { in: productSizeIds } },
          { productBrand: { contains: 'ADIDAS', mode: 'insensitive' } },
          { barcode: { in: barcodes } },
        ],
      },
      orderBy: { bipedAt: 'asc' },
    }),
    prisma.saleItem.findMany({
      where: { OR: [{ productId: { in: productIds } }, { productSizeId: { in: productSizeIds } }] },
      include: { sale: true },
    }),
    prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: productIds } } }),
    prisma.nuvemshopVariantMapping.findMany({
      where: { OR: [{ localProductId: { in: productIds } }, { localInventoryId: { in: productSizeIds } }] },
    }),
    prisma.xmlFiscalItem.findMany({
      where: { OR: [{ productId: { in: productIds } }, { ean: { in: barcodes } }] },
      include: { fiscalDocument: true },
    }),
  ]);

  const bipeIds = stocktakeBipes.map((row) => row.id);
  const productCaptures = await prisma.productCapture.findMany({
    where: {
      OR: [
        { matchedProductId: { in: productIds } },
        { createdProductId: { in: productIds } },
        { bipeId: { in: bipeIds } },
        { barcode: { in: barcodes } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  const payload = {
    metadata: {
      kind: 'adidas-remediation-backup',
      createdAt: new Date().toISOString(),
      readOnlySource: true,
      productFilter: "brand contains 'ADIDAS' (case-insensitive)",
    },
    counts: {
      products: products.length,
      productSizes: productSizes.length,
      storeStocks: storeStocks.length,
      stockMovements: stockMovements.length,
      stocktakeBipes: stocktakeBipes.length,
      productCaptures: productCaptures.length,
      saleItems: saleItems.length,
      productMappings: productMappings.length,
      variantMappings: variantMappings.length,
      xmlFiscalItems: xmlFiscalItems.length,
    },
    data: {
      products,
      productSizes,
      storeStocks,
      stockMovements,
      stocktakeBipes,
      productCaptures,
      saleItems,
      productMappings,
      variantMappings,
      xmlFiscalItems,
    },
  };

  const body = JSON.stringify(payload, null, 2);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const outDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `adidas-remediation-${isoForFile()}.json`);
  fs.writeFileSync(outFile, body, { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(`${outFile}.sha256`, `${sha256}  ${path.basename(outFile)}\n`, { encoding: 'utf8', flag: 'wx' });

  console.log(JSON.stringify({ ok: true, outFile, sha256, bytes: Buffer.byteLength(body), counts: payload.counts }));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
