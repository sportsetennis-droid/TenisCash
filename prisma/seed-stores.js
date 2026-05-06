// prisma/seed-stores.js
// Roda UMA VEZ pra cadastrar as 4 lojas no banco
// Comando: node prisma/seed-stores.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const stores = [
  {
    code: 'LOJA01',
    name: 'Sports & Tennis Praia do Bessa',
    dna: 'Masculino',
    mall: 'Parahyba Mall',
    city: 'João Pessoa',
    state: 'PB',
  },
  {
    code: 'LOJA02',
    name: 'Sports & Tennis Praia de Tambaú',
    dna: 'Feminino',
    mall: 'Pirâmide Shopping Tambaú',
    city: 'João Pessoa',
    state: 'PB',
  },
  {
    code: 'LOJA03',
    name: 'Sports & Tennis Rainha da Borborema',
    dna: 'Futebol',
    mall: 'Complexo K',
    city: 'Campina Grande',
    state: 'PB',
  },
  {
    code: 'LOJA04',
    name: 'Sports & Tennis DNA Paraíba',
    dna: 'Geral',
    mall: 'Shopping Tambiá',
    city: 'João Pessoa',
    state: 'PB',
  },
];

async function main() {
  console.log('Cadastrando lojas...');

  for (const s of stores) {
    const existing = await prisma.store.findUnique({ where: { code: s.code } });
    if (existing) {
      console.log(`  ${s.code} já existe — atualizando dados...`);
      await prisma.store.update({
        where: { code: s.code },
        data: s,
      });
    } else {
      const created = await prisma.store.create({ data: s });
      console.log(`  ${s.code} criada: ${created.name}`);
    }
  }

  console.log('\nPronto. 4 lojas cadastradas.');
  console.log('Lista:');
  const all = await prisma.store.findMany({ orderBy: { code: 'asc' } });
  all.forEach(s => {
    console.log(`  [${s.code}] ${s.name} - DNA ${s.dna} - ${s.mall} - ${s.city}/${s.state}`);
  });
}

main()
  .catch(e => {
    console.error('ERRO:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
