// =====================================================================
// Classificador por REGRAS — zero IA, zero custo.
// Lê nome + marca do produto e SUGERE as 4 (category, subcategory/gênero,
// modality, tier). Determinístico e explicável. NÃO aplica — o dono aprova.
// Substitui o classifyAgent (que pagava Claude) com a mesma saída.
// =====================================================================

function norm(s) {
  return (s || '').toString().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// casa keyword: string = substring; RegExp = testa direto
function hit(name, kws) {
  return kws.some((k) => (k instanceof RegExp ? k.test(name) : name.includes(k)));
}

// itens que NÃO são produto de venda (material de loja) → INSUMO, não sobe pro site
const INSUMO_KW = ['ADESIVO', 'BANDEJA', 'SLAT WALL', 'SLATWALL', 'AMORTECEDOR', 'EXPOSITOR', 'MANEQUIM',
  'CABIDE', 'EMBALAGEM', 'ETIQUETA', 'PROVADOR', 'DISPLAY', 'GANCHEIRA', 'GONDOLA', 'DEPOSITO VERTICAL',
  'TORRE COM', 'CARTAZ', 'PLACA ', 'SUPORTE PAREDE', 'AMOSTRA', 'BRINDE'];

// Regras ordenadas: primeiro acerto vence. [keywords, category, modality]
// Específico antes do genérico. Casa contra o NOME (uppercase, sem acento).
const RULES = [
  // ---- Acessórios ----
  [['BOLA'], 'Acessórios', 'Bola'],
  [['MEIAO', 'MEIA '], 'Acessórios', 'Meia'],
  [['MOCHILA'], 'Acessórios', 'Bolsa'],
  [['BOLSA', 'NECESSAIRE', 'POCHETE', 'SHOULDER BAG', 'SACOCHILA', 'MALA '], 'Acessórios', 'Bolsa'],
  [[/\bTOP\b/, 'MANGUITO'], 'Vestuário', 'Top'],
  [['BONE', 'VISEIRA', 'TOUCA', 'LUVA', 'MUNHEQUEIRA', 'JOELHEIRA', 'CANELEIRA', 'FAIXA', 'GARRAFA',
    'SQUEEZE', 'OCULOS', 'RELOGIO', 'BOMBA', 'REDE ', 'APITO', 'CONE', 'RAQUETE', 'CORDA ',
    'CHAVEIRO', 'CARTEIRA', 'AGULHA', 'ELASTICO', 'KIT PROTECAO', 'PROTECAO RADICAL'], 'Acessórios', 'Outro'],
  [['PRANCHA'], 'Acessórios', 'Prancha'],

  // ---- Vestuário (checar antes de calçado) ----
  [['CAMISETA', 'CAMISA ', 'BABYLOOK', 'BABY LOOK', 'T-SHIRT', 'TSHIRT', 'MANGA LONGA', 'POLO '], 'Vestuário', 'Camiseta'],
  [['BLUSA', 'BLUSAO'], 'Vestuário', 'Camiseta'],
  [['REGATA', 'MACHAO'], 'Vestuário', 'Regata'],
  [['CROPPED'], 'Vestuário', 'Cropped'],
  [['LEGGING'], 'Vestuário', 'Legging'],
  [['SHORT', 'BERMUDA', 'TACTEL'], 'Vestuário', 'Short'],
  [['NATACAO', 'SUNGA', 'BIQUINI'], 'Vestuário', 'Natação'],
  [[/\bMAIO\b/, 'MAIOR DE AGUA'], 'Vestuário', 'Natação'],
  [[/\bCALCA\b/, 'JOGGER', 'MOLETOM'], 'Vestuário', 'Calça'],
  [['JAQUETA', 'CASACO', 'AGASALHO', 'CORTA VENTO', 'CORTA-VENTO', 'CONJUNTO', 'MACAQUINHO',
    'BODY ', 'VESTIDO', 'SAIA ', 'COLETE', 'PARKA', 'PIJAMA'], 'Vestuário', 'Outro'],

  // ---- Calçados (modalidade específica) ----
  [['FUTSAL', 'INDOOR'], 'Calçados', 'Futsal'],
  [['SOCIETY'], 'Calçados', 'Society'],
  [['CHUTEIRA CAMPO', 'TRAVA ', ' FG', ' SG'], 'Calçados', 'Campo'],
  [['SAPATILHA'], 'Calçados', 'Sapatilha'],
  [['SANDALIA', 'CHINELO', 'PAPETE', 'SLIDE', 'RASTEIRA'], 'Calçados', 'Sandália'],
  [['CORRIDA', 'RUNNING'], 'Calçados', 'Corrida'],
  [['CASUAL', 'LIFESTYLE', 'LIFE STYLE', 'URBAN', 'SNEAKER'], 'Calçados', 'LifeStyle'],
];

// marcas que neste catálogo são ~só calçado → ajuda no fallback
const FOOTWEAR_BRANDS = ['SKECHERS', 'OLYMPIKUS', 'OXN', 'OUSADIA'];

function categoryAndModality(name, brand) {
  for (const [kws, cat, mod] of RULES) {
    if (hit(name, kws)) return { category: cat, modality: mod };
  }
  // fallback de calçado genérico (palavra)
  if (name.includes('CHUTEIRA')) return { category: 'Calçados', modality: 'Campo' };
  if (name.includes('TENIS') || name.includes('TÊNIS')) return { category: 'Calçados', modality: 'LifeStyle' };
  if (name.includes('BOTA')) return { category: 'Calçados', modality: 'Outro' };
  // pista de calçado: faixa de tamanho "35/38" ou termina com tamanho 34-46
  if (/\b(3[4-9]|4[0-6])\s*\/\s*(3[4-9]|4[0-6])\b/.test(name) || /\b(3[4-9]|4[0-6])\s*$/.test(name)) {
    return { category: 'Calçados', modality: 'LifeStyle' };
  }
  // marca de calçado + nome sem tipo → provável tênis
  if (FOOTWEAR_BRANDS.includes(brand)) return { category: 'Calçados', modality: 'LifeStyle' };
  return { category: null, modality: null }; // não arrisca lixo → fica pra manual
}

function gender(txt) {
  const infantil = /\b(INFANTIL|JUVENIL|KIDS|BABY|INFANT|MIRIM)\b/.test(txt);
  const masc = /(MASCULIN|\bMASC\b|\bMASC\.|HOMEM|\bMEN\b|\bMALE\b)/.test(txt);
  const fem = /(FEMININ|\bFEM\b|\bFEM\.|MULHER|\bWOMEN\b|\bGIRL\b)/.test(txt);
  if (infantil && masc) return 'Menino';
  if (infantil && fem) return 'Menina';
  if (infantil) return 'Unissex';
  if (masc) return 'Homem';
  if (fem) return 'Mulher';
  return 'Unissex';
}

function tier(txt) {
  if (/\bPRO\b|PROFISSIONAL|OFICIAL|\bELITE\b|PREMIUM|MUNDIAL|FIFA/.test(txt)) return 'Profissional';
  if (/DRY ?FIT|DRYFIT/.test(txt)) return 'DryFit';
  if (/POLIAMIDA/.test(txt)) return 'Poliamida';
  if (/PROTECAO UV|\bUV\b|\bFPS\b|FPU/.test(txt)) return 'Proteção UV';
  if (/CASUAL|LIFESTYLE|LIFE STYLE/.test(txt)) return 'casual';
  if (/INICIACAO|INICIANTE|ESCOLAR|\bSUB\b/.test(txt)) return 'Iniciante';
  return 'Básica';
}

// Retorna {suggestion:{category,subcategory,modality,tier}, confidence, reason} | suggestion:null
function classifyByRules(p) {
  const name = norm(p.name);
  const brand = norm(p.brand);
  const txt = name + ' ' + brand;

  if (INSUMO_KW.some((k) => name.includes(k))) {
    return { suggestion: { category: 'INSUMO', subcategory: 'Unissex', modality: 'Outro', tier: 'Básica' },
      confidence: 0.95, reason: 'material de loja (não vende no site)', source: 'rules' };
  }

  const { category, modality } = categoryAndModality(name, brand);
  if (!category) return { suggestion: null, confidence: 0, reason: 'nome não bate com nenhuma regra → classificar manual', source: 'rules' };

  const subcategory = gender(txt);
  const t = tier(txt);
  const strong = modality !== 'LifeStyle' && modality !== 'Outro' && modality !== 'Campo';
  const conf = strong ? 0.85 : 0.6;
  return { suggestion: { category, subcategory, modality, tier: t }, confidence: conf,
    reason: `nome→${category}/${modality}; gênero=${subcategory}; tier=${t}`, source: 'rules' };
}

module.exports = { classifyByRules, norm };
