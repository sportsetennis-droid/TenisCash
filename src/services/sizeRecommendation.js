// =====================================================================
// Size Recommendation — recomenda tamanho de roupa com base nas medidas
// =====================================================================
// Dado um BodyScan e um Product (vestuário), busca a SizeChart aplicável
// e retorna o tamanho que melhor encaixa nas medidas do cliente.
//
// Cascata de fallback:
//   1. SizeChart específico do Product (productId)
//   2. SizeChart da brand + garmentType + gender
//   3. SizeChart genérico (brand=null) por garmentType + gender
//   4. SizeChart genérico ignorando gender
//
// Função de scoring: pondera medidas por tipo de peça. Pra cada tamanho,
// calcula "quão dentro da faixa" cada medida está (1.0 se dentro, decresce
// linearmente fora). Retorna o de maior score + alternativa se borderline.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Pesos por tipo de peça — qual medida é mais importante pra esse garment
const FIT_WEIGHTS = {
  camisa: { chest: 0.5, shoulder: 0.2, torsoLength: 0.2, sleeve: 0.1 },
  regata: { chest: 0.55, shoulder: 0.25, torsoLength: 0.2 },
  moletom: { chest: 0.45, shoulder: 0.2, torsoLength: 0.2, sleeve: 0.15 },
  jaleco: { chest: 0.4, shoulder: 0.2, torsoLength: 0.25, sleeve: 0.15 },
  calca: { waist: 0.4, hip: 0.3, inseam: 0.3 },
  short: { waist: 0.6, hip: 0.4 },
  bermuda: { waist: 0.6, hip: 0.4 },
};

const DEFAULT_WEIGHTS = { chest: 0.4, waist: 0.3, hip: 0.3 };

// Tolerância: quantos cm de desvio reduz o score em 1.0
const TOLERANCE_CM = 6;

/**
 * Busca o SizeChart mais específico aplicável a um produto.
 */
async function findApplicableSizeChart(product) {
  if (!product) return null;

  // 1. Específico do produto
  let chart = await prisma.sizeChart.findFirst({
    where: { productId: product.id, status: 'approved' },
    orderBy: { updatedAt: 'desc' },
  });
  if (chart) return chart;

  if (!product.garmentType) return null;

  // 2. Brand + garmentType + gender
  if (product.brand) {
    chart = await prisma.sizeChart.findFirst({
      where: {
        brand: product.brand,
        garmentType: product.garmentType,
        status: 'approved',
        ...(productGender(product) ? { gender: productGender(product) } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (chart) return chart;
  }

  // 3. Genérico (brand=null) por garmentType + gender
  chart = await prisma.sizeChart.findFirst({
    where: {
      brand: null,
      garmentType: product.garmentType,
      status: 'approved',
      ...(productGender(product) ? { gender: productGender(product) } : {}),
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (chart) return chart;

  // 4. Genérico ignorando gender
  chart = await prisma.sizeChart.findFirst({
    where: {
      brand: null,
      garmentType: product.garmentType,
      status: 'approved',
    },
    orderBy: { updatedAt: 'desc' },
  });
  return chart;
}

function productGender(product) {
  // Tenta inferir gênero do produto a partir do features JSON ou subcategory
  if (product.features && typeof product.features === 'object') {
    const g = product.features.gender || product.features.genero;
    if (g) {
      const norm = String(g).toLowerCase();
      if (norm.startsWith('masc') || norm === 'm') return 'M';
      if (norm.startsWith('fem') || norm === 'f') return 'F';
      if (norm.startsWith('uni') || norm === 'u') return 'U';
    }
  }
  return null;
}

/**
 * Calcula score de fit pra um tamanho específico.
 * sizeRow: { label, chest_min, chest_max, waist_min, waist_max, ... }
 * userMeasures: { chest: 96, waist: 80, ... } em cm
 */
function scoreFit(userMeasures, sizeRow, garmentType, fitProfile = 'regular') {
  const weights = FIT_WEIGHTS[garmentType] || DEFAULT_WEIGHTS;
  let totalScore = 0;
  let totalWeight = 0;

  for (const [measure, weight] of Object.entries(weights)) {
    const userVal = userMeasures[measure];
    if (userVal == null) continue;

    // Lê faixa do sizeRow. Aceita {measure_min, measure_max} ou {measure: valor central}
    let minVal = sizeRow[`${measure}_min`];
    let maxVal = sizeRow[`${measure}_max`];
    if (minVal == null && maxVal == null && sizeRow[measure] != null) {
      // valor único: ±3% como faixa
      const center = Number(sizeRow[measure]);
      minVal = center * 0.97;
      maxVal = center * 1.03;
    }
    if (minVal == null && maxVal == null) continue;
    if (minVal == null) minVal = maxVal * 0.94;
    if (maxVal == null) maxVal = minVal * 1.06;

    // Ajuste por fit profile
    let targetMin = minVal;
    let targetMax = maxVal;
    if (fitProfile === 'slim') {
      targetMax = minVal + (maxVal - minVal) * 0.4; // prefere ponta inferior da faixa
    } else if (fitProfile === 'oversized') {
      targetMin = maxVal + 2; // prefere pelo menos um tamanho acima
      targetMax = maxVal + 8;
    }

    let m;
    if (userVal >= targetMin && userVal <= targetMax) {
      m = 1; // perfeito
    } else {
      const distance = userVal < targetMin ? (targetMin - userVal) : (userVal - targetMax);
      m = Math.max(0, 1 - distance / TOLERANCE_CM);
    }

    totalScore += m * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 0;
  return totalScore / totalWeight;
}

/**
 * Constrói uma explicação humana da recomendação.
 */
function buildReasoning(userMeasures, sizeRow, garmentType) {
  if (!sizeRow) return null;
  const weights = FIT_WEIGHTS[garmentType] || DEFAULT_WEIGHTS;
  // Pega a medida com maior peso pra explicar
  const primary = Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0];
  const userVal = userMeasures[primary];
  if (!userVal) return `Tamanho ${sizeRow.label} foi recomendado com base em ${Object.keys(weights).join(', ')}.`;

  const min = sizeRow[`${primary}_min`] ?? sizeRow[primary] * 0.97;
  const max = sizeRow[`${primary}_max`] ?? sizeRow[primary] * 1.03;
  const label = { chest: 'peito', waist: 'cintura', hip: 'quadril', shoulder: 'ombro', sleeve: 'manga', inseam: 'entrepernas' }[primary] || primary;
  return `Seu ${label} de ${Math.round(userVal)}cm encaixa na faixa ${Math.round(min)}-${Math.round(max)}cm do tamanho ${sizeRow.label}.`;
}

/**
 * Recomenda tamanho pra um produto.
 *
 * @param {Object} input
 * @param {string} input.scanId
 * @param {string} input.productId
 * @param {string} [input.fitProfile] - "slim" | "regular" | "oversized"
 * @param {boolean} [input.persist=true] - se grava o SizeRecommendation
 *
 * @returns {Promise<{ok, recommendedSize, alternativeSize?, scores, confidence, reasoning, needsSizeChart?}>}
 */
async function recommendSize(input) {
  const { scanId, productId, fitProfile = 'regular', persist = true } = input;
  if (!scanId || !productId) return { ok: false, error: 'scanId e productId obrigatórios' };

  const scan = await prisma.bodyScan.findUnique({
    where: { id: scanId },
    include: { measurements: true },
  });
  if (!scan) return { ok: false, error: 'scan não encontrado' };

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { ok: false, error: 'produto não encontrado' };

  if (!product.garmentType) {
    return { ok: false, error: 'produto não é vestuário (sem garmentType)' };
  }

  const chart = await findApplicableSizeChart(product);
  if (!chart) {
    return {
      ok: false,
      error: 'sem tabela de medidas pra esse produto',
      needsSizeChart: true,
      garmentType: product.garmentType,
      brand: product.brand,
    };
  }

  const userMeasures = Object.fromEntries(
    scan.measurements.map((m) => [m.measureType, m.valueCm])
  );

  // Calcular score por tamanho
  const sizes = Array.isArray(chart.sizes) ? chart.sizes : [];
  if (sizes.length === 0) return { ok: false, error: 'size chart vazia' };

  const scores = {};
  for (const row of sizes) {
    if (!row.label) continue;
    scores[row.label] = scoreFit(userMeasures, row, product.garmentType, fitProfile);
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return { ok: false, error: 'nenhum tamanho pontuou' };

  const [bestSize, bestScore] = ranked[0];
  const [altSize, altScore] = ranked[1] || [null, 0];
  const hasAlternative = altScore > 0.6 && bestScore - altScore < 0.15;

  const bestRow = sizes.find((s) => s.label === bestSize);
  const reasoning = buildReasoning(userMeasures, bestRow, product.garmentType);

  // Persistir
  let recommendationId;
  if (persist) {
    const rec = await prisma.sizeRecommendation.create({
      data: {
        userId: scan.userId,
        scanId,
        productId,
        sizeChartId: chart.id,
        recommendedSize: bestSize,
        alternativeSize: hasAlternative ? altSize : null,
        fitProfile,
        scores,
        reasoning,
      },
    });
    recommendationId = rec.id;
  }

  return {
    ok: true,
    recommendationId,
    recommendedSize: bestSize,
    alternativeSize: hasAlternative ? altSize : null,
    confidence: Math.round(bestScore * 100) / 100,
    scores,
    reasoning,
    chartSource: { id: chart.id, brand: chart.brand, garmentType: chart.garmentType, source: chart.source },
  };
}

/**
 * Registra feedback do cliente após compra (fechando o loop).
 */
async function recordFeedback(input) {
  const { recommendationId, actualBoughtSize, fitFeedback } = input;
  if (!recommendationId) return { ok: false, error: 'recommendationId obrigatório' };

  const rec = await prisma.sizeRecommendation.update({
    where: { id: recommendationId },
    data: {
      actualBoughtSize: actualBoughtSize ?? null,
      fitFeedback: fitFeedback ?? null,
      feedbackAt: new Date(),
    },
  });
  return { ok: true, recommendationId: rec.id };
}

module.exports = {
  recommendSize,
  recordFeedback,
  findApplicableSizeChart,
  _internals: { scoreFit, buildReasoning, FIT_WEIGHTS },
};
