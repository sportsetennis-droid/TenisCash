'use strict';
// =====================================================================
// Liga Aberta F6 — teste de TELA (celular 390 px). npm run test:liga-f6-ui
// Sobe o app real (src/index.js) num banco LOCAL descartável e confere:
//  1. /t/:slug sem login: "Denunciar" pede para entrar
//  2. /t/:slug logado: Denunciar (rodapé) → folha de baixo, motivo, enviar → recebida;
//     Denunciar num aviso → vem pré-selecionado; botões ≥ 44 px; sem rolagem lateral
//  3. /moderacao (admin): fila com as denúncias, ocultar aviso, suspender torneio (com
//     motivo) e reativar pela aba Suspensos; usuário comum vê "só o administrador"
//  4. /privacidade-club: baixar (arquivo JSON sem CPF) e apagar com a frase (botão só
//     libera com a frase certa); conta com saldo vê que o login fica
// Screenshots em SHOTS_DIR. Playwright: require('playwright') ou PLAYWRIGHT_MODULE
// (ex.: playwright-core) + navegador em CHROME_PATH. Não roda contra produção.
// Fora do CI (precisa de navegador).
// =====================================================================

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');
const net = require('net');
const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });

function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  for (const m of tries) { try { return require(m); } catch (_) { /* próximo */ } }
  return null;
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}
let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('⏭️  Playwright não encontrado (defina PLAYWRIGHT_MODULE) — PULADO'); return; }
  const URL_DB = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB)) { console.log('⏭️  DATABASE_URL local não definido — PULADO'); return; }
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-f6-ui-' + crypto.randomBytes(8).toString('hex');
  delete process.env.LIGA_MINORS;
  const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'tmp', 'f6-ui');
  fs.mkdirSync(SHOTS, { recursive: true });

  const jwt = require('jsonwebtoken');
  const { prisma } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  await ensureApexSchema(prisma);
  const RUN = Date.now().toString(36);
  let seq = 0;
  const mk = (label, extra = {}) => prisma.user.create({ data: { name: `UI F6 ${label} ${RUN}-${++seq}`, phone: '834' + String(Date.now() % 1000000).padStart(6, '0') + String(seq).padStart(2, '0'), pin: 'x', ...extra } });
  const owner = await mk('dono');
  const user = await mk('usuario', { cpf: '111444777' + String(Date.now() % 100).padStart(2, '0') });
  const admin = await mk('admin', { role: 'admin' });
  const rich = await mk('com saldo', { balance: 10 });
  const tk = (u) => jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const T = await prisma.tournament.create({ data: { slug: 'f6ui-' + RUN, name: 'Copa UI F6 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: owner.id, status: 'ONGOING', visibility: 'public' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre' } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Leões UI', status: 'CONFIRMED' } });
  await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Tubarões UI', status: 'CONFIRMED' } });
  const post = await prisma.tournamentPost.create({ data: { tournamentId: T.id, authorId: owner.id, body: 'Aviso para denunciar UI ' + RUN } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Jogador UI', userId: user.id, number: 5 } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Rico UI', userId: rich.id, number: 6 } });

  const PORT = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', TREG_SWEEPER: 'off', RNA_ATIVA: '0', RNA_RELOGIO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const BASE = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await get(BASE + '/api/health'); up = r.status === 200 || r.status === 503; } catch (_) {}
  }
  if (!up) { child.kill(); throw new Error('app não subiu: ' + out.slice(-500)); }

  const browser = await pw.chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR', acceptDownloads: true };
  const newCtx = async (u) => {
    const c = await browser.newContext(ctxOpts);
    if (u) await c.addInitScript((t) => { try { localStorage.setItem('tc_token', t); } catch (_) {} }, tk(u));
    return c;
  };
  const scrollW = (page) => page.evaluate(() => document.documentElement.scrollWidth);
  const smallButtons = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => (b.textContent || '').trim().slice(0, 30)), sel);

  // ------------------------------------------------ 1. sem login
  await ok('/t/:slug sem login: "Denunciar" abre a folha pedindo para entrar', async () => {
    const c = await newCtx(null); const p = await c.newPage();
    await p.goto(BASE + '/t/' + T.slug, { waitUntil: 'domcontentloaded' });
    await p.locator('[data-testid="report-open"]').click();
    await p.waitForSelector('[data-testid="report-login"]', { timeout: 10000 });
    await p.screenshot({ path: path.join(SHOTS, '1-denunciar-sem-login.png') });
    await c.close();
  });

  // ------------------------------------------------ 2. logado
  const cu = await newCtx(user); const pu = await cu.newPage();
  await ok('/t/:slug logado: Denunciar (rodapé) → folha de baixo com torneio + times, motivo, enviar → "recebida"; ≥ 44 px; sem rolagem lateral', async () => {
    await pu.goto(BASE + '/t/' + T.slug, { waitUntil: 'domcontentloaded' });
    const rb = await pu.locator('[data-testid="report-open"]').evaluate((b) => b.getBoundingClientRect().height);
    assert.ok(rb >= 44, 'botão do rodapé ' + rb);
    await pu.locator('[data-testid="report-open"]').click();
    await pu.waitForSelector('[data-testid="report-target"]', { timeout: 10000 });
    await pu.waitForFunction(() => [...document.querySelectorAll('[data-testid="report-target"] option')].some((o) => /^ENTRY\|/.test(o.value)), null, { timeout: 10000 });
    const sendDisabled = await pu.locator('[data-testid="report-send"]').isDisabled();
    assert.ok(sendDisabled, 'enviar só depois de escolher o motivo');
    await pu.locator('[data-testid="report-reasons"] button[data-r="SCAM"]').click();
    await pu.locator('[data-testid="report-text"]').fill('Pedindo PIX para inscrição falsa');
    assert.deepStrictEqual(await smallButtons(pu, '.cm-sh button'), []);
    assert.ok((await scrollW(pu)) <= 390, 'rolagem lateral');
    await pu.screenshot({ path: path.join(SHOTS, '2-denunciar-folha.png') });
    await pu.locator('[data-testid="report-send"]').click();
    await pu.waitForSelector('[data-testid="report-done"]', { timeout: 10000 });
    const row = await prisma.contentReport.findFirst({ where: { reporterId: user.id, targetType: 'TOURNAMENT', targetId: T.id } });
    assert.ok(row && row.reason === 'SCAM' && /PIX/.test(row.text));
    await pu.screenshot({ path: path.join(SHOTS, '3-denunciar-recebida.png') });
  });
  await ok('Denunciar num AVISO: o aviso vem pré-selecionado e a denúncia é do aviso', async () => {
    await pu.goto(BASE + '/t/' + T.slug, { waitUntil: 'domcontentloaded' });
    await pu.locator(`[data-report="post"][data-report-id="${post.id}"]`).click();
    await pu.waitForSelector('[data-testid="report-target"]', { timeout: 10000 });
    const v = await pu.locator('[data-testid="report-target"]').inputValue();
    assert.strictEqual(v, 'POST|' + post.id);
    await pu.locator('[data-testid="report-reasons"] button[data-r="OFFENSIVE"]').click();
    await pu.locator('[data-testid="report-send"]').click();
    await pu.waitForSelector('[data-testid="report-done"]', { timeout: 10000 });
    assert.ok(await prisma.contentReport.findFirst({ where: { reporterId: user.id, targetType: 'POST', targetId: post.id, status: 'OPEN' } }));
  });

  // ------------------------------------------------ 3. moderação
  await ok('/moderacao (usuário comum): "só o administrador"', async () => {
    const p = await cu.newPage();
    await p.goto(BASE + '/moderacao', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid="mod-denied"]', { timeout: 10000 });
    await p.close();
  });
  const ca = await newCtx(admin); const pa = await ca.newPage();
  await ok('/moderacao (admin): fila com as 2 denúncias → ocultar aviso (folha de confirmação) → some da fila e do mural', async () => {
    await pa.goto(BASE + '/moderacao', { waitUntil: 'domcontentloaded' });
    await pa.waitForSelector('[data-testid="report-card"]', { timeout: 15000 });
    assert.ok((await pa.locator('[data-testid="report-card"]').count()) >= 2);
    assert.deepStrictEqual(await smallButtons(pa, '.app button, nav.bn button'), []);
    assert.ok((await scrollW(pa)) <= 390, 'rolagem lateral');
    await pa.screenshot({ path: path.join(SHOTS, '4-moderacao-fila.png'), fullPage: true });
    const card = pa.locator('[data-testid="report-card"]', { hasText: 'Aviso para denunciar UI' });
    await card.locator('[data-testid="act-hide-post"]').click();
    await pa.waitForSelector('[data-testid="confirm-ok"]', { state: 'visible', timeout: 5000 });
    await pa.screenshot({ path: path.join(SHOTS, '5-moderacao-confirmar.png') });
    await pa.locator('[data-testid="confirm-ok"]').click();
    await pa.waitForFunction((pid) => !document.body.innerText.includes(pid), 'Aviso para denunciar UI', { timeout: 10000 });
    const p = await prisma.tournamentPost.findUnique({ where: { id: post.id } });
    assert.ok(p.hiddenAt, 'aviso oculto');
  });
  await ok('/moderacao (admin): suspender o torneio com motivo → some do público; aba Suspensos → Reativar', async () => {
    const card = pa.locator('[data-testid="report-card"]').first();
    await card.locator('[data-testid="act-suspend-t"]').click();
    await pa.waitForSelector('[data-testid="confirm-reason"]', { state: 'visible', timeout: 5000 });
    await pa.locator('[data-testid="confirm-reason"]').fill('golpe de PIX');
    await pa.locator('[data-testid="confirm-ok"]').click();
    let t = null;
    for (let i = 0; i < 30 && !(t && t.suspendedAt); i++) { await new Promise((r) => setTimeout(r, 300)); t = await prisma.tournament.findUnique({ where: { id: T.id } }); }
    assert.ok(t.suspendedAt && t.suspendedReason === 'golpe de PIX');
    assert.strictEqual((await get(BASE + '/t/' + T.slug)).status, 404);
    await pa.locator('[data-testid="tab-suspended"]').click();
    await pa.waitForSelector('[data-testid="act-unsuspend-t"]', { timeout: 10000 });
    await pa.screenshot({ path: path.join(SHOTS, '6-moderacao-suspensos.png'), fullPage: true });
    await pa.locator('[data-testid="act-unsuspend-t"]').first().click();
    for (let i = 0; i < 30 && t.suspendedAt; i++) { await new Promise((r) => setTimeout(r, 300)); t = await prisma.tournament.findUnique({ where: { id: T.id } }); }
    assert.strictEqual(t.suspendedAt, null);
    assert.strictEqual((await get(BASE + '/t/' + T.slug)).status, 200);
  });

  // ------------------------------------------------ 4. privacidade
  await ok('/privacidade-club: baixar meus dados → arquivo JSON (sem CPF em claro)', async () => {
    await pu.goto(BASE + '/privacidade-club', { waitUntil: 'domcontentloaded' });
    await pu.waitForSelector('[data-testid="privacy-export"]', { timeout: 10000 });
    assert.deepStrictEqual(await smallButtons(pu, 'button, a.btn'), []);
    assert.ok((await scrollW(pu)) <= 390);
    await pu.screenshot({ path: path.join(SHOTS, '7-privacidade.png'), fullPage: true });
    const [dl] = await Promise.all([pu.waitForEvent('download', { timeout: 15000 }), pu.locator('[data-testid="privacy-export"]').click()]);
    assert.strictEqual(dl.suggestedFilename(), 'meus-dados-club.json');
    const file = path.join(SHOTS, 'meus-dados-club.json');
    await dl.saveAs(file);
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    const cpf = (await prisma.user.findUnique({ where: { id: user.id }, select: { cpf: true } })).cpf;
    assert.ok(j.elenco.some((x) => x.nome === 'Jogador UI'));
    assert.ok(!txt.includes(cpf), 'CPF em claro');
    fs.rmSync(file, { force: true });
  });
  await ok('/privacidade-club: apagar — botão só libera com "APAGAR MEUS DADOS"; depois: dados esportivos apagados', async () => {
    await pu.locator('[data-testid="privacy-erase"]').click();
    await pu.waitForSelector('[data-testid="privacy-phrase"]', { state: 'visible', timeout: 5000 });
    assert.ok(await pu.locator('[data-testid="privacy-confirm"]').isDisabled());
    await pu.locator('[data-testid="privacy-phrase"]').fill('apagar');
    assert.ok(await pu.locator('[data-testid="privacy-confirm"]').isDisabled(), 'frase errada não libera');
    await pu.locator('[data-testid="privacy-phrase"]').fill('apagar meus dados');
    assert.ok(!(await pu.locator('[data-testid="privacy-confirm"]').isDisabled()));
    await pu.screenshot({ path: path.join(SHOTS, '8-privacidade-confirmar.png') });
    await pu.locator('[data-testid="privacy-confirm"]').click();
    await pu.waitForSelector('[data-testid="privacy-done"]', { timeout: 15000 });
    const rp = await prisma.rosterPlayer.findFirst({ where: { entryId: eA.id, number: 5 } });
    assert.strictEqual(rp.name, 'Atleta removido'); assert.strictEqual(rp.userId, null);
    await pu.screenshot({ path: path.join(SHOTS, '9-privacidade-feito.png') });
  });
  await ok('/privacidade-club (conta com saldo): avisa que o login fica; apagar mantém o saldo', async () => {
    const cr = await newCtx(rich); const p = await cr.newPage();
    await p.goto(BASE + '/privacidade-club', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid="privacy-kept"]', { timeout: 10000 });
    assert.ok(/saldo TenisCash/.test(await p.locator('[data-testid="privacy-kept"]').innerText()));
    await p.locator('[data-testid="privacy-erase"]').click();
    await p.locator('[data-testid="privacy-phrase"]').fill('APAGAR MEUS DADOS');
    await p.locator('[data-testid="privacy-confirm"]').click();
    await p.waitForSelector('[data-testid="privacy-done"]', { timeout: 15000 });
    assert.ok(/continua/.test(await p.locator('[data-testid="privacy-done"]').innerText()));
    const u = await prisma.user.findUnique({ where: { id: rich.id } });
    assert.strictEqual(u.balance, 10); assert.strictEqual(u.active, true);
    await cr.close();
  });

  await browser.close();
  child.kill();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F6 — tela (390 px): ${passed} ok, ${failed} falha(s)`);
    process.exit(failed ? 1 : 0);
  });
