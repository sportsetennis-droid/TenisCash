// Recupera bipes NÃO reconhecidos que falharam só por causa do ZERO À ESQUERDA
// (caixa = UPC-12 "195394510652"; banco = GTIN-13 "0195394510652"). Casa por variante,
// marca found, e aplica no StoreStock (cada bipe = 1 unidade localizada). NÃO mexe no
// comprado (ProductSize.stock). Backup antes. DRY-RUN por padrão; --apply pra escrever.
const fs = require('fs'); const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

function variants(code) {
  const c = String(code || '').trim();
  if (!c || !/^\d+$/.test(c)) return [c].filter(Boolean);
  const out = new Set([c]);
  const noLead = c.replace(/^0+/, ''); if (noLead) out.add(noLead);
  if (c.length <= 13) out.add(c.padStart(13, '0'));
  if (c.length <= 14) out.add(c.padStart(14, '0'));
  return [...out];
}

(async () => {
  const bipes = await prisma.stocktakeBipe.findMany({
    where: { found: false },
    select: { id: true, barcode: true, storeId: true, applied: true },
  });
  // resolve cada barcode distinto -> ProductSize (prefere card ativo)
  const cache = {};
  async function resolve(code) {
    if (code in cache) return cache[code];
    const v = variants(code);
    if (v.length === 0) return (cache[code] = null);
    const ps = await prisma.productSize.findMany({
      where: { barcode: { in: v } },
      include: { product: { select: { id: true, name: true, brand: true, active: true } } },
    });
    const chosen = ps.length ? (ps.find((m) => m.product.active) || ps[0]) : null;
    return (cache[code] = chosen ? { chosen, dup: ps.length > 1 } : null);
  }

  let recuperaveis = 0, aplicaveis = 0, inativos = 0;
  const work = [];
  for (const b of bipes) {
    const r = await resolve(b.barcode);
    if (!r) continue;
    recuperaveis++;
    if (!r.chosen.product.active) inativos++;
    const willApply = !b.applied && !!b.storeId;
    if (willApply) aplicaveis++;
    work.push({ b, r, willApply });
  }

  console.log(`Bipes não reconhecidos: ${bipes.length}`);
  console.log(`Recuperáveis (têm card por variante de código): ${recuperaveis}`);
  console.log(`  → vão aplicar no estoque (têm loja, não aplicados): ${aplicaveis}`);
  console.log(`  → caíram em card INATIVO (precisam limpeza Brooks depois): ${inativos}`);

  if (!APPLY) {
    console.log('\nAmostra (8):');
    work.slice(0, 8).forEach(({ b, r }) =>
      console.log(`  ${b.barcode} → ${r.chosen.product.name.slice(0, 46)} | tam ${r.chosen.size} | ${r.chosen.product.active ? 'ativo' : 'INATIVO'}`));
    console.log('\nDRY-RUN. --apply pra recuperar.');
    await prisma.$disconnect(); return;
  }

  // backup
  const dir = path.join(process.cwd(), 'scripts', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const psIds = [...new Set(work.map((w) => w.r.chosen.id))];
  const storeIds = [...new Set(work.map((w) => w.b.storeId).filter(Boolean))];
  const ssBefore = await prisma.storeStock.findMany({ where: { productSizeId: { in: psIds }, storeId: { in: storeIds } } });
  fs.writeFileSync(path.join(dir, 'recover-leadzero-' + work.length + '.json'),
    JSON.stringify({ bipes: work.map((w) => w.b.id), ssBefore }));

  let upd = 0, app = 0;
  for (const { b, r, willApply } of work) {
    await prisma.stocktakeBipe.update({
      where: { id: b.id },
      data: {
        found: true, duplicate: r.dup,
        productId: r.chosen.product.id, productSizeId: r.chosen.id,
        productName: r.chosen.product.name, productSize: r.chosen.size, productBrand: r.chosen.product.brand,
        applied: willApply ? true : b.applied,
      },
    });
    upd++;
    if (willApply) {
      await prisma.storeStock.upsert({
        where: { storeId_productSizeId: { storeId: b.storeId, productSizeId: r.chosen.id } },
        update: { stock: { increment: 1 } },
        create: { storeId: b.storeId, productSizeId: r.chosen.id, stock: 1 },
      });
      app++;
    }
  }
  console.log(`\nFEITO. bipes marcados reconhecidos: ${upd} · aplicados no estoque: ${app}`);
  await prisma.$disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
