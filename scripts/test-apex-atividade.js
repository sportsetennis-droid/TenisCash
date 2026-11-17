#!/usr/bin/env node
// =====================================================================
// Teste do app de atividade APEX (F4) — banco DESCARTÁVEL, nunca prod.
// ---------------------------------------------------------------------
// Uso:
//   psql -h localhost -p 55432 -U postgres -c "create database club_f4"
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f4 npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f4 node scripts/test-apex-atividade.js
//   (opcional) --write-fixtures  grava amostras GPX/TCX/FIT em scripts/fixtures/apex/
// Cobre: geometria (valor conhecido), consentimento, ingestão idempotente,
// import GPX/TCX/FIT, isolamento entre usuários, visibilidade/seguidores,
// zona de privacidade, segmento + matching + ranking + Local Legend, badges
// idempotentes, cashback desligado por padrão e ligado com teto, sequência
// de 7 dias, 100 km no mês, desafios oficial e de grupo, Beacon (expira) e
// o SQL aditivo do ensureApexSchema num banco vazio.
// =====================================================================

const DB = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(DB)) {
  console.error('Recusado: DATABASE_URL precisa ser um banco LOCAL descartável.');
  process.exit(2);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'apex-test-secret';

const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const { execSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const { prisma, JWT_SECRET } = require('../src/middleware');
const geo = require('../src/services/apexGeo');
const rewards = require('../src/services/apexRewards');
const segments = require('../src/services/apexSegments');

let pass = 0, failN = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { failN++; console.log('  ✗', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ------------------------------------------------------------ trilhas
// Rota em João Pessoa: 5003,8 m para o norte (0,045° de latitude) + ~1655 m para leste.
const ROUTE = [[-7.1500, -34.8300], [-7.1050, -34.8300], [-7.1050, -34.8150]];
function makeTrack(waypoints, { start, speed = 3.0, stepS = 5, hr = 150, alt0 = 10, offsetLng = 0 }) {
  const pts = [];
  let t = start;
  let carry = 0;
  pts.push({ t, lat: waypoints[0][0], lng: waypoints[0][1] + offsetLng, alt: alt0, hr });
  for (let i = 1; i < waypoints.length; i++) {
    const [la1, ln1] = waypoints[i - 1], [la2, ln2] = waypoints[i];
    const d = geo.haversine(la1, ln1, la2, ln2);
    const stepM = speed * stepS;
    let pos = stepM - carry;
    while (pos <= d) {
      const f = pos / d;
      t += stepS * 1000;
      pts.push({ t, lat: la1 + (la2 - la1) * f, lng: ln1 + (ln2 - ln1) * f + offsetLng, alt: alt0 + (pts.length % 50 < 25 ? pts.length % 25 : 25 - (pts.length % 25)) * 0.4, hr: hr + (pts.length % 7) });
      pos += stepM;
    }
    carry = d - (pos - stepM);
  }
  const last = waypoints[waypoints.length - 1];
  t += Math.max(1, Math.round((carry / speed) * 1000));
  pts.push({ t, lat: last[0], lng: last[1] + offsetLng, alt: alt0, hr });
  return pts;
}
function toGpx(pts, name = 'Treino GPX', type = 'running') {
  const trk = pts.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><ele>${p.alt.toFixed(1)}</ele><time>${new Date(p.t).toISOString()}</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${p.hr}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Garmin Connect" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<trk><name>${name}</name><type>${type}</type><trkseg>\n${trk}\n</trkseg></trk></gpx>\n`;
}
function toTcx(pts, sport = 'Running') {
  const tp = pts.map((p) => `<Trackpoint><Time>${new Date(p.t).toISOString()}</Time><Position><LatitudeDegrees>${p.lat.toFixed(7)}</LatitudeDegrees><LongitudeDegrees>${p.lng.toFixed(7)}</LongitudeDegrees></Position><AltitudeMeters>${p.alt.toFixed(1)}</AltitudeMeters><HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm></Trackpoint>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="${sport}"><Id>${new Date(pts[0].t).toISOString()}</Id><Lap StartTime="${new Date(pts[0].t).toISOString()}"><Track>\n${tp}\n</Track></Lap></Activity></Activities></TrainingCenterDatabase>\n`;
}
function toFit(pts, sport = 1 /* running */) {
  const { FitEncoder, FitBaseType } = require('fit-file-parser');
  const enc = new FitEncoder();
  const ts = (ms) => FitEncoder.toFitTimestamp(new Date(ms));
  enc.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },          // type = activity
    { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 1 },        // manufacturer = garmin
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: ts(pts[0].t) },
  ], 0);
  for (const p of pts) {
    enc.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(p.t) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: Math.round((p.lat * 2 ** 31) / 180) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: Math.round((p.lng * 2 ** 31) / 180) },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: Math.round((p.alt + 500) * 5) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: p.hr },
    ], 1);
  }
  enc.writeMessage(18, [
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(pts[pts.length - 1].t) },
    { number: 5, size: 1, baseType: FitBaseType.Enum, value: sport },
  ], 2);
  return Buffer.from(enc.close());
}
const asPayloadPoints = (pts) => pts.map((p) => [p.t, p.lat, p.lng, p.alt, 5]);

// ------------------------------------------------------------- servidor
function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1.5mb' }));
  app.use('/api/activities', require('../src/routes/activities'));
  app.use('/api/segments', require('../src/routes/segments'));
  app.use('/api/activity-challenges', require('../src/routes/activityChallenges'));
  app.use('/api/beacon', require('../src/routes/beaconPublic'));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
let BASE = '';
async function call(token, method, url, body, isForm) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (isForm) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + url, { method, headers, body: payload });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}
async function upload(token, name, buf, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return call(token, 'POST', '/api/activities/import', fd, true);
}

async function mkUser(tag, role = 'user', sex) {
  const u = await prisma.user.create({ data: { name: `Atleta ${tag} Teste`, phone: `55839${Date.now() % 1e6}${Math.floor(Math.random() * 1e4)}`, pin: 'x', role } });
  if (sex) await prisma.athleteProfile.create({ data: { userId: u.id, sex } });
  return { id: u.id, token: jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' }) };
}
async function consent(u) { return call(u.token, 'POST', '/api/activities/consent', { scope: 'location_history', granted: true }); }

// ======================================================================
async function main() {
  const server = await startServer();
  BASE = `http://127.0.0.1:${server.address().port}`;
  const DAY = 86400e3;
  const now = Date.now();

  console.log('\n[1] Geometria');
  ok(near(geo.haversine(-7.15, -34.83, -7.105, -34.83), 5003.8, 0.5), '0,045° de latitude = 5003,8 m (haversine)', geo.haversine(-7.15, -34.83, -7.105, -34.83));
  ok(geo.encodePolyline([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]) === '_p~iF~ps|U_ulLnnqC_mqNvxq`@', 'polyline = exemplo oficial do algoritmo');
  const dec = geo.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  ok(dec.length === 3 && near(dec[2][0], 43.252, 1e-6) && near(dec[2][1], -126.453, 1e-6), 'polyline decodifica de volta');
  const base = makeTrack(ROUTE, { start: now - 20 * DAY });
  const mBase = geo.computeMetrics(base, 'RUN');
  const expected = 5003.8 + geo.haversine(-7.105, -34.83, -7.105, -34.815);
  ok(near(mBase.distanceM, expected, 5), `distância da trilha ≈ ${expected.toFixed(1)} m`, mBase.distanceM);
  ok(near(mBase.avgPace, 1000 / 3, 3), 'ritmo ≈ 5:33/km (3 m/s)', mBase.avgPace);
  const splits = geo.splitsPerKm(base);
  ok(splits.length === 7 && splits[0].km === 1 && near(splits[0].paceS, 333, 3), 'parciais por km (6 cheios + 1 parcial)', splits.map((s) => s.km));
  const paused = base.map((p, i) => (i === 100 ? { ...p, seg: true, t: p.t + 600e3 } : i > 100 ? { ...p, t: p.t + 600e3 } : p));
  const mp = geo.computeMetrics(paused, 'RUN');
  ok(mp.elapsedTimeS - mBase.elapsedTimeS === 600 && Math.abs(mp.movingTimeS - mBase.movingTimeS) <= 5, 'pausa: entra no total, não no tempo em movimento');

  // ---------------------------------------------------------- usuários
  const A = await mkUser('A', 'user', 'M');
  const B = await mkUser('B', 'user', 'F');
  const ADM = await mkUser('Admin', 'admin');

  console.log('\n[2] Consentimento + ingestão');
  const payload = { clientId: 'cli-a-1', sportType: 'RUN', visibility: 'public', points: asPayloadPoints(base) };
  let r = await call(A.token, 'POST', '/api/activities', payload);
  ok(r.status === 428 && r.body.consentScope === 'location_history', 'sem consentimento de localização → 428', r);
  r = await consent(A);
  ok(r.status === 201, 'consentimento registrado (Consent)');
  r = await call(A.token, 'POST', '/api/activities', payload);
  ok(r.status === 201 && r.body.activityId, 'atividade gravada', r.body);
  const actA1 = r.body.activityId;
  const keys1 = (r.body.badges || []).map((b) => b.key);
  ok(keys1.includes('first_activity') && keys1.includes('dist_5k'), 'badges 1ª atividade + 5 km', keys1);
  const row = await prisma.activity.findUnique({ where: { id: actA1 } });
  ok(near(row.distanceM, expected, 5) && row.userId === A.id && row.summaryPolyline && row.streams, 'distância calculada no servidor + polyline + streams');
  r = await call(A.token, 'POST', '/api/activities', payload);
  ok(r.status === 200 && r.body.duplicate && r.body.activityId === actA1, 'reenvio offline (mesmo clientId) é idempotente');
  ok((await prisma.badgeEarned.count({ where: { userId: A.id } })) === 2, 'reenvio não duplica badge');
  r = await call(A.token, 'POST', '/api/activities', { ...payload, clientId: 'cli-a-other' });
  ok(r.status === 409, 'mesma atividade com outro id → 409 (duplicata por horário)');
  r = await call(A.token, 'POST', '/api/activities', { sportType: 'BEACH_TENNIS', startedAt: new Date(now - 3 * 3600e3).toISOString(), elapsedTimeS: 3600, visibility: 'private' });
  ok(r.status === 201, 'treino sem GPS (beach tennis) gravado');
  const actPriv = r.body.activityId;
  r = await call(A.token, 'POST', '/api/activities', { sportType: 'RUN', startedAt: new Date(now - 5 * 3600e3).toISOString(), elapsedTimeS: 600, distanceM: 10000 });
  ok(r.status === 400 && /implausível/.test(r.body.error), 'anti-fraude: 10 km em 10 min recusado');

  console.log('\n[3] Import GPX / TCX / FIT');
  const tGpx = makeTrack(ROUTE, { start: now - 15 * DAY, speed: 2.9 });
  r = await upload(A.token, 'treino.gpx', Buffer.from(toGpx(tGpx)), { visibility: 'public' });
  ok(r.status === 201 && r.body.format === 'gpx', 'GPX importado', r.body);
  let imp = await prisma.activity.findUnique({ where: { id: r.body.activityId } });
  ok(imp && near(imp.distanceM, expected, 5) && imp.avgHeartRate >= 150 && imp.elevationGainM > 0 && imp.title === 'Treino GPX', 'GPX: distância, FC média, elevação e nome', imp && { d: imp.distanceM, hr: imp.avgHeartRate, el: imp.elevationGainM, t: imp.title });
  r = await upload(A.token, 'treino.gpx', Buffer.from(toGpx(tGpx)));
  ok(r.status === 409, 'mesmo GPX de novo → 409');
  const tTcx = makeTrack(ROUTE, { start: now - 14 * DAY, speed: 3.1 });
  r = await upload(A.token, 'treino.tcx', Buffer.from(toTcx(tTcx)));
  imp = r.body.activityId && await prisma.activity.findUnique({ where: { id: r.body.activityId } });
  ok(r.status === 201 && r.body.format === 'tcx' && imp.sportType === 'RUN' && near(imp.distanceM, expected, 5), 'TCX importado (esporte + distância)', r.body);
  const tFit = makeTrack(ROUTE, { start: now - 13 * DAY, speed: 3.05 });
  const fitBuf = toFit(tFit);
  r = await upload(A.token, 'relogio.fit', fitBuf);
  imp = r.body.activityId && await prisma.activity.findUnique({ where: { id: r.body.activityId } });
  ok(r.status === 201 && r.body.format === 'fit' && near(imp.distanceM, expected, 5) && imp.avgHeartRate >= 150, 'FIT importado (distância + FC)', r.body);
  const zlib = require('zlib');
  r = await upload(A.token, 'relogio2.fit.gz', zlib.gzipSync(toFit(makeTrack(ROUTE, { start: now - 12 * DAY, speed: 3.0 }))));
  ok(r.status === 201 && r.body.format === 'fit', 'FIT compactado (.gz, export do Strava)');
  r = await upload(A.token, 'lixo.txt', Buffer.from('nada aqui'));
  ok(r.status === 400, 'arquivo inválido → 400');
  if (process.argv.includes('--write-fixtures')) {
    const dir = path.join(__dirname, 'fixtures', 'apex');
    fs.mkdirSync(dir, { recursive: true });
    const sample = makeTrack(ROUTE, { start: Date.parse('2026-11-01T09:00:00Z') });
    fs.writeFileSync(path.join(dir, 'corrida-joao-pessoa.gpx'), toGpx(sample, 'Corrida na orla'));
    fs.writeFileSync(path.join(dir, 'corrida-joao-pessoa.tcx'), toTcx(makeTrack(ROUTE, { start: Date.parse('2026-11-02T09:00:00Z') })));
    fs.writeFileSync(path.join(dir, 'corrida-joao-pessoa.fit'), toFit(makeTrack(ROUTE, { start: Date.parse('2026-11-03T09:00:00Z') })));
    console.log('  (amostras gravadas em scripts/fixtures/apex/)');
  }
  for (const f of ['corrida-joao-pessoa.gpx', 'corrida-joao-pessoa.tcx', 'corrida-joao-pessoa.fit']) {
    const p = path.join(__dirname, 'fixtures', 'apex', f);
    if (!fs.existsSync(p)) continue;
    const parsed = await require('../src/services/activityImport').parseActivityFile(fs.readFileSync(p), f);
    const mm = parsed.ok && geo.computeMetrics(parsed.points, parsed.sportType);
    ok(parsed.ok && near(mm.distanceM, expected, 5), `amostra versionada ${f} lê ${expected.toFixed(0)} m`, mm && mm.distanceM);
  }

  console.log('\n[4] Isolamento entre usuários + visibilidade');
  r = await call(B.token, 'GET', `/api/activities/${actPriv}`);
  ok(r.status === 404, 'B não lê atividade privada de A');
  r = await call(B.token, 'PATCH', `/api/activities/${actA1}`, { title: 'hack' });
  ok(r.status === 404, 'B não edita atividade de A');
  r = await call(B.token, 'DELETE', `/api/activities/${actA1}`);
  ok(r.status === 404 && !!(await prisma.activity.findUnique({ where: { id: actA1 } })), 'B não apaga atividade de A');
  await consent(B);
  r = await call(B.token, 'POST', '/api/activities', { userId: A.id, sportType: 'WALK', startedAt: new Date(now - 30 * 3600e3).toISOString(), elapsedTimeS: 1800 });
  const forged = r.body.activityId && await prisma.activity.findUnique({ where: { id: r.body.activityId } });
  ok(r.status === 201 && forged.userId === B.id, 'userId no body é ignorado (grava pro dono do token)');
  r = await call(B.token, 'GET', '/api/activities');
  ok(r.status === 200 && r.body.activities.every((a) => a.userId === B.id), 'lista padrão só traz as do próprio usuário');
  r = await call(B.token, 'GET', `/api/activities?userId=${A.id}`);
  ok(r.status === 200 && r.body.activities.length > 0 && r.body.activities.every((a) => a.visibility === 'public'), 'lista de A vista por B: só públicas');
  r = await call(B.token, 'GET', `/api/activities/${actA1}`);
  ok(r.status === 200 && !r.body.streams && !r.body.track && r.body.isOwner === false, 'B vê atividade pública de A sem pontos crus');
  r = await call(A.token, 'PATCH', `/api/activities/${actA1}`, { visibility: 'followers', title: 'Longão de domingo' });
  ok(r.status === 200 && r.body.activity.title === 'Longão de domingo', 'dono edita título/visibilidade');
  r = await call(B.token, 'GET', `/api/activities/${actA1}`);
  ok(r.status === 404, '"seguidores": B (não segue) não vê');
  await call(B.token, 'POST', `/api/activities/follow/${A.id}`);
  r = await call(B.token, 'GET', `/api/activities/${actA1}`);
  ok(r.status === 200, '"seguidores": depois de seguir, B vê');
  await call(A.token, 'PATCH', `/api/activities/${actA1}`, { visibility: 'public' });

  console.log('\n[5] Zona de privacidade');
  r = await call(A.token, 'POST', '/api/activities/privacy-zones', { lat: ROUTE[0][0], lng: ROUTE[0][1], radiusM: 300, label: 'Casa' });
  ok(r.status === 201, 'zona criada em volta de casa (início da rota)');
  r = await call(B.token, 'GET', `/api/activities/${actA1}`);
  const pubPts = geo.decodePolyline(r.body.summaryPolyline || '');
  const minD = Math.min(...pubPts.map(([la, ln]) => geo.haversine(la, ln, ROUTE[0][0], ROUTE[0][1])));
  ok(pubPts.length >= 2 && minD > 300 && minD < 400, `visitante não vê ponto a menos de 300 m de casa (mais perto: ${Math.round(minD)} m) — o resto da trilha continua visível`);
  r = await call(A.token, 'GET', `/api/activities/${actA1}`);
  const ownPts = geo.decodePolyline(r.body.summaryPolyline);
  ok(geo.haversine(ownPts[0][0], ownPts[0][1], ROUTE[0][0], ROUTE[0][1]) < 5 && r.body.track.length > 10, 'dono continua vendo a trilha completa');
  r = await call(B.token, 'GET', `/api/activities?userId=${A.id}`);
  ok(r.body.activities.every((a) => !a.summaryPolyline || Math.min(...geo.decodePolyline(a.summaryPolyline).map(([la, ln]) => geo.haversine(la, ln, ROUTE[0][0], ROUTE[0][1]))) > 300), 'zona aplicada também na lista');

  console.log('\n[6] Segmento + matching + ranking + Local Legend');
  const detail = (await call(A.token, 'GET', `/api/activities/${actA1}`)).body;
  const tr = detail.track;
  const sIdx = tr.find((p) => p[3] >= 1000)[2], eIdx = tr.find((p) => p[3] >= 2500)[2];
  r = await call(B.token, 'POST', '/api/segments', { activityId: actA1, startIdx: sIdx, endIdx: eIdx, name: 'Subida falsa' });
  ok(r.status === 404, 'B não cria segmento da atividade de A');
  r = await call(A.token, 'POST', '/api/segments', { activityId: actA1, startIdx: sIdx, endIdx: eIdx, name: 'Orla — reta do Cabo Branco' });
  ok(r.status === 201 && near(r.body.segment.distanceM, 1500, 20), 'segmento de ~1,5 km criado', r.body);
  const segId = r.body.segment.id;
  ok(r.body.backfilled >= 5, `backfill casou as atividades anteriores de A (${r.body.backfilled})`);
  r = await call(A.token, 'POST', '/api/segments', { activityId: actA1, startIdx: sIdx, endIdx: eIdx, name: 'Duplicado' });
  ok(r.status === 409, 'segmento igual → 409');
  // B corre mais rápido no mesmo trajeto → casa automático
  const fastB = makeTrack(ROUTE, { start: now - 2 * DAY, speed: 4.0 });
  r = await call(B.token, 'POST', '/api/activities', { clientId: 'b-fast', sportType: 'RUN', visibility: 'public', points: asPayloadPoints(fastB) });
  ok(r.status === 201 && r.body.efforts === 1, 'esforço casado automaticamente na ingestão', r.body);
  // trajeto paralelo (220 m a leste) e sentido contrário → não casam
  r = await call(B.token, 'POST', '/api/activities', { clientId: 'b-par', sportType: 'RUN', points: asPayloadPoints(makeTrack(ROUTE, { start: now - 3 * DAY, offsetLng: 0.002 })) });
  ok(r.status === 201 && r.body.efforts === 0, 'rua paralela (220 m) não casa');
  r = await call(B.token, 'POST', '/api/activities', { clientId: 'b-rev', sportType: 'RUN', points: asPayloadPoints(makeTrack([...ROUTE].reverse(), { start: now - 4 * DAY })) });
  ok(r.status === 201 && r.body.efforts === 0, 'sentido contrário não casa');
  r = await call(B.token, 'POST', '/api/activities', { clientId: 'b-ride', sportType: 'RIDE', points: asPayloadPoints(makeTrack(ROUTE, { start: now - 5 * DAY, speed: 7 })) });
  ok(r.status === 201 && r.body.efforts === 0, 'pedal não entra em segmento de corrida');
  r = await call(A.token, 'GET', `/api/segments/${segId}`);
  const lb = r.body.leaderboard;
  ok(r.status === 200 && lb[0].athleteId === B.id && near(lb[0].elapsedMs, 375000, 3000), 'ranking geral: B primeiro (~6:15)', lb.map((x) => [x.name, x.elapsedMs]));
  ok(lb.length === 2 && lb[1].athleteId === A.id, 'ranking traz o melhor tempo de cada atleta (1 linha por atleta)');
  r = await call(A.token, 'GET', `/api/segments/${segId}?sex=M`);
  ok(r.body.leaderboard.length === 1 && r.body.leaderboard[0].athleteId === A.id, 'filtro homens');
  r = await call(A.token, 'GET', `/api/segments/${segId}?sex=F`);
  ok(r.body.leaderboard.length === 1 && r.body.leaderboard[0].athleteId === B.id, 'filtro mulheres');
  r = await call(A.token, 'GET', `/api/segments/${segId}?period=month`);
  ok(r.body.leaderboard.every((x) => new Date(x.startedAt) >= rewards.monthStartUtc(new Date())), 'filtro do mês');
  ok(r.body.localLegend && r.body.localLegend.athleteId === A.id && r.body.localLegend.efforts >= 5, 'Local Legend = A (mais esforços em 90 dias)', r.body.localLegend);
  // A corre de novo, mais rápido que o próprio melhor → PR + Local Legend como badge
  r = await call(A.token, 'POST', '/api/activities', { clientId: 'a-pr', sportType: 'RUN', visibility: 'public', points: asPayloadPoints(makeTrack(ROUTE, { start: now - 1 * DAY, speed: 3.5 })) });
  const kk = (r.body.badges || []).map((b) => b.key);
  ok(kk.some((k) => k.startsWith('segment_pr:')), 'badge de recorde pessoal no segmento', kk);
  ok(kk.includes(`local_legend:${segId}`), 'badge Local Legend', kk);
  const actAPR = r.body.activityId;
  r = await call(A.token, 'GET', `/api/activities/${actAPR}`);
  ok(r.body.segmentEfforts.length === 1 && r.body.segmentEfforts[0].isPR, 'detalhe da atividade mostra o segmento com PR');
  // pura: findEfforts com trilha que passa 2x (2 voltas) acha 2 esforços
  const coords = geo.decodePolyline((await prisma.segment.findUnique({ where: { id: segId } })).polyline);
  const twoLaps = makeTrack([ROUTE[0], ROUTE[1], ROUTE[0], ROUTE[1]], { start: now - 40 * DAY });
  ok(segments.findEfforts(coords, 1500, twoLaps).length === 2, 'trilha com 2 passagens = 2 esforços');

  console.log('\n[7] Badges idempotentes + cashback');
  const b1 = await rewards.awardBadge(A.id, 'dist_42k', { silent: true });
  const b2 = await rewards.awardBadge(A.id, 'dist_42k', { silent: true });
  ok(b1 && !b2 && (await prisma.badgeEarned.count({ where: { userId: A.id, badgeKey: 'dist_42k' } })) === 1, 'mesmo badge 2x = 1 registro');
  const allA = await prisma.badgeEarned.findMany({ where: { userId: A.id } });
  const balA = (await prisma.user.findUnique({ where: { id: A.id } })).balance;
  ok(allA.every((b) => b.cashbackAwarded === 0) && balA === 0 && (await prisma.transaction.count({ where: { receiverId: A.id } })) === 0, 'cashback DESLIGADO por padrão (0): nenhum crédito');
  r = await call(A.token, 'PUT', '/api/activities/admin/rewards', { amountPerBadge: 10 });
  ok(r.status === 403, 'atleta comum não liga cashback');
  r = await call(ADM.token, 'PUT', '/api/activities/admin/rewards', { amountPerBadge: 10, monthlyCap: 25, byBadge: { segment_pr: 0 } });
  ok(r.status === 200 && r.body.config.amountPerBadge === 10, 'admin liga cashback (R$10/badge, teto R$25/mês)');
  ok((await prisma.adminAction.count({ where: { adminId: ADM.id, action: 'apex_badge_cashback_update' } })) === 1, 'mudança registrada em AdminAction');
  r = await call(ADM.token, 'PUT', '/api/activities/admin/rewards', { amountPerBadge: -1 });
  ok(r.status === 400, 'valor negativo recusado');
  const C = await mkUser('C');
  await consent(C);
  const long = makeTrack([[-7.20, -34.85], [-7.11, -34.85]], { start: now - 6 * 3600e3, speed: 3.2 }); // ~10 km
  r = await call(C.token, 'POST', '/api/activities', { clientId: 'c-1', sportType: 'RUN', points: asPayloadPoints(long) });
  const kc = r.body.badges.map((b) => [b.key, b.cashback]);
  const balC = (await prisma.user.findUnique({ where: { id: C.id } })).balance;
  ok(r.status === 201 && kc.length === 3, '3 badges (1ª, 5 km, 10 km)', kc);
  ok(near(balC, 25, 0.001), `teto mensal respeitado: saldo R$ ${balC} (10+10+5)`);
  const txC = await prisma.transaction.findMany({ where: { receiverId: C.id } });
  ok(txC.length === 3 && txC.every((t) => t.type === 'credit' && JSON.parse(t.metadata).source === 'apex_badge'), 'Transaction "credit" por badge com origem apex_badge');
  r = await call(C.token, 'POST', '/api/activities', { clientId: 'c-1', sportType: 'RUN', points: asPayloadPoints(long) });
  ok(r.body.duplicate && near((await prisma.user.findUnique({ where: { id: C.id } })).balance, 25, 0.001), 'reenvio não credita de novo');
  await rewards.awardBadge(C.id, 'dist_42k', { silent: true });
  ok(near((await prisma.user.findUnique({ where: { id: C.id } })).balance, 25, 0.001), 'teto atingido: badge novo sem crédito');
  await call(ADM.token, 'PUT', '/api/activities/admin/rewards', { amountPerBadge: 0 });

  console.log('\n[8] Sequência de 7 dias + 100 km no mês');
  const D = await mkUser('D');
  const mStart = rewards.monthStartUtc(new Date()).getTime();
  // 8 dias seguidos antes do mês atual (não mexe no 100 km)
  for (let i = 0; i < 8; i++) {
    r = await call(D.token, 'POST', '/api/activities', { sportType: 'FUNCTIONAL', startedAt: new Date(mStart - (20 - i) * DAY).toISOString(), elapsedTimeS: 2400 });
  }
  const streaks = await prisma.badgeEarned.findMany({ where: { userId: D.id, badgeKey: { startsWith: 'streak_7:' } } });
  ok(streaks.length === 1, 'sequência de 7 dias concedida 1x (o 8º dia não repete)', streaks.map((s) => s.badgeKey));
  if (now - mStart > 10 * 3600e3) {
    for (let i = 0; i < 4; i++) {
      await call(D.token, 'POST', '/api/activities', { sportType: 'RIDE', startedAt: new Date(mStart + (1 + i * 2) * 3600e3).toISOString(), elapsedTimeS: 3600, distanceM: 30000 });
    }
    ok(await prisma.badgeEarned.findUnique({ where: { userId_badgeKey: { userId: D.id, badgeKey: `month_100km:${rewards.localMonth(new Date())}` } } }), '100 km no mês');
  } else console.log('  (100 km/mês pulado: mês começou há menos de 10 h)');

  console.log('\n[9] Desafios');
  const off = { name: 'Novembro 8K', ruleType: 'distance', target: 8000, sportTypes: ['RUN'], startsAt: new Date(now - 30 * DAY).toISOString(), endsAt: new Date(now + 10 * DAY).toISOString() };
  r = await call(A.token, 'POST', '/api/activity-challenges/official', off);
  ok(r.status === 403, 'atleta comum não cria desafio oficial');
  r = await call(ADM.token, 'POST', '/api/activity-challenges/official', off);
  ok(r.status === 201, 'admin cria desafio oficial');
  const offId = r.body.challenge.id;
  r = await call(A.token, 'POST', `/api/activity-challenges/${offId}/join`);
  const partA = await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: offId, userId: A.id } } });
  ok(r.status === 200 && partA.progressValue > 8000 && partA.completedAt, 'ao entrar, progresso recalculado das atividades do período → concluído', partA);
  ok(await prisma.badgeEarned.findUnique({ where: { userId_badgeKey: { userId: A.id, badgeKey: `challenge:${offId}` } } }), 'badge do desafio');
  r = await call(B.token, 'POST', '/api/activity-challenges/group', { name: 'Grupo da orla', ruleType: 'frequency', target: 3, startsAt: new Date(now - 10 * DAY).toISOString(), endsAt: new Date(now + 10 * DAY).toISOString() });
  ok(r.status === 201 && r.body.challenge.inviteCode && /#\/desafio\//.test(r.body.invitePath), 'desafio de grupo com link de convite');
  const grp = r.body.challenge;
  r = await call(A.token, 'GET', `/api/activity-challenges/${grp.id}`);
  ok(r.status === 404, 'grupo privado: quem não foi convidado não vê');
  r = await call(A.token, 'POST', `/api/activity-challenges/${grp.id}/join`);
  ok(r.status === 404, 'grupo privado: não entra sem o código');
  r = await call(A.token, 'GET', `/api/activity-challenges/invite/${grp.inviteCode}`);
  ok(r.status === 200 && r.body.participants === 1, 'prévia do convite');
  r = await call(A.token, 'POST', `/api/activity-challenges/invite/${grp.inviteCode}/join`);
  ok(r.status === 200, 'entra pelo convite');
  r = await call(A.token, 'GET', `/api/activity-challenges/${grp.id}`);
  ok(r.status === 200 && r.body.ranking.length === 2 && r.body.ranking[0].progressValue >= r.body.ranking[1].progressValue, 'ranking do grupo', r.body.ranking);
  r = await call(A.token, 'GET', '/api/activity-challenges');
  ok(r.body.challenges.some((c) => c.id === grp.id) && r.body.challenges.some((c) => c.id === offId), 'lista traz oficial + meus grupos');

  console.log('\n[10] Beacon (posição ao vivo)');
  for (let i = 0; i < 3; i++) await call(A.token, 'POST', '/api/activities/safety-contacts', { name: `Contato ${i}`, phone: '83999990000' });
  r = await call(A.token, 'POST', '/api/activities/safety-contacts', { name: 'Quarto', phone: '83999990000' });
  ok(r.status === 400, 'máximo de 3 contatos de segurança');
  r = await call(A.token, 'POST', '/api/activities/beacon/start', { sportType: 'RUN' });
  ok(r.status === 201 && r.body.token && r.body.path === `/ao-vivo/${r.body.token}` && r.body.contacts.length === 3, 'Beacon iniciado com link + contatos');
  const bc = r.body;
  const sess = await prisma.liveTrackingSession.findUnique({ where: { id: bc.sessionId } });
  ok(sess.shareTokenHash !== bc.token && sess.shareTokenHash.length === 64, 'banco guarda só o hash do token');
  r = await call(null, 'GET', `/api/beacon/${bc.token}`);
  ok(r.status === 200 && r.body.athlete === 'Atleta' && r.body.last === null, 'link abre sem conta');
  const live = makeTrack([[-7.12, -34.84], [-7.11, -34.84]], { start: Date.now() - 600e3, speed: 3 });
  r = await call(A.token, 'POST', `/api/activities/beacon/${bc.sessionId}/position`, { points: live.slice(0, 50).map((p) => [p.lat, p.lng, p.t]) });
  ok(r.status === 200 && r.body.stored === 50, 'posições enviadas');
  r = await call(B.token, 'POST', `/api/activities/beacon/${bc.sessionId}/position`, { points: [[0, 0, Date.now()]] });
  ok(r.status === 404, 'outro usuário não escreve no Beacon de A');
  r = await call(null, 'GET', `/api/beacon/${bc.token}`);
  ok(r.status === 200 && r.body.trail.length === 50 && near(r.body.last.lat, live[49].lat, 1e-6), 'página pública vê rastro e última posição');
  r = await call(B.token, 'GET', `/api/activities/${bc.activityId}`);
  ok(r.status === 404, 'atividade em gravação não aparece pra terceiros');
  r = await call(A.token, 'POST', '/api/activities', { liveActivityId: bc.activityId, clientId: 'a-live', sportType: 'RUN', points: asPayloadPoints(live) });
  ok(r.status === 201 && r.body.activityId === bc.activityId, 'terminar a atividade fecha a mesma atividade do Beacon');
  r = await call(null, 'GET', `/api/beacon/${bc.token}`);
  ok(r.status === 410 && r.body.ended, 'link expira ao terminar (410)');
  const bc2 = (await call(A.token, 'POST', '/api/activities/beacon/start', { sportType: 'WALK' })).body;
  await prisma.liveTrackingSession.update({ where: { id: bc2.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  r = await call(null, 'GET', `/api/beacon/${bc2.token}`);
  ok(r.status === 410, 'link expira pelo tempo (12 h)');
  r = await call(null, 'GET', '/api/beacon/tokeninvalidoqualquercoisa123');
  ok(r.status === 404, 'token inválido → 404');
  ok(await prisma.consent.findFirst({ where: { userId: A.id, scope: 'live_tracking', granted: true } }), 'Consent live_tracking registrado');

  console.log('\n[11] Apagar atividade');
  const before = (await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: offId, userId: A.id } } })).progressValue;
  r = await call(A.token, 'DELETE', `/api/activities/${actAPR}`);
  const after = (await prisma.challengeParticipation.findUnique({ where: { challengeId_userId: { challengeId: offId, userId: A.id } } })).progressValue;
  ok(r.status === 200 && !(await prisma.activity.findUnique({ where: { id: actAPR } })) && (await prisma.segmentEffort.count({ where: { activityId: actAPR } })) === 0, 'atividade + esforços apagados');
  ok(after < before, 'progresso do desafio recalculado');
  r = await call(A.token, 'GET', '/api/activities/me/summary');
  ok(r.status === 200 && r.body.xp > 0 && r.body.level >= 1 && r.body.month.count >= 0, 'resumo (XP/nível/totais)');
  r = await call(A.token, 'GET', '/api/activities/me/badges');
  ok(r.status === 200 && r.body.catalog.length >= 10, 'catálogo de badges');

  server.close();

  console.log('\n[12] ensureApexSchema num banco vazio = mesmo schema do Prisma');
  const ensDb = DB.replace(/\/([^/?]+)(\?|$)/, '/club_f4_ens$2');
  const admin = new PrismaClient();
  await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS club_f4_ens');
  await admin.$executeRawUnsafe('CREATE DATABASE club_f4_ens');
  const ens = new PrismaClient({ datasources: { db: { url: ensDb } } });
  const quiet = console.error; console.error = () => {}; // tabelas fora do F4 não existem nesse banco
  await require('../src/services/ensureApexSchema').ensureApexSchema(ens);
  console.error = quiet;
  const T = ['Activity', 'ActivityLap', 'ActivityPhoto', 'Segment', 'SegmentEffort', 'Challenge', 'ChallengeParticipation', 'BadgeEarned', 'LiveTrackingSession', 'SafetyContact', 'Consent', 'AthleteProfile', 'ActivityPrivacyZone', 'AthleteFollow'];
  const cols = async (c) => (await c.$queryRawUnsafe(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) ORDER BY 1,2`, T)).map((x) => `${x.table_name}.${x.column_name}:${x.data_type}:${x.is_nullable}:${x.column_default || ''}`);
  const idx = async (c) => (await c.$queryRawUnsafe(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY 1`, T)).map((x) => x.indexname);
  const [c1, c2, i1, i2] = [await cols(prisma), await cols(ens), await idx(prisma), await idx(ens)];
  const diffC = c1.filter((x) => !c2.includes(x)).concat(c2.filter((x) => !c1.includes(x)));
  const diffI = i1.filter((x) => !i2.includes(x)).concat(i2.filter((x) => !i1.includes(x)));
  ok(diffC.length === 0, `colunas idênticas (${c1.length})`, diffC);
  ok(diffI.length === 0, `índices idênticos (${i1.length})`, diffI);
  await require('../src/services/ensureApexSchema').ensureApexSchema(prisma);
  ok(true, 'ensureApexSchema roda de novo no banco completo sem erro (idempotente)');
  await ens.$disconnect();
  await admin.$executeRawUnsafe('DROP DATABASE IF EXISTS club_f4_ens').catch(() => {});
  await admin.$disconnect();

  console.log(`\n${failN ? '❌' : '✅'} ${pass} ok, ${failN} falha(s)`);
  await prisma.$disconnect();
  process.exit(failN ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
