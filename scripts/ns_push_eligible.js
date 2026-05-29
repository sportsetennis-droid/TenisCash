// Sobe pro Nuvemshop só os produtos com as 4 classificações completas.
// Uso: node scripts/ns_push_eligible.js [--dry]
const { prisma } = require('../src/middleware');
const handlers = require('../src/services/nuvemshopHandlers');

const DRY = process.argv.includes('--dry');
const BAD_CAT = ['', 'A CLASSIFICAR', 'A DEFINIR'];
const has = (v) => v != null && String(v).trim() !== '';

function parseCtx(p) {
  try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
  catch { return {}; }
}
function isFull(p) {
  const cls = (parseCtx(p).classification) || {};
  return has(p.category) && !BAD_CAT.includes(String(p.category).trim())
    && has(p.subcategory) && has(cls.modality) && has(cls.tier);
}

(async () => {
  const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
  if (!conn) { console.log('SEM conexão NS ativa'); process.exit(1); }

  // pré-filtra no banco (categoria+sub) e refina modality/tier em JS
  const candidates = await prisma.product.findMany({
    where: {
      active: true,
      category: { notIn: BAD_CAT },
      subcategory: { not: null },
    },
    select: { id: true, sku: true, name: true, aiContext: true, category: true, subcategory: true },
    orderBy: { createdAt: 'asc' },
  });
  const eligible = candidates.filter(isFull);

  // quantos já têm mapping (já estão no NS)
  const mapped = await prisma.nuvemshopProductMapping.findMany({
    where: { localProductId: { in: eligible.map((e) => e.id) } },
    select: { localProductId: true },
  });
  const mappedSet = new Set(mapped.map((m) => m.localProductId));

  console.log(`ELEGÍVEIS (4 classificações): ${eligible.length}`);
  console.log(`  já no NS (têm mapping): ${mappedSet.size}`);
  console.log(`  novos a criar: ${eligible.length - mappedSet.size}`);
  if (DRY) {
    eligible.forEach((e) => console.log(`  ${mappedSet.has(e.id) ? 'UPD' : 'NEW'}  ${e.category}/${e.subcategory}  ${e.name}`));
    process.exit(0);
  }

  let created = 0, updated = 0, skipped = 0, failed = 0;
  const errors = [];
  for (const e of eligible) {
    try {
      const r = await handlers.pushProductToNuvemshop(e.id, conn);
      if (r.skipped) { skipped++; }
      else if (r.action === 'created') { created++; console.log('  CRIADO  ', e.name); }
      else { updated++; console.log('  ATUALIZOU', e.name.slice(0, 40)); }
      await new Promise((r) => setTimeout(r, 250));
    } catch (err) {
      failed++;
      errors.push({ name: e.name, error: err.message });
      console.log('  ERRO    ', e.name.slice(0, 40), '::', err.message);
    }
  }

  console.log('\n=== RESULTADO ===');
  console.log(`criados:    ${created}`);
  console.log(`atualizados:${updated}`);
  console.log(`pulados:    ${skipped}`);
  console.log(`falhas:     ${failed}`);
  if (errors.length) console.log('erros:', JSON.stringify(errors.slice(0, 10), null, 2));
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
