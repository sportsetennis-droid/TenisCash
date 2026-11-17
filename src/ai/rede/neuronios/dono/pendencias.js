// dono.pendencias — detector (regra, custo zero)
// Junta as pendências que a rede levantou (sinais `dono.pendencia`) num
// RESUMO só, 1 por dia (chave = data em America/Fortaleza), no pulso diário.
// A pendência avulsa não gera resumo na hora (fica registrada em RnaSinal e
// entra no resumo seguinte). Janela = desde o último resumo (máx. 7 dias;
// sem resumo anterior, últimas 24h).

const OFFSET_MS = 3 * 3600 * 1000;
const DIA = 24 * 3600 * 1000;
const diaFortaleza = (d) => new Date(new Date(d).getTime() - OFFSET_MS).toISOString().slice(0, 10);

function titulo(dados, tipo) {
  const d = dados || {};
  return String(d.titulo || d.texto || d.motivo || d.descricao || tipo).slice(0, 200);
}

module.exports = {
  id: 'dono.pendencias',
  camada: 'detector',
  missao: 'Juntar as pendências do dia num resumo único para o dono (1 por dia).',
  escuta: ['dono.pendencia', 'relogio.diario'],
  emite: ['dono.resumo'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['timezone-fortaleza'],
  tempoMax: 20000,
  async disparar({ sinal, ler, agora }) {
    if (sinal.tipo !== 'relogio.diario') return []; // pendência avulsa: entra no próximo resumo
    const dia = diaFortaleza(agora);
    const ja = await ler.rnaSinal.findFirst({ where: { tipo: 'dono.resumo', dados: { path: ['dia'], equals: dia } } });
    if (ja) return [];
    const ultimo = await ler.rnaSinal.findFirst({ where: { tipo: 'dono.resumo' }, orderBy: { criadoEm: 'desc' }, select: { criadoEm: true } });
    const piso = new Date(agora.getTime() - 7 * DIA);
    const desde = ultimo ? new Date(Math.max(ultimo.criadoEm.getTime(), piso.getTime())) : new Date(agora.getTime() - DIA);
    const lista = await ler.rnaSinal.findMany({
      where: { tipo: 'dono.pendencia', criadoEm: { gte: desde, lte: agora } },
      orderBy: { criadoEm: 'asc' }, take: 500,
      select: { id: true, origem: true, loja: true, dados: true, criadoEm: true },
    });
    const porOrigem = {};
    for (const p of lista) porOrigem[p.origem] = (porOrigem[p.origem] || 0) + 1;
    const itens = lista.slice(0, 30).map((p) => ({ origem: p.origem, loja: p.loja || null, quando: p.criadoEm.toISOString(), titulo: titulo(p.dados, 'pendência'), sinalId: p.id }));
    const texto = lista.length
      ? `${lista.length} pendência(s) desde ${diaFortaleza(desde)}: ` + Object.entries(porOrigem).map(([o, n]) => `${o} ${n}`).join(', ')
      : `Nenhuma pendência levantada pela rede desde ${diaFortaleza(desde)}.`;
    return [{
      tipo: 'dono.resumo', forca: lista.length ? 0.9 : 0.3,
      dados: { dia, desde: desde.toISOString(), total: lista.length, porOrigem, itens, texto, chave: 'resumo:' + dia, fonte: 'RnaSinal tipo=dono.pendencia na janela' },
    }];
  },
};
