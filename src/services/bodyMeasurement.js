// =====================================================================
// Body Measurement — extrai medidas corporais a partir de keypoints
// =====================================================================
// Recebe keypoints MediaPipe Pose (33 landmarks) capturados no client,
// altura/peso informados pelo usuário, e calcula medidas antropométricas:
// peito, cintura, quadril, ombro, manga, entrepernas, etc.
//
// Calibração de escala: usa altura conhecida (cm) / altura em pixels (
// distância vertical da cabeça ao calcanhar) → pixels-por-cm.
// Circunferências: aproximadas via elipse (largura frontal × profundidade
// lateral) usando fórmula de Ramanujan. Ajuste empírico por BMI.
//
// Padrão de retorno: { ok, scanId, measurements, confidence } ou
// { ok: false, error }.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Índices dos landmarks MediaPipe Pose (33 pontos)
// Ref: https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
const LM = {
  nose: 0,
  left_eye_inner: 1, left_eye: 2, left_eye_outer: 3,
  right_eye_inner: 4, right_eye: 5, right_eye_outer: 6,
  left_ear: 7, right_ear: 8,
  mouth_left: 9, mouth_right: 10,
  left_shoulder: 11, right_shoulder: 12,
  left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16,
  left_pinky: 17, right_pinky: 18,
  left_index: 19, right_index: 20,
  left_thumb: 21, right_thumb: 22,
  left_hip: 23, right_hip: 24,
  left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28,
  left_heel: 29, right_heel: 30,
  left_foot_index: 31, right_foot_index: 32,
};

function getKp(kpts, name) {
  if (!kpts) return null;
  // Aceita formato { left_shoulder: {x,y,z,visibility}, ... } ou array indexado
  if (Array.isArray(kpts)) return kpts[LM[name]] || null;
  return kpts[name] || kpts[String(LM[name])] || null;
}

function dist2D(a, b) {
  if (!a || !b) return null;
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

function mid(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// =====================================================================
// CALIBRAÇÃO DE ESCALA (pixels por cm)
// =====================================================================
// Estratégia: distância vertical do topo da cabeça até o calcanhar
// dividido pela altura informada. Como MediaPipe não tem "head top",
// aproximamos: topo = nose.y - (nose.y - ear.y) * 1.4 (offset crânio).
function computeScale(kpts, heightCm) {
  const nose = getKp(kpts, 'nose');
  const lEar = getKp(kpts, 'left_ear');
  const rEar = getKp(kpts, 'right_ear');
  const lHeel = getKp(kpts, 'left_heel');
  const rHeel = getKp(kpts, 'right_heel');

  if (!nose || !lHeel || !rHeel) return null;

  const earY = lEar && rEar ? (lEar.y + rEar.y) / 2 : nose.y;
  // Crown estimado: nariz + 1.4× (orelha→nariz) acima
  const crownY = nose.y - Math.abs(nose.y - earY) * 1.4;
  const heelY = (lHeel.y + rHeel.y) / 2;

  const pixelHeight = Math.abs(heelY - crownY);
  if (pixelHeight <= 0) return null;
  return pixelHeight / heightCm; // pixels por cm
}

// =====================================================================
// CIRCUNFERÊNCIAS (elipse de Ramanujan)
// =====================================================================
// Recebe semiaxes a (metade da largura frontal em cm) e b (metade da
// profundidade lateral em cm). Retorna perímetro aproximado.
function ellipsePerimeter(a, b) {
  if (a <= 0 || b <= 0) return 0;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

// =====================================================================
// MEDIDAS INDIVIDUAIS
// =====================================================================

function measureShoulderWidth(front, scale) {
  const ls = getKp(front, 'left_shoulder');
  const rs = getKp(front, 'right_shoulder');
  const d = dist2D(ls, rs);
  if (!d) return null;
  // Distância acromial → largura ombro a ombro. Adiciona 10% pra capturar
  // os deltóides (MediaPipe pega o ponto da articulação, não a borda).
  return (d / scale) * 1.1;
}

function measureChestCircumference(front, side, scale, sex, weightKg, heightCm) {
  const ls = getKp(front, 'left_shoulder');
  const rs = getKp(front, 'right_shoulder');
  if (!ls || !rs) return null;

  // Largura do peito ~ 92% da largura entre ombros (linha do mamilo)
  const shoulderWidthPx = dist2D(ls, rs);
  const widthCm = (shoulderWidthPx / scale) * 0.92;

  // Profundidade do peito: usa vista lateral se disponível
  let depthCm;
  if (side) {
    // Em vista lateral, pega largura horizontal do tronco na altura do ombro
    const sideShoulder = getKp(side, 'left_shoulder') || getKp(side, 'right_shoulder');
    const sideHip = getKp(side, 'left_hip') || getKp(side, 'right_hip');
    if (sideShoulder && sideHip) {
      // Heurística: na vista lateral, a largura horizontal da silhueta na
      // altura do ombro é a profundidade do tronco. MediaPipe não dá
      // contorno, então estimamos pela razão padrão width:depth = 1:0.65
      // ajustada pelo BMI.
      const bmi = weightKg && heightCm ? weightKg / Math.pow(heightCm / 100, 2) : 23;
      const ratio = bmi > 27 ? 0.78 : bmi > 23 ? 0.68 : 0.62;
      depthCm = widthCm * ratio;
    }
  }
  if (!depthCm) {
    const bmi = weightKg && heightCm ? weightKg / Math.pow(heightCm / 100, 2) : 23;
    const ratio = bmi > 27 ? 0.75 : bmi > 23 ? 0.65 : 0.6;
    depthCm = widthCm * ratio;
  }

  let circumference = ellipsePerimeter(widthCm / 2, depthCm / 2);

  // Correção por sexo: mulheres tendem a ter peito maior em relação ao ombro
  if (sex === 'F') circumference *= 1.04;

  return circumference;
}

function measureWaistCircumference(front, side, scale, sex, weightKg, heightCm) {
  const lHip = getKp(front, 'left_hip');
  const rHip = getKp(front, 'right_hip');
  const lShoulder = getKp(front, 'left_shoulder');
  const rShoulder = getKp(front, 'right_shoulder');
  if (!lHip || !rHip || !lShoulder || !rShoulder) return null;

  // A cintura não é landmark direto. Estimamos como ponto entre ombro e
  // quadril, mais próximo do quadril (~60% do caminho do ombro pro quadril).
  const hipMid = mid(lHip, rHip);
  const shoulderMid = mid(lShoulder, rShoulder);
  // Largura no nível da cintura: interpola entre largura do ombro e do quadril
  // na proporção t=0.6 (cintura fica 60% do caminho do ombro até o quadril).
  const shoulderWidthPx = dist2D(lShoulder, rShoulder);
  const hipWidthPx = dist2D(lHip, rHip);
  // Cintura natural: tipicamente 80-85% da largura do quadril em homens, 75-80% em mulheres
  const waistRatio = sex === 'F' ? 0.78 : 0.85;
  const widthPx = hipWidthPx * waistRatio;
  const widthCm = widthPx / scale;

  const bmi = weightKg && heightCm ? weightKg / Math.pow(heightCm / 100, 2) : 23;
  const depthRatio = bmi > 27 ? 0.82 : bmi > 23 ? 0.7 : 0.6;
  const depthCm = widthCm * depthRatio;

  return ellipsePerimeter(widthCm / 2, depthCm / 2);
}

function measureHipCircumference(front, side, scale, sex, weightKg, heightCm) {
  const lHip = getKp(front, 'left_hip');
  const rHip = getKp(front, 'right_hip');
  if (!lHip || !rHip) return null;

  // Hip landmark do MediaPipe é a articulação do quadril (mais estreito que
  // a circunferência real do quadril que passa pelos glúteos).
  // Largura real do quadril ~ 1.25x a largura entre os pontos do hip
  const widthCm = (dist2D(lHip, rHip) / scale) * 1.25;

  const bmi = weightKg && heightCm ? weightKg / Math.pow(heightCm / 100, 2) : 23;
  const depthRatio = sex === 'F' ? (bmi > 25 ? 0.85 : 0.78) : (bmi > 25 ? 0.78 : 0.7);
  const depthCm = widthCm * depthRatio;

  return ellipsePerimeter(widthCm / 2, depthCm / 2);
}

function measureSleeve(front, scale) {
  // Manga: do ombro até o punho, passando pelo cotovelo (soma 2 segmentos)
  const shoulder = getKp(front, 'right_shoulder') || getKp(front, 'left_shoulder');
  const elbow = getKp(front, 'right_elbow') || getKp(front, 'left_elbow');
  const wrist = getKp(front, 'right_wrist') || getKp(front, 'left_wrist');
  if (!shoulder || !elbow || !wrist) return null;
  const upper = dist2D(shoulder, elbow);
  const lower = dist2D(elbow, wrist);
  if (!upper || !lower) return null;
  return ((upper + lower) / scale);
}

function measureInseam(front, scale) {
  // Entrepernas: do quadril até o tornozelo
  const hip = getKp(front, 'right_hip') || getKp(front, 'left_hip');
  const ankle = getKp(front, 'right_ankle') || getKp(front, 'left_ankle');
  if (!hip || !ankle) return null;
  const d = dist2D(hip, ankle);
  if (!d) return null;
  // O ponto do hip do MediaPipe é mais alto que a entrepernas anatômica
  // (~8cm mais alto). Subtrai esse offset.
  return (d / scale) - 8;
}

function measureTorsoLength(front, scale) {
  // Comprimento do torso: ombro até quadril
  const shoulder = getKp(front, 'right_shoulder') || getKp(front, 'left_shoulder');
  const hip = getKp(front, 'right_hip') || getKp(front, 'left_hip');
  const d = dist2D(shoulder, hip);
  if (!d) return null;
  return d / scale;
}

function measureNeck(front, scale, sex) {
  // Pescoço: aproximado por 40% da largura dos ombros (homens) ou 35% (mulheres)
  // Não há landmark de pescoço; isso é heurística antropométrica.
  const ls = getKp(front, 'left_shoulder');
  const rs = getKp(front, 'right_shoulder');
  const shoulderCm = dist2D(ls, rs) / scale;
  if (!shoulderCm) return null;
  const neckWidth = shoulderCm * (sex === 'F' ? 0.32 : 0.38);
  // Pescoço é mais circular que elíptico
  return Math.PI * neckWidth;
}

function measureThigh(front, scale, weightKg, heightCm, sex) {
  const hip = getKp(front, 'right_hip') || getKp(front, 'left_hip');
  const knee = getKp(front, 'right_knee') || getKp(front, 'left_knee');
  if (!hip || !knee) return null;
  // Coxa: aproximada como circunferência no terço superior entre hip e knee
  // Largura: ~30% da largura do quadril
  const lHip = getKp(front, 'left_hip');
  const rHip = getKp(front, 'right_hip');
  const hipWidth = lHip && rHip ? dist2D(lHip, rHip) / scale : 32;
  const thighWidth = hipWidth * 0.5;
  const bmi = weightKg && heightCm ? weightKg / Math.pow(heightCm / 100, 2) : 23;
  const depthRatio = bmi > 25 ? 0.95 : 0.85;
  return ellipsePerimeter(thighWidth / 2, (thighWidth * depthRatio) / 2);
}

// =====================================================================
// CONFIDENCE
// =====================================================================
function computeConfidence(front, side, back) {
  if (!front) return 0;
  const keys = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee'];
  let sumVis = 0, count = 0;
  for (const k of keys) {
    const kp = getKp(front, k);
    if (kp && typeof kp.visibility === 'number') {
      sumVis += kp.visibility;
      count++;
    }
  }
  const avgVis = count > 0 ? sumVis / count : 0.7;

  // Simetria: distâncias ombro-ombro vs quadril-quadril devem ser plausíveis
  const ls = getKp(front, 'left_shoulder');
  const rs = getKp(front, 'right_shoulder');
  const lh = getKp(front, 'left_hip');
  const rh = getKp(front, 'right_hip');
  let symmetry = 0.8;
  if (ls && rs && lh && rh) {
    const sw = dist2D(ls, rs);
    const hw = dist2D(lh, rh);
    if (sw > 0 && hw > 0) {
      // Razão ombro/quadril típica: 1.0-1.4 (homens), 0.9-1.2 (mulheres)
      const ratio = sw / hw;
      if (ratio > 0.8 && ratio < 1.6) symmetry = 0.95;
      else symmetry = 0.6;
    }
  }

  // Bonus se tem vista lateral também
  const sideBonus = side ? 0.05 : 0;

  return Math.min(1, avgVis * 0.7 + symmetry * 0.25 + sideBonus);
}

// =====================================================================
// API PÚBLICA
// =====================================================================

/**
 * Processa um scan corporal.
 *
 * @param {Object} input
 * @param {string} input.userId
 * @param {number} input.heightCm - altura informada
 * @param {number} [input.weightKg]
 * @param {string} [input.sex] - "M" | "F" | "NB"
 * @param {Object} input.keypointsFront - {left_shoulder: {x,y,z,visibility}, ...} ou array de 33
 * @param {Object} [input.keypointsSide]
 * @param {Object} [input.keypointsBack]
 * @param {Array}  [input.photos] - opt-in: [{url, view}]
 * @param {string} [input.source] - "pwa_apex" | "nuvemshop_widget" | ...
 *
 * @returns {Promise<{ok:boolean, scanId?:string, measurements?:Object, confidence?:number, error?:string}>}
 */
async function processBodyScan(input) {
  const {
    userId, heightCm, weightKg, sex,
    keypointsFront, keypointsSide, keypointsBack,
    photos, source = 'pwa_apex',
  } = input;

  if (!userId) return { ok: false, error: 'userId obrigatório' };
  if (!heightCm || heightCm < 100 || heightCm > 230) {
    return { ok: false, error: 'heightCm deve estar entre 100 e 230' };
  }
  if (!keypointsFront) return { ok: false, error: 'keypointsFront obrigatório' };

  // 1. Calibrar escala
  const scale = computeScale(keypointsFront, heightCm);
  if (!scale) {
    return { ok: false, error: 'não foi possível calibrar escala — landmarks de cabeça/pé ausentes' };
  }

  // 2. Calcular medidas
  const measurements = {
    shoulder: measureShoulderWidth(keypointsFront, scale),
    chest: measureChestCircumference(keypointsFront, keypointsSide, scale, sex, weightKg, heightCm),
    waist: measureWaistCircumference(keypointsFront, keypointsSide, scale, sex, weightKg, heightCm),
    hip: measureHipCircumference(keypointsFront, keypointsSide, scale, sex, weightKg, heightCm),
    sleeve: measureSleeve(keypointsFront, scale),
    inseam: measureInseam(keypointsFront, scale),
    torsoLength: measureTorsoLength(keypointsFront, scale),
    neck: measureNeck(keypointsFront, scale, sex),
    thigh: measureThigh(keypointsFront, scale, weightKg, heightCm, sex),
  };

  // Remove nulls e arredonda
  const cleanMeasures = {};
  for (const [k, v] of Object.entries(measurements)) {
    if (v != null && !isNaN(v) && v > 0) {
      cleanMeasures[k] = Math.round(v * 10) / 10;
    }
  }

  if (Object.keys(cleanMeasures).length === 0) {
    return { ok: false, error: 'nenhuma medida pôde ser calculada — verifique posicionamento' };
  }

  // 3. Confidence
  const confidence = computeConfidence(keypointsFront, keypointsSide, keypointsBack);

  // 4. Verificar User existe
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) return { ok: false, error: 'usuário não existe' };

  // 5. Persistir
  const scan = await prisma.bodyScan.create({
    data: {
      userId,
      source,
      heightCm,
      weightKg: weightKg ?? null,
      sex: sex ?? null,
      keypointsFront,
      keypointsSide: keypointsSide ?? null,
      keypointsBack: keypointsBack ?? null,
      scaleFactor: scale,
      confidence,
      photosStored: Array.isArray(photos) && photos.length > 0,
      photoUrls: photos ?? null,
      measurements: {
        create: Object.entries(cleanMeasures).map(([measureType, valueCm]) => ({
          measureType,
          valueCm,
          confidence,
        })),
      },
    },
    include: { measurements: true },
  });

  // 6. Atualizar cache no User
  await prisma.user.update({
    where: { id: userId },
    data: { lastScanId: scan.id, lastScanAt: new Date() },
  });

  return {
    ok: true,
    scanId: scan.id,
    measurements: cleanMeasures,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Retorna último scan do usuário com medidas.
 */
async function getLatestScan(userId) {
  if (!userId) return { ok: false, error: 'userId obrigatório' };
  const scan = await prisma.bodyScan.findFirst({
    where: { userId },
    orderBy: { capturedAt: 'desc' },
    include: { measurements: true },
  });
  if (!scan) return { ok: false, error: 'nenhum scan encontrado' };

  const measurements = Object.fromEntries(
    scan.measurements.map((m) => [m.measureType, m.valueCm])
  );

  return {
    ok: true,
    scanId: scan.id,
    capturedAt: scan.capturedAt,
    heightCm: scan.heightCm,
    weightKg: scan.weightKg,
    confidence: scan.confidence,
    measurements,
  };
}

module.exports = {
  processBodyScan,
  getLatestScan,
  // exports auxiliares pra testes / outros services
  _internals: {
    computeScale,
    ellipsePerimeter,
    measureShoulderWidth,
    measureChestCircumference,
    measureWaistCircumference,
    measureHipCircumference,
    measureSleeve,
    measureInseam,
    measureTorsoLength,
    LM,
  },
};
