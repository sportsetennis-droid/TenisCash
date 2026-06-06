// Triagem de QUALIDADE de imagem do catálogo — zero IA, zero custo (só banda).
// Mede resolução/peso de cada foto principal e grava em aiContext.catalogPlan.imageQuality.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { probe } = require('../src/services/imageProbe');

function flagOf(res) {
  if (!res.ok) return 'quebrada';
  if (!res.parsed || !res.w || !res.h) return 'desconhecida';
  const lng = Math.max(res.w, res.h);
  if (lng >= 1000) return 'boa';
  if (lng >= 700) return 'media';
  if (lng >= 400) return 'ruim';
  return 'pessima';
}
function nImagesOf(p) {
  let extra = 0; try { const a = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : p.imageUrls; if (Array.isArray(a)) extra = a.length; } catch (_) {}
  return (p.imageUrl ? 1 : 0) + extra;
}

(async () => {
  const rows = await prisma.$queryRawUnsafe(`SELECT id, name, brand, "imageUrl", "imageUrls", "aiContext", (upper(name) LIKE '%CHUTEIRA%') is_chuteira FROM "Product" WHERE active AND "imageUrl" IS NOT NULL ORDER BY id`);
  console.log('fotos a medir:', rows.length);
  const stamp = new Date().toISOString();
  const tally = { boa: 0, media: 0, ruim: 0, pessima: 0, desconhecida: 0, quebrada: 0 };
  const chut = { boa: 0, media: 0, ruim: 0, pessima: 0, desconhecida: 0, quebrada: 0 };
  let semZoom = 0, menos6 = 0, done = 0;
  const piores = [];
  const CHUNK = 30;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await Promise.all(slice.map(async (p) => {
      let res; try { res = await probe(p.imageUrl); } catch (_) { res = { ok: false, status: 'error' }; }
      const flag = flagOf(res);
      const lng = (res.ok && res.w) ? Math.max(res.w, res.h) : 0;
      const nImg = nImagesOf(p);
      tally[flag]++; if (p.is_chuteira) chut[flag]++;
      if (lng && lng < 1000) semZoom++;
      if (nImg < 6) menos6++;
      if (flag === 'pessima' || flag === 'quebrada') piores.push({ name: p.name, brand: p.brand, dim: res.w ? `${res.w}x${res.h}` : res.status, url: p.imageUrl });
      try {
        let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
        const plan = (ctx.catalogPlan && typeof ctx.catalogPlan === 'object') ? ctx.catalogPlan : {};
        plan.imageQuality = { w: res.w || null, h: res.h || null, long: lng || null, bytes: res.bytes || null, type: res.type || null, flag, nImages: nImg, at: stamp };
        ctx.catalogPlan = plan;
        await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
      } catch (_) {}
    }));
    done += slice.length;
    if (done % 600 < CHUNK) console.log(`  ...${done}/${rows.length}`);
  }
  const tot = rows.length;
  const pct = (n) => Math.round((n / tot) * 100) + '%';
  console.log('\n=== QUALIDADE DAS IMAGENS (catálogo) ===');
  console.log(`  boa (>=1000px, zoom ok): ${tally.boa} (${pct(tally.boa)})`);
  console.log(`  média (700-999px):       ${tally.media} (${pct(tally.media)})`);
  console.log(`  ruim (400-699px):        ${tally.ruim} (${pct(tally.ruim)})`);
  console.log(`  PÉSSIMA (<400px):        ${tally.pessima} (${pct(tally.pessima)})`);
  console.log(`  link QUEBRADO:           ${tally.quebrada} (${pct(tally.quebrada)})`);
  console.log(`  não-lida:                ${tally.desconhecida} (${pct(tally.desconhecida)})`);
  console.log(`  --`);
  console.log(`  SEM zoom (<1000px):      ${semZoom} (${pct(semZoom)}) ← matam conversão`);
  console.log(`  com MENOS de 6 fotos:    ${menos6} (${pct(menos6)})`);
  console.log(`\n=== CHUTEIRAS (298) ===`);
  console.log(`  boa=${chut.boa} média=${chut.media} ruim=${chut.ruim} péssima=${chut.pessima} quebrada=${chut.quebrada} não-lida=${chut.desconhecida}`);
  console.log(`\n=== AMOSTRA DAS PIORES (${Math.min(20, piores.length)} de ${piores.length}) ===`);
  piores.slice(0, 20).forEach((x) => console.log(`  [${(x.brand || '?').slice(0, 10).padEnd(10)}] ${x.dim.toString().padEnd(10)} ${(x.name || '').slice(0, 42)}`));
  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
