// =====================================================================
// Sincroniza PREÇOS dos produtos locais → Nuvemshop
// =====================================================================
// Pra cada mapping ativo:
//   1. Lê o produto da Nuvemshop (pega variants)
//   2. Compara com price do produto local
//   3. Se diferente OU NS tá com 0/null e local tem preço > 0:
//      PUT em cada variant atualizando price + promotional_price
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

async function main() {
  log(`=== SYNC PREÇOS LOCAL → NUVEMSHOP ===`);
  log(`Modo: ${dryRun ? 'DRY-RUN' : 'EXECUTE'}\n`);

  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { log('SEM CONEXAO'); process.exit(1); }

  const mappings = await prisma.nuvemshopProductMapping.findMany();
  log(`Mappings ativos: ${mappings.length}`);

  // Carrega todos os produtos locais em lote
  const localIds = mappings.map(m => m.localProductId);
  const locals = await prisma.product.findMany({
    where: { id: { in: localIds } },
    select: { id: true, sku: true, name: true, price: true, promoPrice: true, active: true },
  });
  const localMap = new Map(locals.map(l => [l.id, l]));

  let updated = 0, skipped = 0, fail = 0, alreadyOk = 0, orphansRemoved = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const local = localMap.get(m.localProductId);
    if (!local) { skipped++; continue; }
    if (!local.price || Number(local.price) === 0) { skipped++; continue; }

    if ((i + 1) % 50 === 0) log(`  ${i + 1}/${mappings.length} (updated=${updated}, ok=${alreadyOk}, orph=${orphansRemoved}, skip=${skipped}, fail=${fail})`);

    try {
      // Pega o produto da NS
      const nsProduct = await ns.nuvemshopApi(conn, 'GET', `/products/${m.nuvemshopProductId}`);
      const variants = nsProduct.variants || [];
      if (!variants.length) { skipped++; continue; }

      const targetPrice = Number(local.price).toFixed(2);
      const targetPromo = local.promoPrice && Number(local.promoPrice) > 0 ? Number(local.promoPrice).toFixed(2) : null;
      const needsUpdate = variants.some(v => {
        const cur = v.price ? Number(v.price).toFixed(2) : '0.00';
        return cur !== targetPrice;
      });
      if (!needsUpdate) { alreadyOk++; continue; }

      if (dryRun) { updated++; continue; }

      for (const v of variants) {
        await ns.nuvemshopApi(conn, 'PUT', `/products/${m.nuvemshopProductId}/variants/${v.id}`, {
          price: targetPrice,
          promotional_price: targetPromo,
        });
        await new Promise(r => setTimeout(r, 200));
      }
      updated++;
    } catch (err) {
      const msg = String(err.message || '');
      const is404 = err.status === 404 || msg.includes('404') || msg.includes('not found') || msg.includes('Not Found');
      const is429 = err.status === 429 || msg.includes('429') || msg.includes('Too Many');
      if (is404) {
        if (!dryRun) { await prisma.nuvemshopProductMapping.delete({ where: { id: m.id } }).catch(() => {}); }
        orphansRemoved++;
      } else if (is429) {
        // Retry com backoff exponencial até MAX_RETRIES
        let retried = false;
        for (let attempt = 1; attempt <= 4; attempt++) {
          const wait = Math.min(2 ** attempt * 1000 + Math.random() * 500, 16000);
          await new Promise(r => setTimeout(r, wait));
          try {
            const nsRetry = await ns.nuvemshopApi(conn, 'GET', `/products/${m.nuvemshopProductId}`);
            // Reaproveita lógica simplificada: atualiza variants
            const targetPrice = Number(local.price).toFixed(2);
            const targetPromo = local.promoPrice && Number(local.promoPrice) > 0 ? Number(local.promoPrice).toFixed(2) : null;
            for (const v of (nsRetry.variants || [])) {
              await ns.nuvemshopApi(conn, 'PUT', `/products/${m.nuvemshopProductId}/variants/${v.id}`, { price: targetPrice, promotional_price: targetPromo });
              await new Promise(r => setTimeout(r, 300));
            }
            updated++; retried = true; break;
          } catch (e2) {
            const m2 = String(e2.message || '');
            if (m2.includes('404')) {
              if (!dryRun) await prisma.nuvemshopProductMapping.delete({ where: { id: m.id } }).catch(()=>{});
              orphansRemoved++; retried = true; break;
            }
          }
        }
        if (!retried) {
          fail++;
          if (fail <= 5) log(`  ✗ ${local.sku}: ${msg.slice(0, 80)}`);
        }
      } else {
        fail++;
        if (fail <= 5) log(`  ✗ ${local.sku}: ${msg.slice(0, 80)}`);
      }
    }

    await new Promise(r => setTimeout(r, 350));
  }

  log('\n=== FINAL ===');
  log(`Preços atualizados${dryRun ? ' (simulado)' : ''}: ${updated}`);
  log(`Já estavam OK:                       ${alreadyOk}`);
  log(`Órfãos removidos${dryRun ? ' (simulado)' : ''}: ${orphansRemoved}`);
  log(`Skipped (sem preço local):           ${skipped}`);
  log(`Falhas reais:                        ${fail}`);
  const finalMappings = await prisma.nuvemshopProductMapping.count();
  log(`Mappings Nuvemshop agora:            ${finalMappings}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
