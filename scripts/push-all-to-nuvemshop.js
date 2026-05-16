// =====================================================================
// Push em massa TenisCash → Nuvemshop
// =====================================================================
// Sobe todos os produtos ativos COM IMAGEM que ainda não estão mapeados.
// Roda em lotes pra dar feedback, com delay anti-rate-limit.
// Salva progresso em scripts/.push-progress.json pra retomada.
// =====================================================================

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const handlers = require('../src/services/nuvemshopHandlers');

const prisma = new PrismaClient();
const PROGRESS_FILE = path.join(__dirname, '.push-progress.json');
const BATCH_SIZE = 100;
const DELAY_MS = 250; // entre requests
const BATCH_PAUSE_MS = 5000; // entre lotes (respiro pra Nuvemshop)

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return { processed: [], failed: [], startedAt: new Date().toISOString() };
  }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

async function getConnection() {
  return prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
}

async function main() {
  log('=== PUSH TenisCash → Nuvemshop ===');

  const connection = await getConnection();
  if (!connection) {
    log('FALHA: sem conexão Nuvemshop ativa');
    process.exit(1);
  }
  log(`Conexão ativa: ${connection.nuvemshopUserId}`);

  const progress = loadProgress();
  log(`Progresso anterior: ${progress.processed.length} sucesso, ${progress.failed.length} falhas`);

  // Pega produtos pendentes: ativos + com imagem + não mapeados ainda
  const mapped = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
  const mappedIds = new Set(mapped.map(m => m.localProductId));

  const all = await prisma.product.findMany({
    where: {
      active: true,
      imageUrl: { not: null },
    },
    select: { id: true, sku: true, name: true, brand: true },
    orderBy: { createdAt: 'asc' },
  });

  const pending = all.filter(p => !mappedIds.has(p.id) && !progress.processed.includes(p.id));
  log(`Total candidatos: ${all.length}`);
  log(`Já mapeados na Nuvemshop: ${mappedIds.size}`);
  log(`Pendentes nesta rodada: ${pending.length}`);

  if (pending.length === 0) {
    log('Nada pra fazer. Tudo sincronizado!');
    return;
  }

  let created = 0, updated = 0, failed = 0;
  const startTime = Date.now();

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(pending.length / BATCH_SIZE);

    log(`--- Lote ${batchNum}/${totalBatches} (${batch.length} produtos) ---`);

    for (const p of batch) {
      try {
        const r = await handlers.pushProductToNuvemshop(p.id, connection);
        if (r.action === 'created') created++;
        else updated++;
        progress.processed.push(p.id);

        if ((created + updated) % 25 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (created + updated) / elapsed;
          const remaining = (pending.length - (created + updated + failed)) / rate;
          log(`  ✓ ${created + updated}/${pending.length}  rate=${rate.toFixed(2)}/s  ETA=${Math.round(remaining / 60)}min`);
        }
      } catch (err) {
        failed++;
        progress.failed.push({ id: p.id, sku: p.sku, name: p.name, error: err.message, at: new Date().toISOString() });
        log(`  ✗ ${p.sku} (${p.name?.slice(0, 40)}): ${err.message.slice(0, 100)}`);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    saveProgress(progress);
    log(`Lote ${batchNum} OK. Acumulado: ${created} criados, ${updated} atualizados, ${failed} falhas.`);

    if (i + BATCH_SIZE < pending.length) {
      log(`Pausa de ${BATCH_PAUSE_MS / 1000}s entre lotes...`);
      await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }
  }

  const totalMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  log('=== FINAL ===');
  log(`Criados: ${created}`);
  log(`Atualizados: ${updated}`);
  log(`Falhas: ${failed}`);
  log(`Tempo total: ${totalMin}min`);
  log(`Progresso salvo em: ${PROGRESS_FILE}`);
}

main()
  .catch(e => { console.error('FATAL:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
