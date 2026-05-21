// =====================================================================
// seed-category-tree.js — arvore oficial v2 (ARQUITETURA DE CATEGORIAS.txt)
// =====================================================================
// Wipe + re-seed completo. Idempotente em re-runs.
// Estrutura: CATEGORY -> SUBCATEGORY -> MODALITY -> SPECIALTY
// Nivel SUBCATEGORY identifica genero (Feminino/Homem/Menina/Menino/Mulher/Tamanhos).
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split(/\r?\n/).forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Subramos comuns reutilizados
const TENIS_ADULT_MODS = [
  ['Corrida', ['Iniciante', 'Caminhada', 'Custo Benefício', 'Confortável', 'Trail', 'Super Amortecimento', 'Super Leve', 'Super Treino', 'Super Tênis', 'Super Trail']],
  ['LifeStyle', ['Casual', 'Clássico', 'Premium']],
  ['Musculação/Crossfit', ['Sapatilha de Treino', 'Treino Leve', 'Treino de Força', 'Treino Pro']],
  ['Recuperação Muscular', []],
  ['StreetWear', []],
  ['Sandálias', []],
];
const TENIS_KID_MODS = [
  ['LifeStyle', ['Casual', 'Clássico']], // 'Causal' do .txt corrigido pra 'Casual' (confirmado pelo Douglas)
];
const CHUTEIRA_MODS = [
  ['Futsal', ['Iniciante', 'Treino', 'Profissional']],
  ['Society', ['Iniciante', 'Treino', 'Profissional']],
  ['Campo', ['Iniciante', 'Treino', 'Profissional']],
];
const ACESSORIOS_FULL = [
  ['Meias', ['invisível', 'cano curto', 'cano médio', 'cano longo']],
  ['Joelheira', []],
  ['Cotoveleira', []],
];
const ACESSORIOS_MEIAS_ONLY = [
  ['Meias', ['invisível', 'cano curto', 'cano médio', 'cano longo']],
];

// Arvore literal v2
const TREE = [
  ['Tênis', [
    ['Tamanhos', []],
    ['Feminino', TENIS_ADULT_MODS],
    ['Homem', TENIS_ADULT_MODS],
    ['Menina', TENIS_KID_MODS],
    ['Menino', TENIS_KID_MODS],
  ]],
  ['Chuteiras', [
    ['Tamanhos', []],
    ['Homem', CHUTEIRA_MODS],
    ['Menino', CHUTEIRA_MODS],
  ]],
  ['Vestuário', [
    ['Tamanhos', []],
    ['Mulher', [
      ['Legging', []], ['Short', []], ['Bermuda', []], ['Saia', []],
      ['Top', []], ['Camiseta', []], ['Regata', []],
    ]],
    ['Homem', [
      ['Camiseta', []], ['Regata', []], ['Bermuda', []], ['Short', []], ['Calça', []],
    ]],
    ['Menina', []],
    ['Menino', []],
  ]],
  ['Acessórios', [
    ['Tamanho', []],
    ['Mulher', ACESSORIOS_FULL],
    ['Homem', ACESSORIOS_FULL],
    ['Menina', ACESSORIOS_MEIAS_ONLY],
    ['Menino', ACESSORIOS_MEIAS_ONLY],
  ]],
  ['Dropper', []],
];

(async () => {
  console.log('\n=== Wipe + seed CategoryNode (arvore v2) ===');

  const before = await prisma.categoryNode.count();
  await prisma.categoryNode.deleteMany({});
  console.log('Removidos:', before, 'nos antigos');

  let created = 0;
  async function insert(name, level, parentId) {
    const node = await prisma.categoryNode.create({ data: { name, level, parentId } });
    created++;
    return node;
  }

  for (const [catName, subs] of TREE) {
    const cat = await insert(catName, 'CATEGORY', null);
    if (!Array.isArray(subs) || !subs.length) continue;
    for (const subEntry of subs) {
      if (typeof subEntry === 'string') {
        await insert(subEntry, 'SUBCATEGORY', cat.id);
        continue;
      }
      const [subName, mods] = subEntry;
      const sub = await insert(subName, 'SUBCATEGORY', cat.id);
      if (!Array.isArray(mods) || !mods.length) continue;
      for (const modEntry of mods) {
        if (typeof modEntry === 'string') {
          await insert(modEntry, 'MODALITY', sub.id);
          continue;
        }
        const [modName, specs] = modEntry;
        const mod = await insert(modName, 'MODALITY', sub.id);
        if (!Array.isArray(specs)) continue;
        for (const specName of specs) {
          await insert(specName, 'SPECIALTY', mod.id);
        }
      }
    }
  }

  console.log('Criados:', created, 'nos novos');

  const stats = await prisma.$queryRaw`SELECT level, count(*)::int as c FROM "CategoryNode" GROUP BY level ORDER BY 1`;
  console.log('\nResumo por nivel:');
  stats.forEach(s => console.log('  ' + s.level + ': ' + s.c));

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
