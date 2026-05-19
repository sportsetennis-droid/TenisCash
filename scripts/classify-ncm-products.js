// =====================================================================
// classify-ncm-products.js
// Classifica NCM automaticamente em todos os produtos ativos baseado em
// palavra-chave do nome/categoria/modalidade. NCMs usados pelo varejo
// esportivo brasileiro (Sports & Tennis / Baratão dos Esportes).
//
// Uso:
//   node scripts/classify-ncm-products.js [--dry-run] [--limit N]
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Tabela NCM → palavras-chave que identificam o produto.
// Ordem importa (primeira match ganha — mais específico antes do mais genérico).
const NCM_RULES = [
  // ===== CHUTEIRAS =====
  { ncm: '64031900', keywords: ['chuteira', 'campo', 'society', 'futsal'], cfop: '5102' },

  // ===== TÊNIS (calçados esportivos) =====
  { ncm: '64041100', keywords: ['tenis ', 'tenis-', 'tênis '], cfop: '5102' }, // Tênis materiais sintéticos sola borracha/plástico
  { ncm: '64041900', keywords: ['sapatilha'], cfop: '5102' },

  // ===== SANDÁLIAS E CHINELOS =====
  { ncm: '64022000', keywords: ['chinelo', 'sandalia', 'sandália'], cfop: '5102' },
  { ncm: '64041900', keywords: ['slide ', 'slide-', 'palmilha'], cfop: '5102' },

  // ===== VESTUÁRIO ESPORTIVO =====
  // Camisas/camisetas de algodão
  { ncm: '61091000', keywords: ['camisa', 'camiseta', 'polo ', 'polo-', 'regata'], cfop: '5102' },
  // Bermudas/shorts de algodão
  { ncm: '62034200', keywords: ['bermuda', 'short ', 'short-', 'calção'], cfop: '5102' },
  // Calças de algodão
  { ncm: '62034200', keywords: ['calca ', 'calça '], cfop: '5102' },
  // Agasalhos
  { ncm: '62113200', keywords: ['agasalho', 'jaqueta', 'casaco', 'moleton', 'blusa de frio'], cfop: '5102' },
  // Roupa íntima/biquinis
  { ncm: '61082100', keywords: ['biquini', 'biquíni', 'maio', 'maiô', 'sunga'], cfop: '5102' },

  // ===== MEIAS =====
  { ncm: '61159500', keywords: ['meia', 'meião', 'meiao'], cfop: '5102' },

  // ===== ACESSÓRIOS =====
  // Bonés/chapéus
  { ncm: '65050010', keywords: ['bone ', 'boné ', 'bone-', 'boné-', 'viseira', 'chapeu'], cfop: '5102' },
  // Mochilas e bolsas esportivas
  { ncm: '42029200', keywords: ['mochila', 'bolsa', 'necessaire'], cfop: '5102' },
  // Luvas esportivas
  { ncm: '95066100', keywords: ['luva goleiro', 'luva de goleiro'], cfop: '5102' },
  { ncm: '61169300', keywords: ['luva'], cfop: '5102' },
  // Caneleira
  { ncm: '95066900', keywords: ['caneleira', 'protetor de canela'], cfop: '5102' },
  // Cotoveleira/joelheira
  { ncm: '61159500', keywords: ['cotoveleira', 'joelheira', 'munhequeira', 'tornozeleira'], cfop: '5102' },
  // Faixa/headband
  { ncm: '65050010', keywords: ['faixa', 'headband', 'testeira'], cfop: '5102' },

  // ===== BOLAS =====
  { ncm: '95066200', keywords: ['bola de basquete', 'basketball', 'bola basquete'], cfop: '5102' },
  { ncm: '95066100', keywords: ['bola futebol', 'bola de futebol', 'bola society', 'bola futsal', 'bola campo'], cfop: '5102' },
  { ncm: '95066400', keywords: ['bola tenis', 'bola de tenis', 'bola tênis'], cfop: '5102' },
  { ncm: '95066900', keywords: ['bola volei', 'bola de volei', 'bola vôlei', 'bola handebol'], cfop: '5102' },
  { ncm: '95066900', keywords: ['bola '], cfop: '5102' },

  // ===== EQUIPAMENTOS =====
  { ncm: '95065100', keywords: ['raquete tenis', 'raquete de tenis', 'raquete tênis'], cfop: '5102' },
  { ncm: '95065900', keywords: ['raquete beach', 'raquete frescobol', 'raquete padel'], cfop: '5102' },
  { ncm: '95069100', keywords: ['halter', 'anilha', 'corda', 'elastico', 'abdominal'], cfop: '5102' },
  { ncm: '95069100', keywords: ['equipamento'], cfop: '5102' },

  // ===== CATEGORIA EXPLÍCITA (fallback) =====
  // Se category for "tenis", default tênis genérico
  { ncm: '64041100', categoryMatch: ['tenis', 'tênis'], cfop: '5102' },
  { ncm: '61091000', categoryMatch: ['vestuario', 'vestuário', 'roupa'], cfop: '5102' },
  { ncm: '95066900', categoryMatch: ['acessorio', 'acessório'], cfop: '5102' },
];

// NCM padrão se nada bater
const NCM_DEFAULT = '64041100'; // Tênis (a maior parte do catálogo Sports & Tennis)

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s\-\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyNcm(product) {
  const name = normalize(product.name);
  const cat = normalize(product.category);
  // Combina nome+cat pra busca
  const text = name + ' ' + cat;

  // Tenta regras por palavra-chave
  for (const rule of NCM_RULES) {
    if (rule.keywords) {
      for (const kw of rule.keywords) {
        if (text.includes(kw)) return { ncm: rule.ncm, cfop: rule.cfop, matched: kw };
      }
    }
    if (rule.categoryMatch) {
      for (const cm of rule.categoryMatch) {
        if (cat.includes(cm)) return { ncm: rule.ncm, cfop: rule.cfop, matched: 'cat:' + cm };
      }
    }
  }
  return { ncm: NCM_DEFAULT, cfop: '5102', matched: 'DEFAULT' };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;

  console.log('\n=== Classificação NCM ===');
  console.log('Modo:', dryRun ? 'DRY-RUN (não escreve no banco)' : 'APPLY');

  const products = await prisma.product.findMany({
    where: { active: true },
    select: { id: true, name: true, category: true, ncm: true, cfop: true },
  });
  console.log('Produtos ativos:', products.length, '\n');

  const stats = { withNcm: 0, withoutNcm: 0, byNcm: {}, byMatch: {} };
  const toUpdate = [];
  for (const p of products) {
    if (p.ncm) { stats.withNcm++; continue; }
    stats.withoutNcm++;
    const cls = classifyNcm(p);
    stats.byNcm[cls.ncm] = (stats.byNcm[cls.ncm] || 0) + 1;
    stats.byMatch[cls.matched] = (stats.byMatch[cls.matched] || 0) + 1;
    toUpdate.push({ id: p.id, ncm: cls.ncm, cfop: cls.cfop, name: p.name, matched: cls.matched });
  }

  console.log('Já tinham NCM:', stats.withNcm);
  console.log('Sem NCM (vão receber):', stats.withoutNcm);
  console.log('\nDistribuição por NCM:');
  Object.entries(stats.byNcm).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => {
    console.log('  ' + n + ' → ' + c + ' produtos');
  });
  console.log('\nDistribuição por match:');
  Object.entries(stats.byMatch).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([m, c]) => {
    console.log('  "' + m + '" → ' + c + ' produtos');
  });

  console.log('\nAmostra (10 primeiros):');
  toUpdate.slice(0, 10).forEach(u => {
    console.log('  [' + u.ncm + '] (' + u.matched + ') ' + u.name.slice(0, 70));
  });

  if (dryRun) { await prisma.$disconnect(); return; }

  const batch = toUpdate.slice(0, limit);
  console.log('\nAplicando NCM em', batch.length, 'produtos...');
  let done = 0;
  for (const u of batch) {
    await prisma.product.update({
      where: { id: u.id },
      data: { ncm: u.ncm, cfop: u.cfop, origem: 0, unidade: 'UN' },
    });
    done++;
    if (done % 100 === 0) process.stdout.write('  ' + done + '/' + batch.length + '\r');
  }
  console.log('\n✓ ' + done + ' produtos atualizados');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
