// Cadastra (ou atualiza) múltiplos FiscalIssuers em lote.
// Edita ISSUERS abaixo + roda.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const ISSUERS = [
  {
    // LOJA04 — vai ser o emissor da Nuvemshop (ecommerce)
    cnpj: '44052617000479',
    companyName: 'Meta Esportes Ltda',
    fantasyName: 'Sports & Tennis',
    ie: '165559110',
    street: 'Rua Poeta Targino Teixeira',
    number: '251',
    complement: 'Box Q0011',
    neighborhood: 'Altiplano Cabo Branco',
    cityCode: '2507507', city: 'João Pessoa', state: 'PB', zip: '58046090',
    crt: 3, environment: 'production',
    nfceSerie: 1, nfceNextNumber: 100000,
    nfeSerie: 1, nfeNextNumber: 100000,
    notes: 'Emissor padrão Nuvemshop / ecommerce',
  },
  {
    // LOJA03 — Rainha da Borborema (Campina Grande)
    cnpj: '44052617000398',
    companyName: 'Meta Esportes Ltda',
    fantasyName: 'Sports & Tennis Rainha da Borborema',
    ie: '165308877',
    street: 'Av Prefeito Severino Cabral',
    number: '900',
    neighborhood: 'Catolé',
    cityCode: '2504009', city: 'Campina Grande', state: 'PB', zip: '58410185',
    crt: 3, environment: 'production',
    nfceSerie: 1, nfceNextNumber: 100000,
    nfeSerie: 1, nfeNextNumber: 100000,
  },
  {
    // LOJA02 — Praia de Tambaú
    cnpj: '44052617000550',
    companyName: 'Meta Esportes Ltda',
    fantasyName: 'Sports & Tennis Praia de Tambaú',
    ie: '165602961',
    street: 'Av Antônio Lira',
    number: '300',
    complement: 'Sala 05',
    neighborhood: 'Tambaú',
    cityCode: '2507507', city: 'João Pessoa', state: 'PB', zip: '58039050',
    crt: 3, environment: 'production',
    nfceSerie: 1, nfceNextNumber: 100000,
    nfeSerie: 1, nfeNextNumber: 100000,
  },
];

(async () => {
  console.log('\n=== Cadastro em lote de FiscalIssuers ===');
  for (const data of ISSUERS) {
    const existing = await prisma.fiscalIssuer.findUnique({ where: { cnpj: data.cnpj } });
    let issuer;
    if (existing) {
      issuer = await prisma.fiscalIssuer.update({ where: { id: existing.id }, data });
      console.log('  ↻ ATUALIZADO:', data.fantasyName, '(' + formatCnpj(data.cnpj) + ')');
    } else {
      issuer = await prisma.fiscalIssuer.create({ data });
      console.log('  ✓ CRIADO:    ', data.fantasyName, '(' + formatCnpj(data.cnpj) + ')');
    }
  }
  console.log('\n=== Status atual de TODOS os emissores ===');
  const all = await prisma.fiscalIssuer.findMany({
    orderBy: { cnpj: 'asc' },
    select: { cnpj: true, fantasyName: true, ie: true, city: true, environment: true,
              csc: true, apiToken: true, nfceNextNumber: true, active: true },
  });
  all.forEach(i => {
    const cscOk = i.csc ? '✓CSC' : '⚠sem CSC';
    console.log('  ' + formatCnpj(i.cnpj), '|', i.fantasyName.padEnd(40), '|', i.city.padEnd(15), '|', cscOk);
  });
  await prisma.$disconnect();
})().catch(async e => { console.error('ERRO:', e); await prisma.$disconnect(); process.exit(1); });

function formatCnpj(c) {
  return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
}
