// CONSTITUIÇÃO — COR POR EXTENSO, EM PORTUGUÊS, SEM ABREVIAÇÃO (dono, 14/11/2026)
//
// "A cor tem que ser colocada, tem que ser descrita e não abreviada. Tem produto
//  que tem a mesma referência e cores diferentes; enquanto se abrevia a cor, não
//  se consegue identificar que produto é. As cores têm que ser traduzidas para o
//  português, se não estiverem na língua portuguesa, e escritas, não abreviadas."
//
// Vale para a CRIAÇÃO/EDIÇÃO DO CARD (aiContext.color) e para TODA ETIQUETA.
//
// Regra anti-chute (CLAUDE.md, regra #1): só expande sigla que tem significado
// CERTO. Sigla ambígua (PR = preto ou prata? RO = rosa ou roxo? MR = marinho ou
// marrom?) só é resolvida no dicionário DA MARCA, com evidência (catálogo oficial
// / foto oficial do EAN). Palavra que o dicionário não conhece NÃO é inventada:
// a cor fica como está e o card ganha aiContext.colorReview pra conferência.

function plain(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

// Cores e modificadores já em português, com a grafia correta (acentos).
const PORTUGUESE = [
  'Preto', 'Branco', 'Azul', 'Marinho', 'Royal', 'Verde', 'Vermelho', 'Amarelo',
  'Laranja', 'Rosa', 'Roxo', 'Lilás', 'Lavanda', 'Violeta', 'Cinza', 'Grafite',
  'Chumbo', 'Bege', 'Marrom', 'Café', 'Castanho', 'Caramelo', 'Creme', 'Cru',
  'Areia', 'Marfim', 'Pérola', 'Amêndoa', 'Nude', 'Gelo', 'Dourado', 'Prata',
  'Bronze', 'Cobre', 'Turquesa', 'Celeste', 'Ciano', 'Coral', 'Salmão', 'Pêssego',
  'Menta', 'Oliva', 'Musgo', 'Militar', 'Lima', 'Limão', 'Bordô', 'Vinho',
  'Marsala', 'Cereja', 'Goiaba', 'Magenta', 'Fúcsia', 'Pink', 'Mostarda', 'Cáqui',
  'Petróleo', 'Cobalto', 'Índigo', 'Jeans', 'Malva', 'Uva', 'Fumê', 'Transparente',
  'Sortida', 'Sortido', 'Multicolorido', 'Estampado', 'Mescla',
  'Claro', 'Escuro', 'Fluorescente', 'Neon', 'Metálico', 'Choque', 'Bebê',
];

// Palavras de ligação que podem aparecer dentro de uma cor ("Verde e Preto").
const CONNECTORS = new Map(Object.entries({ e: 'e', com: 'com', de: 'de' }));

// Siglas/grafias CERTAS (sem ambiguidade) e palavras em inglês → português.
// ⚠️ NÃO colocar aqui sigla ambígua: pr, ro, mr, ca, co, dr, vi, fl, cy, ve.
const GLOBAL_ALIASES = {
  // preto
  preta: 'Preto', pt: 'Preto', pto: 'Preto', pta: 'Preto', ptr: 'Preto', blk: 'Preto', black: 'Preto',
  // branco
  branca: 'Branco', bc: 'Branco', bco: 'Branco', bca: 'Branco', br: 'Branco', white: 'Branco', wht: 'Branco', blanc: 'Branco',
  // azul
  az: 'Azul', azl: 'Azul', blue: 'Azul', mar: 'Marinho', mrn: 'Marinho', navy: 'Marinho', nvy: 'Marinho',
  // verde
  vd: 'Verde', vrd: 'Verde', verd: 'Verde', green: 'Verde', lime: 'Lima',
  // vermelho
  vermelha: 'Vermelho', vm: 'Vermelho', vml: 'Vermelho', vrm: 'Vermelho', verm: 'Vermelho', red: 'Vermelho',
  // amarelo
  amarela: 'Amarelo', am: 'Amarelo', aml: 'Amarelo', amr: 'Amarelo', yellow: 'Amarelo',
  // laranja
  lj: 'Laranja', lrj: 'Laranja', larj: 'Laranja', lrja: 'Laranja', orange: 'Laranja',
  // rosa / roxo
  rs: 'Rosa', rsa: 'Rosa', pink: 'Rosa', rx: 'Roxo', purp: 'Roxo', purple: 'Roxo',
  lilac: 'Lilás', lavender: 'Lavanda', violet: 'Violeta',
  // cinza
  cz: 'Cinza', cza: 'Cinza', cnz: 'Cinza', grey: 'Cinza', gray: 'Cinza', gry: 'Cinza',
  grf: 'Grafite', grft: 'Grafite', graphite: 'Grafite', ch: 'Chumbo', charcoal: 'Grafite',
  // terrosos
  beige: 'Bege', mrr: 'Marrom', brown: 'Marrom', cafe: 'Café', coffee: 'Café', caramel: 'Caramelo',
  crm: 'Creme', cream: 'Creme', sand: 'Areia', ivory: 'Marfim', pearl: 'Pérola', almond: 'Amêndoa',
  khaki: 'Cáqui', caqui: 'Cáqui', tan: 'Bege',
  // metálicos
  gold: 'Dourado', dou: 'Dourado', ddo: 'Dourado', dord: 'Dourado', ouro: 'Dourado', silver: 'Prata',
  bronze: 'Bronze', copper: 'Cobre',
  // outros
  turq: 'Turquesa', turquoise: 'Turquesa', cel: 'Celeste', cyan: 'Ciano', salmon: 'Salmão', peach: 'Pêssego',
  mint: 'Menta', olive: 'Oliva', olv: 'Oliva', burgundy: 'Bordô', wine: 'Vinho', cherry: 'Cereja',
  fuchsia: 'Fúcsia', fucsia: 'Fúcsia', fuccia: 'Fúcsia', mustard: 'Mostarda', petrol: 'Petróleo',
  cobalt: 'Cobalto', indigo: 'Índigo', denim: 'Jeans', mauve: 'Malva', grape: 'Uva', smoke: 'Fumê',
  trans: 'Transparente', trsp: 'Transparente', clear: 'Transparente',
  sort: 'Sortida', sortidas: 'Sortida', sortidos: 'Sortido',
  mcmt: 'Multicolorido', multi: 'Multicolorido', multicolor: 'Multicolorido', multicolour: 'Multicolorido', multicor: 'Multicolorido',
  // modificadores
  light: 'Claro', lt: 'Claro', clara: 'Claro', dark: 'Escuro', dk: 'Escuro', escura: 'Escuro',
  fluor: 'Fluorescente', fluo: 'Fluorescente', metallic: 'Metálico', metalico: 'Metálico',
};

// Expressões de mais de uma palavra (nomes comerciais de cor em inglês).
const PHRASES = [
  [['core', 'black'], 'Preto'],
  [['cloud', 'white'], 'Branco'],
  [['ftwr', 'white'], 'Branco'],
  [['footwear', 'white'], 'Branco'],
  [['light', 'blue'], 'Azul Claro'],
  [['dark', 'blue'], 'Azul Escuro'],
  [['hot', 'pink'], 'Rosa Choque'],
  [['blue', 'jeans'], 'Jeans'],
  [['rosa', 'choque'], 'Rosa Choque'],
  [['azul', 'bebe'], 'Azul Bebê'],
  [['rosa', 'bebe'], 'Rosa Bebê'],
];

// Dicionário POR MARCA — só com evidência registrada.
// POKER (Cauduro): catálogo oficial B2B apipedidos.poker.esp.br/api/catalog/{ref}/variations
// (colorHexArray) + foto oficial de cada EAN, conferidos 14/11/2026:
//   PR = Prata (#C0C0C0; chaveiro BR/PR/CZ prateado) · CH = Chumbo (#36454F)
//   RO / ROS = Rosa (bola Rio BR/RO branca e rosa) · MR = Marinho (bola ROC/MR: rosa e azul-marinho)
//   LAR = Laranja · CEL = Celeste · DOU = Dourado
//   AMC / LAC / VDC / ROC = versões neon (foto oficial). Nome DEFINIDO PELO DONO 14/11/2026
//   (opção "Neon / Choque"): Amarelo Neon · Laranja Neon · Verde Neon · Rosa Choque.
const BRAND_ALIASES = {
  poker: {
    pr: 'Prata', ro: 'Rosa', ros: 'Rosa', mr: 'Marinho', lar: 'Laranja',
    cel: 'Celeste', dou: 'Dourado', ch: 'Chumbo',
    amc: 'Amarelo Neon', lac: 'Laranja Neon', vdc: 'Verde Neon', roc: 'Rosa Choque',
  },
};

const DICT = new Map();
for (const word of PORTUGUESE) DICT.set(plain(word), word);
for (const [k, v] of Object.entries(GLOBAL_ALIASES)) DICT.set(k, v);

function brandKey(brand) {
  return plain(brand).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function lookup(token, brandMap) {
  const key = plain(token);
  if (brandMap && Object.prototype.hasOwnProperty.call(brandMap, key)) return brandMap[key];
  return DICT.get(key) || null;
}

// Traduz/expande UMA combinação de cor ("BR/RO/AMC", "Core Black/Cloud White",
// "Azul Marinho"). Retorna { value, certain, changed, unknown }.
function expandColorName(raw, options = {}) {
  const original = String(raw ?? '').trim();
  if (!original) return { value: '', certain: true, changed: false, unknown: [] };
  const brandMap = BRAND_ALIASES[brandKey(options.brand)] || null;
  const unknown = [];
  const parts = original.split(/\s*[/|+,;&]\s*/).filter(Boolean);
  const outParts = [];

  for (const part of parts) {
    // "off-white" é uma palavra só; demais hífens separam palavras/cores.
    const words = part.replace(/off[\s-]?white/ig, 'offwhite').split(/[\s\-_.]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < words.length; i += 1) {
      const a = plain(words[i]);
      const b = plain(words[i + 1]);
      const phrase = PHRASES.find(([p]) => p[0] === a && p[1] === b);
      if (phrase) { out.push(phrase[1]); i += 1; continue; }
      if (a === 'offwhite') { unknown.push('off-white'); out.push('Off-White'); continue; }
      if (CONNECTORS.has(a) && out.length && i < words.length - 1) { out.push(CONNECTORS.get(a)); continue; }
      // Numeração romana de sortimento ("SORTIDA II") faz parte do nome da cor.
      if (/^(i{1,3}|iv|v|vi{1,3})$/.test(a) && out.length) { out.push(words[i].toUpperCase()); continue; }
      const hit = lookup(words[i], brandMap);
      if (hit) { out.push(hit); continue; }
      unknown.push(words[i]);
      out.push(words[i]);
    }
    // "Azul Blue Jeans" → "Azul Azul Jeans" → "Azul Jeans" (palavra repetida colada).
    const dedup = out.filter((w, k) => k === 0 || plain(w) !== plain(out[k - 1]));
    outParts.push(dedup.join(' '));
  }

  const certain = unknown.length === 0;
  const value = outParts.join('/');
  // Mesmo texto (só diferença de maiúscula/acento) = já estava por extenso: não mexe.
  const changed = certain && plain(value) !== plain(original);
  return { value: certain ? value : original, certain, changed, unknown };
}

// Para ETIQUETA: mesma regra, saída em CAIXA ALTA. Se não for certa, devolve
// null (quem chama decide: mantém a revisão manual, nunca imprime sigla chutada).
function labelColorName(raw, options = {}) {
  const r = expandColorName(raw, options);
  if (!r.value) return '';
  if (!r.certain) return null;
  // Mantém o estilo da fonte: cor em CAIXA ALTA continua em caixa alta.
  const original = String(raw);
  return original === original.toUpperCase() ? r.value.toUpperCase() : r.value;
}

// Aplica a regra no aiContext do card (objeto). Preserva o texto original em
// colorRaw (evidência) e marca colorReview quando há sigla/palavra desconhecida.
function normalizeProductColorContext(ctx, brand) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return ctx;
  if (typeof ctx.color !== 'string' || !ctx.color.trim()) return ctx;
  const r = expandColorName(ctx.color, { brand });
  if (r.certain) {
    if (r.changed) {
      if (!ctx.colorRaw) ctx.colorRaw = ctx.color;
      ctx.color = r.value;
    }
    if (ctx.colorReview) delete ctx.colorReview;
  } else {
    ctx.colorReview = {
      raw: ctx.color,
      unknown: r.unknown,
      reason: 'Cor com sigla/palavra sem tradução certa — escrever por extenso em português (constituição 14/11/2026).',
    };
  }
  return ctx;
}

module.exports = { expandColorName, labelColorName, normalizeProductColorContext, BRAND_ALIASES };
