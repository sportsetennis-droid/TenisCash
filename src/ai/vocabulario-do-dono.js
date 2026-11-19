// =====================================================================
// VOCABULÁRIO E REGRAS DO DONO — o que as palavras do Douglas querem dizer
// e as regras que TODO agente precisa saber. Vai no prompt de todo agente de
// IA (base dos agentes + Rede Neural) e na constituição. Uma fonte só:
// mudou aqui, mudou para todos.
// =====================================================================

const BIPADO = 'Quando o dono diz "bipado"/"bipados", é SEMPRE o ESTOQUE NOVO: bipe aplicado das contagens de substituição abertas em 09/11/2026 ' +
  '(rodadas operationType="replacement" que não foram canceladas). Bipe antigo, de rodada cancelada, de inventário antigo ou ainda pendente NÃO é "bipado". ' +
  'Ao responder sobre "bipados", conte, liste e cruze só esse conjunto (dono, 18/11/2026).';

const CINCO_FOTOS = 'Todo produto tem como META 5 fotos da MESMA COR do card (no máximo 5). Produto novo SOBE para a Nuvemshop com 3 fotos ou mais; ' +
  'com menos de 3 não sobe (dono, 19/11/2026: "até 3 fotos pode liberar... menos de 3 fotos não"). Quem tem 3 ou 4 continua sendo completado até 5. ' +
  'Foto nunca é inventada nem de outra cor (dono, 18/11/2026).';

const NUVEMSHOP_AUTOMATICA = 'Toda alteração no card (foto, tamanho, código, venda, estoque, preço, nome, cor, descrição, classificação — tudo) chega SOZINHA na Nuvemshop: ' +
  'espelho do card a cada 3 min, estoque a cada 5 min, produto novo de hora em hora. Nenhum agente depende de "subir na mão" (dono, 18/11/2026).';

const TESTE_E_AUDITORIA = 'Nenhuma tarefa está pronta sem: 1) testar tudo antes de ensinar ou entregar; 2) depois de ensinar, uma equipe de AUDITORIA independente ' +
  'verifica tudo o que foi produzido e se seguiu todas as regras; só então a tarefa está finalizada (dono, 18/11/2026).';

const LUGAR_CERTO = 'Cada agente confere se TODO produto sob sua responsabilidade está no LUGAR CERTO com as especificações certas: categoria, subcategoria (o público: Homem, Mulher/Feminino, Menino, Menina ou Unissex), modalidade e especialidade. ' +
  'A classificação do card é o endereço dele no menu da loja online e tem que bater com o que o NOME do produto diz (meia/bola/bolsa = Acessórios, camiseta/short = Roupas, chuteira FUTSAL = Futsal, JR/infantil = Menino/Menina; criança nunca vai para adulto por falta da palavra "infantil"). ' +
  'Só vale o que está escrito (nome, NF-e, caixa): nada é deduzido. Régua em src/ai/rede/regras/local-certo.js; conserto em regras/conserto-nuvemshop.js; o gerente de cada marca mostra o que está fora do lugar (dono, 18/11/2026).';

const GERENTE_RESPONSAVEL = "Cada gerente de marca é RESPONSÁVEL pelos produtos da sua marca: cuidar do estoque, preencher o cadastro e colocar na Nuvemshop. Ele preenche SOZINHO só o que tem prova escrita (categoria pelo tipo do nome, público MASCULINO/FEMININO/JR do nome, modalidade FUTSAL/SOCIETY/CAMPO da chuteira), nunca sobrescreve o que já está preenchido e registra a prova no card; aciona os agentes de foto oficial e de descrição para todo card com estoque nas lojas do site e fora dele; o que exige julgamento (especialidade, cor sem prova, foto, descrição) vira pendência/proposta para o dono. Publicar continua pela trava oficial e pela subida automática; preço nunca é tocado (dono, 18/11/2026).";

const SITE_DA_MARCA = 'Se a NF-e (ou a caixa) NÃO traz o dado — cor por extenso, foto, o significado de uma sigla de cor — o agente PESQUISA NO SITE OFICIAL DA MARCA pelo CÓDIGO EXATO do card ' +
  '(código de barras; senão a referência/cProd) antes de dizer que não tem. Lojas oficiais VTEX respondem em /api/catalog_system/pub/products/search?fq=alternateIds_Ean:<EAN13> ' +
  '(FILA e Umbro também por fq=productId:<cProd>; Puma/Asics pela Drastosa, a fornecedora; Adidas pela página da REF). Só vale o item com o MESMO código; a cor do item vence a do produto; ' +
  '"cor predominante" é filtro e não vale; tamanhos com cores diferentes = conflito; nome comercial sem cor em português ("Frosted Dew") só vira cor se uma página disser a cor. ' +
  'Produto fora de linha: versão arquivada da página oficial (web.archive.org). Grava com a fonte no card (colorEvidencia) e a cor antiga em colorRaw; sigla confirmada entra no dicionário da marca (colorName.js). ' +
  'Sem página do código exato: fica pendente para a loja conferir na caixa — nunca chutar (dono, 18/11/2026). Ferramenta: src/services/corOficialMarca.js; o gerente de cada marca já usa de hora em hora.';

const REGRAS_DO_DONO = [BIPADO, CINCO_FOTOS, NUVEMSHOP_AUTOMATICA, TESTE_E_AUDITORIA, LUGAR_CERTO, GERENTE_RESPONSAVEL, SITE_DA_MARCA];

const VOCABULARIO_DO_DONO = ['VOCABULÁRIO E REGRAS DO DONO:', ...REGRAS_DO_DONO.map((r) => '- ' + r)].join('\n');

module.exports = { BIPADO, CINCO_FOTOS, NUVEMSHOP_AUTOMATICA, TESTE_E_AUDITORIA, LUGAR_CERTO, GERENTE_RESPONSAVEL, SITE_DA_MARCA, REGRAS_DO_DONO, VOCABULARIO_DO_DONO };
