// seg.custo-dia — detector (regra, custo zero)
// A cada hora soma o gasto de IA do dia (RnaAtivacao.custoRS desde 00:00
// Fortaleza) e avisa o dono ao passar de 80% do teto diário
// (RNA_ORCAMENTO_DIA_RS, padrão R$ 5 — o mesmo que o motor usa pra cortar).
// 1 aviso por faixa (80% e 100%) por dia.

const OFFSET_MS = 3 * 3600 * 1000;
const reais = (v) => 'R$ ' + (Math.round(Number(v || 0) * 100) / 100).toFixed(2).replace('.', ',');

function fortaleza(d) {
  const l = new Date(new Date(d).getTime() - OFFSET_MS);
  return { ymd: l.toISOString().slice(0, 10), inicio: new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), 3, 0, 0)) };
}

module.exports = {
  id: 'seg.custo-dia',
  camada: 'detector',
  missao: 'Avisar o dono quando o gasto de IA do dia passar de 80% do teto diário.',
  escuta: ['relogio.hora'],
  emite: ['dono.pendencia'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['orcamento-ia', 'timezone-fortaleza'],
  tempoMax: 15000,
  async disparar({ ler, agora }) {
    const teto = Number(process.env.RNA_ORCAMENTO_DIA_RS || 5);
    if (!(teto > 0)) return [];
    const f = fortaleza(agora);
    const r = await ler.rnaAtivacao.aggregate({ _sum: { custoRS: true }, where: { criadoEm: { gte: f.inicio } } });
    const gasto = Number((r._sum && r._sum.custoRS) || 0);
    const frac = gasto / teto;
    if (frac < 0.8) return [];
    const faixa = frac >= 1 ? 100 : 80;
    const ref = `custo-dia:${faixa}:${f.ymd}`;
    const ja = await ler.rnaSinal.findFirst({ where: { tipo: 'dono.pendencia', dados: { path: ['ref'], equals: ref } } });
    if (ja) return [];
    return [{
      tipo: 'dono.pendencia', forca: faixa === 100 ? 1 : 0.8,
      dados: {
        ref, chave: ref, origem: 'seg.custo-dia', dia: f.ymd, gastoRS: Math.round(gasto * 10000) / 10000, tetoRS: teto, pct: Math.round(frac * 1000) / 10,
        titulo: faixa === 100
          ? `Teto diário de IA atingido: ${reais(gasto)} de ${reais(teto)} — a rede parou de chamar IA hoje`
          : `Gasto de IA em ${Math.round(frac * 100)}% do teto do dia: ${reais(gasto)} de ${reais(teto)}`,
        fonte: `RnaAtivacao.custoRS desde ${f.ymd} 00:00 (Fortaleza); teto RNA_ORCAMENTO_DIA_RS`,
      },
    }];
  },
};
