// =====================================================================
// CLEANUP — Remove produtos duplicados criados a partir de NFs da
// Meta Esportes (CNPJ 44052617000126), que é empresa do MESMO GRUPO
// (Baratão dos Esportes) e foi incorretamente tratada como fornecedor
// externo, causando dupla contagem de estoque.
// =====================================================================
//
// FLUXO:
//   1. Encontra Products com aiContext.supplierCnpj = '44052617000126'
//   2. Pra cada um, busca produto duplicado (mesmo EAN num ProductSize)
//      vindo de outro supplierCnpj
//   3. Se ENCONTROU duplicata:
//        - Move SaleItems do produto Meta → produto original
//        - Move NuvemshopProductMapping (se houver) — caso conflite, mantém o do original
//        - Move StoreStock (consolida estoque)
//        - DELETA o produto Meta (cascade ProductSize)
//   4. Se NÃO TEM duplicata (EAN único do Meta Esportes):
//        - MANTÉM ativo (é produto exclusivo)
//   5. Gera relatório CSV
//
// Uso:
//   node scripts/cleanup-meta-esportes-duplicates.js --dry-run   (só relata)
//   node scripts/cleanup-meta-esportes-duplicates.js --execute   (aplica)
// =====================================================================

const fs = require('fs');
const path = require('path');
try {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=][^=]*)=(.*)$/);
      if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    });
  }
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const META_CNPJ = '44052617000126';
const dryRun = !process.argv.includes('--execute');

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function findOriginalForEan(ean, excludeProductId) {
  const sizes = await prisma.productSize.findMany({
    where: { barcode: ean, productId: { not: excludeProductId } },
    include: { product: { select: { id: true, sku: true, name: true, brand: true, active: true, aiContext: true } } },
  });
  // Prefere produto ativo com supplierCnpj diferente de Meta
  for (const s of sizes) {
    if (!s.product.active) continue;
    const cnpj = (() => {
      try {
        const ctx = typeof s.product.aiContext === 'string' ? JSON.parse(s.product.aiContext) : s.product.aiContext;
        return ctx?.supplierCnpj;
      } catch { return null; }
    })();
    if (cnpj && cnpj !== META_CNPJ) return s.product;
  }
  // Fallback: qualquer outro produto ativo
  for (const s of sizes) {
    if (s.product.active) return s.product;
  }
  return null;
}

async function main() {
  log(`=== CLEANUP META ESPORTES (CNPJ ${META_CNPJ}) ===`);
  log(`Modo: ${dryRun ? 'DRY-RUN' : 'EXECUTE (apaga de verdade)'}\n`);

  const metaProducts = await prisma.product.findMany({
    where: { aiContext: { path: ['supplierCnpj'], equals: META_CNPJ } },
    include: { sizes: true, saleItems: { select: { id: true } } },
    orderBy: { createdAt: 'asc' },
  });
  // Mapeamentos Nuvemshop (lookup separado pq não há relação reversa direta)
  const allMappings = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: metaProducts.map(p => p.id) } },
  });
  const mappingByProduct = new Map(allMappings.map(m => [m.localProductId, m]));
  log(`Produtos Meta Esportes encontrados: ${metaProducts.length}`);
  log(`Mappings Nuvemshop nesses produtos: ${allMappings.length}`);

  let toDelete = 0;
  let toKeep = 0;
  let moved = { saleItems: 0, mappings: 0, stocks: 0 };
  let errors = [];
  const report = [];

  for (let i = 0; i < metaProducts.length; i++) {
    const p = metaProducts[i];
    if ((i + 1) % 100 === 0) log(`Progresso: ${i + 1}/${metaProducts.length}`);

    // Pega EAN principal (primeiro tamanho com barcode)
    const mainEan = p.sizes.find(s => s.barcode)?.barcode;
    if (!mainEan) {
      // Sem EAN — não dá pra identificar duplicata segura, mantém
      toKeep++;
      report.push({ action: 'KEEP_NO_EAN', sku: p.sku, name: p.name });
      continue;
    }

    const original = await findOriginalForEan(mainEan, p.id);
    if (!original) {
      // EAN único — produto exclusivo da Meta Esportes (algum produto que só veio por aí)
      toKeep++;
      report.push({ action: 'KEEP_UNIQUE_EAN', sku: p.sku, name: p.name, ean: mainEan });
      continue;
    }

    // === TEM DUPLICATA ===
    if (dryRun) {
      toDelete++;
      report.push({ action: 'WOULD_DELETE', sku: p.sku, name: p.name, ean: mainEan, originalSku: original.sku, originalBrand: original.brand });
      continue;
    }

    try {
      // 1. Move SaleItems do meta → original
      if (p.saleItems.length) {
        await prisma.saleItem.updateMany({ where: { productId: p.id }, data: { productId: original.id } });
        moved.saleItems += p.saleItems.length;
      }
      // 2. NuvemshopProductMapping: se o original já tem, deleta o do meta. Senão, transfere.
      const myMapping = mappingByProduct.get(p.id);
      if (myMapping) {
        const origMapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: original.id } });
        if (origMapping) {
          await prisma.nuvemshopProductMapping.delete({ where: { id: myMapping.id } });
        } else {
          await prisma.nuvemshopProductMapping.update({ where: { id: myMapping.id }, data: { localProductId: original.id } });
          moved.mappings++;
        }
      }
      // 3. StoreStock dos tamanhos do meta → consolida no original
      for (const s of p.sizes) {
        const origSize = await prisma.productSize.findFirst({ where: { productId: original.id, size: s.size } });
        if (origSize) {
          // Mescla stocks dos StoreStock
          const metaStocks = await prisma.storeStock.findMany({ where: { productSizeId: s.id } });
          for (const ms of metaStocks) {
            const existingOrig = await prisma.storeStock.findUnique({ where: { storeId_productSizeId: { storeId: ms.storeId, productSizeId: origSize.id } } }).catch(() => null);
            if (existingOrig) {
              // Já existe → NÃO somar (era pra ser duplicata mesmo)
              await prisma.storeStock.delete({ where: { id: ms.id } });
            } else {
              await prisma.storeStock.update({ where: { id: ms.id }, data: { productSizeId: origSize.id } });
              moved.stocks++;
            }
          }
          // E DELETA o ProductSize do meta (cascade já lidou com StoreStock acima)
          // ProductSize cascade delete vai junto com o Product
        }
      }
      // 4. Deleta o produto meta (ProductSize cai em cascade conforme schema)
      await prisma.product.delete({ where: { id: p.id } });
      toDelete++;
      report.push({ action: 'DELETED', sku: p.sku, name: p.name, ean: mainEan, originalSku: original.sku });
    } catch (err) {
      errors.push({ sku: p.sku, error: err.message });
      report.push({ action: 'ERROR', sku: p.sku, error: err.message });
    }
  }

  // Salva relatório
  const reportPath = path.join(__dirname, '.meta-cleanup-report-' + Date.now() + '.csv');
  const headers = 'action,sku,name,ean,originalSku,originalBrand,error\n';
  const rows = report.map(r => [r.action, r.sku, (r.name||'').replace(/,/g,';'), r.ean||'', r.originalSku||'', r.originalBrand||'', (r.error||'').replace(/,/g,';')].join(',')).join('\n');
  fs.writeFileSync(reportPath, headers + rows);

  log('\n=== RESULTADO ===');
  log(`Deletados${dryRun ? ' (simulado)' : ''}: ${toDelete}`);
  log(`Mantidos (EAN único / sem EAN): ${toKeep}`);
  log(`Erros: ${errors.length}`);
  if (!dryRun) {
    log(`Movido: ${moved.saleItems} vendas, ${moved.mappings} mappings Nuvemshop, ${moved.stocks} StoreStocks`);
  }
  log(`Relatório CSV: ${reportPath}`);

  // Stats finais
  if (!dryRun) {
    const total = await prisma.product.count({ where: { active: true } });
    const totalStock = await prisma.productSize.aggregate({ _sum: { stock: true } });
    log(`\n=== ESTADO ATUAL DO BANCO ===`);
    log(`Produtos ativos: ${total}`);
    log(`Estoque total: ${(totalStock._sum.stock || 0).toFixed(0)} unidades`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
