// Limpeza rápida: remove TODAS as promoções duplicadas de "Inauguração TenisCash"
// Uso: node scripts/cleanup-promos.js
//      node scripts/cleanup-promos.js --all     (apaga TODAS as promoções)

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const apagaTodas = process.argv.includes('--all');
  const titulo = 'Inauguração TenisCash';

  // Lista antes
  const antes = await prisma.promo.findMany({ select: { id: true, title: true, percentage: true, endsAt: true } });
  console.log('\nPromoções atuais no banco: ' + antes.length);
  antes.forEach((p, i) => console.log(`  ${i + 1}. ${p.title} (${p.percentage}%)`));

  let result;
  if (apagaTodas) {
    console.log('\n⚠ Modo --all: apagando TODAS as promoções.');
    result = await prisma.promo.deleteMany({});
  } else {
    console.log(`\nApagando promoções com título "${titulo}"...`);
    result = await prisma.promo.deleteMany({ where: { title: titulo } });
  }

  console.log(`\n✓ ${result.count} promoção(ões) apagada(s).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
