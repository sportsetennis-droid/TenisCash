// Bipe: Σ bipes do código na RODADA > COMPRADO daquele tamanho → pede CONFERÊNCIA
// FÍSICA na loja. Bipe repetido com Σ ≤ comprado é par real (não é erro).
// NUNCA propõe apagar bipe: quem decide é a contagem física / o dono.
// Bipe sem rodada (antigo) não vale e não conta. "SEM GTIN" nunca conta.
const c = require('../_comum-estoque');

module.exports = {
  id: 'bipe.acima-comprado',
  camada: 'detector',
  missao: 'Pedir conferência na loja quando o código foi bipado mais vezes que o comprado.',
  escuta: ['bipe.registrado'],
  emite: ['proposta.conferencia-loja'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['bipe-nao-se-apaga', 'so-bipe-novo-vale', 'comprado-nunca-recalcula', 'sem-gtin'],
  tempoMax: 15000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    const b = d.bipeId ? await ler.stocktakeBipe.findUnique({ where: { id: d.bipeId } }) : null;
    if (!b || b.excludedAt || !b.roundId || !b.productSizeId || c.semGtin(b.barcode)) return [];
    const ps = await ler.productSize.findUnique({ where: { id: b.productSizeId }, select: { id: true, size: true, stock: true, barcode: true, product: { select: { id: true, sku: true, name: true } } } });
    if (!ps) return [];
    const bipes = await ler.stocktakeBipe.findMany({
      where: { roundId: b.roundId, excludedAt: null, OR: [{ productSizeId: ps.id }, { barcode: { in: c.variantes(b.barcode) } }] },
      select: { id: true, bipedAt: true, sellerName: true, barcode: true }, orderBy: { bipedAt: 'asc' },
    });
    const bipados = bipes.filter((x) => !c.semGtin(x.barcode)).length;
    const comprado = Number(ps.stock) || 0; // COMPRADO = Σ qCom das NF-e de entrada (nunca recalculado aqui)
    if (bipados <= comprado) return [];
    const st = !d.storeCode && b.storeId ? await ler.store.findUnique({ where: { id: b.storeId }, select: { code: true } }) : null;
    const loja = d.storeCode || (st && st.code) || null;
    return [{
      tipo: 'proposta.conferencia-loja', forca: 0.9, loja,
      dados: {
        chave: `conf|${b.roundId}|${ps.id}`,
        titulo: `Conferir na loja${loja ? ' ' + loja : ''}: ${ps.product.sku} tam ${ps.size} — bipado ${bipados} > comprado ${comprado}`,
        descricao: `Na rodada atual o código ${b.barcode} foi bipado ${bipados} vez(es), mas o comprado (NF-e de entrada) é ${comprado}. ` +
          'Pode ser bipe a mais OU nota de entrada faltando. Contar fisicamente na loja. Nenhum bipe será apagado pela rede.',
        risco: 'baixo',
        evidencia: [
          `rodada ${b.roundId}: ${bipados} bipes válidos do código ${b.barcode} (${bipes.slice(-5).map((x) => x.id + '@' + new Date(x.bipedAt).toISOString()).join(', ')})`,
          `ProductSize ${ps.id} tam ${ps.size}: comprado (stock) = ${comprado}`,
        ],
        previa: { productId: ps.product.id, sizeId: ps.id, tamanho: ps.size, bipados, comprado, excedente: bipados - comprado, roundId: b.roundId },
        acao: { nome: 'rna.registrar', args: {} },
      },
    }];
  },
};
