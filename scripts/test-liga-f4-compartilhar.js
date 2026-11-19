'use strict';
// =====================================================================
// Liga Aberta — FASE 4 (compartilhar e voltar). npm run test:liga-f4
//
// Parte 1 (sem banco): unidade do placar (gols/pontos/sets), mapa explícito dos
//   tipos de aviso do Club que respeitam a preferência de WhatsApp, avisos
//   operacionais fora do notify.js, schema aditivo no início do ensureApexSchema,
//   botões nas páginas, SSE com volta para a consulta (live-sse.js num navegador
//   falso: reconexão com espera crescente, consulta só com o SSE caído).
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. artes dos 5 casos (resultado, tabela, artilharia, card do atleta, campeão) em
//      feed E story: PNG do tamanho certo, link da liga, nome/cores do Club, privado = 404
//   b. basquete por PONTOS: arte, painel do atleta, artilharia do esporte, medalha
//   c. fechar súmula / placar manual: aviso aos jogadores com conta (EntryMember e
//      RosterPlayer), sem atrasar a resposta, idempotente, correção = aviso de correção,
//      Master Cup intacto (lista de exclusão)
//   d. jogadores sem conta: convite por vaga recuperável (abrir de novo = mesmo link),
//      texto + wa.me, NENHUM WhatsApp enviado pelo sistema
//   e. notify: WhatsApp só com a preferência ligada nos tipos do Club; tipo
//      operacional (ponto/código) continua saindo; 'organizer' ligado só para a equipe
//   f. "Entrar neste time": link público só quando o time escolhe; privado = 404
//   g. páginas no app real (src/index.js)
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
// CPF válido aleatório (dígitos verificadores certos) — a medalha exige CPF válido
function randomCpf() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  const dv = (arr) => { const n = arr.length + 1; const s = arr.reduce((a, x, i) => a + x * (n - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  d.push(dv(d)); d.push(dv(d));
  return d.join('');
}
const pngSize = (buf) => ({ sig: buf.slice(1, 4).toString('latin1'), w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// live-sse.js num "navegador" falso (vm): EventSource e relógio controlados pelo teste
function fakeBrowser() {
  const timers = [];
  const ess = [];
  class FakeES {
    constructor(url) { this.url = url; this.readyState = 0; ess.push(this); }
    close() { this.readyState = 2; this.closed = true; }
  }
  const win = { EventSource: FakeES };
  const ctx = {
    window: win, Math, JSON, console,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(read('public/club/live-sse.js'), ctx);
  return { win, timers, ess };
}

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f4-' + crypto.randomBytes(8).toString('hex');
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 're_test_dummy';
  const gr = require('../src/services/tournamentRules');

  await ok('unidade do placar: futsal = gols, basquete = pontos, vôlei = sets (regra da categoria ou esporte)', () => {
    assert.strictEqual(gr.scoreUnit('FUTSAL').many, 'gols');
    assert.strictEqual(gr.scoreUnit('BASKETBALL').many, 'pontos');
    assert.strictEqual(gr.scoreUnit('VOLLEY').many, 'sets');
    assert.strictEqual(gr.scoreUnit(gr.resolveRules({ gameRules: null }, 'BASKETBALL')).many, 'gols', 'categoria antiga = legado (gols)');
    assert.strictEqual(gr.scoreUnit(gr.resolveRules({ gameRules: { events: ['PT1', 'PT2', 'PT3'] } }, 'BASKETBALL')).short, 'PTS');
    assert.deepStrictEqual({ ...gr.PLAYER_POINT_VALUES }, { GOAL: 1, PT1: 1, PT2: 2, PT3: 3 });
    assert.strictEqual(gr.plural(1, gr.scoreUnit('FUTSAL')), '1 gol');
    assert.strictEqual(gr.plural(5, gr.scoreUnit('BASKETBALL')), '5 pontos');
  });

  await ok('notify.js: mapa EXPLÍCITO dos tipos do Club que respeitam a preferência de WhatsApp cobre todo aviso de torneio/clube', () => {
    const { APEX_WA_TYPES } = require('../src/services/notify');
    // todo tipo usado em chamada de notify/notifyMany nos módulos do APEX tem que estar no mapa
    // TODO arquivo de src/ que importa services/notify.js (descoberto, não lista fixa)
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { const rel = d + '/' + f.name; if (f.isDirectory()) walk(rel); else if (/\.js$/.test(f.name)) { const src = read(rel); if (/require\((['"])(\.\/|\.\.\/services\/)notify['"]\)/.test(src)) files.push(rel); } } };
    walk('src');
    assert.ok(files.length >= 9, 'achou poucos chamadores: ' + files.join(','));
    const found = new Set();
    for (const f of files) {
      const src = read(f);
      const re = /notify(?:Many)?\([^]*?type:\s*'([a-z_]+)'/g;
      let m;
      while ((m = re.exec(src))) found.add(m[1]);
    }
    assert.ok(found.size >= 8, 'achou poucos tipos: ' + [...found]);
    for (const t of found) assert.ok(Object.prototype.hasOwnProperty.call(APEX_WA_TYPES, t), 'tipo do Club fora do mapa: ' + t);
    assert.ok(Object.prototype.hasOwnProperty.call(APEX_WA_TYPES, 'info'), 'aviso do Club sem tipo (info) também precisa de opt-in');
    for (const op of ['ponto', 'clock_in', 'codigo', 'agenda', 'crm']) assert.ok(!Object.prototype.hasOwnProperty.call(APEX_WA_TYPES, op), 'tipo operacional no mapa: ' + op);
  });

  await ok('avisos operacionais (código, ponto, agenda, CRM, equipe) NÃO passam pelo notify.js — nada deles muda', () => {
    for (const f of ['src/whatsapp.js', 'src/services/payroll/notify.js', 'src/services/systemMessenger.js']) {
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      const src = read(f);
      assert.ok(!/require\(['"][./]*(services\/)?notify['"]\)/.test(src), f + ' importa o notify.js');
      assert.ok(!/ClubNotifyPref|clubNotifyPref/.test(src), f + ' lê preferência do Club');
    }
  });

  await ok('aviso ao ORGANIZADOR (pedido de inscrição, reembolso, PIX sem vaga) vai com waCategory organizer', () => {
    const a = read('src/routes/tournaments.js');
    const b = read('src/services/tournamentRegistration.js');
    for (const src of [a, b]) {
      const calls = src.match(/notify\(t\.ownerId,[^\n]*/g) || [];
      assert.ok(calls.length >= 2);
      for (const c of calls) {
        const i = src.indexOf(c);
        assert.ok(/waCategory: 'organizer'/.test(src.slice(i, i + 600)), 'sem organizer: ' + c.slice(0, 80));
      }
    }
  });

  await ok('schema aditivo da F4 no INÍCIO do ensureApexSchema (e repetido no fim p/ banco novo) + schema.prisma coerente', () => {
    const { STATEMENTS } = require('../src/services/ensureApexSchema');
    assert.ok(Array.isArray(STATEMENTS), 'ensureApexSchema não exporta STATEMENTS');
    const idx = (re) => STATEMENTS.findIndex((x) => re.test(x));
    const first = [idx(/"ClubNotifyPref" ADD COLUMN IF NOT EXISTS "whatsapp"/), idx(/"TeamInvite" ADD COLUMN IF NOT EXISTS "publicToken"/), idx(/"RosterInvite" ADD COLUMN IF NOT EXISTS "recoverable"/)];
    first.forEach((i) => assert.ok(i >= 0 && i < 3, 'não está no início: ' + i));
    assert.ok(STATEMENTS.slice(-3).every((x) => /ADD COLUMN IF NOT EXISTS/.test(x)), 'faltou repetir no fim');
    assert.ok(!STATEMENTS.some((x) => /\bDROP\b/i.test(x) && /F4|whatsapp|publicToken|recoverable/.test(x)));
    const prisma = read('prisma/schema.prisma');
    assert.ok(/whatsapp\s+Json\?/.test(prisma) && /publicToken\s+String\?/.test(prisma) && /recoverable\s+Boolean\s+@default\(false\)/.test(prisma));
  });

  await ok('páginas: "Criar minha liga" em /t, /atleta e /clube; "Entrar num time" e Compartilhar (folha) em /t; live-sse antes do torneio-midia', () => {
    const idx = read('src/index.js');
    assert.ok(/data-m="join"/.test(idx) && /function openJoin\(/.test(idx), 'botão Entrar num time');
    assert.ok(/if\(a==='share'\) openShare\(\)/.test(idx) && /openShareSheet\(\{title:'Compartilhar'/.test(idx), 'compartilhar /t');
    assert.ok((idx.match(/href="\/criar-liga" data-testid="criar-liga"/g) || []).length >= 2, 'criar minha liga em /t e /atleta');
    assert.ok(/Peça o link ao responsável do time/.test(idx));
    assert.ok(/data-testid="criar-liga"/.test(read('public/clube.html')), '/clube');
    const both = idx.match(/<script src="\/club\/live-sse\.js"><\/script>\r?\n<script src="\/club\/torneio-midia\.js"><\/script>/g) || [];
    assert.strictEqual(both.length, 2);
    const pages = read('src/services/tournamentPages.js');
    assert.ok(/live-sse\.js"><\/script>\r?\n<script src="\/club\/telao\.js/.test(pages) && /live-sse\.js"><\/script>\r?\n<script src="\/club\/embed\.js/.test(pages));
    assert.ok(/<script src="\/club\/live-sse\.js"><\/script>/.test(read('public/racha.html')));
  });

  await ok('/t/:slug: consulta de 20 s SÓ com o SSE caído (SSE_DOWN), nunca enquanto conecta/aberto', () => {
    const idx = read('src/index.js');
    assert.ok(/if\(SSE_DOWN&&DATA\.matches\.some\(function\(m\)\{return m\.status==='LIVE';\}\)\)\{POLL=setTimeout\(function\(\)\{load\(catId,true\);\},20000\);\}/.test(idx));
    assert.ok(/SSE_DOWN=!\(window\.EventSource&&window\.ClubMidia\)/.test(idx));
    assert.ok(/SSE_ON=ok; SSE_DOWN=!ok;/.test(idx));
    assert.ok(!/if\(!SSE_ON&&DATA\.matches/.test(idx), 'sobrou a condição antiga (consultava enquanto o SSE conectava)');
  });

  await ok('live-sse.js: abre → estado ligado; queda simples → estado caído (o navegador reconecta); fechado → reconecta com espera crescente', () => {
    const b = fakeBrowser();
    const states = [];
    b.win.ClubLiveSSE.connect('/api/tournaments/t1/live', { onState: (v) => states.push(v), onMessage: () => {} });
    assert.strictEqual(b.ess.length, 1);
    assert.strictEqual(b.ess[0].url, '/api/tournaments/t1/live');
    assert.deepStrictEqual(states, [], 'conectando não é "caído"');
    b.ess[0].onopen();
    assert.deepStrictEqual(states, [true]);
    b.ess[0].readyState = 0; b.ess[0].onerror();
    assert.deepStrictEqual(states, [true, false]);
    assert.strictEqual(b.timers.length, 0, 'queda simples: quem reconecta é o EventSource (retry 4s)');
    b.ess[0].onopen();
    assert.deepStrictEqual(states, [true, false, true]);
    b.ess[0].readyState = 2; b.ess[0].onerror(); // servidor recusou (lotado/erro): fechado
    assert.strictEqual(b.timers.length, 1);
    assert.ok(b.timers[0].ms >= 1600 && b.timers[0].ms <= 2400, 'espera 1: ' + b.timers[0].ms);
    b.timers[0].fn();
    assert.strictEqual(b.ess.length, 2, 'reconectou');
    b.ess[1].readyState = 2; b.ess[1].onerror();
    assert.ok(b.timers[1].ms >= 3200 && b.timers[1].ms <= 4800, 'espera 2 maior: ' + b.timers[1].ms);
    for (let i = 0; i < 10; i++) { b.timers[b.timers.length - 1].fn(); const e = b.ess[b.ess.length - 1]; e.readyState = 2; e.onerror(); }
    assert.ok(b.timers[b.timers.length - 1].ms <= 72000, 'teto de 60 s (+variação)');
    const messages = [];
    const b2 = fakeBrowser();
    b2.win.ClubLiveSSE.connect('/x', { onMessage: (d) => messages.push(d) });
    b2.ess[0].onmessage({ data: '{"type":"end"}' });
    b2.ess[0].onmessage({ data: 'lixo' });
    assert.deepStrictEqual(messages, [{ type: 'end' }]);
  });

  await ok('navegador sem EventSource: estado caído na hora (a página consulta)', () => {
    const ctx = { window: {}, Math, JSON, setTimeout: () => 0, clearTimeout: () => {} };
    vm.createContext(ctx);
    vm.runInContext(read('public/club/live-sse.js'), ctx);
    const st = [];
    ctx.window.ClubLiveSSE.connect('/x', { onState: (v) => st.push(v) });
    assert.deepStrictEqual(st, [false]);
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('artes, avisos, convites, preferências, páginas', 'DATABASE_URL local (localhost) não definido');
    if (process.env.CI) { failed++; console.error('  ❌ no CI a parte de banco não pode ser pulada'); }
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  // WhatsApp LIGADO (ponte) só para observar o que o notify ENFILEIRA — nada sai daqui
  process.env.WA_BRIDGE_KEY = 'teste-f4-ponte';
  delete process.env.WHATSAPP_TOKEN;
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const gr = require('../src/services/tournamentRules');
  const art = require('../src/services/tournamentArt');
  const notifySvc = require('../src/services/notify');
  const clubPush = require('../src/services/clubPush');
  const matchNotices = require('../src/services/matchNotices');
  const access = require('../src/services/tournamentAccess');
  const roles = require('../src/services/tournamentRoles');
  const whatsappCloud = require('../src/services/whatsappCloud');
  const { publicDomain } = require('../src/config/publicUrl');
  await ensureApexSchema(prisma);
  clubPush.setPrisma(prisma);

  // espião: o sistema não pode chamar envio de WhatsApp sozinho
  const waCalls = [];
  whatsappCloud.sendNotification = async (phone, text) => { waCalls.push({ phone, text }); return { ok: true }; };
  const origEnabled = whatsappCloud.enabled;

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use('/api/club-push', require('../src/routes/clubPush'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipSeq = 0;
  const call = (method, url, { token, body } = {}) => {
    const headers = { 'cf-connecting-ip': `198.51.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}` };
    if (token) headers.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, headers, body);
  };

  const RUN = Date.now().toString(36);
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  const mkUser = (label, extra = {}) => prisma.user.create({ data: { name: `F4 ${label} ${RUN}-${++seq}`, phone: '839' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const U = {
    org: await mkUser('organizador'),
    other: await mkUser('qualquer'),
    p1: await mkUser('jogador 1', { username: 'f4um' + RUN }),
    p2: await mkUser('jogador 2'),
    p3: await mkUser('membro'),
    p4: await mkUser('cestinha', { username: 'f4bb' + RUN, cpf: randomCpf() }),
    p5: await mkUser('pivô'),
    p6: await mkUser('preferencias'),
    staff: await mkUser('equipe', { role: 'admin' }),
    newbie: await mkUser('novato'),
  };
  const allIds = Object.values(U).map((u) => u.id);
  const outboxCount = (ids = allIds) => prisma.whatsAppOutbox.count({ where: { userId: { in: ids } } });
  const notifs = (u, extra = {}) => prisma.appNotification.findMany({ where: { userId: u.id, type: 'result', ...extra }, orderBy: { createdAt: 'asc' } });
  const settle = async () => { await matchNotices.flush(); await notifySvc.flush(); };

  // ---------------------------------------------------------------- dados: futsal público com clube
  const T = await prisma.tournament.create({ data: { slug: 'f4-copa-' + RUN, name: 'Copa F4 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre', gameRules: gr.defaultsFor('FUTSAL') } });
  const clubA = await prisma.club.create({ data: { ownerId: U.org.id, name: 'Leões FC ' + RUN, slug: 'leoes-' + RUN, primaryColor: '#123456', secondaryColor: '#FFEE00' } });
  const clubB = await prisma.club.create({ data: { ownerId: U.org.id, name: 'Tubarões EC ' + RUN, slug: 'tubaroes-' + RUN } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'leoes inscricao ' + RUN, status: 'CONFIRMED', clubId: clubA.id } });
  const eB = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'tubaroes inscricao ' + RUN, status: 'CONFIRMED', clubId: clubB.id } });
  const pA1 = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Jogador Um', number: 10, userId: U.p1.id, role: 'PLAYER' } });
  const pA2 = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Sem Conta A', number: 7, role: 'PLAYER' } });
  const pAc = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Técnico Sem Conta', role: 'COACH' } });
  const pB1 = await prisma.rosterPlayer.create({ data: { entryId: eB.id, name: 'Jogador Dois', number: 9, userId: U.p2.id, role: 'PLAYER' } });
  await prisma.entryMember.create({ data: { entryId: eB.id, userId: U.p3.id } });
  const m1 = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 1, homeEntryId: eA.id, awayEntryId: eB.id, status: 'SCHEDULED', scheduledAt: new Date() } });
  const m2 = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 2, homeEntryId: eB.id, awayEntryId: eA.id, status: 'SCHEDULED', scheduledAt: new Date(Date.now() + 3600e3) } });
  const ev = async (m, entryId, type, playerId) => {
    const r = await call('POST', `/api/tournaments/matches/${m.id}/events`, { token: tok(U.org), body: { type, entryId, playerId } });
    assert.ok(r.status === 200 || r.status === 201, 'evento ' + type + ' ' + r.status + ' ' + r.text);
    return r.json.event || r.json;
  };

  // ================================================================ c. fechar súmula avisa
  console.log('  — fechar súmula: aviso aos jogadores');
  await ev(m1, eA.id, 'GOAL', pA1.id);
  await ev(m1, eA.id, 'GOAL', pA1.id);
  await ev(m1, eA.id, 'ASSIST', pA1.id);
  const goalB = await ev(m1, eB.id, 'GOAL', pB1.id);
  await ev(m1, eA.id, 'GOAL', pA2.id);

  await ok('fechar súmula responde sem esperar o aviso (assíncrono) e o aviso chega depois', async () => {
    // o aviso só começa 1,5 s depois de agendado: se a rota esperasse por ele, a resposta
    // chegaria com o aviso já gravado
    process.env.LIGA_MATCH_NOTICES_DELAY_MS = '1500';
    let r;
    try { r = await call('POST', `/api/tournaments/matches/${m1.id}/finalize`, { token: tok(U.org), body: {} }); } finally { delete process.env.LIGA_MATCH_NOTICES_DELAY_MS; }
    const at = new Date();
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.homeScore, 3);
    assert.strictEqual((await notifs(U.p1)).length, 0, 'aviso saiu ANTES da resposta (síncrono)');
    await settle();
    const l = await notifs(U.p1);
    assert.strictEqual(l.length, 1);
    assert.ok(l[0].createdAt >= at, 'aviso gravado antes da resposta');
  });
  await ok('aviso traz o placar (nome do CLUBE) e o que mudou no histórico de cada um (RosterPlayer e EntryMember)', async () => {
    const [n1] = await notifs(U.p1);
    assert.ok(n1.title.startsWith('Fim de jogo: '), n1.title);
    assert.ok(n1.title.includes(clubA.name) && n1.title.includes('3 × 1') && n1.title.includes(clubB.name), n1.title);
    assert.ok(/Você neste jogo: 2 gols, 1 assistência\./.test(n1.body), n1.body);
    assert.ok(/Temporada \d{4}: 1 jogo, 2 gols, 1 assistência/.test(n1.body), n1.body);
    assert.ok(n1.link.includes('/t/' + T.slug) && n1.link.includes(m1.id));
    const [n2] = await notifs(U.p2);
    assert.ok(/Você neste jogo: 1 gol\./.test(n2.body), n2.body);
    const n3 = await notifs(U.p3);
    assert.strictEqual(n3.length, 1, 'EntryMember recebe');
    assert.ok(!/Você neste jogo/.test(n3[0].body));
    assert.strictEqual((await notifs(U.other)).length, 0, 'quem não jogou não recebe');
  });
  await ok('idempotente: rodar de novo e refechar igual (coordenação) não duplica', async () => {
    const again = await matchNotices.run(m1.id);
    assert.ok(again.duplicate, JSON.stringify(again));
    const r = await call('POST', `/api/tournaments/matches/${m1.id}/finalize`, { token: tok(U.org), body: {} });
    assert.strictEqual(r.status, 200, r.text);
    await settle();
    assert.strictEqual((await notifs(U.p1)).length, 1);
    assert.strictEqual((await notifs(U.p3)).length, 1);
  });
  await ok('correção (gol apagado e súmula refechada) = UM aviso de correção, com o histórico atualizado', async () => {
    const d = await call('DELETE', `/api/tournaments/events/${goalB.id}`, { token: tok(U.org) });
    assert.strictEqual(d.status, 200, d.text);
    const r = await call('POST', `/api/tournaments/matches/${m1.id}/finalize`, { token: tok(U.org), body: {} });
    assert.strictEqual(r.status, 200, r.text);
    await settle();
    const l2 = await notifs(U.p2);
    assert.strictEqual(l2.length, 2);
    assert.ok(l2[1].title.startsWith('Resultado corrigido: ') && l2[1].title.includes('3 × 0'), l2[1].title);
    assert.ok(/Você não marcou gol neste jogo/.test(l2[1].body) && /corrigiu a súmula/.test(l2[1].body), l2[1].body);
    await matchNotices.run(m1.id);
    await settle();
    assert.strictEqual((await notifs(U.p2)).length, 2, 'correção duplicou');
  });
  await ok('placar manual (/result) também avisa (aviso detalhado)', async () => {
    const r = await call('POST', `/api/tournaments/matches/${m2.id}/result`, { token: tok(U.org), body: { homeScore: 0, awayScore: 2 } });
    assert.strictEqual(r.status, 200, r.text);
    await settle();
    const l = (await notifs(U.p1)).filter((n) => n.link.includes(m2.id));
    assert.strictEqual(l.length, 1);
    assert.ok(l[0].title.includes('0 × 2'), l[0].title);
  });
  await ok('Master Cup (lista de exclusão) segue como antes: nenhum aviso novo, nenhuma chave gravada', async () => {
    let MC = await prisma.tournament.findUnique({ where: { slug: 'futsal-master-cup-2026' } });
    if (!MC) MC = await prisma.tournament.create({ data: { slug: 'futsal-master-cup-2026', name: 'II Futsal Master Cup 2026 (teste)', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', ownerId: U.org.id, status: 'ONGOING' } });
    const mcCat = await prisma.tournamentCategory.create({ data: { tournamentId: MC.id, name: 'F4 teste ' + RUN } });
    const x = await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, name: 'MC A ' + RUN } });
    const y = await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, name: 'MC B ' + RUN } });
    await prisma.rosterPlayer.create({ data: { entryId: x.id, name: 'MC jogador', userId: U.p1.id } });
    const mm = await prisma.tournamentMatch.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, stage: 'GROUP', groupName: 'A', round: 1, homeEntryId: x.id, awayEntryId: y.id, status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: x.id } });
    const r = await matchNotices.run(mm.id);
    assert.ok(/exclusão/.test(r.skipped || ''), JSON.stringify(r));
    assert.strictEqual(await prisma.clubPushLog.count({ where: { OR: [{ key: { startsWith: 'mres:' + mm.id } }, { key: { startsWith: 'mresv:' + mm.id } }] } }), 0);
    const u = await call('GET', `/api/tournaments/matches/${mm.id}/unclaimed`, { token: tok(U.org) });
    assert.strictEqual(u.status, 200, u.text);
    assert.ok(u.json.excluded && !u.json.players.length, 'Master Cup: caixa de sem conta não aparece');
    const ci = await call('POST', `/api/tournaments/matches/${mm.id}/claim-invites`, { token: tok(U.org), body: {} });
    assert.ok(ci.json && ci.json.excluded && ci.json.created === 0);
    assert.strictEqual(await prisma.rosterInvite.count({ where: { tournamentId: MC.id } }), 0, 'Master Cup ganhou convite');
    assert.strictEqual((await notifs(U.p1)).filter((n) => n.link && n.link.includes(mm.id)).length, 0);
  });

  // ================================================================ d. sem conta: convite
  console.log('  — jogadores sem conta: convite pelo WhatsApp do organizador');
  let inviteUrl = null;
  await ok('súmula fechada: lista quem jogou SEM conta (GET só lê: nada gerado ainda)', async () => {
    const r = await call('GET', `/api/tournaments/matches/${m1.id}/unclaimed`, { token: tok(U.org) });
    assert.strictEqual(r.status, 200, r.text);
    const names = r.json.players.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ['Sem Conta A', 'Técnico Sem Conta']);
    assert.ok(r.json.players.every((p) => p.invite === null));
    assert.strictEqual(await prisma.rosterInvite.count({ where: { rosterPlayerId: { in: [pA2.id, pAc.id] } } }), 0);
  });
  await ok('preparar convites: link por vaga + texto pronto + wa.me (quem manda é o organizador)', async () => {
    const r = await call('POST', `/api/tournaments/matches/${m1.id}/claim-invites`, { token: tok(U.org), body: {} });
    assert.strictEqual(r.status, 200, r.text);
    const a2 = r.json.players.find((p) => p.playerId === pA2.id);
    assert.ok(a2.invite && /\/convite-elenco\/[A-Za-z0-9_-]{43}$/.test(a2.invite.url), JSON.stringify(a2));
    assert.ok(a2.invite.whatsappUrl.startsWith('https://wa.me/?text='));
    assert.ok(a2.invite.whatsappText.includes('Sem Conta A') && a2.invite.whatsappText.includes(clubA.name) && a2.invite.whatsappText.includes(a2.invite.url));
    inviteUrl = a2.invite.url;
    assert.strictEqual(r.json.created, 2);
  });
  await ok('abrir de novo RECUPERA o mesmo link (não invalida o que já foi mandado) e não cria convite novo', async () => {
    const r = await call('GET', `/api/tournaments/matches/${m1.id}/unclaimed`, { token: tok(U.org) });
    assert.strictEqual(r.json.players.find((p) => p.playerId === pA2.id).invite.url, inviteUrl);
    const r2 = await call('POST', `/api/tournaments/matches/${m1.id}/claim-invites`, { token: tok(U.org), body: {} });
    assert.strictEqual(r2.json.created, 0);
    assert.strictEqual(await prisma.rosterInvite.count({ where: { rosterPlayerId: pA2.id } }), 1);
  });
  await ok('árbitro do jogo (sem ser organização/time) vê só os NOMES: sem link, e não gera convite (403)', async () => {
    const ref = await prisma.user.create({ data: { name: 'F4 árbitro ' + RUN, phone: '8391' + String(Date.now() % 10000000).padStart(7, '0'), pin: 'x' } });
    await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: ref.id, role: 'REFEREE' } });
    const r = await call('GET', `/api/tournaments/matches/${m1.id}/unclaimed`, { token: tok(ref) });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.players.length && r.json.players.every((p) => p.invite === null && p.canInvite === false), JSON.stringify(r.json.players));
    assert.strictEqual(r.json.canInvite, false);
    assert.ok(!JSON.stringify(r.json).includes('/convite-elenco/'), 'vazou link para o árbitro');
    const p = await call('POST', `/api/tournaments/matches/${m1.id}/claim-invites`, { token: tok(ref), body: {} });
    assert.strictEqual(p.status, 403);
  });
  await ok('lista de sem conta: qualquer um = 403, sem login = 401, jogo não fechado = 409', async () => {
    assert.strictEqual((await call('GET', `/api/tournaments/matches/${m1.id}/unclaimed`, { token: tok(U.other) })).status, 403);
    assert.strictEqual((await call('GET', `/api/tournaments/matches/${m1.id}/unclaimed`)).status, 401);
    const m3 = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 3, homeEntryId: eA.id, awayEntryId: eB.id, status: 'SCHEDULED' } });
    const r = await call('POST', `/api/tournaments/matches/${m3.id}/claim-invites`, { token: tok(U.org), body: {} });
    assert.strictEqual(r.status, 409);
    await prisma.tournamentMatch.delete({ where: { id: m3.id } });
  });
  await ok('o jogador reivindica pelo link (vaga ligada à conta dele)', async () => {
    const token = inviteUrl.split('/').pop();
    const r = await call('POST', `/api/tournaments/roster-invites/${token}/claim`, { token: tok(U.newbie) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pA2.id } })).userId, U.newbie.id);
  });
  await ok('NENHUM WhatsApp saiu do sistema: nem para quem não tem conta, nem para atleta que não ligou a preferência', async () => {
    assert.strictEqual(waCalls.length, 0, 'chamou envio: ' + JSON.stringify(waCalls));
    assert.strictEqual(await outboxCount(), 0, 'enfileirou WhatsApp sem a pessoa pedir');
  });

  // ================================================================ e. notify × preferência
  console.log('  — WhatsApp só no que o atleta escolheu');
  await ok('preferências: GET/PUT /api/club-push/preferences por tipo × canal; WhatsApp começa DESLIGADO', async () => {
    const g = await call('GET', '/api/club-push/preferences', { token: tok(U.p6) });
    assert.strictEqual(g.status, 200, g.text);
    assert.ok(g.json.whatsappLabels && g.json.whatsappLabels.result && g.json.whatsappLabels.organizer);
    assert.ok(Object.values(g.json.whatsapp).every((v) => v === false), JSON.stringify(g.json.whatsapp));
    assert.ok(Object.values(g.json.types).every((v) => v === true), 'push segue ligado por padrão');
    const s = await call('GET', '/api/club-push/preferences', { token: tok(U.staff) });
    assert.strictEqual(s.json.whatsapp.organizer, true, 'equipe: aviso de organização ligado por padrão');
    assert.strictEqual(s.json.whatsapp.result, false);
  });
  await ok('aviso do Club (resultado, jogo em 30 min, convite, inscrição) com a preferência desligada NÃO enfileira WhatsApp', async () => {
    for (const type of ['result', 'game_soon', 'team', 'entry', 'challenge', 'schedule', 'training', 'role', 'info', undefined]) await notifySvc.notify(U.p6.id, { type, title: 'Teste ' + type, body: 'x' });
    await settle();
    assert.strictEqual(await outboxCount([U.p6.id]), 0);
  });
  await ok('aviso OPERACIONAL (tipo fora do Club: ponto, código) continua saindo pelo WhatsApp como antes', async () => {
    await notifySvc.notify(U.p6.id, { type: 'ponto', title: 'Ponto', body: 'Bata o ponto' });
    await notifySvc.notify(U.p6.id, { type: 'codigo_verificacao', title: 'Código', body: '123456' });
    await settle();
    assert.strictEqual(await outboxCount([U.p6.id]), 2);
    const d = await notifySvc.whatsappDecision(U.p6.id, 'ponto');
    assert.ok(d.send);
    await notifySvc.notify(U.p6.id, { type: 'ponto', title: 'Só sininho', body: 'x' }, { whatsapp: false });
    await settle();
    assert.strictEqual(await outboxCount([U.p6.id]), 2, 'whatsapp:false continua valendo');
  });
  await ok('atleta LIGA "Resultado" → só esse tipo passa a ir pro WhatsApp', async () => {
    const p = await call('PUT', '/api/club-push/preferences', { token: tok(U.p6), body: { whatsapp: { result: true } } });
    assert.strictEqual(p.status, 200, p.text);
    assert.strictEqual(p.json.whatsapp.result, true);
    assert.strictEqual(p.json.whatsapp.game_soon, false);
    await notifySvc.notify(U.p6.id, { type: 'result', title: 'Fim de jogo', body: 'x' });
    await notifySvc.notify(U.p6.id, { type: 'game_soon', title: 'Jogo em 30', body: 'x' });
    await settle();
    const rows = await prisma.whatsAppOutbox.findMany({ where: { userId: U.p6.id }, orderBy: { createdAt: 'asc' } });
    assert.strictEqual(rows.length, 3);
    assert.ok(rows[2].body.startsWith('Fim de jogo'));
  });
  await ok('aviso de ORGANIZAÇÃO: ligado por padrão só para a equipe; cliente organizador não recebe WhatsApp sem ligar', async () => {
    await notifySvc.notify(U.staff.id, { type: 'entry', title: 'Novo pedido', body: 'x' }, { waCategory: 'organizer' });
    await notifySvc.notify(U.org.id, { type: 'entry', title: 'Novo pedido', body: 'x' }, { waCategory: 'organizer' });
    await notifySvc.notify(U.org.id, { type: 'role', title: 'Torneio transferido', body: 'x' });
    await settle();
    assert.strictEqual(await outboxCount([U.staff.id]), 1);
    assert.strictEqual(await outboxCount([U.org.id]), 0);
  });
  await ok('fim de jogo com o atleta que LIGOU o WhatsApp: só ele recebe; os outros do jogo não', async () => {
    await clubPush.setPrefs(U.p1.id, { whatsapp: { result: true } });
    await ev(m1, eB.id, 'GOAL', pB1.id); // correção: volta o gol (= placar da 1ª versão)
    const r = await call('POST', `/api/tournaments/matches/${m1.id}/finalize`, { token: tok(U.org), body: {} });
    assert.strictEqual(r.status, 200, r.text);
    await settle();
    assert.strictEqual(await outboxCount([U.p1.id]), 1);
    assert.strictEqual(await outboxCount([U.p2.id, U.p3.id, U.newbie.id]), 0);
    const l2 = (await notifs(U.p2)).filter((n) => n.link.includes(m1.id));
    assert.strictEqual(l2.length, 3, 'voltar ao placar anterior também é correção (nova versão)');
    assert.ok(l2[2].title.startsWith('Resultado corrigido: ') && l2[2].title.includes('3 × 1'), l2[2].title);
    assert.strictEqual(waCalls.length, 0, 'Cloud API desligada: a ponte é que puxa da fila');
  });

  // ================================================================ a. artes
  console.log('  — artes (5 casos × feed e story)');
  const tFull = await prisma.tournament.findUnique({ where: { id: T.id } });
  const cases = [
    ['resultado', { matchId: m1.id }],
    ['classificacao', { categoryId: cat.id }],
    ['artilharia', { categoryId: cat.id }],
    ['campeao', { categoryId: cat.id }],
  ];
  await ok('5 casos em FEED e STORY devolvem PNG do tamanho certo (resultado, tabela, artilharia, card do atleta, campeão)', async () => {
    const urls = [];
    for (const [tipo, q] of cases) urls.push([`/api/tournaments/${T.id}/arte/${tipo}.png`, q]);
    urls.push([`/api/tournaments/club/arte/atleta.png`, { handle: U.p1.username }]);
    urls.push([`/api/tournaments/${T.slug}/arte/atleta.png`, { handle: U.p1.username }]);
    for (const [u, q] of urls) {
      for (const formato of ['feed', 'story']) {
        const qs = new URLSearchParams({ ...q, formato }).toString();
        const r = await call('GET', u + '?' + qs);
        assert.strictEqual(r.status, 200, u + ' ' + formato + ' ' + r.text.slice(0, 120));
        assert.ok(/image\/png/.test(r.headers['content-type']));
        const s = pngSize(r.buf);
        assert.strictEqual(s.sig, 'PNG');
        assert.deepStrictEqual([s.w, s.h], formato === 'feed' ? [1080, 1350] : [1080, 1920], u + ' ' + formato);
      }
    }
  });
  await ok('cada arte leva o link da liga (/t/:slug) e o card leva o link do atleta (/atleta/:u)', async () => {
    for (const [tipo, q] of cases) {
      const d = await art._buildData(tFull, tipo, q);
      assert.strictEqual(d.url, publicDomain() + '/t/' + T.slug, tipo);
    }
    const a = await art._buildData({ id: '__none__', slug: '', name: 'Club Sports & Tennis' }, 'atleta', { handle: U.p1.username });
    assert.strictEqual(a.url, publicDomain() + '/atleta/' + U.p1.username);
  });
  await ok('artes usam NOME, CORES e escudo do Club (F2) e o campeão sai quando a liga acaba', async () => {
    const r = await art._buildData(tFull, 'resultado', { matchId: m1.id });
    assert.strictEqual(r.match.homeEntry.name, clubA.name);
    assert.strictEqual(r.match.homeEntry.primaryColor, '#123456');
    assert.strictEqual(r.match.homeEntry.secondaryColor, '#FFEE00');
    const c = await art._buildData(tFull, 'classificacao', { categoryId: cat.id });
    const names = c.groups.flatMap((g) => g.rows.map((x) => x.entry.name));
    assert.ok(names.includes(clubA.name) && names.includes(clubB.name), names.join(','));
    assert.ok(c.groups[0].rows.some((x) => x.entry.primaryColor === '#123456'));
    const ch = await art._buildData(tFull, 'campeao', { categoryId: cat.id });
    assert.ok(ch.champion && ch.champion.name === clubA.name, JSON.stringify(ch.champion));
    const sc = await art._buildData(tFull, 'artilharia', { categoryId: cat.id });
    assert.strictEqual(sc.unit.many, 'gols');
    assert.strictEqual(sc.ranking[0].goals, 2);
  });
  const PT = await prisma.tournament.create({ data: { slug: 'f4-priv-' + RUN, name: 'Privado F4 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'ONGOING', visibility: 'private' } });
  const pcat = await prisma.tournamentCategory.create({ data: { tournamentId: PT.id, name: 'Livre' } });
  const px = await prisma.tournamentEntry.create({ data: { tournamentId: PT.id, categoryId: pcat.id, name: 'Priv A ' + RUN, status: 'CONFIRMED' } });
  const py = await prisma.tournamentEntry.create({ data: { tournamentId: PT.id, categoryId: pcat.id, name: 'Priv B ' + RUN, status: 'CONFIRMED' } });
  const pm = await prisma.tournamentMatch.create({ data: { tournamentId: PT.id, categoryId: pcat.id, stage: 'LEAGUE', round: 1, homeEntryId: px.id, awayEntryId: py.id, status: 'FINISHED', homeScore: 2, awayScore: 1, winnerEntryId: px.id } });
  const privChecks = async () => {
    const missing = await call('GET', `/api/tournaments/nao-existe-${RUN}/arte/resultado.png?matchId=${pm.id}&formato=feed`);
    const out = [];
    for (const [tipo, q] of [['resultado', { matchId: pm.id }], ['classificacao', { categoryId: pcat.id }], ['artilharia', {}], ['campeao', { categoryId: pcat.id }], ['atleta', { handle: U.p1.username }]]) {
      for (const formato of ['feed', 'story']) {
        const r = await call('GET', `/api/tournaments/${PT.id}/arte/${tipo}.png?` + new URLSearchParams({ ...q, formato }));
        out.push({ tipo, formato, status: r.status, same: r.text === missing.text });
      }
    }
    return { missing, out };
  };
  await ok('jogo inexistente = mesmo 404 de torneio privado (não revela se o jogo existe)', async () => {
    const a = await call('GET', `/api/tournaments/matches/nao-existe-${RUN}/unclaimed`, { token: tok(U.org) });
    const b = await call('GET', `/api/tournaments/matches/${pm.id}/unclaimed`, { token: tok(U.other) });
    assert.strictEqual(a.status, 404);
    assert.strictEqual(b.status, 404);
    assert.strictEqual(a.text, b.text);
  });
  await ok('torneio PRIVADO: arte = o MESMO 404 de "não existe" (anônimo e quem não é membro); membro vê sem cache público', async () => {
    const { missing, out } = await privChecks();
    assert.strictEqual(missing.status, 404);
    for (const o of out) assert.ok(o.status === 404 && o.same, JSON.stringify(o));
    const outsider = await call('GET', `/api/tournaments/${PT.id}/arte/resultado.png?matchId=${pm.id}&formato=feed`, { token: tok(U.other) });
    assert.strictEqual(outsider.status, 404);
    const mem = await call('GET', `/api/tournaments/${PT.id}/arte/resultado.png?matchId=${pm.id}&formato=story`, { token: tok(U.org) });
    assert.strictEqual(mem.status, 200);
    assert.ok(/private/.test(mem.headers['cache-control']), mem.headers['cache-control']);
  });

  // ================================================================ b. basquete por pontos
  console.log('  — basquete conta PONTOS (arte, painel, artilharia do esporte, medalha, aviso)');
  const BB = await prisma.tournament.create({ data: { slug: 'f4-bb-' + RUN, name: 'Basquete F4 ' + RUN, sport: 'BASKETBALL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'ONGOING', visibility: 'public' } });
  const bcat = await prisma.tournamentCategory.create({ data: { tournamentId: BB.id, name: 'Adulto', gameRules: gr.defaultsFor('BASKETBALL') } });
  const bA = await prisma.tournamentEntry.create({ data: { tournamentId: BB.id, categoryId: bcat.id, name: 'Cestas ' + RUN, status: 'CONFIRMED' } });
  const bBe = await prisma.tournamentEntry.create({ data: { tournamentId: BB.id, categoryId: bcat.id, name: 'Garrafão ' + RUN, status: 'CONFIRMED' } });
  const bb1 = await prisma.rosterPlayer.create({ data: { entryId: bA.id, name: 'Cestinha', number: 23, userId: U.p4.id } });
  const bb2 = await prisma.rosterPlayer.create({ data: { entryId: bBe.id, name: 'Pivô', number: 5, userId: U.p5.id } });
  const bm = await prisma.tournamentMatch.create({ data: { tournamentId: BB.id, categoryId: bcat.id, stage: 'LEAGUE', round: 1, homeEntryId: bA.id, awayEntryId: bBe.id, status: 'SCHEDULED', scheduledAt: new Date() } });
  await ev(bm, bA.id, 'PT3', bb1.id);
  await ev(bm, bA.id, 'PT2', bb1.id);
  await ev(bm, bBe.id, 'PT1', bb2.id);
  const bfin = await call('POST', `/api/tournaments/matches/${bm.id}/finalize`, { token: tok(U.org), body: {} });
  await settle();
  await ok('fechar súmula do basquete: placar 5×1 e aviso fala em PONTOS', async () => {
    assert.strictEqual(bfin.status, 200, bfin.text);
    assert.strictEqual(bfin.json.homeScore, 5);
    const [n] = await notifs(U.p4);
    assert.ok(/Você neste jogo: 5 pontos\./.test(n.body), n.body);
  });
  const bbT = await prisma.tournament.findUnique({ where: { id: BB.id } });
  await ok('arte: artilharia em PONTOS (cestinha), resultado com o valor de cada cesta', async () => {
    const sc = await art._buildData(bbT, 'artilharia', { categoryId: bcat.id });
    assert.strictEqual(sc.unit.short, 'PTS');
    assert.strictEqual(sc.ranking[0].goals, 5);
    const rs = await art._buildData(bbT, 'resultado', { matchId: bm.id });
    assert.strictEqual(rs.match.unit.short, 'PTS');
    assert.strictEqual(rs.match.scoring.PT3, 3);
    const png = await call('GET', `/api/tournaments/${BB.id}/arte/artilharia.png?categoryId=${bcat.id}&formato=feed`);
    assert.strictEqual(png.status, 200);
    const at = await art._buildData({ id: '__none__', slug: '', name: 'Club' }, 'atleta', { handle: U.p4.username });
    assert.strictEqual(at.athlete.goals, 5, 'card do atleta (histórico) em pontos');
  });
  await ok('painel do atleta e artilharia do esporte somam os PONTOS das cestas (como o histórico)', async () => {
    const dash = require('../src/services/athleteDashboard');
    const d = await dash.dashboard(U.p4.id);
    assert.strictEqual(d.production.games.gols, 5, JSON.stringify(d.production));
    const s = await dash.sportScorers('BASKETBALL');
    const me = s.scorers.find((x) => x.userId === U.p4.id);
    assert.strictEqual(me.goals, 5);
  });
  await ok('medalha de artilharia do basquete: "5 pontos" (não "gols")', async () => {
    const medals = require('../src/services/medals');
    const pv = await medals.previewTournament(BB.id, { id: U.org.id, role: 'user' });
    const c = pv.categories[0];
    const top = c.medals.find((m) => m.achievement === 'TOP_SCORER');
    if (!c.confirmed) throw new Error('categoria não confirmada: ' + c.reason);
    assert.ok(top, JSON.stringify(c));
    assert.strictEqual(top.goals, 5);
    assert.strictEqual(top.goalsText, '5 pontos');
  });

  // ================================================================ f. Entrar neste time
  console.log('  — "Entrar neste time" (link público só quando o time escolhe)');
  let teamToken = null;
  await ok('link do time não aparece na página até o time escolher mostrar', async () => {
    const c = await call('POST', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.org), body: {} });
    assert.strictEqual(c.status, 201, c.text);
    teamToken = c.json.token;
    const j = await call('GET', `/api/tournaments/${T.id}/join-links`);
    assert.strictEqual(j.status, 200);
    assert.deepStrictEqual(j.json.links, {});
  });
  await ok('mostrar na página (PATCH com o token do link ativo) → botão leva ao /convite-time; esconder → some', async () => {
    const bad = await call('PATCH', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.other), body: { public: true, token: teamToken } });
    assert.strictEqual(bad.status, 403);
    const wrong = await call('PATCH', `/api/tournaments/entries/${eB.id}/team-invite`, { token: tok(U.org), body: { public: true, token: teamToken } });
    assert.strictEqual(wrong.status, 404, 'token de outro time');
    const p = await call('PATCH', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.org), body: { public: true, token: teamToken } });
    assert.strictEqual(p.status, 200, p.text);
    const j = await call('GET', `/api/tournaments/${T.id}/join-links`);
    assert.strictEqual(j.json.links[eA.id].url, '/convite-time/' + teamToken);
    assert.ok(!j.json.links[eB.id]);
    const h = await call('PATCH', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.org), body: { public: false } });
    assert.strictEqual(h.status, 200);
    assert.deepStrictEqual((await call('GET', `/api/tournaments/${T.id}/join-links`)).json.links, {});
  });
  await ok('gerar link novo ou revogar tira o anterior da página; criar já público funciona', async () => {
    const c = await call('POST', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.org), body: { public: true } });
    assert.strictEqual(c.status, 201);
    assert.strictEqual((await call('GET', `/api/tournaments/${T.id}/join-links`)).json.links[eA.id].url, '/convite-time/' + c.json.token);
    await call('DELETE', `/api/tournaments/entries/${eA.id}/team-invite`, { token: tok(U.org) });
    assert.deepStrictEqual((await call('GET', `/api/tournaments/${T.id}/join-links`)).json.links, {});
  });
  await ok('torneio privado: links de time = mesmo 404 para quem não é membro', async () => {
    const r = await call('GET', `/api/tournaments/${PT.id}/join-links`);
    assert.strictEqual(r.status, 404);
    const m = await call('GET', `/api/tournaments/${PT.id}/join-links`, { token: tok(U.org) });
    assert.strictEqual(m.status, 200);
  });

  // ================================================================ sabotagem
  console.log('  — prova de sabotagem (cada trava estragada tem que ser pega)');
  async function sabotage(name, breakIt, check, restore) {
    await ok('sabotagem pega: ' + name, async () => {
      await breakIt();
      let caught = false;
      try { await check(); } catch (_) { caught = true; }
      await restore();
      assert.ok(caught, 'o teste NÃO pegou a sabotagem');
    });
  }
  const origAllowed = clubPush.whatsappAllowed;
  await sabotage('notify ignorando a preferência de WhatsApp',
    () => { clubPush.whatsappAllowed = async () => true; },
    async () => {
      const before = await outboxCount([U.p5.id]);
      await notifySvc.notify(U.p5.id, { type: 'game_soon', title: 'x', body: 'y' });
      await settle();
      assert.strictEqual(await outboxCount([U.p5.id]), before);
    },
    () => { clubPush.whatsappAllowed = origAllowed; });
  await sabotage('fim de jogo sem a trava de idempotência (chave apagada → aviso duplicado)',
    () => prisma.clubPushLog.deleteMany({ where: { OR: [{ key: { startsWith: 'mres:' + bm.id } }, { key: { startsWith: 'mresv:' + bm.id } }] } }),
    async () => {
      await matchNotices.run(bm.id);
      await settle();
      assert.strictEqual((await notifs(U.p4)).length, 1);
    },
    async () => { /* o aviso extra fica (banco descartável) */ });
  const origLoad = access.loadVisibleTournament;
  await sabotage('arte sem checar visibilidade (privado aparecendo)',
    () => { access.loadVisibleTournament = (req, key, opts) => prisma.tournament.findFirst({ where: { OR: [{ id: String(key) }, { slug: String(key) }] }, ...(opts && opts.select ? { select: opts.select } : {}) }); },
    async () => {
      const { out } = await privChecks();
      for (const o of out) assert.ok(o.status === 404 && o.same);
    },
    () => { access.loadVisibleTournament = origLoad; });
  const origCan = roles.can;
  await sabotage('"Entrar neste time" sem checar quem pode publicar o link',
    () => { roles.can = async () => true; },
    async () => {
      const c = await call('POST', `/api/tournaments/entries/${eB.id}/team-invite`, { token: tok(U.org), body: {} });
      const r = await call('PATCH', `/api/tournaments/entries/${eB.id}/team-invite`, { token: tok(U.other), body: { public: true, token: c.json.token } });
      assert.strictEqual(r.status, 403);
    },
    () => { roles.can = origCan; });
  whatsappCloud.enabled = origEnabled;

  // ================================================================ g. app real
  console.log('  — páginas no app real (src/index.js)');
  const PORT = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, WA_BRIDGE_KEY: '', PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', TREG_SWEEPER: 'off', RNA_ATIVA: '0', RNA_RELOGIO: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOut = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childOut += d; });
  const page = (p) => httpCall('GET', `http://127.0.0.1:${PORT}${p}`, {});
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { const r = await page('/api/health'); up = r.status === 200 || r.status === 503; } catch (_) {}
  }
  if (!up) {
    skip('páginas no app real', 'app não subiu: ' + childOut.slice(-400));
  } else {
    await ok('/t/:slug: Compartilhar (folha), "Entrar num time", "Criar minha liga" e SSE com volta para a consulta', async () => {
      const r = await page('/t/' + T.slug);
      assert.strictEqual(r.status, 200);
      assert.ok(/data-testid="join-btn"/.test(r.text) && /href="\/criar-liga"/.test(r.text) && /openShareSheet/.test(r.text));
      assert.ok(r.text.indexOf('/club/live-sse.js') > 0 && r.text.indexOf('/club/live-sse.js') < r.text.indexOf('/club/torneio-midia.js'));
      assert.ok(/SSE_DOWN&&DATA\.matches/.test(r.text));
    });
    await ok('/atleta/:u e /clube/:slug têm "Criar minha liga"; /atleta compartilha o card pronto', async () => {
      const a = await page('/atleta/' + U.p1.username);
      assert.strictEqual(a.status, 200);
      assert.ok(/href="\/criar-liga"/.test(a.text) && /arte\/atleta\.png\?formato=/.test(a.text));
      const c = await page('/clube/' + clubA.slug);
      assert.strictEqual(c.status, 200);
      assert.ok(/criar-liga/.test(c.text));
    });
    await ok('telão e embed usam o SSE com reconexão (live-sse.js); /club/live-sse.js servido', async () => {
      for (const p of ['/t/' + T.slug + '/telao', '/t/' + T.slug + '/embed']) {
        const r = await page(p);
        assert.strictEqual(r.status, 200, p);
        assert.ok(/\/club\/live-sse\.js/.test(r.text), p);
      }
      const js = await page('/club/live-sse.js');
      assert.strictEqual(js.status, 200);
      assert.ok(/ClubLiveSSE/.test(js.text));
    });
    await ok('página do torneio PRIVADO sem login = 404 (não vaza nada da F4)', async () => {
      const r = await page('/t/' + PT.slug);
      assert.strictEqual(r.status, 404);
    });
  }
  child.kill();
  server.close();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F4 — compartilhar e voltar: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exit(failed ? 1 : 0);
  });
