// =====================================================================
// preco.abaixo-custo — DETECTOR (regra, custo zero)
// Missão única: achar produto ATIVO com preço de venda zerado ou ≤ custo
// (markup não aplicado). Regra da casa: loja só recebe preço de venda com
// markup, nunca o custo. NÃO muda preço (preço/markup só com ordem do dono):
// propõe REVISÃO, mostrando o preço de referência custo × (1 + markup) quando
// o markup existe no card ou no fornecedor (sem markup → não calcula nada).
// =====================================================================
const MAX = () => Math.max(1, Number(process.env.RNA_PRECO_MAX_POR_PULSO || 100));
const reais = (v) => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');

function ctxDe(p) { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) { return {}; } }

module.exports = {
  id: 'preco.abaixo-custo',
  camada: 'detector',
  missao: 'Achar produto ativo com preço de venda zerado ou menor/igual ao custo.',
  escuta: ['preco.custo-atualizado', 'relogio.diario'],
  emite: ['proposta.preco-revisar'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['preco-com-markup', 'preco-so-com-ordem-do-dono'],
  tempoMax: 60000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    const ids = [].concat(d.productId || [], Array.isArray(d.productIds) ? d.productIds : []).map(String);
    if (sinal.tipo === 'preco.custo-atualizado' && !ids.length) return [];
    const select = { id: true, sku: true, name: true, brand: true, price: true, costPrice: true, markupPercent: true, aiContext: true };
    let produtos;
    if (ids.length) {
      produtos = await ler.product.findMany({ where: { id: { in: ids.slice(0, 2000) }, active: true }, select });
    } else {
      const linhas = await ler.$queryRawUnsafe(
        'SELECT id FROM "Product" WHERE active = true AND (price IS NULL OR price <= 0 OR ("costPrice" > 0 AND price <= "costPrice")) ORDER BY id LIMIT ' + MAX(),
      );
      produtos = linhas.length ? await ler.product.findMany({ where: { id: { in: linhas.map((l) => l.id) } }, select }) : [];
    }
    const alvo = produtos.filter((p) => !(Number(p.price) > 0) || (Number(p.costPrice) > 0 && Number(p.price) <= Number(p.costPrice)));
    if (!alvo.length) return [];

    // markup do fornecedor (supplier.averageMarkup) pelo CNPJ gravado no card
    const cnpjs = [...new Set(alvo.map((p) => String(ctxDe(p).supplierCnpj || '').replace(/\D/g, '')).filter((c) => c.length === 14 && !c.startsWith('44052617')))];
    const fornecedores = cnpjs.length ? await ler.supplier.findMany({ where: { cnpj: { in: cnpjs } }, select: { cnpj: true, companyName: true, averageMarkup: true } }) : [];
    const fDe = new Map(fornecedores.map((f) => [String(f.cnpj).replace(/\D/g, ''), f]));

    return alvo.slice(0, MAX()).map((p) => {
      const price = Number(p.price || 0); const cost = Number(p.costPrice || 0);
      const forn = fDe.get(String(ctxDe(p).supplierCnpj || '').replace(/\D/g, ''));
      const markup = p.markupPercent != null ? { valor: p.markupPercent, fonte: 'Product.markupPercent' }
        : forn && forn.averageMarkup != null ? { valor: forn.averageMarkup, fonte: 'Supplier.averageMarkup (' + forn.companyName + ')' } : null;
      const referencia = markup && cost > 0 ? Math.round(cost * (1 + markup.valor / 100) * 100) / 100 : null;
      const motivo = !(price > 0) ? 'preço de venda zerado' : price === cost ? 'preço igual ao custo (markup não aplicado)' : 'preço abaixo do custo';
      return {
        tipo: 'proposta.preco-revisar',
        impactoRS: cost > 0 ? Math.max(0, cost - price) : null,
        dados: {
          chave: 'preco-revisar:' + p.id + ':' + price + ':' + cost,
          titulo: 'Revisar preço: ' + [p.brand, p.name].filter(Boolean).join(' ').slice(0, 140) + ' (' + motivo + ')',
          descricao: motivo + '. Preço atual ' + reais(price) + (cost > 0 ? ', custo ' + reais(cost) : ', sem custo gravado') + '. '
            + 'A rede NÃO muda preço: o dono define o preço de venda. Enquanto isso o card não pode ir pra loja online.'
            + (referencia ? ' Referência pelo markup (' + markup.valor + '%, ' + markup.fonte + '): ' + reais(referencia) + '.' : ' Sem markup gravado no card nem no fornecedor: referência não calculada.'),
          risco: 'medio',
          acao: { nome: 'rna.registrar', args: {} },
          previa: { productId: p.id, sku: p.sku, precoAtual: price, custo: cost || null, markup: markup || null, precoReferenciaMarkup: referencia, muda: 'nada automaticamente' },
          evidencia: ['Product.price = ' + price + ' (card ' + p.id + ')', 'Product.costPrice = ' + (p.costPrice == null ? 'vazio' : cost)].concat(markup ? [markup.fonte + ' = ' + markup.valor + '%'] : []),
        },
      };
    });
  },
};
