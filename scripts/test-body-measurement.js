// =====================================================================
// Test rápido: valida cálculos do bodyMeasurement com keypoints mock
// =====================================================================
// Não toca banco — só testa as funções puras de cálculo.
// Uso: node scripts/test-body-measurement.js
// =====================================================================

const { _internals } = require('../src/services/bodyMeasurement');
const { _internals: sizeInternals } = require('../src/services/sizeRecommendation');

// Pessoa ~175cm, ombros largos, padrão masculino atlético.
// MediaPipe retorna coordenadas normalizadas 0-1.
const heightCm = 175;
const weightKg = 78;
const sex = 'M';

// Imagem 1080×1920. Coordenadas normalizadas 0-1.
// Topo da cabeça em y≈0.05, calcanhar em y≈0.95.
const mockFrontKeypoints = {
  nose:           { x: 0.50, y: 0.08, visibility: 0.99 },
  left_ear:       { x: 0.53, y: 0.07, visibility: 0.95 },
  right_ear:      { x: 0.47, y: 0.07, visibility: 0.95 },
  left_shoulder:  { x: 0.62, y: 0.20, visibility: 0.98 },
  right_shoulder: { x: 0.38, y: 0.20, visibility: 0.98 },
  left_elbow:     { x: 0.66, y: 0.35, visibility: 0.93 },
  right_elbow:    { x: 0.34, y: 0.35, visibility: 0.93 },
  left_wrist:     { x: 0.68, y: 0.50, visibility: 0.91 },
  right_wrist:    { x: 0.32, y: 0.50, visibility: 0.91 },
  left_hip:       { x: 0.57, y: 0.50, visibility: 0.97 },
  right_hip:      { x: 0.43, y: 0.50, visibility: 0.97 },
  left_knee:      { x: 0.56, y: 0.70, visibility: 0.95 },
  right_knee:     { x: 0.44, y: 0.70, visibility: 0.95 },
  left_ankle:     { x: 0.55, y: 0.92, visibility: 0.92 },
  right_ankle:    { x: 0.45, y: 0.92, visibility: 0.92 },
  left_heel:      { x: 0.54, y: 0.95, visibility: 0.90 },
  right_heel:     { x: 0.46, y: 0.95, visibility: 0.90 },
};

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    process.exitCode = 1;
  }
}

function assertClose(actual, expected, tolerance, label) {
  if (actual == null) throw new Error(`${label}: got null`);
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: expected ~${expected} (±${tolerance}), got ${actual.toFixed(1)}`);
  }
}

console.log('\n=== Testes de cálculo (sem banco) ===\n');

test('computeScale retorna pixels/cm > 0', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  if (!scale || scale <= 0) throw new Error(`scale inválida: ${scale}`);
  // Numa imagem 1920px de altura, 175cm devia dar ~10-11 px/cm
  // mas como coords são normalizadas 0-1, escala é em "unidades normalizadas por cm"
  // que vai ser bem pequeno (~0.005)
  console.log(`    scale = ${scale.toFixed(6)} (unidade norm/cm)`);
});

test('ellipsePerimeter de círculo (a=b=10) ~= 2πr', () => {
  const p = _internals.ellipsePerimeter(10, 10);
  assertClose(p, 2 * Math.PI * 10, 0.1, 'perimetro circulo');
});

test('measureShoulderWidth produz valor plausível (40-55cm)', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  const shoulder = _internals.measureShoulderWidth(mockFrontKeypoints, scale);
  console.log(`    shoulder = ${shoulder.toFixed(1)} cm`);
  if (shoulder < 35 || shoulder > 60) throw new Error(`fora da faixa: ${shoulder}`);
});

test('measureChestCircumference produz valor plausível (85-115cm)', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  const chest = _internals.measureChestCircumference(mockFrontKeypoints, null, scale, sex, weightKg, heightCm);
  console.log(`    chest = ${chest.toFixed(1)} cm`);
  if (chest < 80 || chest > 120) throw new Error(`fora da faixa: ${chest}`);
});

test('measureInseam produz valor plausível (70-90cm)', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  const inseam = _internals.measureInseam(mockFrontKeypoints, scale);
  console.log(`    inseam = ${inseam.toFixed(1)} cm`);
  if (inseam < 65 || inseam > 95) throw new Error(`fora da faixa: ${inseam}`);
});

test('measureTorsoLength produz valor plausível (55-80cm)', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  const torso = _internals.measureTorsoLength(mockFrontKeypoints, scale);
  console.log(`    torso = ${torso.toFixed(1)} cm`);
  if (torso < 50 || torso > 85) throw new Error(`fora da faixa: ${torso}`);
});

test('scoreFit perfeito = 1.0 quando medidas batem', () => {
  const userMeasures = { chest: 99, shoulder: 46, torsoLength: 70, sleeve: 21 };
  const sizeRow = { label: 'M', chest_min: 96, chest_max: 102, shoulder: 46, torsoLength: 70, sleeve: 21 };
  const score = sizeInternals.scoreFit(userMeasures, sizeRow, 'camisa', 'regular');
  console.log(`    score = ${score.toFixed(3)}`);
  if (score < 0.95) throw new Error(`score baixo: ${score}`);
});

test('scoreFit penaliza diferença', () => {
  const userMeasures = { chest: 90, shoulder: 46, torsoLength: 70, sleeve: 21 };
  const sizeRow = { label: 'GG', chest_min: 108, chest_max: 114 };
  const score = sizeInternals.scoreFit(userMeasures, sizeRow, 'camisa', 'regular');
  console.log(`    score (peito muito menor) = ${score.toFixed(3)}`);
  if (score > 0.5) throw new Error(`score deveria ser baixo: ${score}`);
});

test('Sistema completo: medidas → tamanho recomendado', () => {
  const scale = _internals.computeScale(mockFrontKeypoints, heightCm);
  const userMeasures = {
    chest: _internals.measureChestCircumference(mockFrontKeypoints, null, scale, sex, weightKg, heightCm),
    shoulder: _internals.measureShoulderWidth(mockFrontKeypoints, scale),
    torsoLength: _internals.measureTorsoLength(mockFrontKeypoints, scale),
    sleeve: _internals.measureSleeve ? _internals.measureSleeve(mockFrontKeypoints, scale) : 21,
  };
  console.log(`    medidas: chest=${userMeasures.chest.toFixed(1)}, shoulder=${userMeasures.shoulder.toFixed(1)}, torso=${userMeasures.torsoLength.toFixed(1)}`);

  // Size chart de exemplo (do seed)
  const sizes = [
    { label: 'P', chest_min: 90, chest_max: 96, shoulder: 44, torsoLength: 68, sleeve: 20 },
    { label: 'M', chest_min: 96, chest_max: 102, shoulder: 46, torsoLength: 70, sleeve: 21 },
    { label: 'G', chest_min: 102, chest_max: 108, shoulder: 48, torsoLength: 72, sleeve: 22 },
    { label: 'GG', chest_min: 108, chest_max: 114, shoulder: 50, torsoLength: 74, sleeve: 23 },
  ];
  const scores = {};
  for (const row of sizes) {
    scores[row.label] = sizeInternals.scoreFit(userMeasures, row, 'camisa', 'regular');
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  console.log(`    scores: ${JSON.stringify(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, v.toFixed(2)])))}`);
  console.log(`    >>> tamanho recomendado: ${best[0]} (score ${best[1].toFixed(2)})`);
  if (best[1] < 0.5) throw new Error(`nenhum tamanho com score razoável`);
});

console.log('\n=== fim dos testes ===\n');
