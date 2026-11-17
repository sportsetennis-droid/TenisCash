// fin.margem-bridge — analista (IA barata)
// Toda semana: por que a margem bruta mudou (últimos 7 dias × 7 anteriores).
// Os números são calculados por regra (SaleItem.totalPrice × unitCost) e a
// ponte é decomposta em efeito MIX (mudou o que vendeu) e efeito TAXA (mudou
// a margem dentro da marca). A IA só escreve a explicação a partir deles.
const { fortaleza, DIA, reais, pct, VENDA_INVALIDA } = require('../../regras/comercial');

const SCHEMA = { type: 'object', properties: { explicacao: { type: 'string' }, atencao: { type: 'array', items: { type: 'string' } } }, required: ['explicacao'] };

async function periodo(ler, de, ate) {
  const itens = await ler.saleItem.findMany({
    where: { sale: { createdAt: { gte: de, lt: ate }, status: { notIn: VENDA_INVALIDA } } },
    select: { brand: true, quantity: true, totalPrice: true, unitCost: true }, take: 50000,
  });
  const desc = await ler.sale.aggregate({ _sum: { discount: true, totalAmount: true }, where: { createdAt: { gte: de, lt: ate }, status: { notIn: VENDA_INVALIDA } } });
  const marcas = {};
  let receita = 0, receitaComCusto = 0, custo = 0;
  for (const i of itens) {
    const rec = Number(i.totalPrice || 0);
    receita += rec;
    if (i.unitCost == null) continue; // venda antiga sem custo: fica fora da margem (e dito na evidência)
    const c = Number(i.unitCost) * Number(i.quantity || 0);
    receitaComCusto += rec; custo += c;
    const k = i.brand || '—';
    marcas[k] = marcas[k] || { receita: 0, custo: 0 };
    marcas[k].receita += rec; marcas[k].custo += c;
  }
  return { receita, receitaComCusto, custo, margem: receitaComCusto > 0 ? (receitaComCusto - custo) / receitaComCusto : null, cobertura: receita > 0 ? receitaComCusto / receita : 0, desconto: Number((desc._sum && desc._sum.discount) || 0), marcas, itens: itens.length };
}

module.exports = {
  id: 'fin.margem-bridge',
  camada: 'analista',
  missao: 'Explicar ao dono por que a margem bruta mudou na semana, com números reais.',
  escuta: ['relogio.semanal'],
  emite: ['dono.relatorio'],
  limiar: 0,
  custo: { tipo: 'ia-barata' },
  permissao: 'ler',
  regras: ['dados-reais', 'timezone-fortaleza'],
  tempoMax: 45000,
  async disparar({ sinal, ler, pensar, agora }) {
    const f = fortaleza((sinal.dados && sinal.dados.quando) || agora);
    const fim = f.inicio; // semanas fechadas (até ontem)
    const atual = await periodo(ler, new Date(fim - 7 * DIA), fim);
    const anterior = await periodo(ler, new Date(fim - 14 * DIA), new Date(fim - 7 * DIA));
    if (atual.margem == null || anterior.margem == null) {
      return [{ tipo: 'dado-faltante', dados: { motivo: 'sem venda com custo (SaleItem.unitCost) em uma das semanas', atual: atual.itens, anterior: anterior.itens } }];
    }
    // ponte: Δmargem = Σ (share1−share0)·m0 [mix] + Σ share1·(m1−m0) [taxa]
    const todas = new Set([...Object.keys(atual.marcas), ...Object.keys(anterior.marcas)]);
    let mix = 0, taxa = 0;
    const porMarca = [];
    for (const k of todas) {
      const a = atual.marcas[k] || { receita: 0, custo: 0 };
      const b = anterior.marcas[k] || { receita: 0, custo: 0 };
      const s1 = a.receita / atual.receitaComCusto, s0 = b.receita / anterior.receitaComCusto;
      const m1 = a.receita ? (a.receita - a.custo) / a.receita : null;
      const m0 = b.receita ? (b.receita - b.custo) / b.receita : null;
      const eMix = (s1 - s0) * (m0 != null ? m0 : anterior.margem);
      const eTaxa = m1 != null && m0 != null ? s1 * (m1 - m0) : m1 != null ? s1 * (m1 - anterior.margem) : 0; // marca nova: base = margem média anterior
      mix += eMix; taxa += eTaxa;
      porMarca.push({ marca: k, receitaAtual: Math.round(a.receita), receitaAnterior: Math.round(b.receita), margemAtual: m1, margemAnterior: m0, efeitoMix: eMix, efeitoTaxa: eTaxa });
    }
    porMarca.sort((x, y) => Math.abs(y.efeitoMix + y.efeitoTaxa) - Math.abs(x.efeitoMix + x.efeitoTaxa));
    const delta = atual.margem - anterior.margem;
    const numeros = {
      semanaAtual: { de: fortaleza(fim - 7 * DIA).ymd, ate: fortaleza(fim - 1).ymd, receita: Math.round(atual.receita), margem: atual.margem, coberturaCusto: atual.cobertura, desconto: Math.round(atual.desconto) },
      semanaAnterior: { de: fortaleza(fim - 14 * DIA).ymd, ate: fortaleza(fim - 7 * DIA - 1).ymd, receita: Math.round(anterior.receita), margem: anterior.margem, coberturaCusto: anterior.cobertura, desconto: Math.round(anterior.desconto) },
      variacaoMargemPP: delta * 100,
      ponte: { mixPP: mix * 100, taxaPP: taxa * 100 },
      maioresEfeitos: porMarca.slice(0, 5),
    };
    const r = await pensar({
      instrucao: 'Explique em até 5 frases, para o dono, por que a margem bruta mudou, usando SÓ os números da entrada (efeito mix = mudou o que vendeu; efeito taxa = mudou a margem dentro da marca; desconto em R$). Cite as marcas que mais pesaram. Não invente causa que não esteja nos números. Liste em "atencao" o que merece olho (ex.: cobertura de custo baixa).',
      entrada: numeros,
      schema: SCHEMA,
    });
    const fallback = `Margem bruta ${pct(anterior.margem)} → ${pct(atual.margem)} (${(delta * 100).toFixed(1).replace('.', ',')} p.p.): efeito mix ${(mix * 100).toFixed(1).replace('.', ',')} p.p., efeito taxa ${(taxa * 100).toFixed(1).replace('.', ',')} p.p. Maior peso: ${porMarca[0] ? porMarca[0].marca : '—'}.`;
    return [{
      tipo: 'dono.relatorio',
      forca: Math.min(1, 0.6 + Math.abs(delta) * 5),
      impactoRS: Math.round(Math.abs(delta) * atual.receitaComCusto),
      dados: {
        assunto: 'margem-bridge',
        titulo: `Margem da semana: ${pct(anterior.margem)} → ${pct(atual.margem)}`,
        texto: (r.ok && r.json && r.json.explicacao) || fallback,
        atencao: (r.ok && r.json && r.json.atencao) || [],
        numeros,
        chave: `margem-${f.ymd}`,
        evidencia: [
          `SaleItem de ${numeros.semanaAnterior.de} a ${numeros.semanaAtual.ate} (vendas válidas): ${atual.itens} + ${anterior.itens} itens`,
          `Cobertura de custo (itens com unitCost): ${pct(atual.cobertura)} / ${pct(anterior.cobertura)} da receita — o resto fica fora da margem`,
          `Receita ${reais(anterior.receita)} → ${reais(atual.receita)}; desconto ${reais(anterior.desconto)} → ${reais(atual.desconto)}`,
        ],
      },
    }];
  },
};
