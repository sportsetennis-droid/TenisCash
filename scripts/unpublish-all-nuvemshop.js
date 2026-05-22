// =====================================================================
// unpublish-all-nuvemshop.js
// =====================================================================
// Despublica TODOS os produtos espelhados na Nuvemshop (published=false).
// Eles continuam existindo (mapping preservado, URLs vivas) mas ficam
// ocultos pro cliente na loja.
//
// Quando o Douglas classificar um produto completamente no TenisCash
// (category + subcategory + modality + tier), o sync automatico vai
// re-publicar (published=true) na proxima edicao.
//
// Idempotente: pula produtos ja despublicados.
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const ns = require('../src/services/nuvemshop');
const prisma = new PrismaClient();

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { console.error('Sem conexao NS'); process.exit(1); }

  const mappings = await prisma.nuvemshopProductMapping.findMany({
    select: { localProductId: true, nuvemshopProductId: true },
    orderBy: { id: 'asc' },
  });

  console.log('Total mapeados na NS:', mappings.length);
  console.log('Iniciando despublicacao...\n');

  let ok = 0, alreadyOff = 0, fail = 0;
  const startTs = Date.now();

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    try {
      // GET pra checar estado atual
      let current;
      try {
        current = await ns.nuvemshopApi(conn, 'GET', `/products/${m.nuvemshopProductId}`);
      } catch (e) {
        // Produto não existe mais na NS — limpa mapping
        if (/404/.test(e.message)) {
          await prisma.nuvemshopProductMapping.delete({ where: { localProductId: m.localProductId } }).catch(() => {});
          fail++;
          continue;
        }
        throw e;
      }
      if (current.published === false) { alreadyOff++; continue; }

      await ns.nuvemshopApi(conn, 'PUT', `/products/${m.nuvemshopProductId}`, { published: false });
      ok++;
    } catch (e) {
      fail++;
      console.error('  ✗', m.nuvemshopProductId, '-', e.message);
    }
    if ((i + 1) % 50 === 0) {
      const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
      console.log(`  ${i + 1}/${mappings.length} | ok:${ok} jaOff:${alreadyOff} fail:${fail} | ${elapsed}s`);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\n=== RESULTADO ===');
  console.log('Despublicados:', ok);
  console.log('Ja estavam off:', alreadyOff);
  console.log('Falhas:', fail);
  console.log('Tempo total:', Math.round((Date.now() - startTs) / 1000) + 's');

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
