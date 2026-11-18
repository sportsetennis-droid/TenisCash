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
  { id: 'loja-fora-do-site', rx: /^so em loja que nao vende no site$/, titulo: 'Bipado só em loja que não abastece o site',
    como: 'O site só vende o físico das lojas que abastecem a Nuvemshop (hoje 04, 06 e 07 no código; o CLAUDE.md diz todas as lojas — decisão pendente do dono). Ou o dono libera a loja para o site, ou transfere o par para uma loja do site (proposta de transferência).',
    quem: 'dono', dono: true },
  { id: 'confirmacao', rx: /sem confirmacao humana/, titulo: 'Falta a confirmação do dono para subir',
    como: 'Depois de conferir foto, cor, preço e tamanhos, o dono marca "confirmar para a Nuvemshop" no card (admin). É a trava final de propósito: nenhum agente marca por conta própria.',
    quem: 'dono', dono: true },
  { id: 'foto', rx: /sem foto valida/, titulo: 'Sem foto válida',
    como: 'Buscar a foto OFICIAL pela referência/código exato da cor (fonte da marca na ficha); conferir a cor olhando cada foto; sem fonte online, a loja fotografa a peça. Nunca foto de outro colorway.',
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
    como: 'Renomear para MODELO + COR por extenso (sem código, tamanho ou espaço duplo da NF-e). A referência fica no campo de referência, não no nome.',
    quem: 'cadastro', dono: false },
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
    como: 'Bipe caiu em card inativo: achar o card canônico (curado) da mesma referência e religar, ou reativar o curado.',
    quem: 'cadastro', dono: false },
];

const sem = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function passoDe(motivo) {
  const m = sem(motivo);
  return PASSOS.find((p) => p.rx.test(m)) || { id: 'outro', titulo: String(motivo), como: 'Motivo novo do gate: conferir no card e registrar aqui o passo de conserto.', quem: 'dono', dono: true };
}

module.exports = { PASSOS, passoDe };
