// =====================================================================
// IMAGENS DE SITE — mapa canônico de TODOS os slots de imagem da loja
// (tema Morelia). Fonte: _slots_spec.json + config/settings.txt + templates.
//
// Estrutura: BLOCOS → expandidos em SLOTS.
//   gender: 'feminino' | 'masculino' | 'gender' (gera p/ os 2) | 'shared'
//   engine: true  = o motor escolhe produto BIPADO (produto protagonista)
//           false = produção à parte (logo/ícone/pessoa) — só conta, não gera
// =====================================================================
const GENDERS = ['feminino', 'masculino'];
const DIMS = { card: [1080, 1440], wide: [1456, 700], banner: [1600, 1200] };
const RATIO = { card: '3:4', wide: '2.08:1', banner: '4:3' };
const GEN_ABBR = { feminino: 'fem', masculino: 'masc' };

// ---- BLOCO 1: SHOWCASE da home (a vitrine — 22 slots, gênero-específico) ----
const SHOWCASE = {
  card: [
    { key: 'corrida', label: 'Corrida', filter: { type: 'Tênis', modality: ['Corrida'] } },
    { key: 'lifestyle', label: 'Lifestyle', filter: { type: 'Tênis', modality: ['LifeStyle', 'Lifestyle', 'Casual'] } },
    { key: 'treino', label: 'Treino', filter: { type: 'Tênis', modality: ['Caminhada / Treino leve', 'Treino', 'Academia', 'Musculação'] } },
    { key: 'recuperacao', label: 'Recuperação', filter: { type: 'Tênis', modality: ['Recuperação', 'Recovery'] } },
    { key: 'streetwear', label: 'Streetwear', filter: { type: 'Tênis', modality: ['Streetwear', 'Skate'] } },
  ],
  wide: [
    { key: 'tenis', label: 'Tênis (destaque)', filter: { type: 'Tênis' } },
    { key: 'roupas', label: 'Roupas', filter: { category: 'roupa' } },
    { key: 'acessorios', label: 'Acessórios', filter: { category: 'acessor' } },
    { key: 'wellness', label: 'Wellness', filter: { type: 'Tênis', modality: ['Recuperação', 'Recovery', 'Yoga'] } },
  ],
  banner: [
    { key: 'hero', label: 'Hero principal', filter: { type: 'Tênis' } },
    { key: 'promo', label: 'Coleção/Promo', filter: {} },
  ],
};
const SHOWCASE_CAT = {
  feminino: { corrida: '/tenis/mulher/corrida1/', lifestyle: '/tenis/mulher/lifestyle/', treino: '/tenis/mulher/musculacao-crossfit/', recuperacao: '/tenis/mulher/recuperacao-muscular/', streetwear: '/tenis/mulher/streetwear/', tenis: '/tenis/mulher/', roupas: '/dna-feminino/', acessorios: '/acessorios/', wellness: '/tenis/mulher/recuperacao-muscular/', hero: '/tenis/mulher/', promo: '/tenis/mulher/lifestyle/' },
  masculino: { corrida: '/tenis/performance/leveza-teste/', lifestyle: '/tenis/performance/lifestyle1/', treino: '/tenis/performance/musculacao-crossfit1/', recuperacao: '/tenis/performance/recuperacao-muscular1/', streetwear: '/tenis/performance/streetwear1/', tenis: '/tenis/performance/', roupas: '/dna-masculino/', acessorios: '/acessorios/', wellness: '/tenis/performance/recuperacao-muscular1/', hero: '/tenis/performance/', promo: '/tenis/performance/lifestyle1/' },
};

// ---- BLOCOS 2+: demais imagens do tema (settings.txt) ----
// count = nº de imagens; planned=true → contagem default ajustável pelo dono.
const BLOCKS = [
  { block: 'banner-full', label: 'Banner Full 1 e 2', section: 'banner-wide', gender: 'shared', count: 2, dims: [1200, 600], engine: true, asset: 'st-banfull', filter: { type: 'Tênis' } },
  { block: 'vitrine-categorias', label: 'Vitrine de Categorias', section: 'card', gender: 'gender', count: 3, dims: [600, 800], engine: true, asset: 'st-vitcat', filter: {} },
  { block: 'categorias-principais', label: 'Categorias principais', section: 'tile', gender: 'shared', count: 8, dims: [400, 500], engine: true, planned: true, asset: 'st-maincat', filter: {} },
  { block: 'slider', label: 'Slider / Carrossel', section: 'slider', gender: 'shared', count: 5, dims: [1440, 700], engine: true, planned: true, asset: 'st-slider', filter: {} },
  { block: 'destaques-menu', label: 'Destaques do menu', section: 'square', gender: 'shared', count: 7, dims: [500, 500], engine: true, asset: 'st-menuhl', filter: {} },
  // --- produção à parte (não é produto bipado): pessoa/logo/ícone ---
  { block: 'quick-filter', label: 'Quick filter (modelos)', section: 'model', gender: 'gender', count: 7, dims: null, engine: false, asset: 'qf' },
  { block: 'marcas', label: 'Marcas (logos)', section: 'logo', gender: 'shared', count: 12, dims: [200, 200], engine: false, planned: true, asset: 'st-brand' },
  { block: 'banner-services', label: 'Banner services (ícones)', section: 'icon', gender: 'shared', count: 4, dims: [120, 120], engine: false, asset: 'st-svc' },
  { block: 'depoimentos', label: 'Depoimentos', section: 'people', gender: 'shared', count: 3, dims: [250, 250], engine: false, asset: 'st-test' },
];

// Nota informativa (não vira slot fixo — depende de quantas categorias):
const NOTES = [{ block: 'banner-categoria', label: 'Banner de página de categoria', dims: [930, 465], note: '1 por categoria (N a definir)' }];

function ratioOf(dims) { if (!dims) return '?'; const [w, h] = dims; const g = gcd(w, h); return `${w / g}:${h / g}`; }
function gcd(a, b) { return b ? gcd(b, a % b) : a; }

function buildSlots() {
  const slots = [];
  let id = 0;

  // BLOCO 1 — showcase (22, gênero-específico)
  for (const gender of GENDERS) {
    const ab = GEN_ABBR[gender];
    const push = (sec, d) => slots.push({
      id: ++id, block: 'showcase', blockLabel: 'Showcase da home', gender, section: sec,
      key: d.key, label: d.label, dims: DIMS[sec], width: DIMS[sec][0], height: DIMS[sec][1], ratio: RATIO[sec],
      category: (SHOWCASE_CAT[gender] || {})[d.key] || '', asset: `${sec === 'banner' ? 'st-ban' : 'st-vit'}-${ab}-${d.key}`,
      file: `${sec === 'banner' ? 'st-ban' : 'st-vit'}-${ab}-${d.key}.webp`, filter: d.filter, engine: true,
    });
    for (const d of SHOWCASE.card) push('card', d);
    for (const d of SHOWCASE.wide) push('wide', d);
    for (const d of SHOWCASE.banner) push('banner', d);
  }

  // BLOCOS 2+ — demais
  for (const b of BLOCKS) {
    const genders = b.gender === 'gender' ? GENDERS : [b.gender];
    for (const g of genders) {
      const ab = g === 'shared' ? null : GEN_ABBR[g];
      for (let i = 1; i <= b.count; i++) {
        const name = ab ? `${b.asset}-${ab}-${i}` : `${b.asset}-${i}`;
        slots.push({
          id: ++id, block: b.block, blockLabel: b.label, gender: g, section: b.section,
          key: `${b.block}-${ab || 'sh'}-${i}`, label: `${b.label} ${i}`,
          dims: b.dims, width: b.dims ? b.dims[0] : null, height: b.dims ? b.dims[1] : null, ratio: ratioOf(b.dims),
          category: '', asset: name, file: b.dims ? `${name}.webp` : '', filter: b.filter || {},
          engine: b.engine, planned: !!b.planned,
        });
      }
    }
  }
  return slots;
}

const SLOTS = buildSlots();

// Resumo por bloco (pro Mapeador e a tela)
function blockSummary() {
  const map = new Map();
  for (const s of SLOTS) {
    if (!map.has(s.block)) map.set(s.block, { block: s.block, label: s.blockLabel, count: 0, dims: s.dims, engine: s.engine, planned: !!s.planned });
    map.get(s.block).count++;
  }
  return [...map.values()];
}

module.exports = { SLOTS, GENDERS, DIMS, RATIO, BLOCKS, NOTES, blockSummary };
