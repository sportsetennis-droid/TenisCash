// =====================================================================
// APEX — Segmentos: criação, matching automático, ranking, Local Legend
// ---------------------------------------------------------------------
// Matching (geometria própria, sem turf):
//  1. pré-filtro no banco: segmentos da mesma família de esporte cujo
//     início cai no retângulo da atividade (+ folga);
//  2. na trilha: ponto a ≤ START_TOL do início do segmento → depois, ponto
//     a ≤ START_TOL do fim, com distância percorrida entre 80% e 125% do
//     segmento (garante sentido e evita atalhos/voltas);
//  3. corredor: amostras do segmento a cada ~20 m precisam estar a
//     ≤ CORRIDOR_M do trecho da trilha (90% delas; nenhuma > 2×CORRIDOR_M).
// Tempo do esforço = horário no fim − horário no início (ms).
// =====================================================================

const { prisma } = require('../middleware');
const geo = require('./apexGeo');
const crypto = require('crypto');

const START_TOL = 35;   // m
const CORRIDOR_M = 30;  // m
const MIN_SEG_M = 200;
const MAX_SEG_M = 50000;
const LEGEND_DAYS = 90;

const FAMILY = { RUN: 'RUN', TRAIL_RUN: 'RUN', TREADMILL: null, WALK: 'WALK', HIKE: 'WALK', RIDE: 'RIDE' };
function family(sport) { return FAMILY[sport] === undefined ? sport : FAMILY[sport]; }

// Pontos do segmento reamostrados a cada ~stepM metros
function resample(coords, stepM = 20) {
  const out = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const [la1, ln1] = coords[i - 1], [la2, ln2] = coords[i];
    const d = geo.haversine(la1, ln1, la2, ln2);
    let pos = stepM - acc;
    while (pos <= d) {
      const f = pos / d;
      out.push([la1 + (la2 - la1) * f, ln1 + (ln2 - ln1) * f]);
      pos += stepM;
    }
    acc = (acc + d) % stepM;
  }
  out.push(coords[coords.length - 1]);
  return out;
}

/**
 * Procura passagens do segmento na trilha. Pura (testável sem banco).
 * @param segCoords [[lat,lng],...] geometria do segmento
 * @param segDist   distância do segmento (m)
 * @param points    trilha normalizada [{t,lat,lng,hr}]
 * @returns [{startIdx,endIdx,elapsedMs,startedAt,avgHeartRate}]
 */
function findEfforts(segCoords, segDist, points) {
  if (!segCoords || segCoords.length < 2 || points.length < 2) return [];
  const [sLat, sLng] = segCoords[0];
  const [eLat, eLng] = segCoords[segCoords.length - 1];
  const cum = geo.cumulative(points);
  const samples = resample(segCoords, 20);
  const proj = geo.projector(sLat, sLng);
  const P = points.map((p) => proj(p.lat, p.lng));
  const S = samples.map((c) => proj(c[0], c[1]));
  const efforts = [];
  let i = 0;
  while (i < points.length - 1) {
    const ds = geo.haversine(points[i].lat, points[i].lng, sLat, sLng);
    if (ds > START_TOL) { i++; continue; }
    // ponto mais próximo do início dentro do grupo contíguo
    let si = i, best = ds;
    while (i + 1 < points.length && geo.haversine(points[i + 1].lat, points[i + 1].lng, sLat, sLng) <= START_TOL) {
      i++;
      const d = geo.haversine(points[i].lat, points[i].lng, sLat, sLng);
      if (d < best) { best = d; si = i; }
    }
    // procura o fim
    let ei = -1;
    for (let j = si + 1; j < points.length; j++) {
      const run = cum[j] - cum[si];
      if (run > segDist * 1.25) break;
      if (run < segDist * 0.8) continue;
      const de = geo.haversine(points[j].lat, points[j].lng, eLat, eLng);
      if (de <= START_TOL) {
        ei = j;
        let bestE = de;
        while (ei + 1 < points.length && cum[ei + 1] - cum[si] <= segDist * 1.25) {
          const d2 = geo.haversine(points[ei + 1].lat, points[ei + 1].lng, eLat, eLng);
          if (d2 <= bestE) { bestE = d2; ei++; } else break;
        }
        break;
      }
    }
    if (ei < 0) { i = si + 1; continue; }
    // corredor
    let inside = 0, worst = 0;
    for (const s of S) {
      let m = Infinity;
      for (let k = si; k < ei; k++) {
        const d = geo.pointSegDist(s, P[k], P[k + 1]);
        if (d < m) m = d;
        if (m <= 1) break;
      }
      if (m <= CORRIDOR_M) inside++;
      if (m > worst) worst = m;
    }
    if (inside / S.length >= 0.9 && worst <= CORRIDOR_M * 2) {
      const hrs = points.slice(si, ei + 1).map((p) => p.hr).filter(Number.isFinite);
      efforts.push({
        startIdx: si, endIdx: ei,
        elapsedMs: Math.round(points[ei].t - points[si].t),
        startedAt: new Date(points[si].t),
        avgHeartRate: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null,
      });
      i = ei + 1;
    } else {
      i = si + 1;
    }
  }
  return efforts.filter((e) => e.elapsedMs > 0);
}

/** Cria segmento a partir de um trecho [startIdx..endIdx] da atividade do dono. */
async function createSegmentFromActivity(userId, activityId, { name, startIdx, endIdx } = {}) {
  const act = await prisma.activity.findFirst({ where: { id: activityId, userId } });
  if (!act) return { ok: false, status: 404, error: 'atividade não encontrada' };
  const points = geo.streamsToPoints(act.streams);
  if (points.length < 2) return { ok: false, status: 400, error: 'atividade sem GPS' };
  const s = Number(startIdx), e = Number(endIdx);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e >= points.length || e <= s) {
    return { ok: false, status: 400, error: 'trecho inválido (startIdx/endIdx)' };
  }
  const nm = String(name || '').trim().slice(0, 80);
  if (nm.length < 3) return { ok: false, status: 400, error: 'dê um nome ao segmento (mín. 3 letras)' };
  const slice = points.slice(s, e + 1);
  const dist = geo.cumulative(slice).pop();
  if (dist < MIN_SEG_M) return { ok: false, status: 400, error: `segmento curto demais (mín. ${MIN_SEG_M} m)` };
  if (dist > MAX_SEG_M) return { ok: false, status: 400, error: 'segmento longo demais (máx. 50 km)' };
  const coords = geo.simplifyTo(slice.map((p) => [p.lat, p.lng]), 400);
  const fam = family(act.sportType);
  if (!fam) return { ok: false, status: 400, error: 'esporte sem segmento' };
  const polyline = geo.encodePolyline(coords);
  const geomHash = crypto.createHash('sha1').update(fam + ':' + geo.encodePolyline(coords.map(([a, b]) => [Math.round(a * 2000) / 2000, Math.round(b * 2000) / 2000]))).digest('hex');
  const dup = await prisma.segment.findFirst({ where: { geomHash } });
  if (dup) return { ok: false, status: 409, error: 'já existe um segmento igual', segmentId: dup.id };
  const seg = await prisma.segment.create({
    data: {
      name: nm, sportType: fam, polyline, distanceM: Math.round(dist * 10) / 10,
      elevationGainM: geo.elevation(slice).gain, visibility: 'public', geomHash,
      creatorId: userId, sourceActivityId: act.id,
      startLat: coords[0][0], startLng: coords[0][1],
      endLat: coords[coords.length - 1][0], endLng: coords[coords.length - 1][1],
    },
  });
  // Casa com atividades recentes (inclusive a de origem) pra já nascer com ranking
  const backfill = await backfillSegment(seg);
  return { ok: true, segment: seg, backfilled: backfill };
}

async function backfillSegment(seg, days = LEGEND_DAYS) {
  const pad = 0.01;
  const since = new Date(Date.now() - days * 86400e3);
  const sports = Object.keys(FAMILY).filter((k) => FAMILY[k] === seg.sportType);
  if (!sports.length) sports.push(seg.sportType);
  // candidatas: atividades com stream no período (limite pra não travar)
  const acts = await prisma.activity.findMany({
    where: { sportType: { in: sports }, processingState: 'done', startedAt: { gte: since }, streams: { not: null } },
    select: { id: true, userId: true, streams: true, visibility: true },
    orderBy: { startedAt: 'desc' },
    take: 500,
  });
  let n = 0;
  for (const a of acts) {
    const pts = geo.streamsToPoints(a.streams);
    const bb = geo.bbox(pts);
    if (seg.startLat < bb.minLat - pad || seg.startLat > bb.maxLat + pad || seg.startLng < bb.minLng - pad || seg.startLng > bb.maxLng + pad) continue;
    n += (await saveEfforts(seg, a, pts)).length;
  }
  return n;
}

async function saveEfforts(seg, activity, points) {
  const coords = geo.decodePolyline(seg.polyline);
  const found = findEfforts(coords, seg.distanceM, points);
  const saved = [];
  for (const f of found) {
    try {
      const ef = await prisma.segmentEffort.upsert({
        where: { segmentId_activityId_startedAt: { segmentId: seg.id, activityId: activity.id, startedAt: f.startedAt } },
        create: {
          segmentId: seg.id, activityId: activity.id, athleteId: activity.userId,
          elapsedMs: f.elapsedMs, startedAt: f.startedAt, avgHeartRate: f.avgHeartRate,
          // anti-fraude simples: velocidade média impossível vira esforço marcado (fora do ranking)
          flaggedFraud: seg.distanceM / (f.elapsedMs / 1000) > (seg.sportType === 'RIDE' ? 25 : 7),
        },
        update: {},
      });
      saved.push(ef);
    } catch (e) { if (e.code !== 'P2002') throw e; }
  }
  return saved;
}

/** Matching ao ingerir: devolve os esforços novos. */
async function matchActivity(activity, points) {
  const fam = family(activity.sportType);
  if (!fam || !points || points.length < 2) return [];
  const bb = geo.bbox(points);
  const pad = 0.0005; // ~55 m
  const segs = await prisma.segment.findMany({
    where: {
      sportType: fam,
      verificationState: { not: 'rejected' },
      startLat: { gte: bb.minLat - pad, lte: bb.maxLat + pad },
      startLng: { gte: bb.minLng - pad, lte: bb.maxLng + pad },
    },
    take: 300,
  });
  const out = [];
  for (const seg of segs) {
    if (seg.endLat < bb.minLat - pad || seg.endLat > bb.maxLat + pad || seg.endLng < bb.minLng - pad || seg.endLng > bb.maxLng + pad) continue;
    const efforts = await saveEfforts(seg, activity, points);
    for (const ef of efforts) out.push({ effort: ef, segment: seg });
  }
  return out;
}

async function athleteNames(ids) {
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, username: true } });
  const profiles = await prisma.athleteProfile.findMany({ where: { userId: { in: ids } }, select: { userId: true, sex: true, avatarUrl: true } }).catch(() => []);
  const m = {};
  for (const u of users) m[u.id] = { name: (u.name || 'Atleta').split(' ').slice(0, 2).join(' '), username: u.username };
  for (const p of profiles) if (m[p.userId]) { m[p.userId].sex = p.sex; m[p.userId].avatarUrl = p.avatarUrl; }
  return m;
}

/**
 * Ranking do segmento: melhor tempo por atleta.
 * period: all | month ; sex: M | F (só atletas com sexo no perfil).
 * Esforço de atividade "só eu" fica fora do ranking público.
 */
async function leaderboard(segmentId, { period = 'all', sex = null, limit = 50 } = {}) {
  const where = { segmentId, flaggedFraud: false, activity: { visibility: { not: 'private' }, processingState: 'done' } };
  if (period === 'month') {
    const { monthStartUtc } = require('./apexRewards');
    where.startedAt = { gte: monthStartUtc(new Date()) };
  }
  const efforts = await prisma.segmentEffort.findMany({ where, orderBy: [{ elapsedMs: 'asc' }, { startedAt: 'asc' }], take: 5000 });
  const best = new Map();
  for (const e of efforts) if (!best.has(e.athleteId)) best.set(e.athleteId, e);
  const names = await athleteNames([...best.keys()]);
  let rows = [...best.values()].map((e) => ({
    athleteId: e.athleteId, ...(names[e.athleteId] || { name: 'Atleta' }),
    elapsedMs: e.elapsedMs, startedAt: e.startedAt, activityId: e.activityId, effortId: e.id,
  }));
  if (sex === 'M' || sex === 'F') rows = rows.filter((r) => r.sex === sex);
  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

/** Local Legend: mais esforços nos últimos 90 dias (empate → quem chegou lá antes). */
async function localLegend(segmentId) {
  const since = new Date(Date.now() - LEGEND_DAYS * 86400e3);
  const groups = await prisma.segmentEffort.groupBy({
    by: ['athleteId'],
    where: { segmentId, flaggedFraud: false, startedAt: { gte: since }, activity: { visibility: { not: 'private' } } },
    _count: { _all: true },
    _min: { startedAt: true },
  });
  if (!groups.length) return null;
  groups.sort((a, b) => b._count._all - a._count._all || a._min.startedAt - b._min.startedAt);
  const top = groups[0];
  const names = await athleteNames([top.athleteId]);
  return { athleteId: top.athleteId, ...(names[top.athleteId] || {}), efforts: top._count._all, days: LEGEND_DAYS };
}

/** Badges ligados a segmento depois do matching (PR + Local Legend). */
async function segmentBadges(userId, matches) {
  const { awardBadge } = require('./apexRewards');
  const out = [];
  for (const { effort, segment } of matches) {
    if (effort.flaggedFraud) continue;
    const prev = await prisma.segmentEffort.findFirst({
      where: { segmentId: segment.id, athleteId: userId, id: { not: effort.id }, flaggedFraud: false },
      orderBy: { elapsedMs: 'asc' },
    });
    if (prev && effort.elapsedMs < prev.elapsedMs) {
      const b = await awardBadge(userId, `segment_pr:${effort.id}`, { metadata: { segmentId: segment.id, segmentName: segment.name, elapsedMs: effort.elapsedMs, previousMs: prev.elapsedMs } });
      if (b) out.push(b);
    }
    const ll = await localLegend(segment.id);
    if (ll && ll.athleteId === userId && ll.efforts >= 2) {
      const b = await awardBadge(userId, `local_legend:${segment.id}`, { metadata: { segmentId: segment.id, segmentName: segment.name, efforts: ll.efforts } });
      if (b) out.push(b);
    }
  }
  return out;
}

module.exports = {
  findEfforts, createSegmentFromActivity, matchActivity, leaderboard, localLegend,
  segmentBadges, backfillSegment, family, resample,
};
