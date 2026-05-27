// =====================================================================
// APEX SPORT — Activity Ingest (unificado ao TenisCash)
// =====================================================================
// Recebe atividades do app mobile + imports (GPX/FIT). Valida, persiste
// via Prisma principal, dispara loops downstream (badges, cashback, etc.).
//
// O atleta é o mesmo User da loja Sports & Tennis. Não criamos cluster
// dedicado — usamos o Postgres existente do TenisCash.
// Streams (lat/lng, HR) vão pro ClickHouse quando configurado.
// =====================================================================

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VALID_SPORTS = new Set([
  'RUN', 'RIDE', 'SWIM', 'WALK', 'HIKE', 'TRAIL_RUN', 'TREADMILL',
  'STRENGTH', 'YOGA', 'PILATES', 'HIIT', 'CROSSFIT', 'FUNCTIONAL',
  'TENNIS', 'PADEL', 'BEACH_TENNIS', 'BASKETBALL', 'SOCCER',
  'SURF', 'SUP', 'KAYAK', 'CLIMB', 'SKI', 'SNOWBOARD',
  'OTHER',
]);

// Velocidade média plausível por esporte (m/s) — anti-fraude básico
const MAX_PLAUSIBLE_SPEED = {
  RUN: 7,       // 25 km/h
  TRAIL_RUN: 6,
  WALK: 3,      // 11 km/h
  HIKE: 3,
  RIDE: 25,     // 90 km/h
  SWIM: 3,
  TENNIS: 15,
  PADEL: 15,
};

/**
 * Cria uma atividade. Retorna { ok, activityId } ou { ok:false, error }.
 *
 * @param {Object} payload  { userId, sportType, startedAt, elapsedTimeS, movingTimeS, distanceM, ... }
 * @param {Object} streams  { latlng, heart_rate_bpm, cadence_spm, ... } — TODO: ClickHouse
 */
async function ingestActivity(payload, streams = {}) {
  if (!VALID_SPORTS.has(payload.sportType)) {
    return { ok: false, error: `sportType inválido: ${payload.sportType}` };
  }
  if (!payload.userId) return { ok: false, error: 'userId obrigatório' };
  if (!payload.startedAt) return { ok: false, error: 'startedAt obrigatório' };

  const start = new Date(payload.startedAt);
  if (start > new Date(Date.now() + 60_000)) {
    return { ok: false, error: 'startedAt no futuro' };
  }

  const elapsed = Number(payload.elapsedTimeS) || 0;
  const moving = Number(payload.movingTimeS) || elapsed;
  if (moving > elapsed) return { ok: false, error: 'movingTime > elapsedTime' };

  const dist = Number(payload.distanceM) || 0;
  const max = MAX_PLAUSIBLE_SPEED[payload.sportType] || 30;
  if (moving > 0 && (dist / moving) > max) {
    return { ok: false, error: `velocidade média implausível pra ${payload.sportType}` };
  }

  // Confere User existe (FK)
  const user = await prisma.user.findUnique({ where: { id: payload.userId }, select: { id: true } });
  if (!user) return { ok: false, error: 'userId não existe' };

  try {
    const activity = await prisma.activity.create({
      data: {
        userId: payload.userId,
        sportType: payload.sportType,
        startedAt: start,
        endedAt: payload.endedAt ? new Date(payload.endedAt) : null,
        elapsedTimeS: elapsed,
        movingTimeS: moving,
        distanceM: payload.distanceM ?? null,
        elevationGainM: payload.elevationGainM ?? null,
        elevationLossM: payload.elevationLossM ?? null,
        avgHeartRate: payload.avgHeartRate ?? null,
        maxHeartRate: payload.maxHeartRate ?? null,
        avgPace: payload.avgPace ?? null,
        maxSpeed: payload.maxSpeed ?? null,
        avgPower: payload.avgPower ?? null,
        calories: payload.calories ?? null,
        trainingLoad: payload.trainingLoad ?? null,
        summaryPolyline: payload.summaryPolyline ?? null,
        visibility: payload.visibility ?? 'followers',
        deviceSource: payload.deviceSource ?? 'phone',
        rawPayloadRef: payload.rawPayloadRef ?? null,
        startPrivacyRadiusM: payload.startPrivacyRadiusM ?? 250,
        endPrivacyRadiusM: payload.endPrivacyRadiusM ?? 250,
        processingState: 'processing',
      },
    });

    // TODO downstream:
    //  - segment-processor (map matching)
    //  - leaderboard-updater
    //  - challenge-progress
    //  - badge-checker  → BadgeEarned (com cashbackAwarded creditando User.balance)
    //  - ml-feature-pipeline (coach IA)
    // Hoje: marca como done direto. Quando worker existir, fila/Kafka entra aqui.
    await prisma.activity.update({
      where: { id: activity.id },
      data: { processingState: 'done' },
    });

    return {
      ok: true,
      activityId: activity.id,
      status: 'DONE',
      warning: streams && Object.keys(streams).length
        ? 'streams recebidos mas ClickHouse não configurado — descartados'
        : undefined,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Import de arquivo GPX/FIT/TCX (Garmin, Strava export, etc.)
 * Não implementado — requer parser nativo por formato.
 */
async function importActivityFile(_userId, _filePath, format) {
  if (!['gpx', 'fit', 'tcx'].includes(format)) {
    return { ok: false, error: 'formato não suportado' };
  }
  return { ok: false, error: `STUB — parser ${format} ainda não implementado` };
}

module.exports = { ingestActivity, importActivityFile, VALID_SPORTS };
