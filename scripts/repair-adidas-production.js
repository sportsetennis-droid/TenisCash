const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: process.env.ENV_FILE || path.join(__dirname, '..', '.env'), quiet: true });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const REPAIR_SOURCE = 'adidas-remediation-2026-07-14';
const KNOWN_CONFLICTS = [
  '4065427633473',
  '4068806390127',
  '4066766748446',
  '4067888734935',
  '4067897204764',
  '4067897201046',
  '4067897204740',
  '4067897201077',
];
const EXCLUDE = /\b(MEIA|MEIAO|BONE|BOLSA|MALA|MOCHILA|CAMISA|CAMISETA|REGATA|BERMUDA|SHORT|CALCA|JAQUETA|AGASALHO|TOP|LEGGING|SAIA|CUECA|MAIO|LUVA|BOLA|CHINELO|SANDALIA|CARTEIRA|VISEIRA|TOUCA|GARRAFA|SQUEEZE|CHUTEIRA)\b/i;
const FOOTWEAR = /\b(TENIS|TÊNIS|SAMBA|SUPERSTAR|DURAMO|SUPERNOVA|GALAXY|RUNFALCON|RESPONSE|ADIZERO|COURT|MEGARIDE|BRAVADA|VL COURT|QUESTAR|ULTRABOOST|ADVANTAGE)\b/i;

function isFootwear(product) {
  const name = String(product?.name || '');
  if (EXCLUDE.test(name)) return false;
  return FOOTWEAR.test(name) || /\b(1[6-9]|2[0-9]|3[0-9]|4[0-8])\s*\/\s*(1[6-9]|2[0-9]|3[0-9]|4[0-8])\b/.test(name);
}

function modelRef(product) {
  const text = `${product?.sku || ''} ${product?.name || ''}`.toUpperCase();
  const ref = text.match(/\bREF[:\s-]*([A-Z0-9-]{4,20})\b/);
  if (ref) return ref[1];
  const common = text.match(/\b([A-Z]{1,3}\d{4})\b/);
  return common ? common[1] : null;
}

function barcodeKey(value) {
  const raw = String(value || '').trim();
  return /^\d{8,14}$/.test(raw) ? raw.replace(/^0+/, '') : raw.toUpperCase();
}

function contextOf(product) {
  try {
    return typeof product?.aiContext === 'string' ? JSON.parse(product.aiContext) : (product?.aiContext || {});
  } catch (_) {
    return {};
  }
}

function uniqueArchiveSize(id) {
  return `ARQ-${String(id).slice(0, 12)}`;
}

function legacyPlaceholder(ref, id) {
  return `T-LEGACY-${ref}-${String(id).slice(0, 6)}`;
}

async function conflictPlan(barcode) {
  const owners = await prisma.productSize.findMany({
    where: { barcode },
    include: {
      product: true,
      storeStocks: true,
      saleItems: { select: { id: true } },
      stockMovements: { select: { id: true } },
    },
  });
  if (owners.length < 2) return { barcode, status: 'already_clean', owners: owners.length };

  const entries = await prisma.xmlFiscalItem.findMany({
    where: { ean: barcode, productId: { not: null }, fiscalDocument: { docType: 'entrada' } },
    select: { productId: true },
  });
  const entryProductIds = [...new Set(entries.map((row) => row.productId))];
  let candidates = owners.filter((owner) => entryProductIds.includes(owner.productId));
  if (candidates.length !== 1) {
    const active = owners.filter((owner) => owner.product.active);
    if (active.length === 1) candidates = active;
  }
  if (candidates.length !== 1) {
    return { barcode, status: 'blocked', reason: 'canonical_not_unique', owners: owners.map((row) => ({ productId: row.productId, productSizeId: row.id, sku: row.product.sku, active: row.product.active })) };
  }

  const canonical = candidates[0];
  const duplicates = owners.filter((owner) => owner.id !== canonical.id);
  const blockers = [];
  for (const duplicate of duplicates) {
    if (duplicate.saleItems.length) blockers.push(`${duplicate.id}:sale_items`);
    if (duplicate.stockMovements.length) blockers.push(`${duplicate.id}:stock_movements`);
    for (const stock of duplicate.storeStocks.filter((row) => row.stock > 0)) {
      const canonicalStock = canonical.storeStocks.find((row) => row.storeId === stock.storeId);
      if (!canonicalStock || canonicalStock.stock <= 0) blockers.push(`${duplicate.id}:canonical_missing_store_${stock.storeId}`);
    }
  }
  return {
    barcode,
    status: blockers.length ? 'blocked' : 'ready',
    blockers,
    canonical: { productId: canonical.productId, productSizeId: canonical.id, sku: canonical.product.sku, size: canonical.size },
    duplicates: duplicates.map((owner) => ({
      productId: owner.productId,
      productSizeId: owner.id,
      sku: owner.product.sku,
      active: owner.product.active,
      stocks: owner.storeStocks.map((row) => ({ id: row.id, storeId: row.storeId, stock: row.stock })),
    })),
  };
}

async function referencePlans(footwear) {
  const groups = new Map();
  for (const product of footwear) {
    const ref = modelRef(product);
    if (!ref) continue;
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(product);
  }

  const plans = [];
  for (const [ref, products] of groups.entries()) {
    if (products.length < 2) continue;
    const nfe = products.filter((product) => /nfe/i.test(String(product.source || '')));
    if (nfe.length !== 1) {
      plans.push({ ref, status: 'blocked', reason: 'nfe_canonical_not_unique', products: products.map((row) => row.id) });
      continue;
    }
    const canonical = nfe[0];
    const duplicates = products.filter((product) => product.id !== canonical.id);
    const duplicatePlans = [];
    let groupBlocked = false;
    for (const duplicate of duplicates) {
      const saleCount = await prisma.saleItem.count({ where: { productId: duplicate.id } });
      const sizes = await prisma.productSize.findMany({
        where: { productId: duplicate.id },
        include: { storeStocks: true, stockMovements: { select: { id: true } }, saleItems: { select: { id: true } } },
      });
      const canonicalSizes = await prisma.productSize.findMany({ where: { productId: canonical.id }, include: { storeStocks: true } });
      const sizePlans = [];
      for (const size of sizes) {
        const bipes = await prisma.stocktakeBipe.count({ where: { productSizeId: size.id } });
        const units = size.storeStocks.reduce((sum, row) => sum + Math.max(0, row.stock), 0);
        if (size.saleItems.length || size.stockMovements.length) {
          sizePlans.push({ productSizeId: size.id, status: 'blocked', reason: 'linked_history' });
          groupBlocked = true;
          continue;
        }
        if (KNOWN_CONFLICTS.includes(String(size.barcode || ''))) {
          sizePlans.push({ productSizeId: size.id, status: 'handled_by_conflict', barcode: size.barcode });
          continue;
        }
        const key = barcodeKey(size.barcode);
        const canonicalOwner = size.barcode ? canonicalSizes.find((row) => barcodeKey(row.barcode) === key) : null;
        if (canonicalOwner) {
          const missingStore = size.storeStocks.filter((row) => row.stock > 0).find((row) => {
            const target = canonicalOwner.storeStocks.find((stock) => stock.storeId === row.storeId);
            return !target || target.stock <= 0;
          });
          if (missingStore) {
            sizePlans.push({ productSizeId: size.id, status: 'blocked', reason: 'canonical_missing_store', storeId: missingStore.storeId });
            groupBlocked = true;
          } else {
            sizePlans.push({ productSizeId: size.id, status: 'dedupe_existing', targetProductSizeId: canonicalOwner.id, barcode: size.barcode, units, bipes });
          }
          continue;
        }
        if (units > 0 || bipes > 0) {
          const ownerCount = size.barcode ? await prisma.productSize.count({ where: { barcode: size.barcode } }) : 1;
          if (ownerCount !== 1) {
            sizePlans.push({ productSizeId: size.id, status: 'blocked', reason: 'barcode_shared_without_canonical', barcode: size.barcode });
            groupBlocked = true;
          } else {
            sizePlans.push({ productSizeId: size.id, status: 'move_placeholder', barcode: size.barcode, placeholder: legacyPlaceholder(ref, size.id), units, bipes });
          }
        } else {
          sizePlans.push({ productSizeId: size.id, status: 'archive_zero', barcode: size.barcode });
        }
      }
      duplicatePlans.push({ productId: duplicate.id, sku: duplicate.sku, saleCount, status: sizePlans.some((row) => row.status === 'blocked') ? 'blocked' : 'ready', sizePlans });
    }
    plans.push({ ref, status: groupBlocked ? 'blocked' : 'ready', canonicalProductId: canonical.id, canonicalSku: canonical.sku, duplicates: duplicatePlans });
  }
  return plans;
}

async function buildPlan() {
  const allAdidas = await prisma.product.findMany({
    where: { brand: { contains: 'ADIDAS', mode: 'insensitive' } },
    include: { sizes: { include: { storeStocks: true } } },
  });
  const footwear = allAdidas.filter((product) => product.active && isFootwear(product));
  const productIds = footwear.map((product) => product.id);
  const sizeIds = footwear.flatMap((product) => product.sizes.map((size) => size.id));
  const categoryChanges = footwear.filter((product) => String(product.category || '').trim().toUpperCase() !== 'CALÇADOS').map((product) => ({ productId: product.id, from: product.category, to: 'Calçados' }));
  const orphanBipes = await prisma.stocktakeBipe.findMany({
    where: { productId: { in: productIds }, applied: true, productSizeId: null },
    select: { id: true, barcode: true, productId: true, storeId: true },
  });
  const conflicts = [];
  for (const barcode of KNOWN_CONFLICTS) conflicts.push(await conflictPlan(barcode));
  const references = await referencePlans(footwear);
  const reviewUnits = footwear.reduce((sum, product) => sum + product.sizes.reduce((n, size) => {
    if (size.sizeConfirmedAt) return n;
    return n + size.storeStocks.reduce((m, stock) => m + Math.max(0, stock.stock), 0);
  }, 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    summary: {
      footwearProducts: footwear.length,
      nuvemshopBlocks: footwear.length,
      categoryChanges: categoryChanges.length,
      orphanBipes: orphanBipes.length,
      conflictReady: conflicts.filter((row) => row.status === 'ready').length,
      conflictBlocked: conflicts.filter((row) => row.status === 'blocked').length,
      referenceReady: references.filter((row) => row.status === 'ready').length,
      referenceBlocked: references.filter((row) => row.status === 'blocked').length,
      unconfirmedUnitsRequiringPhysicalRecount: reviewUnits,
    },
    productIds,
    sizeIds,
    categoryChanges,
    orphanBipes,
    conflicts,
    references,
  };
}

async function moveVariantMapping(tx, fromSizeId, toSizeId, toProductId) {
  const from = await tx.nuvemshopVariantMapping.findUnique({ where: { localInventoryId: fromSizeId } });
  if (!from) return 'none';
  const target = await tx.nuvemshopVariantMapping.findUnique({ where: { localInventoryId: toSizeId } });
  if (target) {
    await tx.nuvemshopVariantMapping.delete({ where: { id: from.id } });
    return 'duplicate_mapping_removed';
  }
  await tx.nuvemshopVariantMapping.update({ where: { id: from.id }, data: { localInventoryId: toSizeId, localProductId: toProductId } });
  return 'mapping_moved';
}

async function markDuplicateProduct(tx, duplicateProductId, canonicalProductId, ref) {
  const remainingPositive = await tx.storeStock.count({ where: { stock: { gt: 0 }, productSize: { productId: duplicateProductId } } });
  const sales = await tx.saleItem.count({ where: { productId: duplicateProductId } });
  const product = await tx.product.findUnique({ where: { id: duplicateProductId } });
  if (!product) return false;
  const ctx = contextOf(product);
  await tx.product.update({
    where: { id: duplicateProductId },
    data: {
      active: remainingPositive === 0 ? false : product.active,
      aiContext: {
        ...ctx,
        confirmedForNuvemshop: false,
        hideFromNuvemshop: true,
        duplicateReview: {
          status: remainingPositive === 0 ? (sales > 0 ? 'archived_with_history' : 'archived') : 'blocked',
          canonicalProductId,
          ref,
          historicalSaleItemsPreserved: sales,
          at: new Date().toISOString(),
          source: REPAIR_SOURCE,
        },
      },
    },
  });
  const mapping = await tx.nuvemshopProductMapping.findUnique({ where: { localProductId: duplicateProductId } });
  if (mapping) await tx.nuvemshopProductMapping.update({ where: { id: mapping.id }, data: { syncStatus: 'blocked_duplicate' } });
  return remainingPositive === 0;
}

async function archiveDuplicateIntoExisting(tx, duplicateSizeId, targetSizeId, targetProductId, reason) {
  const duplicate = await tx.productSize.findUnique({ where: { id: duplicateSizeId }, include: { storeStocks: true } });
  const target = await tx.productSize.findUnique({ where: { id: targetSizeId }, include: { product: true, storeStocks: true } });
  if (!duplicate || !target) throw new Error(`variant missing: ${duplicateSizeId} -> ${targetSizeId}`);
  for (const stock of duplicate.storeStocks) {
    if (stock.stock !== 0) {
      await tx.storeStockMovement.create({ data: {
        storeId: stock.storeId,
        productSizeId: duplicate.id,
        type: 'stocktake_repair',
        quantity: -stock.stock,
        stockBefore: stock.stock,
        stockAfter: 0,
        source: REPAIR_SOURCE,
        reason,
        metadata: { targetProductSizeId: target.id },
      } });
      await tx.storeStock.update({ where: { id: stock.id }, data: { stock: 0 } });
    }
  }
  await tx.stocktakeBipe.updateMany({
    where: { productSizeId: duplicate.id },
    data: { productId: targetProductId, productSizeId: target.id, productName: target.product.name, productSize: target.size, productBrand: target.product.brand, found: true, duplicate: false },
  });
  await tx.productCapture.updateMany({ where: { matchedProductId: duplicate.productId, barcode: duplicate.barcode }, data: { matchedProductId: targetProductId } });
  await moveVariantMapping(tx, duplicate.id, target.id, targetProductId);
  await tx.productSize.update({ where: { id: duplicate.id }, data: { barcode: null, size: uniqueArchiveSize(duplicate.id), stock: 0, sizeConfirmedAt: null } });
}

async function moveToCanonicalPlaceholder(tx, duplicateSizeId, targetProductId, ref) {
  const duplicate = await tx.productSize.findUnique({ where: { id: duplicateSizeId }, include: { storeStocks: true } });
  const targetProduct = await tx.product.findUnique({ where: { id: targetProductId } });
  if (!duplicate || !targetProduct) throw new Error(`legacy variant missing: ${duplicateSizeId}`);
  const placeholder = legacyPlaceholder(ref, duplicate.id);
  const target = await tx.productSize.create({ data: { productId: targetProductId, size: placeholder, barcode: duplicate.barcode, stock: 0, sizeConfirmedAt: null } });
  for (const stock of duplicate.storeStocks) {
    if (stock.stock !== 0) {
      await tx.storeStockMovement.create({ data: {
        storeId: stock.storeId, productSizeId: duplicate.id, type: 'stocktake_repair_transfer_out', quantity: -stock.stock,
        stockBefore: stock.stock, stockAfter: 0, source: REPAIR_SOURCE, reason: 'Consolidação de card Adidas duplicado', metadata: { targetProductSizeId: target.id },
      } });
      await tx.storeStockMovement.create({ data: {
        storeId: stock.storeId, productSizeId: target.id, type: 'stocktake_repair_transfer_in', quantity: stock.stock,
        stockBefore: 0, stockAfter: stock.stock, source: REPAIR_SOURCE, reason: 'Consolidação de card Adidas duplicado', metadata: { sourceProductSizeId: duplicate.id },
      } });
      await tx.storeStock.update({ where: { id: stock.id }, data: { productSizeId: target.id } });
    }
  }
  await tx.stocktakeBipe.updateMany({
    where: { productSizeId: duplicate.id },
    data: { productId: targetProductId, productSizeId: target.id, productName: targetProduct.name, productSize: placeholder, productBrand: targetProduct.brand, found: true, duplicate: false },
  });
  await tx.productCapture.updateMany({ where: { matchedProductId: duplicate.productId }, data: { matchedProductId: targetProductId } });
  await moveVariantMapping(tx, duplicate.id, target.id, targetProductId);
  await tx.productSize.update({ where: { id: duplicate.id }, data: { barcode: null, size: uniqueArchiveSize(duplicate.id), stock: 0, sizeConfirmedAt: null } });
  return target.id;
}

async function applyPlan(plan) {
  if (plan.conflicts.some((row) => row.status === 'blocked')) throw new Error('Existem conflitos bloqueados; aplicação cancelada');
  if (plan.references.some((row) => row.status === 'blocked')) throw new Error('Existem duplicidades por referência bloqueadas; aplicação cancelada');

  const result = { categories: 0, nuvemshopBlocked: 0, orphansReset: 0, conflicts: 0, referenceGroups: 0, variantsArchived: 0, variantsMoved: 0, productsArchived: 0 };
  await prisma.$transaction(async (tx) => {
    for (const conflict of plan.conflicts.filter((row) => row.status === 'ready')) {
      const target = await tx.productSize.findUnique({ where: { id: conflict.canonical.productSizeId }, include: { product: true } });
      if (!target || target.barcode !== conflict.barcode) throw new Error(`Plano stale no GTIN ${conflict.barcode}`);
      for (const duplicate of conflict.duplicates) {
        await archiveDuplicateIntoExisting(tx, duplicate.productSizeId, target.id, target.productId, `Remoção de saldo duplicado do GTIN ${conflict.barcode}`);
        result.variantsArchived++;
        if (await markDuplicateProduct(tx, duplicate.productId, target.productId, modelRef(target.product) || conflict.barcode)) result.productsArchived++;
      }
      await tx.stocktakeBipe.updateMany({ where: { barcode: conflict.barcode }, data: { productId: target.productId, productSizeId: target.id, productName: target.product.name, productSize: target.size, productBrand: target.product.brand, found: true, duplicate: false } });
      result.conflicts++;
    }

    for (const group of plan.references.filter((row) => row.status === 'ready')) {
      for (const duplicate of group.duplicates.filter((row) => row.status === 'ready')) {
        for (const sizePlan of duplicate.sizePlans) {
          if (sizePlan.status === 'handled_by_conflict') continue;
          if (sizePlan.status === 'dedupe_existing') {
            await archiveDuplicateIntoExisting(tx, sizePlan.productSizeId, sizePlan.targetProductSizeId, group.canonicalProductId, `Consolidação do modelo Adidas ${group.ref}`);
            result.variantsArchived++;
          } else if (sizePlan.status === 'move_placeholder') {
            await moveToCanonicalPlaceholder(tx, sizePlan.productSizeId, group.canonicalProductId, group.ref);
            result.variantsMoved++;
          } else if (sizePlan.status === 'archive_zero') {
            await tx.productSize.update({ where: { id: sizePlan.productSizeId }, data: { barcode: null, size: uniqueArchiveSize(sizePlan.productSizeId), stock: 0, sizeConfirmedAt: null } });
            result.variantsArchived++;
          }
        }
        if (await markDuplicateProduct(tx, duplicate.productId, group.canonicalProductId, group.ref)) result.productsArchived++;
      }
      result.referenceGroups++;
    }

    for (const productId of plan.productIds) {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product || !product.active) continue;
      const ctx = contextOf(product);
      await tx.product.update({
        where: { id: productId },
        data: {
          category: 'Calçados',
          aiContext: {
            ...ctx,
            confirmedForNuvemshop: false,
            hideFromNuvemshop: true,
            adidasStockReview: { status: 'blocked_pending_physical_recount', at: new Date().toISOString(), source: REPAIR_SOURCE },
          },
        },
      });
      result.categories += String(product.category || '').trim().toUpperCase() === 'CALÇADOS' ? 0 : 1;
      result.nuvemshopBlocked++;
    }

    const orphanIds = plan.orphanBipes.map((row) => row.id);
    if (orphanIds.length) {
      const updated = await tx.stocktakeBipe.updateMany({ where: { id: { in: orphanIds }, productSizeId: null }, data: { applied: false, found: false, duplicate: false } });
      result.orphansReset = updated.count;
    }
  }, { timeout: 120_000, maxWait: 15_000 });
  return result;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
  const plan = await buildPlan();
  const outDir = path.join(__dirname, '..', APPLY ? 'backups' : 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const planFile = path.join(outDir, `adidas-production-${APPLY ? 'apply' : 'dry-run'}-${stamp}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

  if (!APPLY) {
    console.log(JSON.stringify({ ok: true, applied: false, planFile, summary: plan.summary }));
    return;
  }
  const result = await applyPlan(plan);
  const after = await buildPlan();
  const resultFile = path.join(outDir, `adidas-production-result-${stamp}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({ planFile, result, after }, null, 2));
  console.log(JSON.stringify({ ok: true, applied: true, planFile, resultFile, result, after: after.summary }));
}

main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(async () => prisma.$disconnect());
