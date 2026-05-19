// Renumera as Stores baseado no CNPJ raiz da Meta Esportes (44.052.617).
// MANTÉM os UUIDs internos — só muda code/name/fiscalIssuer.
// Assim estoque, vendas e histórico ficam intactos.
//
// Mapa de re-organização:
//   /0001-26 → LOJA01 Baratão dos Esportes (matriz)
//   /0002-07 → LOJA02 Sports & Tennis Praia do Bessa
//   /0003-98 → LOJA03 Sports & Tennis Rainha da Borborema
//   /0004-79 → LOJA04 Sports & Tennis (Ecommerce — substitui Fábrica)
//   /0005-50 → LOJA05 Sports & Tennis Praia de Tambaú
//   /0006-30 → LOJA06 Sports & Tennis Tambiá

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Identifica Store atual por nome (mais robusto que code)
// → mapeia pra (novo code + novo name + dna + mall + fiscalIssuer CNPJ)
const REMAP = [
  { matchNames: ['Baratão dos Esportes', 'Baratão'],
    newCode: 'LOJA01', newName: 'Baratão dos Esportes',
    dna: 'Outlet', mall: 'Loja de Rua', city: 'João Pessoa', state: 'PB',
    issuerCnpj: '44052617000126' },
  { matchNames: ['Sports & Tennis Praia do Bessa', 'Bessa'],
    newCode: 'LOJA02', newName: 'Sports & Tennis Praia do Bessa',
    dna: 'Masculino', mall: 'Parahyba Mall', city: 'João Pessoa', state: 'PB',
    issuerCnpj: '44052617000207' },
  { matchNames: ['Sports & Tennis Rainha da Borborema', 'Rainha'],
    newCode: 'LOJA03', newName: 'Sports & Tennis Rainha da Borborema',
    dna: 'Futebol', mall: 'Complexo K', city: 'Campina Grande', state: 'PB',
    issuerCnpj: '44052617000398' },
  { matchNames: ['Fábrica', 'Fabrica', 'Ecommerce'],
    newCode: 'LOJA04', newName: 'Sports & Tennis (Ecommerce)',
    dna: 'Ecommerce', mall: 'Online — Nuvemshop', city: 'João Pessoa', state: 'PB',
    issuerCnpj: '44052617000479' },
  { matchNames: ['Sports & Tennis Praia de Tambaú', 'Tambaú'],
    newCode: 'LOJA05', newName: 'Sports & Tennis Praia de Tambaú',
    dna: 'Feminino', mall: 'Pirâmide Shopping Tambaú', city: 'João Pessoa', state: 'PB',
    issuerCnpj: '44052617000550' },
  { matchNames: ['Sports & Tennis DNA Paraíba', 'Sports & Tennis Tambiá', 'DNA Paraíba', 'Tambiá'],
    newCode: 'LOJA06', newName: 'Sports & Tennis Tambiá',
    dna: 'Geral', mall: 'Shopping Tambiá', city: 'João Pessoa', state: 'PB',
    issuerCnpj: '44052617000630' },
];

(async () => {
  console.log('\n=== Remap Stores ===\n');

  // 1) Pega todas as Stores atuais
  const stores = await prisma.store.findMany();
  console.log('Stores atuais:', stores.length);

  // 2) Faz match e cria plano (sem aplicar ainda)
  const plan = [];
  for (const r of REMAP) {
    const store = stores.find(s => r.matchNames.some(n => s.name.toLowerCase().includes(n.toLowerCase())));
    if (!store) {
      console.log('  ⚠ não achei store pra:', r.newCode, r.newName);
      continue;
    }
    const issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: r.issuerCnpj } });
    if (!issuer) {
      console.log('  ⚠ FiscalIssuer não cadastrado pra CNPJ:', r.issuerCnpj);
      continue;
    }
    plan.push({ store, target: r, issuer });
  }

  // 3) Renomeia tudo pra códigos TEMPORÁRIOS primeiro (evita conflito @unique)
  console.log('\n• Etapa 1: códigos temporários...');
  for (const p of plan) {
    await prisma.store.update({
      where: { id: p.store.id },
      data: { code: 'TMP_' + p.store.id.slice(0, 8) },
    });
  }

  // 4) Aplica códigos/nomes/fiscalIssuer finais
  console.log('• Etapa 2: códigos finais + vínculo FiscalIssuer...\n');
  for (const p of plan) {
    await prisma.store.update({
      where: { id: p.store.id },
      data: {
        code: p.target.newCode,
        name: p.target.newName,
        dna: p.target.dna,
        mall: p.target.mall,
        city: p.target.city,
        state: p.target.state,
        fiscalIssuerId: p.issuer.id,
      },
    });
    const oldLabel = p.store.name + ' (era ' + p.store.code + ')';
    console.log('  ✓ ' + p.target.newCode + ' ← ' + oldLabel + ' → ' + p.target.newName);
    console.log('     CNPJ emissor: ' + p.target.issuerCnpj + ' | DNA: ' + p.target.dna);
  }

  // 5) Status final
  console.log('\n=== Status final ===');
  const final = await prisma.store.findMany({
    orderBy: { code: 'asc' },
    include: { fiscalIssuer: { select: { cnpj: true, fantasyName: true, csc: true } } },
  });
  final.forEach(s => {
    const fmtCnpj = s.fiscalIssuer ? s.fiscalIssuer.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : '—';
    const cscOk = s.fiscalIssuer?.csc ? '✓CSC' : '⚠sem CSC';
    console.log('  ' + s.code + ' | ' + s.name.padEnd(40) + ' | ' + fmtCnpj + ' | ' + cscOk);
  });

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
