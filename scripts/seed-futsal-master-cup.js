'use strict';
// CLI do carregamento do II Futsal Master Cup 2026 (usa o módulo oficial).
// Uso: node scripts/seed-futsal-master-cup.js [--apply] [OWNER_EMAIL=...]
// Sem --apply = dry-run (só mostra). A carga em si é idempotente.
// Pela loja, o mais fácil é o botão "Importar" em /torneios.html (admin).

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { importFutsalMasterCup } = require('../src/services/futsalMasterCupSeed');

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`\n🏆 II FUTSAL MASTER CUP 2026 — ${APPLY ? 'GRAVANDO' : 'dry-run (nada gravado)'}\n`);
  if (!APPLY) {
    console.log('Dry-run: rode com --apply pra gravar, ou use o botão "Importar" em /torneios.html (admin).\n');
    return;
  }
  let ownerId = null;
  if (process.env.OWNER_EMAIL) {
    const u = await prisma.user.findUnique({ where: { email: process.env.OWNER_EMAIL }, select: { id: true } });
    if (u) ownerId = u.id;
  }
  const r = await importFutsalMasterCup(ownerId);
  if (!r.ok) {
    console.error('❌', r.error);
    process.exit(1);
  }
  console.log(`✅ ${r.categories} categorias · ${r.teams} times · ${r.matchesCreated} jogos criados (${r.matchesTBD} a confirmar).`);
  console.log(`   Página pública: ${r.publicUrl}\n`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
