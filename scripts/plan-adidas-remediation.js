const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EXCLUDE = /\b(MEIA|MEIAO|BONE|BOLSA|MALA|MOCHILA|CAMISA|CAMISETA|REGATA|BERMUDA|SHORT|CALCA|JAQUETA|AGASALHO|TOP|LEGGING|SAIA|CUECA|MAIO|LUVA|BOLA|CHINELO|SANDALIA|CARTEIRA|VISEIRA|TOUCA|GARRAFA|SQUEEZE|CHUTEIRA)\b/i;
const FOOTWEAR = /\b(TENIS|TÊNIS|SAMBA|SUPERSTAR|DURAMO|SUPERNOVA|GALAXY|RUNFALCON|RESPONSE|ADIZERO|COURT|MEGARIDE|BRAVADA|VL COURT|QUESTAR|ULTRABOOST|ADVANTAGE)\b/i;

function isFootwear(product) {
  const name = String(product.name || '');
  if (EXCLUDE.test(name)) return false;
  return FOOTWEAR.test(name) || /\b(1[6-9]|2[0-9]|3[0-9]|4[0-8])\s*\/\s*(1[6-9]|2[0-9]|3[0-9]|4[0-8])\b/.test(name);
}

function barcodeKey(value) {
  const raw = String(value || '').trim();
  if (!/^\d{8,14}$/.test(raw)) return raw.toUpperCase();
  return raw.replace(/^0+/, '');
}

function modelRef(product) {
  const text = `${product?.sku || ''} ${product?.name || ''}`.toUpperCase();
  const ref = text.match(/\bREF[:\s-]*([A-Z0-9-]{4,20})\b/);
  if (ref) return ref[1];
  const common = text.match(/\b([A-Z]{1,3}\d{4})\b/);
  return common ? common[1] : null;
}

function positiveStock(size) {
  return (size.storeStocks || []).reduce((sum, row) => sum + Math.max(0, Number(row.stock || 0)), 0);
}

function capturedBrSize(note) {
  const values = [];
  const text = String(note || '');
  for (const match of text.matchAll(/"tamanho"\s*:\s*"BR\s*(\d{2}(?:[.,]5)?)"/gi)) {
    values.push(match[1].replace(',', '.'));
  }
  return values;
}

async function main() {
  const allProducts = await prisma.product.findMany({
    where: { brand: { contains: 'ADIDAS', mode: 'insensitive' } },
    include: { sizes: { include: { storeStocks: true } } },
  });
  const footwear = allProducts.filter((product) => product.active && isFootwear(product));
  const productIds = footwear.map((product) => product.id);
  const sizeIds = footwear.flatMap((product) => product.sizes.map((size) => size.id));
  const barcodes = footwear.flatMap((product) => product.sizes.map((size) => size.barcode).filter(Boolean));

  const [bipes, captures, allOwners, mappings, variantMappings, saleItems] = await Promise.all([
    prisma.stocktakeBipe.findMany({
      where: { OR: [{ productId: { in: productIds } }, { productSizeId: { in: sizeIds } }] },
      orderBy: { bipedAt: 'asc' },
    }),
    prisma.productCapture.findMany({ where: { barcode: { in: barcodes } }, select: { id: true, barcode: true, note: true, status: true, bipeId: true, createdAt: true } }),
    prisma.productSize.findMany({
      where: { barcode: { in: barcodes } },
      include: { product: { select: { id: true, sku: true, name: true, brand: true, active: true } }, storeStocks: true },
    }),
    prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: productIds } } }),
    prisma.nuvemshopVariantMapping.findMany({ where: { OR: [{ localProductId: { in: productIds } }, { localInventoryId: { in: sizeIds } }] } }),
    prisma.saleItem.findMany({ where: { OR: [{ productId: { in: productIds } }, { productSizeId: { in: sizeIds } }] }, select: { id: true, productId: true, productSizeId: true, size: true, quantity: true, saleId: true } }),
  ]);

  const ownerByBarcode = new Map();
  for (const owner of allOwners) {
    const key = barcodeKey(owner.barcode);
    if (!ownerByBarcode.has(key)) ownerByBarcode.set(key, []);
    ownerByBarcode.get(key).push(owner);
  }
  const captureByBarcode = new Map();
  for (const capture of captures) {
    const key = barcodeKey(capture.barcode);
    if (!captureByBarcode.has(key)) captureByBarcode.set(key, []);
    captureByBarcode.get(key).push(capture);
  }

  const deterministicMappings = [];
  const physicalRecount = [];
  const barcodeConflicts = [];
  const seenConflicts = new Set();

  for (const product of footwear) {
    const ref = modelRef(product);
    for (const size of product.sizes) {
      const units = positiveStock(size);
      if (units <= 0) continue;
      const key = barcodeKey(size.barcode);
      const owners = ownerByBarcode.get(key) || [];
      if (owners.length > 1 && !seenConflicts.has(key)) {
        seenConflicts.add(key);
        barcodeConflicts.push({
          barcode: size.barcode,
          owners: owners.map((owner) => ({
            productId: owner.productId,
            productSizeId: owner.id,
            sku: owner.product.sku,
            product: owner.product.name,
            active: owner.product.active,
            size: owner.size,
            sizeConfirmedAt: owner.sizeConfirmedAt,
            units: positiveStock(owner),
            ref: modelRef(owner.product),
          })),
        });
      }

      if (size.sizeConfirmedAt) continue;
      const confirmedSameRef = owners.filter((owner) => (
        owner.id !== size.id
        && owner.sizeConfirmedAt
        && modelRef(owner.product)
        && modelRef(owner.product) === ref
      ));
      const confirmedSizes = [...new Set(confirmedSameRef.map((owner) => owner.size))];
      const capturedSizes = [...new Set((captureByBarcode.get(key) || []).flatMap((capture) => capturedBrSize(capture.note)))];
      const evidenceSizes = [...new Set([...confirmedSizes, ...capturedSizes])];

      const row = {
        productId: product.id,
        productSizeId: size.id,
        sku: product.sku,
        product: product.name,
        category: product.category,
        barcode: size.barcode,
        currentSize: size.size,
        units,
        stores: size.storeStocks.filter((stock) => stock.stock !== 0).map((stock) => ({ storeId: stock.storeId, stock: stock.stock })),
        confirmedSameRef: confirmedSameRef.map((owner) => ({ productId: owner.productId, productSizeId: owner.id, size: owner.size, sku: owner.product.sku, active: owner.product.active })),
        capturedSizes,
      };
      if (evidenceSizes.length === 1) deterministicMappings.push({ ...row, targetSize: evidenceSizes[0], evidence: confirmedSizes.length ? 'confirmed_same_gtin_same_model' : 'physical_label_capture' });
      else physicalRecount.push({ ...row, evidenceSizes, reason: evidenceSizes.length > 1 ? 'conflicting_evidence' : 'no_traceable_size_evidence' });
    }
  }

  const categoryRepairs = footwear
    .filter((product) => String(product.category || '').trim().toUpperCase() !== 'CALÇADOS')
    .map((product) => ({ productId: product.id, sku: product.sku, product: product.name, from: product.category, to: 'Calçados' }));

  const orphanBipes = bipes.filter((bipe) => bipe.applied && !bipe.productSizeId);
  const pendingBipes = bipes.filter((bipe) => !bipe.applied);
  const activeExactDuplicates = [];
  const byName = new Map();
  for (const product of footwear) {
    const key = String(product.name || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(product);
  }
  for (const rows of byName.values()) {
    if (rows.length > 1) activeExactDuplicates.push(rows.map((product) => ({ id: product.id, sku: product.sku, name: product.name })));
  }
  const referenceDuplicateGroups = [];
  const byRef = new Map();
  for (const product of footwear) {
    const ref = modelRef(product);
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(product);
  }
  for (const [ref, rows] of byRef.entries()) {
    if (rows.length < 2) continue;
    referenceDuplicateGroups.push({
      ref,
      products: rows.map((product) => ({
        id: product.id,
        sku: product.sku,
        name: product.name,
        source: product.source,
        units: product.sizes.reduce((sum, size) => sum + positiveStock(size), 0),
        variants: product.sizes.length,
        sizes: product.sizes.map((size) => ({
          id: size.id,
          barcode: size.barcode,
          size: size.size,
          sizeConfirmedAt: size.sizeConfirmedAt,
          units: positiveStock(size),
          stores: size.storeStocks.filter((row) => row.stock !== 0).map((row) => ({ storeId: row.storeId, stock: row.stock })),
          bipes: bipes.filter((bipe) => bipe.productSizeId === size.id).length,
        })),
      })),
    });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    footwearProducts: footwear.length,
    positiveUnits: footwear.reduce((sum, product) => sum + product.sizes.reduce((n, size) => n + positiveStock(size), 0), 0),
    deterministicMappings: deterministicMappings.length,
    deterministicUnits: deterministicMappings.reduce((sum, row) => sum + row.units, 0),
    physicalRecountVariants: physicalRecount.length,
    physicalRecountUnits: physicalRecount.reduce((sum, row) => sum + row.units, 0),
    barcodeConflictGroups: barcodeConflicts.length,
    categoryRepairs: categoryRepairs.length,
    orphanAppliedBipes: orphanBipes.length,
    pendingBipes: pendingBipes.length,
    activeExactDuplicateGroups: activeExactDuplicates.length,
    referenceDuplicateGroups: referenceDuplicateGroups.length,
    nuvemshopProductMappings: mappings.length,
    nuvemshopVariantMappings: variantMappings.length,
    saleItems: saleItems.length,
    latestBipeAt: bipes.length ? bipes[bipes.length - 1].bipedAt : null,
  };

  const report = { summary, deterministicMappings, physicalRecount, barcodeConflicts, categoryRepairs, orphanBipes, pendingBipes, activeExactDuplicates, referenceDuplicateGroups };
  const output = process.env.OUTPUT_FILE || path.join(__dirname, '..', 'output', `adidas-remediation-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, output, summary }));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
