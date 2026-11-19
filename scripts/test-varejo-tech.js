#!/usr/bin/env node
// Testes das tecnologias de varejo (F6): busca tolerante (pg_trgm), catálogo offline,
// observabilidade (pino/Sentry), Google Wallet, calendário .ics e painel de vendas.
//
// Usa banco DESCARTÁVEL — nunca o de produção:
//   psql -h localhost -p 55432 -U postgres -c "create database varejo_f6"
//   DATABASE_URL=postgresql://postgres@localhost:55432/varejo_f6 npx prisma db push --skip-generate --accept-data-loss
//   VAREJO_TEST_DATABASE_URL=postgresql://postgres@localhost:55432/varejo_f6 node scripts/test-varejo-tech.js
'use strict';

const TEST_DB = process.env.VAREJO_TEST_DATABASE_URL || 'postgresql://postgres@localhost:55432/varejo_f6';
if (!/localhost|127\.0\.0\.1/.test(TEST_DB) || /railway|rlwy/i.test(TEST_DB)) {
  console.error('Recusado: o teste só roda em banco local descartável.');
  process.exit(2);
}
process.env.DATABASE_URL = TEST_DB;
process.env.JWT_SECRET = 'varejo-f6-test-secret';
process.env.PUBLIC_BASE_URL = 'https://teniscash.test';
process.env.LOG_LEVEL = 'info';
delete process.env.SENTRY_DSN;
delete process.env.GOOGLE_WALLET_ISSUER_ID;
delete process.env.GOOGLE_WALLET_SA_JSON;

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

const ROOT = path.resolve(__dirname, '..');
const { prisma } = require(path.join(ROOT, 'src/middleware'));
const { ensureApexSchema, ensureSearchIndexes } = require(path.join(ROOT, 'src/services/ensureApexSchema'));
const productSearch = require(path.join(ROOT, 'src/services/productSearch'));
const observability = require(path.join(ROOT, 'src/services/observability'));
const googleWallet = require(path.join(ROOT, 'src/services/googleWallet'));
const teamCalendar = require(path.join(ROOT, 'src/services/teamCalendar'));

const TAG = 'f6t-' + Date.now().toString(36);
let passed = 0;
const results = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push('  ok   ' + name);
  } catch (e) {
    results.push('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e));
  }
}

// ---------------------------------------------------------------- datas
const TZ = 'America/Fortaleza';
const todayYmd = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const addDays = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);
const dowOf = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay();
const compact = (ymd) => ymd.replace(/-/g, '');

// ------------------------------------------------------------- app de teste
const logLines = [];
const logger = observability.createLogger({ destination: { write: (s) => logLines.push(s) } });
function buildApp() {
  const app = express();
  app.use(express.json());
  // mesmas linhas de src/index.js (logger de teste p/ capturar a saída)
  observability.initSentry();
  app.use(observability.httpLogger({ logger }));
  app.use(observability.sentryResponseHook);
  app.use('/api/search', require(path.join(ROOT, 'src/routes/search')));
  app.use('/api/google-wallet', require(path.join(ROOT, 'src/routes/googleWallet')));
  app.use('/api/team-calendar', require(path.join(ROOT, 'src/routes/teamCalendar')));
  app.use('/api/sales-dashboard', require(path.join(ROOT, 'src/routes/salesDashboard')));
  app.post('/api/echo', (req, res) => res.json({ ok: true }));
  observability.installErrorHandler(app);
  return app;
}

let server;
let base;
function req(method, url, { token, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const h = { ...headers };
    if (token) h.Authorization = 'Bearer ' + token;
    let data = null;
    if (body !== undefined) { data = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

// ------------------------------------------------------------------ seed
const seed = {};
async function seedData() {
  const mk = (code, name) => prisma.store.create({ data: { code: TAG + '-' + code, name } });
  seed.storeA = await mk('A', 'Sports & Tennis Praia do Bessa');
  seed.storeB = await mk('B', 'Sports & Tennis Tambiá');
  const user = (role, name, extra = {}) => prisma.user.create({
    data: { name, phone: TAG + '-' + role + '-' + crypto.randomBytes(3).toString('hex'), pin: 'x', role, ...extra },
  });
  seed.seller = await user('seller', 'Maria Vendedora Silva', { storeId: seed.storeA.id });
  seed.seller2 = await user('seller', 'João Outro Vendedor', { storeId: seed.storeB.id });
  seed.admin = await user('admin', 'Dono Teste');
  seed.customer = await user('user', 'Cliente Fiel Souza', { balance: 50 });

  const product = async (sku, name, brand, { active = true, color = null, cost = null, sizes = [] } = {}) => {
    const p = await prisma.product.create({
      data: { sku: TAG + '-' + sku, name, brand, category: 'tenis', price: 499.9, costPrice: cost, active, aiContext: color ? { color } : undefined },
    });
    for (const s of sizes) {
      const ps = await prisma.productSize.create({ data: { productId: p.id, size: s.size, barcode: s.barcode, stock: s.comprado || 0 } });
      for (const [store, qty] of s.stock || []) await prisma.storeStock.create({ data: { storeId: store.id, productSizeId: ps.id, stock: qty } });
    }
    return p;
  };
  seed.nimbus = await product('1011B794', 'TENIS ASICS GEL-NIMBUS 26 MASCULINO', 'ASICS', {
    color: 'Preto/Branco', cost: 123.45,
    sizes: [
      { size: '40', barcode: '4550457123456', comprado: 5, stock: [[seed.storeA, 2], [seed.storeB, 1]] },
      { size: '41', barcode: '4550457123463', comprado: 5, stock: [[seed.storeA, 0]] },
      { size: '42', barcode: 'SEM GTIN', comprado: 9, stock: [[seed.storeB, 4]] },
    ],
  });
  seed.kappa = await product('K100.05', 'CHUTEIRA KAPPA MAESTRO SINTETICO SOLA PVC AMARELO/VERDE', 'KAPPA', {
    color: 'Amarelo/Verde', cost: 88.8,
    sizes: [{ size: '39', barcode: '7898765432109', comprado: 3, stock: [[seed.storeA, 1]] }],
  });
  seed.olymp = await product('OLY-CORRE3', 'Tênis Olympikus Corre 3 Feminino', 'Olympikus', { color: 'Lilás', sizes: [{ size: '36', barcode: '7891122334455', stock: [[seed.storeB, 2]] }] });
  seed.inactive = await product('INATIVO', 'TENIS ASICS GEL-NIMBUS 25 ANTIGO', 'ASICS', { active: false, sizes: [{ size: '40', barcode: '4550457999999' }] });
}

async function cleanup() {
  const products = await prisma.product.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } });
  const pids = products.map((p) => p.id);
  const users = await prisma.user.findMany({ where: { phone: { startsWith: TAG } }, select: { id: true } });
  const uids = users.map((u) => u.id);
  const stores = await prisma.store.findMany({ where: { code: { startsWith: TAG } }, select: { id: true } });
  const sids = stores.map((s) => s.id);
  const sales = await prisma.sale.findMany({ where: { sellerId: { in: uids } }, select: { id: true } });
  await prisma.saleItem.deleteMany({ where: { saleId: { in: sales.map((s) => s.id) } } });
  await prisma.sale.deleteMany({ where: { id: { in: sales.map((s) => s.id) } } });
  await prisma.storeStock.deleteMany({ where: { storeId: { in: sids } } });
  await prisma.productSize.deleteMany({ where: { productId: { in: pids } } });
  await prisma.product.deleteMany({ where: { id: { in: pids } } });
  await prisma.agendaActivity.deleteMany({ where: { OR: [{ sellerId: { in: uids } }, { storeId: { in: sids } }] } });
  await prisma.sellerMonthlyShift.deleteMany({ where: { sellerId: { in: uids } } });
  await prisma.sellerSchedule.deleteMany({ where: { sellerId: { in: uids } } });
  await prisma.sellerMonthlySchedule.deleteMany({ where: { createdById: { in: uids } } });
  for (const id of uids) {
    await prisma.$executeRaw`DELETE FROM "TeamCalendarFeed" WHERE "sellerId" = ${id}`;
    await prisma.$executeRaw`DELETE FROM "AgendaRequest" WHERE "sellerId" = ${id}`.catch(() => {});
  }
  await prisma.user.deleteMany({ where: { id: { in: uids } } });
  await prisma.store.deleteMany({ where: { id: { in: sids } } });
}

// ================================================================== testes
async function main() {
  await ensureApexSchema(prisma);
  await require(path.join(ROOT, 'src/services/agendaDaily')).ensureAgendaSchema(prisma); // "AgendaRequest" (boot)
  await seedData();
  server = buildApp().listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
  const sellerTok = tokenFor(seed.seller);
  const adminTok = tokenFor(seed.admin);
  const customerTok = tokenFor(seed.customer);

  // ------------------------------------------------ 1. busca tolerante
  await test('schema: pg_trgm instalado e 4 índices GIN de trigram válidos', async () => {
    const ext = await prisma.$queryRawUnsafe(`SELECT 1 FROM pg_extension WHERE extname='pg_trgm'`);
    assert.strictEqual(ext.length, 1);
    const idx = await prisma.$queryRawUnsafe(`SELECT c.relname, i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid WHERE c.relname LIKE '%_trgm_idx' ORDER BY 1`);
    assert.deepStrictEqual(idx.map((r) => r.relname).sort(), ['ProductSize_barcode_trgm_idx', 'Product_brand_trgm_idx', 'Product_name_trgm_idx', 'Product_sku_trgm_idx']);
    assert.ok(idx.every((r) => r.indisvalid));
  });

  await test('schema: o planner consegue usar o índice de nome (expressão igual à da busca)', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const f = `translate(lower(coalesce("name",'')), '${productSearch.ACCENT_FROM}', '${productSearch.ACCENT_TO}')`;
      const plan = await tx.$queryRawUnsafe(`EXPLAIN SELECT id FROM "Product" WHERE 'nimbu' <% ${f}`);
      const text = plan.map((r) => Object.values(r)[0]).join('\n');
      assert.ok(/Product_name_trgm_idx/.test(text), text);
    });
  });

  const search = (q, tok = sellerTok) => req('GET', '/api/search/products?q=' + encodeURIComponent(q), { token: tok });
  const ours = (r) => r.json.products.filter((p) => String(p.sku).startsWith(TAG));

  await test('busca "asics nimbu" (erro de digitação) acha o GEL-NIMBUS em 1º', async () => {
    const r = await search('asics nimbu');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.mode, 'trgm');
    assert.strictEqual(ours(r)[0].id, seed.nimbus.id);
  });
  await test('busca "chutera kapa" acha a chuteira Kappa', async () => {
    const r = await search('chutera kapa');
    assert.strictEqual(ours(r)[0].id, seed.kappa.id);
  });
  await test('busca sem acento e com erro: "tenis olimpikus" acha "Tênis Olympikus"', async () => {
    const r = await search('tenis olimpikus');
    assert.strictEqual(ours(r)[0].id, seed.olymp.id);
  });
  await test('busca por parte do EAN ("7123456") acha o produto', async () => {
    const r = await search('7123456');
    assert.ok(r.json.products.length >= 1);
    assert.strictEqual(ours(r)[0].id, seed.nimbus.id);
  });
  await test('busca por referência parcial ("k100") acha a Kappa', async () => {
    const r = await search('k100');
    assert.ok(r.json.products.some((p) => p.id === seed.kappa.id));
  });
  await test('produto inativo nunca aparece; "SEM GTIN" não sai como código', async () => {
    const r = await search('asics nimbus');
    assert.ok(!r.json.products.some((p) => p.id === seed.inactive.id));
    const sem = await search('SEM GTIN');
    assert.ok(!JSON.stringify(sem.json.products).includes('SEM GTIN'));
    const n = r.json.products.find((p) => p.id === seed.nimbus.id);
    assert.strictEqual(n.sizes.find((s) => s.size === '42').barcode, null);
  });
  await test('estoque devolvido = físico Σ StoreStock (não o comprado) e sem custo', async () => {
    const r = await search('nimbus');
    const n = r.json.products.find((p) => p.id === seed.nimbus.id);
    assert.strictEqual(n.physicalStock, 7); // 2 + 1 + 4 (comprado seria 19)
    const s40 = n.sizes.find((s) => s.size === '40');
    assert.deepStrictEqual(s40.storeStocks.map((x) => x.stock).sort(), [1, 2]);
    assert.ok(!/cost/i.test(r.text));
    assert.ok(!r.text.includes('123.45'));
  });
  await test('busca exige equipe: cliente 403, sem token 401', async () => {
    assert.strictEqual((await search('nimbus', customerTok)).status, 403);
    assert.strictEqual((await search('nimbus', null)).status, 401);
  });
  await test('sem pg_trgm (fallback LIKE) a busca funciona e não quebra', async () => {
    process.env.SEARCH_FORCE_FALLBACK = '1';
    productSearch.resetTrgmCache();
    try {
      const r = await search('asics nimbus');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.mode, 'like');
      assert.strictEqual(ours(r)[0].id, seed.nimbus.id);
      const ean = await search('7123456');
      assert.strictEqual(ours(ean)[0].id, seed.nimbus.id);
    } finally {
      delete process.env.SEARCH_FORCE_FALLBACK;
      productSearch.resetTrgmCache();
    }
  });
  await test('CREATE EXTENSION negado não derruba o boot (ensureSearchIndexes devolve trgm=false)', async () => {
    const fake = { $executeRawUnsafe: async (sql) => { if (/EXTENSION/.test(sql)) throw new Error('permission denied to create extension'); }, $queryRawUnsafe: async () => [] };
    const r = await ensureSearchIndexes(fake);
    assert.deepStrictEqual(r, { trgm: false, indexes: 0 });
  });

  // ------------------------------------------------ 2. snapshot offline
  let etag1;
  let snap;
  await test('snapshot: 200 + ETag, só ativos, sem custo, SEM GTIN vira null', async () => {
    const r = await req('GET', '/api/search/catalog-snapshot', { token: sellerTok });
    assert.strictEqual(r.status, 200);
    etag1 = r.headers.etag;
    assert.ok(/^"cat1-/.test(etag1));
    snap = r.json;
    const mine = snap.products.filter((p) => String(p[3]).startsWith(TAG));
    assert.strictEqual(mine.length, 3);
    assert.ok(!mine.some((p) => p[0] === seed.inactive.id));
    assert.ok(!/cost/i.test(r.text) && !r.text.includes('123.45') && !r.text.includes('88.8'));
    const n = mine.find((p) => p[0] === seed.nimbus.id);
    const s42 = n[7].find((s) => s[0] === '42');
    assert.strictEqual(s42[1], null);
    const storeIdxB = snap.stores.findIndex((s) => s[0] === seed.storeB.id);
    assert.deepStrictEqual(s42[2], [[storeIdxB, 4]]);
  });
  await test('snapshot: If-None-Match igual → 304; estoque mudou → ETag novo', async () => {
    const r304 = await req('GET', '/api/search/catalog-snapshot', { token: sellerTok, headers: { 'If-None-Match': etag1 } });
    assert.strictEqual(r304.status, 304);
    const ss = await prisma.storeStock.findFirst({ where: { storeId: seed.storeA.id, productSize: { productId: seed.kappa.id } } });
    await prisma.storeStock.update({ where: { id: ss.id }, data: { stock: 2 } });
    require(path.join(ROOT, 'src/routes/search'))._resetSnapshotCache();
    const r2 = await req('GET', '/api/search/catalog-snapshot', { token: sellerTok, headers: { 'If-None-Match': etag1 } });
    assert.strictEqual(r2.status, 200);
    assert.notStrictEqual(r2.headers.etag, etag1);
    snap = r2.json;
  });
  await test('snapshot exige equipe (cliente 403)', async () => {
    assert.strictEqual((await req('GET', '/api/search/catalog-snapshot', { token: customerTok })).status, 403);
  });
  await test('catalog-offline.js: busca offline (com MiniSearch 7.2.0 se baixar; senão modo simples)', async () => {
    const offline = require(path.join(ROOT, 'public/catalog-offline.js'));
    let MiniSearch = null;
    try {
      const file = path.join(os.tmpdir(), 'minisearch-7.2.0-umd.js');
      if (!fs.existsSync(file)) {
        const res = await fetch('https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/umd/index.js');
        if (res.ok) fs.writeFileSync(file, await res.text());
      }
      if (fs.existsSync(file)) MiniSearch = require(file);
    } catch (_) { MiniSearch = null; }
    offline._reset();
    offline._load(snap, new Date().toISOString(), 'x', MiniSearch);
    const mine = (q) => offline.search(q).filter((p) => String(p.sku).startsWith(TAG));
    assert.strictEqual(mine('7123456')[0].id, seed.nimbus.id, 'EAN parcial');
    if (MiniSearch) {
      assert.strictEqual(mine('asics nimbu')[0].id, seed.nimbus.id);
      assert.strictEqual(mine('chutera kapa')[0].id, seed.kappa.id);
      assert.strictEqual(mine('tenis olimpikus')[0].id, seed.olymp.id);
    } else {
      results.push('  (aviso) MiniSearch não baixado — testado só o modo simples');
      assert.strictEqual(mine('asics nimbus')[0].id, seed.nimbus.id);
    }
    const k = mine('kappa')[0];
    assert.strictEqual(k.sizes[0].storeStocks[0].stock, 2); // estoque mudado acima
  });

  // ------------------------------------------------ 3. observabilidade
  await test('pino: redige token/CPF/telefone/Authorization em log estruturado', async () => {
    const lines = [];
    const l = observability.createLogger({ destination: { write: (s) => lines.push(s) } });
    l.info({ token: 'segredo123', cliente: { cpf: '123.456.789-09', phone: '83999998888', nome: 'Ana' }, req: { headers: { authorization: 'Bearer abc' } }, body: { senha: 'x' } }, 'teste');
    const out = lines.join('');
    for (const leak of ['segredo123', '123.456.789-09', '83999998888', 'Bearer abc', 'senha']) assert.ok(!out.includes(leak), 'vazou ' + leak + ': ' + out);
    assert.ok(out.includes('Ana'));
  });
  await test('pino-http: 1 linha JSON por request com requestId, sem corpo/token/CPF na URL', async () => {
    logLines.length = 0;
    const rid = 'teste-req-1234567';
    const r = await req('POST', '/api/echo?token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk&cpf=12345678909&q=asics', {
      token: 'eyJhbGciOiJIUzI1NiJ9.segredo.assinatura', headers: { 'x-request-id': rid }, body: { cpf: '98765432100', telefone: '83911112222' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-request-id'], rid);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const out = logLines.join('');
    const line = JSON.parse(logLines.find((s) => s.includes('/api/echo')));
    assert.strictEqual(line.req.id, rid);
    assert.strictEqual(line.res.statusCode, 200);
    for (const leak of ['segredo', '12345678909', '98765432100', '83911112222', 'eyJ']) assert.ok(!out.includes(leak), 'vazou ' + leak + ': ' + out);
    assert.ok(out.includes('q=asics'));
    // id gerado quando não vem do proxy
    const r2 = await req('GET', '/api/google-wallet/status');
    assert.ok(/^[0-9a-f-]{36}$/.test(r2.headers['x-request-id']));
  });
  await test('pino-http: token do calendário no caminho é mascarado', async () => {
    assert.strictEqual(observability.safeUrl('/api/team-calendar/feed/abc.1.xyz.ics'), '/api/team-calendar/feed/[token]');
  });
  await test('Sentry: sem SENTRY_DSN é no-op (não carrega, não registra handlers)', async () => {
    assert.strictEqual(observability.initSentry({}), null);
    assert.strictEqual(observability.sentryEnabled, false);
    const loaded = Object.keys(require.cache).some((k) => k.includes(`${path.sep}@sentry${path.sep}`));
    assert.strictEqual(loaded, false, '@sentry/node foi carregado sem DSN');
    const app = express();
    app.get('/x', (_q, s) => s.end());
    const before = app._router.stack.length;
    const rejBefore = process.listenerCount('unhandledRejection');
    observability.installErrorHandler(app);
    assert.strictEqual(app._router.stack.length, before);
    assert.strictEqual(process.listenerCount('unhandledRejection'), rejBefore);
  });
  await test('Sentry: scrub tira corpo/cookies/headers e mascara CPF/telefone/e-mail/JWT', async () => {
    const ev = observability.scrubEvent({
      message: 'falhou p/ 123.456.789-09 tel (83) 99999-1234 a@b.com',
      request: { url: 'https://x/api/a?token=abc&cpf=1', data: { cpf: '1' }, cookies: { s: 1 }, headers: { authorization: 'Bearer z' }, query_string: 'token=abc&q=nike' },
      user: { id: 'u1', email: 'a@b.com', ip_address: '1.2.3.4' },
      exception: { values: [{ value: 'token eyJaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc', stacktrace: { frames: [{ vars: { senha: 'x' } }] } }] },
      breadcrumbs: [{ message: 'cliente 83988887777' }],
    });
    const out = JSON.stringify(ev);
    for (const leak of ['123.456.789-09', '99999-1234', 'a@b.com', 'Bearer z', 'eyJaaaa', '83988887777', '1.2.3.4', '"senha"']) assert.ok(!out.includes(leak), 'vazou ' + leak + ': ' + out);
    assert.deepStrictEqual(ev.user, { id: 'u1' });
    assert.ok(ev.request.query_string.includes('q=nike'));
  });

  // ------------------------------------------------ 4. Google Wallet
  await test('Wallet: sem credencial → enabled=false e save-link 404', async () => {
    const s = await req('GET', '/api/google-wallet/status');
    assert.deepStrictEqual(s.json, { enabled: false });
    assert.strictEqual((await req('GET', '/api/google-wallet/save-link', { token: customerTok })).status, 404);
  });
  await test('Wallet: JWT savetowallet RS256 com campos certos (chave de teste, sem chamar Google)', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const sa = { type: 'service_account', client_email: 'wallet-teste@projeto.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    process.env.GOOGLE_WALLET_ISSUER_ID = '3388000000012345678';
    process.env.GOOGLE_WALLET_SA_JSON = Buffer.from(JSON.stringify(sa)).toString('base64');
    try {
      assert.deepStrictEqual((await req('GET', '/api/google-wallet/status')).json, { enabled: true });
      const r = await req('GET', '/api/google-wallet/save-link', { token: customerTok });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.url.startsWith('https://pay.google.com/gp/v/save/'));
      const token = r.json.url.slice('https://pay.google.com/gp/v/save/'.length);
      const claims = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }), { algorithms: ['RS256'], audience: 'google' });
      assert.strictEqual(claims.iss, sa.client_email);
      assert.strictEqual(claims.typ, 'savetowallet');
      assert.deepStrictEqual(claims.origins, ['https://teniscash.test']);
      assert.strictEqual(claims.payload.genericClasses[0].id, '3388000000012345678.teniscash_membro');
      const obj = claims.payload.genericObjects[0];
      assert.ok(obj.id.startsWith('3388000000012345678.tc_'));
      assert.ok(!obj.id.includes(seed.customer.id), 'id interno exposto');
      assert.strictEqual(obj.classId, '3388000000012345678.teniscash_membro');
      assert.strictEqual(obj.state, 'ACTIVE');
      assert.strictEqual(obj.header.defaultValue.value, 'Cliente Fiel Souza');
      assert.ok(obj.cardTitle.defaultValue.value.includes('TenisCash'));
      const saldo = obj.textModulesData.find((t) => t.id === 'saldo');
      assert.ok(/^T\$ 50,00 \(em \d{2}\/\d{2}\/\d{4}/.test(saldo.body), saldo.body);
      assert.strictEqual(obj.barcode, undefined, 'não inventa formato de QR');
      assert.ok(!JSON.stringify(claims).includes(seed.customer.phone));
      // mesmo cliente = mesmo id de cartão
      const again = googleWallet.buildSaveLink({ id: seed.customer.id, name: 'x', balance: 1 });
      assert.strictEqual(again.objectId, obj.id);
      // cliente não logado não gera
      assert.strictEqual((await req('GET', '/api/google-wallet/save-link')).status, 401);
    } finally {
      delete process.env.GOOGLE_WALLET_ISSUER_ID;
      delete process.env.GOOGLE_WALLET_SA_JSON;
    }
  });

  // ------------------------------------------------ 5. calendário .ics
  await test('ICS: escala publicada + folga aprovada, fuso Fortaleza; não presume turno; sem pedido pendente', async () => {
    const today = todayYmd();
    const month = today.slice(0, 7);
    // mês atual publicado (se já existir um mês publicado no banco de teste, reaproveita)
    let sched = await prisma.sellerMonthlySchedule.findUnique({ where: { month } });
    if (!sched) sched = await prisma.sellerMonthlySchedule.create({ data: { month, status: 'PUBLISHED', createdById: seed.admin.id, publishedAt: new Date() } });
    else if (sched.status !== 'PUBLISHED') sched = await prisma.sellerMonthlySchedule.update({ where: { id: sched.id }, data: { status: 'PUBLISHED' } });
    await prisma.sellerMonthlyShift.create({ data: { scheduleId: sched.id, sellerId: seed.seller.id, storeId: seed.storeA.id, workDate: new Date(today + 'T12:00:00Z'), startTime: '09:00', endTime: '18:00' } });
    // escala fixa cadastrada: NÃO vira turno no .ics (mês sem escala publicada não presume horário)
    const d40 = addDays(today, 40);
    const d47 = addDays(today, 47);
    await prisma.sellerSchedule.create({ data: { sellerId: seed.seller.id, storeId: seed.storeB.id, weekday: dowOf(d40), startTime: '10:00', endTime: '16:00' } });
    // folga aprovada em D+40 (some o turno fixo desse dia) e folga amanhã
    await prisma.agendaActivity.create({ data: { title: 'Folga', type: 'folga', date: new Date(d40 + 'T12:00:00Z'), sellerId: seed.seller.id } });
    await prisma.agendaActivity.create({ data: { title: 'Aniversário da filha', type: 'folga', date: new Date(addDays(today, 1) + 'T12:00:00Z'), sellerId: seed.seller.id } });
    // de outro vendedor (não pode aparecer) + feriado da loja B (aparece: ele trabalha na B na escala fixa)
    await prisma.agendaActivity.create({ data: { title: 'Folga do João', type: 'folga', date: new Date(addDays(today, 2) + 'T12:00:00Z'), sellerId: seed.seller2.id } });
    await prisma.agendaActivity.create({ data: { title: 'Feriado municipal', type: 'feriado', date: new Date(addDays(today, 3) + 'T12:00:00Z'), storeId: seed.storeB.id } });
    // pedido PENDENTE (não aprovado) não entra
    await prisma.$executeRaw`INSERT INTO "AgendaRequest" ("id","sellerId","type","title","date") VALUES (${crypto.randomUUID()}, ${seed.seller.id}, 'folga', 'Pedido pendente XYZ', ${addDays(today, 5)})`;

    const link = await req('GET', '/api/team-calendar/my-link', { token: sellerTok });
    assert.strictEqual(link.status, 200);
    assert.ok(link.json.url.startsWith('https://teniscash.test/api/team-calendar/feed/'));
    assert.ok(link.json.webcal.startsWith('webcal://'));
    const feedPath = new URL(link.json.url).pathname;
    const r = await req('GET', feedPath);
    assert.strictEqual(r.status, 200);
    assert.ok(/^text\/calendar/.test(r.headers['content-type']));
    const ics = r.text;
    // estrutura válida
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.trimEnd().endsWith('END:VCALENDAR'));
    assert.ok(/\r\nVERSION:2\.0\r\n/.test(ics) && /\r\nPRODID:/.test(ics));
    for (const comp of ['VCALENDAR', 'VEVENT', 'VTIMEZONE']) {
      assert.strictEqual((ics.match(new RegExp('BEGIN:' + comp + '\\r\\n', 'g')) || []).length, (ics.match(new RegExp('END:' + comp + '(\\r\\n|$)', 'g')) || []).length, comp);
    }
    assert.ok(ics.includes('TZID:America/Fortaleza') && ics.includes('TZOFFSETTO:-0300'));
    const stamps = ics.match(/^DTSTAMP:.*$/gm);
    assert.ok(stamps.length && stamps.every((s) => /^DTSTAMP:\d{8}T\d{6}Z\r?$/.test(s)), stamps.join(','));
    const uids = ics.match(/^UID:.*$/gm);
    assert.strictEqual(new Set(uids).size, uids.length, 'UID repetido');
    // turno da escala publicada hoje 09:00–18:00 no fuso de Fortaleza
    assert.ok(ics.includes(`DTSTART;TZID=America/Fortaleza:${compact(today)}T090000`), 'turno publicado');
    assert.ok(ics.includes(`DTEND;TZID=America/Fortaleza:${compact(today)}T180000`));
    // escala fixa NÃO gera turno presumido (nem em D+47, nem em D+40 que é folga)
    assert.ok(!ics.includes(`${compact(d47)}T100000`), 'turno presumido da escala fixa');
    assert.ok(!ics.includes(`${compact(d40)}T100000`), 'turno em dia de folga');
    assert.strictEqual((ics.match(/^SUMMARY:Turno/gm) || []).length, 1, 'só o turno publicado');
    assert.ok(ics.includes(`DTSTART;VALUE=DATE:${compact(d40)}`));
    assert.ok(ics.includes('Folga · Aniversário da filha') || ics.includes('Folga · Anivers'));
    assert.ok(ics.includes('Feriado · Feriado municipal'));
    assert.ok(!ics.includes('Folga do João'), 'evento de outro vendedor');
    assert.ok(!ics.includes('Pedido pendente XYZ'), 'pedido pendente');

    // service: o horário local vira o instante UTC certo (UTC-3)
    assert.strictEqual(teamCalendar.localToUtc('2026-11-20', '09:00').toISOString(), '2026-11-20T12:00:00.000Z');

    // trocar o link invalida o antigo
    const rot = await req('POST', '/api/team-calendar/my-link/rotate', { token: sellerTok });
    assert.strictEqual(rot.status, 200);
    assert.notStrictEqual(rot.json.url, link.json.url);
    assert.strictEqual((await req('GET', feedPath)).status, 404);
    assert.strictEqual((await req('GET', new URL(rot.json.url).pathname)).status, 200);
    // token adulterado / cliente
    assert.strictEqual((await req('GET', feedPath.replace(/.{5}\.ics$/, 'AAAAA.ics'))).status, 404);
    assert.strictEqual((await req('GET', '/api/team-calendar/my-link', { token: customerTok })).status, 403);
  });

  // ------------------------------------------------ 6. painel de vendas
  await test('painel: admin-only e números batem com as vendas semeadas (dia de Fortaleza)', async () => {
    const today = todayYmd();
    const yest = addDays(today, -1);
    const mkSale = async (store, total, createdAt, status = 'completed', items = []) => {
      const s = await prisma.sale.create({ data: { sellerId: seed.seller.id, storeId: store ? store.id : null, totalAmount: total, status, createdAt } });
      for (const it of items) await prisma.saleItem.create({ data: { saleId: s.id, productName: it.name, brand: it.brand, quantity: it.qty, unitPrice: it.total / it.qty, totalPrice: it.total } });
      return s;
    };
    const before = (await req('GET', '/api/sales-dashboard/summary?days=30', { token: adminTok })).json;
    // hoje 12:00 local
    await mkSale(seed.storeA, 300, new Date(today + 'T15:00:00Z'), 'completed', [{ name: 'Nimbus', brand: 'ASICS', qty: 1, total: 300 }]);
    await mkSale(seed.storeA, 100, new Date(today + 'T16:00:00Z'), 'completed', [{ name: 'Kappa', brand: 'KAPPA', qty: 2, total: 100 }]);
    // ontem 23:30 local = hoje 02:30 UTC → conta ONTEM
    await mkSale(seed.storeB, 200, new Date(today + 'T02:30:00Z'), 'completed', [{ name: 'Nimbus', brand: 'ASICS', qty: 1, total: 200 }]);
    // cancelada e fora da janela: não contam
    await mkSale(seed.storeB, 999, new Date(today + 'T15:00:00Z'), 'canceled', [{ name: 'X', brand: 'ZZZ', qty: 1, total: 999 }]);
    await mkSale(seed.storeA, 777, new Date(addDays(today, -45) + 'T15:00:00Z'), 'completed', [{ name: 'Y', brand: 'YYY', qty: 1, total: 777 }]);

    assert.strictEqual((await req('GET', '/api/sales-dashboard/summary', { token: sellerTok })).status, 403);
    assert.strictEqual((await req('GET', '/api/sales-dashboard/summary')).status, 401);
    const r = await req('GET', '/api/sales-dashboard/summary?days=30', { token: adminTok });
    assert.strictEqual(r.status, 200);
    const d = r.json;
    assert.strictEqual(d.timezone, 'America/Fortaleza');
    assert.strictEqual(d.days.length, 30);
    assert.strictEqual(d.to, today);
    const A = d.stores.find((s) => s.storeId === seed.storeA.id);
    const B = d.stores.find((s) => s.storeId === seed.storeB.id);
    assert.strictEqual(A.sales, 2);
    assert.strictEqual(A.revenue, 400);
    assert.strictEqual(A.avgTicket, 200);
    assert.strictEqual(A.daily[d.days.indexOf(today)], 400);
    assert.strictEqual(B.sales, 1);
    assert.strictEqual(B.revenue, 200);
    assert.strictEqual(B.daily[d.days.indexOf(yest)], 200, 'venda de 23:30 local tem que cair ontem');
    assert.strictEqual(B.daily[d.days.indexOf(today)], 0);
    // totais = antes + o que semeamos (3 vendas, R$ 600)
    assert.strictEqual(d.totals.sales - before.totals.sales, 3);
    assert.strictEqual(Math.round((d.totals.revenue - before.totals.revenue) * 100) / 100, 600);
    assert.strictEqual(d.totals.avgTicket, d.totals.sales ? Math.round((d.totals.revenue / d.totals.sales) * 100) / 100 : 0);
    const brandOf = (x, name) => x.topBrands.find((t) => t.brand === name) || { units: 0, revenue: 0 };
    const asics = brandOf(d, 'ASICS');
    const asics0 = brandOf(before, 'ASICS');
    assert.deepStrictEqual([asics.units - asics0.units, Math.round((asics.revenue - asics0.revenue) * 100) / 100], [2, 500]);
    assert.ok(!d.topBrands.some((b) => b.brand === 'ZZZ' || b.brand === 'YYY'));
    assert.ok(d.topBrands.every((b, i) => i === 0 || d.topBrands[i - 1].revenue >= b.revenue), 'top marcas em ordem de faturamento');
  });
}

main()
  .catch((e) => { results.push('  FAIL (setup) ' + (e.stack || e)); })
  .finally(async () => {
    try { await cleanup(); } catch (e) { results.push('  (aviso) limpeza: ' + e.message); }
    if (server) server.close();
    await prisma.$disconnect();
    console.log(results.join('\n'));
    const failed = results.filter((r) => r.includes('FAIL')).length;
    console.log(`\n${passed} ok, ${failed} falha(s)`);
    process.exit(failed ? 1 : 0);
  });
