const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { applyStoreStockDelta } = require('../src/services/storeStockLedger');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const CUTOFF = new Date(process.env.SALE_STOCK_BACKFILL_CUTOFF || '2026-06-04T18:31:15.000Z');

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

async function buildPlan() {
  const lastCounts = await prisma.stocktakeBipe.groupBy({
    by: ['storeId'],
    where: { applied: true, storeId: { not: null } },
    _max: { bipedAt: true },
  });
  const countByStore = new Map(lastCounts.map((row) => [row.storeId, row._max.bipedAt]));

  const sales = await prisma.sale.findMany({
    where: {
      status: 'completed',
      storeId: { not: null },
      createdAt: { gte: CUTOFF },
      items: { some: { size: null, productId: { not: null } } },
    },
    select: {
      id: true,
      storeId: true,
      createdAt: true,
      items: {
        where: { size: null, productId: { not: null } },
        select: { id: true, productId: true, productSizeId: true, productName: true, quantity: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const productIds = [...new Set(sales.flatMap((sale) => sale.items.map((item) => item.productId)).filter(Boolean))];
  const storeIds = [...new Set(sales.map((sale) => sale.storeId).filter(Boolean))];
  const stores = await prisma.store.findMany({
    where: { id: { in: storeIds } },
    select: { id: true, code: true, name: true },
  });
  const storeById = new Map(stores.map((store) => [store.id, store]));
  const sizes = await prisma.productSize.findMany({
    where: { productId: { in: productIds } },
    select: {
      id: true,
      productId: true,
      size: true,
      storeStocks: {
        where: { storeId: { in: storeIds } },
        select: { id: true, storeId: true, stock: true, updatedAt: true },
      },
    },
  });
  const sizesByProduct = new Map();
  for (const size of sizes) {
    if (!sizesByProduct.has(size.productId)) sizesByProduct.set(size.productId, []);
    sizesByProduct.get(size.productId).push(size);
  }

  const plan = [];
  const unresolved = [];
  for (const sale of sales) {
    const store = storeById.get(sale.storeId);
    const lastCountAt = countByStore.get(sale.storeId);
    for (const item of sale.items) {
      if (item.productSizeId) continue;
      if (!lastCountAt || sale.createdAt <= lastCountAt) {
        unresolved.push({ reason: 'sale_before_last_physical_count', saleId: sale.id, saleItemId: item.id, quantity: item.quantity, storeCode: store?.code || null });
        continue;
      }
      const local = (sizesByProduct.get(item.productId) || [])
        .map((size) => ({ size, stock: size.storeStocks.find((row) => row.storeId === sale.storeId) }))
        .filter((entry) => entry.stock);
      if (local.length !== 1) {
        unresolved.push({ reason: local.length ? 'ambiguous_local_sizes' : 'no_local_size', saleId: sale.id, saleItemId: item.id, quantity: item.quantity, storeCode: store?.code || null, candidateCount: local.length });
        continue;
      }
      const chosen = local[0];
      plan.push({
        saleId: sale.id,
        saleItemId: item.id,
        saleCreatedAt: sale.createdAt,
        storeId: sale.storeId,
        storeCode: store?.code || null,
        storeName: store?.name || null,
        productId: item.productId,
        productName: item.productName,
        productSizeId: chosen.size.id,
        size: chosen.size.size,
        quantity: item.quantity,
        stockBefore: chosen.stock.stock,
        lastPhysicalCountAt: lastCountAt,
      });
    }
  }
  return { plan, unresolved };
}

function summarize(rows, unresolved) {
  const byStore = {};
  for (const row of rows) {
    const key = row.storeCode || row.storeId;
    if (!byStore[key]) byStore[key] = { items: 0, units: 0 };
    byStore[key].items += 1;
    byStore[key].units += row.quantity;
  }
  const unresolvedByReason = {};
  for (const row of unresolved) {
    if (!unresolvedByReason[row.reason]) unresolvedByReason[row.reason] = { items: 0, units: 0 };
    unresolvedByReason[row.reason].items += 1;
    unresolvedByReason[row.reason].units += row.quantity;
  }
  return {
    cutoff: CUTOFF.toISOString(),
    eligibleItems: rows.length,
    eligibleUnits: rows.reduce((sum, row) => sum + row.quantity, 0),
    byStore,
    unresolvedItems: unresolved.length,
    unresolvedUnits: unresolved.reduce((sum, row) => sum + row.quantity, 0),
    unresolvedByReason,
  };
}

async function applyPlan(plan) {
  if (process.env.CONFIRM_SALE_STOCK_BACKFILL !== 'APPLY') {
    throw new Error('Para aplicar, defina CONFIRM_SALE_STOCK_BACKFILL=APPLY. Sem isso o script é somente leitura.');
  }

  const outputDir = path.resolve(__dirname, '..', 'backups');
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(outputDir, `sale-stock-backfill-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({ generatedAt: new Date().toISOString(), cutoff: CUTOFF.toISOString(), plan: plan.map((row) => ({ ...row, saleCreatedAt: iso(row.saleCreatedAt), lastPhysicalCountAt: iso(row.lastPhysicalCountAt) })) }, null, 2));

  let applied = 0;
  let units = 0;
  for (const row of plan) {
    await prisma.$transaction(async (tx) => {
      const item = await tx.saleItem.findUnique({ where: { id: row.saleItemId }, select: { productSizeId: true, size: true, quantity: true } });
      if (!item || item.productSizeId || item.size) return;
      const prior = await tx.storeStockMovement.findFirst({ where: { saleItemId: row.saleItemId, type: 'historical_backfill' }, select: { id: true } });
      if (prior) return;
      await tx.saleItem.update({ where: { id: row.saleItemId }, data: { productSizeId: row.productSizeId, size: row.size } });
      await applyStoreStockDelta(tx, {
        storeId: row.storeId,
        productSizeId: row.productSizeId,
        saleId: row.saleId,
        saleItemId: row.saleItemId,
        quantity: -item.quantity,
        type: 'historical_backfill',
        source: 'safe_backfill_2026_07',
        reason: 'Venda sem tamanho, posterior à última contagem física e com uma única variante localizada na loja.',
        metadata: { lastPhysicalCountAt: iso(row.lastPhysicalCountAt), originalSize: null },
      });
      applied += 1;
      units += item.quantity;
    });
  }
  return { backupPath, applied, units };
}

async function main() {
  const { plan, unresolved } = await buildPlan();
  const summary = summarize(plan, unresolved);
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...summary }, null, 2));
  if (!APPLY) return;
  const result = await applyPlan(plan);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

main()
  .catch((err) => {
    console.error(`BACKFILL_ERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
