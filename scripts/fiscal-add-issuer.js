// Cadastra (ou atualiza) FiscalIssuer no banco a partir de dict inline.
// Editar a constante DATA abaixo + rodar.

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DATA = {
  cnpj: '44052617000207',
  companyName: 'Meta Esportes Ltda',                  // mesma razão da matriz — filial herda
  fantasyName: 'Sports & Tennis Praia do Bessa',      // aparece no cupom
  ie: '165261730',
  im: null,
  street: 'Rua Bacharel José de Oliveira Curvhatuz',
  number: '850',
  complement: 'Sala 85',
  neighborhood: 'Jardim Oceania',
  cityCode: '2507507', // João Pessoa
  city: 'João Pessoa',
  state: 'PB',
  zip: '58037432',
  phone: null,
  apiToken: null,  // não usado (emissão direta SEFAZ)
  environment: 'production',
  csc: null,       // aguardando geração no portal SEFAZ-PB
  cscId: null,
  crt: 3,          // Regime Normal (igual à matriz — confirmado via DANFE Chianca)
  active: true,
  // Numeração: usa série 1 + começa em 100000 pra não conflitar com Chianca histórico
  nfceSerie: 1,
  nfceNextNumber: 100000,
  nfeSerie: 1,
  nfeNextNumber: 100000,
};

(async () => {
  console.log('\n=== Cadastrando FiscalIssuer ===');
  let issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: DATA.cnpj } });
  if (issuer) {
    console.log('• Existe (id=' + issuer.id + ') — ATUALIZANDO');
    issuer = await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data: DATA });
  } else {
    console.log('• CRIANDO novo');
    issuer = await prisma.fiscalIssuer.create({ data: DATA });
  }
  console.log('  ✓ ID:', issuer.id);
  console.log('  ✓ CNPJ:', issuer.cnpj.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5'));
  console.log('  ✓ Razão:', issuer.companyName);
  console.log('  ✓ Fantasia (sai no cupom):', issuer.fantasyName);
  console.log('  ✓ IE:', issuer.ie);
  console.log('  ✓ Endereço:', issuer.street, issuer.number, '-', issuer.neighborhood, '-', issuer.city, '/', issuer.state, '- CEP', issuer.zip);
  console.log('  ✓ CRT:', issuer.crt, '(Regime Normal)');
  console.log('  ✓ Ambiente:', issuer.environment);
  console.log('  ⚠ CSC: pendente — gerar no portal SEFAZ-PB');
  console.log('  → Próxima NFCe: ' + issuer.nfceNextNumber + ' (série ' + issuer.nfceSerie + ')');
  await prisma.$disconnect();
})().catch(async e => { console.error('ERRO:', e); await prisma.$disconnect(); process.exit(1); });
