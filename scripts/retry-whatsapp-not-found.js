// =====================================================================
// retry-whatsapp-not-found.js
// Pega o progress.json gerado por process-whatsapp-stock.js e re-tenta o
// match nos itens que ficaram NOT FOUND, usando o findProduct atual (já com
// estratégia 4b name_prefix). Não chama Vision de novo — usa o ext salvo.
//
// Uso:
//   node scripts/retry-whatsapp-not-found.js \
//        --progress /c/tmp/estoque-fotos/parahyba.entries.progress.json \
//        --store LOJA02 \
//        --apply  (sem flag = dry-run)
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
const APPLY = !!args.apply;

if (!PROGRESS_FILE || !STORE_CODE) {
  console.error('Uso: --progress <file.json> --store LOJA0X [--apply]');
  process.exit(1);
}

const prisma = new PrismaClient();

async function findProduct(ext) {
  if (!ext || ext.erro) return null;
  const ref = (ext.codigoFornecedor || '').trim().toUpperCase();
  const ean = (ext.ean || '').replace(/\D/g, '');

  if (ean && ean.length >= 12) {
    const byEan = await prisma.product.findFirst({
      where: { active: true, sku: { contains: ean, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true },
    });
    if (byEan) return { ...byEan, matchedBy: 'ean' };
  }
  if (ref) {
    const byRef = await prisma.product.findFirst({
      where: { active: true, aiContext: { path: ['supplierRef'], equals: ref } },
      select: { id: true, sku: true, name: true, brand: true },
    });
    if (byRef) return { ...byRef, matchedBy: 'supplierRef' };
  }
  if (ref) {
    const bySku = await prisma.product.findFirst({
      where: { active: true, sku: { endsWith: ref, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true },
    });
    if (bySku) return { ...bySku, matchedBy: 'sku' };
  }
  if (ref) {
    const byName = await prisma.product.findFirst({
      where: { active: true, name: { contains: ref, mode: 'insensitive' } },
      select: { id: true, sku: true, name: true, brand: true },
    });
    if (byName) return { ...byName, matchedBy: 'name' };
  }
  if (ref) {
    const refPrefix = ref.split(/[-\s]/)[0];
    if (refPrefix && refPrefix.length >= 5 && refPrefix !== ref) {
      const byNamePrefix = await prisma.product.findFirst({
        where: { active: true, name: { contains: refPrefix, mode: 'insensitive' } },
        select: { id: true, sku: true, name: true, brand: true },
      });
      if (byNamePrefix) return { ...byNamePrefix, matchedBy: 'name_prefix' };
      const bySupRefPref = await prisma.product.findFirst({
        where: { active: true, aiContext: { path: ['supplierRef'], equals: refPrefix } },
        select: { id: true, sku: true, name: true, brand: true },
      });
      if (bySupRefPref) return { ...bySupRefPref, matchedBy: 'supplierRef_prefix' };
    }
  }
  // 4c) supplierRef LIKE ref% (cobre Brooks: etiqueta 1104471D099, banco 1104471D099070)
  if (ref) {
    const refClean = ref.replace(/\s+/g, '');
    if (refClean.length >= 6) {
      const rows = await prisma.$queryRaw`
        SELECT id, sku, name, brand
        FROM "Product"
        WHERE active = true
          AND "aiContext"->>'supplierRef' LIKE ${refClean + '%'}
        LIMIT 1`;
      if (rows && rows[0]) return { ...rows[0], matchedBy: 'supplierRef_startsWith' };
    }
  }
  if (ext.marca && ext.modelo) {
    const modelTokens = ext.modelo.split(/\s+/).filter(t => t.length >= 3).slice(0, 3);
    if (modelTokens.length) {
      const candidates = await prisma.product.findMany({
        where: {
          active: true,
          brand: { contains: ext.marca, mode: 'insensitive' },
          AND: modelTokens.map(t => ({ name: { contains: t, mode: 'insensitive' } })),
        },
        select: { id: true, sku: true, name: true, brand: true },
        take: 1,
      });
      if (candidates[0]) return { ...candidates[0], matchedBy: 'name_fuzzy' };
    }
  }
  return null;
}

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
  const notFound = Object.entries(progress).filter(([_, v]) => v && v.ext && v.matched === false);
  console.log(`\n=== Retry NOT FOUND ===`);
  console.log(`Total no progress: ${Object.keys(progress).length}`);
  console.log(`NOT FOUND a retentar: ${notFound.length}`);
  console.log(`Modo: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Loja: ${STORE_CODE} (${store.name})\n`);

  let recovered = 0;
  let totalSizesApplied = 0;
  for (const [photo, entry] of notFound) {
    const product = await findProduct(entry.ext);
    if (!product) continue;
    recovered++;
    console.log(`✓ ${photo.slice(0, 22)} → ${product.brand} ${product.sku} (${product.matchedBy})`);
    progress[photo] = { ...entry, productId: product.id, matchedBy: product.matchedBy, matched: undefined };
    delete progress[photo].matched;
    if (APPLY && entry.sizes && entry.sizes.length) {
      const r = await applyStock(product.id, entry.sizes, store.id);
      totalSizesApplied += entry.sizes.reduce((a, s) => a + (s.qty || 1), 0);
      progress[photo].applied = r;
    }
  }

  if (recovered > 0) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  }

  console.log(`\n=== Resumo ===`);
  console.log(`  Recuperados:   ${recovered} de ${notFound.length}`);
  console.log(`  Taxa recovery: ${notFound.length ? (recovered / notFound.length * 100).toFixed(1) : 0}%`);
  if (APPLY) console.log(`  Aplicado:      ${totalSizesApplied} unidades em ${STORE_CODE}`);
  await prisma.$disconnect();
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
