// rede.erros — detector (regra, custo zero)
// A cada hora procura neurônio com 3+ ativações em ERRO na última hora
// (RnaAtivacao.status='erro') e levanta pendência pro dono com o último
// erro de cada um. 1 pendência por neurônio por hora.

const OFFSET_MS = 3 * 3600 * 1000;
const HORA = 3600 * 1000;
const MIN_ERROS = 3;

module.exports = {
  id: 'rede.erros',
  camada: 'detector',
  missao: 'Avisar o dono quando um neurônio falhar 3 ou mais vezes na última hora.',
  escuta: ['relogio.hora'],
  emite: ['dono.pendencia'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['observabilidade'],
  tempoMax: 15000,
  async disparar({ ler, agora }) {
    const desde = new Date(agora.getTime() - HORA);
    const g = await ler.rnaAtivacao.groupBy({ by: ['neuronio'], where: { status: 'erro', criadoEm: { gte: desde } }, _count: { _all: true } });
    const quebrados = g.filter((x) => x._count._all >= MIN_ERROS).sort((a, b) => b._count._all - a._count._all).slice(0, 10);
    const horaKey = new Date(agora.getTime() - OFFSET_MS).toISOString().slice(0, 13); // AAAA-MM-DDTHH (Fortaleza)
    const saidas = [];
    for (const q of quebrados) {
      const ref = `erros:${q.neuronio}:${horaKey}`;
      const ja = await ler.rnaSinal.findFirst({ where: { tipo: 'dono.pendencia', dados: { path: ['ref'], equals: ref } } });
      if (ja) continue;
      const ult = await ler.rnaAtivacao.findFirst({ where: { neuronio: q.neuronio, status: 'erro' }, orderBy: { criadoEm: 'desc' }, select: { erro: true } });
      saidas.push({
        tipo: 'dono.pendencia', forca: 0.9,
        dados: {
          ref, chave: ref, origem: 'rede.erros', neuronio: q.neuronio, erros: q._count._all,
          titulo: `Neurônio ${q.neuronio} falhou ${q._count._all}x na última hora`,
          ultimoErro: ult && ult.erro ? String(ult.erro).slice(0, 300) : null,
          sugestao: 'Ver o erro no painel da rede; se persistir, desligar o neurônio no painel.',
          fonte: 'RnaAtivacao status=erro na última hora',
        },
      });
    }
    return saidas;
  },
};
