// resultado.aplicar — detector (regra, custo zero)
// Recebe o KPI medido (`resultado.kpi`) e PROPÕE ao dono aplicá-lo nos pesos
// da rede. Neurônio não escreve: quem ajusta é a ação `rede.aplicar-kpi`
// (src/ai/rede/acoes/rede.js), que só roda com a proposta APROVADA —
// chama aprendizado.aoResultado(objetivoId, recompensa) e, se for a medição
// final, marca o objetivo como concluído.

const fmt = (x) => (x >= 0 ? '+' : '') + Number(x).toFixed(2).replace('.', ',');

module.exports = {
  id: 'resultado.aplicar',
  camada: 'detector',
  missao: 'Propor ao dono aplicar o resultado medido de um objetivo nos pesos da rede.',
  escuta: ['resultado.kpi'],
  emite: ['proposta.aprendizado-kpi'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['aprendizado-auditado', 'dono-decide'],
  tempoMax: 15000,
  async disparar({ sinal, ler }) {
    const d = sinal.dados || {};
    const recompensa = Number(d.recompensa);
    if (!d.objetivoId || !Number.isFinite(recompensa) || recompensa < -1 || recompensa > 1) return [];
    const final = !!d.final;
    if (!final && recompensa === 0) return []; // parcial neutra: nada a ajustar
    const obj = await ler.rnaObjetivo.findUnique({ where: { id: d.objetivoId }, select: { id: true, texto: true, status: true } });
    if (!obj || obj.status !== 'ativo') return [];
    const chave = d.chave || `kpi:${obj.id}:${final ? 'final' : d.quando || sinal.id}`;
    // dono já decidiu esta medição (aprovou ou rejeitou)? não pergunta de novo
    const decidida = await ler.aIApproval.findFirst({ where: { type: 'rna_aprendizado_kpi', status: { not: 'pending' }, payload: { path: ['rna', 'chave'], equals: chave } }, select: { id: true } });
    if (decidida) return [];
    const kpis = (d.detalhe && d.detalhe.kpis) || [];
    const evidencia = kpis.map((k) => `${k.kpi} (${k.tipo}): atual ${k.atual} vs base ${k.base} — janelas ${k.janela.atual.join('→')} × ${k.janela.base.join('→')}; fonte ${k.fonte}`);
    for (const f of (d.detalhe && d.detalhe.naoMensuraveis) || []) evidencia.push(`não medido: ${f.kpi} — ${f.motivo}`);
    evidencia.push(`sinal resultado.kpi ${sinal.id} (trace ${sinal.traceId})`);
    return [{
      tipo: 'proposta.aprendizado-kpi', forca: 1,
      dados: {
        chave,
        titulo: `${final ? 'Fechar objetivo' : 'Aplicar medição parcial'} "${String(obj.texto).slice(0, 80)}" — recompensa ${fmt(recompensa)}`,
        descricao: `Se aprovar: as sinapses das propostas já aprovadas deste objetivo mudam ${fmt(0.1 * recompensa)} de peso (auditado em RnaAjustePeso, motivo "kpi")${final ? ' e o objetivo é marcado como CONCLUÍDO' : ''}.`,
        risco: 'baixo',
        previa: { objetivoId: obj.id, recompensa, deltaPeso: Math.round(0.1 * recompensa * 10000) / 10000, concluir: final },
        evidencia,
        acao: { nome: 'rede.aplicar-kpi', args: { objetivoId: obj.id, recompensa, concluir: final, detalhe: d.detalhe || null } },
      },
    }];
  },
};
