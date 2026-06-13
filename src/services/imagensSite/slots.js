// =====================================================================
// IMAGENS DE SITE — mapa canônico dos 22 slots da home (tema Morelia).
// Fonte: _slots_spec.json + _patch_home.js (nomes de arquivo FIXOS).
// Cada slot: gênero, seção, tamanho master exato, categoria de destino,
// nome do webp publicado (st-vit-* / st-ban-*) e filtro de taxonomia.
// 11 por gênero (5 card + 4 wide + 2 banner) = 22.
// =====================================================================
const GENDERS = ['feminino', 'masculino'];

const DIMS = { card: [1080, 1440], wide: [1456, 700], banner: [1600, 1200] };
const RATIO = { card: '3:4', wide: '2.08:1', banner: '4:3' };

// modality aceita LISTA de sinônimos (o dado do banco é bagunçado/parcial).
const CARD_DEFS = [
  { key: 'corrida',     label: 'Corrida',     filter: { type: 'Tênis', modality: ['Corrida'] } },
  { key: 'lifestyle',   label: 'Lifestyle',   filter: { type: 'Tênis', modality: ['LifeStyle', 'Lifestyle', 'Casual'] } },
  { key: 'treino',      label: 'Treino',      filter: { type: 'Tênis', modality: ['Caminhada / Treino leve', 'Treino', 'Academia', 'Musculação'] } },
  { key: 'recuperacao', label: 'Recuperação', filter: { type: 'Tênis', modality: ['Recuperação', 'Recovery'] } },
  { key: 'streetwear',  label: 'Streetwear',  filter: { type: 'Tênis', modality: ['Streetwear', 'Skate'] } },
];
const WIDE_DEFS = [
  { key: 'tenis',      label: 'Tênis (destaque)', filter: { type: 'Tênis' } },
  { key: 'roupas',     label: 'Roupas',           filter: { category: 'roupa' } },
  { key: 'acessorios', label: 'Acessórios',       filter: { category: 'acessor' } },
  { key: 'wellness',   label: 'Wellness',         filter: { type: 'Tênis', modality: ['Recuperação', 'Recovery', 'Yoga'] } },
];
const BANNER_DEFS = [
  { key: 'hero',  label: 'Hero principal', filter: { type: 'Tênis' } },
  { key: 'promo', label: 'Coleção/Promo',  filter: {} },
];

// categorias de destino por slot (lidas do _slots_spec.json), por gênero
const CATEGORY_URL = {
  feminino: {
    corrida: '/tenis/mulher/corrida1/', lifestyle: '/tenis/mulher/lifestyle/',
    treino: '/tenis/mulher/musculacao-crossfit/', recuperacao: '/tenis/mulher/recuperacao-muscular/',
    streetwear: '/tenis/mulher/streetwear/', tenis: '/tenis/mulher/', roupas: '/dna-feminino/',
    acessorios: '/acessorios/', wellness: '/tenis/mulher/recuperacao-muscular/',
    hero: '/tenis/mulher/', promo: '/tenis/mulher/lifestyle/',
  },
  masculino: {
    corrida: '/tenis/performance/leveza-teste/', lifestyle: '/tenis/performance/lifestyle1/',
    treino: '/tenis/performance/musculacao-crossfit1/', recuperacao: '/tenis/performance/recuperacao-muscular1/',
    streetwear: '/tenis/performance/streetwear1/', tenis: '/tenis/performance/', roupas: '/dna-masculino/',
    acessorios: '/acessorios/', wellness: '/tenis/performance/recuperacao-muscular1/',
    hero: '/tenis/performance/', promo: '/tenis/performance/lifestyle1/',
  },
};

const GEN_ABBR = { feminino: 'fem', masculino: 'masc' };

function mk(id, gender, section, d, asset) {
  return {
    id, gender, section, key: d.key, label: d.label,
    ratio: RATIO[section], dims: DIMS[section],
    width: DIMS[section][0], height: DIMS[section][1],
    category: (CATEGORY_URL[gender] || {})[d.key] || '',
    asset, file: `${asset}.webp`, filter: d.filter,
  };
}

function buildSlots() {
  const slots = [];
  let id = 0;
  for (const gender of GENDERS) {
    const ab = GEN_ABBR[gender];
    for (const d of CARD_DEFS)   slots.push(mk(++id, gender, 'card', d, `st-vit-${ab}-${d.key}`));
    for (const d of WIDE_DEFS)   slots.push(mk(++id, gender, 'wide', d, `st-vit-${ab}-${d.key}`));
    for (const d of BANNER_DEFS) slots.push(mk(++id, gender, 'banner', d, `st-ban-${ab}-${d.key}`));
  }
  return slots;
}

const SLOTS = buildSlots();

module.exports = { SLOTS, GENDERS, DIMS, RATIO };
