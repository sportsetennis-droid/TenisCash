// =====================================================================
// RNA — REGRA 30: TODO PRODUTO NO LUGAR CERTO (dono, 18/11/2026)
// "Eu quero que você ensine e veja para cada agente olhar e ver se o seu
//  produto que está sob sua responsabilidade está no local certo com as
//  devidas especificações, categoria, subcategoria e demais. Isso tem que
//  ser regra."
//
// "Lugar certo" = a classificação do card (Categoria > Subcategoria/público >
// Modalidade > Especialidade) é a que coloca o produto no MENU da loja online:
// o envio para a Nuvemshop resolve essa cadeia contra o menu e cria o ramo que
// faltar. Card de MEIA classificado em "Tênis" aparece no site dentro de Tênis.
// (Exceção: card com aiContext.nuvemshopMapping vai pelos IDs desse mapeamento
// antigo — quem chama avisa isso; ver _raio-x.)
//
// Esta régua só usa o que está ESCRITO no nome do card (o tipo do produto,
// a modalidade da chuteira, o público). Nada é deduzido nem chutado: se o
// nome não diz, a régua não acusa. Ela ACUSA e ENSINA; quem corrige é o
// cadastro, e o envio ao site é automático depois da correção (regra 28).
// Auditoria 18/11: criança nunca é empurrada para adulto; acessório "para
// tênis/chuteira" não é calçado; Sandálias/Roupas/Feminino como o catálogo usa.
// =====================================================================

// maiúsculas, sem acento e com espaço simples (texto de NF-e vem com espaço duplo)
const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ');
const vazio = (v) => ['', 'A CLASSIFICAR', 'A DEFINIR', 'NAO DEFINIDO', 'SEM MARCA'].includes(norm(v).trim());

// Categorias fora desta conferência: uso interno (INSUMO) e dropshipping (Dropper).
const FORA_DA_CONFERENCIA = new Set(['INSUMO', 'DROPPER']);

// "PARA TÊNIS", "DE CHUTEIRA", "P/ TÊNIS" = acessório DO calçado, não o calçado.
const NAO_E_O_CALCADO = '(?<!PARA )(?<!DE )(?<!P\\/ )(?<!P\\/)';

// Tipo do produto pela palavra escrita no nome → categorias em que ele pode estar
// (como o catálogo usa hoje: Sandálias e Roupas são aceitas ao lado da árvore oficial).
// Só palavras sem ambiguidade (FAIXA, KIT, CONJUNTO, BOTA ficam de fora de propósito).
const TIPOS = [
  // "BEACH TENIS" e "TENIS DE MESA" são o ESPORTE, não o calçado
  { tipo: 'tênis', rx: new RegExp('\\bSAPATENIS\\b|' + NAO_E_O_CALCADO + '(?<!BEACH )\\bTENIS\\b(?! DE MESA)'), categorias: ['TENIS'] },
  { tipo: 'chuteira', rx: new RegExp(NAO_E_O_CALCADO + '\\bCHUTEIRAS?\\b'), categorias: ['CHUTEIRAS'] },
  { tipo: 'sandália/chinelo', rx: /\b(CHINELOS?|SANDALIAS?|SLIDES?|BABUCHES?)\b/, categorias: ['SANDALIAS', 'TENIS'] },
  { tipo: 'acessório', rx: /\b(MEIAS?|MEIAO|BOLAS?|BOLSAS?|MOCHILAS?|BONES?|VISEIRAS?|CANELEIRAS?|JOELHEIRAS?|COTOVELEIRAS?|TORNOZELEIRAS?|MUNHEQUEIRAS?|LUVAS?|GARRAFAS?|SQUEEZES?|OCULOS|TOUCAS?|APITOS?|BOMBAS?|CHAVEIROS?|MANGUITOS?|CANELITOS?|REDES?|RAQUETES?|PORTA|FIGURAS?|LIMPA|LIMPEZA|PALMILHAS?|(?<!SEM )CADARCOS?|OVERGRIPS?|TRAVAS?|CRAVOS?)\b/, categorias: ['ACESSORIOS'] },
  { tipo: 'roupa', rx: /\b(CAMISETAS?|CAMISAS?|REGATAS?|BERMUDAS?|SHORTS?|CALCAO|CALCOES|CALCAS?|LEGGINGS?|CROPPED|JAQUETAS?|CASACOS?|BLUSAS?|BLUSAO|AGASALHOS?|MACAQUINHOS?|MACACAO|MAIOS?|SUNGAS?|BIQUINIS?|KIMONOS?|MOLETONS?|SAIAS?|CORTA[- ]VENTO)\b/, categorias: ['VESTUARIO', 'ROUPAS'] },
];

// tipo = a palavra de tipo que aparece PRIMEIRO no nome ("MEIA DE CHUTEIRA" é meia)
function tipoDoNome(nome) {
  const n = norm(nome);
  let melhor = null;
  for (const t of TIPOS) {
    const m = t.rx.exec(n);
    if (m && (!melhor || m.index < melhor.pos)) melhor = { ...t, pos: m.index, palavra: m[0] };
  }
  return melhor;
}

// modalidade da chuteira escrita no nome (só uma; duas = não acusa)
function modalidadeChuteira(nome) {
  const n = norm(nome);
  const achou = new Set();
  if (/\bFUTSAL\b|\bINDOOR\b/.test(n)) achou.add('FUTSAL');
  if (/\bSOCIETY\b/.test(n)) achou.add('SOCIETY');
  if (/\bCAMPO\b/.test(n)) achou.add('CAMPO');
  return achou.size === 1 ? [...achou][0] : null;
}

// Público escrito no nome: criança e gênero são coisas separadas.
// ("BABY LOOK" é corte feminino adulto — BABY não conta como infantil.)
function publicoDoNome(nome) {
  const n = norm(nome);
  // "NEYMAR JR" é nome de linha/jogador (chuteira e camisa ADULTAS), não infantil
  const infantil = /\b(INFANTIL|INFANTO|JUVENIL|KIDS|JUNIOR|INF)\b|(?<!NEYMAR )\bJR\b/.test(n);
  const masc = /\b(MASCULINO|MASCULINA|MASC)\b/.test(n);
  const fem = /\b(FEMININO|FEMININA|FEM)\b/.test(n);
  return { infantil, genero: masc && !fem ? 'masculino' : fem && !masc ? 'feminino' : null };
}

// Público de cada subcategoria do card (como o catálogo e a árvore usam).
const PUBLICOS = {
  HOMEM: { infantil: false, genero: 'masculino' }, MASCULINO: { infantil: false, genero: 'masculino' },
  MULHER: { infantil: false, genero: 'feminino' }, FEMININO: { infantil: false, genero: 'feminino' },
  MENINO: { infantil: true, genero: 'masculino' }, 'INF. M': { infantil: true, genero: 'masculino' }, 'INF M': { infantil: true, genero: 'masculino' },
  MENINA: { infantil: true, genero: 'feminino' }, 'INF. F': { infantil: true, genero: 'feminino' }, 'INF F': { infantil: true, genero: 'feminino' },
  INFANTIL: { infantil: true, genero: null },
  UNISSEX: { infantil: null, genero: null },
};
// nós da árvore que não são público, mas existem nela (filtro de tamanhos)
const SUB_DA_ARVORE_SEM_PUBLICO = new Set(['TAMANHOS', 'TAMANHO']);

const INCOMPLETA = 'local: classificação incompleta';

// Confere UM card. Retorna a lista de motivos (strings estáveis — viram passo de conserto).
function conferirLocal(produto) {
  const p = produto || {};
  const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) { return {}; } })();
  const cls = ctx.classification || {};
  const motivos = [];
  const cat = norm(p.category).trim();
  if (FORA_DA_CONFERENCIA.has(cat)) return motivos;

  if (vazio(p.category) || vazio(p.subcategory) || vazio(cls.modality) || vazio(cls.tier)) motivos.push(INCOMPLETA);

  const tipo = tipoDoNome(p.name);
  if (tipo && !vazio(p.category) && !tipo.categorias.includes(cat)) {
    motivos.push(`local: categoria errada (nome diz ${tipo.tipo}, card está em ${String(p.category).trim()})`);
  }
  // 2ª classificação (2ª cadeia no menu do site): mesma régua de tipo
  const c2 = ctx.classification2 || {};
  const cat2 = norm(c2.category).trim();
  if (tipo && !vazio(c2.category) && !FORA_DA_CONFERENCIA.has(cat2) && !tipo.categorias.includes(cat2)) {
    motivos.push(`local: categoria errada na 2ª classificação (nome diz ${tipo.tipo}, está em ${String(c2.category).trim()})`);
  }

  if (cat === 'CHUTEIRAS' && !vazio(cls.modality)) {
    const mod = modalidadeChuteira(p.name);
    if (mod && norm(cls.modality).trim() !== mod) motivos.push(`local: modalidade errada (nome diz ${mod.toLowerCase()}, card está em ${String(cls.modality).trim()})`);
  }

  if (!vazio(p.subcategory)) {
    const sub = norm(p.subcategory).trim();
    const doCard = PUBLICOS[sub];
    if (!doCard) {
      if (!SUB_DA_ARVORE_SEM_PUBLICO.has(sub)) motivos.push(`local: subcategoria fora da árvore (${String(p.subcategory).trim()}; deve ser o público: Homem, Mulher/Feminino, Menino, Menina ou Unissex)`);
    } else if (doCard.infantil !== null) {
      const doNome = publicoDoNome(p.name);
      const onde = String(p.subcategory).trim();
      // só acusa o que o nome DIZ e contradiz o card; criança nunca é empurrada para adulto
      if (doNome.infantil && doCard.infantil === false) motivos.push(`local: público errado (nome diz infantil, card está em ${onde})`);
      else if (doNome.genero && doCard.genero && doNome.genero !== doCard.genero) motivos.push(`local: público errado (nome diz ${doNome.genero}, card está em ${onde})`);
    }
  }
  return motivos;
}

module.exports = { INCOMPLETA, conferirLocal, tipoDoNome, modalidadeChuteira, publicoDoNome, TIPOS };
