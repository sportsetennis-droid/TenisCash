'use strict';
// =====================================================================
// Liga Aberta F7 — teste de TELA (celular 390 px). npm run test:liga-f7-ui
// Sobe o app real (src/index.js) num banco LOCAL descartável e confere:
//  1. Painel do torneio (fundador): card "TenisCash por conquista" → folha com as regras,
//     aviso "desligado", salvar rascunho, SEM botão de pagar (TenisCash desligado)
//  2. Inscritos (organizador): botão da camisa → folha "Orçamento de uniforme" com escudo,
//     cores e nº de atletas; sem a autorização não envia; com ela cria o lead (e não manda
//     mensagem); 2º toque não duplica
//  3. Meu time (admin do time): botão "Pedir orçamento de uniforme"
//  4. Meu plano: planos por tamanho sem preço, "Fale com a gente para ampliar" (folha),
//     bloco do admin troca o plano de um organizador
// Botões ≥ 44 px, sem rolagem lateral. Screenshots em SHOTS_DIR. Playwright: require('playwright')
// ou PLAYWRIGHT_MODULE (ex.: playwright-core) + CHROME_PATH. Não roda contra produção. Fora do CI.
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
  for (const m of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean)) { try { return require(m); } catch (_) { /* próximo */ } }
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
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-f7-ui-' + crypto.randomBytes(6).toString('hex');
  const SHOTS = process.env.SHOTS_DIR || path.join(__dirname, '..', 'tmp', 'f7-ui');
  fs.mkdirSync(SHOTS, { recursive: true });

  const jwt = require('jsonwebtoken');
  const sharp = require('sharp');
  const { prisma } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const mediaStore = require('../src/services/mediaStore');
  await ensureApexSchema(prisma);
  const RUN = Date.now().toString(36);
  let seq = 0;
  const mk = (label, extra = {}) => prisma.user.create({ data: { name: `UI F7 ${label} ${RUN}-${++seq}`, phone: '834' + String(Date.now() % 1000000).padStart(6, '0') + String(seq).padStart(2, '0'), pin: 'x', ...extra } });
  const owner = await mk('fundador');
  const teamAdmin = await mk('admin do time');
  const admin = await mk('admin', { role: 'admin' });
  const org = await mk('organizador', { username: 'f7uiorg' + RUN });
  const tk = (u) => jwt.sign({ userId: u.id }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const crestBuf = await sharp({ create: { width: 48, height: 48, channels: 3, background: { r: crypto.randomInt(256), g: 120, b: 40 } } }).png().toBuffer();
  const crest = await mediaStore.putBuffer(crestBuf, { ownerUserId: owner.id });
  const T = await prisma.tournament.create({ data: { slug: 'f7ui-' + RUN, name: 'Copa UI F7 ' + RUN, sport: 'FUTSAL', format: 'KNOCKOUT', ownerId: owner.id, status: 'ONGOING', visibility: 'public' } });
  const club = await prisma.club.create({ data: { name: 'Falcões UI ' + RUN, slug: 'f7ui-falcoes-' + RUN, ownerId: owner.id, crestUrl: crest.url, primaryColor: '#0A3D91', secondaryColor: '#FFFFFF', originTournamentId: T.id } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre' } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Falcões UI ' + RUN, status: 'CONFIRMED', clubId: club.id } });
  await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Corujas UI ' + RUN, status: 'CONFIRMED' } });
  await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: teamAdmin.id, role: 'TEAM_ADMIN', entryId: eA.id } });
  for (let i = 1; i <= 9; i++) await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Jogador ' + i, number: i } });

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
  const pageAs = async (u) => { const ctx = await browser.newContext(ctxOpts); await ctx.addInitScript((t) => { try { localStorage.setItem('tc_token', t); } catch (_) {} }, tk(u)); return ctx.newPage(); };
  const sheetButtonsOk = (page) => page.evaluate(() => {
    const small = [...document.querySelectorAll('#sheet button.btn, #sheet a.btn')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).map((b) => b.textContent.trim().slice(0, 30));
    return { small, scrollW: document.documentElement.scrollWidth };
  });
  const toastText = async (page) => { await page.waitForFunction(() => document.getElementById('toast').classList.contains('on'), null, { timeout: 10000 }); return page.locator('#toast').innerText(); };
  // espera o aviso com o texto esperado (o anterior pode ainda estar na tela)
  const toastMatch = async (page, rx) => { await page.waitForFunction((src) => new RegExp(src).test(document.getElementById('toast').textContent || ''), rx.source, { timeout: 15000 }); return true; };

  const po = await pageAs(owner);
  await ok('Painel (fundador): card TenisCash por conquista → folha com regras, aviso "desligado", salvar rascunho, sem botão de pagar', async () => {
    await po.goto(BASE + '/torneios.html#t/' + T.id, { waitUntil: 'domcontentloaded' });
    await po.waitForSelector('[data-testid="cash-card"]', { timeout: 20000 });
    await po.locator('[data-testid="cash-card"] button').click();
    await po.waitForSelector('[data-testid="cash-off"]', { timeout: 15000 });
    assert.strictEqual(await po.locator('[data-testid="cash-pay"]').count(), 0, 'botão de pagar com TenisCash desligado');
    await po.fill('[data-testid="cash-in-TITLE"]', '15');
    await po.locator('[data-testid="cash-save"]').click();
    const t = await toastText(po);
    assert.ok(/teto|salvo/i.test(t), t);
    const row = await prisma.tournamentCashConfig.findUnique({ where: { tournamentId: T.id } });
    assert.strictEqual(row.rules.TITLE.amount, 15);
    const lay = await sheetButtonsOk(po);
    assert.deepStrictEqual(lay.small, []); assert.ok(lay.scrollW <= 390, 'rolagem lateral: ' + lay.scrollW);
    await po.screenshot({ path: path.join(SHOTS, '1-tenischash-conquista.png') });
  });
  await ok('Inscritos (organizador): camisa → folha do orçamento com escudo/cores/atletas; sem autorização não envia; com ela cria 1 lead; 2º toque não duplica', async () => {
    await po.goto(BASE + '/torneios.html?r=2#t/' + T.id, { waitUntil: 'domcontentloaded' }); // recarrega (fecha a folha anterior)
    await po.waitForSelector('[data-act="open-cat"]', { timeout: 20000 });
    await po.locator('[data-act="open-cat"]').first().click();
    await po.waitForSelector('[data-testid="uni-btn"]', { timeout: 15000 });
    const bh = await po.locator('[data-testid="uni-btn"]').first().evaluate((b) => b.getBoundingClientRect().height);
    assert.ok(bh >= 44, 'botão da camisa ' + bh);
    await po.locator('[data-testid="uni-btn"]').first().click();
    await po.waitForSelector('[data-testid="uni-send"]', { timeout: 15000 });
    assert.strictEqual(await po.inputValue('#uq-colors'), '#0A3D91 / #FFFFFF');
    assert.strictEqual(await po.inputValue('#uq-n'), '9');
    assert.ok(/\/media\//.test(await po.locator('#sheet img').getAttribute('src')), 'escudo por /media');
    await po.screenshot({ path: path.join(SHOTS, '2-orcamento-uniforme.png') });
    await po.locator('[data-testid="uni-send"]').click();
    assert.ok(await toastMatch(po, /autorização/));
    assert.strictEqual(await prisma.mfLead.count({ where: { requestedByUserId: owner.id } }), 0);
    await po.locator('[data-testid="uni-consent"]').check();
    await po.locator('[data-testid="uni-send"]').click();
    assert.ok(await toastMatch(po, /Meta Fardamentos/));
    const leads = await prisma.mfLead.findMany({ where: { requestedByUserId: owner.id } });
    assert.strictEqual(leads.length, 1); assert.strictEqual(leads[0].source, 'liga'); assert.strictEqual(leads[0].athleteCount, 9);
    // 2º toque: a folha avisa e o servidor não duplica
    await po.locator('[data-testid="uni-btn"]').first().click();
    await po.waitForSelector('[data-testid="uni-recent"]', { timeout: 15000 });
    await po.locator('[data-testid="uni-consent"]').check();
    await po.locator('[data-testid="uni-send"]').click();
    assert.ok(await toastMatch(po, /já pediu/));
    assert.strictEqual(await prisma.mfLead.count({ where: { requestedByUserId: owner.id } }), 1);
    assert.strictEqual(await prisma.whatsAppOutbox.count({ where: { userId: owner.id } }).catch(() => 0), 0, 'nada enviado');
  });
  await ok('Meu time (admin do time): botão "Pedir orçamento de uniforme" abre a folha', async () => {
    const pt = await pageAs(teamAdmin);
    await pt.goto(BASE + '/torneios.html#t/' + T.id, { waitUntil: 'domcontentloaded' });
    await pt.waitForSelector('[data-testid="uni-myteam"]', { timeout: 20000 });
    const h = await pt.locator('[data-testid="uni-myteam"]').evaluate((b) => b.getBoundingClientRect().height);
    assert.ok(h >= 44, 'altura ' + h);
    await pt.locator('[data-testid="uni-myteam"]').click();
    await pt.waitForSelector('[data-testid="uni-send"]', { timeout: 15000 });
    const sw = await pt.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, 'rolagem lateral: ' + sw);
    await pt.screenshot({ path: path.join(SHOTS, '3-meu-time-uniforme.png') });
  });
  await ok('Meu plano: planos por tamanho SEM preço + "Fale com a gente para ampliar" (folha, sem cobrança)', async () => {
    await po.goto(BASE + '/torneios.html#plano', { waitUntil: 'domcontentloaded' });
    await po.waitForSelector('[data-testid="plan-tiers"]', { timeout: 20000 });
    const txt = await po.locator('[data-testid="plan-tiers"]').innerText();
    assert.ok(/Grátis/.test(txt) && /Pequeno/.test(txt) && /Médio/.test(txt) && /Grande/.test(txt), txt);
    assert.ok(!/R\$|preço|mensalidade|cartão|pix/i.test(await po.locator('#app').innerText()), 'sem preço/checkout');
    assert.strictEqual(await po.locator('[data-testid="plan-admin"]').count(), 0, 'bloco do admin só para admin');
    const h = await po.locator('[data-testid="plan-contact"]').evaluate((b) => b.getBoundingClientRect().height);
    assert.ok(h >= 44, 'altura ' + h);
    await po.locator('[data-testid="plan-contact"]').click();
    await po.waitForFunction(() => document.getElementById('sheetbg').classList.contains('on'));
    assert.ok(/Ampliar o plano/.test(await po.locator('#sheet').innerText()));
    const sw = await po.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 390, 'rolagem lateral: ' + sw);
    await po.screenshot({ path: path.join(SHOTS, '4-meu-plano-tamanhos.png'), fullPage: true });
  });
  await ok('Meu plano (admin global): troca o plano de um organizador pelo @ (registro no servidor)', async () => {
    const pa = await pageAs(admin);
    await pa.goto(BASE + '/torneios.html#plano', { waitUntil: 'domcontentloaded' });
    await pa.waitForSelector('[data-testid="plan-admin"]', { timeout: 20000 });
    await pa.fill('#pa-who', '@f7uiorg' + RUN);
    await pa.selectOption('#pa-plan', 'medio');
    await pa.fill('#pa-note', 'liga grande de bairro');
    await pa.locator('[data-act="plan-assign"]').click();
    assert.ok(/Médio/.test(await toastText(pa)));
    const sub = await prisma.organizerSubscription.findUnique({ where: { userId: org.id } });
    assert.strictEqual(sub.planKey, 'medio');
    assert.strictEqual(await prisma.organizerPlanLog.count({ where: { userId: org.id, actorId: admin.id } }), 1);
    await pa.screenshot({ path: path.join(SHOTS, '5-admin-troca-plano.png'), fullPage: true });
  });

  await browser.close();
  child.kill();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F7 — tela (390 px): ${passed} ok, ${failed} falha(s)`);
    process.exit(failed ? 1 : 0);
  });
