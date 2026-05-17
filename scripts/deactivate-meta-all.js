// =====================================================================
// Desativa TODOS os 1.706 produtos exclusivos vindos da Meta Esportes
// (CNPJ 44052617000126).
//
// Motivo: NF de transferência de filial NÃO cria estoque novo. O produto
// já entrou pela NF original do fornecedor real (Nike, CajuBrasil, etc).
// Esses produtos entraram errado no sistema e devem sair.
//
// O que faz:
// 1. active = false
// 2. aiContext.deactivatedReason = 'meta_esportes_transferencia_filial'
// 3. Reversível com --rollback
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
  log(`=== DESATIVAR TODOS Meta Esportes (transferencia filial) ===`);
  log(`Modo: ${rollback ? 'ROLLBACK' : (dryRun ? 'DRY-RUN' : 'EXECUTE')}\n`);

  if (rollback) {
    const r = await prisma.$queryRaw`
      UPDATE "Product" SET active = true
      WHERE "aiContext"->>'deactivatedReason' = 'meta_esportes_transferencia_filial'
      RETURNING id
    `;
    log(`Reativados: ${r.length}`);
    return;
  }

  const products = await prisma.product.findMany({
    where: { aiContext: { path: ['supplierCnpj'], equals: META_CNPJ }, active: true },
    select: { id: true, sku: true, aiContext: true },
  });
  log(`Produtos Meta Esportes ainda ativos: ${products.length}`);

  if (dryRun) {
    log('(dry-run — use --execute pra aplicar)');
    return;
  }

  const now = new Date().toISOString();
  let updated = 0;
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const ctx = (() => {
      try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
      catch { return {}; }
    })();
    await prisma.product.update({
      where: { id: p.id },
      data: {
        active: false,
        aiContext: { ...ctx, deactivatedReason: 'meta_esportes_transferencia_filial', deactivatedAt: now },
      },
    });
    updated++;
    if (updated % 200 === 0) log(`  ${updated}/${products.length}`);
  }
  log(`\n✓ Desativados: ${updated}`);

  // Estado final
  const totalActive = await prisma.product.count({ where: { active: true } });
  log(`Produtos ativos agora: ${totalActive}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
