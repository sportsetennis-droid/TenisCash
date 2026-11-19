'use strict';
// =====================================================================
// Teste F5 — Glicko-2, rankings (temporada/mês/circuito), push do Club e
// clube permanente. Usa BANCO DESCARTÁVEL (nunca produção):
//
//   psql -h localhost -p 55432 -U postgres -c "create database club_f5"
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f5 npx prisma db push --skip-generate --accept-data-loss
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f5 node scripts/test-club-ranking.js
//
// O web-push é SIMULADO (stub do sendNotification): nada sai pra internet.
// =====================================================================

const assert = require('assert');
const http = require('http');

const DB = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(DB)) {
  console.error('Recusado: DATABASE_URL precisa apontar pra um banco LOCAL descartável.');
  process.exit(2);
}

// ---- stub do web-push ANTES de qualquer require do serviço
const webpush = require('web-push');
const pushCalls = [];
let failEndpoint410 = null;
webpush.sendNotification = async (sub, payload) => {
  if (sub.endpoint === failEndpoint410) { const e = new Error('gone'); e.statusCode = 410; throw e; }
  pushCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return { statusCode: 201 };
};

const express = require('express');
const jwt = require('jsonwebtoken');
const { prisma, JWT_SECRET } = require('../src/middleware');
const glicko = require('../src/services/glicko2');
const rating = require('../src/services/clubRating');
const rankings = require('../src/services/clubRankings');
const push = require('../src/services/clubPush');
const engine = require('../src/services/tournamentEngine');
const { notify } = require('../src/services/notify');
const { ensureApexSchema } = require('../src/services/ensureApexSchema');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≉ ${b}`);

// --------------------------------------------------------------- fixtures
let seq = 0;
async function user(name, extra = {}) {
  seq += 1;
  const u = await prisma.user.create({ data: { name, phone: '5583900' + String(100000 + seq), pin: 'x', username: name.toLowerCase().replace(/\W/g, '') + seq, ...extra } });
  return u;
}
async function tournament(sport, { isDoubles = false, name, format = 'KNOCKOUT', ownerId, status = 'ONGOING' } = {}) {
  seq += 1;
  return prisma.tournament.create({ data: { slug: 't-' + seq + '-' + Date.now(), name: name || ('Torneio ' + seq), sport, isDoubles, format, ownerId, status } });
}
async function category(t, name, gender = 'M') {
  return prisma.tournamentCategory.create({ data: { tournamentId: t.id, name, gender } });
}
async function entry(t, cat, name, userIds = []) {
  return prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: cat.id, name, members: { create: userIds.map((userId) => ({ userId })) } } });
}
async function match(t, cat, home, away, stage, when, extra = {}) {
  return prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat.id, stage, homeEntryId: home && home.id, awayEntryId: away && away.id, scheduledAt: when ? new Date(when) : null, ...extra } });
}
// mini torneio só com FINAL (resultado aplicado pelo motor)
async function finalOnly(sport, catName, winnerUser, loserUser, when, ownerId) {
  const t = await tournament(sport, { ownerId });
  const c = await category(t, catName, 'M');
  const ew = await entry(t, c, 'W ' + seq, [winnerUser.id]);
  const el = await entry(t, c, 'L ' + seq, [loserUser.id]);
  const f = await match(t, c, ew, el, 'FINAL', when);
  const r = await engine.applyMatchResult(f.id, { homeScore: 2, awayScore: 0 });
  assert.ok(r.ok, 'final aplicada');
  return t;
}

function startApp() {
  const app = express();
  app.use(express.json({ limit: '1.5mb' }));
  app.use('/api/club-ranking', require('../src/routes/clubRanking'));
  app.use('/api/club-push', require('../src/routes/clubPush'));
  app.use('/api/clubs', require('../src/routes/clubs'));
  app.use('/clube', require('../src/routes/clubPage'));
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
function req(server, method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, method, path,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json, text: buf, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });

async function snapshot() {
  const rows = await prisma.glickoRating.findMany({ orderBy: [{ sport: 'asc' }, { format: 'asc' }, { subjectKey: 'asc' }] });
  return rows.map((r) => [r.sport, r.format, r.subjectType, r.subjectKey, r.rating, r.rd, r.volatility, r.matches, r.wins, r.draws, r.losses, r.lastPeriod].join('|'));
}

// ------------------------------------------------------------------ main
(async function main() {
  console.log('Schema aditivo (ensureApexSchema no banco de teste)');
  await ok('ensureApexSchema roda sem erro e é idempotente', async () => {
    const n1 = await ensureApexSchema(prisma);
    const n2 = await ensureApexSchema(prisma);
    assert.strictEqual(n1, n2);
    const cols = await prisma.$queryRawUnsafe(`select column_name from information_schema.columns where table_name='PushSubscription' and column_name='app'`);
    assert.strictEqual(cols.length, 1);
  });

  console.log('Glicko-2 (paper de Glickman)');
  await ok('exemplo do paper: 1464.06 / 151.52 / σ 0.05999', () => {
    const r = glicko.updatePlayer({ rating: 1500, rd: 200, vol: 0.06 }, [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 },
    ]);
    near(r.rating, 1464.06, 0.01, 'rating');
    near(r.rd, 151.52, 0.01, 'RD');
    near(r.vol, 0.05999, 0.00001, 'volatilidade');
  });
  await ok('sem jogo no período: só o RD cresce (√(φ²+σ²))', () => {
    const r = glicko.updatePlayer({ rating: 1700, rd: 60, vol: 0.06 }, []);
    assert.strictEqual(r.rating, 1700);
    near(r.rd, Math.sqrt(60 * 60 + Math.pow(0.06 * glicko.SCALE, 2)), 1e-9, 'RD');
    assert.ok(glicko.inflateRd(60, 0.06, 1000) <= 350, 'RD nunca passa de 350');
  });
  await ok('nível 0–7 e confiabilidade', () => {
    assert.strictEqual(rating.level(1500), 3);
    assert.strictEqual(rating.level(2300), 7);
    assert.strictEqual(rating.level(3000), 7);
    assert.strictEqual(rating.level(500), 0);
    assert.strictEqual(rating.reliability(350), 0);
    assert.strictEqual(rating.reliability(50), 100);
    assert.strictEqual(rating.isProvisional(350), true);
    assert.strictEqual(rating.isProvisional(90), false);
  });
  await ok('período = semana seg→dom em Fortaleza', () => {
    // dom 2026-10-11 23:30 Fortaleza (= seg 02:30 UTC) ainda é a semana anterior à seg 12/10
    const sun = rating.periodIndex('2026-10-12T02:30:00Z');
    const mon = rating.periodIndex('2026-10-12T03:30:00Z');
    assert.strictEqual(mon, sun + 1);
    assert.strictEqual(rating.periodStart(mon).toISOString(), '2026-10-12T03:00:00.000Z');
  });

  // ---- dados
  const owner = await user('Dono Torneio');
  const A = await user('Ana Beach'); const B = await user('Bia Beach'); const C = await user('Caio Beach'); const D = await user('Duda Beach');
  await prisma.athleteProfile.create({ data: { userId: A.id, sex: 'F' } });
  await prisma.athleteProfile.create({ data: { userId: C.id, sex: 'M' } });

  // Torneio de simples (mata-mata) — semis numa semana, final na outra
  const T1 = await tournament('BEACH_TENNIS', { ownerId: owner.id, name: 'Open Bessa' });
  const c1 = await category(T1, 'Masculino B', 'M');
  const eA = await entry(T1, c1, 'Ana', [A.id]); const eB = await entry(T1, c1, 'Bia', [B.id]);
  const eC = await entry(T1, c1, 'Caio', [C.id]); const eD = await entry(T1, c1, 'Duda', [D.id]);
  const fin = await match(T1, c1, null, null, 'FINAL', '2026-10-14T20:00:00Z');
  const s1 = await match(T1, c1, eA, eB, 'SEMI', '2026-10-05T20:00:00Z', { ordering: 0, nextMatchId: fin.id, nextSlot: 'home' });
  const s2 = await match(T1, c1, eC, eD, 'SEMI', '2026-10-06T20:00:00Z', { ordering: 1, nextMatchId: fin.id, nextSlot: 'away' });

  console.log('Rating no fluxo real (applyMatchResult)');
  await ok('resultado de jogo finalizado gera rating Glicko-2 (e mantém o legado)', async () => {
    assert.ok((await engine.applyMatchResult(s1.id, { homeScore: 2, awayScore: 0 })).ok);
    assert.ok((await engine.applyMatchResult(s2.id, { homeScore: 2, awayScore: 1 })).ok);
    assert.ok((await engine.applyMatchResult(fin.id, { homeScore: 2, awayScore: 1 })).ok); // Ana campeã sobre Caio
    const rows = await prisma.glickoRating.findMany({ where: { sport: 'BEACH_TENNIS', format: 'SINGLES' } });
    assert.strictEqual(rows.length, 4);
    const ra = rows.find((r) => r.subjectKey === A.id);
    assert.strictEqual(ra.matches, 2); assert.strictEqual(ra.wins, 2);
    assert.ok(ra.rating > 1500 && ra.rd < 350);
    const legacy = await prisma.athleteRating.findUnique({ where: { userId_sport: { userId: A.id, sport: 'BEACH_TENNIS' } } });
    assert.ok(legacy && legacy.rating > 2, 'rating legado (Elo 0–7) continua sendo atualizado');
  });
  await ok('cálculo do pool bate com Glicko-2 manual período a período', async () => {
    // semana 1: A vence B, C vence D (todos 1500/350). semana 2: A vence C.
    const p1A = glicko.updatePlayer({ rating: 1500, rd: 350, vol: 0.06 }, [{ rating: 1500, rd: 350, score: 1 }]);
    const p1C = glicko.updatePlayer({ rating: 1500, rd: 350, vol: 0.06 }, [{ rating: 1500, rd: 350, score: 1 }]);
    const p2A = glicko.updatePlayer(p1A, [{ rating: p1C.rating, rd: p1C.rd, score: 1 }]);
    const ra = await prisma.glickoRating.findFirst({ where: { sport: 'BEACH_TENNIS', format: 'SINGLES', subjectKey: A.id } });
    near(ra.rating, p2A.rating, 1e-4, 'rating A');
    near(ra.rd, p2A.rd, 1e-4, 'RD A');
  });
  await ok('desafio 1x1 jogado entra no pool SINGLES', async () => {
    await prisma.playChallenge.create({ data: { challengerId: B.id, challengedId: D.id, sport: 'BEACH_TENNIS', status: 'PLAYED', winnerId: B.id, homeScore: 2, awayScore: 0 } });
    await engine.rateHeadToHead(B.id, D.id, 'BEACH_TENNIS');
    const rb = await prisma.glickoRating.findFirst({ where: { sport: 'BEACH_TENNIS', format: 'SINGLES', subjectKey: B.id } });
    assert.strictEqual(rb.matches, 2); assert.strictEqual(rb.wins, 1);
  });

  // duplas
  const P = await user('Pedro Dupla'); const Q = await user('Quel Dupla'); const R = await user('Rui Dupla'); const S = await user('Sol Dupla');
  const T2 = await tournament('BEACH_TENNIS', { ownerId: owner.id, isDoubles: true, name: 'Duplas Tambaú' });
  const c2 = await category(T2, 'Mista', 'MIXED');
  const d1 = await entry(T2, c2, 'Pedro & Quel', [P.id, Q.id]);
  const d2 = await entry(T2, c2, 'Rui & Sol', [R.id, S.id]);
  const dm = await match(T2, c2, d1, d2, 'FINAL', '2026-10-20T20:00:00Z');
  await ok('dupla: pool DOUBLES separado, cada atleta contra o adversário composto', async () => {
    assert.ok((await engine.applyMatchResult(dm.id, { homeScore: 2, awayScore: 0 })).ok);
    const rows = await prisma.glickoRating.findMany({ where: { sport: 'BEACH_TENNIS', format: 'DOUBLES' } });
    assert.strictEqual(rows.length, 4);
    assert.ok(rows.find((r) => r.subjectKey === P.id).rating > 1500);
    assert.ok(rows.find((r) => r.subjectKey === S.id).rating < 1500);
    assert.strictEqual(await prisma.glickoRating.count({ where: { format: 'SINGLES', subjectKey: P.id } }), 0);
  });

  // futsal (time sem conta dos membros)
  const T3 = await tournament('FUTSAL', { ownerId: owner.id, format: 'ROUND_ROBIN', name: 'Master Cup' });
  const c3 = await category(T3, '40+', 'M');
  const fA = await entry(T3, c3, 'Cabo Branco'); const fB = await entry(T3, c3, 'Amigos CG'); const fC = await entry(T3, c3, 'Treze Master');
  const fm1 = await match(T3, c3, fA, fB, 'LEAGUE', '2026-10-21T22:00:00Z');
  const fm2 = await match(T3, c3, fB, fC, 'LEAGUE', '2026-10-22T22:00:00Z');
  const fm3 = await match(T3, c3, fA, fC, 'LEAGUE', '2026-10-23T22:00:00Z');
  await ok('futsal: rating de TIME por nome do clube; empate = 0,5', async () => {
    assert.ok((await engine.applyMatchResult(fm1.id, { homeScore: 3, awayScore: 1 })).ok);
    assert.ok((await engine.applyMatchResult(fm2.id, { homeScore: 2, awayScore: 2 })).ok);
    assert.ok((await engine.applyMatchResult(fm3.id, { homeScore: 1, awayScore: 0 })).ok);
    const rows = await prisma.glickoRating.findMany({ where: { sport: 'FUTSAL', format: 'TEAM' } });
    assert.strictEqual(rows.length, 3);
    const cb = rows.find((r) => r.teamName === 'Cabo Branco');
    const am = rows.find((r) => r.teamName === 'Amigos CG');
    assert.strictEqual(cb.subjectType, 'TEAM'); assert.strictEqual(cb.subjectKey, 'cabo branco');
    assert.strictEqual(cb.wins, 2); assert.strictEqual(am.draws, 1);
  });

  console.log('Recálculo idempotente a partir do histórico');
  await ok('recalcular 2x dá o mesmo resultado; apagar e recalcular reconstrói igual', async () => {
    const before = await snapshot();
    await rating.recomputeSport(null);
    const again = await snapshot();
    assert.deepStrictEqual(again, before);
    await prisma.glickoRating.deleteMany({});
    const r = await rating.recomputeSport(null);
    assert.ok(r.ok && r.events === 8, 'eventos: ' + r.events); // 3 simples + 1 desafio + 1 dupla + 3 futsal
    assert.deepStrictEqual(await snapshot(), before);
  });
  await ok('recálculos concorrentes do mesmo esporte não duplicam linhas', async () => {
    const before = await snapshot();
    await Promise.all([rating.recomputeSport('FUTSAL'), rating.recomputeSport('FUTSAL'), rating.recomputeSport('FUTSAL')]);
    assert.deepStrictEqual(await snapshot(), before);
  });

  console.log('Rankings');
  const server = await startApp();
  await ok('ranking de nível (HTTP): ordem, nível, confiabilidade, provisório', async () => {
    const r = await req(server, 'GET', '/api/club-ranking/BEACH_TENNIS/rating?format=SINGLES');
    assert.strictEqual(r.status, 200);
    assert.ok(/no-store/.test(r.headers['cache-control']));
    const l = r.json.ranking;
    assert.strictEqual(l[0].userId, A.id);
    assert.strictEqual(l[0].rank, 1);
    assert.ok(l[0].level > 3 && l[0].level <= 7);
    assert.ok(typeof l[0].reliability === 'number' && l[0].reliability > 0);
    assert.strictEqual(l[0].provisional, true, '2 jogos = provisório');
    const fem = await req(server, 'GET', '/api/club-ranking/BEACH_TENNIS/rating?format=SINGLES&gender=F');
    assert.deepStrictEqual(fem.json.ranking.map((x) => x.userId), [A.id]);
    const firm = await req(server, 'GET', '/api/club-ranking/BEACH_TENNIS/rating?format=SINGLES&provisional=0');
    assert.strictEqual(firm.json.ranking.length, 0, 'ninguém confiável ainda');
    const team = await req(server, 'GET', '/api/club-ranking/FUTSAL/rating');
    assert.strictEqual(team.json.format, 'TEAM');
    assert.strictEqual(team.json.ranking[0].name, 'Cabo Branco');
  });
  await ok('nível do atleta com posição (/athlete/:handle)', async () => {
    const r = await req(server, 'GET', '/api/club-ranking/athlete/' + A.username);
    assert.strictEqual(r.status, 200);
    const s = r.json.levels.find((x) => x.format === 'SINGLES');
    assert.strictEqual(s.position, 1); assert.strictEqual(s.of, 4);
    assert.strictEqual((await req(server, 'GET', '/api/club-ranking/athlete/ninguem-xyz')).status, 404);
  });
  await ok('temporada (ano) e mês: V=3/E=1, filtros de categoria e gênero', async () => {
    const y = await req(server, 'GET', '/api/club-ranking/BEACH_TENNIS/season?year=2026&format=SINGLES');
    assert.strictEqual(y.status, 200);
    const a = y.json.ranking.find((x) => x.userId === A.id);
    assert.strictEqual(a.points, 6); assert.strictEqual(y.json.ranking[0].userId, A.id);
    // desafio B×D foi gravado agora (novembro) → entra no ano, não em outubro
    const b = y.json.ranking.find((x) => x.userId === B.id);
    assert.strictEqual(b.played, 2);
    const oct = await rankings.seasonRanking({ sport: 'BEACH_TENNIS', format: 'SINGLES', year: 2026, month: 10 });
    assert.strictEqual(oct.ranking.find((x) => x.userId === B.id).played, 1);
    const cat = await rankings.seasonRanking({ sport: 'BEACH_TENNIS', format: 'SINGLES', year: 2026, category: 'masculino b' });
    assert.strictEqual(cat.ranking.find((x) => x.userId === B.id).played, 1, 'desafio não tem categoria');
    const fem = await rankings.seasonRanking({ sport: 'BEACH_TENNIS', format: 'SINGLES', year: 2026, gender: 'F' });
    assert.strictEqual(fem.ranking.length, 0, 'categoria do jogo é masculina');
    const fut = await req(server, 'GET', '/api/club-ranking/FUTSAL/season?year=2026');
    assert.strictEqual(fut.json.ranking[0].name, 'Cabo Branco'); assert.strictEqual(fut.json.ranking[0].points, 6);
    const bad = await req(server, 'GET', '/api/club-ranking/FUTSAL/season?month=13');
    assert.strictEqual(bad.status, 400);
  });
  await ok('circuito: pontos por fase, melhores N em 52 semanas', async () => {
    await finalOnly('BEACH_TENNIS', 'Masculino B', C, A, '2026-11-02T20:00:00Z', owner.id); // Ana vice (700)
    await finalOnly('BEACH_TENNIS', 'Masculino B', A, B, '2025-06-01T20:00:00Z', owner.id); // fora das 52 semanas
    const asOf = '2026-11-17T12:00:00Z';
    const r = await req(server, 'GET', '/api/club-ranking/BEACH_TENNIS/circuit?category=Masculino%20B&asOf=' + encodeURIComponent(asOf));
    assert.strictEqual(r.status, 200);
    const a = r.json.ranking.find((x) => x.userId === A.id);
    assert.strictEqual(r.json.best, 10);
    assert.strictEqual(a.points, 1700, 'campeã (1000) + vice (700)');
    assert.strictEqual(a.events, 2);
    const c = r.json.ranking.find((x) => x.userId === C.id);
    assert.strictEqual(c.points, 1700, 'vice (700) + campeão (1000)');
    const b = r.json.ranking.find((x) => x.userId === B.id);
    assert.strictEqual(b.points, 450, 'semifinal');
    const best1 = await rankings.circuitRanking({ sport: 'BEACH_TENNIS', category: 'Masculino B', asOf, best: 1 });
    assert.strictEqual(best1.ranking.find((x) => x.userId === A.id).points, 1000);
    const w104 = await rankings.circuitRanking({ sport: 'BEACH_TENNIS', category: 'Masculino B', asOf, weeks: 104, best: 2 });
    assert.strictEqual(w104.ranking.find((x) => x.userId === A.id).points, 2000);
    const fem = await rankings.circuitRanking({ sport: 'BEACH_TENNIS', gender: 'F', asOf });
    assert.strictEqual(fem.ranking.length, 0);
    // tabela configurável
    await rankings.setCircuitConfig({ points: { CHAMPION: 1200 } });
    const cfg = await rankings.circuitRanking({ sport: 'BEACH_TENNIS', category: 'Masculino B', asOf, best: 1 });
    assert.strictEqual(cfg.ranking.find((x) => x.userId === A.id).points, 1200);
    await rankings.setCircuitConfig({ points: { CHAMPION: 1000 } });
    await assert.rejects(rankings.setCircuitConfig({ points: { XYZ: 1 } }));
    // liga (pontos corridos) encerrada também pontua pela classificação
    const fut = await rankings.circuitRanking({ sport: 'FUTSAL', asOf });
    assert.strictEqual(fut.ranking[0].name, 'Cabo Branco'); assert.strictEqual(fut.ranking[0].points, 1000);
    const pts = await req(server, 'GET', '/api/club-ranking/circuit/points');
    assert.strictEqual(pts.json.points.CHAMPION, 1000);
    const put = await req(server, 'PUT', '/api/club-ranking/circuit/points', { body: { best: 5 } });
    assert.strictEqual(put.status, 401, 'mexer na tabela exige login de admin');
  });

  console.log('Push no celular (web-push simulado)');
  await ok('push só pra quem tem inscrição do Club e o tipo ligado', async () => {
    await push.subscribe(A.id, { endpoint: 'https://push.example/a', keys: { p256dh: 'pA', auth: 'aA' } });
    await push.subscribe(B.id, { endpoint: 'https://push.example/b', keys: { p256dh: 'pB', auth: 'aB' } });
    await push.setPrefs(B.id, { types: { result: false } });
    await prisma.pushSubscription.create({ data: { userId: D.id, endpoint: 'https://push.example/d-varejo', p256dh: 'pD', authKey: 'aD' } }); // varejo (app null)
    pushCalls.length = 0;
    for (const u of [A, B, C, D]) await notify(u.id, { type: 'result', title: 'Resultado publicado', body: 'Saiu o placar.', link: '#/t/' + T1.id });
    await push.flush();
    assert.deepStrictEqual(pushCalls.map((c) => c.endpoint), ['https://push.example/a']);
    assert.strictEqual(pushCalls[0].payload.url, '/club.html#/t/' + T1.id);
    assert.strictEqual(pushCalls[0].payload.title, 'Resultado publicado');
    assert.strictEqual(await prisma.appNotification.count({ where: { type: 'result' } }), 4, 'in-app continua pra todos');
    pushCalls.length = 0;
    await notify(B.id, { type: 'challenge', title: 'Novo desafio', body: 'x' });
    await notify(B.id, { type: 'team', title: 'Convite de time', body: 'x' }); // team → categoria invite (ligada)
    await push.flush();
    assert.strictEqual(pushCalls.length, 2);
    pushCalls.length = 0;
    await push.setPrefs(A.id, { push: false });
    await notify(A.id, { type: 'result', title: 'r', body: 'x' });
    await push.flush();
    assert.strictEqual(pushCalls.length, 0, 'push geral desligado');
    await push.setPrefs(A.id, { push: true });
  });
  await ok('inscrição cancelada no navegador (410) é apagada', async () => {
    failEndpoint410 = 'https://push.example/b';
    const r = await push.sendPushNow(B.id, { type: 'challenge', title: 't', body: 'b' });
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(await prisma.pushSubscription.count({ where: { endpoint: 'https://push.example/b' } }), 0);
    failEndpoint410 = null;
  });
  await ok('aviso "jogo em 30 min": uma vez só, pros atletas do jogo (push + in-app)', async () => {
    const now = new Date();
    const T4 = await tournament('BEACH_TENNIS', { ownerId: owner.id, name: 'Rei da Praia' });
    const c4 = await category(T4, 'Open', 'OPEN');
    const x = await entry(T4, c4, 'Ana', [A.id]); const y = await entry(T4, c4, 'Duda', [D.id]);
    await match(T4, c4, x, y, 'FINAL', new Date(now.getTime() + 30 * 60000), { location: 'Arena Bessa' });
    pushCalls.length = 0;
    const r1 = await push.runGameSoon(now);
    await push.flush();
    assert.strictEqual(r1.matches, 1); assert.strictEqual(r1.notified, 2);
    assert.strictEqual(await prisma.appNotification.count({ where: { type: 'game_soon' } }), 2);
    assert.deepStrictEqual(pushCalls.map((c) => c.endpoint), ['https://push.example/a'], 'D só tem inscrição do varejo');
    assert.ok(/Arena Bessa/.test(pushCalls[0].payload.body));
    await push.runGameSoon(now);
    assert.strictEqual(await prisma.appNotification.count({ where: { type: 'game_soon' } }), 2, 'idempotente');
  });
  await ok('rotas de push (HTTP): chave VAPID pública, inscrição e preferências', async () => {
    const k = await req(server, 'GET', '/api/club-push/vapid-public-key');
    assert.strictEqual(k.status, 200); assert.ok(k.json.publicKey && k.json.publicKey.length > 40);
    assert.strictEqual((await req(server, 'POST', '/api/club-push/subscribe', { body: {} })).status, 401);
    const bad = await req(server, 'POST', '/api/club-push/subscribe', { token: tok(C), body: { endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } } });
    assert.strictEqual(bad.status, 400);
    const s = await req(server, 'POST', '/api/club-push/subscribe', { token: tok(C), body: { endpoint: 'https://push.example/c', keys: { p256dh: 'pc', auth: 'ac' } } });
    assert.strictEqual(s.status, 200);
    const p = await req(server, 'PUT', '/api/club-push/preferences', { token: tok(C), body: { types: { game_soon: false, nada: true } } });
    assert.strictEqual(p.json.types.game_soon, false); assert.strictEqual(p.json.types.result, true); assert.ok(!('nada' in p.json.types));
    const st = await req(server, 'GET', '/api/club-push/status', { token: tok(C) });
    assert.strictEqual(st.json.subscriptions, 1);
  });

  console.log('Clube permanente');
  const coach = await user('Téo Técnico');
  let club;
  await ok('criar clube (escudo, cores, esportes) e ver a página pública', async () => {
    const r = await req(server, 'POST', '/api/clubs', { token: tok(A), body: { name: 'Cabo Branco Futsal', sports: ['FUTSAL', 'xyz', 'BEACH_TENNIS'], primaryColor: '#123abc', crestUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' /* PNG 1x1 real — a Liga F0 recusa arquivo só com o cabeçalho */ } });
    assert.strictEqual(r.status, 201, r.text);
    club = r.json;
    assert.strictEqual(club.slug, 'cabo-branco-futsal');
    assert.deepStrictEqual(club.sports, ['FUTSAL', 'BEACH_TENNIS']);
    assert.strictEqual(club.primaryColor, '#123ABC');
    assert.ok(/^[A-Z2-9]{8}$/.test(club.inviteCode));
    const dup = await req(server, 'POST', '/api/clubs', { token: tok(B), body: { name: 'Cabo Branco Futsal' } });
    assert.strictEqual(dup.json.slug, 'cabo-branco-futsal-2');
    const badCrest = await req(server, 'POST', '/api/clubs', { token: tok(B), body: { name: 'X Clube', crestUrl: 'javascript:alert(1)' } });
    assert.strictEqual(badCrest.status, 400);
    const pub = await req(server, 'GET', '/api/clubs/' + club.slug);
    assert.strictEqual(pub.status, 200);
    assert.strictEqual(pub.json.members.length, 1); assert.strictEqual(pub.json.members[0].role, 'owner');
    assert.strictEqual(pub.json.viewer, null);
    const page = await req(server, 'GET', '/clube/' + club.slug);
    assert.strictEqual(page.status, 200); assert.ok(/<!DOCTYPE html>/i.test(page.text));
    assert.strictEqual((await req(server, 'GET', '/api/clubs/nao-existe')).status, 404);
  });
  await ok('convite por código/link: entra como atleta', async () => {
    const inv = await req(server, 'GET', '/api/clubs/' + club.slug + '/invite', { token: tok(A) });
    assert.strictEqual(inv.status, 200); assert.ok(inv.json.path.includes('?convite=' + club.inviteCode));
    assert.strictEqual((await req(server, 'GET', '/api/clubs/' + club.slug + '/invite', { token: tok(B) })).status, 403);
    const j = await req(server, 'POST', '/api/clubs/join', { token: tok(B), body: { code: club.inviteCode.toLowerCase() } });
    assert.strictEqual(j.status, 200, j.text); assert.strictEqual(j.json.membership.role, 'athlete'); assert.strictEqual(j.json.membership.status, 'ACTIVE');
    assert.strictEqual((await req(server, 'POST', '/api/clubs/join', { token: tok(B), body: { code: 'ZZZZZZZZ' } })).status, 404);
    const regen = await req(server, 'POST', '/api/clubs/' + club.slug + '/invite-code', { token: tok(A) });
    assert.notStrictEqual(regen.json.code, club.inviteCode);
    assert.strictEqual((await req(server, 'POST', '/api/clubs/join', { token: tok(D), body: { code: club.inviteCode } })).status, 404, 'código antigo não vale mais');
  });
  await ok('convite nominal: PENDING → aceitar; papéis dono/técnico/atleta', async () => {
    const i = await req(server, 'POST', '/api/clubs/' + club.slug + '/invite', { token: tok(A), body: { username: coach.username, role: 'coach' } });
    assert.strictEqual(i.status, 201, i.text); assert.strictEqual(i.json.status, 'PENDING');
    assert.strictEqual(await prisma.appNotification.count({ where: { userId: coach.id, type: 'club_invite' } }), 1);
    const pv = await req(server, 'GET', '/api/clubs/' + club.slug, { token: tok(coach) });
    assert.strictEqual(pv.json.viewer.status, 'PENDING'); assert.strictEqual(pv.json.viewer.pendingRole, 'coach');
    const acc = await req(server, 'POST', '/api/clubs/' + club.slug + '/respond', { token: tok(coach), body: { action: 'accept' } });
    assert.strictEqual(acc.status, 200); assert.strictEqual(acc.json.status, 'ACTIVE');
    // técnico convida atleta, mas não convida técnico nem edita o clube
    assert.strictEqual((await req(server, 'POST', '/api/clubs/' + club.slug + '/invite', { token: tok(coach), body: { userId: C.id } })).status, 201);
    assert.strictEqual((await req(server, 'POST', '/api/clubs/' + club.slug + '/invite', { token: tok(coach), body: { userId: D.id, role: 'coach' } })).status, 403);
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug, { token: tok(coach), body: { name: 'Hack' } })).status, 403);
    assert.strictEqual((await req(server, 'POST', '/api/clubs/' + club.slug + '/respond', { token: tok(C), body: { action: 'decline' } })).json.status, 'DECLINED');
    // atleta não muda papel; dono promove; dono não perde o papel sozinho
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug + '/members/' + B.id, { token: tok(B), body: { role: 'coach' } })).status, 403);
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug + '/members/' + B.id, { token: tok(A), body: { role: 'coach' } })).json.role, 'coach');
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug + '/members/' + A.id, { token: tok(A), body: { role: 'athlete' } })).status, 409);
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug + '/members/' + B.id, { token: tok(A), body: { role: 'rei' } })).status, 400);
    const ed = await req(server, 'PATCH', '/api/clubs/' + club.slug, { token: tok(A), body: { description: 'Clube de futsal master', secondaryColor: '#ffffff' } });
    assert.strictEqual(ed.status, 200); assert.strictEqual(ed.json.secondaryColor, '#FFFFFF');
    const mine = await req(server, 'GET', '/api/clubs/mine', { token: tok(coach) });
    assert.strictEqual(mine.json.clubs[0].role, 'coach');
  });
  await ok('vínculo explícito a torneio: próximos jogos, treinos e medalhas na página', async () => {
    const wrong = await req(server, 'POST', '/api/clubs/' + club.slug + '/links', { token: tok(A), body: { tournamentId: T3.id, entryName: 'cabo branco' } });
    assert.strictEqual(wrong.status, 404, 'sem casar nome parecido');
    assert.strictEqual((await req(server, 'POST', '/api/clubs/' + club.slug + '/links', { token: tok(coach), body: { tournamentId: T3.id, entryName: 'Cabo Branco' } })).status, 403);
    const opts = await req(server, 'GET', '/api/clubs/' + club.slug + '/entry-options?tournamentId=' + T3.id, { token: tok(A) });
    assert.ok(opts.json.entries.includes('Cabo Branco'));
    const ln = await req(server, 'POST', '/api/clubs/' + club.slug + '/links', { token: tok(A), body: { tournamentId: T3.id, entryName: 'Cabo Branco' } });
    assert.strictEqual(ln.status, 201, ln.text);
    const soon = new Date(Date.now() + 2 * 86400000);
    await match(T3, c3, fC, fA, 'LEAGUE', soon);
    await match(T3, c3, fB, fC, 'LEAGUE', soon); // jogo de outro time: não aparece
    await prisma.trainingSession.create({ data: { tournamentId: T3.id, clubName: 'Cabo Branco', title: 'Treino tático', scheduledAt: soon } });
    await prisma.trainingSession.create({ data: { tournamentId: T3.id, clubName: 'Amigos CG', title: 'Treino deles', scheduledAt: soon } });
    await prisma.medal.create({ data: {
      serial: 'CST-2026-000001', credentialId: 'urn:uuid:test-1', userId: B.id, issuerId: 'iss', templateId: 'tpl', sport: 'BEACH_TENNIS',
      series: 's', eventName: 'Open Bessa', tier: 'GOLD', placement: 1, editionNumber: 1, editionTotal: 1, recipientName: 'Bia Beach',
      identitySalt: 'x', identityHash: 'y', credentialJwt: 'jwt', verificationCode: 'AAAA-BBBB-CCCC', issuedByUserId: owner.id,
    } });
    const anon = await req(server, 'GET', '/api/clubs/' + club.slug);
    assert.strictEqual(anon.json.upcoming.length, 1);
    assert.strictEqual(anon.json.upcoming[0].home, 'Treze Master'); assert.strictEqual(anon.json.upcoming[0].away, 'Cabo Branco');
    assert.strictEqual(anon.json.trainings.length, 0, 'treino só pra membro');
    assert.strictEqual(anon.json.medals.length, 1); assert.strictEqual(anon.json.medals[0].eventName, 'Open Bessa');
    const mem = await req(server, 'GET', '/api/clubs/' + club.slug, { token: tok(B) });
    assert.deepStrictEqual(mem.json.trainings.map((t) => t.title), ['Treino tático']);
    assert.strictEqual(mem.json.viewer.role, 'coach');
    const lvl = mem.json.members.find((m) => m.userId === A.id).level;
    assert.ok(lvl && lvl.level > 3, 'nível Glicko do membro na página');
    // privado: esconde elenco/medalhas de quem não é membro
    await req(server, 'PATCH', '/api/clubs/' + club.slug, { token: tok(A), body: { privacyLevel: 'private' } });
    const priv = await req(server, 'GET', '/api/clubs/' + club.slug);
    assert.strictEqual(priv.json.members.length, 0); assert.strictEqual(priv.json.membersHidden, true);
    // remover vínculo
    assert.strictEqual((await req(server, 'DELETE', '/api/clubs/' + club.slug + '/links/' + ln.json.id, { token: tok(A) })).status, 200);
    assert.strictEqual((await req(server, 'GET', '/api/clubs/' + club.slug)).json.upcoming.length, 0);
  });
  await ok('membro do clube vinculado recebe o aviso de 30 min', async () => {
    await req(server, 'POST', '/api/clubs/' + club.slug + '/links', { token: tok(A), body: { tournamentId: T3.id, entryName: 'Cabo Branco' } });
    const m = await prisma.tournamentMatch.findFirst({ where: { tournamentId: T3.id, status: 'SCHEDULED', awayEntryId: fA.id } });
    const now = new Date(m.scheduledAt.getTime() - 30 * 60000);
    const aud = await push.matchAudience(await prisma.tournamentMatch.findUnique({ where: { id: m.id }, include: { homeEntry: { include: { members: true } }, awayEntry: { include: { members: true } } } }));
    assert.ok(aud.includes(A.id) && aud.includes(B.id) && aud.includes(coach.id), 'membros ativos do clube');
    assert.ok(!aud.includes(C.id), 'convite recusado não recebe');
    const r = await push.runGameSoon(now);
    assert.ok(r.matches >= 1);
  });
  await ok('saída/remoção: atleta sai; dono não sai sem passar o clube', async () => {
    assert.strictEqual((await req(server, 'DELETE', '/api/clubs/' + club.slug + '/members/' + A.id, { token: tok(A) })).status, 409);
    assert.strictEqual((await req(server, 'PATCH', '/api/clubs/' + club.slug + '/members/' + coach.id, { token: tok(A), body: { role: 'owner' } })).json.role, 'owner');
    const c2 = await prisma.club.findUnique({ where: { id: club.id } });
    assert.strictEqual(c2.ownerId, coach.id);
    assert.strictEqual((await prisma.clubMembership.findUnique({ where: { clubId_userId: { clubId: club.id, userId: A.id } } })).role, 'coach');
    assert.strictEqual((await req(server, 'DELETE', '/api/clubs/' + club.slug + '/members/' + A.id, { token: tok(A) })).status, 200);
  });

  server.close();
  await push.flush();
  console.log(`\n${passed} passaram, ${failed} falharam`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
})().catch(async (e) => {
  console.error('ERRO FATAL', e);
  try { await prisma.$disconnect(); } catch (_) {}
  process.exit(1);
});
