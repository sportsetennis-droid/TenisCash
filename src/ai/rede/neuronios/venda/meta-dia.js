// venda.meta-dia — detector (regra, custo zero)
// No pulso das 15h (Fortaleza), compara o vendido do dia com a meta de cada
// loja. Abaixo de 60% → venda.abaixo-meta. Meta: Config `meta.venda.<LOJA>`
// (valor diário em R$); sem meta cadastrada, usa a MÉDIA dos mesmos dias da
// semana nas 4 semanas anteriores e diz isso na evidência. Sem histórico → nada.
const { fortaleza, DIA, NOMES_DIA, reais, pct, VENDA_INVALIDA } = require('../../regras/comercial');

const HORA_CHECK = () => Number(process.env.RNA_META_HORA || 15);
const LIMITE = 0.6;

async function vendido(ler, storeId, de, ate) {
  const r = await ler.sale.aggregate({
    _sum: { totalAmount: true }, _count: { _all: true },
    where: { storeId, createdAt: { gte: de, lt: ate }, status: { notIn: VENDA_INVALIDA } },
  });
  return { total: Number((r._sum && r._sum.totalAmount) || 0), vendas: (r._count && r._count._all) || 0 };
}

async function metaDaLoja(ler, loja, f) {
  const cfg = await ler.config.findFirst({ where: { key: { in: [`meta.venda.${loja.code}.${f.ymd}`, `meta.venda.${loja.code}`] } }, orderBy: { key: 'desc' } });
  const v = cfg ? Number(String(cfg.value).replace(',', '.')) : NaN;
  if (cfg && v > 0) return { meta: v, fonte: `meta cadastrada (Config ${cfg.key})` };
  const dias = [];
  for (let w = 1; w <= 4; w++) {
    const ini = new Date(f.inicio.getTime() - w * 7 * DIA);
    const r = await vendido(ler, loja.id, ini, new Date(ini.getTime() + DIA));
    dias.push({ data: fortaleza(ini).ymd, total: r.total });
  }
  const comVenda = dias.filter((d) => d.total > 0);
  if (!comVenda.length) return null;
  const media = comVenda.reduce((s, d) => s + d.total, 0) / comVenda.length;
  return { meta: media, fonte: `sem meta cadastrada: média das ${comVenda.length} ${NOMES_DIA[f.diaSemana]}s anteriores (${dias.map((d) => d.data + ' ' + reais(d.total)).join('; ')})` };
}

module.exports = {
  id: 'venda.meta-dia',
  camada: 'detector',
  missao: 'Avisar quando uma loja vendeu menos de 60% da meta do dia até as 15h.',
  escuta: ['relogio.hora'],
  emite: ['venda.abaixo-meta'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['timezone-fortaleza', 'dados-reais'],
  tempoMax: 20000,
  async disparar({ sinal, ler, agora }) {
    const f = fortaleza((sinal.dados && sinal.dados.quando) || agora);
    if (f.hora !== HORA_CHECK()) return [];
    const lojas = await ler.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true } });
    const saidas = [];
    for (const loja of lojas) {
      const m = await metaDaLoja(ler, loja, f);
      if (!m) continue;
      const v = await vendido(ler, loja.id, f.inicio, f.agora);
      const p = m.meta > 0 ? v.total / m.meta : 1;
      if (p >= LIMITE) continue;
      saidas.push({
        tipo: 'venda.abaixo-meta',
        forca: Math.min(1, 0.6 + (LIMITE - p)),
        impactoRS: Math.round(m.meta - v.total),
        loja: loja.code,
        dados: {
          loja: loja.code, lojaNome: loja.name, data: f.ymd, hora: f.hora,
          vendido: Math.round(v.total * 100) / 100, vendas: v.vendas,
          meta: Math.round(m.meta * 100) / 100, pct: Math.round(p * 1000) / 1000,
          chave: `abaixo-meta-${loja.code}-${f.ymd}`,
          evidencia: [
            `Vendas ${loja.code} em ${f.ymd} até ${f.hora}h (Fortaleza): ${reais(v.total)} em ${v.vendas} venda(s) — tabela Sale`,
            `Meta do dia ${reais(m.meta)} — ${m.fonte}`,
            `Atingido ${pct(p)} < 60%`,
          ],
        },
      });
    }
    return saidas;
  },
};
