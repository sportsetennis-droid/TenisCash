// =====================================================================
// Unify NFe Duplicates — produtos criados via NFe onde cada tamanho virou
// um produto separado, vira 1 Product + N ProductSizes.
// =====================================================================
// Uso:
//   node scripts/unify-nfe-duplicates.js              (dry-run, mostra o plano)
//   node scripts/unify-nfe-duplicates.js --apply      (executa)
//   node scripts/unify-nfe-duplicates.js --apply --limit 10  (só primeiros 10 grupos)
//
// Estratégia:
//   1. Carrega Products com source='nfe-import'
//   2. Pra cada um, extrai baseName + size do nome
//   3. Agrupa por baseName normalizado
//   4. Pra grupos com >1 produto:
//      - Escolhe canônico (maior nº de ProductSizes; tie → mais antigo)
//      - Move ProductSize de cada duplicata pro canônico (soma estoque se já existe)
//      - Move StoreStock atrelados
//      - Atualiza NuvemshopProductMapping (cancela mapping antigo)
//      - Desativa duplicata (active=false, NÃO deleta — preserva histórico fiscal)
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const { extractBaseAndSize } = require('../src/services/nfeSizeParser');

const prisma = new PrismaClient();

async function main() {
  const apply = process.argv.includes('--apply');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  console.log(`\n=== Unify NFe Duplicates ===`);
  console.log(`Modo: ${apply ? 'APPLY (vai modificar banco)' : 'DRY-RUN (só mostra plano)'}`);
  console.log(`Limite: ${limit === Infinity ? 'sem limite' : limit}\n`);

  // 1. Carrega TODOS os produtos NFe ativos
  const products = await prisma.product.findMany({
    where: { active: true, source: 'nfe-import' },
    select: {
      id: true, sku: true, name: true, brand: true, costPrice: true, aiContext: true,
      createdAt: true, imageUrl: true,
      sizes: { select: { id: true, size: true, stock: true, barcode: true } },
    },
  });
  console.log(`Carregados ${products.length} produtos com source=nfe-import\n`);

  // 2. Agrupa por baseKey
  const groups = new Map();
  for (const p of products) {
    const { baseKey, baseName, size } = extractBaseAndSize(p.name);
    if (!baseKey) continue;
    if (!groups.has(baseKey)) groups.set(baseKey, { baseKey, baseName, products: [] });
    groups.get(baseKey).products.push({ ...p, _detectedSize: size });
  }

  const duplicateGroups = [...groups.values()]
    .filter(g => g.products.length > 1)
    // Salvaguarda: NÃO unifica se algum produto do grupo já tem MUITOS sizes (>3) — provavelmente é variação real
    .filter(g => g.products.every(p => p.sizes.length <= 3))
    .slice(0, limit);

  console.log(`Grupos duplicados elegíveis: ${duplicateGroups.length}`);
  console.log(`Produtos a desativar: ${duplicateGroups.reduce((s, g) => s + g.products.length - 1, 0)}`);
  console.log(`Produtos canônicos resultantes: ${duplicateGroups.length}\n`);

  if (!duplicateGroups.length) {
    console.log('Nada a fazer.');
    await prisma.$disconnect();
    return;
  }

  let processed = 0;
  let sizesCreated = 0;
  let sizesUpdated = 0;
  let storeStocksMoved = 0;
  let productsDeactivated = 0;
  let mappingsCancelled = 0;

  for (const g of duplicateGroups) {
    // Escolhe canônico: mais ProductSizes; empate → createdAt mais antigo
    const sorted = [...g.products].sort((a, b) => {
      if (b.sizes.length !== a.sizes.length) return b.sizes.length - a.sizes.length;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);

    console.log(`[${++processed}/${duplicateGroups.length}] ${g.baseName}`);
    console.log(`  Canônico: ${canonical.sku} (${canonical.sizes.length} sizes existentes)`);

    for (const dup of duplicates) {
      const sizeStr = dup._detectedSize || '';
      console.log(`    ← dup ${dup.sku} size=${sizeStr || '(sem)'} (${dup.sizes.length} sizes próprios)`);

      if (!apply) continue;

      // 2a. Se duplicata tem ProductSizes próprios, move/soma cada um
      for (const dupSize of dup.sizes) {
        // Procura mesmo tamanho no canônico
        const existing = await prisma.productSize.findFirst({
          where: { productId: canonical.id, size: dupSize.size },
        });
        if (existing) {
          // Soma estoque
          await prisma.productSize.update({
            where: { id: existing.id },
            data: {
              stock: existing.stock + dupSize.stock,
              barcode: existing.barcode || dupSize.barcode,
            },
          });
          // Move StoreStocks da duplicata pro canônico-size
          const moved = await prisma.storeStock.updateMany({
            where: { productSizeId: dupSize.id },
            data: { productSizeId: existing.id },
          });
          storeStocksMoved += moved.count;
          // Deleta o ProductSize da duplicata (já consolidou)
          await prisma.productSize.delete({ where: { id: dupSize.id } });
          sizesUpdated++;
        } else {
          // Move o ProductSize inteiro pro canônico (rebind productId)
          await prisma.productSize.update({
            where: { id: dupSize.id },
            data: { productId: canonical.id },
          });
          sizesCreated++;
        }
      }

      // 2b. Se duplicata NÃO tinha ProductSize e detectamos tamanho no nome, cria
      if (dup.sizes.length === 0 && sizeStr) {
        const existing = await prisma.productSize.findFirst({
          where: { productId: canonical.id, size: sizeStr },
        });
        if (existing) {
          sizesUpdated++;
          // Não tem como saber o estoque histórico — pula
        } else {
          await prisma.productSize.create({
            data: {
              productId: canonical.id,
              size: sizeStr,
              stock: 0,
              barcode: null,
            },
          });
          sizesCreated++;
        }
      }

      // 2c. Cancela mappings da duplicata na Nuvemshop (pra não sincronizar)
      const mappingsUpdated = await prisma.nuvemshopProductMapping.updateMany({
        where: { productId: dup.id },
        data: { syncStatus: 'cancelled_unified' },
      }).catch(() => ({ count: 0 }));
      mappingsCancelled += mappingsUpdated.count;

      // 2d. Desativa duplicata (preserva histórico fiscal — XmlFiscalItem fica linkado)
      await prisma.product.update({
        where: { id: dup.id },
        data: {
          active: false,
          aiContext: {
            ...(dup.aiContext || {}),
            unifiedInto: canonical.id,
            unifiedAt: new Date().toISOString(),
          },
        },
      });
      productsDeactivated++;
    }
  }

  console.log(`\n========================================`);
  console.log(`Resumo (${apply ? 'EXECUTADO' : 'DRY-RUN'}):`);
  console.log(`  Grupos processados:       ${processed}`);
  console.log(`  Produtos desativados:     ${productsDeactivated}`);
  console.log(`  ProductSizes movidos/criados: ${sizesCreated}`);
  console.log(`  ProductSizes consolidados:    ${sizesUpdated}`);
  console.log(`  StoreStocks remapeados:   ${storeStocksMoved}`);
  console.log(`  Nuvemshop mappings cancelados: ${mappingsCancelled}`);
  console.log(`========================================\n`);

  if (!apply) {
    console.log('Para executar, rode novamente com --apply\n');
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('\nERRO:', err);
  prisma.$disconnect();
  process.exit(1);
});
