// =====================================================================
// clear-product-classifications.js
// =====================================================================
// Limpa apenas:
//   - Product.category
//   - Product.subcategory
//   - aiContext.classification (gender/modality/tier/sport)
//   - aiContext.gender (root level)
//
// PRESERVA: brand, sku, price, costPrice, sizes, storeStocks, imageUrl,
// imageUrls, aiContext.supplierCnpj/supplierRef/firstNFeKey/color/etc.,
// active flag, ncm, cfop, unidade, etc.
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DRY = args.dry || (!args.apply);

(async () => {
  console.log('\n=== Clear Product Classifications ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // 1) Reset category pra 'A CLASSIFICAR' (coluna NOT NULL) e subcategory pra NULL
  if (!DRY) {
    const r1 = await prisma.$executeRaw`
      UPDATE "Product"
      SET category = 'A CLASSIFICAR', subcategory = NULL
      WHERE active = true
    `;
    console.log('Linhas resetadas pra A CLASSIFICAR:', r1);
  } else {
    const c = await prisma.product.count({ where: { active: true } });
    console.log('DRY: resetaria category/subcategory em', c, 'produtos');
  }

  // 2) Remove aiContext.classification + aiContext.gender (root) preservando o resto
  const all = await prisma.$queryRaw`
    SELECT id, "aiContext"::text as ctx FROM "Product" WHERE active=true AND "aiContext" IS NOT NULL
  `;
  console.log('Produtos com aiContext:', all.length);

  let touched = 0;
  for (const p of all) {
    let ctx;
    try { ctx = JSON.parse(p.ctx); } catch { continue; }
    let changed = false;
    if (ctx.classification !== undefined) { delete ctx.classification; changed = true; }
    if (ctx.gender !== undefined) { delete ctx.gender; changed = true; }
    if (changed) {
      if (!DRY) {
        await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
      }
      touched++;
    }
  }
  console.log('Produtos com aiContext.classification/gender removidos:', touched);

  // 3) Stats finais
  const after = await prisma.$queryRaw`
    SELECT
      count(*)::int as total,
      sum(case when category IS NOT NULL AND category != '' then 1 else 0 end)::int as com_cat,
      sum(case when subcategory IS NOT NULL AND subcategory != '' then 1 else 0 end)::int as com_sub,
      sum(case when "aiContext"::jsonb->'classification'->>'gender' IS NOT NULL then 1 else 0 end)::int as com_gender,
      sum(case when "aiContext"::jsonb->'classification'->>'modality' IS NOT NULL then 1 else 0 end)::int as com_mod,
      sum(case when "aiContext"::jsonb->'classification'->>'tier' IS NOT NULL then 1 else 0 end)::int as com_tier
    FROM "Product" WHERE active=true
  `;
  const x = after[0];
  console.log('\n=== ESTADO APOS LIMPEZA ===');
  console.log('Ativos:                 ', x.total);
  console.log('  com category != A CLASSIFICAR:', x.com_cat - x.total, '(deveria ser 0; todos viraram A CLASSIFICAR)');
  console.log('  com subcategory:      ', x.com_sub, '(deveria ser 0)');
  console.log('  com gender:           ', x.com_gender, '(deveria ser 0)');
  console.log('  com modality:         ', x.com_mod, '(deveria ser 0)');
  console.log('  com tier:             ', x.com_tier, '(deveria ser 0)');

  // 4) Confirma que marca/fornecedor/preco NAO foram tocados
  const safe = await prisma.$queryRaw`
    SELECT
      sum(case when brand IS NOT NULL AND brand != '' AND brand != 'A DEFINIR' then 1 else 0 end)::int as com_marca,
      sum(case when "aiContext"::jsonb->>'supplierCnpj' IS NOT NULL then 1 else 0 end)::int as com_supplier,
      sum(case when price > 0 then 1 else 0 end)::int as com_preco,
      sum(case when "imageUrl" IS NOT NULL then 1 else 0 end)::int as com_imagem
    FROM "Product" WHERE active=true
  `;
  const s = safe[0];
  console.log('\n=== VERIFICA O QUE FOI PRESERVADO ===');
  console.log('  com marca:            ', s.com_marca);
  console.log('  com supplierCnpj:     ', s.com_supplier);
  console.log('  com preço:            ', s.com_preco);
  console.log('  com imagem:           ', s.com_imagem);

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
