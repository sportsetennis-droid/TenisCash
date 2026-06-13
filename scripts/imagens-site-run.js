// =====================================================================
// CLI: roda o orquestrador IMAGENS DE SITE (Mapeador + Estoque) contra o
// banco REAL e imprime o plano. Pra testar a seleção no terminal antes
// de ligar a tela. READ-ONLY no catálogo (só grava 2 chaves de Config).
//   node scripts/imagens-site-run.js                 → fem + masc
//   node scripts/imagens-site-run.js feminino        → só feminino
// =====================================================================
try {
  const fs = require('fs'); const path = require('path');
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  env.split(/\r?\n/).forEach((l) => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch { /* sem .env: usa o ambiente */ }

const { PrismaClient } = require('@prisma/client');
const orchestrator = require('../src/services/imagensSite/orchestrator');
const prisma = new PrismaClient();

const emit = (e) => {
  const tag = String(e.level || 'info').toUpperCase().padEnd(4);
  const slot = e.slot ? ` #${e.slot}` : '';
  console.log(`[${tag}] ${e.agent}/${e.phase}${slot} — ${e.msg}`);
};

(async () => {
  const genders = process.argv.slice(2).filter((a) => ['feminino', 'masculino'].includes(a));
  const { plan } = await orchestrator.run({ prisma, emit, genders: genders.length ? genders : null });

  console.log('\n=== PLANO (resumo) ===');
  for (const it of plan) {
    const p = it.product;
    const who = p ? `${(p.brand || '').trim()} ${p.name} [${p.bipado}un]` : '(vazio)';
    console.log(
      `#${String(it.slot).padStart(2)} ${it.gender.padEnd(9)} ${it.section.padEnd(6)} ${String(it.label).padEnd(16)} ${it.dims.join('x').padEnd(9)} → ${who}`,
    );
  }
  const filled = plan.filter((x) => x.product).length;
  console.log(`\nPreenchidos: ${filled}/${plan.length}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
