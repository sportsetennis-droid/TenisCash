// =====================================================================
// APEX SPORT — Activity Ingest Service
// =====================================================================
// Recebe atividades do app mobile + GPX/FIT importados de Garmin etc.
// Normaliza, valida, dispara processadores downstream via event bus.
//
// NÃO ESTÁ EM PRODUÇÃO — falta:
// - Cluster Postgres + PostGIS dedicado (APEX_DATABASE_URL)
// - Kafka/NATS broker
// - S3 bucket pra payloads raw
// - Worker pool processando segmentos/leaderboards/challenges
// =====================================================================

// const { PrismaClient } = require('@apex-prisma-client');
// const prisma = new PrismaClient();

const VALID_SPORTS = new Set([
  'RUN', 'RIDE', 'SWIM', 'WALK', 'HIKE', 'TRAIL_RUN', 'TREADMILL',
  'STRENGTH', 'YOGA', 'PILATES', 'HIIT', 'CROSSFIT', 'FUNCTIONAL',
  'TENNIS', 'PADEL', 'BEACH_TENNIS', 'BASKETBALL', 'SOCCER',
  'SURF', 'SUP', 'KAYAK', 'CLIMB', 'SKI', 'SNOWBOARD',
  'OTHER',
]);

/**
 * Cria uma atividade nova a partir de payload do app mobile.
 *
 * Validações:
 * - sportType válido
 * - user existe
 * - tempos coerentes (elapsed_time >= moving_time, started_at antes do agora)
 * - distância coerente com tempo (não permite velocidades impossíveis)
 *
 * @param {Object} payload - { userId, sportType, startedAt, elapsedTimeS, ... }
 * @param {Object} streams - { latlng, heart_rate_bpm, cadence_spm, ... } (vai pro ClickHouse)
 */
async function ingestActivity(payload, streams = {}) {
  if (!VALID_SPORTS.has(payload.sportType)) {
    return { ok: false, error: `sportType inválido: ${payload.sportType}` };
  }
  if (!payload.userId) return { ok: false, error: 'userId obrigatório' };
  if (!payload.startedAt) return { ok: false, error: 'startedAt obrigatório' };

  const start = new Date(payload.startedAt);
  if (start > new Date(Date.now() + 60000)) {
    return { ok: false, error: 'startedAt no futuro' };
  }
  const elapsed = Number(payload.elapsedTimeS) || 0;
  const moving = Number(payload.movingTimeS) || elapsed;
  if (moving > elapsed) return { ok: false, error: 'movingTime > elapsedTime' };

  const dist = Number(payload.distanceM) || 0;
  // Velocidade média plausível por esporte (m/s)
  const maxPlausibleSpeed = {
    RUN: 7,        // 25 km/h (sprint mundial)
    WALK: 3,       // 11 km/h
    RIDE: 25,      // 90 km/h (descida)
    SWIM: 3,       // 11 km/h (recorde nadador)
    HIKE: 3,
  };
  const max = maxPlausibleSpeed[payload.sportType] || 30;
  if (moving > 0 && (dist / moving) > max) {
    return { ok: false, error: `velocidade média implausível pra ${payload.sportType}` };
  }

  // TODO: salvar via Prisma quando APEX_DATABASE_URL existir
  // const activity = await prisma.activity.create({ data: { ...payload, processingState: 'pending' } });

  // TODO: emitir evento "activity.created" pro Kafka/NATS
  // - subscribers: segment-processor, leaderboard-updater, challenge-progress, ml-feature-pipeline

  // TODO: streams (lat/lng, HR, etc.) vão pro ClickHouse
  // const samples = streams.latlng.map((p, i) => ({ activity_id, ts: ..., lat: p[0], lon: p[1], hr: streams.heart_rate_bpm?.[i] }));
  // await clickhouse.insert('activity_samples', samples);

  return {
    ok: true,
    // activityId: activity.id,
    activityId: 'STUB_' + Date.now(),
    status: 'PROCESSING',
    warning: 'STUB — APEX_DATABASE_URL não configurada, ingestão simulada',
  };
}

/**
 * Importa GPX/FIT/TCX vindo de Garmin Connect, Strava export, etc.
 */
async function importActivityFile(userId, filePath, format) {
  if (!['gpx', 'fit', 'tcx'].includes(format)) {
    return { ok: false, error: 'formato não suportado' };
  }
  // TODO: parser específico por formato (gpx-parser, fit-decoder, tcx-parser)
  // TODO: converte pra payload canônico → chama ingestActivity()
  return { ok: false, error: 'STUB — parser de ' + format + ' não implementado ainda' };
}

module.exports = { ingestActivity, importActivityFile, VALID_SPORTS };
