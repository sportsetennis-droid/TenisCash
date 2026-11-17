// mkt.recebimento — detector (regra, custo zero)
// NF-e de ENTRADA classificada → mkt.chegada (mercadoria nova por loja,
// pro carrossel de chegada). Confere no banco que é entrada (transferência
// NUNCA é chegada) e acha a loja pelo CNPJ do destinatário. Só itens que já
// têm card (productId); item órfão não vira conteúdo.
const { reais } = require('../../regras/comercial');

// Tabela literal do CLAUDE.md (CNPJ destinatário → loja), usada se o banco não ligar o CNPJ à loja.
const LOJA_POR_CNPJ = { '44052617000126': 'LOJA01', '44052617000207': 'LOJA02', '44052617000398': 'LOJA03', '44052617000479': 'LOJA04', '44052617000550': 'LOJA05', '44052617000630': 'LOJA06' };
const so = (s) => String(s || '').replace(/\D/g, '');

module.exports = {
  id: 'mkt.recebimento',
  camada: 'detector',
  missao: 'Avisar o marketing de mercadoria nova que chegou numa loja por NF-e de entrada.',
  escuta: ['nfe.classificada'],
  emite: ['mkt.chegada'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['entrada-x-transferencia', 'dados-reais'],
  tempoMax: 20000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if ((d.docType && d.docType !== 'entrada') || d.entrada === false) return []; // na dúvida (classificação divergente), não é chegada
    const id = d.documentId || d.fiscalDocumentId || d.id || null;
    const doc = id
      ? await ler.xmlFiscalDocument.findUnique({ where: { id }, select: { id: true, docType: true, recipientCnpj: true, issuerName: true, number: true, accessKey: true } })
      : d.accessKey ? await ler.xmlFiscalDocument.findUnique({ where: { accessKey: d.accessKey }, select: { id: true, docType: true, recipientCnpj: true, issuerName: true, number: true, accessKey: true } }) : null;
    if (!doc) return [{ tipo: 'dado-faltante', dados: { motivo: 'NF-e não encontrada no banco', documentId: id, accessKey: d.accessKey || null } }];
    if (doc.docType !== 'entrada') return []; // transferência/saída nunca é chegada
    const cnpj = so(doc.recipientCnpj);
    let loja = null;
    const emissor = cnpj ? await ler.fiscalIssuer.findFirst({ where: { cnpj }, select: { id: true } }) : null;
    if (emissor) { const s = await ler.store.findFirst({ where: { fiscalIssuerId: emissor.id }, select: { code: true } }); loja = s && s.code; }
    if (!loja) loja = LOJA_POR_CNPJ[cnpj] || null;
    const itens = await ler.xmlFiscalItem.findMany({ where: { fiscalDocumentId: doc.id, productId: { not: null } }, select: { productId: true, quantity: true } });
    if (!itens.length) return [];
    const qtd = {};
    for (const i of itens) qtd[i.productId] = (qtd[i.productId] || 0) + Number(i.quantity || 0);
    const prods = await ler.product.findMany({ where: { id: { in: Object.keys(qtd) }, active: true }, select: { id: true, name: true, brand: true, price: true, imageUrl: true } });
    if (!prods.length) return [];
    const produtos = prods.map((p) => ({ productId: p.id, nome: p.name, marca: p.brand, pecas: qtd[p.id], preco: p.price, temFoto: !!p.imageUrl })).sort((a, b) => b.pecas - a.pecas);
    const pecas = produtos.reduce((s, p) => s + p.pecas, 0);
    return [{
      tipo: 'mkt.chegada',
      forca: 0.7,
      loja,
      impactoRS: Math.round(produtos.reduce((s, p) => s + p.pecas * (p.preco || 0), 0)),
      dados: {
        loja, documentId: doc.id, fornecedor: doc.issuerName, nfe: doc.number,
        produtos: produtos.slice(0, 40), totalPecas: pecas,
        chave: `chegada-${doc.id}`,
        evidencia: [
          `NF-e ${doc.number || doc.accessKey || doc.id} de ${doc.issuerName || 'fornecedor'} — docType=entrada (XmlFiscalDocument)`,
          `Destinatário CNPJ ${cnpj || '?'} → ${loja || 'loja não identificada'}`,
          `${produtos.length} card(s), ${pecas} peça(s) (XmlFiscalItem.quantity); valor de venda ${reais(produtos.reduce((s, p) => s + p.pecas * (p.preco || 0), 0))}`,
        ],
      },
    }];
  },
};
