// =====================================================================
// apply-from-progress.js
// Lê o progress.json gerado pelo process-whatsapp-stock.js e aplica
// StoreStock pra TODAS as entries que têm productId (matched).
// Idempotente: ignora entries com `applied` já setado.
//
// Uso:
//   node scripts/apply-from-progress.js \
//        --progress /c/tmp/estoque-fotos/parahyba.entries.progress.json \
//        --store LOJA02
// =====================================================================

try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));

const PROGRESS_FILE = args.progress;
const STORE_CODE = args.store;

if (!PROGRESS_FILE || !STORE_CODE) {
  console.error('Uso: --progress <file.json> --store LOJA0X');
  process.exit(1);
}

const prisma = new PrismaClient();

async function applyStock(productId, sizes, storeId) {
  let created = 0, updated = 0;
  for (const s of sizes) {
    let ps = await prisma.productSize.findFirst({ where: { productId, size: String(s.size) } });
    if (!ps) ps = await prisma.productSize.create({ data: { productId, size: String(s.size), stock: 0 } });
    const existing = await prisma.storeStock.findFirst({ where: { productSizeId: ps.id, storeId } });
    if (existing) {
      await prisma.storeStock.update({ where: { id: existing.id }, data: { stock: existing.stock + (s.qty || 1) } });
      updated++;
    } else {
      await prisma.storeStock.create({ data: { productSizeId: ps.id, storeId, stock: s.qty || 1 } });
      created++;
    }
    const all = await prisma.storeStock.findMany({ where: { productSizeId: ps.id } });
    await prisma.productSize.update({ where: { id: ps.id }, data: { stock: all.reduce((a, b) => a + (b.stock || 0), 0) } });
  }
  return { created, updated };
}

(async () => {
  const store = await prisma.store.findUnique({ where: { code: STORE_CODE } });
  if (!store) { console.error('Store ' + STORE_CODE + ' não existe'); process.exit(1); }
  const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  const entries = Object.entries(progress);
  const matched = entries.filter(([_, v]) => v && v.productId && !v.applied);
  const alreadyApplied = entries.filter(([_, v]) => v && v.applied).length;
  const notMatched = entries.filter(([_, v]) => v && !v.productId).length;

  console.log(`\n=== Apply Stock from Progress ===`);
  console.log(`Loja: ${STORE_CODE} (${store.name})`);
  console.log(`Total no progress: ${entries.length}`);
  console.log(`Já aplicados:      ${alreadyApplied}`);
  console.log(`A aplicar agora:   ${matched.length}`);
  console.log(`Sem match:         ${notMatched}\n`);

  let processed = 0;
  let totalSizesApplied = 0;
  let totalCreated = 0, totalUpdated = 0;

  for (const [photo, entry] of matched) {
    processed++;
    const sizes = entry.sizes || [];
    if (!sizes.length) {
      if (processed % 50 === 0) process.stdout.write('.');
      continue;
    }
    try {
      const r = await applyStock(entry.productId, sizes, store.id);
      const units = sizes.reduce((a, s) => a + (s.qty || 1), 0);
      totalSizesApplied += units;
      totalCreated += r.created;
      totalUpdated += r.updated;
      progress[photo].applied = r;
      if (processed % 25 === 0) {
        fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
        process.stdout.write(`\n[${processed}/${matched.length}] applied ${totalSizesApplied} un. so far...`);
      }
    } catch (e) {
      console.error(`\n  ERR ${photo}:`, e.message);
    }
  }
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));

  console.log(`\n\n=== Resumo final ===`);
  console.log(`  Fotos aplicadas:  ${processed}`);
  console.log(`  Unidades stock:   ${totalSizesApplied}`);
  console.log(`  StoreStock novos: ${totalCreated}`);
  console.log(`  StoreStock upd:   ${totalUpdated}`);
  console.log(`  Loja:             ${STORE_CODE}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
