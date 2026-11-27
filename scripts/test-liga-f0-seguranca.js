'use strict';
process.env.LIGA_MEDIA_JSON_START = process.env.LIGA_MEDIA_JSON_START || '2020-01-01T00:00:00Z';
// =====================================================================
// Liga Aberta — FASE 0 (segurança). Roda com: npm run test:liga-f0
//
// Parte 1 (sem banco, sempre roda):
//   - boot sem JWT_SECRET em produção falha; com segredo sobe; dev = aleatório
//   - imageGuard: aceita PNG/JPEG/WEBP reais; recusa SVG, arquivo falso com
//     prefixo de imagem, dimensão gigante, URL perigosa; encolhe o que passa do limite
//   - rotas temporárias sem segredo em texto; comparação por hash
//   - limitador devolve 429 em JSON, em português, contado por usuário
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   - cadastro de atleta: sem código / código errado / expirado / tentativas
//     esgotadas = recusado; código certo = conta + token; 6º código/hora = 429
//   - inscrição: usuário comum não inscreve em torneio fechado nem terceiros;
//     fundador/coordenador/admin inscrevem; comum entra PENDING só a si/ao próprio time
//   - importação do Futsal Master Cup só admin global
//   - /api/_loopview: sem login 401, não-admin 403, admin passa
//   - uploads (logo, patrocinador, escudo, banner) passam pelo imageGuard
//   - limitador de criação de torneio devolve 429
// Sem DATABASE_URL local a Parte 2 é PULADA (e avisa). Nunca roda contra produção.
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
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
    console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
}
function skip(name, why) {
  skipped++;
  console.log('  ⏭️  ' + name + ' — PULADO: ' + why);
}
const silent = { warn() {} };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// HTTP sem keep-alive (fetch/undici deixa socket aberto e, no Windows, o
// process.exit aborta com assert do libuv).
function httpCall(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers, Connection: 'close' };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request(url, { method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function bootEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['RAILWAY_ENVIRONMENT', 'RAILWAY_ENVIRONMENT_NAME']) if (!(k in extra)) delete env[k];
  return env;
}

async function main() {
  // ------------------------------------------------------------------
  console.log('1. Segredo do JWT');
  const { resolveJwtSecret, isProductionEnv } = require('../src/services/jwtSecret');
  await ok('produção (NODE_ENV) sem JWT_SECRET → erro', () => {
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production' }, silent), /JWT_SECRET não definido em produção/);
    assert.throws(() => resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: '   ' }, silent), /JWT_SECRET/);
  });
  await ok('Railway (RAILWAY_ENVIRONMENT) sem JWT_SECRET → erro', () => {
    assert.ok(isProductionEnv({ RAILWAY_ENVIRONMENT: 'production' }));
    assert.throws(() => resolveJwtSecret({ RAILWAY_ENVIRONMENT: 'production' }, silent), /JWT_SECRET/);
  });
  await ok('produção com JWT_SECRET usa o valor configurado', () => {
    assert.strictEqual(resolveJwtSecret({ NODE_ENV: 'production', JWT_SECRET: 'segredo-longo-de-teste-123' }, silent), 'segredo-longo-de-teste-123');
  });
  await ok('fora de produção: segredo aleatório por processo + aviso', () => {
    const warns = [];
    const a = resolveJwtSecret({}, { warn: (m) => warns.push(m) });
    const b = resolveJwtSecret({}, silent);
    assert.ok(/^[0-9a-f]{96}$/.test(a));
    assert.notStrictEqual(a, b);
    assert.ok(warns.some((w) => /aleatório/.test(w)));
  });
  await ok('BOOT: require(middleware) em produção sem JWT_SECRET sai com erro', () => {
    const r = spawnSync(process.execPath, ['-e', "require('./src/middleware'); process.exit(0)"], { cwd: ROOT, env: bootEnv({ NODE_ENV: 'production', JWT_SECRET: '' }), encoding: 'utf8', timeout: 60000 });
    assert.notStrictEqual(r.status, 0, 'deveria falhar');
    assert.match(r.stderr, /JWT_SECRET não definido em produção/);
  });
  await ok('BOOT: com JWT_SECRET em produção o middleware carrega', () => {
    const r = spawnSync(process.execPath, ['-e', "require('./src/middleware'); process.exit(0)"], { cwd: ROOT, env: bootEnv({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }), encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
  });
  await ok('sem segredo padrão no código (middleware e mf.js usam o mesmo)', () => {
    const mw = read('src/middleware.js');
    assert.ok(!mw.includes('teniscash-secret-change-in-production'));
    const mf = read('src/routes/mf.js');
    assert.ok(!/process\.env\.JWT_SECRET\s*\|\|/.test(mf), 'mf.js não pode ter padrão próprio');
    assert.ok(/JWT_SECRET\s*}\s*=\s*require\('\.\.\/middleware'\)/.test(mf), 'mf.js importa do middleware');
  });

  // ------------------------------------------------------------------
  console.log('2. imageGuard (validação real de imagem)');
  const sharp = require('sharp');
  const ig = require('../src/services/imageGuard');
  const solid = (w, h, color = '#E5571E') => sharp({ create: { width: w, height: h, channels: 3, background: color } });
  const uri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;
  const PNG = uri('image/png', await solid(32, 32).png().toBuffer());
  const JPG = uri('image/jpeg', await solid(32, 32).jpeg().toBuffer());
  const WEBP = uri('image/webp', await solid(32, 32).webp().toBuffer());
  const SVG = uri('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>'));
  const FAKE_PREFIX = 'data:image/png;base64,iVBORw0KGgo=';
  const FAKE_TEXT = uri('image/png', Buffer.from('<script>alert(1)</script> isto não é imagem nenhuma'));
  const FAKE_HEADER = uri('image/png', Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(300)]));
  const GIANT = uri('image/png', await solid(4097, 8).png().toBuffer());

  await ok('aceita PNG, JPEG e WEBP reais (mesmo formato na saída)', async () => {
    for (const [src, mime] of [[PNG, 'image/png'], [JPG, 'image/jpeg'], [WEBP, 'image/webp']]) {
      const r = await ig.guardImageDataUri(src, { maxChars: 200000 });
      assert.strictEqual(r.mime, mime);
      assert.ok(r.dataUri.startsWith(`data:${mime};base64,`));
      assert.strictEqual(r.width, 32);
    }
  });
  const rejects = async (value, rx, opts) => {
    await assert.rejects(() => ig.guardImageDataUri(value, opts || { maxChars: 200000 }), (e) => e instanceof ig.ImageGuardError && rx.test(e.message));
  };
  await ok('recusa SVG', () => rejects(SVG, /SVG/));
  await ok('recusa arquivo falso só com o prefixo/assinatura de PNG', async () => {
    await rejects(FAKE_PREFIX, /PNG, JPEG ou WEBP|corrompida/);
    await rejects(FAKE_TEXT, /PNG, JPEG ou WEBP/);
    await rejects(FAKE_HEADER, /corrompida/);
  });
  await ok('recusa dimensão acima de 4096 px', () => rejects(GIANT, /4096/));
  await ok('recusa data URI que não é imagem', () => rejects(uri('text/html', Buffer.from('<b>x</b>')), /imagem/));
  await ok('encolhe/reencoda imagem pesada até caber no limite da rota', async () => {
    const noise = await sharp(crypto.randomBytes(1200 * 1200 * 3), { raw: { width: 1200, height: 1200, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const big = uri('image/jpeg', noise);
    assert.ok(big.length > 200000);
    const r = await ig.guardImageDataUri(big, { maxChars: 200000 });
    assert.ok(r.resized && r.dataUri.length <= 200000 && r.width < 1200, `saiu ${r.dataUri.length} chars ${r.width}px`);
  });
  await ok('URL: só https:// ou caminho do próprio site', () => {
    assert.strictEqual(ig.guardImageUrl('https://exemplo.com/logo.png'), 'https://exemplo.com/logo.png');
    assert.strictEqual(ig.guardImageUrl('/img/futsal-master-cup.png'), '/img/futsal-master-cup.png');
    for (const bad of ['javascript:alert(1)', 'http://exemplo.com/a.png', '//evil.com/a.png', 'data:text/html;base64,PHNjcmlwdD4=', 'https://x.com/a.png" onerror="alert(1)', 'vbscript:x']) {
      assert.throws(() => ig.guardImageUrl(bad), ig.ImageGuardError, bad);
    }
    assert.throws(() => ig.guardImageUrl('/img/x.png', { allowRelative: false }), ig.ImageGuardError);
  });
  await ok('guardImageField: vazio limpa; data: valida; link valida', async () => {
    assert.strictEqual(await ig.guardImageField(null), null);
    assert.strictEqual(await ig.guardImageField('  '), null);
    assert.ok((await ig.guardImageField(PNG)).startsWith('data:image/png'));
    await assert.rejects(() => ig.guardImageField('javascript:alert(1)'), ig.ImageGuardError);
  });

  // ------------------------------------------------------------------
  console.log('3. Rotas temporárias sem segredo em texto');
  const { matchesSecretHash, sha256Hex } = require('../src/services/secretGuard');
  await ok('comparação por sha256 em tempo constante (+ rotação por variável)', () => {
    const h = sha256Hex('valor-de-teste');
    assert.strictEqual(matchesSecretHash('valor-de-teste', h), true);
    assert.strictEqual(matchesSecretHash('outro', h), false);
    assert.strictEqual(matchesSecretHash('', h), false);
    assert.strictEqual(matchesSecretHash(undefined, h), false);
    process.env.ROUTE_GUARD_TESTE_F0 = 'novo-segredo';
    assert.strictEqual(matchesSecretHash('valor-de-teste', h, 'ROUTE_GUARD_TESTE_F0'), false, 'o antigo deixa de valer');
    assert.strictEqual(matchesSecretHash('novo-segredo', h, 'ROUTE_GUARD_TESTE_F0'), true);
    delete process.env.ROUTE_GUARD_TESTE_F0;
  });
  await ok('I4: segredos antigos (vazados) não valem mais — só os hashes novos ficam no código', () => {
    const src = ['src/index.js', 'src/routes/aiCuration.js', 'src/routes/catalogEngine.js', '.github/workflows/fiscal-diag.yml'].map(read).join(' ');
    for (const oldHash of ['ca5dbc3282688211', '59d0a72e89cae415', '9c358aac1c62e30f', '0993d4b3f72b41c9']) assert.ok(!src.includes(oldHash), 'hash antigo ainda no código: ' + oldHash);
    for (const newHash of ['9e2c74b63e8ccc15', 'c0cd2431ff0b0c03', '28eb28fc7d72bb8b', '6cd67e29c025dcee']) assert.ok(src.includes(newHash), 'hash novo ausente: ' + newHash);
    assert.ok(!/[?&]g=[a-z0-9_]{6,}/i.test(read('.github/workflows/fiscal-diag.yml')), 'workflow não carrega segredo em texto');
  });
  await ok('I4: rota guardada aceita o segredo da env ROUTE_GUARD_* e recusa outro (404)', async () => {
    const { pull2026ColHandler } = require('../src/routes/aiCuration');
    const run = (g) => new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; } };
      Promise.resolve(pull2026ColHandler({ query: { g }, body: {} }, res)).catch((e) => resolve({ status: 'erro', body: e.message }));
    });
    process.env.ROUTE_GUARD_PX2026COL = 'valor-de-teste-f0';
    try {
      assert.strictEqual((await run('outro')).status, 404);
      assert.strictEqual((await run('')).status, 404);
      assert.notStrictEqual((await run('valor-de-teste-f0')).status, 404);
    } finally { delete process.env.ROUTE_GUARD_PX2026COL; }
  });
  await ok('nenhuma comparação ?g= com texto fixo e loop.html sem segredo', () => {
    const idx = read('src/index.js');
    assert.ok(!/req\.query\.g\s*!==\s*'/.test(idx), 'index.js ainda compara ?g= com texto');
    assert.ok(!/req\.query\.g\s*!==\s*[A-Z_]+_GUARD\b/.test(read('src/routes/aiCuration.js')));
    assert.ok(!/req\.query\.g\s*!==\s*[A-Z_]+_GUARD\b/.test(read('src/routes/catalogEngine.js')));
    const loop = read('public/loop.html');
    assert.ok(!/_loopview\?g=/.test(loop), 'loop.html não pode carregar segredo');
    assert.ok(/tc_admin_token/.test(loop), 'loop.html manda o token do admin');
    assert.ok(/loopViewChain/.test(idx), '/api/_loopview passa por authMiddleware + adminMiddleware');
  });

  // ------------------------------------------------------------------
  console.log('4. Limitador (429 em JSON, por usuário)');
  const express = require('express');
  const { make } = require('../src/services/ligaRateLimit');
  await ok('3ª chamada com max=2 → 429 JSON em português; outro usuário não é afetado', async () => {
    const app = express();
    app.use((req, _res, next) => { req.userId = req.headers['x-user'] || null; next(); });
    app.post('/x', make({ max: 2, message: 'Muitas tentativas. Aguarde.' }), (req, res) => res.json({ ok: true }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const port = server.address().port;
    const hit = (user) => httpCall('POST', `http://127.0.0.1:${port}/x`, { 'x-user': user });
    assert.strictEqual((await hit('a')).status, 200);
    assert.strictEqual((await hit('a')).status, 200);
    const third = await hit('a');
    assert.strictEqual(third.status, 429);
    const j = third.json;
    assert.strictEqual(j.error, 'Muitas tentativas. Aguarde.');
    assert.strictEqual((await hit('b')).status, 200, 'contagem é por usuário');
    await new Promise((r) => server.close(r));
  });

  await ok('I1: chave de IP usa cf-connecting-ip válido; inválido cai no req.ip; IPv6 agrupa por /64', () => {
    const { ipKey } = require('../src/services/ligaRateLimit');
    const k = (h, ip) => ipKey({ headers: h, ip });
    assert.strictEqual(k({ 'cf-connecting-ip': '200.10.20.30' }, '172.70.1.1'), '200.10.20.30');
    assert.strictEqual(k({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }, '172.70.1.1'), '172.70.1.1', 'valor inválido é ignorado');
    assert.strictEqual(k({ 'cf-connecting-ip': '<script>' }, '172.70.1.1'), '172.70.1.1');
    assert.strictEqual(k({}, '::ffff:10.0.0.9'), '10.0.0.9');
    const a = k({ 'cf-connecting-ip': '2804:14c:5b8:8e00:aaaa:bbbb:cccc:dddd' }, 'x');
    const b = k({ 'cf-connecting-ip': '2804:14c:5b8:8e00::1' }, 'x');
    const c = k({ 'cf-connecting-ip': '2804:14c:5b8:8e01::1' }, 'x');
    assert.strictEqual(a, '2804:14c:5b8:8e00::/64');
    assert.strictEqual(a, b, 'mesmo /64 = mesma chave');
    assert.notStrictEqual(a, c, '/64 vizinho = outra chave');
  });
  await ok('I2: telefone com e sem 55 = mesma chave do limitador (formato do envio)', () => {
    const { phoneFromBody } = require('../src/services/ligaRateLimit');
    const { formatPhoneBR } = require('../src/services/phoneBR');
    const k = (v) => phoneFromBody({ body: { whatsapp: v } });
    assert.strictEqual(k('83999990000'), '5583999990000');
    assert.strictEqual(k('+55 (83) 99999-0000'), '5583999990000');
    assert.strictEqual(k('5583999990000'), formatPhoneBR('83 99999-0000'));
    assert.strictEqual(require('../src/whatsapp').formatPhoneBR, formatPhoneBR, 'o envio usa a mesma função');
  });

  // ------------------------------------------------------------------
  console.log('5. Rotas com banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('cadastro com código, inscrição, import, _loopview, uploads, limitador real', 'DATABASE_URL local (localhost) não definido');
    return;
  }
  await dbSuite(PNG, JPG, WEBP, SVG, FAKE_PREFIX);
}

async function dbSuite(PNG, JPG, WEBP, SVG, FAKE_PREFIX) {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f0-' + crypto.randomBytes(8).toString('hex');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { prisma, JWT_SECRET } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const signupCode = require('../src/services/athleteSignupCode');
  await ensureApexSchema(prisma);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/tournaments', require('../src/routes/tournamentMedia').apiRouter);
  app.use('/api/public', require('../src/routes/tournamentMedia').publicRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use(require('../src/routes/tournamentRegistration'));
  app.use('/api/clubs', require('../src/routes/clubs'));
  app.get('/api/_loopview', ...require('../src/routes/loopView').loopViewChain);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Cada chamada sai de um "IP" diferente (cf-connecting-ip) para os limitadores
  // por IP não se misturarem entre os testes; quem quer testar IP passa `ip`.
  let ipSeq = 0;
  function call(method, url, { token, body, ip } = {}) {
    const headers = { 'cf-connecting-ip': ip || `198.51.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}` };
    if (token) headers.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, headers, body);
  }
  const RUN = Date.now().toString(36);
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  let phoneSeq = 0;
  const phone = () => '839' + phoneBase + String(++phoneSeq % 1000).padStart(3, '0');
  const mkUser = (role, extra = {}) => prisma.user.create({ data: { name: `F0 ${role || 'user'} ${RUN}-${++seq}`, phone: phone(), pin: 'x', ...(role ? { role } : {}), ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const N = (p) => signupCode.normalizePhone(p); // formato do envio (55+DDD+número)

  // ---------------- cadastro com código ----------------
  const sent = [];
  const okSender = (ph, code) => { sent.push({ phone: ph, code }); return { success: true, provider: 'teste' }; };
  signupCode.setSenderForTests(okSender);
  const lastCode = (ph) => { const x = [...sent].reverse().find((s) => s.phone === N(ph)); return x && x.code; };
  const reg = (body, opts = {}) => call('POST', '/api/tournaments/athletes/register', { body, ...opts });
  const start = (whatsapp, opts = {}) => call('POST', '/api/tournaments/athletes/register/start', { body: { whatsapp }, ...opts });

  console.log('  — cadastro de atleta com código no WhatsApp');
  await ok('start sem telefone → 400', async () => {
    assert.strictEqual((await start('')).status, 400);
  });
  await ok('I2: telefone que JÁ tem conta → mesma resposta 200 genérica, sem código; o 409 só no passo final', async () => {
    const u = await mkUser();
    const novo = phone();
    const a = await start(u.phone);
    const b = await start(novo);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    assert.deepStrictEqual(Object.keys(a.json).sort(), Object.keys(b.json).sort());
    assert.strictEqual(a.json.message, b.json.message);
    assert.strictEqual(lastCode(u.phone), undefined, 'conta existente não recebe código');
    assert.strictEqual((await start('55' + u.phone)).status, 200, 'com 55 também não revela');
    const r = await reg({ name: 'Já Tem', whatsapp: u.phone, password: '1234', code: '123456' });
    assert.strictEqual(r.status, 409);
  });
  const P1 = phone();
  await ok('start manda código de 6 dígitos; banco guarda só o hash, no formato 55+DDD+número', async () => {
    const r = await start(P1);
    assert.strictEqual(r.status, 200, r.text);
    const code = lastCode(P1);
    assert.ok(/^\d{6}$/.test(code));
    const row = await prisma.athleteSignupCode.findFirst({ where: { phone: N(P1) }, orderBy: { createdAt: 'desc' } });
    assert.ok(row && /^[0-9a-f]{64}$/.test(row.codeHash) && !row.codeHash.includes(code));
    assert.strictEqual(row.phone, '55' + P1);
    assert.ok(row.expiresAt.getTime() - Date.now() <= 10 * 60 * 1000 + 1000);
  });
  await ok('cadastro SEM código → recusado (nenhuma conta criada)', async () => {
    const r = await reg({ name: 'Ana F0', whatsapp: P1, password: '1234' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json.needsCode, true);
    assert.strictEqual(await prisma.user.count({ where: { phone: P1 } }), 0);
  });
  await ok('cadastro com código ERRADO → recusado', async () => {
    const wrong = lastCode(P1) === '000000' ? '111111' : '000000';
    const r = await reg({ name: 'Ana F0', whatsapp: P1, password: '1234', code: wrong });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /incorreto/);
    assert.strictEqual(await prisma.user.count({ where: { phone: P1 } }), 0);
  });
  await ok('foto falsa (prefixo PNG) é recusada antes de gastar o código', async () => {
    const r = await reg({ name: 'Ana F0', whatsapp: P1, password: '1234', code: lastCode(P1), photo: FAKE_PREFIX });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(await prisma.user.count({ where: { phone: P1 } }), 0);
  });
  await ok('I2: código pedido SEM 55 vale no cadastro COM 55 → conta + token (foto real reencodada)', async () => {
    const r = await reg({ name: 'Ana F0', whatsapp: '+55 ' + P1, password: '1234', code: lastCode(P1), photo: PNG });
    assert.strictEqual(r.status, 201, r.text);
    const d = jwt.verify(r.json.token, JWT_SECRET);
    const u = await prisma.user.findUnique({ where: { phone: P1 } });
    assert.ok(u && d.userId === u.id, 'conta gravada no formato nacional');
    assert.strictEqual(r.json.photoSource, 'upload');
    const prof = await prisma.athleteProfile.findUnique({ where: { userId: u.id } });
    // Liga F5: a foto (já reencodada pelo imageGuard) fica no mediaStore — o perfil guarda /media/<sha>.png
    assert.ok(/^\/media\/[a-f0-9]{64}\.png$/.test(prof.avatarUrl), prof.avatarUrl);
  });
  await ok('M6: @ do Instagram já usado → conta nasce sem @ (usernameTaken), com token', async () => {
    const handle = 'f0handle' + RUN;
    await mkUser(null, { username: handle });
    const P = phone();
    await start(P);
    const r = await reg({ name: 'Igor F0', whatsapp: P, password: '1234', code: lastCode(P), instagram: '@' + handle });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.usernameTaken, true);
    assert.strictEqual(r.json.user.username, null);
    assert.ok(r.json.token);
  });
  await ok('código é de uso único', async () => {
    const P = phone();
    await start(P);
    const c = lastCode(P);
    assert.strictEqual((await signupCode.consumeSignupCode(N(P), c)).ok, true);
    assert.strictEqual((await signupCode.consumeSignupCode(N(P), c)).ok, false);
  });
  await ok('5 tentativas erradas esgotam o código (o certo depois não vale)', async () => {
    const P = phone();
    await start(P);
    const c = lastCode(P);
    const wrong = c === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.strictEqual((await reg({ name: 'Bia F0', whatsapp: P, password: '1234', code: wrong })).status, 400);
    const r = await reg({ name: 'Bia F0', whatsapp: P, password: '1234', code: c });
    assert.ok([400, 429].includes(r.status), String(r.status));
    assert.strictEqual(await prisma.user.count({ where: { phone: P } }), 0);
  });
  await ok('código expirado → recusado', async () => {
    const P = phone();
    await start(P);
    await prisma.athleteSignupCode.updateMany({ where: { phone: N(P) }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await reg({ name: 'Caio F0', whatsapp: P, password: '1234', code: lastCode(P) });
    assert.strictEqual(r.status, 400);
    assert.match(r.json.error, /expirado/);
  });
  await ok('pedir código novo invalida o anterior (depois de enviado)', async () => {
    const P = phone();
    await start(P);
    const old = lastCode(P);
    await start(P);
    const cur = lastCode(P);
    if (old !== cur) assert.strictEqual((await reg({ name: 'Duda F0', whatsapp: P, password: '1234', code: old })).status, 400);
    assert.strictEqual((await reg({ name: 'Duda F0', whatsapp: P, password: '1234', code: cur })).status, 201);
  });
  await ok('M7: se o envio do código NOVO falha, o anterior continua valendo', async () => {
    const P = phone();
    assert.strictEqual((await start(P)).status, 200);
    const old = lastCode(P);
    signupCode.setSenderForTests(() => ({ success: false, message: 'falhou' }));
    assert.strictEqual((await start(P)).status, 503);
    signupCode.setSenderForTests(okSender);
    assert.strictEqual((await reg({ name: 'Eli F0', whatsapp: P, password: '1234', code: old })).status, 201);
  });
  await ok('I2: limitador por telefone — com e sem 55 contam juntos; 6º código na hora → 429 JSON', async () => {
    const P = phone();
    for (let i = 0; i < 5; i++) assert.strictEqual((await start(i % 2 ? '55' + P : P)).status, 200);
    const r = await start('+55 ' + P);
    assert.strictEqual(r.status, 429);
    assert.match(r.json.error, /Muitos códigos/);
  });
  await ok('I1: limitador por IP usa cf-connecting-ip — 21º pedido do mesmo IP → 429; outro IP segue', async () => {
    const ip = '203.0.113.77';
    for (let i = 0; i < 20; i++) assert.strictEqual((await start(phone(), { ip })).status, 200, `#${i}`);
    const r = await start(phone(), { ip });
    assert.strictEqual(r.status, 429);
    assert.match(r.json.error, /deste aparelho/);
    assert.strictEqual((await start(phone(), { ip: '203.0.113.78' })).status, 200);
  });
  await ok('I1: IPv6 do mesmo /64 conta como um cliente só', async () => {
    const prefix = '2001:db8:aaaa:' + (Date.now() % 9000 + 1000).toString(16);
    for (let i = 0; i < 20; i++) assert.strictEqual((await start(phone(), { ip: `${prefix}::${(i + 1).toString(16)}` })).status, 200, `#${i}`);
    assert.strictEqual((await start(phone(), { ip: `${prefix}:ffff:1:2:3` })).status, 429);
  });
  await ok('I2: teto global diário estourado → 429 sem enviar', async () => {
    const used = await prisma.athleteSignupCode.count({ where: { createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } } });
    process.env.ATHLETE_SIGNUP_DAILY_MAX = String(used);
    const P = phone();
    const before = sent.length;
    const r = await start(P);
    delete process.env.ATHLETE_SIGNUP_DAILY_MAX;
    assert.strictEqual(r.status, 429, r.text);
    assert.match(r.json.error, /Limite diário/);
    assert.strictEqual(sent.length, before, 'nada enviado');
    assert.strictEqual(await prisma.athleteSignupCode.count({ where: { phone: N(P) } }), 0);
  });
  await ok('sem canal de envio → 503 e nada fica gravado', async () => {
    signupCode.setSenderForTests(() => ({ success: false, message: 'WhatsApp nao configurado' }));
    const P = phone();
    const r = await start(P);
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.whatsappDown, true);
    assert.strictEqual(await prisma.athleteSignupCode.count({ where: { phone: N(P) } }), 0);
    signupCode.setSenderForTests(okSender);
  });

  // ---------------- inscrição ----------------
  console.log('  — permissão de inscrição (POST /:id/entries)');
  const owner = await mkUser();
  const admin = await mkUser('admin');
  const coord = await mkUser();
  const userB = await mkUser();
  const third = await mkUser();
  const t = await prisma.tournament.create({ data: { slug: 'f0-' + RUN, name: 'F0 Torneio ' + RUN, sport: 'FUTSAL', format: 'KNOCKOUT', ownerId: owner.id, status: 'DRAFT' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Livre' } });
  const cat2 = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: '40+' } });
  await prisma.tournamentRole.create({ data: { tournamentId: t.id, userId: coord.id, role: 'COORDINATOR' } });
  const entry = (u, body) => call('POST', `/api/tournaments/${t.id}/entries`, { token: u && tok(u), body });

  await ok('sem login → 401', async () => {
    assert.strictEqual((await entry(null, { categoryId: cat.id })).status, 401);
  });
  await ok('usuário comum NÃO inscreve em torneio alheio fechado (time e a si mesmo)', async () => {
    assert.strictEqual((await entry(userB, { categoryId: cat.id, team: true, teamName: 'Invasor FC' })).status, 403);
    assert.strictEqual((await entry(userB, { categoryId: cat.id })).status, 403);
    assert.strictEqual(await prisma.tournamentEntry.count({ where: { tournamentId: t.id } }), 0);
  });
  await ok('fundador inscreve terceiro (memberUserIds) → CONFIRMED', async () => {
    const r = await entry(owner, { categoryId: cat.id, memberUserIds: [third.id], seed: 1 });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.status, 'CONFIRMED');
    assert.strictEqual(r.json.seed, 1);
  });
  await ok('coordenador e admin global inscrevem time com torneio fechado', async () => {
    const c = await entry(coord, { categoryId: cat.id, team: true, teamName: 'Time do Coordenador' });
    assert.strictEqual(c.status, 201, c.text);
    const a = await entry(admin, { categoryId: cat.id, team: true, teamName: 'Time do Admin' });
    assert.strictEqual(a.status, 201, a.text);
  });
  await prisma.tournament.update({ where: { id: t.id }, data: { status: 'OPEN' } });
  await ok('com inscrições abertas, comum NUNCA inscreve terceiros', async () => {
    assert.strictEqual((await entry(userB, { categoryId: cat2.id, memberUserIds: [third.id] })).status, 403);
    assert.strictEqual((await entry(userB, { categoryId: cat2.id, memberUsernames: [userB.id, third.id] })).status, 403);
  });
  await ok('com inscrições abertas, comum se inscreve → PENDING, sem seed/grupo', async () => {
    const r = await entry(userB, { categoryId: cat.id, seed: 1, groupName: 'A' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.status, 'PENDING');
    assert.strictEqual(r.json.seed, null);
    assert.strictEqual(r.json.groupName, null);
  });
  await ok('comum cria o PRÓPRIO time → PENDING e vira admin só desse time', async () => {
    const r = await entry(userB, { categoryId: cat2.id, team: true, teamName: 'Time da B' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.status, 'PENDING');
    const role = await prisma.tournamentRole.findFirst({ where: { tournamentId: t.id, userId: userB.id, role: 'TEAM_ADMIN' } });
    assert.ok(role && role.entryId === r.json.id);
  });
  await ok('comum não "entra" em clube existente repetindo o nome em outra categoria', async () => {
    const r = await entry(third, { categoryId: cat2.id, team: true, teamName: 'time do coordenador' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(await prisma.tournamentRole.count({ where: { tournamentId: t.id, userId: third.id } }), 0);
  });
  await ok('M2: admin do clube inscreve o MESMO clube em outra categoria (a trava de nome não vale pra ele)', async () => {
    const r = await entry(userB, { categoryId: cat.id, team: true, teamName: 'time da b' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.status, 'PENDING');
    const roles2 = await prisma.tournamentRole.count({ where: { tournamentId: t.id, userId: userB.id, role: 'TEAM_ADMIN' } });
    assert.strictEqual(roles2, 2);
  });
  await ok('M5: remover/rejeitar a inscrição tira o papel de admin do time junto', async () => {
    const e = await prisma.tournamentEntry.findFirst({ where: { tournamentId: t.id, categoryId: cat.id, name: 'time da b' } });
    const del = await call('DELETE', `/api/tournaments/entries/${e.id}`, { token: tok(owner) });
    assert.strictEqual(del.status, 200, del.text);
    assert.strictEqual(await prisma.tournamentRole.count({ where: { entryId: e.id } }), 0);
    assert.strictEqual(await prisma.tournamentRole.count({ where: { tournamentId: t.id, userId: userB.id, role: 'TEAM_ADMIN' } }), 1);
  });
  await ok('I6: organizador inscreve em massa sem esbarrar no limitador (125 times)', async () => {
    // I6 testa o LIMITADOR de requisições, não o teto do plano grátis (64 times, testado na F7).
    // Sobe o teto só durante este teste e devolve o valor anterior no fim.
    const antes = process.env.LIGA_FREE_TEAMS_PER_CATEGORY;
    process.env.LIGA_FREE_TEAMS_PER_CATEGORY = '500';
    try {
      const cm = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Massa ' + RUN } });
      for (let i = 0; i < 125; i++) {
        const r = await entry(owner, { categoryId: cm.id, team: true, teamName: `Massa ${i}` });
        assert.strictEqual(r.status, 201, `#${i} ${r.text.slice(0, 120)}`);
      }
    } finally {
      if (antes === undefined) delete process.env.LIGA_FREE_TEAMS_PER_CATEGORY; else process.env.LIGA_FREE_TEAMS_PER_CATEGORY = antes;
    }
  });
  await ok('I3: aprovar inscrição de TIME (sem membros) em torneio com TenisCash não trava em 402', async () => {
    const tc = await prisma.tournament.create({ data: { slug: 'f0c-' + RUN, name: 'F0 Cash ' + RUN, sport: 'FUTSAL', format: 'KNOCKOUT', ownerId: owner.id, status: 'OPEN', cashEnabled: true, entryFeeCash: 10 } });
    const cc = await prisma.tournamentCategory.create({ data: { tournamentId: tc.id, name: 'Livre' } });
    const r = await call('POST', `/api/tournaments/${tc.id}/entries`, { token: tok(userB), body: { categoryId: cc.id, team: true, teamName: 'Time Pagante F0' } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.status, 'PENDING');
    const ap = await call('POST', `/api/tournaments/entries/${r.json.id}/approve`, { token: tok(owner) });
    assert.strictEqual(ap.status, 200, ap.text);
    assert.strictEqual(ap.json.status, 'CONFIRMED');
    assert.strictEqual(ap.json.entryPaid, false);
  });
  await ok('I5: logo pública só serve png/jpeg/webp/gif (SVG antigo → 404) com nosniff + CSP sandbox', async () => {
    const svgSp = await prisma.tournamentSponsor.create({ data: { tournamentId: t.id, name: 'SVG antigo', logoUrl: SVG } });
    const pngSp = await prisma.tournamentSponsor.create({ data: { tournamentId: t.id, name: 'PNG ok', logoUrl: PNG } });
    const htmlSp = await prisma.tournamentSponsor.create({ data: { tournamentId: t.id, name: 'HTML', logoUrl: 'data:image/x-html;base64,PHNjcmlwdD4=' } });
    assert.strictEqual((await httpCall('GET', `${base}/api/public/sponsors/${svgSp.id}/logo`)).status, 404);
    assert.strictEqual((await httpCall('GET', `${base}/api/public/sponsors/${htmlSp.id}/logo`)).status, 404);
    const r = await new Promise((resolve, reject) => {
      http.get(`${base}/api/public/sponsors/${pngSp.id}/logo`, { agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res)); }).on('error', reject);
    });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(r.headers['content-security-policy'], "default-src 'none'; sandbox");
    const e = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: cat.id, name: 'Escudo SVG antigo ' + RUN, logoUrl: SVG } });
    assert.strictEqual((await httpCall('GET', `${base}/api/public/entries/${e.id}/logo`)).status, 404);
  });
  await ok('I7: PATCH de patrocinador sem logoUrl não consome o limitador de imagem', async () => {
    const sp = await prisma.tournamentSponsor.create({ data: { tournamentId: t.id, name: 'Ordem F0' } });
    for (let i = 0; i < 70; i++) {
      const r = await call('PATCH', `/api/tournaments/${t.id}/sponsors/${sp.id}`, { token: tok(coord), body: { ordering: i } });
      assert.strictEqual(r.status, 200, `#${i} ${r.text.slice(0, 120)}`);
    }
  });
  await ok('prazo de inscrição vencido → comum recusado; organizador ainda inscreve', async () => {
    await prisma.tournament.update({ where: { id: t.id }, data: { registrationCloseAt: new Date(Date.now() - 60000) } });
    assert.strictEqual((await entry(third, { categoryId: cat2.id })).status, 403);
    assert.strictEqual((await entry(owner, { categoryId: cat2.id, memberUserIds: [third.id] })).status, 201);
  });

  // ---------------- import ----------------
  console.log('  — importação do Futsal Master Cup');
  await ok('usuário comum → 403', async () => {
    const r = await call('POST', '/api/tournaments/import/futsal-master-cup', { token: tok(userB) });
    assert.strictEqual(r.status, 403);
  });
  await ok('organizador de outro torneio (não admin) → 403', async () => {
    assert.strictEqual((await call('POST', '/api/tournaments/import/futsal-master-cup', { token: tok(owner) })).status, 403);
  });
  await ok('admin global → importa (200)', async () => {
    const r = await call('POST', '/api/tournaments/import/futsal-master-cup', { token: tok(admin) });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
  });

  // ---------------- _loopview ----------------
  console.log('  — /api/_loopview');
  await ok('sem login → 401; com ?g= antigo e sem login → 401', async () => {
    assert.strictEqual((await call('GET', '/api/_loopview')).status, 401);
    assert.strictEqual((await call('GET', '/api/_loopview?g=qualquer')).status, 401);
  });
  await ok('logado sem ser admin → 403', async () => {
    assert.strictEqual((await call('GET', '/api/_loopview', { token: tok(userB) })).status, 403);
  });
  await ok('admin → 200 JSON', async () => {
    const r = await call('GET', '/api/_loopview', { token: tok(admin) });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.strictEqual(r.json.ok, true);
  });

  // ---------------- uploads ----------------
  console.log('  — uploads passam pelo imageGuard');
  const e1 = await prisma.tournamentEntry.findFirst({ where: { tournamentId: t.id, name: 'Time do Coordenador' } });
  const logo = (body) => call('POST', `/api/tournaments/entries/${e1.id}/logo`, { token: tok(owner), body });
  await ok('logo do time: falsa/SVG/http recusadas; PNG real, https e caminho do site aceitos', async () => {
    assert.strictEqual((await logo({ logo: FAKE_PREFIX })).status, 400);
    assert.strictEqual((await logo({ logo: SVG })).status, 400);
    assert.strictEqual((await logo({ logo: 'http://exemplo.com/a.png' })).status, 400);
    assert.strictEqual((await logo({ logo: 'javascript:alert(1)' })).status, 400);
    const ok1 = await logo({ logo: PNG });
    assert.strictEqual(ok1.status, 200, ok1.text);
    assert.ok(/^\/media\/[a-f0-9]{64}\.png$/.test(ok1.json.logoUrl), ok1.json.logoUrl); // Liga F5: /media/<sha>.png
    assert.strictEqual((await logo({ logo: 'https://exemplo.com/escudo.png' })).status, 200);
    assert.strictEqual((await logo({ logo: '/img/futsal-master-cup.png' })).status, 200);
    assert.strictEqual((await logo({ logo: null })).status, 200);
  });
  await ok('patrocinador: SVG e falsa recusadas; JPEG real aceito', async () => {
    const sp = (logoUrl) => call('POST', `/api/tournaments/${t.id}/sponsors`, { token: tok(owner), body: { name: 'Patro F0', logoUrl } });
    assert.strictEqual((await sp(SVG)).status, 400);
    assert.strictEqual((await sp(FAKE_PREFIX)).status, 400);
    const r = await sp(JPG);
    assert.strictEqual(r.status, 201, r.text);
  });
  await ok('escudo do clube: falso recusado; WEBP real aceito', async () => {
    assert.strictEqual((await call('POST', '/api/clubs', { token: tok(userB), body: { name: 'Clube Falso F0', crestUrl: FAKE_PREFIX } })).status, 400);
    const r = await call('POST', '/api/clubs', { token: tok(userB), body: { name: 'Clube F0 ' + RUN, crestUrl: WEBP } });
    assert.strictEqual(r.status, 201, r.text);
    assert.ok(/^\/media\/[a-f0-9]{64}\.webp$/.test(r.json.crestUrl), r.json.crestUrl); // Liga F5: /media/<sha>.webp
  });
  await ok('banner do torneio: javascript: recusado na criação e na edição', async () => {
    const r = await call('POST', '/api/tournaments', { token: tok(owner), body: { name: 'Banner ruim', bannerUrl: 'javascript:alert(1)' } });
    assert.strictEqual(r.status, 400);
    const p = await call('PATCH', `/api/tournaments/${t.id}`, { token: tok(owner), body: { bannerUrl: 'data:text/html;base64,PHNjcmlwdD4=' } });
    assert.strictEqual(p.status, 400);
    const p2 = await call('PATCH', `/api/tournaments/${t.id}`, { token: tok(owner), body: { bannerUrl: 'https://exemplo.com/banner.jpg' } });
    assert.strictEqual(p2.status, 200, p2.text);
  });

  // ---------------- limitador real ----------------
  console.log('  — limitador real de criação de torneio');
  await ok('21º torneio na hora pelo mesmo usuário → 429 JSON em português', async () => {
    const L = await mkUser();
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', '/api/tournaments', { token: tok(L), body: { name: `Lim ${RUN} ${i}` } });
      assert.strictEqual(r.status, 201, `#${i} ${r.text.slice(0, 120)}`);
    }
    const r = await call('POST', '/api/tournaments', { token: tok(L), body: { name: `Lim ${RUN} 21` } });
    assert.strictEqual(r.status, 429);
    assert.match(r.json.error, /Muitos torneios/);
    const other = await mkUser();
    assert.strictEqual((await call('POST', '/api/tournaments', { token: tok(other), body: { name: `Outro ${RUN}` } })).status, 201, 'outro usuário segue livre');
  });

  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('💥', e); })
  .finally(() => {
    console.log(`\nLiga Aberta F0 — segurança: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exitCode = failed ? 1 : 0;
    // Sai sozinho quando os handles fecham; trava de segurança se algum timer ficar vivo.
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  });
