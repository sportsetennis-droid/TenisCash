'use strict';
// =====================================================================
// Liga Aberta — FASE 5 (arquivos e desempenho). npm run test:liga-f5
//
// Parte 1 (sem banco): assinatura SigV4 (vetor oficial da AWS), adaptador S3 só com
//   todas as variáveis (https), rótulos do card por esporte, schema F5 no início do
//   ensureApexSchema, cursor inválido.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. upload grava em MediaObject e devolve /media/...; dedup por sha256
//   b. /media: cabeçalhos (immutable, ETag/304, nosniff, CSP sandbox), HEAD, recusa SVG,
//      extensão errada e sha inexistente
//   c. APIs JSON de torneio/clube/atleta sem 'data:image' (varredura); data URI antigo
//      continua no banco e abre pela URL devolvida e pelo paliativo
//   d. migração dry-run / apply / apply de novo / revert / revert de novo, pulando o
//      Master Cup (byte a byte) + CLI dry-run
//   e. índices (pg_indexes)
//   f. paginação por cursor (mural, vitrine, jogos, artilharia, ranking, histórico,
//      ranking Glicko) sem duplicar/pular, com inserção no meio; resposta antiga intacta
//   g. limites do plano grátis (torneio, /quick, categoria, time, aviso, imagem) — 402 em
//      PT; admin/equipe sem limite; dado antigo não bloqueia; Master Cup fora; /me/plan
//   h. card do atleta de beach tennis sem "GOLS" (JSON, arte e página)
//   i. app real (src/index.js): /media com helmet/compressão, /atleta, /t/:slug "Ver mais"
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });

let passed = 0;
let failed = 0;
let skipped = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    failed++;
    console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  }
}
function skip(name, why) { skipped++; console.log('  ⏭️  ' + name + ' — PULADO: ' + why); }
// prova de sabotagem: estraga, roda a checagem (TEM que falhar), conserta
async function sabotage(name, breakIt, check, restore) {
  let caught = false;
  try {
    await breakIt();
    try { await check(); } catch (_) { caught = true; }
  } finally {
    await restore();
  }
  if (caught) { passed++; console.log('  ✅ sabotagem pega: ' + name); } else { failed++; console.error('  ❌ sabotagem NÃO pega: ' + name); }
}

function httpCall(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers, Connection: 'close' };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request(url, { method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text, buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SALT_R = crypto.randomInt(256);
const SALT_G = crypto.randomInt(256);
async function pngDataUri(r, g, b, size = 24) {
  const sharp = require('sharp');
  const buf = await sharp({ create: { width: size, height: size, channels: 3, background: { r: (r + SALT_R) % 256, g: (g + SALT_G) % 256, b } } }).png().toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f5-' + crypto.randomBytes(8).toString('hex');
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 're_test_dummy';
  const mediaStore = require('../src/services/mediaStore');
  const cardStats = require('../src/services/athleteCardStats');
  const pag = require('../src/services/pagination');

  await ok('SigV4: vetor oficial da AWS (GET /test.txt, Range) dá a assinatura documentada', () => {
    const r = mediaStore.signV4({
      method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt',
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1', date: new Date('2013-05-24T00:00:00Z'),
    });
    assert.strictEqual(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    assert.ok(/SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/.test(r.headers.authorization));
  });

  await ok('adaptador S3 só liga com TODAS as variáveis e endpoint https (sem SSRF por usuário)', () => {
    const keys = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY', 'MEDIA_S3_PUBLIC_URL'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      keys.forEach((k) => delete process.env[k]);
      assert.strictEqual(mediaStore.adapterName(), 'db');
      Object.assign(process.env, { MEDIA_S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com', MEDIA_S3_BUCKET: 'liga-midia', MEDIA_S3_ACCESS_KEY_ID: 'k', MEDIA_S3_SECRET_ACCESS_KEY: 's' });
      assert.strictEqual(mediaStore.adapterName(), 'db', 'sem URL pública não liga');
      process.env.MEDIA_S3_PUBLIC_URL = 'https://midia.exemplo.com.br';
      assert.strictEqual(mediaStore.adapterName(), 's3');
      process.env.MEDIA_S3_ENDPOINT = 'http://169.254.169.254';
      assert.strictEqual(mediaStore.adapterName(), 'db', 'http (metadados) recusado');
      process.env.MEDIA_S3_ENDPOINT = 'https://acc.r2.cloudflarestorage.com/../x';
      assert.strictEqual(mediaStore.adapterName(), 'db', 'endpoint com caminho recusado');
    } finally {
      keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    }
  });

  const beachCard = { stats: { matchesPlayed: 10, wins: 7, titles: 1, tournaments: 3, goals: 0, assists: 0 }, history: { bySport: [{ sport: 'BEACH_TENNIS', games: 10, goals: 0, assists: 0 }] }, ratings: [] };
  const checkBeachCells = (card) => {
    const cs = cardStats.statCells(card);
    const labels = cs.cells.map((c) => c.label.toUpperCase());
    assert.ok(!labels.includes('GOLS') && !labels.includes('ASSIST.'), 'raquete com gol: ' + labels);
    assert.deepStrictEqual(labels, ['JOGOS', 'VITÓRIAS', 'APROVEIT.', 'TÍTULOS', 'TORNEIOS']);
    assert.strictEqual(cs.cells[2].value, '70%');
  };
  await ok('card: raquete = Jogos/Vitórias/Aproveit./Títulos/Torneios (sem GOLS); futsal = Gols/Assist.; basquete = Pontos', () => {
    checkBeachCells(beachCard);
    const fut = cardStats.statCells({ stats: { matchesPlayed: 5, wins: 2 }, history: { bySport: [{ sport: 'FUTSAL', games: 5, goals: 4, assists: 2 }] }, ratings: [] });
    assert.deepStrictEqual(fut.cells.map((c) => c.label), ['Jogos', 'Vitórias', 'Gols', 'Assist.', 'Títulos', 'Torneios']);
    assert.strictEqual(fut.cells[2].value, 4);
    const bb = cardStats.statCells({ stats: { matchesPlayed: 3, wins: 1 }, history: { bySport: [{ sport: 'BASKETBALL', games: 3, goals: 31, assists: 0 }] }, ratings: [] });
    assert.strictEqual(bb.cells[2].label, 'Pontos');
    assert.strictEqual(bb.cells[2].value, 31);
    // sem histórico: esporte do rating
    assert.strictEqual(cardStats.statCells({ stats: {}, history: { bySport: [] }, ratings: [{ sport: 'PADEL' }] }).family, 'racket');
  });

  await ok('schema F5 no INÍCIO do ensureApexSchema (MediaObject, planos, coluna do aviso e índices) e no schema.prisma', () => {
    const { STATEMENTS } = require('../src/services/ensureApexSchema');
    const head = STATEMENTS.slice(0, 25).join('\n');
    for (const s of ['"MediaObject"', 'MediaObject_sha256_key', '"OrganizerPlan"', '"OrganizerSubscription"', '"imageUrl"', 'Tournament_ownerId_idx', 'TournamentMatch_homeEntryId_idx', 'TournamentMatch_awayEntryId_idx', 'TournamentMatch_winnerEntryId_idx', 'TournamentMatch_scheduledAt_idx', 'Club_ownerId_idx', 'ClubMembership_userId_idx']) assert.ok(head.includes(s), 'falta no início: ' + s);
    assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(STATEMENTS.join('\n')), 'nada de DROP');
    const prismaSrc = read('prisma/schema.prisma');
    assert.ok(/model MediaObject \{[\s\S]*sha256\s+String\s+@unique/.test(prismaSrc));
    assert.ok(/priceCents Int\?/.test(prismaSrc), 'preço nulo (sem preço definido)');
  });

  await ok('cursor inválido = erro 400 (não quebra a consulta)', () => {
    assert.throws(() => pag.parsePage({ cursor: '!!!' }), /cursor inválido/);
    assert.strictEqual(pag.parsePage({ limit: '0' }, { defaultLimit: 20 }).limit, 20, 'limit estranho cai no padrão (como antes)');
    assert.strictEqual(pag.parsePage({ limit: 'abc' }, { defaultLimit: 7 }).limit, 7);
    assert.throws(() => pag.keysetWhere(pag.POST_SPEC, { k: ['x', { d: '2026-01-01T00:00:00Z' }, 'id'] }), /cursor inválido/, 'tipo errado no cursor = 400');
    assert.throws(() => pag.keysetWhere(pag.POST_SPEC, { k: [1] }), /cursor inválido/);
    const p = pag.parsePage({});
    assert.strictEqual(p.paged, false);
  });

  await ok('clube.html (página do clube) mostra escudo/foto guardados em /media (safeImg)', () => {
    const src = read('public/clube.html');
    const m = /function safeImg\(u\)\{[^\n]*\}/.exec(src);
    assert.ok(m, 'safeImg não achado');
    const fn = new Function(m[0] + '; return safeImg;')();
    assert.strictEqual(fn('/media/' + 'a'.repeat(64) + '.png'), '/media/' + 'a'.repeat(64) + '.png');
    assert.strictEqual(fn('javascript:alert(1)'), '');
    assert.strictEqual(fn('/media/../x.png'), '');
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('mídia, migração, paginação, planos, páginas', 'DATABASE_URL local (localhost) não definido');
    if (process.env.CI) { failed++; console.error('  ❌ no CI a parte de banco não pode ser pulada'); }
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  process.env.LIGA_PLAN_START = '2020-01-01T00:00:00Z'; // limites por torneio valem nos torneios do teste
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const mediaStore = require('../src/services/mediaStore');
  const mig = require('../src/services/mediaMigration');
  const plans = require('../src/services/organizerPlan');
  const pag = require('../src/services/pagination');
  const clubIdentity = require('../src/services/clubIdentity');
  const cardStats = require('../src/services/athleteCardStats');
  const art = require('../src/services/tournamentArt');
  await ensureApexSchema(prisma);
  try { require('../src/services/clubs').setPrisma(prisma); } catch (_) {}
  try { require('../src/services/clubRankings').setPrisma(prisma); } catch (_) {}

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  app.use(['/api/tournaments', '/api/public', '/api/club-ranking', '/api/clubs'], mediaStore.jsonMiddleware);
  app.get('/media/:file', mediaStore.serveMedia);
  app.head('/media/:file', mediaStore.serveMedia);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use('/api/clubs', require('../src/routes/clubs'));
  app.use('/api/club-ranking', require('../src/routes/clubRanking'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipSeq = 0;
  const call = (method, url, { token, body, headers } = {}) => {
    const h = { 'cf-connecting-ip': `198.51.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}`, ...(headers || {}) };
    if (token) h.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, h, body);
  };

  const RUN = Date.now().toString(36);
  const LET = RUN.replace(/[0-9]/g, (d) => 'abcdefghij'[d]).toUpperCase(); // só letras (esporte do ranking)
  const RSP = 'PADELX' + LET;
  const GSP = 'BTX' + LET;
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  const mkUser = (label, extra = {}) => prisma.user.create({ data: { name: `F5 ${label} ${RUN}-${++seq}`, phone: '838' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const U = {
    org: await mkUser('organizador'),
    coord: await mkUser('coordenador'),
    other: await mkUser('qualquer'),
    beach: await mkUser('beach', { username: 'f5bt' + RUN }),
    fut: await mkUser('futsal', { username: 'f5fu' + RUN }),
    staff: await mkUser('equipe', { role: 'admin' }),
    planner: await mkUser('limites'),
    mcOwner: await mkUser('dono master cup'),
  };

  // ---------------------------------------------------------------- dados
  const T = await prisma.tournament.create({ data: { slug: 'f5-copa-' + RUN, name: 'Copa F5 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre' } });
  const cat2 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Master' } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Leões ' + RUN, status: 'CONFIRMED' } });
  const eA2 = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat2.id, name: 'Leões ' + RUN, status: 'CONFIRMED' } });
  const eB = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Tubarões ' + RUN, status: 'CONFIRMED' } });
  const logo1 = await pngDataUri(200, 30, 30);

  // ================================================================ a. upload + dedup
  console.log('  — a. upload e dedup');
  let mediaUrl = null;
  await ok('upload do escudo grava em MediaObject (dono, origem upload) e devolve /media/<sha>.png; campo guarda a URL', async () => {
    const r = await call('POST', `/api/tournaments/entries/${eA.id}/logo`, { token: tok(U.org), body: { logo: logo1 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(mediaStore.MEDIA_PATH_RX.test(r.json.logoUrl), r.json.logoUrl);
    mediaUrl = r.json.logoUrl;
    const sha = mediaUrl.slice(7, 71);
    const row = await prisma.mediaObject.findUnique({ where: { sha256: sha } });
    assert.ok(row && row.bytes && row.bytes.length > 0 && row.mime === 'image/png');
    assert.strictEqual(row.ownerUserId, U.org.id);
    assert.strictEqual(row.source, 'upload');
    assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(row.bytes)).digest('hex'), sha);
    const both = await prisma.tournamentEntry.findMany({ where: { id: { in: [eA.id, eA2.id] } }, select: { logoUrl: true } });
    assert.ok(both.every((e) => e.logoUrl === mediaUrl), 'o mesmo escudo nas 2 categorias do time (1 objeto)');
  });
  await ok('dedup por sha256: o mesmo escudo enviado de novo (outro time) NÃO cria outro objeto', async () => {
    const before = await prisma.mediaObject.count();
    const r = await call('POST', `/api/tournaments/entries/${eB.id}/logo`, { token: tok(U.org), body: { logo: logo1 } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.logoUrl, mediaUrl);
    assert.strictEqual(await prisma.mediaObject.count(), before);
  });
  await ok('SVG enviado é recusado (400) e "/media" inexistente não é aceito como valor', async () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    const r = await call('POST', `/api/tournaments/entries/${eB.id}/logo`, { token: tok(U.org), body: { logo: svg } });
    assert.strictEqual(r.status, 400);
    const r2 = await call('POST', `/api/tournaments/entries/${eB.id}/logo`, { token: tok(U.org), body: { logo: '/media/' + 'a'.repeat(64) + '.png' } });
    assert.strictEqual(r2.status, 400);
    const r3 = await call('POST', `/api/tournaments/entries/${eB.id}/logo`, { token: tok(U.org), body: { logo: '/api/public/entries/' + eB.id + '/logo' } });
    assert.strictEqual(r3.status, 400, 'endereço interno não vira laço');
    const r4 = await call('POST', `/api/tournaments/entries/${eB.id}/logo`, { token: tok(U.org), body: { logo: mediaUrl } });
    assert.strictEqual(r4.status, 200, 'URL /media já gravada é aceita');
  });
  await ok('banner, patrocinador, aviso com imagem e escudo do clube também vão pro mediaStore', async () => {
    const b1 = await pngDataUri(10, 120, 200, 40);
    const p = await call('PATCH', `/api/tournaments/${T.id}`, { token: tok(U.org), body: { bannerUrl: b1 } });
    assert.strictEqual(p.status, 200, p.text);
    assert.ok(mediaStore.isMediaPath((await prisma.tournament.findUnique({ where: { id: T.id } })).bannerUrl));
    const sp = await call('POST', `/api/tournaments/${T.id}/sponsors`, { token: tok(U.org), body: { name: 'Patro', logoUrl: await pngDataUri(1, 2, 3) } });
    assert.strictEqual(sp.status, 201, sp.text);
    assert.ok(mediaStore.isMediaPath((await prisma.tournamentSponsor.findUnique({ where: { id: sp.json.id } })).logoUrl));
    const po = await call('POST', `/api/tournaments/${T.id}/posts`, { token: tok(U.org), body: { body: 'com foto', image: await pngDataUri(9, 9, 200) } });
    assert.strictEqual(po.status, 201, po.text);
    assert.ok(mediaStore.isMediaPath(po.json.imageUrl), po.json.imageUrl);
    const cl = await call('POST', '/api/clubs', { token: tok(U.org), body: { name: 'Clube F5 ' + RUN, crestUrl: await pngDataUri(50, 50, 50) } });
    assert.strictEqual(cl.status, 201, cl.text);
    assert.ok(mediaStore.isMediaPath((await prisma.club.findUnique({ where: { id: cl.json.id } })).crestUrl));
  });

  // ================================================================ b. rota /media
  console.log('  — b. /media');
  const checkMediaHeaders = async () => {
    const r = await call('GET', mediaUrl);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.strictEqual(r.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(/sandbox/.test(r.headers['content-security-policy'] || ''));
    assert.strictEqual(r.headers.etag, '"' + mediaUrl.slice(7, 71) + '"');
    assert.strictEqual(r.buf.slice(1, 4).toString('latin1'), 'PNG');
    const r304 = await call('GET', mediaUrl, { headers: { 'If-None-Match': r.headers.etag } });
    assert.strictEqual(r304.status, 304);
  };
  await ok('GET /media: 200 PNG, cache de 1 ano immutable, ETag (304), nosniff, CSP sandbox', checkMediaHeaders);
  await ok('HEAD /media: 200 sem corpo; .svg, extensão errada, sha inexistente e traversal = 404', async () => {
    const h = await call('HEAD', mediaUrl);
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.buf.length, 0);
    const sha = mediaUrl.slice(7, 71);
    for (const bad of [`/media/${sha}.svg`, `/media/${sha}.jpg`, `/media/${'b'.repeat(64)}.png`, '/media/..%2f..%2fpackage.json', `/media/${sha.toUpperCase()}.png`]) {
      const r = await call('GET', bad);
      assert.strictEqual(r.status, 404, bad);
    }
    const q = await call('GET', mediaUrl + '?x=1');
    assert.strictEqual(q.status, 301, 'query string → endereço canônico (não fura o cache)');
    assert.strictEqual(q.headers.location, mediaUrl);
    // um SVG gravado à força no banco não é servido
    const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const sSha = crypto.createHash('sha256').update(svgBuf).digest('hex');
    await prisma.mediaObject.createMany({ data: [{ sha256: sSha, mime: 'image/svg+xml', bytes: svgBuf, size: svgBuf.length }], skipDuplicates: true });
    for (const ext of ['png', 'svg']) assert.strictEqual((await call('GET', `/media/${sSha}.${ext}`)).status, 404);
  });

  // ================================================================ c. APIs JSON sem base64
  console.log('  — c. JSON sem base64 + data URI antigo');
  // dados ANTIGOS (como gravados antes da F5): data URI direto no banco
  const oldLogo = await pngDataUri(0, 160, 60);
  const oldCrest = await pngDataUri(160, 0, 160);
  const oldAvatar = await pngDataUri(255, 200, 0, 32);
  const oldBanner = await pngDataUri(20, 20, 20, 48);
  const oldSponsor = await pngDataUri(70, 80, 90);
  const svgOld = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  const LT = await prisma.tournament.create({ data: { slug: 'f5-antigo-' + RUN, name: 'Antigo F5 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'ONGOING', visibility: 'public', bannerUrl: oldBanner } });
  const lcat = await prisma.tournamentCategory.create({ data: { tournamentId: LT.id, name: 'Única' } });
  const lclub = await prisma.club.create({ data: { ownerId: U.org.id, name: 'Clube Antigo ' + RUN, slug: 'clube-antigo-' + RUN, crestUrl: oldCrest } });
  const le1 = await prisma.tournamentEntry.create({ data: { tournamentId: LT.id, categoryId: lcat.id, name: 'Velho A ' + RUN, status: 'CONFIRMED', logoUrl: oldLogo } });
  const le2 = await prisma.tournamentEntry.create({ data: { tournamentId: LT.id, categoryId: lcat.id, name: 'Velho B ' + RUN, status: 'CONFIRMED', clubId: lclub.id } });
  const le3 = await prisma.tournamentEntry.create({ data: { tournamentId: LT.id, categoryId: lcat.id, name: 'Velho SVG ' + RUN, status: 'CONFIRMED', logoUrl: svgOld } });
  await prisma.tournamentSponsor.create({ data: { tournamentId: LT.id, name: 'Patro Antigo', logoUrl: oldSponsor } });
  await prisma.athleteProfile.upsert({ where: { userId: U.fut.id }, create: { userId: U.fut.id, username: U.fut.username, avatarUrl: oldAvatar }, update: { avatarUrl: oldAvatar } });
  const rpF = await prisma.rosterPlayer.create({ data: { entryId: le1.id, name: 'Artilheiro', number: 9, userId: U.fut.id, role: 'PLAYER' } });
  const lm = await prisma.tournamentMatch.create({ data: { tournamentId: LT.id, categoryId: lcat.id, stage: 'LEAGUE', round: 1, homeEntryId: le1.id, awayEntryId: le2.id, status: 'FINISHED', homeScore: 2, awayScore: 0, winnerEntryId: le1.id } });
  await prisma.matchEvent.createMany({ data: [{ matchId: lm.id, entryId: le1.id, playerId: rpF.id, type: 'GOAL' }, { matchId: lm.id, entryId: le1.id, playerId: rpF.id, type: 'GOAL' }] });
  await prisma.glickoRating.create({ data: { sport: 'FUTSAL', format: 'SINGLES', subjectType: 'USER', subjectKey: U.fut.id, userId: U.fut.id, rating: 1600, rd: 80, volatility: 0.06, matches: 3 } }).catch(() => null);
  const jsonUrls = () => [
    `/api/tournaments/${LT.id}`, `/api/tournaments/${LT.slug}`, `/api/tournaments/${LT.id}/entries`,
    `/api/tournaments/${LT.id}/categories/${lcat.id}/matches`, `/api/tournaments/${LT.id}/categories/${lcat.id}/standings`,
    `/api/tournaments/${LT.id}/stats/scorers`, `/api/tournaments/${LT.id}/sponsors`, `/api/tournaments?limit=100`,
    `/api/public/tournaments/${LT.slug}`, `/api/clubs/${lclub.slug}`, `/api/tournaments/athletes/${U.fut.username}/card`,
    `/api/tournaments/athletes/${U.fut.username}/history`, `/api/club-ranking/FUTSAL/rating?format=SINGLES`, `/api/tournaments/${LT.id}/posts`,
  ];
  const scanNoBase64 = async () => {
    for (const u of jsonUrls()) {
      const r = await call('GET', u);
      assert.ok(r.status === 200, u + ' → ' + r.status + ' ' + r.text.slice(0, 200));
      assert.ok(r.json, u + ' não é JSON');
      assert.ok(!/data:image/i.test(r.text), 'base64 de imagem na resposta de ' + u);
    }
  };
  await ok('varredura: nenhuma API JSON de torneio/clube/atleta devolve "data:image" (14 rotas)', scanNoBase64);
  await ok('JSON: texto que só parece data URI fica; SVG em campo de imagem = null; falha ao registrar = imagem continua (não some)', async () => {
    const fake = 'data:image/png;base64,QUJD';
    const out = await mediaStore.publicizePayload({ description: fake, logoUrl: svgOld, other: { crestUrl: fake } });
    assert.strictEqual(out.description, fake, 'texto livre não vira null');
    assert.strictEqual(out.logoUrl, null);
    assert.strictEqual(out.other.crestUrl, null, 'campo de imagem ilegível = null');
    const fresh = await pngDataUri(7, 77, 177, 20);
    mediaStore.setPrisma({ mediaObject: { findUnique: async () => { throw new Error('tabela ainda não existe'); } } });
    try {
      const o2 = await mediaStore.publicizePayload({ logoUrl: fresh });
      assert.strictEqual(o2.logoUrl, fresh, 'falha no armazenamento NÃO apaga a imagem');
    } finally { mediaStore.setPrisma(prisma); }
  });
  await ok('data URI antigo: continua no banco, aparece como URL e abre (mesmos bytes); paliativo segue servindo; SVG antigo sai null', async () => {
    const row = await prisma.tournamentEntry.findUnique({ where: { id: le1.id } });
    assert.strictEqual(row.logoUrl, oldLogo, 'o dado de origem não muda');
    const r = await call('GET', `/api/tournaments/${LT.id}/entries`);
    const list = r.json.entries || r.json;
    const e1 = list.find((x) => x.id === le1.id);
    assert.ok(e1 && mediaStore.isMediaPath(e1.logoUrl), JSON.stringify(e1 && e1.logoUrl));
    const img = await call('GET', e1.logoUrl);
    assert.strictEqual(img.status, 200);
    assert.ok(img.buf.equals(Buffer.from(oldLogo.split(',')[1], 'base64')), 'mesmos bytes do data URI antigo');
    const legacy = await prisma.mediaObject.findUnique({ where: { sha256: e1.logoUrl.slice(7, 71) } });
    assert.strictEqual(legacy.source, 'legacy');
    const e2 = list.find((x) => x.id === le2.id);
    assert.ok(mediaStore.isMediaPath(e2.logoUrl), 'escudo antigo do CLUBE também vira URL');
    const e3 = list.find((x) => x.id === le3.id);
    assert.strictEqual(e3.logoUrl, null, 'SVG antigo nunca sai');
    const pal = await call('GET', `/api/public/entries/${le1.id}/logo`);
    assert.strictEqual(pal.status, 200);
    assert.ok(/max-age=3600/.test(pal.headers['cache-control']));
    const pub = await call('GET', `/api/public/tournaments/${LT.slug}`);
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/media\//.test(pub.json.tournament.logoUrl), 'API pública (embed): URL absoluta ' + pub.json.tournament.logoUrl);
  });

  // ================================================================ d. migração
  console.log('  — d. migração (Master Cup fora)');
  const mcFound = await prisma.tournament.findUnique({ where: { slug: 'futsal-master-cup-2026' } });
  if (mcFound) await prisma.tournament.update({ where: { id: mcFound.id }, data: { ownerId: U.mcOwner.id } });
  const MC = mcFound
    || await prisma.tournament.create({ data: { slug: 'futsal-master-cup-2026', name: 'II Futsal Master Cup 2026', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', ownerId: U.mcOwner.id, status: 'ONGOING', visibility: 'public' } });
  const mcBanner = await pngDataUri(1, 99, 1, 40);
  await prisma.tournament.update({ where: { id: MC.id }, data: { bannerUrl: mcBanner } });
  const mcCat = await prisma.tournamentCategory.create({ data: { tournamentId: MC.id, name: '40+ A ' + RUN } });
  const mcLogo = await pngDataUri(2, 98, 2);
  const mcE = await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, name: 'Cabo Branco ' + RUN, status: 'CONFIRMED', logoUrl: mcLogo } });
  const mcSp = await prisma.tournamentSponsor.create({ data: { tournamentId: MC.id, name: 'Patro MC', logoUrl: mcLogo } });
  const mcPlayer = await mkUser('atleta master cup');
  await prisma.athleteProfile.create({ data: { userId: mcPlayer.id, avatarUrl: await pngDataUri(3, 3, 97) } });
  await prisma.entryMember.create({ data: { entryId: mcE.id, userId: mcPlayer.id } });
  const mcClub = await prisma.club.create({ data: { ownerId: U.mcOwner.id, name: 'Clube do MC ' + RUN, slug: 'clube-mc-' + RUN, crestUrl: mcLogo, originTournamentId: MC.id } });
  const snapMC = async () => JSON.stringify(await Promise.all([
    prisma.tournament.findUnique({ where: { id: MC.id }, select: { bannerUrl: true, updatedAt: true } }),
    prisma.tournamentEntry.findMany({ where: { tournamentId: MC.id }, select: { id: true, logoUrl: true }, orderBy: { id: 'asc' } }),
    prisma.tournamentSponsor.findMany({ where: { tournamentId: MC.id }, select: { id: true, logoUrl: true }, orderBy: { id: 'asc' } }),
    prisma.athleteProfile.findUnique({ where: { userId: mcPlayer.id }, select: { avatarUrl: true } }),
    prisma.club.findUnique({ where: { id: mcClub.id }, select: { crestUrl: true } }),
  ]));
  const mcBefore = await snapMC();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liga-f5-'));
  const backupFile = path.join(tmp, 'bk.jsonl');
  const legacyRows = async () => ({
    banner: (await prisma.tournament.findUnique({ where: { id: LT.id } })).bannerUrl,
    logo: (await prisma.tournamentEntry.findUnique({ where: { id: le1.id } })).logoUrl,
    crest: (await prisma.club.findUnique({ where: { id: lclub.id } })).crestUrl,
    avatar: (await prisma.athleteProfile.findUnique({ where: { userId: U.fut.id } })).avatarUrl,
    svg: (await prisma.tournamentEntry.findUnique({ where: { id: le3.id } })).logoUrl,
  });
  let firstApply = null;
  await ok('migração dry-run: conta sem gravar nada (nem objeto, nem campo)', async () => {
    const before = await prisma.mediaObject.count();
    const rows0 = await legacyRows();
    const rep = await mig.run(prisma, { apply: false });
    assert.ok(rep.migrated >= 5, 'a migrar: ' + rep.migrated);
    assert.ok(rep.keptExcluded >= 5, 'Master Cup mantido: ' + rep.keptExcluded);
    assert.strictEqual(await prisma.mediaObject.count(), before);
    assert.deepStrictEqual(await legacyRows(), rows0);
    assert.ok(rep.skipped.some((s) => s.id === le3.id && /SVG/.test(s.reason)), 'SVG listado e não migrado');
  });
  await ok('migração --apply: campos viram /media (backup antes), SVG fica, Master Cup intacto byte a byte', async () => {
    firstApply = await mig.run(prisma, { apply: true, backupFile, batch: 2 });
    const rows = await legacyRows();
    for (const k of ['banner', 'logo', 'crest', 'avatar']) assert.ok(mediaStore.isMediaPath(rows[k]), k + ' = ' + String(rows[k]).slice(0, 40));
    assert.strictEqual(rows.svg, svgOld);
    const lines = fs.readFileSync(backupFile, 'utf8').trim().split('\n');
    assert.ok(lines.length >= firstApply.migrated);
    assert.ok(lines.some((l) => JSON.parse(l).old === oldLogo), 'backup guarda o valor antigo');
    assert.strictEqual(await snapMC(), mcBefore, 'Master Cup NÃO pode mudar');
    const obj = await prisma.mediaObject.findUnique({ where: { sha256: rows.banner.slice(7, 71) } });
    assert.ok(obj && ['legacy', 'migration'].includes(obj.source), 'objeto registrado (o mesmo conteúdo já servido vira 1 objeto só)');
  });
  await ok('migração idempotente: 2º apply não acha nada novo; Master Cup segue lendo o data URI', async () => {
    const rep = await mig.run(prisma, { apply: true, backupFile: path.join(tmp, 'bk2.jsonl') });
    assert.strictEqual(rep.migrated, 0);
    assert.strictEqual(await snapMC(), mcBefore);
    const r = await call('GET', `/api/tournaments/${MC.id}/entries`);
    assert.ok(!/data:image/.test(r.text), 'JSON do Master Cup sem base64');
    const pal = await call('GET', `/api/public/entries/${mcE.id}/logo`);
    assert.strictEqual(pal.status, 200, 'paliativo do Master Cup lê o data URI antigo');
  });
  await ok('revert: volta o data URI; revert de novo não muda nada; objetos ficam', async () => {
    const objs = await prisma.mediaObject.count();
    const r1 = await mig.revert(prisma, backupFile);
    assert.ok(r1.restored >= 5);
    const rows = await legacyRows();
    assert.strictEqual(rows.logo, oldLogo);
    assert.strictEqual(rows.banner, oldBanner);
    assert.strictEqual(rows.crest, oldCrest);
    assert.strictEqual(rows.avatar, oldAvatar);
    const r2 = await mig.revert(prisma, backupFile);
    assert.strictEqual(r2.restored, 0);
    assert.strictEqual(await prisma.mediaObject.count(), objs, 'nunca apaga objeto');
    assert.strictEqual(await snapMC(), mcBefore);
  });
  await ok('CLI: node scripts/migrate-liga-f5-media.js (dry-run) roda e não grava', async () => {
    const before = await legacyRows();
    const out = spawnSync(process.execPath, [path.join(__dirname, 'migrate-liga-f5-media.js')], { env: { ...process.env }, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(out.status, 0, out.stderr || out.stdout);
    assert.ok(/DRY-RUN/.test(out.stdout) && /nada gravado/.test(out.stdout) && /futsal-master-cup-2026/.test(out.stdout), out.stdout.slice(-400));
    assert.deepStrictEqual(await legacyRows(), before);
  });

  // ================================================================ e. índices
  console.log('  — e. índices');
  const NEED_IDX = ['Tournament_ownerId_idx', 'TournamentMatch_homeEntryId_idx', 'TournamentMatch_awayEntryId_idx', 'TournamentMatch_winnerEntryId_idx', 'TournamentMatch_scheduledAt_idx', 'TournamentMatch_categoryId_round_ordering_idx', 'Club_ownerId_idx', 'Club_originTournamentId_idx', 'ClubMembership_userId_idx', 'TournamentStanding_tournamentId_idx', 'TournamentPost_tournamentId_pinned_createdAt_idx', 'PickupAttendance_playerId_idx', 'MediaObject_sha256_key', 'MediaObject_ownerUserId_createdAt_idx', 'TournamentAudit_tournamentId_createdAt_idx', 'TeamInvite_entryId_idx', 'RosterInvite_rosterPlayerId_idx'];
  await ok('índices existem (pg_indexes), inclusive os das tabelas das F1–F4', async () => {
    const rows = await prisma.$queryRawUnsafe('SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()');
    const have = new Set(rows.map((r) => r.indexname));
    for (const i of NEED_IDX) assert.ok(have.has(i), 'falta índice ' + i);
  });

  // ================================================================ f. paginação
  console.log('  — f. paginação por cursor');
  const collect = async (urlFn, key, idOf, limit) => {
    const seen = [];
    let cur = null;
    for (let guard = 0; guard < 200; guard++) {
      const r = await call('GET', urlFn(limit, cur));
      assert.strictEqual(r.status, 200, r.text);
      for (const x of r.json[key]) seen.push(idOf(x));
      cur = r.json.nextCursor || r.json.tournamentsNextCursor || null;
      if (!cur) break;
    }
    return seen;
  };
  const noDup = (arr) => assert.strictEqual(new Set(arr).size, arr.length, 'item duplicado entre páginas');
  // mural: 23 avisos, vários com o MESMO createdAt (desempate por id) e alguns fixados
  const PT = await prisma.tournament.create({ data: { slug: 'f5-mural-' + RUN, name: 'Mural F5 ' + RUN, sport: 'FUTSAL', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const sameAt = new Date('2026-11-01T12:00:00Z');
  for (let i = 0; i < 23; i++) await prisma.tournamentPost.create({ data: { tournamentId: PT.id, body: 'aviso ' + i, pinned: i % 7 === 0, createdAt: i < 10 ? sameAt : new Date(sameAt.getTime() + i * 60000) } });
  const postsAll = async () => (await prisma.tournamentPost.findMany({ where: { tournamentId: PT.id }, orderBy: pag.orderByOf(pag.POST_SPEC) })).map((p) => p.id);
  const checkPostsPaging = async () => {
    const got = await collect((l, c) => `/api/tournaments/${PT.id}/posts?limit=${l}` + (c ? '&cursor=' + encodeURIComponent(c) : ''), 'posts', (p) => p.id, 4);
    noDup(got);
    assert.deepStrictEqual(got, await postsAll(), 'ordem/itens diferentes da consulta inteira');
  };
  await ok('mural: páginas de 4 = a lista inteira, na ordem (fixado, data, id), sem duplicar nem pular', checkPostsPaging);
  await ok('mural: aviso novo inserido NO MEIO da paginação não duplica nem some item da sequência', async () => {
    const r1 = await call('GET', `/api/tournaments/${PT.id}/posts?limit=5`);
    const first = r1.json.posts.map((p) => p.id);
    await prisma.tournamentPost.create({ data: { tournamentId: PT.id, body: 'novo no meio', createdAt: new Date(sameAt.getTime() + 5 * 60000 + 1) } });
    const rest = await collect((l, c) => `/api/tournaments/${PT.id}/posts?limit=${l}&cursor=${encodeURIComponent(c || r1.json.nextCursor)}`, 'posts', (p) => p.id, 5);
    const all = first.concat(rest);
    noDup(all);
    const full = await postsAll();
    const missing = full.filter((id) => !all.includes(id));
    assert.ok(missing.length <= 1, 'só o item novo (que entrou ANTES do cursor) pode faltar: ' + missing.length);
  });
  await ok('cursor adulterado (tipo errado) = 400 em PT, não 500', async () => {
    const bad = Buffer.from(JSON.stringify({ k: [1, 2, 3] })).toString('base64url');
    const r = await call('GET', `/api/tournaments/${PT.id}/posts?limit=3&cursor=${bad}`);
    assert.strictEqual(r.status, 400, r.text);
    assert.ok(/cursor inválido/.test(r.json.error));
  });
  await ok('mural sem limit/cursor: resposta antiga ({posts}, até 50) + nextCursor nulo', async () => {
    const r = await call('GET', `/api/tournaments/${PT.id}/posts`);
    assert.ok(Array.isArray(r.json.posts) && r.json.posts.length === 24);
    assert.strictEqual(r.json.nextCursor, null);
  });
  // vitrine: 15 torneios públicos (alguns sem data)
  const VS = 'f5vit' + RUN;
  for (let i = 0; i < 15; i++) await prisma.tournament.create({ data: { slug: VS + '-' + i, name: 'Vitrine ' + i, sport: 'TABLE_TENNIS', storeId: VS, ownerId: U.staff.id, status: i % 3 === 0 ? 'OPEN' : 'ONGOING', visibility: 'public', startDate: i % 4 === 0 ? null : new Date(Date.UTC(2026, 10, 1 + i)) } });
  await ok('vitrine: páginas por cursor (data nula por último) = conjunto da resposta antiga, sem duplicar', async () => {
    const got = await collect((l, c) => `/api/tournaments?sport=TABLE_TENNIS&storeId=${VS}&limit=${l}` + (c ? '&cursor=' + encodeURIComponent(c) : ''), 'tournaments', (t) => t.id, 4);
    noDup(got);
    const legacy = await call('GET', '/api/tournaments?sport=TABLE_TENNIS&storeId=' + VS);
    assert.ok(Array.isArray(legacy.json.tournaments));
    assert.deepStrictEqual([...got].sort(), legacy.json.tournaments.map((t) => t.id).sort());
    assert.strictEqual(got.length, 15);
  });
  // jogos: 260 numa categoria (passa do teto seguro)
  const MT = await prisma.tournament.create({ data: { slug: 'f5-jogos-' + RUN, name: 'Jogos F5 ' + RUN, sport: 'FUTSAL', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const mcat = await prisma.tournamentCategory.create({ data: { tournamentId: MT.id, name: 'Grande' } });
  const smallCat = await prisma.tournamentCategory.create({ data: { tournamentId: MT.id, name: 'Pequena' } });
  await prisma.tournamentMatch.createMany({ data: Array.from({ length: 260 }, (_, i) => ({ tournamentId: MT.id, categoryId: mcat.id, stage: 'LEAGUE', round: 1 + Math.floor(i / 20), ordering: i % 3, status: 'SCHEDULED' })) });
  await prisma.tournamentMatch.createMany({ data: Array.from({ length: 12 }, (_, i) => ({ tournamentId: MT.id, categoryId: smallCat.id, stage: 'LEAGUE', round: 1 + Math.floor(i / 4), ordering: i % 4, status: 'SCHEDULED' })) });
  await ok('jogos: categoria pequena sem limit/cursor = resposta ANTIGA ({matches}, sem nextCursor)', async () => {
    const r = await call('GET', `/api/tournaments/${MT.id}/categories/${smallCat.id}/matches`);
    assert.deepStrictEqual(Object.keys(r.json), ['matches']);
    assert.strictEqual(r.json.matches.length, 12);
  });
  await ok('jogos: acima do teto seguro vem paginado; seguir o cursor dá os 260 sem repetir, na ordem (rodada, ordem, id)', async () => {
    process.env.LIGA_MATCHES_SAFE_CAP = '50';
    try {
      const r = await call('GET', `/api/tournaments/${MT.id}/categories/${mcat.id}/matches`);
      assert.strictEqual(r.json.matches.length, 200);
      assert.ok(r.json.nextCursor);
      const got = await collect((l, c) => `/api/tournaments/${MT.id}/categories/${mcat.id}/matches?limit=${l}` + (c ? '&cursor=' + encodeURIComponent(c) : ''), 'matches', (m) => m.id, 37);
      noDup(got);
      const full = (await prisma.tournamentMatch.findMany({ where: { categoryId: mcat.id }, orderBy: pag.orderByOf(pag.MATCH_SPEC), select: { id: true } })).map((m) => m.id);
      assert.deepStrictEqual(got, full);
    } finally { delete process.env.LIGA_MATCHES_SAFE_CAP; }
  });
  // artilharia com empates + ranking por esporte + histórico + ranking Glicko
  const ST = await prisma.tournament.create({ data: { slug: 'f5-art-' + RUN, name: 'Artilharia F5 ' + RUN, sport: 'HANDBALL', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const scat = await prisma.tournamentCategory.create({ data: { tournamentId: ST.id, name: 'Livre' } });
  const se1 = await prisma.tournamentEntry.create({ data: { tournamentId: ST.id, categoryId: scat.id, name: 'Time 1', status: 'CONFIRMED' } });
  const se2 = await prisma.tournamentEntry.create({ data: { tournamentId: ST.id, categoryId: scat.id, name: 'Time 2', status: 'CONFIRMED' } });
  const smatch = await prisma.tournamentMatch.create({ data: { tournamentId: ST.id, categoryId: scat.id, stage: 'LEAGUE', round: 1, homeEntryId: se1.id, awayEntryId: se2.id, status: 'FINISHED', homeScore: 30, awayScore: 20 } });
  const evs = [];
  for (let i = 0; i < 17; i++) {
    const p = await prisma.rosterPlayer.create({ data: { entryId: i % 2 ? se1.id : se2.id, name: 'Igual', number: i, role: 'PLAYER' } }); // nomes IGUAIS: desempate por id
    for (let g = 0; g < (i % 3) + 1; g++) evs.push({ matchId: smatch.id, entryId: p.entryId, playerId: p.id, type: 'GOAL' });
  }
  await prisma.matchEvent.createMany({ data: evs });
  await ok('artilharia: ?limit/&cursor com empates (mesmo nome e gols) = lista inteira, sem repetir', async () => {
    const full = (await call('GET', `/api/tournaments/${ST.id}/stats/scorers`)).json.ranking.map((r) => r.playerId);
    assert.strictEqual(full.length, 17);
    const got = await collect((l, c) => `/api/tournaments/${ST.id}/stats/scorers?limit=${l}` + (c ? '&cursor=' + encodeURIComponent(c) : ''), 'ranking', (r) => r.playerId, 5);
    noDup(got);
    assert.deepStrictEqual(got, full);
  });
  await ok('artilharia do esporte (/rankings/:sport/scorers): cursor percorre todos, sem repetir', async () => {
    const all = (await call('GET', '/api/tournaments/rankings/HANDBALL/scorers?limit=200')).json.scorers;
    const got = await collect((l, c) => c ? `/api/tournaments/rankings/HANDBALL/scorers?limit=${l}&cursor=${encodeURIComponent(c)}` : `/api/tournaments/rankings/HANDBALL/scorers?limit=${l}`, 'scorers', (s) => (s.userId || s.name) + '|' + s.team + '|' + s.goals + '|' + s.games, 4);
    assert.strictEqual(got.length, all.length);
  });
  for (let i = 0; i < 9; i++) {
    const u = await mkUser('rating ' + i);
    await prisma.athleteRating.create({ data: { userId: u.id, sport: RSP, rating: i < 5 ? 3.5 : 2 + i / 10, matchesCount: 2 } }); // 5 empatados em 3.5
  }
  await ok('ranking por esporte (rating): cursor (rating desc, id) sem repetir, posição contínua', async () => {
    const got = [];
    const ranks = [];
    let cur = null;
    for (let g = 0; g < 10; g++) {
      const r = await call('GET', '/api/tournaments/rankings/' + RSP + '?limit=2' + (cur ? '&cursor=' + encodeURIComponent(cur) : ''));
      r.json.ranking.forEach((x) => { got.push(x.userId); ranks.push(x.rank); });
      cur = r.json.nextCursor;
      if (!cur) break;
    }
    noDup(got);
    assert.strictEqual(got.length, 9);
    assert.deepStrictEqual(ranks, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const legacy = await call('GET', '/api/tournaments/rankings/' + RSP);
    assert.strictEqual(legacy.json.ranking.length, 9, 'sem cursor: resposta antiga');
  });
  for (let i = 0; i < 7; i++) {
    const u = await mkUser('glicko ' + i);
    await prisma.glickoRating.create({ data: { sport: GSP, format: 'SINGLES', subjectType: 'USER', subjectKey: u.id, userId: u.id, rating: 1500, rd: 60, volatility: 0.06, matches: 10 } });
  }
  await ok('ranking Glicko do Club (/api/club-ranking/:sport/rating): ?limit dá nextCursor; cursor percorre os 7 empatados sem repetir', async () => {
    const first = await call('GET', '/api/club-ranking/' + GSP + '/rating?format=SINGLES&limit=3');
    assert.strictEqual(first.json.ranking.length, 3);
    assert.ok(first.json.nextCursor);
    const got = await collect((l, c) => `/api/club-ranking/${GSP}/rating?format=SINGLES&limit=${l}` + (c ? '&cursor=' + encodeURIComponent(c) : ''), 'ranking', (x) => x.key, 3);
    noDup(got);
    assert.strictEqual(got.length, 7);
    const old = await call('GET', '/api/club-ranking/' + GSP + '/rating?format=SINGLES');
    assert.strictEqual(old.json.ranking.length, 7, 'sem limit: resposta antiga');
  });

  // ================================================================ h. card do beach tennis (dados reais)
  console.log('  — h. card do atleta (raquete)');
  const BT = await prisma.tournament.create({ data: { slug: 'f5-bt-' + RUN, name: 'Beach F5 ' + RUN, sport: 'BEACH_TENNIS', isDoubles: true, ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const bcat = await prisma.tournamentCategory.create({ data: { tournamentId: BT.id, name: 'Duplas' } });
  const partner = await mkUser('parceiro');
  const bE1 = await prisma.tournamentEntry.create({ data: { tournamentId: BT.id, categoryId: bcat.id, name: 'Dupla 1', status: 'CONFIRMED' } });
  const bE2 = await prisma.tournamentEntry.create({ data: { tournamentId: BT.id, categoryId: bcat.id, name: 'Dupla 2', status: 'CONFIRMED' } });
  await prisma.entryMember.createMany({ data: [{ entryId: bE1.id, userId: U.beach.id }, { entryId: bE2.id, userId: partner.id }] });
  for (let i = 0; i < 4; i++) await prisma.tournamentMatch.create({ data: { tournamentId: BT.id, categoryId: bcat.id, stage: 'LEAGUE', round: i + 1, homeEntryId: bE1.id, awayEntryId: bE2.id, status: 'FINISHED', homeScore: i < 3 ? 2 : 0, awayScore: i < 3 ? 0 : 2, winnerEntryId: i < 3 ? bE1.id : bE2.id } });
  const checkBeachCard = async () => {
    const r = await call('GET', `/api/tournaments/athletes/${U.beach.username}/card`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.mainSport, 'BEACH_TENNIS');
    const labels = r.json.statCells.map((c) => c.label);
    assert.ok(!labels.includes('Gols') && !labels.includes('Assist.'), 'beach tennis com GOLS: ' + labels);
    assert.ok(labels.includes('Aproveit.'));
    assert.strictEqual(r.json.statCells.find((c) => c.key === 'winRate').value, '75%');
    const out = await art.buildArt('club', 'atleta', { handle: U.beach.username, formato: 'story' }, {});
    assert.ok(out && out.png && out.png.length > 1000, 'arte gerada');
  };
  await ok('card do atleta de beach tennis: sem "Gols"/"Assist.", com aproveitamento (JSON + arte gera)', checkBeachCard);

  // ================================================================ g. limites do plano
  console.log('  — g. limites do plano grátis');
  const savedEnv = {};
  const setEnv = (k, v) => { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v; };
  setEnv('LIGA_FREE_ACTIVE_TOURNAMENTS', '2');
  setEnv('LIGA_FREE_CATEGORIES_PER_TOURNAMENT', '2');
  setEnv('LIGA_FREE_TEAMS_PER_CATEGORY', '3');
  setEnv('LIGA_FREE_POSTS_PER_MONTH', '2');
  setEnv('LIGA_FREE_IMAGES_PER_MONTH', '1');
  const P = U.planner;
  let PT1 = null;
  const checkTournamentLimit = async () => {
    const a = await call('POST', '/api/tournaments', { token: tok(P), body: { name: 'Plano 1 ' + RUN, sport: 'FUTSAL' } });
    const b = await call('POST', '/api/tournaments', { token: tok(P), body: { name: 'Plano 2 ' + RUN, sport: 'FUTSAL' } });
    assert.strictEqual(a.status, 201, a.text);
    assert.strictEqual(b.status, 201, b.text);
    PT1 = a.json;
    const c = await call('POST', '/api/tournaments', { token: tok(P), body: { name: 'Plano 3 ' + RUN, sport: 'FUTSAL' } });
    assert.strictEqual(c.status, 402, c.text);
    assert.ok(/^Limite do plano grátis: até 2 torneios ativos/.test(c.json.error), c.json.error);
    assert.strictEqual(c.json.code, 'PLAN_LIMIT');
    const q = await call('POST', '/api/tournaments/quick', { token: tok(P), body: { sport: 'FUTSAL', preset: 'liga-pontos-corridos', teams: ['A', 'B', 'C', 'D'] } });
    assert.strictEqual(q.status, 402, '/quick também respeita o limite: ' + q.text);
  };
  await ok('torneios ativos: a 1ª criação acima do limite = 402 em PT (rota normal e /quick)', checkTournamentLimit);
  await ok('sem retroatividade: torneios antigos (antes de LIGA_PLAN_START) e o Master Cup não contam nos ativos', async () => {
    const old = await mkUser('organizador antigo');
    for (let i = 0; i < 3; i++) await prisma.tournament.create({ data: { slug: 'f5-velho-' + RUN + '-' + i, name: 'Velho ' + i, sport: 'FUTSAL', ownerId: old.id, status: 'ONGOING', createdAt: new Date('2019-01-01T00:00:00Z') } });
    const r = await call('POST', '/api/tournaments', { token: tok(old), body: { name: 'Novo do antigo ' + RUN, sport: 'FUTSAL' } });
    assert.strictEqual(r.status, 201, r.text);
  });
  await ok('admin/equipe não tem limite (cria além do limite, /me/plan unlimited)', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', '/api/tournaments', { token: tok(U.staff), body: { name: 'Equipe ' + i + ' ' + RUN, sport: 'FUTSAL' } });
      assert.strictEqual(r.status, 201, r.text);
    }
    const pl = await call('GET', '/api/tournaments/me/plan', { token: tok(U.staff) });
    assert.strictEqual(pl.json.unlimited, true);
  });
  await ok('dado antigo não bloqueia: com mais torneios que o limite, editar e lançar seguem funcionando', async () => {
    const r = await call('PATCH', `/api/tournaments/${PT1.id}`, { token: tok(P), body: { name: 'Plano 1 editado ' + RUN } });
    assert.strictEqual(r.status, 200, r.text);
    // organizador antigo com 4 torneios ativos (gravados antes) ainda edita os dele
    const old = await prisma.tournament.findMany({ where: { ownerId: U.org.id, archivedAt: null }, select: { id: true } });
    assert.ok(old.length > 2);
    const e = await call('PATCH', `/api/tournaments/${T.id}`, { token: tok(U.org), body: { description: 'segue editando' } });
    assert.strictEqual(e.status, 200, e.text);
  });
  await ok('categorias por torneio: 3ª = 402 (também para o coordenador); admin cria; torneio criado antes dos planos não é limitado', async () => {
    await prisma.tournamentRole.create({ data: { tournamentId: PT1.id, userId: U.coord.id, role: 'COORDINATOR' } });
    const c1 = await call('POST', `/api/tournaments/${PT1.id}/categories`, { token: tok(P), body: { name: 'C1' } });
    const c2 = await call('POST', `/api/tournaments/${PT1.id}/categories`, { token: tok(U.coord), body: { name: 'C2' } });
    assert.strictEqual(c1.status, 201, c1.text);
    assert.strictEqual(c2.status, 201, c2.text);
    const c3 = await call('POST', `/api/tournaments/${PT1.id}/categories`, { token: tok(U.coord), body: { name: 'C3' } });
    assert.strictEqual(c3.status, 402, c3.text);
    assert.ok(/categorias por torneio/.test(c3.json.error));
    const c4 = await call('POST', `/api/tournaments/${PT1.id}/categories`, { token: tok(U.staff), body: { name: 'C4 equipe' } });
    assert.strictEqual(c4.status, 201, 'admin global sem limite');
    await prisma.tournament.update({ where: { id: PT1.id }, data: { createdAt: new Date('2019-06-01T00:00:00Z') } });
    const c5 = await call('POST', `/api/tournaments/${PT1.id}/categories`, { token: tok(P), body: { name: 'C5 antigo' } });
    assert.strictEqual(c5.status, 201, 'torneio anterior aos planos: sem limite por torneio');
    await prisma.tournament.update({ where: { id: PT1.id }, data: { createdAt: new Date() } });
  });
  await ok('times por categoria: 4º time inscrito pelo organizador = 402', async () => {
    const cid = (await prisma.tournamentCategory.findFirst({ where: { tournamentId: PT1.id, name: 'C1' } })).id;
    for (let i = 1; i <= 3; i++) {
      const r = await call('POST', `/api/tournaments/${PT1.id}/entries`, { token: tok(P), body: { categoryId: cid, team: true, name: 'Time ' + i + ' ' + RUN } });
      assert.strictEqual(r.status, 201, r.text);
    }
    const r4 = await call('POST', `/api/tournaments/${PT1.id}/entries`, { token: tok(P), body: { categoryId: cid, team: true, name: 'Time 4 ' + RUN } });
    assert.strictEqual(r4.status, 402, r4.text);
    assert.ok(/até 3 times por categoria/.test(r4.json.error));
  });
  await ok('avisos por mês: 3º = 402; imagens por mês: 2ª imagem nova = 402', async () => {
    for (let i = 0; i < 2; i++) assert.strictEqual((await call('POST', `/api/tournaments/${PT1.id}/posts`, { token: tok(P), body: { body: 'aviso ' + i } })).status, 201);
    const p3 = await call('POST', `/api/tournaments/${PT1.id}/posts`, { token: tok(P), body: { body: 'aviso 3' } });
    assert.strictEqual(p3.status, 402, p3.text);
    assert.ok(/avisos no mural por mês/.test(p3.json.error));
    const i1 = await call('PATCH', `/api/tournaments/${PT1.id}`, { token: tok(P), body: { bannerUrl: await pngDataUri(11, 22, 33) } });
    assert.strictEqual(i1.status, 200, i1.text);
    const i2 = await call('PATCH', `/api/tournaments/${PT1.id}`, { token: tok(P), body: { bannerUrl: await pngDataUri(44, 55, 66) } });
    assert.strictEqual(i2.status, 402, i2.text);
    assert.ok(/imagens enviadas por mês/.test(i2.json.error));
    const link = await call('PATCH', `/api/tournaments/${PT1.id}`, { token: tok(P), body: { bannerUrl: 'https://exemplo.com.br/x.png' } });
    assert.strictEqual(link.status, 200, 'link https não conta como imagem enviada');
  });
  await ok('GET /me/plan: uso × limite (sem preço) para o organizador', async () => {
    const r = await call('GET', '/api/tournaments/me/plan', { token: tok(P) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.plan.key, 'free');
    assert.strictEqual(r.json.plan.priceCents, null);
    assert.strictEqual(r.json.limits.activeTournaments, 2);
    assert.strictEqual(r.json.usage.activeTournaments, 2);
    assert.strictEqual(r.json.usage.postsPerMonth, 2);
    assert.strictEqual(r.json.usage.imagesPerMonth, 1);
    assert.strictEqual(r.json.unlimited, false);
    assert.strictEqual((await call('GET', '/api/tournaments/me/plan')).status, 401);
  });
  await ok('torneio da lista de exclusão (Master Cup) não é limitado (dono comum cria categoria além do limite)', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', `/api/tournaments/${MC.id}/categories`, { token: tok(U.mcOwner), body: { name: 'MC extra ' + i + ' ' + RUN } });
      assert.strictEqual(r.status, 201, r.text);
    }
  });

  // ================================================================ PROVA DE SABOTAGEM
  console.log('  — prova de sabotagem');
  await sabotage('JSON sem o middleware de mídia (LIGA_MEDIA_JSON=0) → varredura acha base64',
    () => { process.env.LIGA_MEDIA_JSON = '0'; }, scanNoBase64, () => { delete process.env.LIGA_MEDIA_JSON; });
  const origCheck = plans.check;
  await sabotage('limite do plano desligado (check sempre libera) → teste do limite de torneio pega',
    async () => { plans.check = async () => null; await prisma.tournament.updateMany({ where: { ownerId: P.id }, data: { archivedAt: new Date() } }); },
    checkTournamentLimit,
    async () => { plans.check = origCheck; await prisma.tournament.updateMany({ where: { ownerId: P.id }, data: { status: 'FINISHED' } }); });
  const origKey = pag.keysetWhere;
  await sabotage('cursor ignorado (keysetWhere devolve tudo) → paginação acha duplicado',
    () => { pag.keysetWhere = () => null; }, checkPostsPaging, () => { pag.keysetWhere = origKey; });
  const origEx = clubIdentity.excludedSlugs;
  await sabotage('migração sem a lista de exclusão → o Master Cup entraria na conta',
    () => { clubIdentity.excludedSlugs = () => new Set(); },
    async () => { const rep = await mig.run(prisma, { apply: false }); assert.ok(rep.keptExcluded >= 5, 'Master Cup fora: ' + rep.keptExcluded); },
    () => { clubIdentity.excludedSlugs = origEx; });
  const origFam = cardStats.familyOf;
  await sabotage('card sem adaptar ao esporte (familyOf = gols) → beach tennis com "Gols" é pego',
    () => { cardStats.familyOf = () => 'goals'; }, checkBeachCard, () => { cardStats.familyOf = origFam; });
  const origServe = mediaStore.serveMedia;
  await sabotage('/media sem cabeçalho de segurança (sem nosniff/immutable) → teste de cabeçalhos pega',
    () => {
      const routeLayer = app._router.stack.find((l) => l.route && l.route.path === '/media/:file' && l.route.methods.get);
      routeLayer.route.stack[0].handle = async (req, res) => { const row = await mediaStore.get(req.params.file.slice(0, 64)); res.type(row.mime).send(Buffer.from(row.bytes)); };
    },
    checkMediaHeaders,
    () => { const routeLayer = app._router.stack.find((l) => l.route && l.route.path === '/media/:file' && l.route.methods.get); routeLayer.route.stack[0].handle = origServe; });
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // ================================================================ i. app real
  console.log('  — i. app real (src/index.js)');
  const PORT = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, WA_BRIDGE_KEY: '', PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', TREG_SWEEPER: 'off', RNA_ATIVA: '0', RNA_RELOGIO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });
  const page = (p, h = {}) => httpCall('GET', `http://127.0.0.1:${PORT}${p}`, h);
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await page('/api/health'); up = r.status === 200 || r.status === 503; } catch (_) {}
  }
  if (!up) {
    skip('app real', 'app não subiu: ' + childOut.slice(-400));
  } else {
    await ok('/media no app real (helmet + compressão): cabeçalhos certos e CORP cross-origin', async () => {
      const r = await page(mediaUrl, { 'Accept-Encoding': 'gzip' });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['content-type'], 'image/png');
      assert.strictEqual(r.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(r.headers['cross-origin-resource-policy'], 'cross-origin');
      assert.ok(!r.headers['content-encoding'], 'PNG não é recomprimido');
      assert.strictEqual((await page(mediaUrl.replace('.png', '.svg'))).status, 404);
    });
    await ok('/atleta de beach tennis: sem "Gols"/"Assist." no card, com "Aproveit."; foto antiga não vai em base64 no HTML', async () => {
      const r = await page('/atleta/' + U.beach.username);
      assert.strictEqual(r.status, 200);
      assert.ok(/Aproveit\./.test(r.text));
      assert.ok(!/<div class="sc-l">Gols<\/div>/.test(r.text) && !/<div class="sc-l">Assist\.<\/div>/.test(r.text));
      const f = await page('/atleta/' + U.fut.username);
      assert.ok(/<div class="sc-l">Gols<\/div>/.test(f.text), 'futsal continua com Gols');
      assert.ok(!/data:image/.test(f.text), 'avatar antigo virou /media no HTML');
    });
    await ok('/t/:slug: mural com 20 + "Ver mais avisos" (cursor) e banner sem base64', async () => {
      const r = await page('/t/' + PT.slug);
      assert.strictEqual(r.status, 200);
      assert.ok(/data-testid="mural-more"/.test(r.text) && /data-cursor="[A-Za-z0-9_-]+"/.test(r.text));
      assert.strictEqual((r.text.match(/class="post"/g) || []).length, 20);
      const l = await page('/t/' + LT.slug);
      assert.ok(/<img class="logo" src="\/media\/[a-f0-9]{64}\.png"/.test(l.text) && !/src="data:/.test(l.text), 'banner antigo vira /media');
      assert.ok(/fetchMatches/.test(l.text), 'jogos seguem o cursor quando a categoria é grande');
    });
    await ok('JSON pelo app real também sem base64 (torneio antigo)', async () => {
      const r = await page(`/api/tournaments/${LT.id}/entries`);
      assert.strictEqual(r.status, 200);
      assert.ok(!/data:image/.test(r.text));
    });
  }
  child.kill();
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F5 — arquivos e desempenho: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exit(failed ? 1 : 0);
  });
