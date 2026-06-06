// Aplica no estoque LOCALIZADO (StoreStock) os bipes reconhecidos (found=true) que
// ficaram pendentes (applied=false). NÃO toca no comprado (ProductSize.stock). Backup antes.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const bipes = await prisma.stocktakeBipe.findMany({
    where: { found: true, applied: false },
    select: { id: true, barcode: true, storeId: true, productSizeId: true },
  });
  console.log('bipes reconhecidos pendentes:', bipes.length);

  // resolve ProductSize atual (prefere o productSizeId; senão pelo barcode) e agrupa por (loja, size)
  const groups = {}; // key storeId|psId -> {storeId, psId, count, bipeIds:[]}
  let semPs = 0, semLoja = 0;
  const psCacheById = new Map(), psCacheByBc = new Map();
  for (const b of bipes) {
    if (!b.storeId) { semLoja++; continue; }
    let psId = null;
    if (b.productSizeId) {
      if (!psCacheById.has(b.productSizeId)) psCacheById.set(b.productSizeId, await prisma.productSize.findUnique({ where: { id: b.productSizeId }, select: { id: true } }));
      const ps = psCacheById.get(b.productSizeId); if (ps) psId = ps.id;
    }
    if (!psId && b.barcode) {
      if (!psCacheByBc.has(b.barcode)) psCacheByBc.set(b.barcode, await prisma.productSize.findFirst({ where: { barcode: b.barcode }, select: { id: true } }));
      const ps = psCacheByBc.get(b.barcode); if (ps) psId = ps.id;
    }
    if (!psId) { semPs++; continue; }
    const k = b.storeId + '|' + psId;
    if (!groups[k]) groups[k] = { storeId: b.storeId, psId, count: 0, bipeIds: [] };
    groups[k].count++; groups[k].bipeIds.push(b.id);
  }
  const gList = Object.values(groups);
  console.log(`grupos (loja+tamanho): ${gList.length} · sem ProductSize: ${semPs} · sem loja: ${semLoja}`);

  // backup
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const bf = path.join(dir, 'apply-bipes-' + Date.now() + '.json');
  fs.writeFileSync(bf, JSON.stringify(gList.map(g => ({ storeId: g.storeId, psId: g.psId, count: g.count, bipeIds: g.bipeIds }))));
  console.log('BACKUP:', bf);

  // aplica (grupos = linhas distintas, seguro em paralelo) em lotes de 20
  let applied = 0, errs = 0;
  for (let i = 0; i < gList.length; i += 20) {
    const slice = gList.slice(i, i + 20);
    await Promise.all(slice.map(async (g) => {
      try {
        await prisma.storeStock.upsert({
          where: { storeId_productSizeId: { storeId: g.storeId, productSizeId: g.psId } },
          update: { stock: { increment: g.count } },
          create: { storeId: g.storeId, productSizeId: g.psId, stock: g.count },
        });
        await prisma.stocktakeBipe.updateMany({ where: { id: { in: g.bipeIds } }, data: { applied: true } });
        applied += g.count;
      } catch (e) { errs++; }
    }));
    if (i % 400 < 20) console.log(`  ...${i}/${gList.length} grupos`);
  }
  console.log(`\nFEITO. unidades localizadas aplicadas: ${applied} · grupos com erro: ${errs}`);
  const rest = await prisma.stocktakeBipe.count({ where: { found: true, applied: false } });
  console.log('bipes reconhecidos ainda pendentes:', rest, '(esperado = sem ProductSize/loja:', semPs + semLoja, ')');
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
