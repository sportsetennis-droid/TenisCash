// =====================================================================
// VOCABULÁRIO E REGRAS DO DONO — o que as palavras do Douglas querem dizer
// e as regras que TODO agente precisa saber. Vai no prompt de todo agente de
// IA (base dos agentes + Rede Neural) e na constituição. Uma fonte só:
// mudou aqui, mudou para todos.
// =====================================================================

const BIPADO = 'Quando o dono diz "bipado"/"bipados", é SEMPRE o ESTOQUE NOVO: bipe aplicado das contagens de substituição abertas em 09/11/2026 ' +
  '(rodadas operationType="replacement" que não foram canceladas). Bipe antigo, de rodada cancelada, de inventário antigo ou ainda pendente NÃO é "bipado". ' +
  'Ao responder sobre "bipados", conte, liste e cruze só esse conjunto (dono, 18/11/2026).';

const CINCO_FOTOS = 'Todo produto tem que ter 5 fotos da MESMA COR do card (nem menos, nem mais). Produto novo com menos de 5 não sobe para a Nuvemshop; ' +
  'o que já está no site com menos de 5 é completado. Foto nunca é inventada nem de outra cor (dono, 18/11/2026).';

const NUVEMSHOP_AUTOMATICA = 'Toda alteração no card (foto, tamanho, código, venda, estoque, preço, nome, cor, descrição, classificação — tudo) chega SOZINHA na Nuvemshop: ' +
  'espelho do card a cada 3 min, estoque a cada 5 min, produto novo de hora em hora. Nenhum agente depende de "subir na mão" (dono, 18/11/2026).';

const TESTE_E_AUDITORIA = 'Nenhuma tarefa está pronta sem: 1) testar tudo antes de ensinar ou entregar; 2) depois de ensinar, uma equipe de AUDITORIA independente ' +
  'verifica tudo o que foi produzido e se seguiu todas as regras; só então a tarefa está finalizada (dono, 18/11/2026).';

const REGRAS_DO_DONO = [BIPADO, CINCO_FOTOS, NUVEMSHOP_AUTOMATICA, TESTE_E_AUDITORIA];

const VOCABULARIO_DO_DONO = ['VOCABULÁRIO E REGRAS DO DONO:', ...REGRAS_DO_DONO.map((r) => '- ' + r)].join('\n');

module.exports = { BIPADO, CINCO_FOTOS, NUVEMSHOP_AUTOMATICA, TESTE_E_AUDITORIA, REGRAS_DO_DONO, VOCABULARIO_DO_DONO };
