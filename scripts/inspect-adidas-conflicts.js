const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const BARCODES = ['4065427633473', '4068806390127', '4066766748446', '4067888734935'];

async function main() {
  const result = [];
  for (const barcode of BARCODES) {
    const owners = await prisma.productSize.findMany({
      where: { barcode },
      include: {
        product: true,
        storeStocks: { include: { store: { select: { code: true, name: true } } } },
        saleItems: { include: { sale: { select: { id: true, storeId: true, status: true, createdAt: true } } } },
        stockMovements: true,
      },
    });
    const bipes = await prisma.stocktakeBipe.findMany({ where: { barcode }, orderBy: { bipedAt: 'asc' } });
    const xmlItems = await prisma.xmlFiscalItem.findMany({
      where: { ean: barcode },
      include: { fiscalDocument: { select: { accessKey: true, docType: true, issueDate: true } } },
      orderBy: { createdAt: 'asc' },
    });
    result.push({
      barcode,
      owners: owners.map((owner) => ({
        productSizeId: owner.id,
        productId: owner.productId,
        sku: owner.product.sku,
        product: owner.product.name,
        brand: owner.product.brand,
        source: owner.product.source,
        active: owner.product.active,
        size: owner.size,
        sizeConfirmedAt: owner.sizeConfirmedAt,
        purchased: owner.stock,
        storeStocks: owner.storeStocks.map((row) => ({ store: row.store.code, stock: row.stock })),
        sales: owner.saleItems.map((row) => ({ saleId: row.saleId, quantity: row.quantity, size: row.size, status: row.sale.status })),
        movements: owner.stockMovements.map((row) => ({ type: row.type, quantity: row.quantity, storeId: row.storeId })),
      })),
      bipes: {
        total: bipes.length,
        byProductSizeId: Object.fromEntries([...new Set(bipes.map((row) => row.productSizeId || 'null'))].map((id) => [id, bipes.filter((row) => (row.productSizeId || 'null') === id).length])),
        byStoreId: Object.fromEntries([...new Set(bipes.map((row) => row.storeId || 'null'))].map((id) => [id, bipes.filter((row) => (row.storeId || 'null') === id).length])),
        scanner: bipes.filter((row) => /scanner-etiqueta/i.test(String(row.userAgent || ''))).length,
      },
      xmlItems: xmlItems.map((item) => ({ productId: item.productId, supplierCode: item.supplierCode, description: item.description, quantity: item.quantity, docType: item.fiscalDocument.docType, accessKey: item.fiscalDocument.accessKey })),
    });
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
