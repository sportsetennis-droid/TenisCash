'use strict';
// =====================================================================
// Liga Aberta F4 — teste de TELA (celular 390 px). npm run test:liga-f4-ui
// Sobe o app real (src/index.js) num banco LOCAL descartável e confere:
//  1. /t/:slug registra EventSource no /live e SÓ agenda a consulta de 20 s depois
//     que o SSE cai (EventSource falso controlado pelo teste); volta ao abrir de novo
//  2. Compartilhar abre o bottom-sheet com as imagens prontas (feed e story) e o link
//  3. "Entrar num time": time com link público → /convite-time; sem link → "Peça o link…"
//  4. "Criar minha liga" em /t/:slug e /atleta/:u (botão ≥ 44 px, sem rolagem lateral)
//  5. /atleta/:u: Compartilhar com o card pronto
//  6. Club → Notificações: interruptores por tipo × canal (celular, WhatsApp)
//  7. Súmula fechada (torneios.html): "Jogadores sem conta" com botão de WhatsApp
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

// EventSource falso + gravador de setTimeout(…, 20000): roda ANTES dos scripts da página
function initFakes() {
  window.__es = [];
  window.__poll = [];
  window.__cleared = [];
  class FakeES {
    constructor(url) { this.url = url; this.readyState = 0; window.__es.push(this); }
    close() { this.readyState = 2; }
  }
  window.EventSource = FakeES;
  const st = window.setTimeout.bind(window);
  const ct = window.clearTimeout.bind(window);
  window.setTimeout = function (fn, ms) { const id = st(fn, ms); if (ms === 20000) window.__poll.push(id); return id; };
  window.clearTimeout = function (id) { if (window.__poll.includes(id)) window.__cleared.push(id); return ct(id); };
  window.__fire = function (i, kind, rs) {
    const e = window.__es[i]; if (!e) return false;
    if (kind === 'open') { e.readyState = 1; e.onopen && e.onopen(); }
    if (kind === 'error') { e.readyState = rs == null ? 0 : rs; e.onerror && e.onerror(); }
    return true;
  };
}

async function main() {
  const pw = loadPlaywright();
  if (!pw) { console.log('⏭️  Playwright não encontrado (defina PLAYWRIGHT_MODULE) — PULADO'); return; }
  const URL_DB = process.env.DATABASE_URL || '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB)) { console.log('⏭️  DATABASE_URL local não definido — PULADO'); return; }
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-f4-ui-' + crypto.randomBytes(6).toString('hex');
  const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'tmp', 'f4-ui');
  fs.mkdirSync(SHOTS, { recursive: true });

  const jwt = require('jsonwebtoken');
  const { prisma } = require('../src/middleware');
  const gr = require('../src/services/tournamentRules');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  await ensureApexSchema(prisma);
  const RUN = Date.now().toString(36);
  let seq = 0;
  const mk = (label, extra = {}) => prisma.user.create({ data: { name: `UI F4 ${label} ${RUN}-${++seq}`, phone: '836' + String(Date.now() % 1000000).padStart(6, '0') + String(seq).padStart(2, '0'), pin: 'x', ...extra } });
  const org = await mk('organizador', { username: 'f4ui' + RUN });
  const token = jwt.sign({ userId: org.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  // torneio público: 2 times com clube, 1 jogo encerrado, 1 AO VIVO, link público no time A
  const T = await prisma.tournament.create({ data: { slug: 'f4ui-' + RUN, name: 'Copa Tela F4 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: org.id, status: 'ONGOING', visibility: 'public' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre', gameRules: gr.defaultsFor('FUTSAL') } });
  const cA = await prisma.club.create({ data: { ownerId: org.id, name: 'Leões ' + RUN, slug: 'leoes-ui-' + RUN, primaryColor: '#0E7C3A', secondaryColor: '#FFFFFF' } });
  const cB = await prisma.club.create({ data: { ownerId: org.id, name: 'Tubarões ' + RUN, slug: 'tub-ui-' + RUN } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'A ' + RUN, status: 'CONFIRMED', clubId: cA.id } });
  const eB = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'B ' + RUN, status: 'CONFIRMED', clubId: cB.id } });
  const pA = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Artilheiro', number: 9, userId: org.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Sem Conta Um', number: 4 } });
  await prisma.rosterPlayer.create({ data: { entryId: eB.id, name: 'Sem Conta Dois', number: 8 } });
  const mDone = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 1, homeEntryId: eA.id, awayEntryId: eB.id, status: 'LIVE', scheduledAt: new Date(Date.now() - 3600e3) } });
  await prisma.matchEvent.create({ data: { matchId: mDone.id, entryId: eA.id, playerId: pA.id, type: 'GOAL' } });
  await require('../src/services/matchSheet').finalizeMatch(mDone.id, {});
  await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 2, homeEntryId: eB.id, awayEntryId: eA.id, status: 'LIVE', scheduledAt: new Date() } });
  const inv = await require('../src/services/teamInvite').createInvite({ entryId: eA.id, userId: org.id, userRole: 'user', public: true });

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
  const layoutOf = (page, root) => page.evaluate((sel) => {
    const r = sel ? document.querySelector(sel) : document;
    const small = [...(r || document).querySelectorAll('button, a.btn, a.cm-btn, .cm-link button, a.cta-btn, a.act, button.act')]
      .filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 30));
    return { scrollW: document.documentElement.scrollWidth, small };
  }, root || null);

  // ------------------------------------------------ /t/:slug
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript(initFakes);
  const page = await ctx.newPage();
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  await page.goto(BASE + '/t/' + T.slug, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#catbody [id^="m-"]', { timeout: 30000 }); // jogos carregados (DATA pronto)
  await page.waitForTimeout(500);

  await ok('/t/:slug registra EventSource no /live e NÃO agenda a consulta de 20 s enquanto o SSE conecta/está aberto', async () => {
    const st = await page.evaluate(() => ({ es: window.__es.map((e) => e.url), poll: window.__poll.length }));
    assert.strictEqual(st.es.length, 1, JSON.stringify(st));
    assert.ok(st.es[0].endsWith('/api/tournaments/' + encodeURIComponent(T.id) + '/live') || st.es[0].includes('/live'), st.es[0]);
    assert.strictEqual(st.poll, 0, 'consultou com o SSE conectando');
    await page.evaluate(() => window.__fire(0, 'open'));
    await page.waitForTimeout(300);
    assert.strictEqual(await page.evaluate(() => window.__poll.length), 0, 'consultou com o SSE aberto');
  });
  await ok('SSE caiu → consulta de 20 s agendada; SSE voltou → consulta cancelada', async () => {
    await page.evaluate(() => window.__fire(0, 'error', 0));
    await page.waitForTimeout(200);
    const p = await page.evaluate(() => ({ poll: window.__poll.length, dot: document.getElementById('livedot').style.display }));
    assert.ok(p.poll >= 1, 'não voltou para a consulta: ' + JSON.stringify(p));
    await page.evaluate(() => window.__fire(0, 'open'));
    await page.waitForTimeout(200);
    const c = await page.evaluate(() => ({ cleared: window.__cleared.length, poll: window.__poll.length }));
    assert.ok(c.cleared >= 1, 'consulta não foi cancelada ao voltar: ' + JSON.stringify(c));
  });
  await shot('1-torneio');
  await ok('"Criar minha liga" e "Entrar num time" visíveis, ≥ 44 px, sem rolagem lateral', async () => {
    const cta = page.getByTestId('criar-liga');
    assert.strictEqual(await cta.getAttribute('href'), '/criar-liga');
    const bb = await cta.boundingBox();
    assert.ok(bb && bb.height >= 44, 'cta < 44');
    const jb = await page.getByTestId('join-btn').boundingBox();
    assert.ok(jb && jb.height >= 44);
    const l = await layoutOf(page);
    assert.ok(l.scrollW <= 390, 'rolagem lateral: ' + l.scrollW);
  });
  await ok('Compartilhar abre o bottom-sheet com imagens prontas (feed) e o link da liga', async () => {
    await page.locator('[data-m="share"]').tap();
    await page.getByTestId('share-sheet').waitFor({ state: 'attached' });
    const link = await page.getByTestId('share-link').inputValue();
    assert.strictEqual(link, BASE + '/t/' + T.slug);
    for (const k of ['resultado', 'tabela', 'artilharia', 'torneio']) await page.getByTestId('share-img-' + k).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-th img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 3, null, { timeout: 30000 });
    const dims = await page.evaluate(() => [...document.querySelectorAll('.cm-th img')].filter((i) => i.naturalWidth).map((i) => [i.naturalWidth, i.naturalHeight]));
    assert.ok(dims.every(([w, h]) => w === 1080 && h === 1350), 'feed: ' + JSON.stringify(dims));
    const wa = await page.getByTestId('share-wa').getAttribute('href');
    assert.ok(wa.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes('/t/' + T.slug));
    const l = await layoutOf(page, '.cm-sh');
    assert.deepStrictEqual(l.small, [], 'botões < 44px: ' + l.small);
    assert.ok(l.scrollW <= 390);
  });
  await page.waitForTimeout(400);
  await shot('2-compartilhar-feed');
  await ok('trocar para STORY recarrega as imagens no formato 1080×1920', async () => {
    await page.getByTestId('share-fmt-story').tap();
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-th img')].filter((i) => i.complete && i.naturalHeight === 1920).length >= 3, null, { timeout: 30000 });
    assert.ok(await page.evaluate(() => document.querySelector('.cm-th').classList.contains('st')));
  });
  await page.waitForTimeout(300);
  await shot('3-compartilhar-story');
  await ok('Copiar copia o link (ou avisa) sem quebrar', async () => {
    await page.getByTestId('share-copy').tap();
    await page.waitForFunction(() => /copiado|Copie/.test((document.querySelector('.cm-toast') || {}).textContent || ''), null, { timeout: 5000 });
  });
  await page.evaluate(() => window.ClubMidia.close());
  await page.waitForTimeout(300);
  await ok('"Entrar num time": time com link público → Entrar neste time; sem link → "Peça o link ao responsável do time"', async () => {
    await page.getByTestId('join-btn').tap();
    await page.getByTestId('join-team').waitFor({ timeout: 10000 });
    const href = await page.getByTestId('join-team').getAttribute('href');
    assert.strictEqual(href, '/convite-time/' + inv.token);
    const ask = await page.getByTestId('join-ask').textContent();
    assert.ok(/Peça o link ao responsável do time/.test(ask), ask);
    const bb = await page.getByTestId('join-team').boundingBox();
    assert.ok(bb.height >= 44);
  });
  await page.waitForTimeout(300);
  await shot('4-entrar-num-time');
  await ctx.close();

  // ------------------------------------------------ /atleta/:u
  const ctx2 = await browser.newContext(ctxOpts);
  const pa = await ctx2.newPage();
  await pa.goto(BASE + '/atleta/' + org.username, { waitUntil: 'domcontentloaded' });
  await ok('/atleta: "Criar minha liga" + Compartilhar com o card pronto (feed 1080×1350)', async () => {
    assert.strictEqual(await pa.getByTestId('criar-liga').getAttribute('href'), '/criar-liga');
    await pa.locator('#shareBtn').tap();
    await pa.getByTestId('share-img-atleta').waitFor();
    await pa.waitForFunction(() => { const i = document.querySelector('.cm-th img'); return i && i.complete && i.naturalWidth === 1080; }, null, { timeout: 30000 });
    assert.strictEqual(await pa.getByTestId('share-link').inputValue(), BASE + '/atleta/' + org.username);
    const l = await layoutOf(pa, '.cm-sh');
    assert.deepStrictEqual(l.small, []);
  });
  await pa.waitForTimeout(300);
  await pa.screenshot({ path: path.join(SHOTS, '5-atleta-compartilhar.png') });
  await ctx2.close();

  // ------------------------------------------------ Club: preferências por tipo × canal
  const ctx3 = await browser.newContext(ctxOpts);
  await ctx3.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); } catch (_) {} }, token);
  const pc = await ctx3.newPage();
  await pc.goto(BASE + '/club.html#/perfil', { waitUntil: 'domcontentloaded' });
  await ok('Club → Notificações: grade tipo × canal; WhatsApp começa desligado e liga só o tipo escolhido', async () => {
    await pc.locator('[data-act="pushset"]').first().waitFor({ timeout: 20000 });
    await pc.locator('[data-act="pushset"]').first().tap();
    await pc.getByTestId('prefs-grid').waitFor({ timeout: 15000 });
    const wa = await pc.evaluate(() => [...document.querySelectorAll('[data-act="pwa"]')].map((i) => [i.getAttribute('data-k'), i.checked]));
    assert.ok(wa.length >= 8 && wa.every(([, c]) => c === false), JSON.stringify(wa));
    const sz = await pc.evaluate(() => [...document.querySelectorAll('.pgr .c')].map((c) => Math.round(c.getBoundingClientRect().height)));
    assert.ok(sz.every((h) => h >= 44), 'alvo < 44px: ' + sz);
    await pc.getByTestId('pref-wa-result').tap();
    await pc.waitForFunction(() => /WhatsApp ligado/.test((document.querySelector('.toast') || document.body).textContent || ''), null, { timeout: 8000 }).catch(() => {});
    await pc.waitForTimeout(600);
    const row = await prisma.clubNotifyPref.findUnique({ where: { userId: org.id } });
    assert.ok(row && row.whatsapp && row.whatsapp.result === true && row.whatsapp.game_soon === false, JSON.stringify(row));
    const l = await layoutOf(pc);
    assert.ok(l.scrollW <= 390, 'rolagem lateral ' + l.scrollW);
  });
  await pc.waitForTimeout(300);
  await pc.screenshot({ path: path.join(SHOTS, '6-club-preferencias.png') });
  await ctx3.close();

  // ------------------------------------------------ súmula fechada: jogadores sem conta
  const ctx4 = await browser.newContext(ctxOpts);
  await ctx4.addInitScript((tk) => { try { localStorage.setItem('tc_token', tk); localStorage.setItem('tc_admin_token', tk); } catch (_) {} }, token);
  const ps = await ctx4.newPage();
  await ps.goto(BASE + '/torneios.html#sumula/' + mDone.id, { waitUntil: 'domcontentloaded' });
  await ok('súmula fechada: "Jogadores sem conta" → Preparar convites → botão de WhatsApp (wa.me) por jogador', async () => {
    await ps.getByTestId('unclaimed-box').waitFor({ timeout: 20000 });
    await ps.getByTestId('unclaimed-prepare').waitFor({ timeout: 15000 });
    await ps.getByTestId('unclaimed-prepare').tap();
    await ps.getByTestId('unclaimed-wa').first().waitFor({ timeout: 15000 });
    const hrefs = await ps.evaluate(() => [...document.querySelectorAll('[data-testid=unclaimed-wa]')].map((a) => a.getAttribute('href')));
    assert.strictEqual(hrefs.length, 2);
    assert.ok(hrefs.every((h) => h.startsWith('https://wa.me/?text=') && decodeURIComponent(h).includes('/convite-elenco/')));
    const outbox = await prisma.whatsAppOutbox.count({ where: { createdAt: { gte: new Date(Date.now() - 600e3) }, body: { contains: 'convite-elenco' } } });
    assert.strictEqual(outbox, 0, 'o sistema enfileirou WhatsApp de convite');
  });
  await ps.waitForTimeout(300);
  await ps.evaluate(() => { const b = document.getElementById('unc-box'); if (b) b.scrollIntoView({ block: 'center' }); });
  await ps.waitForTimeout(300);
  await ps.screenshot({ path: path.join(SHOTS, '7-sumula-sem-conta.png') });
  await ctx4.close();

  await browser.close();
  child.kill();
  await prisma.$disconnect();
  console.log('  screenshots: ' + SHOTS);
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F4 — tela: ${passed} ok, ${failed} falha(s)`);
    process.exit(failed ? 1 : 0);
  });
