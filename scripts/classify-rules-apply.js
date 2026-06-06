// Preenche aiContext.catalogPlan.classification.suggestion por REGRAS (zero IA).
// Roda local, direto no banco. NÃO classifica de fato — só sugere (dono aprova).
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { classifyByRules } = require('../src/services/catalogRules');

(async () => {
  const ids = await prisma.$queryRawUnsafe(
    `SELECT id FROM "Product" WHERE active AND (category IS NULL OR category='A CLASSIFICAR' OR subcategory IS NULL OR "aiContext"->'classification'->>'modality' IS NULL) ORDER BY id`
  );
  console.log('não-classificados:', ids.length);
  let suggested = 0, insumo = 0, manual = 0, kept = 0, err = 0, done = 0;
  const stamp = new Date().toISOString();
  const CHUNK = 25;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    await Promise.all(slice.map(async ({ id }) => {
      try {
        const p = await prisma.product.findUnique({ where: { id }, select: { id: true, name: true, brand: true, aiContext: true } });
        if (!p) return;
        const c = classifyByRules(p);
        let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
        const plan = (ctx.catalogPlan && typeof ctx.catalogPlan === 'object') ? ctx.catalogPlan : {};
        const prev = plan.classification && plan.classification.suggestion;

        if (!c.suggestion && prev) { kept++; return; } // não rebaixa: mantém sugestão que já existia

        plan.classification = {
          classified: false,
          suggestion: c.suggestion,
          suggestionSource: 'rules',
          confidence: c.confidence,
          reason: c.reason,
        };
        plan.suggestedAt = stamp;
        ctx.catalogPlan = plan;
        await prisma.product.update({ where: { id }, data: { aiContext: ctx } });

        if (!c.suggestion) manual++;
        else if (c.suggestion.category === 'INSUMO') insumo++;
        else suggested++;
      } catch (e) { err++; }
    }));
    done += slice.length;
    if (done % 500 < CHUNK) console.log(`  ...${done}/${ids.length}`);
  }
  console.log(`\nFEITO. sugeridos(regra)=${suggested} · insumo=${insumo} · manual(sem regra)=${manual} · mantidos(AI antigo)=${kept} · erros=${err}`);
  const cov = suggested + insumo;
  console.log(`Cobertura grátis: ${cov}/${ids.length} (${Math.round(cov / ids.length * 100)}%) com sugestão pronta pra aprovar.`);
  await prisma.$disconnect();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
