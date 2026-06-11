// =====================================================================
// sweep-adidas-unlink-sizes.js [--apply]
// =====================================================================
// Ordem do dono (2026-06-11): "tirar a vinculação do registro atual do
// código junto ao tamanho e deixar que isso seja feito manualmente,
// apenas de todos os produtos da adidas".
//
// A NFe ALPAR/Adidas NÃO traz tamanho por código → todo tamanho Adidas
// não-confirmado por CAIXA física é chute de importação. Este sweep:
//   - pega TODO ProductSize de produto ADIDAS com sizeConfirmedAt NULL
//     e size que não é placeholder (T-...)
//   - vira placeholder 'T-<barcode>' (sem barcode: 'T-<id12>')
//   - atualiza o snapshot productSize dos bipes do código
//   - NÃO mexe em stock / StoreStock / sizeConfirmedAt de confirmados
//
// O preenchimento passa a ser 100% manual: bipe na loja → modal pede o
// tamanho da caixa → POST /api/stocktake/bipe/:id/size grava+confirma.
//
// Backup em scripts/backups/sweep-adidas-unlink-<ts>.json (pra reverter).
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

(async () => {
  const targets = await prisma.$queryRaw`
    SELECT ps.id, ps.size, ps.barcode, ps."productId", p.name
    FROM "ProductSize" ps JOIN "Product" p ON p.id = ps."productId"
    WHERE upper(p.brand) = 'ADIDAS'
      AND ps."sizeConfirmedAt" IS NULL
      AND ps.size !~ '^T-'
    ORDER BY p.name, ps.size`;

  console.log(`Alvos (Adidas, não-confirmado, não-placeholder): ${targets.length}`);
  const porTipo = {};
  for (const t of targets) {
    const k = /^[0-9]{2}([.,·]5?|)$/.test(t.size) ? 'numero' : (/^(ÚNICO|UNICO|U)$/i.test(t.size) ? 'unico' : 'outros');
    porTipo[k] = (porTipo[k] || 0) + 1;
  }
  console.log('Por tipo:', JSON.stringify(porTipo));

  if (!APPLY) {
    console.log('\nDRY-RUN (10 exemplos):');
    for (const t of targets.slice(0, 10)) {
      console.log(`  ${t.size.padEnd(8)} -> T-${t.barcode || t.id.slice(0, 12)}  | ${t.name.slice(0, 60)}`);
    }
    console.log('\nRode com --apply pra executar.');
    process.exit(0);
  }

  // backup
  const backupDir = path.join(__dirname, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `sweep-adidas-unlink-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(targets, null, 1));
  console.log('Backup:', backupFile);

  let ok = 0, fail = 0, bipesAtualizados = 0;
  for (const t of targets) {
    const ph = 'T-' + (t.barcode || t.id.slice(0, 12));
    try {
      await prisma.$transaction(async (tx) => {
        await tx.productSize.update({ where: { id: t.id }, data: { size: ph, sizeConfirmedAt: null } });
        const u = await tx.stocktakeBipe.updateMany({ where: { productSizeId: t.id }, data: { productSize: ph } });
        bipesAtualizados += u.count;
      });
      ok++;
    } catch (e) {
      // colisão de unique (productId,size) ou afim — tenta com sufixo do id
      try {
        const ph2 = 'T-' + (t.barcode || '') + '-' + t.id.slice(0, 6);
        await prisma.$transaction(async (tx) => {
          await tx.productSize.update({ where: { id: t.id }, data: { size: ph2, sizeConfirmedAt: null } });
          const u = await tx.stocktakeBipe.updateMany({ where: { productSizeId: t.id }, data: { productSize: ph2 } });
          bipesAtualizados += u.count;
        });
        ok++;
        console.warn(`  fallback ph2 em ${t.id} (${e.message.slice(0, 60)})`);
      } catch (e2) {
        fail++;
        console.error(`  FALHOU ${t.id} "${t.size}": ${e2.message.slice(0, 100)}`);
      }
    }
  }
  console.log(`\nDesvinculados: ${ok}/${targets.length} (falhas: ${fail}) · snapshots de bipe atualizados: ${bipesAtualizados}`);

  // verificação
  const sobra = await prisma.$queryRaw`
    SELECT count(*)::int n FROM "ProductSize" ps JOIN "Product" p ON p.id = ps."productId"
    WHERE upper(p.brand) = 'ADIDAS' AND ps."sizeConfirmedAt" IS NULL AND ps.size !~ '^T-'`;
  console.log('Restantes não-placeholder não-confirmados:', sobra[0].n, '(esperado: 0)');
  await prisma.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
