// =====================================================================
// APEX SPORT — Activity Ingest (unificado ao TenisCash)
// ---------------------------------------------------------------------
// Recebe atividades gravadas no PWA (/atividade.html) e imports de relógio
// (GPX/TCX/FIT). Valida, calcula as métricas NO SERVIDOR a partir dos
// pontos (não confia no número do cliente), grava e roda o downstream:
//   segmentos (matching + PR + Local Legend) → badges/XP/cashback → desafios.
// O atleta é o mesmo User da loja. userId vem SEMPRE do token (req.userId).
// =====================================================================

const { prisma } = require('../middleware');
const geo = require('./apexGeo');

const VALID_SPORTS = new Set([
  'RUN', 'RIDE', 'SWIM', 'WALK', 'HIKE', 'TRAIL_RUN', 'TREADMILL',
  'STRENGTH', 'YOGA', 'PILATES', 'HIIT', 'CROSSFIT', 'FUNCTIONAL',
  'TENNIS', 'PADEL', 'BEACH_TENNIS', 'BASKETBALL', 'SOCCER',
  'SURF', 'SUP', 'KAYAK', 'CLIMB', 'SKI', 'SNOWBOARD',
  'OTHER',
]);
const VISIBILITIES = new Set(['public', 'followers', 'private']);

// Velocidade média plausível por esporte (m/s) — anti-fraude básico
const MAX_PLAUSIBLE_SPEED = {
  RUN: 7, TRAIL_RUN: 6, WALK: 3, HIKE: 3, RIDE: 25, SWIM: 3, TENNIS: 15, PADEL: 15,
};
const MAX_ACCURACY_M = 50; // ponto do celular com precisão pior que isso é descartado

const SPORT_PT = {
  RUN: 'Corrida', WALK: 'Caminhada', RIDE: 'Pedal', HIKE: 'Trilha', TRAIL_RUN: 'Corrida na trilha',
  BEACH_TENNIS: 'Beach tennis', TENNIS: 'Tênis', PADEL: 'Padel', FUNCTIONAL: 'Treino funcional',
  STRENGTH: 'Musculação', SWIM: 'Natação', TREADMILL: 'Esteira',
};
function defaultTitle(sport, startedAt) {
  const h = (new Date(startedAt).getUTCHours() + 24 - 3) % 24; // Fortaleza
  const per = h < 5 ? 'da madrugada' : h < 12 ? 'da manhã' : h < 18 ? 'da tarde' : 'da noite';
  return `${SPORT_PT[sport] || 'Atividade'} ${per}`;
}

/** Aceita pontos como objeto {t,lat,lng,alt,hr,acc,seg} ou array [t,lat,lng,alt,acc,seg]. */
function normalizePoints(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let pendingSeg = false;
  for (const p of raw) {
    let o;
    if (Array.isArray(p)) o = { t: Number(p[0]), lat: Number(p[1]), lng: Number(p[2]), alt: p[3] == null ? null : Number(p[3]), acc: p[4] == null ? null : Number(p[4]), seg: !!p[5] };
    else if (p && typeof p === 'object') o = { t: typeof p.t === 'string' ? Date.parse(p.t) : Number(p.t), lat: Number(p.lat), lng: Number(p.lng), alt: p.alt == null ? null : Number(p.alt), hr: p.hr == null ? null : Number(p.hr), acc: p.acc == null ? null : Number(p.acc), seg: !!p.seg };
    else continue;
    const bad = !Number.isFinite(o.t)
      || (Number.isFinite(o.acc) && o.acc > MAX_ACCURACY_M)
      || !Number.isFinite(o.lat) || !Number.isFinite(o.lng) || Math.abs(o.lat) > 90 || Math.abs(o.lng) > 180;
    if (bad) { if (o.seg) pendingSeg = true; continue; } // quebra de trecho não se perde
    if (pendingSeg) { o.seg = true; pendingSeg = false; }
    delete o.acc;
    if (!o.seg) delete o.seg;
    out.push(o);
  }
  out.sort((a, b) => a.t - b.t);
  if (out.length) delete out[0].seg;
  return geo.downsample(out, 20000);
}

async function hasConsent(userId, scope) {
  const c = await prisma.consent.findFirst({ where: { userId, scope }, orderBy: { grantedAt: 'desc' } });
  return !!(c && c.granted && !c.revokedAt);
}

/**
 * Grava atividade. Retorna { ok, activityId, badges, efforts } ou { ok:false, status, error }.
 * @param {string} userId  SEMPRE req.userId (nunca do body)
 * @param {object} payload { sportType, startedAt, elapsedTimeS, points, title, visibility, clientId, liveActivityId, ... }
 */
async function ingestActivity(userId, payload = {}) {
  if (!userId) return { ok: false, status: 401, error: 'não autenticado' };
  const sportType = String(payload.sportType || '');
  if (!VALID_SPORTS.has(sportType)) return { ok: false, status: 400, error: `sportType inválido: ${payload.sportType}` };
  const visibility = VISIBILITIES.has(payload.visibility) ? payload.visibility : 'followers';
  const clientId = payload.clientId ? String(payload.clientId).slice(0, 80) : null;

  if (clientId) {
    const dup = await prisma.activity.findUnique({ where: { userId_clientId: { userId, clientId } }, select: { id: true } });
    if (dup) return { ok: true, activityId: dup.id, duplicate: true, badges: [], efforts: 0 };
  }

  const points = normalizePoints(payload.points);
  const gps = points.length >= 2;
  if (gps && !(await hasConsent(userId, 'location_history'))) {
    return { ok: false, status: 428, error: 'consentimento de localização necessário', consentScope: 'location_history' };
  }

  let m;
  if (gps) {
    m = geo.computeMetrics(points, sportType);
  } else {
    if (!payload.startedAt) return { ok: false, status: 400, error: 'startedAt obrigatório' };
    const elapsed = Math.round(Number(payload.elapsedTimeS) || 0);
    if (elapsed <= 0) return { ok: false, status: 400, error: 'duração obrigatória (elapsedTimeS)' };
    const moving = Math.round(Number(payload.movingTimeS) || elapsed);
    if (moving > elapsed) return { ok: false, status: 400, error: 'movingTime > elapsedTime' };
    const start = new Date(payload.startedAt);
    if (isNaN(start)) return { ok: false, status: 400, error: 'startedAt inválido' };
    const dist = payload.distanceM != null && Number(payload.distanceM) > 0 ? Number(payload.distanceM) : null;
    m = {
      startedAt: start, endedAt: new Date(start.getTime() + elapsed * 1000),
      elapsedTimeS: elapsed, movingTimeS: moving, distanceM: dist,
      avgPace: dist ? Math.round(moving / (dist / 1000)) : null,
      avgHeartRate: Number(payload.avgHeartRate) || null, maxHeartRate: Number(payload.maxHeartRate) || null,
      elevationGainM: null, elevationLossM: null, maxSpeed: null,
    };
  }
  // Elapsed informado pelo celular (relógio de parede, inclui pausas) pode ser maior
  if (Number(payload.elapsedTimeS) > m.elapsedTimeS) m.elapsedTimeS = Math.round(Number(payload.elapsedTimeS));

  if (m.startedAt > new Date(Date.now() + 60_000)) return { ok: false, status: 400, error: 'startedAt no futuro' };
  if (m.elapsedTimeS > 48 * 3600) return { ok: false, status: 400, error: 'atividade longa demais (> 48 h)' };
  const max = MAX_PLAUSIBLE_SPEED[sportType] || 30;
  if (m.movingTimeS > 0 && m.distanceM && (m.distanceM / m.movingTimeS) > max) {
    return { ok: false, status: 400, error: `velocidade média implausível pra ${sportType}` };
  }

  // Duplicata (mesma atividade enviada 2x / importada de novo): mesmo início ±60 s
  const near = await prisma.activity.findFirst({
    where: {
      userId, processingState: 'done',
      startedAt: { gte: new Date(m.startedAt.getTime() - 60_000), lte: new Date(m.startedAt.getTime() + 60_000) },
    },
    select: { id: true },
  });
  if (near) return { ok: false, status: 409, error: 'você já tem uma atividade nesse horário', activityId: near.id };

  const coords = gps ? points.map((p) => [p.lat, p.lng]) : [];
  const data = {
    sportType,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    elapsedTimeS: m.elapsedTimeS,
    movingTimeS: Math.min(m.movingTimeS, m.elapsedTimeS),
    distanceM: m.distanceM,
    elevationGainM: m.elevationGainM,
    elevationLossM: m.elevationLossM,
    avgHeartRate: m.avgHeartRate,
    maxHeartRate: m.maxHeartRate,
    avgPace: m.avgPace,
    maxSpeed: m.maxSpeed,
    calories: Number(payload.calories) > 0 ? Math.round(Number(payload.calories)) : null,
    summaryPolyline: gps ? geo.encodePolyline(geo.simplifyTo(coords, 600)) : null,
    streams: gps ? geo.pointsToStreams(points) : undefined,
    title: String(payload.title || '').trim().slice(0, 120) || defaultTitle(sportType, m.startedAt),
    description: payload.description ? String(payload.description).slice(0, 2000) : null,
    visibility,
    deviceSource: payload.deviceSource ? String(payload.deviceSource).slice(0, 60) : 'phone',
    clientId,
    processingState: 'processing',
  };

  let activity;
  try {
    if (payload.liveActivityId) {
      const live = await prisma.activity.findFirst({ where: { id: String(payload.liveActivityId), userId, processingState: 'recording' } });
      if (!live) return { ok: false, status: 404, error: 'atividade ao vivo não encontrada' };
      activity = await prisma.activity.update({ where: { id: live.id }, data });
      await require('./apexBeacon').stopForActivity(live.id);
    } else {
      activity = await prisma.activity.create({ data: { userId, ...data } });
    }
  } catch (e) {
    if (e.code === 'P2002' && clientId) {
      const dup = await prisma.activity.findUnique({ where: { userId_clientId: { userId, clientId } }, select: { id: true } });
      if (dup) return { ok: true, activityId: dup.id, duplicate: true, badges: [], efforts: 0 };
    }
    return { ok: false, status: 500, error: e.message };
  }
  activity = await prisma.activity.update({ where: { id: activity.id }, data: { processingState: 'done' } });

  const result = await runDownstream(activity, points);
  return { ok: true, activityId: activity.id, status: 'DONE', ...result };
}

/** Segmentos → badges → desafios. Falha aqui NÃO desfaz a atividade. */
async function runDownstream(activity, points) {
  const out = { badges: [], efforts: 0, challenges: 0, warnings: [] };
  const segments = require('./apexSegments');
  const rewards = require('./apexRewards');
  const challenges = require('./apexChallenges');
  try {
    if (points && points.length >= 2) {
      const matches = await segments.matchActivity(activity, points);
      out.efforts = matches.length;
      out.badges.push(...(await segments.segmentBadges(activity.userId, matches)));
    }
  } catch (e) { out.warnings.push('segmentos: ' + e.message); }
  try { out.badges.push(...(await rewards.evaluateActivityBadges(activity))); } catch (e) { out.warnings.push('badges: ' + e.message); }
  try { out.challenges = (await challenges.onActivity(activity.userId, activity)).length; } catch (e) { out.warnings.push('desafios: ' + e.message); }
  out.badges = out.badges.map((b) => ({ key: b.badgeKey, ...rewards.badgeInfo(b.badgeKey), xp: b.xpAwarded, cashback: b.cashbackAwarded }));
  if (!out.warnings.length) delete out.warnings;
  return out;
}

/** Import de arquivo GPX/TCX/FIT (.gz aceito). */
async function importActivityFile(userId, buffer, filename = '', opts = {}) {
  const { parseActivityFile } = require('./activityImport');
  const parsed = await parseActivityFile(buffer, filename, VALID_SPORTS.has(opts.sportType) ? opts.sportType : undefined);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const gps = parsed.points.some((p) => Number.isFinite(p.lat));
  const payload = {
    sportType: parsed.sportType,
    title: opts.title || parsed.name || null,
    visibility: opts.visibility,
    deviceSource: parsed.deviceSource || parsed.format,
  };
  if (gps) payload.points = parsed.points;
  else {
    const m = geo.computeMetrics(parsed.points, parsed.sportType);
    Object.assign(payload, { startedAt: m.startedAt, elapsedTimeS: m.elapsedTimeS, avgHeartRate: m.avgHeartRate, maxHeartRate: m.maxHeartRate });
  }
  const r = await ingestActivity(userId, payload);
  return { ...r, format: parsed.format };
}

/** Apaga atividade do dono (filhos explícitos — FK pode não existir em prod). */
async function deleteActivity(userId, id) {
  const act = await prisma.activity.findFirst({ where: { id: String(id), userId } });
  if (!act) return { ok: false, status: 404, error: 'não encontrada' };
  await prisma.$transaction([
    prisma.segmentEffort.deleteMany({ where: { activityId: act.id } }),
    prisma.activityLap.deleteMany({ where: { activityId: act.id } }),
    prisma.activityPhoto.deleteMany({ where: { activityId: act.id } }),
    prisma.liveTrackingSession.deleteMany({ where: { activityId: act.id } }),
    prisma.activity.delete({ where: { id: act.id } }),
  ]);
  // desafios: recalcula (progresso cai se a atividade contava)
  try {
    const ch = require('./apexChallenges');
    const parts = await prisma.challengeParticipation.findMany({ where: { userId }, include: { challenge: true } });
    for (const p of parts) if (p.challenge.startsAt <= act.startedAt && p.challenge.endsAt > act.startedAt) await ch.recompute(userId, p.challenge);
  } catch (_) {}
  return { ok: true };
}

module.exports = { ingestActivity, importActivityFile, deleteActivity, normalizePoints, runDownstream, hasConsent, VALID_SPORTS, VISIBILITIES };
