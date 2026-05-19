// Emite 1 NFCe de teste em homologação contra a Brasil NFe.
// SEFAZ exige descrição do produto começar com "NOTA FISCAL EMITIDA EM
// AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL" pra notas de teste.
//
// Uso: node scripts/fiscal-test-nfce.js [--cnpj 44052617000126]

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fiscal = require('../src/services/fiscalApi');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1]]);
  return acc;
}, []));
const cnpj = (args.cnpj || '44052617000126').replace(/\D/g, '');

(async () => {
  const issuer = await prisma.fiscalIssuer.findUnique({ where: { cnpj } });
  if (!issuer) { console.error('Issuer não encontrado'); process.exit(1); }
  if (!issuer.apiToken) { console.error('Sem apiToken'); process.exit(1); }
  if (issuer.environment !== 'homologation') {
    console.error('⚠ AMBIENTE NÃO É HOMOLOGAÇÃO — abortando por segurança');
    process.exit(1);
  }

  console.log('\n=== Teste NFCe em homologação ===');
  console.log('Emitente:', issuer.companyName, '(' + issuer.cnpj + ')');
  console.log('Ambiente:', issuer.environment, '(TipoAmbiente=' + fiscal.tipoAmbiente(issuer.environment) + ')');
  console.log('Próximo número NFCe:', issuer.nfceNextNumber, '/ série', issuer.nfceSerie, '\n');

  // Busca 1 produto ATIVO do catálogo com NCM cadastrado pra teste real
  const produtoReal = await prisma.product.findFirst({
    where: { active: true, ncm: { not: null }, price: { gt: 0 } },
    select: { id: true, sku: true, name: true, ncm: true, cfop: true, price: true, unidade: true },
  });
  if (!produtoReal) {
    console.error('Nenhum produto ativo com NCM cadastrado. Rode primeiro: node scripts/classify-ncm-products.js');
    process.exit(1);
  }
  console.log('Produto de teste:', produtoReal.name, '(SKU ' + produtoReal.sku + ')');
  console.log('  NCM:', produtoReal.ncm, '| CFOP:', produtoReal.cfop, '| Preço: R$', produtoReal.price);

  // Payload conforme doc oficial Brasil NFe pra NFCe
  const payload = {
    TipoAmbiente: fiscal.tipoAmbiente(issuer.environment),
    ModeloDocumento: 65,
    NaturezaOperacao: 'Venda ao Consumidor',
    Finalidade: 1,
    ConsumidorFinal: true,
    IndicadorPresenca: 1,
    Produtos: [{
      NmProduto: produtoReal.name.slice(0, 120),
      NCM: produtoReal.ncm,
      CFOP: parseInt(produtoReal.cfop || '5102', 10),
      Quantidade: 1,
      ValorUnitario: produtoReal.price,
      ValorTotal: produtoReal.price,
    }],
    Pagamentos: [{ TipoPagamento: 1, Valor: produtoReal.price }],
  };

  console.log('Enviando pra Brasil NFe...\n');
  const resp = await fiscal.enviarNotaFiscal(issuer, payload);

  console.log('HTTP Status:', resp.status);
  console.log('Resposta:\n', JSON.stringify(resp.data, null, 2).slice(0, 2500));

  // Brasil NFe usa ReturnNF.Ok como verdadeiro indicador de sucesso
  const returnNF = resp.data?.ReturnNF;
  const authorized = !!returnNF?.Ok;
  const errorMsg = resp.data?.Error || returnNF?.DsStatusRespostaSefaz || 'Erro desconhecido';

  if (authorized) {
    console.log('\n✓ AUTORIZADA pela SEFAZ');
    console.log('  Número:', returnNF.Numero);
    console.log('  Série:', returnNF.Serie);
    console.log('  Chave:', returnNF.ChaveNF);
    console.log('  Status SEFAZ:', returnNF.CodStatusRespostaSefaz, '-', returnNF.DsStatusRespostaSefaz);
    console.log('  Valor NF:', returnNF.Detalhes?.valorNf);

    await prisma.fiscalIssuer.update({
      where: { id: issuer.id },
      data: { nfceNextNumber: (returnNF.Numero || issuer.nfceNextNumber) + 1 },
    });
  } else {
    console.log('\n❌ REJEITADA:', errorMsg);
  }

  // Pra debug evita duplicate constraint quando rejected várias vezes seguidas:
  // usa next available number procurando o que ainda não existe pra esse issuer/docType
  let nextN = returnNF?.Numero || issuer.nfceNextNumber || 1;
  while (await prisma.fiscalDocument.findFirst({
    where: { issuerId: issuer.id, docType: 'NFCE', serie: issuer.nfceSerie || 1, number: nextN },
  })) { nextN++; }

  await prisma.fiscalDocument.create({
    data: {
      issuerId: issuer.id,
      docType: 'NFCE',
      serie: returnNF?.Serie || issuer.nfceSerie || 1,
      number: nextN,
      status: authorized ? 'authorized' : 'rejected',
      rejectReason: authorized ? null : String(errorMsg).slice(0, 500),
      accessKey: returnNF?.ChaveNF || null,
      protocol: returnNF?.CodStatusRespostaSefaz ? String(returnNF.CodStatusRespostaSefaz) : null,
      totalValue: 1.00,
      productIds: [],
      payload,
      response: resp.data,
    },
  });

  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
