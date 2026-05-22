// =====================================================================
// apply-markup-to-products.js
// =====================================================================
// Pra cada produto importado via NFe:
//   1. Pega o XmlFiscalItem mais recente (custo real = unitValue)
//   2. Set costPrice = unitValue
//   3. Set price = costPrice * (1 + supplier.averageMarkup/100)
//
// Se supplier não tem markup, usa 100% como default (dobra o custo).
// Idempotente: só atualiza onde price não está consistente com custo+markup.
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
const DEFAULT_MARKUP_PCT = 100; // fallback se supplier não tem markup definido

(async () => {
  console.log('\n=== Apply markup to products ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  // 1. Mapeia suppliers + markup
  const suppliers = await prisma.supplier.findMany({
    where: { active: true },
    select: { cnpj: true, companyName: true, averageMarkup: true },
  });
  const markupByCnpj = Object.fromEntries(suppliers.filter(s => s.cnpj).map(s => [s.cnpj, s.averageMarkup]));
  console.log('Suppliers ativos:', suppliers.length);
  console.log('Com markup definido:', Object.values(markupByCnpj).filter(m => m != null).length);

  // 2. Pega TODOS os produtos ativos com supplierCnpj
  const products = await prisma.$queryRaw`
    SELECT p.id, p.sku, p.name, p.price, p."costPrice",
           p."aiContext"::jsonb->>'supplierCnpj' as cnpj
    FROM "Product" p
    WHERE p.active = true
      AND p."aiContext"::jsonb->>'supplierCnpj' IS NOT NULL
  `;
  console.log('Produtos com supplierCnpj:', products.length);

  // 3. Pra cada produto: pega unitValue mais recente da NFe vinculada
  const costMap = await prisma.$queryRaw`
    SELECT i."productId", AVG(i."unitValue")::float as avg_cost, MAX(i."unitValue")::float as max_cost
    FROM "XmlFiscalItem" i
    JOIN "XmlFiscalDocument" d ON i."fiscalDocumentId"=d.id
    WHERE d."docType"='entrada' AND i."productId" IS NOT NULL AND i."unitValue" > 0
    GROUP BY i."productId"
  `;
  const costByProductId = Object.fromEntries(costMap.map(r => [r.productId, r.avg_cost]));
  console.log('Produtos com custo via NFe:', Object.keys(costByProductId).length);

  // 4. Aplica markup
  let updated = 0, skipped = 0, semCusto = 0, semMarkup = 0;
  for (const p of products) {
    const cost = costByProductId[p.id] || p.costPrice || 0;
    if (cost <= 0) { semCusto++; continue; }

    const markup = markupByCnpj[p.cnpj] != null ? markupByCnpj[p.cnpj] : DEFAULT_MARKUP_PCT;
    if (markup == null) { semMarkup++; continue; }

    const newPrice = Math.round(cost * (1 + markup / 100) * 100) / 100;
    const newCost = Math.round(cost * 100) / 100;

    // Só atualiza se mudou significativamente (> 1%)
    const priceChanged = Math.abs(newPrice - (p.price || 0)) / Math.max(p.price || 1, 1) > 0.01;
    const costChanged = Math.abs(newCost - (p.costPrice || 0)) > 0.01;
    if (!priceChanged && !costChanged) { skipped++; continue; }

    if (!DRY) {
      await prisma.product.update({
        where: { id: p.id },
        data: { costPrice: newCost, price: newPrice },
      });
    }
    updated++;
    if (updated <= 5) console.log(`  ${p.sku.slice(-10)} | custo R$ ${newCost.toFixed(2)} × ${markup}% = R$ ${newPrice.toFixed(2)} (era R$ ${(p.price||0).toFixed(2)})`);
  }

  console.log('\n=== RESULTADO ===');
  console.log('  Atualizados:', updated);
  console.log('  Sem mudança (skip):', skipped);
  console.log('  Sem custo:', semCusto);
  console.log('  Sem markup do fornecedor:', semMarkup);

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
