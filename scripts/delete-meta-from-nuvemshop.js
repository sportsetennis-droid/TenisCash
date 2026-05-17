// =====================================================================
// Deleta da Nuvemshop os produtos desativados como duplicata da Meta
// Esportes (active=false + deactivatedReason='meta_esportes_duplicate')
// que JÁ FORAM publicados lá.
//
// Pra cada produto: DELETE /products/:nuvemshopId + remove mapping.
//
// Reversível? NÃO — uma vez deletado da Nuvemshop, o produto some
// definitivamente lá (mas pode ser recriado via push se reativar).
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
  log(`=== DELETE META DUPLICATES DA NUVEMSHOP ===`);
  log(`Modo: ${dryRun ? 'DRY-RUN' : 'EXECUTE'}\n`);

  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { log('SEM CONEXÃO NUVEMSHOP ATIVA'); process.exit(1); }

  // Produtos desativados como duplicata
  const desativados = await prisma.product.findMany({
    where: {
      active: false,
      aiContext: { path: ['deactivatedReason'], equals: 'meta_esportes_duplicate' },
    },
    select: { id: true, sku: true, name: true },
  });
  const ids = desativados.map(d => d.id);
  const productMap = new Map(desativados.map(d => [d.id, d]));

  // Mappings da Nuvemshop desses produtos
  const mappings = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: ids } },
  });

  log(`Desativados encontrados: ${desativados.length}`);
  log(`COM mapping Nuvemshop (a deletar de lá): ${mappings.length}\n`);

  if (!mappings.length) { log('Nada a fazer.'); return; }

  if (dryRun) {
    mappings.slice(0, 10).forEach(m => {
      const p = productMap.get(m.localProductId);
      log(`  [SIM] DELETE NS#${m.nuvemshopProductId} ← ${p?.sku} ${p?.name?.slice(0, 50)}`);
    });
    if (mappings.length > 10) log(`  ... e mais ${mappings.length - 10}`);
    log('\n(--execute pra aplicar)');
    return;
  }

  let ok = 0, fail = 0;
  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    const p = productMap.get(m.localProductId);
    try {
      await ns.nuvemshopApi(conn, 'DELETE', `/products/${m.nuvemshopProductId}`);
      await prisma.nuvemshopProductMapping.delete({ where: { id: m.id } });
      ok++;
      if ((ok + fail) % 10 === 0) log(`  ${ok + fail}/${mappings.length} (ok=${ok}, fail=${fail})`);
    } catch (err) {
      // Se a Nuvemshop responder 404 (já deletado lá), apaga só o mapping local
      const is404 = err.status === 404 || (err.message || '').includes('404') || (err.message || '').includes('not found');
      if (is404) {
        await prisma.nuvemshopProductMapping.delete({ where: { id: m.id } }).catch(() => {});
        ok++;
        log(`  ${p?.sku}: já não existia na NS, mapping removido`);
      } else {
        fail++;
        log(`  ✗ ${p?.sku}: ${err.message?.slice(0, 80)}`);
      }
    }
    await new Promise(r => setTimeout(r, 300)); // anti rate-limit
  }

  log(`\n=== RESULTADO ===`);
  log(`Deletados da Nuvemshop: ${ok}`);
  log(`Falhas: ${fail}`);
  const remaining = await prisma.nuvemshopProductMapping.count();
  log(`Total mappings Nuvemshop agora: ${remaining}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); }).finally(() => prisma.$disconnect());
