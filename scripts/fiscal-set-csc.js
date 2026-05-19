// Atualiza CSC/cscId no FiscalIssuer existente.
// Args: --cnpj <14digitos> --csc <token> --cscid <1-3>
// Ou edita os defaults abaixo e roda direto.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1]]);
  return acc;
}, []));

const cnpj = (args.cnpj || '44052617000126').replace(/\D/g, '');
const csc = args.csc || 'B31D3421-3B60-7CE1-15CB-8E6BB167BEB5';
const cscId = args.cscid || '1';

(async () => {
  const issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj } });
  if (!issuer) {
    console.error('Issuer não encontrado pra CNPJ ' + cnpj);
    process.exit(1);
  }
  const upd = await prisma.fiscalIssuer.update({
    where: { id: issuer.id },
    data: { csc, cscId },
  });
  console.log('✓ CSC atualizado em FiscalIssuer:');
  console.log('  ID interno:', upd.id);
  console.log('  CNPJ:', upd.cnpj);
  console.log('  Empresa:', upd.companyName);
  console.log('  CSC_ID:', upd.cscId);
  console.log('  CSC:', '*'.repeat(upd.csc.length - 4) + upd.csc.slice(-4)); // mostra mascarado
  console.log('  Ambiente:', upd.environment);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
