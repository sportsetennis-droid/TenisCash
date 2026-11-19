'use strict';
// =====================================================================
// Liga Aberta F3 — teste de TELA do assistente "criar liga em 2 minutos".
// npm run test:liga-f3-ui
// Sobe o app real (src/index.js) num banco LOCAL descartável, abre /criar-liga
// num celular de 390 px (Playwright) e cronometra: esporte → modelo → 8 times
// colados → publicar. Dois caminhos: sem conta logada (entra no passo 4 e
// publica na sequência, sem perder o rascunho) e já logado. Confere layout
// mobile (sem rolagem lateral, botões >= 44 px, navegação inferior fixa) e que
// o rascunho sobrevive a recarregar a página. Screenshots: env SHOTS_DIR.
// Playwright: require('playwright') ou o módulo em PLAYWRIGHT_MODULE (ex.:
// playwright-core) + navegador em CHROME_PATH. Não roda contra produção.
// =====================================================================

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const assert = require('assert');
const { spawn } = require('child_process');

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

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('⏭️  Playwright não encontrado (defina PLAYWRIGHT_MODULE) — PULADO'); return; }
  const URL_DB = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB)) { console.log('⏭️  DATABASE_URL local não definido — PULADO'); return; }
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-f3-ui-' + crypto.randomBytes(6).toString('hex');
  const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'tmp', 'f3-ui');
  fs.mkdirSync(SHOTS, { recursive: true });

  const bcrypt = require('bcryptjs');
  const jwt = require('jsonwebtoken');
  const { prisma } = require('../src/middleware');
  const RUN = Date.now().toString(36);
  const phone = '837' + String(Date.now() % 100000000).padStart(8, '0');
  const user = await prisma.user.create({ data: { name: 'Organizador UI ' + RUN, phone, pin: await bcrypt.hash('senha123', 8) } });
  const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const PORT = 4500 + Math.floor(Math.random() * 80);
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
  const TEAMS = ['Leões', 'Tubarões', 'Águias', 'Falcões', 'Panteras', 'Lobos', 'Touros', 'Gaviões'].map((n) => `${n} ${RUN}`);
  const results = [];
  let failed = 0;

  async function scenario(label, { loggedIn }) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
    if (loggedIn) await ctx.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); } catch (_) {} }, token);
    const page = await ctx.newPage();
    const shot = async (n) => page.screenshot({ path: path.join(SHOTS, `${label}-${n}.png`) });
    const t0 = Date.now();
    await page.goto(BASE + '/criar-liga', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('sport-FUTSAL').waitFor();
    await shot('1-esporte');
    await page.getByTestId('sport-FUTSAL').tap();
    await page.getByTestId('preset-copa-grupos-mata-mata').waitFor();
    await shot('2-formato');
    await page.getByTestId('preset-copa-grupos-mata-mata').tap();
    await page.getByTestId('paste').fill(TEAMS.map((t) => t + (loggedIn ? ' L' : ' A')).join('\n'));
    await page.getByTestId('add-paste').tap();
    await page.waitForFunction(() => /\b8\b/.test(document.querySelector('[data-testid=count]').textContent));
    await shot('3-times');
    if (!loggedIn) {
      // rascunho sobrevive a recarregar (localStorage)
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('[data-testid=count]') && /\b8\b/.test(document.querySelector('[data-testid=count]').textContent));
    }
    await page.getByTestId('next').tap();
    await page.getByTestId('name').waitFor();
    if (!loggedIn) {
      await page.getByTestId('login-user').fill(phone);
      await page.getByTestId('login-pass').fill('senha123');
    }
    await shot('4-publicar');
    const layout = await page.evaluate(() => {
      const nb = document.querySelector('nav.bottom').getBoundingClientRect();
      const next = document.querySelector('[data-testid=next]').getBoundingClientRect();
      const small = [...document.querySelectorAll('button, a.btn, input, select')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim() || b.id).slice(0, 5);
      return { scrollW: document.documentElement.scrollWidth, navBottom: Math.round(nb.bottom), vh: window.innerHeight, nextH: Math.round(next.height), small };
    });
    await page.getByTestId('next').tap();
    await page.getByTestId('published').waitFor({ timeout: 30000 });
    const ms = Date.now() - t0;
    await shot('5-publicado');
    const link = await page.getByTestId('link').textContent();
    await ctx.close();
    const slug = link.split('/t/')[1];
    const t = await prisma.tournament.findUnique({ where: { slug }, include: { _count: { select: { entries: true, matches: true } } } });
    try {
      assert.ok(t, 'torneio não encontrado pelo link ' + link);
      assert.strictEqual(t.ownerId, user.id);
      assert.strictEqual(t._count.entries, 8);
      assert.strictEqual(t._count.matches, 12);
      assert.ok(layout.scrollW <= 390, 'rolagem lateral: ' + layout.scrollW);
      assert.ok(layout.nextH >= 44, 'botão principal < 44px');
      assert.strictEqual(layout.navBottom, layout.vh, 'navegação inferior não está colada embaixo');
      assert.deepStrictEqual(layout.small, [], 'alvos de toque < 44px: ' + layout.small.join(', '));
      assert.ok(ms < 120000, 'passou de 2 minutos');
      console.log(`  ✅ ${label}: 8 times publicados em ${(ms / 1000).toFixed(1)} s (link ${link}) — layout ok (390 px, botão ${layout.nextH}px)`);
    } catch (e) {
      failed++;
      console.error(`  ❌ ${label}: ${e.message}`);
    }
    results.push({ label, ms, link });
  }

  // Racha: presença → sorteio → placar rápido (+1 com a folha "quem fez?") no celular
  async function rachaScenario() {
    const q = await require('../src/services/quickTournament').createQuick({ userId: user.id, userRole: 'user', body: { sport: 'FUTSAL', preset: 'racha-semanal', teams: ['Ana', 'Bia', 'Caio', 'Duda'].map((n) => n + ' ' + RUN) } });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
    await ctx.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); localStorage.removeItem('racha_tab'); } catch (_) {} }, token);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const shot = async (n) => page.screenshot({ path: path.join(SHOTS, `racha-${n}.png`) });
    try {
      await page.goto(BASE + '/racha/' + q.tournament.slug, { waitUntil: 'domcontentloaded' });
      await page.locator('button.tog').first().waitFor();
      for (let i = 0; i < 4; i++) {
        await page.locator('button.tog:not(.in)').first().tap();
        await page.waitForFunction((n) => document.querySelectorAll('button.tog.in').length === n, i + 1);
      }
      await shot('1-presenca');
      await page.locator('nav.bottom button[data-tab=times]').tap();
      await page.locator('#draw').tap();
      await page.locator('.team').nth(1).waitFor();
      await shot('2-times');
      await page.locator('nav.bottom button[data-tab=placar]').tap();
      await page.locator('#newg').tap();
      await page.locator('[data-sc=home]').waitFor();
      await page.locator('[data-sc=home]').tap();
      await page.locator('#sheet [data-rp]').first().tap();
      await page.waitForFunction(() => /1\s*×\s*0/.test(document.querySelector('.score .n').textContent));
      await shot('3-placar');
      await page.locator('nav.bottom button[data-tab=artilharia]').tap();
      await page.locator('table, .card p.muted').first().waitFor();
      const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
      assert.ok(scrollW <= 390, 'rolagem lateral no racha: ' + scrollW);
      assert.deepStrictEqual(errors, [], 'erro de JS: ' + errors.join(' | '));
      console.log('  ✅ racha no celular: presença de 4, sorteio, jogo e +1 com autor — sem erro de JS, sem rolagem lateral');
    } catch (e) {
      failed++;
      await shot('erro').catch(() => {});
      console.error('  ❌ racha no celular: ' + e.message + (errors.length ? ' | JS: ' + errors.join(' | ') : ''));
    }
    await ctx.close();
  }

  // Súmula: alerta de falta vem da regra (categoria antiga = 6ª falta igual a antes; basquete = 5ª)
  async function sumulaScenario() {
    const errors = [];
    const mk = async (label, sport, gameRules, fouls) => {
      const t = await prisma.tournament.create({ data: { slug: 'f3-sum-' + label + '-' + RUN, name: 'Súmula ' + label, sport, format: 'ROUND_ROBIN', ownerId: user.id, status: 'ONGOING' } });
      const c = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Livre', gameRules: gameRules === null ? undefined : gameRules } });
      const h = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Casa ' + label } });
      const a = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'Fora ' + label } });
      const m = await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, stage: 'LEAGUE', round: 1, homeEntryId: h.id, awayEntryId: a.id, status: 'LIVE' } });
      for (let i = 0; i < fouls; i++) await prisma.matchEvent.create({ data: { matchId: m.id, entryId: h.id, type: 'FOUL', period: 1 } });
      return m;
    };
    const legacy = await mk('legado', 'FUTSAL', null, 6);
    const basket = await mk('basquete', 'BASKETBALL', require('../src/services/tournamentRules').defaultsFor('BASKETBALL'), 5);
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
    await ctx.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); localStorage.setItem('sum_period_x', '1'); } catch (_) {} }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(BASE + '/torneios.html#/sumula/' + legacy.id, { waitUntil: 'domcontentloaded' });
      await page.locator('.sc-al .alert').first().waitFor({ timeout: 20000 });
      const t1 = await page.locator('.sc-al').textContent();
      assert.ok(/6ª falta — tiro livre direto sem barreira/.test(t1), 'categoria antiga: ' + t1);
      const per1 = await page.locator('.seg.per button').allTextContents();
      assert.deepStrictEqual(per1, ['1º tempo', '2º tempo', 'Prorrogação'], 'períodos mudaram no legado');
      await page.screenshot({ path: path.join(SHOTS, 'sumula-legado.png') });
      await page.goto(BASE + '/torneios.html#/sumula/' + basket.id, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => /5ª falta/.test((document.querySelector('.sc-al') || {}).textContent || ''), null, { timeout: 20000 });
      const t2 = await page.locator('.sc-al').textContent();
      assert.ok(/5ª falta — lances livres/.test(t2), 'basquete: ' + t2);
      const per2 = await page.locator('.seg.per button').allTextContents();
      assert.deepStrictEqual(per2, ['1ºQ', '2ºQ', '3ºQ', '4ºQ', 'Prorr.']);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390, 'rolagem lateral na súmula');
      await page.locator('.prow').first().waitFor({ state: 'attached' }).catch(() => {});
      await page.screenshot({ path: path.join(SHOTS, 'sumula-basquete.png') });
      assert.deepStrictEqual(errors, [], 'erro de JS: ' + errors.join(' | '));
      console.log('  ✅ súmula: categoria antiga mostra a 6ª falta igual a antes; basquete mostra a 5ª (regra da categoria) e 4 quartos');
    } catch (e) {
      failed++;
      await page.screenshot({ path: path.join(SHOTS, 'sumula-erro.png') }).catch(() => {});
      console.error('  ❌ súmula: ' + e.message + (errors.length ? ' | JS: ' + errors.join(' | ') : ''));
    }
    await ctx.close();
  }

  try {
    await scenario('sem-login', { loggedIn: false });
    await scenario('logado', { loggedIn: true });
    await rachaScenario();
    await sumulaScenario();
  } finally {
    await browser.close();
    child.kill();
    await prisma.$disconnect();
  }
  console.log(`\nLiga F3 — tela: ${results.map((r) => `${r.label} ${(r.ms / 1000).toFixed(1)}s`).join(' · ')} · screenshots em ${SHOTS}`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error('ERRO', e); process.exit(1); });
