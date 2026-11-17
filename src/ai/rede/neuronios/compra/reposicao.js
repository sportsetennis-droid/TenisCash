// Compras: tamanho-chave zerado na loja E zerado na REDE inteira (nenhuma loja tem
// pra transferir) e com giro (vendeu ≥ N em 90 dias) → propõe REPOSIÇÃO com o
// histórico de venda e o fornecedor = EMISSOR da última NF-e de entrada (nunca o
// grupo). Quantidade sugerida = vendas de 90 dias do tamanho (regra, não chute).
// A IA barata só escreve a justificativa. Compra é decisão do dono.
const c = require('../_comum-estoque');

module.exports = {
  id: 'compra.reposicao',
  camada: 'analista',
  missao: 'Propor reposição de tamanho que vende e acabou na rede, com histórico e fornecedor real.',
  escuta: ['estoque.ruptura'],
  emite: ['proposta.reposicao', 'dado-faltante'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['fornecedor-e-o-emissor', 'transferencia-nao-e-compra', 'comprado-nunca-recalcula', 'nada-sem-aprovacao'],
  tempoMax: 45000,
  async disparar({ sinal, ler, agora, pensar }) {
    const d = sinal.dados || {};
    if (!d.productId || !Array.isArray(d.tamanhosFaltando)) return [];
    const minVendas = Number(process.env.RNA_REPOSICAO_MIN_VENDAS || 2);
    const p = await ler.product.findUnique({ where: { id: d.productId }, select: { id: true, sku: true, name: true, brand: true, price: true, costPrice: true, sizes: { select: { id: true, size: true, barcode: true, stock: true } } } });
    if (!p) return [];
    const itens = [];
    for (const f of d.tamanhosFaltando) {
      if ((f.vendas90dRede || 0) < minVendas) continue;
      const rede = await ler.storeStock.aggregate({ _sum: { stock: true }, where: { productSizeId: f.sizeId } });
      if (((rede._sum && rede._sum.stock) || 0) > 0) continue; // tem na rede: é caso de transferência
      const ps = p.sizes.find((s) => s.id === f.sizeId);
      itens.push({ sizeId: f.sizeId, tamanho: f.size, barcode: ps && !c.semGtin(ps.barcode) ? ps.barcode : null, vendas90d: f.vendas90dRede, comprado: ps ? ps.stock : null, sugerido: f.vendas90dRede });
    }
    if (!itens.length) return [];
    const forn = await c.fornecedorDoProduto(ler, p);
    if (!forn) return [c.dadoFaltante('repo|' + p.id + '|fornecedor', 'fornecedor', 'nenhuma NF-e de ENTRADA de fornecedor para este card (transferência não conta)', { productId: p.id })];
    const unid = itens.reduce((s, i) => s + i.sugerido, 0);
    let just = null;
    if (pensar) {
      const r = await pensar({
        instrucao: 'Escreva 1 a 2 frases (máx. 40 palavras) justificando ao dono a reposição. Use só os números dados; não invente prazo, preço ou tendência.',
        entrada: { produto: p.name, loja: d.loja, itens: itens.map((i) => ({ tamanho: i.tamanho, vendas90d: i.vendas90d, sugerido: i.sugerido })), fornecedor: forn.nome },
        schema: { type: 'object', properties: { justificativa: { type: 'string' } }, required: ['justificativa'] },
      }).catch(() => null);
      if (r && r.ok && r.json && r.json.justificativa) just = String(r.json.justificativa).slice(0, 400);
    }
    const fatos = itens.map((i) => `tam ${i.tamanho}: vendeu ${i.vendas90d} em 90d, zerado em todas as lojas`).join('; ');
    return [{
      tipo: 'proposta.reposicao', forca: 0.7, loja: d.loja || null,
      impactoRS: p.price ? Math.round(unid * p.price) : null,
      dados: {
        chave: 'repo|' + p.id + '|' + itens.map((i) => i.sizeId).sort().join(','),
        titulo: `Repor ${p.sku} (${itens.map((i) => i.tamanho).join(', ')}) — ${unid} un — ${forn.nome || forn.cnpj}`,
        descricao: (just || fatos) + ' Sugestão = vendas de 90 dias de cada tamanho. Compra só com o seu sim.',
        risco: 'medio',
        evidencia: [fatos, `fornecedor = emissor da NF-e de entrada ${forn.ultimaNfe} (CNPJ ${forn.cnpj})`, `origem: ${d.chave || 'estoque.ruptura'}`],
        previa: { productId: p.id, sku: p.sku, fornecedor: forn, itens, custoUnitario: p.costPrice || null, totalCustoEstimado: p.costPrice ? Math.round(unid * p.costPrice * 100) / 100 : null },
        acao: { nome: 'rna.registrar', args: {} },
      },
    }];
  },
};
