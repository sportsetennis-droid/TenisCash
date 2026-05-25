// Aplica bipes do dia ao StoreStock — modo Substituir
// Uso: node scripts/apply-bipes-stock.js          → dryRun (só mostra)
//      node scripts/apply-bipes-stock.js --apply   → aplica
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const APPLY = process.argv.includes('--apply');

(async () => {
  const r = await p.$queryRaw`SELECT DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza')::timestamp AS d, (DATE_TRUNC('day', NOW() AT TIME ZONE 'America/Fortaleza') + INTERVAL '1 day' - INTERVAL '1 millisecond')::timestamp AS e`;
  const dayStart = r[0].d, dayEnd = r[0].e;
  const where = {
    bipedAt: { gte: dayStart, lte: dayEnd },
    found: true, applied: false,
    productSizeId: { not: null }, storeId: { not: null },
  };

  const groups = await p.stocktakeBipe.groupBy({
    by: ['storeId', 'productSizeId'], where, _count: { id: true },
  });
  if (groups.length === 0) { console.log('Nada pra aplicar'); process.exit(0); }

  const sizeIds = [...new Set(groups.map(g => g.productSizeId))];
  const sizes = await p.productSize.findMany({
    where: { id: { in: sizeIds } },
    include: { product: { select: { name: true, brand: true, sku: true } } },
  });
  const sizeMap = Object.fromEntries(sizes.map(s => [s.id, s]));
  const storeIds = [...new Set(groups.map(g => g.storeId))];
  const stores = await p.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, name: true, code: true } });
  const storeMap = Object.fromEntries(stores.map(s => [s.id, s]));
  const cur = await p.storeStock.findMany({
    where: { OR: groups.map(g => ({ storeId: g.storeId, productSizeId: g.productSizeId })) },
  });
  const curMap = Object.fromEntries(cur.map(c => [c.storeId + ':' + c.productSizeId, c.stock]));

  const plan = groups.map(g => ({
    storeId: g.storeId, store: storeMap[g.storeId]?.code || '?',
    sizeId: g.productSizeId, size: sizeMap[g.productSizeId]?.size,
    product: sizeMap[g.productSizeId]?.product?.name || '?',
    brand: sizeMap[g.productSizeId]?.product?.brand || '',
    cur: curMap[g.storeId + ':' + g.productSizeId] || 0,
    nov: g._count.id,
  })).sort((a,b) => b.nov - a.nov);

  console.log(`PLANO: ${plan.length} produto×loja, ${plan.reduce((s,p)=>s+p.nov,0)} bipes`);
  console.log('Top 20:');
  plan.slice(0, 20).forEach(p => {
    const delta = p.nov - p.cur;
    const sig = delta >= 0 ? '+' : '';
    console.log(`  ${p.store} | ${(p.product||'').slice(0,40).padEnd(40)} ${(p.size||'').padEnd(8)} | ${p.cur} → ${p.nov} (${sig}${delta})`);
  });

  if (!APPLY) { console.log('\nPra aplicar: --apply'); process.exit(0); }

  console.log('\nAPLICANDO...');
  let applied = 0;
  for (const it of plan) {
    await p.storeStock.upsert({
      where: { storeId_productSizeId: { storeId: it.storeId, productSizeId: it.sizeId } },
      update: { stock: it.nov },
      create: { storeId: it.storeId, productSizeId: it.sizeId, stock: it.nov },
    });
    applied++;
  }
  const upd = await p.stocktakeBipe.updateMany({ where, data: { applied: true } });
  console.log(`✅ ${applied} StoreStock atualizados`);
  console.log(`✅ ${upd.count} bipes marcados como aplicados`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
