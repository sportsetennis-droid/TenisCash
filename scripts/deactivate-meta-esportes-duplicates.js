// =====================================================================
// DEACTIVATE — Marca como INATIVOS os produtos duplicados criados a
// partir de NFs da Meta Esportes (CNPJ 44052617000126). NÃO DELETA.
//
// Critério: Product vindo da Meta Esportes que TEM um EAN duplicado
// em outro produto vindo de fornecedor real → marca active=false.
// Produtos exclusivos da Meta (EAN único) ficam ativos.
//
// Marca:
//   active = false
//   aiContext.deactivatedReason = 'meta_esportes_duplicate'
//   aiContext.deactivatedAt = ISO date
//
// Reversível: rodar este mesmo script com --rollback reativa todos.
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
const rollback = process.argv.includes('--rollback');

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function main() {
  log(`=== DEACTIVATE META ESPORTES ===`);
  log(`Modo: ${rollback ? 'ROLLBACK (reativar)' : (dryRun ? 'DRY-RUN' : 'EXECUTE')}\n`);

  if (rollback) {
    const r = await prisma.$queryRaw`
      UPDATE "Product" SET active = true
      WHERE "aiContext"->>'deactivatedReason' = 'meta_esportes_duplicate'
      RETURNING id
    `;
    log(`Reativados: ${r.length} produtos`);
    return;
  }

  const metaProducts = await prisma.product.findMany({
    where: { aiContext: { path: ['supplierCnpj'], equals: META_CNPJ }, active: true },
    include: { sizes: { select: { id: true, size: true, barcode: true, stock: true } } },
    orderBy: { createdAt: 'asc' },
  });
  log(`Produtos Meta Esportes ativos: ${metaProducts.length}`);

  let willDeactivate = 0;
  let willKeep = 0;
  const toDeactivate = [];

  for (let i = 0; i < metaProducts.length; i++) {
    const p = metaProducts[i];
    if ((i + 1) % 200 === 0) log(`Verificando: ${i + 1}/${metaProducts.length}`);

    const mainEan = p.sizes.find(s => s.barcode)?.barcode;
    if (!mainEan) { willKeep++; continue; }

    // Verifica se EAN existe em outro produto ativo de OUTRO fornecedor
    const dup = await prisma.productSize.findFirst({
      where: { barcode: mainEan, productId: { not: p.id } },
      include: { product: { select: { id: true, active: true, sku: true, aiContext: true } } },
    });
    if (dup && dup.product.active) {
      const otherCnpj = (() => {
        try {
          const c = typeof dup.product.aiContext === 'string' ? JSON.parse(dup.product.aiContext) : dup.product.aiContext;
          return c?.supplierCnpj;
        } catch { return null; }
      })();
      if (otherCnpj !== META_CNPJ) {
        toDeactivate.push({ id: p.id, sku: p.sku, name: p.name, ean: mainEan, originalSku: dup.product.sku });
        willDeactivate++;
        continue;
      }
    }
    willKeep++;
  }

  log(`\nA desativar: ${willDeactivate}`);
  log(`A manter (EAN único): ${willKeep}`);

  // Salva relatório
  const reportPath = path.join(__dirname, '.meta-deactivate-report-' + Date.now() + '.csv');
  fs.writeFileSync(reportPath, 'sku,name,ean,originalSku\n' + toDeactivate.map(r => [r.sku, (r.name||'').replace(/,/g,';'), r.ean, r.originalSku].join(',')).join('\n'));
  log(`Relatório: ${reportPath}`);

  if (dryRun) { log('\n(dry-run — nada foi gravado. Use --execute pra aplicar)'); return; }

  log('\nAplicando desativação em batch...');
  const now = new Date().toISOString();
  for (let i = 0; i < toDeactivate.length; i += 100) {
    const batch = toDeactivate.slice(i, i + 100);
    // Não dá pra fazer updateMany com aiContext modificado (JSON merge)
    // então vai um por um (~670 × 50ms = 33s)
    for (const item of batch) {
      const cur = await prisma.product.findUnique({ where: { id: item.id }, select: { aiContext: true } });
      const ctx = (() => {
        try { return typeof cur.aiContext === 'string' ? JSON.parse(cur.aiContext) : (cur.aiContext || {}); }
        catch { return {}; }
      })();
      await prisma.product.update({
        where: { id: item.id },
        data: {
          active: false,
          aiContext: { ...ctx, deactivatedReason: 'meta_esportes_duplicate', deactivatedAt: now, originalDuplicateOf: item.originalSku },
        },
      });
    }
    log(`  ${Math.min(i + 100, toDeactivate.length)}/${toDeactivate.length}`);
  }
  log('✓ Concluído');

  // Stats
  const totalActive = await prisma.product.count({ where: { active: true } });
  const totalStockActive = await prisma.productSize.aggregate({
    _sum: { stock: true },
    where: { product: { active: true } },
  });
  log(`\nProdutos ativos agora: ${totalActive}`);
  log(`Estoque ativo agora: ${(totalStockActive._sum.stock || 0).toFixed(0)} unidades`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
