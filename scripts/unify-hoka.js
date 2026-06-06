// Consolida HOKA: junta cards com a MESMA foto (= mesmo produto/cor), preenche
// a COR (verificada visualmente) e limpa o nome (modelo). Backup antes. --apply pra escrever.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// modelo limpo a partir do nome bagunçado
function model(name) {
  const n = (name || '').toUpperCase();
  if (n.includes('CLIFTON 10')) return 'Clifton 10';
  if (n.includes('CLIFTON 9')) return 'Clifton 9';
  if (n.includes('MACH X 2') || n.includes('MACH X2')) return 'Mach X 2';
  if (n.includes('MACH 7')) return 'Mach 7';
  if (n.includes('BONDI 8')) return 'Bondi 8';
  if (n.includes('BONDI 9')) return 'Bondi 9';
  if (n.includes('SKYFLOW')) return 'Skyflow';
  if (n.includes('RINCON 4')) return 'Rincon 4';
  return null;
}
// cor por trecho da URL da foto (verificado olhando cada imagem)
function colorByUrl(url) {
  const u = (url || '');
  if (u.includes('clifton-10tenis')) return 'Cinza';
  if (u.includes('mach-7tenis')) return 'Preto';
  if (u.includes('31aku2xb7lL')) return 'Preto';            // Bondi 8 amazon
  if (u.includes('bondi-9tenis')) return 'Branco/Cinza';
  if (u.includes('clifton-9')) return 'Azul';
  if (u.includes('1155120-FCQ') || u.includes('158081')) return 'Branco/Verde'; // Mach X 2
  if (u.includes('skyflowtenis')) return 'Branco/Verde/Laranja';
  if (u.includes('31auKXMN6iL')) return 'Preto/Branco';     // Rincon 4 amazon
  if (u.includes('image-photoroom-5')) return 'Verde Água'; // W Rincon 4
  return null;
}

async function moveSizesTo(tx, fromIds, canonId) {
  const canonSizes = await tx.productSize.findMany({ where: { productId: canonId }, select: { size: true } });
  const used = new Set(canonSizes.map(s => s.size));
  const uniq = (ean) => { let l = 'T-' + String(ean).slice(-4); if (used.has(l)) l = 'T-' + String(ean).slice(-6); if (used.has(l)) l = 'T-' + String(ean); while (used.has(l)) l = 'T-' + String(ean) + '-' + used.size; used.add(l); return l; };
  for (const fid of fromIds) {
    const sizes = await tx.productSize.findMany({ where: { productId: fid } });
    for (const sz of sizes) {
      const dupe = await tx.productSize.findFirst({ where: { productId: canonId, barcode: sz.barcode || '___none___' } });
      if (dupe) {
        const ss = await tx.storeStock.findMany({ where: { productSizeId: sz.id } });
        for (const x of ss) await tx.storeStock.upsert({ where: { storeId_productSizeId: { storeId: x.storeId, productSizeId: dupe.id } }, update: { stock: { increment: x.stock || 0 } }, create: { storeId: x.storeId, productSizeId: dupe.id, stock: x.stock || 0 } });
        await tx.storeStock.deleteMany({ where: { productSizeId: sz.id } });
        await tx.productSize.delete({ where: { id: sz.id } });
      } else {
        await tx.productSize.update({ where: { id: sz.id }, data: { productId: canonId, size: uniq(sz.barcode || sz.id) } });
      }
    }
    await tx.product.update({ where: { id: fid }, data: { active: false } });
  }
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT pr.id, pr.name, pr."imageUrl" img, pr."aiContext" ctx,
      (pr."aiContext"->'catalogPlan'->'imageQuality'->>'flag') imgq,
      (SELECT count(*)::int FROM "ProductSize" pz WHERE pz."productId"=pr.id) nsizes,
      (SELECT COALESCE(sum(stock),0)::int FROM "ProductSize" pz WHERE pz."productId"=pr.id) compr
    FROM "Product" pr WHERE pr.active AND (upper(pr.brand) LIKE '%HOKA%' OR upper(pr.name) LIKE '%HOKA%')`);

  // agrupa por imageUrl (mesma foto = mesmo produto/cor)
  const byImg = {};
  for (const r of rows) { const k = r.img || ('noimg-' + r.id); (byImg[k] = byImg[k] || []).push(r); }
  const merges = Object.values(byImg).filter(g => g.length > 1);

  console.log(`HOKA ativos: ${rows.length} · grupos por foto: ${Object.keys(byImg).length} · merges(>1): ${merges.length}`);
  merges.forEach(g => console.log(`  juntar ${g.length} → "${model(g[0].name) || g[0].name}" (${colorByUrl(g[0].img) || '?'})`));

  if (!APPLY) { console.log('\nDRY-RUN. --apply pra executar.'); await prisma.$disconnect(); return; }

  // backup
  const ids = rows.map(r => r.id);
  const bkDir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(bkDir, { recursive: true });
  const pss = await prisma.productSize.findMany({ where: { productId: { in: ids } } });
  const sss = await prisma.storeStock.findMany({ where: { productSizeId: { in: pss.map(s => s.id) } } });
  const prods = await prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, active: true, aiContext: true } });
  const bf = path.join(bkDir, 'hoka-' + Date.now() + '.json'); fs.writeFileSync(bf, JSON.stringify({ prods, pss, sss }, null, 0));
  console.log('BACKUP:', bf);

  // 1) merges por foto
  let merged = 0;
  for (const g of merges) {
    const sorted = [...g].sort((a, b) => ((b.imgq === 'boa') - (a.imgq === 'boa')) || (b.nsizes - a.nsizes) || (b.compr - a.compr));
    const canon = sorted[0];
    await prisma.$transaction(async (tx) => { await moveSizesTo(tx, sorted.slice(1).map(x => x.id), canon.id); }, { timeout: 60000, maxWait: 20000 });
    merged += sorted.length - 1;
  }

  // 2) preenche cor + limpa nome em TODOS os HOKA ativos restantes
  const after = await prisma.$queryRawUnsafe(`SELECT pr.id, pr.name, pr."imageUrl" img, pr."aiContext" ctx FROM "Product" pr WHERE pr.active AND (upper(pr.brand) LIKE '%HOKA%' OR upper(pr.name) LIKE '%HOKA%')`);
  let named = 0, colored = 0;
  for (const r of after) {
    const m = model(r.name); const c = colorByUrl(r.img);
    let ctx = {}; try { ctx = typeof r.ctx === 'string' ? JSON.parse(r.ctx) : (r.ctx || {}); } catch (_) {}
    const data = {};
    if (m && r.name !== m) { data.name = m; named++; }
    if (c && ctx.color !== c) { ctx.color = c; data.aiContext = ctx; colored++; }
    if (Object.keys(data).length) await prisma.product.update({ where: { id: r.id }, data });
  }
  console.log(`\nFEITO. cards fundidos: ${merged} · nomes limpos: ${named} · cores preenchidas: ${colored} · HOKA ativos agora: ${after.length}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
