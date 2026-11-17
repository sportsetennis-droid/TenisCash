// =====================================================================
// RNA — ações da própria rede (META). Só rodam a partir de proposta
// APROVADA pelo dono (acoes.executar confere o status). Cada ação valida
// de novo os argumentos — nunca confia no neurônio que propôs.
//   rede.aplicar-kpi        → aprendizado.aoResultado + conclui o objetivo
//   rede.desligar-neuronio  → poda: RnaNeuronio.ativo=false (auditado)
// =====================================================================

// Neurônios de segurança não são podados por proposta automática: se o dono
// quiser desligar um, faz direto no painel (desligamento consciente).
const PROTEGIDOS = /^seg\./;

module.exports = function registrarAcoesRede(registrar) {
  registrar('rede.aplicar-kpi', {
    descricao: 'Aplica o resultado medido de um objetivo nos pesos da rede (±0,1 × recompensa nas sinapses das propostas aprovadas dele) e, se for o fechamento, marca o objetivo como concluído.',
    async executar(args, { aprovacao, db }) {
      const objetivoId = String((args && args.objetivoId) || '');
      const recompensa = Number(args && args.recompensa);
      if (!objetivoId) throw new Error('objetivoId ausente');
      if (!Number.isFinite(recompensa) || recompensa < -1 || recompensa > 1) throw new Error('recompensa fora de [-1, 1]: ' + (args && args.recompensa));
      const obj = await db.rnaObjetivo.findUnique({ where: { id: objetivoId } });
      if (!obj) throw new Error('objetivo não encontrado: ' + objetivoId);
      if (['concluido', 'cancelado'].includes(obj.status)) throw new Error('objetivo já está ' + obj.status + ': resultado não é reaplicado');
      const aprendizado = require('../aprendizado');
      const { ajustes } = await aprendizado.aoResultado(objetivoId, recompensa, db);
      const concluir = !!(args && args.concluir);
      const resultado = {
        recompensa,
        final: concluir,
        detalhe: (args && args.detalhe) || null,
        ajustes: ajustes.length,
        aplicadoEm: new Date().toISOString(),
        aprovacaoId: aprovacao ? aprovacao.id : null,
      };
      await db.rnaObjetivo.update({ where: { id: objetivoId }, data: concluir ? { status: 'concluido', resultado } : { resultado } });
      require('../motor').invalidarCaches();
      return { ok: true, objetivoId, recompensa, ajustes: ajustes.length, concluido: concluir };
    },
  });

  registrar('rede.desligar-neuronio', {
    descricao: 'Poda: desliga um neurônio (RnaNeuronio.ativo=false) e registra em RnaAjustePeso com motivo "poda". Religa-se pelo painel.',
    async executar(args, { aprovacao, db }) {
      const id = String((args && args.id) || '');
      if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(id)) throw new Error('id de neurônio inválido: ' + id);
      if (PROTEGIDOS.test(id)) throw new Error('neurônio de segurança não é podado por proposta (desligue no painel, se for o caso)');
      const n = await db.rnaNeuronio.findUnique({ where: { id } });
      if (!n) throw new Error('neurônio não encontrado: ' + id);
      if (!n.ativo) return { ok: true, id, nota: 'já estava desligado' };
      await db.rnaNeuronio.update({ where: { id }, data: { ativo: false } });
      const rna = (aprovacao && aprovacao.payload && aprovacao.payload.rna) || {};
      await db.rnaAjustePeso.create({ data: {
        alvo: 'neuronio:' + id, de: 1, para: 0, motivo: 'poda',
        traceId: rna.traceId || null, aprovacaoId: aprovacao ? aprovacao.id : null,
      } });
      require('../motor').invalidarCaches();
      return { ok: true, id, desligado: true, motivo: (args && args.motivo) || null };
    },
  });
};
