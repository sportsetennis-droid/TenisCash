// =====================================================================
// VOCABULÁRIO DO DONO — o que as palavras do Douglas querem dizer.
// Vai no prompt de TODO agente de IA (base dos agentes + Rede Neural) e na
// constituição. Uma fonte só: mudou aqui, mudou para todos.
// =====================================================================

const BIPADO = 'Quando o dono diz "bipado"/"bipados", é SEMPRE o ESTOQUE NOVO: bipe aplicado das contagens de substituição abertas em 09/11/2026 ' +
  '(rodadas operationType="replacement" que não foram canceladas). Bipe antigo, de rodada cancelada, de inventário antigo ou ainda pendente NÃO é "bipado". ' +
  'Ao responder sobre "bipados", conte, liste e cruze só esse conjunto (dono, 18/11/2026).';

const VOCABULARIO_DO_DONO = ['VOCABULÁRIO DO DONO:', '- ' + BIPADO].join('\n');

module.exports = { BIPADO, VOCABULARIO_DO_DONO };
