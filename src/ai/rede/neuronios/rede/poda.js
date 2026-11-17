// rede.poda — detector (regra, custo zero)
// Todo mês lista os neurônios candidatos à poda (mesma regra de
// aprendizado.candidatosPoda, só leitura) e faz UMA PROPOSTA por neurônio.
// Nada é desligado aqui: o dono aprova e a ação `rede.desligar-neuronio`
// desliga (auditado em RnaAjustePeso, motivo 'poda').
// Não propõe podar neurônio de segurança (seg.*) nem a si mesmo.

const NAO_PODA = /^(seg\.|rede\.poda$)/;

module.exports = {
  id: 'rede.poda',
  camada: 'detector',
  missao: 'Propor ao dono desligar os neurônios que só erram ou não são usados.',
  escuta: ['relogio.mensal'],
  emite: ['proposta.poda'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'propor',
  regras: ['poda-com-confirmacao-do-dono'],
  tempoMax: 20000,
  async disparar({ ler }) {
    // mesma lógica do aprendizado, executada com o cliente SÓ-LEITURA
    const candidatos = await require('../../aprendizado').candidatosPoda(ler);
    const alvo = candidatos.filter((c) => !NAO_PODA.test(c.id)).slice(0, 20);
    if (!alvo.length) return [];
    const ids = alvo.map((c) => c.id);
    const linhas = await ler.rnaNeuronio.findMany({ where: { id: { in: ids } } });
    const porId = new Map(linhas.map((n) => [n.id, n]));
    return alvo.map((c) => {
      const n = porId.get(c.id) || {};
      const uso = n.ultimoUso ? new Date(n.ultimoUso).toISOString().slice(0, 10) : 'nunca';
      return {
        tipo: 'proposta.poda', forca: 0.7,
        dados: {
          chave: 'poda:' + c.id,
          titulo: `Podar (desligar) o neurônio ${c.id}`,
          descricao: `Motivo: ${c.motivo}. Desligar não apaga nada; religa-se pelo painel da rede.`,
          risco: 'baixo',
          previa: { neuronio: c.id, camada: n.camada || null, ativoDepois: false },
          evidencia: [
            `RnaNeuronio ${c.id}: acertos ${n.acertos ?? '?'}, erros ${n.erros ?? '?'}, disparos ${n.disparos ?? '?'}, último uso ${uso}`,
            `Regra de poda (aprendizado.candidatosPoda): ${c.motivo}`,
          ],
          acao: { nome: 'rede.desligar-neuronio', args: { id: c.id, motivo: c.motivo } },
        },
      };
    });
  },
};
