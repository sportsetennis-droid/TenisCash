// =====================================================================
// RNA — MANUAL DE CONSERTO: como levar TODO produto BIPADO para a Nuvemshop.
// (dono 2026-11-18: "ensine a cada [agente] como consertar esses erros para
// que todos os produtos bipados estejam na nuvemshop")
//
// "BIPADO" = ESTOQUE NOVO: bipe aplicado das rodadas de SUBSTITUIÇÃO em curso
// (abertas em 09/11/2026). Rodada cancelada, bipe antigo e bipe pendente NÃO
// contam (regra "só bipe novo vale").
//
// Cada motivo do gate oficial (services/nuvemshopEligibility) tem um passo de
// conserto, quem faz e se precisa do dono. Nenhum passo inventa dado: o que
// não está na NF-e, na caixa ou no site oficial da marca fica pendente.
// O gerente de marca só ENSINA e aponta; quem corrige é a pessoa indicada ou
// o mini agente do assunto, sempre como PROPOSTA quando toca preço/site.
// =====================================================================

const PASSOS = [
  { id: 'anuncio-apagado', rx: /^anuncio apagado na nuvemshop$/, titulo: 'Anúncio apagado na Nuvemshop',
    como: 'O anúncio deste card não existe mais na loja online (apagado no painel da Nuvemshop ou na limpeza da loja). O sistema NÃO recria sozinho: recriar poderia desfazer uma exclusão do dono ou repetir produto na loja. Se é para voltar, o dono manda e o card é republicado conferindo antes se o produto já não está na loja (trava contra repetido).',
    quem: 'dono', dono: true },
  // ---- regra 30 (dono 18/11): todo produto no LUGAR CERTO do site — a classificação do card é o endereço dele no menu
  { id: 'local-categoria', rx: /^local: categoria errada/, titulo: 'Categoria errada (o produto aparece na seção errada do site)',
    como: 'A categoria tem que ser o TIPO escrito no nome do produto: tênis → Tênis; chuteira → Chuteiras; meia, bola, bolsa, mochila, boné, luva, caneleira, joelheira, garrafa, óculos, touca, rede, raquete, palmilha, cadarço → Acessórios; camiseta, short, bermuda, calça, legging, top, regata, jaqueta, maiô, sunga, kimono → Vestuário (ou Roupas, como o catálogo usa hoje); chinelo/sandália → Sandálias (como o catálogo usa hoje; na árvore oficial é Tênis > público > Sandálias). Use um ramo que JÁ EXISTE no menu — o envio cria o ramo que faltar, então nunca invente nome novo; criar ramo novo é decisão do dono. Depois ajuste subcategoria (público), modalidade e especialidade. O espelho do card leva a mudança para o site sozinho (regra 28) — exceto se o card tem aiContext.nuvemshopMapping (mapeamento antigo da IA): aí apague esse mapeamento junto, senão o site continua no lugar antigo.',
    quem: 'cadastro / classificador', dono: false },
  { id: 'local-modalidade', rx: /^local: modalidade errada/, titulo: 'Chuteira na modalidade errada',
    como: 'A modalidade da chuteira é a que está escrita no nome: FUTSAL → Futsal, SOCIETY → Society, CAMPO → Campo. Corrigir a modalidade e conferir a especialidade (Iniciante, Treino, Profissional).',
    quem: 'cadastro / classificador', dono: false },
  { id: 'local-publico', rx: /^local: publico errado/, titulo: 'Público errado (masculino, feminino ou infantil)',
    como: 'A subcategoria é o PÚBLICO e só se corrige com o que o nome (ou a NF-e/caixa) DIZ: nome diz infantil (INFANTIL, JUVENIL, JR, JUNIOR, INF) e o card está em adulto → passar para o público infantil da árvore daquela categoria (Chuteiras: Menino é o único nó infantil; Tênis: Menino ou Menina — o gênero tem que estar escrito, senão fica pendente com o dono). Nome diz FEMININO em card masculino → Mulher (ou Feminino, onde a árvore usa Feminino); MASCULINO em card feminino → Homem; FEMININO em Menino → Menina e vice-versa. Criança NUNCA vai para adulto por falta da palavra "infantil" no nome. Nada de chute.',
    quem: 'cadastro', dono: false },
  { id: 'local-subcategoria', rx: /^local: subcategoria fora da arvore/, titulo: 'Subcategoria fora da árvore oficial',
    como: 'Na árvore oficial a subcategoria é o PÚBLICO (Homem, Mulher/Feminino, Menino, Menina ou Unissex); o tipo do produto vai na modalidade e o detalhe na especialidade. Valores como "Meias", "Óculos / Natação" ou "camiseta modal" criam ramos paralelos no menu do site. Onde encaixar (ou criar um ramo novo na árvore) é decisão do dono — o cadastro só aponta.',
    quem: 'dono', dono: true },
  { id: 'loja-fora-do-site', rx: /^so em loja que nao vende no site$/, titulo: 'Bipado só em loja que não abastece o site',
    como: 'O estoque da loja online vem só das lojas que abastecem o site — hoje 04, 06 e 07 (dono 12/11: "tenho produtos corretamente no estoque das lojas 04, 06 e 07, eles podem subir pra Nuvemshop"). Ou o dono libera outra loja para o site, ou o par é transferido para uma loja do site (proposta de transferência, aprovada pelo dono).',
    quem: 'dono', dono: true },
  { id: 'confirmacao', rx: /sem confirmacao humana/, titulo: 'Falta a confirmação para subir',
    como: 'A subida automática (de hora em hora) confirma sozinha o card que passa em TODAS as outras travas. Pelo envio manual do admin, a confirmação é marcada no card antes de enviar.',
    quem: 'subida automática / admin', dono: false },
  { id: 'fotos-minimas', rx: /menos de \d+ fotos/, titulo: 'Menos de 5 fotos (regra do dono: todo produto tem 5)',
    como: 'Completar até 5 fotos DA MESMA COR do card, nesta ordem de fonte (usadas de verdade nas varreduras de fotos de 15/11 e 18/11/2026; registro na memória "fotos-oficiais"): ' +
      '1) lojas VTEX pelo código de barras exato — /api/catalog_system/pub/products/search?fq=alternateIds_Ean:<EAN> em americanas, paquetaesportes, oscarcalcados, shopcoopera, shopping.sicredi, pittol e nos sites oficiais (penalty, umbro, fila, asics, olympikus, kenner, mizuno, ous, cajubrasil, newbalance, skechers, underarmour); ' +
      '2) CDN oficial da marca pela referência+cor exata (fonte na ficha da marca); ' +
      '3) busca pelo nome só com conferência rígida de modelo E cor (na dúvida, não usa); ' +
      '4) sem fonte online, a loja fotografa a peça real: lateral de fora, lateral de dentro, frente, calcanhar/trás e sola/de cima. ' +
      'Cada foto é conferida OLHANDO (cor, modelo, gênero) antes de gravar; nada de tabela de medidas, logo ou montagem; grava com backup e no máximo 5.',
    quem: 'conteudo.foto-oficial / loja', dono: false, usaFicha: 'foto' },
  { id: 'descricao', rx: /sem descricao/, titulo: 'Sem descrição',
    como: 'Gerar descrição técnica só com dados reais do card (marca, modelo, cor, material da NF-e) — o mini agente conteudo.descricao propõe e o dono aprova.',
    quem: 'conteudo.descricao', dono: true },
  { id: 'cor', rx: /sem cor|cor abreviada|cor crua/, titulo: 'Cor ausente, abreviada ou crua',
    como: 'Escrever a cor POR EXTENSO e em português (Branco/Rosa, nunca BR/RO). Fonte: NF-e literal, etiqueta da caixa ou página oficial da referência. Sigla sem evidência fica pendente (colorReview), não se chuta.',
    quem: 'cadastro', dono: false, usaFicha: 'cor' },
  { id: 'classificacao', rx: /(categoria|subcategoria|modalidade|especialidade) ausente/, titulo: 'Falta uma das 4 classificações',
    como: 'Preencher Categoria + Sub + Modalidade + Especialidade (regra inquebrável: sem as 4 não sobe).',
    quem: 'classificador / cadastro', dono: false },
  { id: 'marca', rx: /marca ausente/, titulo: 'Marca indefinida',
    como: 'Marca vem do fornecedor/NF-e e da etiqueta; card "A DEFINIR" não sobe. Corrigir no cadastro.',
    quem: 'cadastro', dono: false },
  { id: 'nome', rx: /^nome cru|nome ausente/, titulo: 'Nome cru da NF-e',
    como: 'Renomear para MODELO + COR por extenso, sem tamanho, código de barras nem espaço duplo da NF-e. Atenção: referências diferentes são produtos diferentes e NUNCA se juntam; quando duas refs têm o mesmo modelo e cor (ex.: Kappa K101/K102), o nome precisa continuar distinguível — confirmar com o dono como escrever, porque o CLAUDE.md (Kappa) manda a REF no nome e o portão do site recusa código no nome.',
    quem: 'cadastro / dono', dono: false },
  { id: 'custo', rx: /sem custo gravado/, titulo: 'Sem custo gravado',
    como: 'Custo = vUnCom da NF-e de ENTRADA do mesmo código (nunca transferência). Sem NF-e de entrada, falta importar a nota — não se estima custo.',
    quem: 'nfe / financeiro', dono: false },
  { id: 'preco-zero', rx: /preco de venda zerado/, titulo: 'Preço de venda zerado',
    como: 'Preço de venda = custo × (1 + markup). Mudar preço é decisão do dono: o mini agente de preço propõe e o dono aprova.',
    quem: 'preco (proposta)', dono: true },
  { id: 'preco-custo', rx: /preco de venda nao supera o custo/, titulo: 'Preço menor ou igual ao custo',
    como: 'Conferir custo (NF-e de entrada) e aplicar o markup. Proposta de preço para o dono aprovar; nunca sobe com preço de custo.',
    quem: 'preco (proposta)', dono: true },
  { id: 'tamanho-tecnico', rx: /tamanho tecnico/, titulo: 'Tamanho técnico (T-) com estoque',
    como: 'O número do tamanho só vem da CAIXA física (ou NF-e literal / tabela oficial da marca). Bipar de novo pedindo o tamanho ou conferir a foto do bipe NOVO; até lá não sobe.',
    quem: 'loja / bipe', dono: false, usaFicha: 'tamanho' },
  { id: 'sem-tamanho', rx: /sem tamanho valido com estoque/, titulo: 'Nenhum tamanho com estoque nas lojas do site',
    como: 'Os tamanhos bipados estão em loja que não abastece o site, ou o estoque foi vendido. Ver "Bipado só em loja que não abastece o site".',
    quem: 'dono', dono: true },
  { id: 'sem-codigo', rx: /sem codigo de barras/, titulo: 'Tamanho com estoque sem código de barras',
    como: 'Gravar o código efetivamente lido na caixa (bipe novo) no tamanho certo; nunca usar código de outra variante nem "SEM GTIN".',
    quem: 'loja / bipe', dono: false },
  { id: 'fisico-maior', rx: /fisico .* maior que comprado|fisico maior que comprado/, titulo: 'Físico maior que o comprado',
    como: 'Pode ser par repetido real ou falta de NF-e de entrada. Conferir na loja e procurar a nota; nunca apagar bipe nem recalcular o comprado.',
    quem: 'loja / nfe', dono: false },
  { id: 'codigo-duplo', rx: /mesmo codigo de barras em 2 tamanhos/, titulo: 'Mesmo código em 2 tamanhos',
    como: 'Um código = um tamanho. Conferir na caixa qual é o certo e separar.',
    quem: 'cadastro', dono: false },
  { id: 'oculto', rx: /oculto manualmente/, titulo: 'Oculto de propósito',
    como: 'Card marcado para não subir (ex.: junção errada a separar). Resolver o motivo do bloqueio e só então tirar a marca.',
    quem: 'dono', dono: true },
  { id: 'inativo', rx: /produto inativo/, titulo: 'Card inativo',
    como: 'Bipe caiu em card inativo: achar o card canônico (curado) da MESMA referência e religar. Só reativar card que tem NF-e de ENTRADA (card só de transferência fica descartado) e que não está numa decisão pendente do dono (ex.: os 28 Converse desativados).',
    quem: 'cadastro / dono', dono: false },
];

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function passoDe(motivo) {
  const m = sem(motivo);
  return PASSOS.find((p) => p.rx.test(m)) || { id: 'outro', titulo: String(motivo), como: 'Motivo novo do gate: conferir no card e registrar aqui o passo de conserto.', quem: 'dono', dono: true };
}

module.exports = { PASSOS, passoDe };
