// =====================================================================
// Unify by Supplier Ref — alguns fornecedores (NESK e cia) mandam ref com
// TAMANHO embutido (ex: SEMA195.195B.38, SEMA195.195B.39...). Cada tamanho
// vira um produto separado. Esse script extrai a "ref base" removendo o
// segmento final de tamanho e unifica produtos pela ref base.
// =====================================================================
// Uso:
//   node scripts/unify-by-supplier-ref.js [CNPJ_OPCIONAL] [--apply] [--limit N]
//
// Exemplos:
//   node scripts/unify-by-supplier-ref.js                  (dry-run, todos fornecedores)
//   node scripts/unify-by-supplier-ref.js 23593619000152   (só NESK, dry-run)
//   node scripts/unify-by-supplier-ref.js 23593619000152 --apply
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const { extractBaseAndSize, isValidSize } = require('../src/services/nfeSizeParser');

const prisma = new PrismaClient();

/**
 * stripSizeFromRef — remove o segmento final da ref se ele for um tamanho.
 *   "SEMA195.195B.38"     → "SEMA195.195B"
 *   "SEMA195.195B.36/37"  → "SEMA195.195B"
 *   "CT00010001"          → "CT00010001" (não tem tamanho, mantém)
 *   "ABC-1234-40"         → "ABC-1234"
 *   "REF/123/GG"          → "REF/123"
 */
function stripSizeFromRef(ref) {
  if (!ref) return ref;
  const s = String(ref).trim();
  // Separadores: . - / _ espaço
  const m = s.match(/^(.+?)[\.\-\/\_\s]+([A-Z0-9]{1,5}(?:\/[A-Z0-9]{1,5})?)$/i);
  if (m && isValidSize(m[2])) return m[1];
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : Infinity;
  const cnpj = args.find(a => /^\d{14}$/.test(a)) || null;

  console.log(`\n=== Unify by Supplier Ref ===`);
  console.log(`Modo: ${apply ? 'APPLY (vai modificar banco)' : 'DRY-RUN'}`);
  console.log(`CNPJ filtro: ${cnpj || '(todos)'}`);
  console.log(`Limite: ${limit === Infinity ? 'sem limite' : limit}\n`);

  // 1. Pega produtos com supplierRef e (opcionalmente) filtrados por CNPJ
  const where = {
    active: true,
    aiContext: { path: ['supplierRef'], not: null },
  };
  if (cnpj) {
    where.AND = [
      { aiContext: { path: ['supplierRef'], not: null } },
      { aiContext: { path: ['supplierCnpj'], equals: cnpj } },
    ];
    delete where.aiContext;
  }

  const products = await prisma.product.findMany({
    where,
    select: {
      id: true, sku: true, name: true, brand: true, costPrice: true, aiContext: true,
      createdAt: true, imageUrl: true,
      sizes: { select: { id: true, size: true, stock: true, barcode: true } },
    },
  });
  console.log(`Carregados ${products.length} produtos com supplierRef\n`);

  // 2. Agrupa por (cnpj, refBase)
  const groups = new Map();
  for (const p of products) {
    const ref = p.aiContext?.supplierRef;
    const pcnpj = p.aiContext?.supplierCnpj || 'unknown';
    const refBase = stripSizeFromRef(ref);
    if (!refBase) continue;
    const key = `${pcnpj}::${refBase}`;
    if (!groups.has(key)) {
      groups.set(key, { cnpj: pcnpj, refBase, products: [] });
    }
    // Também detecta tamanho do nome (fallback se ref não tinha)
    const { size: nameSize } = extractBaseAndSize(p.name);
    const sizeFromRef = (() => {
      const m = String(ref).match(/[\.\-\/\_\s]([A-Z0-9]{1,5}(?:\/[A-Z0-9]{1,5})?)$/i);
      return m && isValidSize(m[1]) ? m[1].toUpperCase() : null;
    })();
    groups.get(key).products.push({ ...p, _size: sizeFromRef || nameSize || '' });
  }

  const duplicateGroups = [...groups.values()]
    .filter(g => g.products.length > 1)
    .slice(0, limit);

  console.log(`Grupos com >1 produto (mesma refBase): ${duplicateGroups.length}`);
  console.log(`Produtos a unificar: ${duplicateGroups.reduce((s, g) => s + g.products.length, 0)} → vira ${duplicateGroups.length}\n`);

  if (!duplicateGroups.length) {
    console.log('Nada a fazer.');
    await prisma.$disconnect();
    return;
  }

  // 3. Pra cada grupo, escolhe canônico e migra ProductSizes
  let processed = 0;
  let sizesCreated = 0;
  let sizesUpdated = 0;
  let storeStocksMoved = 0;
  let productsDeactivated = 0;
  let mappingsCancelled = 0;

  for (const g of duplicateGroups) {
    // Canônico: maior nº de ProductSizes; tie → menor createdAt
    const sorted = [...g.products].sort((a, b) => {
      if (b.sizes.length !== a.sizes.length) return b.sizes.length - a.sizes.length;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);

    // Limpa nome do canônico:
    //   1. Remove "REF XYZ" do final
    //   2. Remove tamanho do final
    //   3. Remove códigos sobrando
    let cleanedName = canonical.name
      .replace(/\s+REF[\s:\-]+[A-Z0-9\.\-\/]+\s*$/i, '')         // " REF SEFA199.199A.35"
      .replace(/\s+[A-Z]{2,4}\d{2,4}\.[A-Z0-9\.]+\s*$/i, '')     // " SEMA195.195B.38"
      .trim();
    const { baseName: cleanName } = extractBaseAndSize(cleanedName);
    const canonicalNewName = cleanName || cleanedName || canonical.name;

    processed++;
    if (processed <= 5 || processed % 20 === 0) {
      console.log(`[${processed}/${duplicateGroups.length}] ref="${g.refBase}" (${duplicates.length + 1} produtos)`);
      console.log(`  Canônico: ${canonical.sku} ${canonical._size ? '[' + canonical._size + ']' : ''} (${canonical.sizes.length} sizes)`);
      console.log(`  Nome final: "${canonicalNewName}"`);
      duplicates.slice(0, 3).forEach(d => console.log(`    ← dup ${d.sku} [${d._size || '?'}]`));
      if (duplicates.length > 3) console.log(`    ... + ${duplicates.length - 3} dups`);
    }

    if (!apply) continue;

    // Renomeia canônico pro nome limpo + atualiza ref base
    if (canonicalNewName !== canonical.name || canonical.aiContext?.supplierRef !== g.refBase) {
      await prisma.product.update({
        where: { id: canonical.id },
        data: {
          name: canonicalNewName,
          aiContext: {
            ...(canonical.aiContext || {}),
            supplierRef: g.refBase,
            supplierRefOriginal: canonical.aiContext?.supplierRef,
          },
        },
      });
    }

    // Pra cada duplicata: garante ProductSize no canônico + desativa duplicata
    for (const dup of duplicates) {
      const targetSize = dup._size;

      // Move ProductSizes existentes
      for (const dupSize of dup.sizes) {
        const existing = await prisma.productSize.findFirst({
          where: { productId: canonical.id, size: dupSize.size },
        });
        if (existing) {
          await prisma.productSize.update({
            where: { id: existing.id },
            data: { stock: existing.stock + dupSize.stock, barcode: existing.barcode || dupSize.barcode },
          });
          // Merge de StoreStocks: pra cada um do dupSize, soma no canonical-store-stock se já existe, senão move
          const dupStocks = await prisma.storeStock.findMany({ where: { productSizeId: dupSize.id } });
          for (const ds of dupStocks) {
            const target = await prisma.storeStock.findFirst({
              where: { productSizeId: existing.id, storeId: ds.storeId },
            });
            if (target) {
              await prisma.storeStock.update({
                where: { id: target.id },
                data: { stock: target.stock + ds.stock },
              });
              await prisma.storeStock.delete({ where: { id: ds.id } });
            } else {
              await prisma.storeStock.update({
                where: { id: ds.id },
                data: { productSizeId: existing.id },
              });
            }
            storeStocksMoved++;
          }
          await prisma.productSize.delete({ where: { id: dupSize.id } }).catch(() => {});
          sizesUpdated++;
        } else {
          await prisma.productSize.update({
            where: { id: dupSize.id },
            data: { productId: canonical.id },
          }).catch(() => {});
          sizesCreated++;
        }
      }

      // Se duplicata não tinha ProductSize mas detectamos tamanho, cria com stock=0
      if (dup.sizes.length === 0 && targetSize) {
        const existing = await prisma.productSize.findFirst({
          where: { productId: canonical.id, size: targetSize },
        });
        if (!existing) {
          await prisma.productSize.create({
            data: {
              productId: canonical.id,
              size: targetSize,
              stock: 0,
              barcode: dup.sku && dup.sku.includes('-') ? dup.sku.split('-').slice(-1)[0] : null,
            },
          });
          sizesCreated++;
        } else {
          sizesUpdated++;
        }
      }

      // Cancela mappings Nuvemshop
      const m = await prisma.nuvemshopProductMapping.updateMany({
        where: { productId: dup.id },
        data: { syncStatus: 'cancelled_unified' },
      }).catch(() => ({ count: 0 }));
      mappingsCancelled += m.count;

      // Desativa (preserva XmlFiscalItem)
      await prisma.product.update({
        where: { id: dup.id },
        data: {
          active: false,
          aiContext: {
            ...(dup.aiContext || {}),
            unifiedInto: canonical.id,
            unifiedAt: new Date().toISOString(),
            unifiedBy: 'unify-by-supplier-ref',
          },
        },
      });
      productsDeactivated++;
    }

    // Pega o canônico também: se ele não tem ProductSize próprio mas detectamos tamanho, cria
    if (canonical.sizes.length === 0 && canonical._size && apply) {
      const exists = await prisma.productSize.findFirst({
        where: { productId: canonical.id, size: canonical._size },
      });
      if (!exists) {
        await prisma.productSize.create({
          data: { productId: canonical.id, size: canonical._size, stock: 0, barcode: null },
        });
        sizesCreated++;
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`Resumo (${apply ? 'EXECUTADO' : 'DRY-RUN'}):`);
  console.log(`  Grupos processados:            ${processed}`);
  console.log(`  Produtos desativados:          ${productsDeactivated}`);
  console.log(`  ProductSizes criados/movidos:  ${sizesCreated}`);
  console.log(`  ProductSizes consolidados:     ${sizesUpdated}`);
  console.log(`  StoreStocks remapeados:        ${storeStocksMoved}`);
  console.log(`  Nuvemshop mappings cancelados: ${mappingsCancelled}`);
  console.log(`========================================\n`);

  if (!apply) console.log('Para executar, adicione --apply\n');

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('\nERRO:', err);
  prisma.$disconnect();
  process.exit(1);
});
