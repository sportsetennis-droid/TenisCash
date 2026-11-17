// =====================================================================
// APEX — geometria e métricas de trilha (sem dependência externa)
// ---------------------------------------------------------------------
// Distância (haversine), polyline codificado (algoritmo Google, precisão 5),
// simplificação Douglas-Peucker, métricas da atividade (distância, tempo em
// movimento, elevação, ritmo, FC), parciais por km, série do gráfico e
// distância ponto-segmento (usada no matching de segmentos e na zona de
// privacidade).
//
// Formato de trilha usado em todo o módulo (pontos normalizados):
//   { t: epoch ms, lat, lng, alt?: m, hr?: bpm, seg?: true (começa trecho novo
//     depois de pausa — não soma distância/tempo desde o ponto anterior) }
// =====================================================================

const R_EARTH = 6371008.8; // raio médio (m) — mesmo valor do turf
const toRad = (d) => (d * Math.PI) / 180;

function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------- polyline
function encodeSigned(v) {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (n >= 0x20) { out += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
  return out + String.fromCharCode(n + 63);
}
function encodePolyline(coords, precision = 5) {
  const f = 10 ** precision;
  let pLat = 0, pLng = 0, out = '';
  for (const [lat, lng] of coords) {
    const la = Math.round(lat * f), ln = Math.round(lng * f);
    out += encodeSigned(la - pLat) + encodeSigned(ln - pLng);
    pLat = la; pLng = ln;
  }
  return out;
}
function decodePolyline(str, precision = 5) {
  const f = 10 ** precision;
  const out = [];
  let i = 0, lat = 0, lng = 0;
  while (str && i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i <= str.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / f, lng / f]);
  }
  return out;
}

// ------------------------------------------------- projeção local (metros)
// Equiretangular em torno de um ponto de referência: erro desprezível na
// escala de um segmento/zona (alguns km).
function projector(lat0, lng0) {
  const kx = Math.cos(toRad(lat0)) * (Math.PI / 180) * R_EARTH;
  const ky = (Math.PI / 180) * R_EARTH;
  return (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * ky];
}

function pointSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return Math.sqrt(x * x + y * y);
}

// Douglas-Peucker sobre [[lat,lng],...]; tolerância em metros.
function simplify(coords, tolM = 5) {
  if (coords.length <= 2) return coords.slice();
  const proj = projector(coords[0][0], coords[0][1]);
  const P = coords.map((c) => proj(c[0], c[1]));
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack = [[0, coords.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointSegDist(P[i], P[s], P[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return coords.filter((_, i) => keep[i]);
}

// Simplifica até caber em maxPts (aumenta a tolerância).
function simplifyTo(coords, maxPts = 600) {
  let tol = 3, out = simplify(coords, tol);
  while (out.length > maxPts && tol < 500) { tol *= 1.6; out = simplify(coords, tol); }
  return out;
}

// ------------------------------------------------------------ métricas
const MIN_MOVING_SPEED = { RIDE: 1.0, default: 0.45 }; // m/s
const MAX_GAP_S = 120; // salto maior que isso (sem marcar pausa) só conta se houve deslocamento

function hasGps(points) { return Array.isArray(points) && points.some((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)); }

/** Distância acumulada por ponto (m), respeitando quebras de trecho. */
function cumulative(points) {
  const cum = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const d = b.seg ? 0 : haversine(a.lat, a.lng, b.lat, b.lng);
    cum[i] = cum[i - 1] + d;
  }
  return cum;
}

// Ganho/perda de elevação com histerese (filtra ruído de GPS/barômetro).
function elevation(points, threshold = 3) {
  let gain = 0, loss = 0, ref = null;
  for (const p of points) {
    if (!Number.isFinite(p.alt)) continue;
    if (ref === null) { ref = p.alt; continue; }
    const d = p.alt - ref;
    if (d >= threshold) { gain += d; ref = p.alt; }
    else if (d <= -threshold) { loss += -d; ref = p.alt; }
  }
  return { gain: Math.round(gain * 10) / 10, loss: Math.round(loss * 10) / 10 };
}

/**
 * Métricas completas de uma trilha.
 * @returns {distanceM, elapsedTimeS, movingTimeS, elevationGainM, elevationLossM,
 *           avgPace (s/km), maxSpeed (m/s), avgHeartRate, maxHeartRate, startedAt, endedAt}
 */
function computeMetrics(points, sportType = 'RUN') {
  const pts = (points || []).filter((p) => Number.isFinite(p.t));
  if (!pts.length) return null;
  const minSpeed = MIN_MOVING_SPEED[sportType] || MIN_MOVING_SPEED.default;
  let dist = 0, moving = 0, maxSpeed = 0;
  const gps = hasGps(pts);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || b.seg) continue;
    if (!gps) { moving += dt; continue; }
    const d = haversine(a.lat, a.lng, b.lat, b.lng);
    dist += d;
    const v = d / dt;
    if (v >= minSpeed && (dt <= MAX_GAP_S || v >= minSpeed * 2)) moving += dt;
    if (dt >= 2 && v > maxSpeed) maxSpeed = v; // ignora picos de 1 amostra
  }
  const hrs = pts.map((p) => p.hr).filter((h) => Number.isFinite(h) && h > 25 && h < 240);
  const el = elevation(pts);
  const elapsed = Math.round((pts[pts.length - 1].t - pts[0].t) / 1000);
  return {
    startedAt: new Date(pts[0].t),
    endedAt: new Date(pts[pts.length - 1].t),
    distanceM: gps ? Math.round(dist * 10) / 10 : null,
    elapsedTimeS: elapsed,
    movingTimeS: Math.min(elapsed, Math.round(moving)),
    elevationGainM: gps && pts.some((p) => Number.isFinite(p.alt)) ? el.gain : null,
    elevationLossM: gps && pts.some((p) => Number.isFinite(p.alt)) ? el.loss : null,
    avgPace: gps && dist > 50 && moving > 0 ? Math.round((moving / (dist / 1000)) * 10) / 10 : null,
    maxSpeed: gps ? Math.round(maxSpeed * 100) / 100 : null,
    avgHeartRate: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
    maxHeartRate: hrs.length ? Math.max(...hrs) : null,
  };
}

/** Parciais por km (último parcial pode ser fração). */
function splitsPerKm(points) {
  if (!hasGps(points) || points.length < 2) return [];
  const cum = cumulative(points);
  const out = [];
  let km = 1, startIdx = 0;
  const flush = (endIdx, frac) => {
    const a = points[startIdx], b = points[endIdx];
    const timeS = (b.t - a.t) / 1000;
    const distM = cum[endIdx] - cum[startIdx];
    const hrs = points.slice(startIdx, endIdx + 1).map((p) => p.hr).filter(Number.isFinite);
    out.push({
      km: frac ? Math.round((distM / 1000) * 100) / 100 : km,
      distanceM: Math.round(distM),
      timeS: Math.round(timeS),
      paceS: distM > 0 ? Math.round(timeS / (distM / 1000)) : null,
      elevDiffM: Number.isFinite(b.alt) && Number.isFinite(a.alt) ? Math.round(b.alt - a.alt) : null,
      avgHr: hrs.length ? Math.round(hrs.reduce((s, h) => s + h, 0) / hrs.length) : null,
      partial: !!frac,
    });
  };
  for (let i = 1; i < points.length; i++) {
    if (cum[i] >= km * 1000) { flush(i, false); startIdx = i; km++; }
  }
  if (cum[points.length - 1] - cum[startIdx] >= 50) flush(points.length - 1, true);
  return out;
}

/** Série reduzida pro gráfico: [{d (km), alt, pace (s/km suavizado), hr}] */
function chartSeries(points, maxPts = 300) {
  if (!hasGps(points) || points.length < 2) return [];
  const cum = cumulative(points);
  const step = Math.max(1, Math.floor(points.length / maxPts));
  const out = [];
  for (let i = 0; i < points.length; i += step) {
    // ritmo suavizado numa janela de ~200 m
    let j = i;
    while (j > 0 && cum[i] - cum[j] < 200) j--;
    const dd = cum[i] - cum[j], dt = (points[i].t - points[j].t) / 1000;
    out.push({
      d: Math.round(cum[i]) / 1000,
      alt: Number.isFinite(points[i].alt) ? Math.round(points[i].alt * 10) / 10 : null,
      pace: dd > 30 && dt > 0 ? Math.round(dt / (dd / 1000)) : null,
      hr: Number.isFinite(points[i].hr) ? points[i].hr : null,
    });
  }
  return out;
}

function bbox(points) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const p of points) {
    if (!Number.isFinite(p.lat)) continue;
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

// ------------------------------------------- streams <-> pontos (banco)
function pointsToStreams(points) {
  const s = { t: [], lat: [], lng: [], alt: [], hr: [], seg: [] };
  if (!points.length) return s;
  const t0 = points[0].t;
  points.forEach((p, i) => {
    s.t.push(Math.round((p.t - t0) / 100) / 10);
    s.lat.push(Number.isFinite(p.lat) ? Math.round(p.lat * 1e6) / 1e6 : null);
    s.lng.push(Number.isFinite(p.lng) ? Math.round(p.lng * 1e6) / 1e6 : null);
    s.alt.push(Number.isFinite(p.alt) ? Math.round(p.alt * 10) / 10 : null);
    s.hr.push(Number.isFinite(p.hr) ? Math.round(p.hr) : null);
    if (p.seg) s.seg.push(i);
  });
  if (s.alt.every((v) => v === null)) delete s.alt;
  if (s.hr.every((v) => v === null)) delete s.hr;
  s.t0 = t0;
  return s;
}

function streamsToPoints(streams) {
  if (!streams || !Array.isArray(streams.t)) return [];
  const segs = new Set(streams.seg || []);
  const t0 = Number(streams.t0) || 0;
  return streams.t.map((t, i) => ({
    t: t0 + t * 1000,
    lat: streams.lat ? streams.lat[i] : null,
    lng: streams.lng ? streams.lng[i] : null,
    alt: streams.alt ? streams.alt[i] : null,
    hr: streams.hr ? streams.hr[i] : null,
    seg: segs.has(i) || undefined,
  })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

// Reduz trilha muito longa (mantém 1 ponto a cada N) pra caber no banco.
function downsample(points, maxPts = 20000) {
  if (points.length <= maxPts) return points;
  const step = Math.ceil(points.length / maxPts);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i % step === 0 || i === points.length - 1 || points[i].seg) out.push(points[i]);
  }
  return out;
}

// Insere pontos a cada stepM metros em [[lat,lng],...] (pra recortar a
// zona de privacidade sem apagar um trecho reto inteiro do polyline simplificado).
function densify(coords, stepM = 20) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [la1, ln1] = coords[i - 1], [la2, ln2] = coords[i];
    const n = Math.min(2000, Math.floor(haversine(la1, ln1, la2, ln2) / stepM));
    for (let k = 1; k <= n; k++) out.push([la1 + ((la2 - la1) * k) / (n + 1), ln1 + ((ln2 - ln1) * k) / (n + 1)]);
    out.push(coords[i]);
  }
  return out;
}

// --------------------------------------------- zona de privacidade
/** Remove pontos dentro de qualquer zona {lat,lng,radiusM}. */
function applyPrivacyZones(points, zones) {
  if (!zones || !zones.length) return points;
  let lastHidden = false;
  const out = [];
  for (const p of points) {
    const hidden = zones.some((z) => haversine(p.lat, p.lng, z.lat, z.lng) <= (z.radiusM || 300));
    if (!hidden) { out.push(lastHidden && out.length ? { ...p, seg: true } : p); }
    lastHidden = hidden;
  }
  return out;
}

module.exports = {
  haversine, encodePolyline, decodePolyline, simplify, simplifyTo, projector, pointSegDist,
  computeMetrics, cumulative, elevation, splitsPerKm, chartSeries, bbox, hasGps,
  pointsToStreams, streamsToPoints, downsample, applyPrivacyZones, densify,
};
