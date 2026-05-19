// =====================================================================
// Seed: tabelas de medidas genéricas pra MVP do sistema de recomendação
// =====================================================================
// Cria SizeCharts genéricas (brand=null, status=approved) pra cada
// combinação garmentType × gender. Servem como fallback quando o produto
// não tem chart específico da marca.
//
// Uso: node scripts/seed-size-charts.js
//      node scripts/seed-size-charts.js --reset  (apaga genéricas existentes antes)
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Tabelas baseadas em padrões ABNT NBR 13377/16060 + cross-check com
// marcas esportivas brasileiras (Olympikus, Penalty, Topper) e internacionais
// (Nike, Adidas). Faixas em cm.

const CHARTS = [
  // =========================================================
  // CAMISA MASCULINA
  // =========================================================
  {
    brand: null, garmentType: 'camisa', gender: 'M',
    sizes: [
      { label: 'PP', chest_min: 84, chest_max: 90, shoulder: 42, torsoLength: 66, sleeve: 19, neck_min: 35, neck_max: 37 },
      { label: 'P', chest_min: 90, chest_max: 96, shoulder: 44, torsoLength: 68, sleeve: 20, neck_min: 37, neck_max: 39 },
      { label: 'M', chest_min: 96, chest_max: 102, shoulder: 46, torsoLength: 70, sleeve: 21, neck_min: 39, neck_max: 41 },
      { label: 'G', chest_min: 102, chest_max: 108, shoulder: 48, torsoLength: 72, sleeve: 22, neck_min: 41, neck_max: 43 },
      { label: 'GG', chest_min: 108, chest_max: 114, shoulder: 50, torsoLength: 74, sleeve: 23, neck_min: 43, neck_max: 45 },
      { label: 'XGG', chest_min: 114, chest_max: 122, shoulder: 52, torsoLength: 76, sleeve: 24, neck_min: 45, neck_max: 47 },
    ],
  },
  // =========================================================
  // CAMISA FEMININA
  // =========================================================
  {
    brand: null, garmentType: 'camisa', gender: 'F',
    sizes: [
      { label: 'PP', chest_min: 78, chest_max: 84, shoulder: 38, torsoLength: 60 },
      { label: 'P', chest_min: 84, chest_max: 90, shoulder: 40, torsoLength: 62 },
      { label: 'M', chest_min: 90, chest_max: 96, shoulder: 42, torsoLength: 64 },
      { label: 'G', chest_min: 96, chest_max: 102, shoulder: 44, torsoLength: 66 },
      { label: 'GG', chest_min: 102, chest_max: 110, shoulder: 46, torsoLength: 68 },
    ],
  },
  // =========================================================
  // CAMISA UNISSEX (caimento mais reto, varia menos por gênero)
  // =========================================================
  {
    brand: null, garmentType: 'camisa', gender: 'U',
    sizes: [
      { label: 'PP', chest_min: 84, chest_max: 92, shoulder: 42, torsoLength: 66 },
      { label: 'P', chest_min: 92, chest_max: 98, shoulder: 44, torsoLength: 69 },
      { label: 'M', chest_min: 98, chest_max: 104, shoulder: 46, torsoLength: 71 },
      { label: 'G', chest_min: 104, chest_max: 110, shoulder: 48, torsoLength: 73 },
      { label: 'GG', chest_min: 110, chest_max: 118, shoulder: 50, torsoLength: 75 },
    ],
  },
  // =========================================================
  // REGATA MASCULINA
  // =========================================================
  {
    brand: null, garmentType: 'regata', gender: 'M',
    sizes: [
      { label: 'P', chest_min: 90, chest_max: 96, shoulder: 40, torsoLength: 68 },
      { label: 'M', chest_min: 96, chest_max: 102, shoulder: 42, torsoLength: 70 },
      { label: 'G', chest_min: 102, chest_max: 108, shoulder: 44, torsoLength: 72 },
      { label: 'GG', chest_min: 108, chest_max: 116, shoulder: 46, torsoLength: 74 },
    ],
  },
  // =========================================================
  // REGATA FEMININA
  // =========================================================
  {
    brand: null, garmentType: 'regata', gender: 'F',
    sizes: [
      { label: 'P', chest_min: 84, chest_max: 90, shoulder: 36, torsoLength: 60 },
      { label: 'M', chest_min: 90, chest_max: 96, shoulder: 38, torsoLength: 62 },
      { label: 'G', chest_min: 96, chest_max: 102, shoulder: 40, torsoLength: 64 },
      { label: 'GG', chest_min: 102, chest_max: 110, shoulder: 42, torsoLength: 66 },
    ],
  },
  // =========================================================
  // CALÇA MASCULINA
  // =========================================================
  {
    brand: null, garmentType: 'calca', gender: 'M',
    sizes: [
      { label: '38', waist_min: 70, waist_max: 74, hip_min: 88, hip_max: 92, inseam: 78 },
      { label: '40', waist_min: 74, waist_max: 78, hip_min: 92, hip_max: 96, inseam: 79 },
      { label: '42', waist_min: 78, waist_max: 82, hip_min: 96, hip_max: 100, inseam: 80 },
      { label: '44', waist_min: 82, waist_max: 86, hip_min: 100, hip_max: 104, inseam: 81 },
      { label: '46', waist_min: 86, waist_max: 90, hip_min: 104, hip_max: 108, inseam: 82 },
      { label: '48', waist_min: 90, waist_max: 94, hip_min: 108, hip_max: 112, inseam: 83 },
      { label: '50', waist_min: 94, waist_max: 98, hip_min: 112, hip_max: 116, inseam: 84 },
    ],
  },
  // =========================================================
  // CALÇA FEMININA
  // =========================================================
  {
    brand: null, garmentType: 'calca', gender: 'F',
    sizes: [
      { label: '36', waist_min: 62, waist_max: 66, hip_min: 86, hip_max: 90, inseam: 74 },
      { label: '38', waist_min: 66, waist_max: 70, hip_min: 90, hip_max: 94, inseam: 75 },
      { label: '40', waist_min: 70, waist_max: 74, hip_min: 94, hip_max: 98, inseam: 76 },
      { label: '42', waist_min: 74, waist_max: 78, hip_min: 98, hip_max: 102, inseam: 77 },
      { label: '44', waist_min: 78, waist_max: 82, hip_min: 102, hip_max: 106, inseam: 78 },
      { label: '46', waist_min: 82, waist_max: 86, hip_min: 106, hip_max: 110, inseam: 79 },
    ],
  },
  // =========================================================
  // SHORT / BERMUDA MASCULINO
  // =========================================================
  {
    brand: null, garmentType: 'short', gender: 'M',
    sizes: [
      { label: 'P', waist_min: 70, waist_max: 78, hip_min: 88, hip_max: 96 },
      { label: 'M', waist_min: 78, waist_max: 86, hip_min: 96, hip_max: 104 },
      { label: 'G', waist_min: 86, waist_max: 94, hip_min: 104, hip_max: 112 },
      { label: 'GG', waist_min: 94, waist_max: 102, hip_min: 112, hip_max: 120 },
    ],
  },
  // =========================================================
  // SHORT / BERMUDA FEMININO
  // =========================================================
  {
    brand: null, garmentType: 'short', gender: 'F',
    sizes: [
      { label: 'P', waist_min: 62, waist_max: 70, hip_min: 86, hip_max: 94 },
      { label: 'M', waist_min: 70, waist_max: 78, hip_min: 94, hip_max: 102 },
      { label: 'G', waist_min: 78, waist_max: 86, hip_min: 102, hip_max: 110 },
      { label: 'GG', waist_min: 86, waist_max: 94, hip_min: 110, hip_max: 118 },
    ],
  },
  // =========================================================
  // JALECO UNISSEX (referência: padrão hospitalar)
  // =========================================================
  {
    brand: null, garmentType: 'jaleco', gender: 'U',
    sizes: [
      { label: 'P', chest_min: 90, chest_max: 98, shoulder: 44, torsoLength: 82, sleeve: 56 },
      { label: 'M', chest_min: 98, chest_max: 106, shoulder: 46, torsoLength: 84, sleeve: 58 },
      { label: 'G', chest_min: 106, chest_max: 114, shoulder: 48, torsoLength: 86, sleeve: 60 },
      { label: 'GG', chest_min: 114, chest_max: 124, shoulder: 50, torsoLength: 88, sleeve: 62 },
    ],
  },
  // =========================================================
  // MOLETOM UNISSEX
  // =========================================================
  {
    brand: null, garmentType: 'moletom', gender: 'U',
    sizes: [
      { label: 'P', chest_min: 92, chest_max: 100, shoulder: 46, torsoLength: 70, sleeve: 60 },
      { label: 'M', chest_min: 100, chest_max: 108, shoulder: 48, torsoLength: 72, sleeve: 62 },
      { label: 'G', chest_min: 108, chest_max: 116, shoulder: 50, torsoLength: 74, sleeve: 64 },
      { label: 'GG', chest_min: 116, chest_max: 126, shoulder: 52, torsoLength: 76, sleeve: 66 },
    ],
  },
];

async function main() {
  const reset = process.argv.includes('--reset');

  if (reset) {
    const del = await prisma.sizeChart.deleteMany({
      where: { brand: null, source: 'manual' },
    });
    console.log(`Removidas ${del.count} charts genéricas anteriores.`);
  }

  let created = 0;
  let skipped = 0;

  for (const c of CHARTS) {
    const existing = await prisma.sizeChart.findFirst({
      where: {
        brand: null,
        garmentType: c.garmentType,
        gender: c.gender,
        productId: null,
        supplierId: null,
      },
    });
    if (existing && !reset) {
      skipped++;
      console.log(`  → já existe: ${c.garmentType} / ${c.gender} (${existing.id})`);
      continue;
    }

    const chart = await prisma.sizeChart.create({
      data: {
        brand: null,
        garmentType: c.garmentType,
        gender: c.gender,
        sizes: c.sizes,
        source: 'manual',
        status: 'approved',
        sourceUrl: 'seed:default-charts',
        reviewedAt: new Date(),
      },
    });
    created++;
    console.log(`  ✓ ${c.garmentType} / ${c.gender}: ${c.sizes.length} tamanhos (${chart.id})`);
  }

  console.log(`\n${created} criadas, ${skipped} já existiam.`);
  console.log(`Total no banco: ${await prisma.sizeChart.count()}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
