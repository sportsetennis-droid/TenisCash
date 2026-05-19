// prisma/seed-stores.js
// Cadastro idempotente das 6 Stores da rede Sports & Tennis, alinhado
// com o número de filial do CNPJ Meta Esportes (44.052.617/000X-XX):
//   /0001 → LOJA01 Baratão (matriz)
//   /0002 → LOJA02 Bessa
//   /0003 → LOJA03 Rainha (Campina Grande)
//   /0004 → LOJA04 Ecommerce (Nuvemshop)
//   /0005 → LOJA05 Tambaú
//   /0006 → LOJA06 Tambiá (DNA Paraíba)
// Comando: node prisma/seed-stores.js

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const stores = [
  {
    code: 'LOJA01',
    name: 'Baratão dos Esportes',
    dna: 'Outlet',
    mall: 'Loja de Rua',
    city: 'João Pessoa',
    state: 'PB',
    latitude: -7.1195,
    longitude: -34.8450,
  },
  {
    code: 'LOJA02',
    name: 'Sports & Tennis Praia do Bessa',
    dna: 'Masculino',
    mall: 'Parahyba Mall',
    city: 'João Pessoa',
    state: 'PB',
    latitude: -7.0812177,
    longitude: -34.8391033,
  },
  {
    code: 'LOJA03',
    name: 'Sports & Tennis Rainha da Borborema',
    dna: 'Futebol',
    mall: 'Complexo K',
    city: 'Campina Grande',
    state: 'PB',
    latitude: -7.2328083,
    longitude: -35.8716498,
  },
  {
    code: 'LOJA04',
    name: 'Sports & Tennis (Ecommerce)',
    dna: 'Ecommerce',
    mall: 'Online — Nuvemshop',
    city: 'João Pessoa',
    state: 'PB',
    latitude: -7.1430,
    longitude: -34.8810,
  },
  {
    code: 'LOJA05',
    name: 'Sports & Tennis Praia de Tambaú',
    dna: 'Feminino',
    mall: 'Pirâmide Shopping Tambaú',
    city: 'João Pessoa',
    state: 'PB',
    latitude: -7.1147014,
    longitude: -34.8238210,
  },
  {
    code: 'LOJA06',
    name: 'Sports & Tennis Tambiá',
    dna: 'Geral',
    mall: 'Shopping Tambiá',
    city: 'João Pessoa',
    state: 'PB',
    latitude: -7.1163828,
    longitude: -34.8798557,
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

  console.log('\nPronto. ' + stores.length + ' lojas cadastradas.');
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
