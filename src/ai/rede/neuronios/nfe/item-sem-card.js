// NF-e: acha item de ENTRADA cujo código (EAN) não está em nenhum tamanho do catálogo.
// ANTES de chamar de órfão, procura card que JÁ existe (curado ou inativo):
//   1) EAN escrito no sku do card  2) sku = maior prefixo do cProd (sku-âncora)
//   3) outro item de entrada com o MESMO cProd já ligado a um card.
// Achou 1 card → propõe LIGAR o item a ele (nunca criar card novo).
// Transferência NUNCA passa daqui (não é compra e não cria card).
const c = require('../_comum-estoque');

const MAX_POR_NFE = 60;

module.exports = {
  id: 'nfe.item-sem-card',
  camada: 'detector',
  missao: 'Achar item de NF-e de entrada sem tamanho no catálogo, procurando antes o card que já existe.',
  escuta: ['nfe.classificada'],
  emite: ['nfe.item-orfao', 'proposta.ligar-card', 'dado-faltante'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['transferencia-nao-cria-card', 'buscar-card-antes-de-criar', 'ref-diferente-card-diferente', 'sem-gtin'],
  tempoMax: 30000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (!d.entrada || d.docType !== 'entrada') return []; // transferência/saída: nada aqui
    const doc = await ler.xmlFiscalDocument.findUnique({ where: { id: d.documentId }, include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    if (!doc) return [c.dadoFaltante('nfe|' + d.documentId, 'nfe', 'NF-e classificada não encontrada')];
    // agrupa por código: o mesmo EAN repetido na nota é 1 código só
    const grupos = new Map();
    doc.items.forEach((it, i) => {
      if (c.cfopTransf(it.cfop)) return; // linha de transferência dentro da nota: não é compra
      const ean = c.eanDoItem(it);
      const k = ean ? 'ean:' + c.identidade(ean) : 'cprod:' + String(it.supplierCode || it.id);
      if (!grupos.has(k)) grupos.set(k, { ean, itens: [], nItem: i + 1 });
      grupos.get(k).itens.push(it);
    });
    const out = [];
    let n = 0;
    for (const [k, g] of grupos) {
      const it = g.itens[0];
      if (g.ean) {
        if (await c.codigoConhecido(ler, g.ean)) continue;
      } else if (g.itens.every((x) => x.productId)) continue; // SEM GTIN já ligado por cProd
      if (++n > MAX_POR_NFE) { out.push({ tipo: 'nfe.item-orfao', forca: 0.5, dados: { chave: doc.id + '|excedente', documentId: doc.id, accessKey: doc.accessKey, excedente: true, nota: 'mais de ' + MAX_POR_NFE + ' códigos órfãos nesta NF-e; o restante fica para a conferência' } }); break; }
      const ligado = g.itens.find((x) => x.productId);
      let candidatos = [];
      if (ligado) {
        const p = await ler.product.findUnique({ where: { id: ligado.productId }, select: { id: true, sku: true, name: true, brand: true, active: true } });
        if (p) candidatos = [Object.assign(p, { como: 'item já ligado ao card (falta o tamanho)' })];
      } else {
        candidatos = await c.buscarCardExistente(ler, it, g.ean);
      }
      const card = candidatos.length === 1 ? candidatos[0] : null;
      const qtd = g.itens.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
      const dados = {
        chave: (doc.accessKey || doc.id) + '|' + k,
        documentId: doc.id, accessKey: doc.accessKey, issuerCnpj: c.soDigitos(doc.issuerCnpj), issuerName: doc.issuerName,
        itemIds: g.itens.map((x) => x.id), nItem: g.nItem, ean: g.ean, semGtin: !g.ean,
        cProd: it.supplierCode, xProd: it.description, quantidade: g.ean ? qtd : null,
        cardExistente: card, candidatos: candidatos.length > 1 ? candidatos : [],
        situacao: card ? (ligado ? 'card-sem-tamanho' : 'card-existe-sem-ligacao') : candidatos.length > 1 ? 'ambiguo' : 'sem-card',
      };
      out.push({ tipo: 'nfe.item-orfao', forca: card ? 0.8 : 0.9, dados });
      if (card && !ligado) {
        out.push({ tipo: 'proposta.ligar-card', forca: 0.8, dados: {
          chave: 'ligar|' + g.itens.map((x) => x.id).join(','),
          titulo: `Ligar item da NF-e ao card existente ${card.sku}${card.active ? '' : ' (INATIVO)'}`,
          descricao: `Item ${g.nItem} da NF-e ${doc.accessKey || doc.id} (cProd ${it.supplierCode || '-'}, "${it.description}") não tem card ligado. ` +
            `Achei o card ${card.sku} — ${card.name} (${card.como}). Proposta: só LIGAR o item ao card (não cria card, não mexe em estoque nem em tamanho).` +
            (card.active ? '' : ' O card está inativo: reativar é decisão sua.'),
          risco: 'baixo',
          evidencia: [`NF-e ${doc.accessKey || doc.id} item ${g.nItem}: cProd=${it.supplierCode || '-'} xProd="${it.description}" EAN=${g.ean || 'SEM GTIN'}`, `card ${card.id} sku=${card.sku} encontrado por: ${card.como}`],
          previa: { itemIds: dados.itemIds, productId: card.id, sku: card.sku, ativo: card.active },
          acao: { nome: 'estoque.ligar-item-nfe', args: { itemIds: dados.itemIds, productId: card.id } },
        } });
      }
    }
    return out;
  },
};
