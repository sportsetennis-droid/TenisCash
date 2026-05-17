// =====================================================================
// Sincroniza MARCAS dos produtos locais → Nuvemshop
// Pra cada mapping, faz PUT em /products/:nsId com { brand }
// Pula se já tá igual. Retry exponencial pra 429.
// Custo: ZERO (sem IA)
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
const ns = require('../src/services/nuvemshop');
const prisma = new PrismaClient();

const dryRun = !process.argv.includes('--execute');

function log(m) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`); }

async function putWithRetry(conn, productId, payload, attempt = 1) {
  try {
    return await ns.nuvemshopApi(conn, 'PUT', '/products/' + productId, payload);
  } catch (err) {
    const msg = String(err.message || '');
    const is429 = err.status === 429 || msg.includes('429') || msg.includes('Too Many');
    const is5xx = err.status >= 500 || /5\d\d/.test(msg);
    if ((is429 || is5xx) && attempt < 4) {
      const wait = Math.min(2 ** attempt * 1000 + Math.random() * 500, 16000);
      await new Promise(r => setTimeout(r, wait));
      return putWithRetry(conn, productId, payload, attempt + 1);
    }
    throw err;
  }
}

async function main() {
  log('=== SYNC MARCAS LOCAL → NUVEMSHOP ===');
  log('Modo: ' + (dryRun ? 'DRY-RUN' : 'EXECUTE') + '\n');

  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { log('SEM CONEXAO'); process.exit(1); }

  const mappings = await prisma.nuvemshopProductMapping.findMany();
  log('Mappings: ' + mappings.length);

  const locals = await prisma.product.findMany({
    where: { id: { in: mappings.map(m => m.localProductId) } },
    select: { id: true, sku: true, brand: true },
  });
  const localMap = new Map(locals.map(l => [l.id, l]));

  let updated = 0, alreadyOk = 0, fail = 0, orphan = 0, skipped = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const local = localMap.get(m.localProductId);
    if (!local || !local.brand) { skipped++; continue; }

    if ((i + 1) % 100 === 0) log('  ' + (i+1) + '/' + mappings.length + ' (upd=' + updated + ', ok=' + alreadyOk + ', orph=' + orphan + ', fail=' + fail + ')');

    try {
      const nsProduct = await ns.nuvemshopApi(conn, 'GET', '/products/' + m.nuvemshopProductId);
      if ((nsProduct.brand || '') === local.brand) { alreadyOk++; continue; }
      if (dryRun) { updated++; continue; }
      await putWithRetry(conn, m.nuvemshopProductId, { brand: local.brand });
      updated++;
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 404 || msg.includes('404') || msg.includes('not found')) {
        if (!dryRun) await prisma.nuvemshopProductMapping.delete({ where: { id: m.id } }).catch(() => {});
        orphan++;
      } else {
        fail++;
        if (fail <= 5) log('  ✗ ' + local.sku + ': ' + msg.slice(0, 80));
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }

  log('\n=== FINAL ===');
  log('Marcas atualizadas' + (dryRun ? ' (simulado)' : '') + ': ' + updated);
  log('Já estavam OK:                       ' + alreadyOk);
  log('Órfãos removidos:                    ' + orphan);
  log('Skipped (sem brand local):           ' + skipped);
  log('Falhas:                              ' + fail);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
