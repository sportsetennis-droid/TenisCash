// =====================================================================
// APEX — import de arquivo do relógio/app (GPX, TCX, FIT; também .gz)
// ---------------------------------------------------------------------
// GPX/TCX: @tmcw/togeojson (BSD-2) + @xmldom/xmldom (MIT).
// FIT:     fit-file-parser (MIT, build CommonJS em dist/cjs).
// Saída única: { sportType, name, points:[{t,lat,lng,alt,hr}], deviceSource }
// =====================================================================

const zlib = require('zlib');

const SPORT_MAP = [
  [/trail/i, 'TRAIL_RUN'],
  [/treadmill|esteira/i, 'TREADMILL'],
  [/run|corrida|jog/i, 'RUN'],
  [/walk|caminhada/i, 'WALK'],
  [/hik|trilha/i, 'HIKE'],
  [/bik|cycl|ride|bike|ciclismo|pedal/i, 'RIDE'],
  [/swim|nata/i, 'SWIM'],
  [/beach.?tennis/i, 'BEACH_TENNIS'],
  [/padel/i, 'PADEL'],
  [/tennis|tênis/i, 'TENNIS'],
];
// Códigos numéricos que o Strava grava no <type> do GPX exportado
const STRAVA_GPX_TYPES = { 1: 'RIDE', 4: 'HIKE', 9: 'RUN', 10: 'WALK' };

function mapSport(raw, fallback = 'RUN') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  if (STRAVA_GPX_TYPES[s]) return STRAVA_GPX_TYPES[s];
  for (const [re, v] of SPORT_MAP) if (re.test(s)) return v;
  return fallback;
}

function detectFormat(buf, filename = '') {
  const name = String(filename).toLowerCase().replace(/\.gz$/, '');
  if (buf.length > 12 && buf.toString('ascii', 8, 12) === '.FIT') return 'fit';
  if (name.endsWith('.fit')) return 'fit';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 2000));
  if (/<TrainingCenterDatabase/i.test(head) || name.endsWith('.tcx')) return 'tcx';
  if (/<gpx/i.test(head) || name.endsWith('.gpx')) return 'gpx';
  return null;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

// ------------------------------------------------------------- GPX / TCX
function parseXml(buf, format) {
  const { DOMParser } = require('@xmldom/xmldom');
  const tj = require('@tmcw/togeojson');
  const text = buf.toString('utf8').replace(/^﻿/, '');
  const doc = new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml');
  const fc = format === 'tcx' ? tj.tcx(doc) : tj.gpx(doc);
  const points = [];
  let name = null, rawType = null;
  for (const f of fc.features || []) {
    const g = f.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) continue;
    name = name || f.properties?.name || null;
    rawType = rawType || f.properties?.type || f.properties?.sport || null;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    const cp = f.properties?.coordinateProperties || {};
    const pick = (arr, li) => (g.type === 'LineString' ? arr : (arr || [])[li]);
    lines.forEach((coords, li) => {
      const times = pick(cp.times, li) || [];
      const hrArr = pick(cp.heart || cp.heartRates, li) || [];
      coords.forEach((c, i) => {
        const t = times[i] ? Date.parse(times[i]) : NaN;
        points.push({
          t, lat: num(c[1]), lng: num(c[0]), alt: num(c[2]), hr: num(hrArr[i]),
          seg: li > 0 && i === 0 ? true : undefined,
        });
      });
    });
  }
  // TCX: o esporte fica no atributo Sport de <Activity>
  if (format === 'tcx' && !rawType) {
    const m = text.match(/<Activity[^>]*Sport="([^"]+)"/i);
    if (m) rawType = m[1];
  }
  if (format === 'gpx' && !rawType) {
    const m = text.match(/<type>([^<]+)<\/type>/i);
    if (m) rawType = m[1];
  }
  const creator = (text.match(/creator="([^"]+)"/i) || [])[1] || null;
  return { name, rawType, points, deviceSource: creator ? String(creator).slice(0, 60) : format };
}

// ------------------------------------------------------------------ FIT
async function parseFit(buf) {
  const mod = require('fit-file-parser');
  const FitParser = mod.default || mod;
  const parser = new FitParser({ force: true, speedUnit: 'm/s', lengthUnit: 'm', temperatureUnit: 'celsius', mode: 'list' });
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const data = await parser.parseAsync(ab);
  const points = [];
  for (const r of data.records || []) {
    const t = r.timestamp ? new Date(r.timestamp).getTime() : NaN;
    points.push({
      t,
      lat: num(r.position_lat),
      lng: num(r.position_long),
      alt: num(r.enhanced_altitude ?? r.altitude),
      hr: num(r.heart_rate),
    });
  }
  const session = (data.sessions || [])[0] || {};
  const sport = session.sport || (data.sports || [])[0]?.sport || (data.activity || {}).sport;
  const fileId = (data.file_ids || [])[0] || data.file_id || {};
  return {
    name: null,
    rawType: sport,
    points,
    deviceSource: fileId.manufacturer ? String(fileId.manufacturer).slice(0, 60) : 'fit',
    session,
  };
}

/**
 * Lê um arquivo e devolve trilha normalizada.
 * @returns {ok, format, sportType, name, points, deviceSource} | {ok:false, error}
 */
async function parseActivityFile(buffer, filename = '', sportHint) {
  if (!buffer || !buffer.length) return { ok: false, error: 'arquivo vazio' };
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try { buf = zlib.gunzipSync(buf, { maxOutputLength: 80 * 1024 * 1024 }); } catch (e) { return { ok: false, error: 'arquivo .gz inválido' }; }
  }
  const format = detectFormat(buf, filename);
  if (!format) return { ok: false, error: 'formato não reconhecido (use GPX, TCX ou FIT)' };
  let parsed;
  try {
    parsed = format === 'fit' ? await parseFit(buf) : parseXml(buf, format);
  } catch (e) {
    return { ok: false, error: `não consegui ler o ${format.toUpperCase()}: ${e.message}` };
  }
  const withTime = parsed.points.filter((p) => Number.isFinite(p.t));
  if (withTime.length < 2) return { ok: false, error: 'arquivo sem pontos com horário' };
  withTime.sort((a, b) => a.t - b.t);
  const gps = withTime.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180 && !(p.lat === 0 && p.lng === 0));
  // Sem GPS (esteira, quadra): mantém só tempo/FC.
  const points = gps.length >= 2 ? gps : withTime.map((p) => ({ t: p.t, hr: p.hr }));
  return {
    ok: true,
    format,
    sportType: sportHint || mapSport(parsed.rawType, gps.length >= 2 ? 'RUN' : 'OTHER'),
    name: parsed.name,
    points,
    deviceSource: parsed.deviceSource,
  };
}

module.exports = { parseActivityFile, detectFormat, mapSport };
