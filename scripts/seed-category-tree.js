// =====================================================================
// seed-category-tree.js — cria a árvore inicial de categorias
// =====================================================================
// Baseado no arquivo ARQUITETURA DE CATEGORIAS.txt do Douglas.
// Estrutura: CATEGORY → SUBCATEGORY → MODALITY → SPECIALTY
//
// Idempotente: pula nó se já existe com mesmo (parentId, name, level).
// =====================================================================
try {
  const env = require('fs').readFileSync('.env', 'utf8');
  env.split('\n').forEach(l => {
    const m = l.match(/^([^=#]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
} catch {}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Árvore literal (espelho do txt do Douglas)
const TREE = [
  ['Tênis', [
    ['Tamanhos', []],
    ['Feminino', [
      ['Corrida', ['Iniciante', 'Caminhada', 'Custo Benefício', 'Confortável', 'Trail', 'Super Amortecimento', 'Super Leve', 'Super Treino', 'Super Tênis', 'Super Trail']],
      ['LifeStyle', ['Casual', 'Clássico', 'Premium']],
      ['Musculação/Crossfit', ['Sapatilha de Treino', 'Treino Leve', 'Treino de Força', 'Treino Pro']],
      ['Recuperação Muscular', []],
      ['StreetWear', []],
      ['Sandálias', []],
    ]],
    ['Homem', [
      ['Corrida', ['Iniciante', 'Caminhada', 'Custo Benefício', 'Confortável', 'Trail', 'Super Amortecimento', 'Super Leve', 'Super Treino', 'Super Tênis', 'Super Trail']],
      ['LifeStyle', ['Casual', 'Clássico', 'Premium']],
      ['Musculação/Crossfit', ['Sapatilha de Treino', 'Treino Leve', 'Treino de Força', 'Treino Pro']],
      ['Recuperação Muscular', []],
      ['StreetWear', []],
      ['Sandálias', []],
    ]],
    ['Menina', [
      ['LifeStyle', ['Casual', 'Clássico']],
    ]],
    ['Menino', [
      ['LifeStyle', ['Casual', 'Clássico']],
    ]],
  ]],
  ['Chuteiras', [
    ['Tamanhos', []],
    ['Homem', [
      ['Futsal', ['Iniciante', 'Treino', 'Profissional']],
      ['Society', ['Iniciante', 'Treino', 'Profissional']],
      ['Campo', ['Iniciante', 'Treino', 'Profissional']],
    ]],
    ['Menino', [
      ['Futsal', ['Iniciante', 'Treino', 'Profissional']],
      ['Society', ['Iniciante', 'Treino', 'Profissional']],
      ['Campo', ['Iniciante', 'Treino', 'Profissional']],
    ]],
  ]],
  ['Vestuário', [
    ['Tamanhos', []],
    ['Mulher', []],
    ['Homem', []],
  ]],
  ['Acessórios', [
    ['Tamanhos', []],
    ['Mulher', []],
    ['Homem', []],
  ]],
  ['Dropper', []],
];

async function ensure(parentId, name, level, position) {
  // Idempotente: busca primeiro
  const existing = await prisma.categoryNode.findFirst({
    where: { parentId: parentId || null, name, level },
  });
  if (existing) return existing;
  return prisma.categoryNode.create({
    data: { parentId: parentId || null, name, level, position },
  });
}

async function walk(node, parentId, level) {
  const [name, children] = Array.isArray(node) ? node : [node, []];
  // children pode ser array de strings (folhas) ou array aninhado
  const created = await ensure(parentId, name, level, 0);
  if (!Array.isArray(children) || children.length === 0) return;

  const nextLevel = nextLevelOf(level);
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (typeof c === 'string') {
      await ensure(created.id, c, nextLevel, i);
    } else {
      await walk(c, created.id, nextLevel);
    }
  }
}

function nextLevelOf(level) {
  if (level === 'CATEGORY') return 'SUBCATEGORY';
  if (level === 'SUBCATEGORY') return 'MODALITY';
  if (level === 'MODALITY') return 'SPECIALTY';
  return 'SPECIALTY';
}

(async () => {
  console.log('Seed da árvore de categorias...');
  for (let i = 0; i < TREE.length; i++) {
    await walk(TREE[i], null, 'CATEGORY');
  }
  const total = await prisma.categoryNode.count();
  console.log('✓ árvore criada. Total nós:', total);
  // Mostra resumo
  const byLevel = await prisma.$queryRaw`
    SELECT level, COUNT(*)::int qty FROM "CategoryNode" GROUP BY level ORDER BY
      CASE level WHEN 'CATEGORY' THEN 1 WHEN 'SUBCATEGORY' THEN 2 WHEN 'MODALITY' THEN 3 ELSE 4 END`;
  byLevel.forEach(r => console.log('  ' + r.level + ':', r.qty));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('ERRO:', e); await prisma.$disconnect(); process.exit(1); });
