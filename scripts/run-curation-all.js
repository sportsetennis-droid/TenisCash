// =====================================================================
// Roda o agente curador em TODOS os produtos pendentes do catalogo.
// Modo background — log em arquivo + DB já é a fonte de verdade.
// =====================================================================
// Uso:
//   node scripts/run-curation-all.js [--limit=10000] [--cnpj=02675611000750] [--concurrency=3]
// =====================================================================

// Carrega .env
const fs = require('fs');
const path = require('path');
try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
} catch (_) {}

const { PrismaClient } = require('@prisma/client');
const prisma = global._prismaCuration || (global._prismaCuration = new PrismaClient());
const { curateProduct } = require('../src/services/curationAgent');

const LOG = path.join(__dirname, '..', 'curation-progress.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

function parseArgs() {
  const out = { limit: 10000, cnpj: null, concurrency: 3 };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--limit=')) out.limit = parseInt(a.split('=')[1], 10) || out.limit;
    else if (a.startsWith('--cnpj=')) out.cnpj = a.split('=')[1];
    else if (a.startsWith('--concurrency=')) out.concurrency = parseInt(a.split('=')[1], 10) || out.concurrency;
  }
  return out;
}

async function main() {
  const args = parseArgs();
  log(`=== Iniciando curadoria autônoma ===`);
  log(`Limit: ${args.limit} | CNPJ: ${args.cnpj || '(todos)'} | Concurrency: ${args.concurrency}`);

  const where = {
    active: true,
    OR: [{ imageUrl: null }, { longDescription: null }],
  };
  if (args.cnpj) where.aiContext = { path: ['supplierCnpj'], equals: args.cnpj };

  const queue = await prisma.product.findMany({
    where,
    select: { id: true, sku: true, name: true, brand: true },
    take: args.limit,
    orderBy: [{ brand: 'asc' }, { name: 'asc' }],
  });
  log(`Fila: ${queue.length} produtos pendentes`);
  if (!queue.length) {
    log('Nada pra curar. Saindo.');
    await prisma.$disconnect();
    return;
  }

  let processed = 0, imageOk = 0, descOk = 0, nsOk = 0, errors = 0;
  let totalCostBRL = 0;
  const startedAt = Date.now();

  // Worker pool simples — N produtos sendo curados em paralelo
  let cursor = 0;
  async function worker(id) {
    while (cursor < queue.length) {
      const myIdx = cursor++;
      const product = queue[myIdx];
      try {
        const r = await curateProduct(product.id, { imageCandidates: 6, minScore: 4 });
        if (r.steps.image?.ok) imageOk++;
        if (r.steps.description?.ok) descOk++;
        if (r.steps.nuvemshop?.synced) nsOk++;
        if (r.error) errors++;
        totalCostBRL += r.costBRL || 0;
        processed++;
        if (processed % 20 === 0 || processed < 10) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const avg = processed > 0 ? (elapsed / processed) : 0;
          const remaining = Math.round(avg * (queue.length - processed));
          log(`[${processed}/${queue.length}] img:${imageOk} desc:${descOk} ns:${nsOk} err:${errors} | R$ ${totalCostBRL.toFixed(2)} | ${elapsed}s rodando | ~${Math.round(remaining/60)}min restantes`);
        }
      } catch (err) {
        errors++;
        log(`ERRO ${product.sku}: ${err.message}`);
      }
    }
  }

  // Dispara N workers em paralelo
  await Promise.all(Array.from({ length: args.concurrency }, (_, i) => worker(i + 1)));

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log(`\n=== CURADORIA CONCLUÍDA ===`);
  log(`Processados:           ${processed}`);
  log(`Com imagem:            ${imageOk}`);
  log(`Com descrição:         ${descOk}`);
  log(`Sync Nuvemshop:        ${nsOk}`);
  log(`Erros:                 ${errors}`);
  log(`Custo total estimado:  R$ ${totalCostBRL.toFixed(2)}`);
  log(`Tempo total:           ${Math.round(elapsed/60)} min`);

  await prisma.$disconnect();
}

main().catch((err) => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
