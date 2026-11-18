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
//
// Esta régua só usa o que está ESCRITO no nome do card (o tipo do produto,
// a modalidade da chuteira, o público). Nada é deduzido nem chutado: se o
// nome não diz, a régua não acusa. Ela ACUSA e ENSINA; quem corrige é o
// cadastro, e o envio ao site é automático depois da correção (regra 28).
// =====================================================================

const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const vazio = (v) => ['', 'A CLASSIFICAR', 'A DEFINIR', 'NAO DEFINIDO', 'SEM MARCA'].includes(norm(v).trim());

// Tipo do produto pela palavra escrita no nome → categorias em que ele pode estar.
// Só palavras sem ambiguidade (FAIXA, KIT, CONJUNTO, BOTA ficam de fora de propósito).
const TIPOS = [
  // "BEACH TENIS" e "TENIS DE MESA" são o ESPORTE, não o calçado
  { tipo: 'tênis', rx: /\bSAPATENIS\b|(?<!BEACH )\bTENIS\b(?! DE MESA)/, categorias: ['TENIS'] },
  { tipo: 'chuteira', rx: /\bCHUTEIRAS?\b/, categorias: ['CHUTEIRAS'] },
  { tipo: 'sandália/chinelo', rx: /\b(CHINELOS?|SANDALIAS?|SLIDES?|BABUCHES?)\b/, categorias: ['SANDALIAS', 'TENIS'] },
  { tipo: 'acessório', rx: /\b(MEIAS?|MEIAO|BOLAS?|BOLSAS?|MOCHILAS?|BONES?|VISEIRAS?|CANELEIRAS?|JOELHEIRAS?|COTOVELEIRAS?|TORNOZELEIRAS?|MUNHEQUEIRAS?|LUVAS?|GARRAFAS?|SQUEEZES?|OCULOS|TOUCAS?|APITOS?|BOMBAS?|CHAVEIROS?|MANGUITOS?|CANELITOS?|REDES?|RAQUETES?|PORTA|FIGURAS?|LIMPA)\b/, categorias: ['ACESSORIOS'] },
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

// público escrito no nome
function publicoDoNome(nome) {
  const n = norm(nome);
  const infantil = /\b(INFANTIL|JUVENIL|INFANTO|KIDS|BABY|JR)\b/.test(n);
  const masc = /\b(MASCULINO|MASCULINA|MASC)\b/.test(n);
  const fem = /\b(FEMININO|FEMININA|FEM)\b/.test(n);
  if (infantil) return 'infantil';
  if (masc && !fem) return 'masculino';
  if (fem && !masc) return 'feminino';
  return null;
}

const PUBLICOS = {
  HOMEM: 'masculino', MASCULINO: 'masculino',
  MULHER: 'feminino', FEMININO: 'feminino',
  MENINO: 'infantil', MENINA: 'infantil', INFANTIL: 'infantil', 'INF. M': 'infantil', 'INF. F': 'infantil', 'INF M': 'infantil', 'INF F': 'infantil',
  UNISSEX: 'unissex',
};

const INCOMPLETA = 'local: classificação incompleta';

// Confere UM card. Retorna a lista de motivos (strings estáveis — viram passo de conserto).
function conferirLocal(produto) {
  const p = produto || {};
  const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) { return {}; } })();
  const cls = ctx.classification || {};
  const motivos = [];
  const cat = norm(p.category).trim();

  if (vazio(p.category) || vazio(p.subcategory) || vazio(cls.modality) || vazio(cls.tier)) motivos.push(INCOMPLETA);

  const tipo = tipoDoNome(p.name);
  // INSUMO = uso interno da loja (não vai ao site): fora desta conferência
  if (tipo && !vazio(p.category) && cat !== 'INSUMO' && !tipo.categorias.includes(cat)) {
    motivos.push(`local: categoria errada (nome diz ${tipo.tipo}, card está em ${String(p.category).trim()})`);
  }

  if (cat === 'CHUTEIRAS' && !vazio(cls.modality)) {
    const mod = modalidadeChuteira(p.name);
    if (mod && norm(cls.modality).trim() !== mod) motivos.push(`local: modalidade errada (nome diz ${mod.toLowerCase()}, card está em ${String(cls.modality).trim()})`);
  }

  if (!vazio(p.subcategory)) {
    const sub = norm(p.subcategory).trim();
    const doCard = PUBLICOS[sub];
    if (!doCard) motivos.push(`local: subcategoria fora da árvore (${String(p.subcategory).trim()}; deve ser o público: Homem, Mulher, Menino, Menina ou Unissex)`);
    else {
      const doNome = publicoDoNome(p.name);
      if (doNome && doCard !== 'unissex' && doNome !== doCard) motivos.push(`local: público errado (nome diz ${doNome}, card está em ${String(p.subcategory).trim()})`);
    }
  }
  return motivos;
}

module.exports = { INCOMPLETA, conferirLocal, tipoDoNome, modalidadeChuteira, publicoDoNome, TIPOS };
