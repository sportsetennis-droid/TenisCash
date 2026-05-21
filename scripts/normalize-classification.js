// =====================================================================
// normalize-classification.js — padroniza gender/modality/tier em aiContext
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

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => {
  if (v.startsWith('--')) acc.push([v.slice(2), a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true]);
  return acc;
}, []));
const DRY = args.dry || (!args.apply);

// Tabelas de normalização (matched case-insensitive)
const GENDER_MAP = {
  'menina': 'Menina',
  'inf. f': 'Menina',
  'inf f': 'Menina',
  'infantil f': 'Menina',
  'infantil feminino': 'Menina',
  'menino': 'Menino',
  'inf. m': 'Menino',
  'inf m': 'Menino',
  'infantil m': 'Menino',
  'infantil masculino': 'Menino',
  'masculino': 'Homem',
  'homem': 'Homem',
  'feminino': 'Mulher',
  'mulher': 'Mulher',
  'unissex': 'Unissex',
};

const MODALITY_MAP = {
  'corrida': 'Corrida',
  'caminhada': 'Caminhada',
  'caminhada / treino leve': 'Caminhada',
  'lifestyle': 'LifeStyle',
  'recuperação': 'Recuperação Muscular',
  'recuperação muscular': 'Recuperação Muscular',
  'musculação/crossfit': 'Musculação/Crossfit',
  'musculação / crossfit / hyrox': 'Musculação/Crossfit',
  'musculação / crossfit': 'Musculação/Crossfit',
  'crossfit': 'Musculação/Crossfit',
  'sapatilha': 'Sapatilha',
  'streetwear': 'StreetWear',
  'futsal': 'Futsal',
  'society': 'Society',
  'campo': 'Campo',
  'sandálias': 'Sandálias',
  'sandalias': 'Sandálias',
};

const TIER_MAP = {
  'iniciante': 'Iniciante',
  'entrada': 'Iniciante',
  'casual': 'Casual',
  'pau pra toda obra': 'Casual',
  'confortável': 'Confortável',
  'confortavel': 'Confortável',
  'conforto': 'Confortável',
  'máximo conforto': 'Confortável',
  'maximo conforto': 'Confortável',
  'custo benefício': 'Custo Benefício',
  'custo beneficio': 'Custo Benefício',
  'conforto benefício': 'Custo Benefício',
  'conforto beneficio': 'Custo Benefício',
  'treino': 'Treino',
  'intermediário': 'Treino',
  'intermediario': 'Treino',
  'treino de força': 'Treino de Força',
  'treino de forca': 'Treino de Força',
  'profissional': 'Profissional',
  'pro': 'Profissional',
  'pró': 'Profissional',
  'premium': 'Premium',
  'super tênis': 'Super Tênis',
  'super tenis': 'Super Tênis',
  'maratona': 'Super Tênis',
  'super trail': 'Super Trail',
  'super leve': 'Super Leve',
  'velocidade': 'Super Leve',
  'super amortecimento': 'Super Amortecimento',
  'super treino': 'Super Treino',
  'trail': 'Trail',
  'caminhada': 'Caminhada',
  'clássico': 'Clássico',
  'classico': 'Clássico',
  'sapatilha de treino': 'Sapatilha de Treino',
};

function normalize(value, map) {
  if (!value) return null;
  const key = String(value).toLowerCase().trim();
  return map[key] || value; // se não conhece, mantém
}

(async () => {
  console.log('\n=== Normaliza gender/modality/tier ===');
  console.log('Modo:', DRY ? 'DRY-RUN' : 'APPLY');

  const products = await prisma.$queryRaw`
    SELECT id, "aiContext"::text as ctx FROM "Product" WHERE active=true AND "aiContext" IS NOT NULL
  `;
  console.log('Produtos ativos com aiContext:', products.length);

  let updated = 0;
  const stats = { gender: 0, modality: 0, tier: 0 };

  for (const p of products) {
    let ctx;
    try { ctx = JSON.parse(p.ctx); } catch { continue; }
    if (!ctx.classification) ctx.classification = {};

    let changed = false;
    // gender pode estar em ctx.gender OU ctx.classification.gender
    const rawGender = ctx.classification.gender || ctx.gender;
    if (rawGender) {
      const norm = normalize(rawGender, GENDER_MAP);
      if (norm && norm !== rawGender) {
        ctx.classification.gender = norm;
        if (ctx.gender) ctx.gender = norm;
        changed = true; stats.gender++;
      } else if (norm) {
        ctx.classification.gender = norm;
        if (ctx.gender) ctx.gender = norm;
      }
    }
    const rawMod = ctx.classification.modality;
    if (rawMod) {
      const norm = normalize(rawMod, MODALITY_MAP);
      if (norm && norm !== rawMod) {
        ctx.classification.modality = norm;
        changed = true; stats.modality++;
      }
    }
    const rawTier = ctx.classification.tier;
    if (rawTier) {
      const norm = normalize(rawTier, TIER_MAP);
      if (norm && norm !== rawTier) {
        ctx.classification.tier = norm;
        changed = true; stats.tier++;
      }
    }

    if (changed) {
      if (!DRY) await prisma.product.update({ where: { id: p.id }, data: { aiContext: ctx } });
      updated++;
    }
  }

  console.log('Produtos com normalizações:', updated);
  console.log('  Gender ajustados:  ', stats.gender);
  console.log('  Modality ajustados:', stats.modality);
  console.log('  Tier ajustados:    ', stats.tier);

  // Stats finais
  const g = await prisma.$queryRaw`SELECT "aiContext"::jsonb->'classification'->>'gender' as v, count(*)::int as c FROM "Product" WHERE active=true GROUP BY 1 ORDER BY c DESC`;
  console.log('\nGender FINAL:'); g.forEach(x => console.log('  ' + (x.v || '(null)').padEnd(20) + ': ' + x.c));
  const m = await prisma.$queryRaw`SELECT "aiContext"::jsonb->'classification'->>'modality' as v, count(*)::int as c FROM "Product" WHERE active=true GROUP BY 1 ORDER BY c DESC`;
  console.log('\nModality FINAL:'); m.forEach(x => console.log('  ' + (x.v || '(null)').padEnd(25) + ': ' + x.c));
  const t = await prisma.$queryRaw`SELECT "aiContext"::jsonb->'classification'->>'tier' as v, count(*)::int as c FROM "Product" WHERE active=true GROUP BY 1 ORDER BY c DESC`;
  console.log('\nTier FINAL:'); t.forEach(x => console.log('  ' + (x.v || '(null)').padEnd(25) + ': ' + x.c));

  await prisma.$disconnect();
})().catch(async e => { console.error('FATAL:', e); await prisma.$disconnect(); process.exit(1); });
