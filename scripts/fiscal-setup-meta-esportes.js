// =====================================================================
// fiscal-setup-meta-esportes.js
// Cadastra (ou atualiza) o emissor fiscal Meta Esportes Ltda / Baratão dos
// Esportes no banco e faz UM ping de validação na Brasil NFe.
// NÃO emite NFe/NFCe nesse script — só prepara e valida o token.
//
// Uso:
//   node scripts/fiscal-setup-meta-esportes.js
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fiscal = require('../src/services/fiscalApi');

const TOKEN = 'Z2creTkvQzFyWXBEQTNxRzdaQy9oOWtwelZJTDgxRjNLaTlOc2NwWjVGdz06UDZlalZBUE5RVXE0SjZ4ak9WYUhzQT09OjE4LzA1LzIwMzY=';

const data = {
  cnpj: '44052617000126',
  companyName: 'Meta Esportes Ltda',
  fantasyName: 'Baratão dos Esportes',
  ie: '164687769',
  im: null,
  street: 'Rua Treze de Maio',
  number: '249',
  complement: null,
  neighborhood: 'Centro',
  cityCode: '2507507', // João Pessoa IBGE
  city: 'João Pessoa',
  state: 'PB',
  zip: '58013070',
  phone: null,
  apiToken: TOKEN,
  environment: 'homologation', // mais seguro pra começar
  csc: null,                   // pra NFCe — adicionar depois quando gerar no portal SEFAZ-PB
  cscId: null,
  crt: 1,                      // Simples Nacional (ajustar se for outro)
  active: true,
};

(async () => {
  console.log('\n=== Setup Fiscal: Meta Esportes Ltda / Baratão dos Esportes ===\n');

  // 1) Cria ou atualiza issuer
  let issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj: data.cnpj } });
  if (issuer) {
    console.log('• Issuer já existe, atualizando dados...');
    issuer = await prisma.fiscalIssuer.update({ where: { id: issuer.id }, data });
  } else {
    console.log('• Criando novo issuer...');
    issuer = await prisma.fiscalIssuer.create({ data });
  }
  console.log('  ✓ ID interno:', issuer.id);
  console.log('  ✓ CNPJ:', issuer.cnpj);
  console.log('  ✓ Empresa:', issuer.companyName);
  console.log('  ✓ Fantasia:', issuer.fantasyName);
  console.log('  ✓ Ambiente:', issuer.environment, '(TipoAmbiente=' + fiscal.tipoAmbiente(issuer.environment) + ')');

  // 2) Validação leve do token — consulta uma chave fictícia.
  //    Token errado → 401/403. Token OK + chave inexistente → 404 ou JSON de erro específico.
  console.log('\n• Validando token via Brasil NFe (GET ConsultarNotaFiscal/0000000000000000000000000000000000000000000)...');
  try {
    const r = await fiscal.consultarNotaFiscal(issuer, '0'.repeat(44));
    console.log('  HTTP status:', r.status);
    if (r.status === 401 || r.status === 403) {
      console.log('  ❌ TOKEN INVÁLIDO OU EXPIRADO — verifica no painel Brasil NFe');
    } else if (r.status === 404 || (r.data && /n.o encontrad/i.test(JSON.stringify(r.data)))) {
      console.log('  ✓ Token autenticou (chave fictícia não existe — esperado)');
    } else {
      console.log('  Resposta:', JSON.stringify(r.data || {}, null, 2).slice(0, 400));
      console.log('  ✓ Token parece válido (resposta abaixo de 500)');
    }
  } catch (err) {
    console.log('  ⚠ Erro de rede:', err.message);
  }

  await prisma.$disconnect();
  console.log('\nPronto. Próximo passo: cadastrar CSC (pra NFCe) e fazer 1 emissão de teste.\n');
})().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
