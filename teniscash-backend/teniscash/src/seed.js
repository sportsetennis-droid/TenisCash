const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function seed() {
  console.log('Iniciando seed do TenisCash...');

  // Cria admin padrão
  const adminPin = await bcrypt.hash('1234', 10);
  const admin = await prisma.user.upsert({
    where: { phone: '83999990001' },
    create: {
      name: 'Douglas Admin',
      phone: '83999990001',
      pin: adminPin,
      role: 'superadmin',
      balance: 0,
    },
    update: {}
  });
  console.log('Admin criado:', admin.name);

  // Configura bônus de boas-vindas
  await prisma.config.upsert({
    where: { key: 'welcome_bonus' },
    create: { key: 'welcome_bonus', value: '100' },
    update: {}
  });
  console.log('Bônus de boas-vindas: 100 TenisCash');

  // Regras de marca padrão
  const brands = [
    { brand: 'Olympikus', maxDiscount: 25 },
    { brand: 'Puma', maxDiscount: 15 },
    { brand: 'Nike', maxDiscount: 15 },
    { brand: 'Adidas', maxDiscount: 15 },
    { brand: 'Converse', maxDiscount: 30 },
    { brand: 'Mizuno', maxDiscount: 20 },
    { brand: 'Fila', maxDiscount: 25 },
    { brand: 'Penalty', maxDiscount: 25 },
    { brand: 'Reebok', maxDiscount: 20 },
    { brand: 'Brooks', maxDiscount: 15 },
  ];

  for (const b of brands) {
    await prisma.brandRule.upsert({
      where: { brand: b.brand },
      create: b,
      update: { maxDiscount: b.maxDiscount },
    });
  }
  console.log('Regras de marca configuradas:', brands.length);

  // Promo inicial
  await prisma.promo.create({
    data: {
      title: 'Inauguração TenisCash',
      description: 'TenisCash vale até 30% em toda a loja na semana de lançamento',
      percentage: 30,
      scope: 'all',
      endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 dias
    }
  }).catch(() => {});
  console.log('Promo de inauguração criada');

  console.log('\n✅ Seed completo!');
  console.log('Login admin: 83999990001 / PIN: 1234');
  console.log('TROQUE O PIN DO ADMIN APÓS O PRIMEIRO LOGIN!\n');

  await prisma.$disconnect();
}

seed().catch(console.error);
