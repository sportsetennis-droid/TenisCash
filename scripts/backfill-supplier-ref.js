// =====================================================================
// Backfill: preenche aiContext.supplierRef nos produtos já importados.
// Extrai a referência do fornecedor (cProd da NF-e) de:
//   1. aiContext.baseProductKey (ex: "tenis-ct00010001-chuck-...")
//   2. sku (ex: "0750-CT00010001")
// =====================================================================
// Uso:
//   node scripts/backfill-supplier-ref.js [--cnpj=02675611000750] [--dry-run]
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function extractRef(product) {
  const ctx = (() => {
    try {
      if (!product.aiContext) return {};
      return typeof product.aiContext === 'string' ? JSON.parse(product.aiContext) : product.aiContext;
    } catch (_) { return {}; }
  })();

  if (ctx.supplierRef) return { ref: ctx.supplierRef, ctx, source: 'already-set' };

  // Tenta baseProductKey
  if (ctx.baseProductKey) {
    const m = String(ctx.baseProductKey).match(/([a-z]{2,4}\d{6,12})/i);
    if (m) return { ref: m[1].toUpperCase(), ctx, source: 'baseProductKey' };
  }

  // Tenta SKU (formato "0750-CT00010001")
  if (product.sku) {
    const m = String(product.sku).match(/-([A-Za-z]{2,4}\d{6,12})/);
    if (m) return { ref: m[1].toUpperCase(), ctx, source: 'sku' };
  }

  return { ref: null, ctx, source: null };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cnpjArg = args.find((a) => a.startsWith('--cnpj='));
  const cnpj = cnpjArg ? cnpjArg.split('=')[1] : null;

  console.log(`\n=== Backfill supplierRef ===`);
  console.log(`Modo: ${dryRun ? 'DRY-RUN' : 'WRITE'}`);
  console.log(`Filtro CNPJ: ${cnpj || '(todos)'}\n`);

  const where = { active: true };
  if (cnpj) where.aiContext = { path: ['supplierCnpj'], equals: cnpj };

  const products = await prisma.product.findMany({
    where,
    select: { id: true, sku: true, name: true, aiContext: true },
  });
  console.log(`Encontrados ${products.length} produtos\n`);

  let updated = 0;
  let skipped = 0;
  let noRef = 0;
  const samples = [];

  for (const p of products) {
    const { ref, ctx, source } = extractRef(p);
    if (!ref) { noRef++; continue; }
    if (source === 'already-set') { skipped++; continue; }

    if (samples.length < 10) {
      samples.push({ sku: p.sku, name: p.name?.slice(0, 50), ref, source });
    }

    if (!dryRun) {
      await prisma.product.update({
        where: { id: p.id },
        data: { aiContext: { ...ctx, supplierRef: ref } },
      });
    }
    updated++;
  }

  console.log('Amostra:');
  for (const s of samples) console.log(`  [${s.source}] ${s.ref}  ←  ${s.sku} (${s.name})`);

  console.log(`\n✅ Resultado:`);
  console.log(`   Atualizados:        ${updated}`);
  console.log(`   Já tinham supplierRef: ${skipped}`);
  console.log(`   Sem ref detectável: ${noRef}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
