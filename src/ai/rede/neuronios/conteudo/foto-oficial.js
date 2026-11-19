// =====================================================================
// conteudo.foto-oficial — ANALISTA (ia-barata; aqui resolve por regra)
// Missão única: dizer EXATAMENTE qual busca fazer pra achar a foto oficial
// de um card publicado sem foto: marca + referência/código exato + cor.
// Não baixa nada, não escolhe foto. Sem COR não propõe (regra: foto é por
// card = ref + cor; sem cor entra foto do colorway errado) → dado-faltante.
// Evidência = ref/cor/códigos lidos do card.
// =====================================================================
const { contextOf } = require('../../../../services/nuvemshopEligibility');

const texto = (v) => (v == null ? '' : String(v).trim());
const codigoReal = (b) => /^\d{8,14}$/.test(texto(b));

module.exports = {
  id: 'conteudo.foto-oficial',
  camada: 'analista',
  missao: 'Montar a busca exata da foto oficial de um card sem foto (marca, referência exata e cor).',
  escuta: ['nuvem.incompleto', 'marca.cadastro-incompleto'],
  emite: ['proposta.foto'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'propor',
  regras: ['foto-precisa-da-cor', 'nunca-inventar-dado'],
  tempoMax: 20000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    if (!(d.falta || []).includes('foto') || !d.productId) return [];
    const p = await ler.product.findUnique({
      where: { id: d.productId },
      select: { id: true, sku: true, name: true, brand: true, aiContext: true, imageUrl: true, sizes: { select: { size: true, barcode: true } } },
    });
    if (!p) return [];
    const ctx = contextOf(p);
    const marca = texto(p.brand);
    const ref = texto(ctx.supplierRef) || texto(p.sku);
    const cor = texto(ctx.color);
    const faltam = [];
    if (!marca) faltam.push('marca');
    if (!ref) faltam.push('referencia');
    if (!cor) faltam.push('cor');
    if (ctx.colorReview) faltam.push('cor (em revisão: colorReview)');
    if (faltam.length) {
      return [{ tipo: 'dado-faltante', dados: { chave: 'foto:' + p.id, productId: p.id, campos: faltam, motivo: 'sem marca/referência/cor confirmadas não há busca exata de foto (risco de colorway errado)' } }];
    }
    const eans = [...new Set(p.sizes.map((s) => texto(s.barcode)).filter(codigoReal))].slice(0, 5);
    const busca = `"${marca}" "${ref}" ${cor}`;
    return [{
      tipo: 'proposta.foto',
      dados: {
        chave: 'foto:' + p.id,
        titulo: 'Buscar foto oficial: ' + marca + ' ' + ref + ' (' + cor + ')',
        descricao: (sinal.tipo === 'marca.cadastro-incompleto' ? 'Card com estoque nas lojas do site, fora da Nuvemshop por falta de foto (pedido do gerente da marca).' : 'Card publicado sem foto.') + ' Buscar a foto OFICIAL pelo código exato e conferir a cor olhando a imagem antes de gravar. '
          + 'Não usar foto de revendedor que mostre outra cor; sem foto certa, melhor ficar sem foto.',
        risco: 'baixo',
        acao: { nome: 'rna.registrar', args: {} },
        previa: { productId: p.id, nome: p.name, busca, buscaAlternativa: eans.length ? `"${marca}" ${eans[0]}` : null, conferir: ['mesma referência', 'mesma cor: ' + cor, 'foto oficial da marca'] },
        evidencia: ['marca = ' + marca + ' (Product.brand)', 'referência = ' + ref + (texto(ctx.supplierRef) ? ' (aiContext.supplierRef)' : ' (Product.sku)'), 'cor = ' + cor + ' (aiContext.color)']
          .concat(eans.length ? ['códigos de barras do card: ' + eans.join(', ')] : []),
      },
    }];
  },
};
