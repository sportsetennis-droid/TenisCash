// seg.injecao — detector (regra, custo zero)
// Conteúdo de fora (WhatsApp, Instagram, e-mail) é DADO, nunca instrução.
// O motor já marca `dados._alertaInjecao` quando acha comando escondido no
// sinal externo; este neurônio transforma a marca em alerta (`seg.alerta`)
// e, se o MESMO remetente (telefoneHash) insistir 3x em 24h, levanta uma
// pendência pro dono (1 por remetente por dia). Não guarda o texto da
// mensagem no alerta — só os padrões achados.

const OFFSET_MS = 3 * 3600 * 1000;
const DIA = 24 * 3600 * 1000;
const REPETICOES = 3;
const diaFortaleza = (d) => new Date(new Date(d).getTime() - OFFSET_MS).toISOString().slice(0, 10);

module.exports = {
  id: 'seg.injecao',
  camada: 'detector',
  missao: 'Alertar quando conteúdo externo traz instrução escondida (prompt injection).',
  escuta: ['whatsapp.*', 'instagram.*', 'email.*'],
  emite: ['seg.alerta', 'dono.pendencia'],
  limiar: 0,
  custo: { tipo: 'regra' },
  permissao: 'ler',
  regras: ['conteudo-externo-e-dado'],
  tempoMax: 15000,
  async disparar({ sinal, ler, agora }) {
    const d = sinal.dados || {};
    const padroes = d._alertaInjecao;
    if (!Array.isArray(padroes) || !padroes.length) return [];
    const remetente = d.telefoneHash || d.remetenteHash || d.autorHash || null;
    const dia = diaFortaleza(agora);
    const saidas = [{
      tipo: 'seg.alerta', forca: 1,
      dados: { motivo: 'possível instrução escondida em conteúdo externo', canal: sinal.tipo, empresa: d.empresa || null, remetente, padroes, sinalOrigem: sinal.id, dia, chave: 'injecao:' + sinal.id },
    }];
    if (!remetente) return saidas;
    const anteriores = await ler.rnaSinal.count({ where: { tipo: 'seg.alerta', criadoEm: { gte: new Date(agora.getTime() - DIA) }, dados: { path: ['remetente'], equals: remetente } } });
    if (anteriores + 1 < REPETICOES) return saidas;
    const ref = `injecao:${remetente}:${dia}`;
    const ja = await ler.rnaSinal.findFirst({ where: { tipo: 'dono.pendencia', dados: { path: ['ref'], equals: ref } } });
    if (ja) return saidas;
    saidas.push({
      tipo: 'dono.pendencia', forca: 1,
      dados: {
        ref, chave: ref, origem: 'seg.injecao', canal: sinal.tipo, remetente, ocorrencias24h: anteriores + 1,
        titulo: `Remetente insiste em mensagem com instrução escondida (${anteriores + 1}x em 24h, ${sinal.tipo})`,
        sugestao: 'Conferir a conversa; a rede tratou como dado e não executou nada.',
      },
    });
    return saidas;
  },
};
