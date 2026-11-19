'use strict';
// =====================================================================
// Liga Aberta F5 — teste de TELA (celular 390 px). npm run test:liga-f5-ui
// Sobe o app real (src/index.js) num banco LOCAL descartável e confere:
//  1. torneios.html → Vitrine: 20 torneios + "Ver mais torneios" (cursor) → 25, botão some
//  2. torneios.html → Meu plano: uso × limite (torneios, avisos, imagens), sem preço,
//     sem rolagem lateral, botões ≥ 44 px
//  3. /t/:slug: mural com 20 avisos + "Ver mais avisos" → 25 (imagem do aviso por /media)
//  4. /atleta/:u (beach tennis): card sem "Gols"; "Ver mais campeonatos" → 22
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
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-f5-ui-' + crypto.randomBytes(6).toString('hex');
  const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'tmp', 'f5-ui');
  fs.mkdirSync(SHOTS, { recursive: true });

  const jwt = require('jsonwebtoken');
  const sharp = require('sharp');
  const { prisma } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const mediaStore = require('../src/services/mediaStore');
  await ensureApexSchema(prisma);
  const RUN = Date.now().toString(36);
  let seq = 0;
  const mk = (label, extra = {}) => prisma.user.create({ data: { name: `UI F5 ${label} ${RUN}-${++seq}`, phone: '835' + String(Date.now() % 1000000).padStart(6, '0') + String(seq).padStart(2, '0'), pin: 'x', ...extra } });
  const org = await mk('organizador', { username: 'f5ui' + RUN });
  const token = jwt.sign({ userId: org.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // vitrine: 25 torneios públicos (marcados pela loja-sede de teste)
  const STORE = 'f5ui-' + RUN;
  for (let i = 0; i < 25; i++) await prisma.tournament.create({ data: { slug: STORE + '-v' + i, name: 'Vitrine UI ' + i, sport: 'FUTSAL', ownerId: org.id, status: 'OPEN', visibility: 'public', storeId: STORE, startDate: new Date(Date.UTC(2026, 10, 1 + i)) } });
  // mural: 25 avisos (1 com imagem)
  const T = await prisma.tournament.create({ data: { slug: 'f5ui-mural-' + RUN, name: 'Mural UI ' + RUN, sport: 'FUTSAL', ownerId: org.id, status: 'ONGOING', visibility: 'public' } });
  const img = await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: crypto.randomInt(256), g: crypto.randomInt(256), b: 30 } } }).png().toBuffer(); // única por execução
  const put = await mediaStore.putBuffer(img, { ownerUserId: org.id });
  for (let i = 0; i < 25; i++) await prisma.tournamentPost.create({ data: { tournamentId: T.id, body: 'Aviso número ' + i, imageUrl: i === 24 ? put.url : null, createdAt: new Date(Date.now() - (25 - i) * 60000) } });
  // atleta de beach tennis em 22 campeonatos encerrados
  const ath = await mk('beach', { username: 'f5uibt' + RUN });
  const rival = await mk('rival');
  for (let i = 0; i < 22; i++) {
    const t = await prisma.tournament.create({ data: { slug: 'f5ui-bt-' + RUN + '-' + i, name: 'Open Beach ' + i, sport: 'BEACH_TENNIS', ownerId: org.id, status: 'FINISHED', visibility: 'public', startDate: new Date(Date.UTC(2026, 0, 1 + i)) } });
    const c = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Simples' } });
    const e1 = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Atleta ' + i, status: 'CONFIRMED' } });
    const e2 = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Rival ' + i, status: 'CONFIRMED' } });
    await prisma.entryMember.createMany({ data: [{ entryId: e1.id, userId: ath.id }, { entryId: e2.id, userId: rival.id }] });
    await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, stage: 'LEAGUE', round: 1, homeEntryId: e1.id, awayEntryId: e2.id, status: 'FINISHED', homeScore: 2, awayScore: i % 3 ? 0 : 2, winnerEntryId: i % 3 ? e1.id : null, scheduledAt: new Date(Date.UTC(2026, 0, 1 + i)) } });
  }

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
  const ctxOpts = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' };
  const layoutOf = (page) => page.evaluate(() => {
    const small = [...document.querySelectorAll('button, a.btn, a.linkrow')]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44 && !b.closest('.chips') && !b.closest('nav'))
      .map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30));
    return { scrollW: document.documentElement.scrollWidth, small };
  });

  // ------------------------------------------------ torneios.html (logado)
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); } catch (_) {} }, token);
  const page = await ctx.newPage();
  // a vitrine lista todos os públicos; filtra pela sede do teste interceptando a URL (sem mexer no front)
  await page.route(/\/api\/tournaments\/?\?limit=20/, (route) => route.continue({ url: route.request().url().replace('?limit=20', '?storeId=' + STORE + '&limit=20') }));
  await ok('Vitrine: 20 torneios + "Ver mais torneios" → 25 (cursor), botão some no fim; botão ≥ 44 px', async () => {
    await page.goto(BASE + '/torneios.html#vitrine', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vit-more"]', { timeout: 20000 });
    assert.strictEqual(await page.locator('#vgrid .vcard').count(), 20);
    const h = await page.locator('[data-testid="vit-more"]').evaluate((b) => b.getBoundingClientRect().height);
    assert.ok(h >= 44, 'altura do botão ' + h);
    await page.screenshot({ path: path.join(SHOTS, '1-vitrine.png') });
    await page.locator('[data-testid="vit-more"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#vgrid .vcard').length === 25, null, { timeout: 15000 });
    assert.strictEqual(await page.locator('[data-testid="vit-more"]').count(), 0);
    const ids = await page.locator('#vgrid .vcard').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
    assert.strictEqual(new Set(ids).size, 25, 'sem repetir');
    const lay = await layoutOf(page);
    assert.ok(lay.scrollW <= 390, 'rolagem lateral: ' + lay.scrollW);
    await page.screenshot({ path: path.join(SHOTS, '2-vitrine-mais.png'), fullPage: true });
  });
  await ok('Meu plano: uso × limite (torneios ativos, avisos e imagens do mês), sem preço, celular sem rolagem lateral', async () => {
    await page.goto(BASE + '/torneios.html#plano', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="plan-card"]', { timeout: 20000 });
    const txt = await page.locator('[data-testid="plan-card"]').innerText();
    assert.ok(/Plano Grátis/.test(txt), txt);
    assert.ok(/Torneios ativos/.test(txt) && /Avisos no mural este mês/.test(txt) && /Imagens enviadas este mês/.test(txt));
    const act = await page.locator('[data-testid="plan-activeTournaments"]').innerText();
    assert.ok(/^\d+ de \d+$/.test(act.trim()), 'uso × limite: ' + act);
    const img1 = await page.locator('[data-testid="plan-imagesPerMonth"]').innerText();
    assert.ok(/^1 de /.test(img1.trim()), 'imagem do aviso conta: ' + img1);
    assert.ok(!/R\$|preço|mensalidade/i.test(await page.locator('#app').innerText()), 'sem preço na tela');
    const lay = await layoutOf(page);
    assert.ok(lay.scrollW <= 390, 'rolagem lateral: ' + lay.scrollW);
    await page.screenshot({ path: path.join(SHOTS, '3-meu-plano.png'), fullPage: true });
  });
  await ok('Início (celular): atalho "Meu plano" leva à tela do plano', async () => {
    await page.goto(BASE + '/torneios.html#', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="plan-link"]', { timeout: 20000 });
    await page.locator('[data-testid="plan-link"]').click();
    await page.waitForSelector('[data-testid="plan-card"]', { timeout: 15000 });
  });

  // ------------------------------------------------ /t/:slug (público)
  const pub = await browser.newContext(ctxOpts);
  const pt = await pub.newPage();
  await ok('/t/:slug: mural com 20 avisos + "Ver mais avisos" → 25 (com a imagem por /media)', async () => {
    await pt.goto(BASE + '/t/' + T.slug, { waitUntil: 'domcontentloaded' });
    assert.strictEqual(await pt.locator('#mural .post').count(), 20);
    const b = pt.locator('[data-testid="mural-more"]');
    assert.ok((await b.evaluate((x) => x.getBoundingClientRect().height)) >= 44);
    await b.click();
    await pt.waitForFunction(() => document.querySelectorAll('#mural .post').length === 25, null, { timeout: 15000 });
    assert.strictEqual(await pt.locator('[data-testid="mural-more"]').count(), 0);
    const srcs = await pt.locator('#mural .post-img').evaluateAll((els) => els.map((e) => e.getAttribute('src')));
    assert.ok(srcs.length >= 1 && srcs.every((s) => /^\/media\/[a-f0-9]{64}\.png$/.test(s)), JSON.stringify(srcs));
    const loaded = await pt.locator('#mural .post-img').first().evaluate((im) => new Promise((r) => (im.complete ? r(im.naturalWidth) : im.addEventListener('load', () => r(im.naturalWidth)))));
    assert.strictEqual(loaded, 64, 'imagem do /media carregou');
    const sw = await pt.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, 'rolagem lateral: ' + sw);
    await pt.screenshot({ path: path.join(SHOTS, '4-mural-mais.png'), fullPage: true });
  });

  // ------------------------------------------------ /atleta/:u (beach tennis)
  await ok('/atleta (beach tennis): card sem "Gols"/"Assist.", com aproveitamento; "Ver mais campeonatos" → 22', async () => {
    await pt.goto(BASE + '/atleta/' + ath.username, { waitUntil: 'domcontentloaded' });
    const labels = await pt.locator('.grid .sc-l').allInnerTexts();
    const up = labels.map((l) => l.toUpperCase());
    assert.ok(!up.includes('GOLS') && !up.includes('ASSIST.'), labels.join(','));
    assert.ok(up.includes('APROVEIT.'), labels.join(','));
    await pt.locator('.htab[data-v="camp"]').click();
    assert.strictEqual(await pt.locator('#hist .hrow').count(), 20);
    const mb = pt.locator('[data-testid="hist-more"]');
    assert.ok((await mb.evaluate((x) => x.getBoundingClientRect().height)) >= 44);
    await mb.click();
    await pt.waitForFunction(() => document.querySelectorAll('#hist .hrow').length === 22, null, { timeout: 15000 });
    assert.strictEqual(await pt.locator('[data-testid="hist-more"]').count(), 0);
    const names = await pt.locator('#hist .hrow b').allInnerTexts();
    assert.strictEqual(new Set(names).size, 22, 'sem repetir');
    const sw = await pt.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, 'rolagem lateral: ' + sw);
    await pt.screenshot({ path: path.join(SHOTS, '5-atleta-mais.png'), fullPage: true });
  });

  await browser.close();
  child.kill();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F5 — tela (390 px): ${passed} ok, ${failed} falha(s)`);
    process.exit(failed ? 1 : 0);
  });
