// NF-e: depois de uma ENTRADA, recalcula (só para informar) o custo médio
// ponderado dos cards que ela tocou: Σ vProd / Σ qCom das NF-e de ENTRADA dos
// códigos do card. Transferência e "SEM GTIN" ficam de fora. Não grava nada.
const c = require('../_comum-estoque');

const r2 = (x) => Math.round(x * 100) / 100;

module.exports = {
  id: 'nfe.custo-medio',
  camada: 'detector',
  missao: 'Informar o novo custo médio ponderado dos cards tocados por uma NF-e de entrada.',
  escuta: ['nfe.classificada'],
  emite: ['preco.custo-atualizado'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['transferencia-nao-e-compra', 'sem-gtin'],
  tempoMax: 30000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (!d.entrada || d.docType !== 'entrada') return [];
    const itensNota = await ler.xmlFiscalItem.findMany({ where: { fiscalDocumentId: d.documentId }, select: { ean: true, cfop: true, quantity: true } });
    const eans = [...new Set(itensNota.filter((i) => !c.cfopTransf(i.cfop)).map(c.eanDoItem).filter(Boolean))];
    if (!eans.length) return [];
    const sizes = await ler.productSize.findMany({ where: { barcode: { in: eans.flatMap(c.variantes) } }, select: { productId: true } });
    const pids = [...new Set(sizes.map((s) => s.productId))];
    const out = [];
    for (const pid of pids) {
      const p = await ler.product.findUnique({ where: { id: pid }, select: { id: true, sku: true, name: true, costPrice: true, sizes: { select: { barcode: true } } } });
      if (!p) continue;
      const vs = [...new Set(p.sizes.map((s) => s.barcode).filter((b) => !c.semGtin(b)).flatMap(c.variantes))];
      if (!vs.length) continue;
      // entrada gravada ou (ainda sem docType) classificada como entrada pela mesma regra
      const itens = await ler.xmlFiscalItem.findMany({
        where: { ean: { in: vs }, fiscalDocument: c.WHERE_DOC_ENTRADA },
        select: { quantity: true, totalValue: true, unitValue: true, cfop: true, fiscalDocumentId: true, fiscalDocument: { select: c.SEL_DOC } },
      });
      const validos = itens.filter((i) => !c.cfopTransf(i.cfop) && Number(i.quantity) > 0 && c.docEhEntrada(i.fiscalDocument, [i]));
      const qtd = validos.reduce((s, i) => s + Number(i.quantity), 0);
      if (!qtd) continue;
      const valor = validos.reduce((s, i) => s + (Number(i.totalValue) || Number(i.unitValue) * Number(i.quantity) || 0), 0);
      const custoNovo = r2(valor / qtd);
      const custoAnterior = p.costPrice != null ? r2(p.costPrice) : null;
      if (custoAnterior != null && Math.abs(custoNovo - custoAnterior) < 0.01) continue;
      const qtdNota = validos.filter((i) => i.fiscalDocumentId === d.documentId).reduce((s, i) => s + Number(i.quantity), 0);
      out.push({
        tipo: 'preco.custo-atualizado', forca: 0.9,
        impactoRS: custoAnterior != null ? r2(Math.abs(custoNovo - custoAnterior) * (qtdNota || 1)) : null,
        dados: {
          chave: 'custo|' + pid, productId: pid, sku: p.sku, nome: p.name, custoAnterior, custoNovo,
          base: { quantidade: qtd, valor: r2(valor), linhas: validos.length, regra: 'Σ vProd / Σ qCom das NF-e de entrada (sem transferência, sem SEM GTIN)' },
          documentId: d.documentId, accessKey: d.accessKey, gravado: false,
        },
      });
    }
    return out;
  },
};
