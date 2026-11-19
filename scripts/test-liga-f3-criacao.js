'use strict';
// =====================================================================
// Liga Aberta — FASE 3 (criação em 2 minutos). npm run test:liga-f3
//
// Parte 1 (sem banco): modelos prontos, regras do jogo (legado = futsal com
//   6ª falta), sorteio equilibrado (menor diferença possível, determinístico
//   pela semente), próxima edição, leitura da lista colada, schema aditivo
//   no início do ensureApexSchema e súmula sem o "6" fixo no front.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. POST /quick: 8 times → torneio + categoria + 8 inscrições com clube +
//      jogos, numa transação (falha no meio não deixa lixo); modelos aplicados;
//      sem login = 401; limitador de criação (429); validações
//   b. regras por categoria: pontos/desempate, 6ª falta vinda da regra (padrão 6),
//      tipo de evento rejeitado por esporte, basquete somando pontos, vôlei em
//      sets, categoria SEM regra salva = comportamento antigo (Master Cup intacto)
//   c. racha: presença, sorteio equilibrado (semente), placar rápido, artilharia
//      da temporada, histórico do atleta, fora do rating
//   d. link do time: válido, vencido, revogado, limite do elenco, permissão
//   e. duplicar: clubes e elencos mantidos, sem jogos, rascunho, nova edição
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Força bruta: menor diferença de soma possível entre 2 times (tamanhos floor/ceil).
function bruteMinDiff(levels) {
  const w = levels.map((x) => Math.round(x * 10));
  const n = w.length; const size = Math.floor(n / 2); const total = w.reduce((a, b) => a + b, 0);
  let best = Infinity;
  for (let mask = 0; mask < (1 << n); mask++) {
    let c = 0; let s = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { c++; s += w[i]; }
    if (c === size) best = Math.min(best, Math.abs(total - 2 * s));
  }
  return best / 10;
}

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f3-' + crypto.randomBytes(8).toString('hex');
  const presets = require('../src/services/tournamentPresets');
  const gr = require('../src/services/tournamentRules');
  const pickup = require('../src/services/pickup');
  const { nextEdition } = require('../src/services/tournamentDuplicate');
  const quick = require('../src/services/quickTournament');

  await ok('5 modelos prontos: racha semanal, pontos corridos, copa, torneio de um dia, ranking de duplas', () => {
    const ids = presets.PRESETS.map((p) => p.id);
    assert.deepStrictEqual(ids, ['racha-semanal', 'liga-pontos-corridos', 'copa-grupos-mata-mata', 'torneio-um-dia', 'ranking-duplas']);
    for (const p of presets.PRESETS) {
      assert.ok(p.format && p.label && Array.isArray(p.tiebreakers) && p.pointsWin != null && p.doubleRound !== undefined, p.id);
    }
  });
  await ok('modelo preenche formato, pontos, desempate, ida/volta, duração e nº de jogadores', () => {
    const r = presets.applyPreset(presets.presetById('racha-semanal'), 'FUTSAL');
    assert.strictEqual(r.format, 'PICKUP');
    assert.strictEqual(r.category.gameRules.periods, 1);
    assert.strictEqual(r.category.gameRules.minutesPerPeriod, 10);
    assert.strictEqual(r.category.gameRules.playersOnField, 5);
    const l = presets.applyPreset(presets.presetById('liga-pontos-corridos'), 'FUTSAL');
    assert.strictEqual(l.format, 'ROUND_ROBIN');
    for (const k of ['HEAD_TO_HEAD', 'GOAL_DIFF', 'GOALS_FOR', 'FAIR_PLAY', 'DRAW']) assert.ok(l.category.tiebreakers.includes(k), k);
    assert.strictEqual(l.category.gameRules.minutesPerPeriod, 20);
    const d = presets.applyPreset(presets.presetById('ranking-duplas'), 'BEACH_TENNIS');
    assert.ok(d.isDoubles);
    assert.strictEqual(d.category.gameRules.playersOnField, 2);
    const um = presets.applyPreset(presets.presetById('torneio-um-dia'), 'TENNIS');
    assert.strictEqual(um.category.gameRules.minutesPerPeriod, null, 'raquete não ganha tempo de jogo');
  });
  await ok('categoria SEM regra salva = comportamento antigo (eventos de futsal, 6ª falta, mesmo texto)', () => {
    for (const sport of ['FUTSAL', 'BASKETBALL', 'VOLLEY', null]) {
      const r = gr.resolveRules({ gameRules: null }, sport);
      assert.strictEqual(r.source, 'legacy');
      assert.deepStrictEqual(r.events, ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT']);
      assert.strictEqual(r.foulLimit, 6);
      assert.strictEqual(r.foulText, 'tiro livre direto sem barreira');
      assert.strictEqual(r.foulWarnText, 'a próxima é tiro livre direto');
      assert.strictEqual(r.periods, 2);
      assert.deepStrictEqual(r.scoring, { GOAL: 1 });
    }
  });
  await ok('regra nova por esporte: basquete soma 1/2/3, vôlei conta sets, futsal = 6 faltas', () => {
    const b = gr.resolveRules({ gameRules: gr.defaultsFor('BASKETBALL') }, 'BASKETBALL');
    assert.deepStrictEqual(b.scoring, { PT1: 1, PT2: 2, PT3: 3 });
    assert.deepStrictEqual(gr.scoreFromEvents([{ entryId: 'h', type: 'PT3' }, { entryId: 'h', type: 'PT2' }, { entryId: 'a', type: 'PT1' }, { entryId: 'h', type: 'FOUL' }], b, 'h', 'a'), { home: 5, away: 1 });
    const v = gr.resolveRules({ gameRules: gr.defaultsFor('VOLLEY') }, 'VOLLEY');
    assert.deepStrictEqual(v.scoring, { SET: 1 });
    assert.strictEqual(gr.resolveRules({ gameRules: gr.defaultsFor('FUTSAL') }, 'FUTSAL').foulLimit, 6);
  });
  await ok('regra inválida é recusada (tipo inexistente, sem tipo que marca ponto, número fora da faixa)', () => {
    assert.ok(gr.normalizeGameRules({ events: ['GOAL', 'CHUTE'] }).error);
    assert.ok(gr.normalizeGameRules({ events: ['FOUL', 'TIMEOUT'] }).error);
    assert.ok(gr.normalizeGameRules({ foulLimit: 99 }).error);
    assert.ok(gr.normalizeGameRules({ periods: 0 }).error);
    assert.deepStrictEqual(gr.normalizeGameRules({ foulLimit: 5, events: ['goal', 'FOUL'] }).data, { foulLimit: 5, events: ['GOAL', 'FOUL'] });
  });
  await ok('sorteio equilibrado: menor diferença possível (força bruta) e determinístico pela semente', () => {
    let rng = 7;
    const rnd = () => { rng = (rng * 1103515245 + 12345) % 2147483648; return rng / 2147483648; };
    for (let c = 0; c < 25; c++) {
      const n = 4 + (c % 9);
      const ps = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, level: Math.round(rnd() * 70) / 10 }));
      const r = pickup.balancedTeams(ps, 2, 'semente-' + c);
      const diff = Math.abs(r[0].levelSum - r[1].levelSum);
      assert.ok(Math.abs(diff - bruteMinDiff(ps.map((p) => p.level))) < 1e-9, `caso ${c}: ${diff} ≠ ${bruteMinDiff(ps.map((p) => p.level))}`);
      assert.ok(Math.abs(r[0].ids.length - r[1].ids.length) <= 1);
      assert.deepStrictEqual(pickup.balancedTeams(ps, 2, 'semente-' + c), r, 'mesma semente deu outro sorteio');
    }
    const big = Array.from({ length: 15 }, (_, i) => ({ id: 'q' + i, level: (i % 7) + 0.5 }));
    const three = pickup.balancedTeams(big, 3, 'x');
    const sums = three.map((t) => t.levelSum);
    assert.ok(Math.max(...sums) - Math.min(...sums) <= 1, '3 times desequilibrados: ' + sums);
    assert.deepStrictEqual(three.map((t) => t.ids.length).sort(), [5, 5, 5]);
  });
  await ok('próxima edição: 2026→2027 (e no nome), II→III, sem edição→ano no nome ou 2', () => {
    assert.deepStrictEqual(nextEdition('Copa Verão 2026', '2026'), { edition: '2027', name: 'Copa Verão 2027' });
    assert.deepStrictEqual(nextEdition('II Futsal Master Cup', 'II'), { edition: 'III', name: 'III Futsal Master Cup' });
    assert.deepStrictEqual(nextEdition('Liga do Bairro 2026', null), { edition: '2027', name: 'Liga do Bairro 2027' });
    assert.deepStrictEqual(nextEdition('Racha de Quinta', null), { edition: '2', name: 'Racha de Quinta' });
  });
  await ok('lista colada: um por linha, tira numeração/marcador e linhas vazias', () => {
    assert.deepStrictEqual(quick.parseNames('1. Leões\n\n2) Tubarões \n- Águias\n•  Falcões  FC'), ['Leões', 'Tubarões', 'Águias', 'Falcões FC']);
  });
  await ok('schema F3 aditivo no INÍCIO do ensureApexSchema (antes da F2) e coerente com o schema.prisma', () => {
    const sch = fs.readFileSync(path.join(__dirname, '../src/services/ensureApexSchema.js'), 'utf8');
    const first = sch.indexOf('STATEMENTS = [');
    const gi = sch.indexOf('"gameRules"', first);
    assert.ok(gi > first && gi < sch.indexOf('"clubId"', first), 'gameRules tem que vir antes do clubId');
    for (const tb of ['TeamInvite', 'PickupPlayer', 'PickupSession', 'PickupAttendance']) {
      assert.ok(sch.indexOf('CREATE TABLE IF NOT EXISTS "' + tb + '"', first) < sch.indexOf('"clubId"', first), tb);
    }
    assert.ok(!/DROP (TABLE|COLUMN)/i.test(sch), 'nunca apagar');
    const prismaSchema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
    for (const m of ['model TeamInvite', 'model PickupPlayer', 'model PickupSession', 'model PickupAttendance', 'gameRules      Json?']) assert.ok(prismaSchema.includes(m), m);
  });
  await ok('súmula: alerta de falta vem da regra (nada de "6" fixo no front); rotas novas existem', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/torneios.html'), 'utf8');
    assert.ok(!/x\[1\]>=6/.test(html) && !/fouls\.home>=6/.test(html), 'alerta da 6ª falta ainda fixo');
    assert.ok(html.includes('foulLimit'), 'súmula não lê a regra');
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/tournaments.js'), 'utf8');
    for (const r of ["'/quick'", "'/presets'", "'/:id/duplicate'", "'/:idOrSlug/pickup'", "'/:id/pickup/draw'", "'/pickup/games/:matchId/score'", "'/:idOrSlug/pickup/scorers'", "'/entries/:entryId/team-invite'", "'/team-invites/:token'", "'/team-invites/:token/join'"]) {
      assert.ok(src.includes(r), 'faltou rota ' + r);
    }
    assert.ok(!/ownerId !== req\.userId/.test(src), 'checagem de dono inline');
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('criação rápida, regras, racha, link do time, duplicar', 'DATABASE_URL local (localhost) não definido');
    if (process.env.CI) { failed++; console.error('  ❌ no CI a parte de banco não pode ser pulada'); }
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const engine = require('../src/services/tournamentEngine');
  const gr = require('../src/services/tournamentRules');
  const pickup = require('../src/services/pickup');
  const roles = require('../src/services/tournamentRoles');
  const teamInvite = require('../src/services/teamInvite');
  await ensureApexSchema(prisma);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
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
  const mkUser = (label, extra = {}) => prisma.user.create({ data: { name: `F3 ${label} ${RUN}-${++seq}`, phone: '838' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const U = {
    org: await mkUser('organizador'),
    other: await mkUser('qualquer'),
    org2: await mkUser('organizador 2'),
    teamAdmin: await mkUser('admin do time'),
    coord: await mkUser('coordenador'),
    p1: await mkUser('jogador 1'),
    p2: await mkUser('jogador 2'),
    p3: await mkUser('jogador 3'),
    limiter: await mkUser('limitador'),
    racheiro: await mkUser('racheiro', { username: 'f3rach' + RUN }),
  };
  const TEAMS8 = ['Leões', 'Tubarões', 'Águias', 'Falcões', 'Panteras', 'Lobos', 'Touros', 'Gaviões'].map((n) => n + ' ' + RUN);

  // ---------------------------------------- Master Cup (proteção): categoria SEM regra salva
  let MC = await prisma.tournament.findUnique({ where: { slug: 'futsal-master-cup-2026' } });
  if (!MC) MC = await prisma.tournament.create({ data: { slug: 'futsal-master-cup-2026', name: 'II Futsal Master Cup 2026 (teste)', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', ownerId: U.org.id, status: 'ONGOING' } });
  let mcCat = await prisma.tournamentCategory.findFirst({ where: { tournamentId: MC.id } });
  if (!mcCat) mcCat = await prisma.tournamentCategory.create({ data: { tournamentId: MC.id, name: '40+ A' } });
  let mcE = await prisma.tournamentEntry.findMany({ where: { tournamentId: MC.id } });
  if (mcE.length < 2) {
    mcE = [await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, name: 'Cabo Branco', groupName: 'A' } }), await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, name: 'Amigos CG', groupName: 'A' } })];
  }
  let mcMatch = await prisma.tournamentMatch.findFirst({ where: { tournamentId: MC.id } });
  if (!mcMatch) mcMatch = await prisma.tournamentMatch.create({ data: { tournamentId: MC.id, categoryId: mcCat.id, stage: 'GROUP', groupName: 'A', round: 1, homeEntryId: mcE[0].id, awayEntryId: mcE[1].id, status: 'SCHEDULED' } });
  const snapMC = async () => JSON.stringify({
    t: await prisma.tournament.findUnique({ where: { id: MC.id } }),
    c: await prisma.tournamentCategory.findMany({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } }),
    e: await prisma.tournamentEntry.findMany({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } }),
    m: await prisma.tournamentMatch.findMany({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } }),
  });
  const mcBefore = await snapMC();

  // ================================================================ a. /quick
  console.log('  — a. criação rápida (POST /quick)');
  const quickBody = (extra = {}) => ({ sport: 'FUTSAL', preset: 'copa-grupos-mata-mata', teams: TEAMS8.join('\n'), ...extra });
  let Q;
  await ok('sem login = 401 (nada gravado)', async () => {
    const before = await prisma.tournament.count();
    const r = await call('POST', '/api/tournaments/quick', { body: quickBody() });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(await prisma.tournament.count(), before);
  });
  await ok('8 times colados → torneio + categoria + 8 inscrições com clube + jogos gerados', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: quickBody() });
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    Q = r.json;
    assert.ok(Q.url.endsWith('/t/' + Q.tournament.slug) && Q.whatsappUrl.startsWith('https://wa.me/?text='));
    const t = await prisma.tournament.findUnique({ where: { id: Q.tournament.id } });
    assert.strictEqual(t.ownerId, U.org.id);
    assert.strictEqual(t.format, 'GROUPS_KNOCKOUT');
    assert.strictEqual(t.status, 'ONGOING');
    assert.strictEqual(t.cashEnabled, false);
    assert.ok(/^Copa de Futsal · [A-Z][a-z]{2}\/20\d\d$/.test(t.name), 'nome sugerido: ' + t.name);
    const cats = await prisma.tournamentCategory.findMany({ where: { tournamentId: t.id } });
    assert.strictEqual(cats.length, 1);
    assert.deepStrictEqual(cats[0].tiebreakers, ['POINTS', 'GOAL_DIFF', 'GOALS_FOR', 'HEAD_TO_HEAD', 'FAIR_PLAY', 'DRAW']);
    assert.strictEqual(cats[0].gameRules.foulLimit, 6);
    const es = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id }, include: { club: true } });
    assert.strictEqual(es.length, 8);
    assert.ok(es.every((e) => e.clubId && e.club && e.club.name === e.name && e.status === 'CONFIRMED'), 'todo time com clube');
    assert.strictEqual(new Set(es.map((e) => e.clubId)).size, 8);
    assert.ok(es.every((e) => e.club.originTournamentId === t.id && e.club.ownerId === U.org.id));
    const m = await prisma.tournamentMatch.count({ where: { tournamentId: t.id } });
    assert.strictEqual(m, 12, '2 grupos de 4 = 12 jogos');
    assert.strictEqual(Q.matchesCreated, 12);
    const au = await prisma.tournamentAudit.findFirst({ where: { tournamentId: t.id, action: 'tournament.create' } });
    assert.ok(au && au.after.quick === true && au.after.teams === 8);
  });
  await ok('a página pública do torneio criado responde e a tabela sai na API pública', async () => {
    const r = await call('GET', `/api/tournaments/${Q.tournament.slug}`);
    assert.strictEqual(r.status, 200);
    const s = await call('GET', `/api/tournaments/${Q.tournament.id}/categories/${Q.categoryId}/standings`);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.json.standings.length, 8);
  });
  const presetCases = [
    ['liga-pontos-corridos', 'FUTSAL', 'ROUND_ROBIN', 28, (c) => { assert.strictEqual(c.gameRules.minutesPerPeriod, 20); assert.ok(c.tiebreakers.includes('HEAD_TO_HEAD')); }],
    ['torneio-um-dia', 'SOCCER', 'KNOCKOUT', 8, (c) => { assert.strictEqual(c.gameRules.periods, 1); assert.strictEqual(c.gameRules.minutesPerPeriod, 15); }],
    ['ranking-duplas', 'BEACH_TENNIS', 'ROUND_ROBIN', 28, (c, t, es) => { assert.ok(t.isDoubles); assert.strictEqual(c.pointsDraw, 0); assert.ok(es.every((e) => !e.clubId), 'dupla não vira clube'); }],
  ];
  for (const [preset, sport, fmt, nMatches, extra] of presetCases) {
    await ok(`modelo "${preset}" aplicado (${sport} → ${fmt})`, async () => {
      const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport, preset, teams: TEAMS8.map((x) => x + ' ' + preset) } });
      assert.strictEqual(r.status, 201, r.text.slice(0, 300));
      const t = await prisma.tournament.findUnique({ where: { id: r.json.tournament.id } });
      assert.strictEqual(t.format, fmt);
      const c = await prisma.tournamentCategory.findFirst({ where: { tournamentId: t.id } });
      const es = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id } });
      assert.strictEqual(es.length, 8);
      const m = await prisma.tournamentMatch.count({ where: { tournamentId: t.id } });
      assert.strictEqual(m, nMatches, 'jogos gerados');
      extra(c, t, es);
    });
  }
  let RACHA;
  await ok('modelo "racha-semanal": cria os JOGADORES do racha (sem tabela) e link /racha/', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', preset: 'racha-semanal', teams: ['Ana', 'Bia', 'Caio', 'Duda', 'Edu', 'Fabi', 'Gui', 'Hugo'].map((n) => n + ' ' + RUN) } });
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    RACHA = r.json;
    assert.ok(RACHA.url.includes('/racha/'));
    const t = await prisma.tournament.findUnique({ where: { id: RACHA.tournament.id } });
    assert.strictEqual(t.format, 'PICKUP');
    assert.strictEqual(await prisma.pickupPlayer.count({ where: { tournamentId: t.id } }), 8);
    assert.strictEqual(await prisma.tournamentEntry.count({ where: { tournamentId: t.id } }), 0);
  });
  await ok('só o formato (sem modelo) também publica — mata-mata com 5 times (bye)', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport: 'VOLLEY', format: 'KNOCKOUT', name: 'Vôlei de Praia ' + RUN, teams: ['A', 'B', 'C', 'D', 'E'].map((x) => x + RUN) } });
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    assert.strictEqual(r.json.tournament.name, 'Vôlei de Praia ' + RUN);
    assert.ok(r.json.matchesCreated >= 4);
  });
  await ok('64 times publicam (mata-mata de 64 = 63 jogos + 3º lugar)', async () => {
    const names = Array.from({ length: 64 }, (_, i) => `Time ${i + 1} ${RUN}`);
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport: 'FUTSAL', format: 'KNOCKOUT', teams: names } });
    assert.strictEqual(r.status, 201, r.text.slice(0, 300));
    assert.strictEqual(await prisma.tournamentEntry.count({ where: { tournamentId: r.json.tournament.id } }), 64);
    assert.strictEqual(r.json.matchesCreated, 64);
    assert.strictEqual(await prisma.tournamentMatch.count({ where: { tournamentId: r.json.tournament.id } }), 64);
  });
  await ok('validações: nomes repetidos (acento/caixa), 1 time, 65 times, esporte, modelo de outro esporte', async () => {
    const bad = async (body, re) => { const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body }); assert.strictEqual(r.status, 400, JSON.stringify(body).slice(0, 80) + ' → ' + r.status); assert.ok(re.test(r.json.error), r.json.error); };
    await bad({ sport: 'FUTSAL', format: 'ROUND_ROBIN', teams: ['Leões', 'LEÕES ', 'Tigres'] }, /repetidos/);
    await bad({ sport: 'FUTSAL', format: 'ROUND_ROBIN', teams: ['Só um'] }, /pelo menos 2/);
    await bad({ sport: 'FUTSAL', format: 'ROUND_ROBIN', teams: Array.from({ length: 65 }, (_, i) => 'T' + i) }, /máximo de 64/);
    await bad({ sport: 'XADREZ', format: 'ROUND_ROBIN', teams: ['A', 'B'] }, /esporte/);
    await bad({ sport: 'FUTSAL', preset: 'ranking-duplas', teams: ['A', 'B'] }, /não serve/);
    await bad({ sport: 'FUTSAL', format: 'AMERICANO', teams: ['A', 'B'] }, /formato/);
  });
  const origGen = engine.generateFixtures;
  const checkNoGarbage = async () => {
    const before = { t: await prisma.tournament.count(), c: await prisma.club.count(), e: await prisma.tournamentEntry.count(), cat: await prisma.tournamentCategory.count() };
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', format: 'ROUND_ROBIN', teams: ['X1', 'X2', 'X3'].map((x) => x + RUN + Math.random()) } });
    const after = { t: await prisma.tournament.count(), c: await prisma.club.count(), e: await prisma.tournamentEntry.count(), cat: await prisma.tournamentCategory.count() };
    assert.strictEqual(r.status, 500, 'esperava falha simulada: ' + r.status);
    assert.deepStrictEqual(after, before, 'sobrou lixo da criação que falhou');
  };
  await ok('transação: falha DEPOIS de criar clubes e inscrições não deixa lixo (torneio, clube, inscrição, categoria)', async () => {
    engine.generateFixtures = async () => { throw new Error('falha simulada no meio'); };
    try { await checkNoGarbage(); } finally { engine.generateFixtures = origGen; }
  });
  await ok('limitador da F0 vale na criação rápida (21ª em 1 h = 429)', async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await call('POST', '/api/tournaments/quick', { token: tok(U.limiter), body: { sport: 'FUTSAL' } });
    assert.strictEqual(last.status, 429, 'status ' + last.status);
    assert.ok(/torneios criados/.test(last.json.error));
  });
  await ok('GET /presets lista modelos, formatos e tipos de evento (sem login)', async () => {
    const r = await call('GET', '/api/tournaments/presets');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.presets.length, 5);
    assert.ok(r.json.eventTypes.PT3 && r.json.formats.some((f) => f.id === 'PICKUP') && r.json.maxTeams === 64);
  });

  // ================================================================ b. regras por categoria
  console.log('  — b. regras por categoria');
  const qcat = await prisma.tournamentCategory.findUnique({ where: { id: Q.categoryId } });
  await ok('pontos V/E/D e ordem de desempate editáveis (confronto direto, saldo, gols pró, menos cartões, sorteio)', async () => {
    const r = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.org), body: { pointsWin: 2, pointsDraw: 1, pointsLoss: 0, tiebreakers: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF', 'GOALS_FOR', 'FAIR_PLAY', 'DRAW'] } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.pointsWin, 2);
    assert.deepStrictEqual(r.json.tiebreakers, ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF', 'GOALS_FOR', 'FAIR_PLAY', 'DRAW']);
    const o = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.other), body: { pointsWin: 9 } });
    assert.strictEqual(o.status, 403);
  });
  await ok('regras do jogo editáveis (duração, jogadores, elenco, faltas) e tipo inválido recusado', async () => {
    const r = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.org), body: { gameRules: { periods: 2, minutesPerPeriod: 25, playersOnField: 5, maxRoster: 14, foulLimit: 5, foulText: 'tiro livre sem barreira' } } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.rules.foulLimit, 5);
    assert.strictEqual(r.json.rules.minutesPerPeriod, 25);
    assert.strictEqual(r.json.rules.maxRoster, 14);
    const bad = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.org), body: { gameRules: { events: ['GOAL', 'ESCANTEIO'] } } });
    assert.strictEqual(bad.status, 400);
    const back = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.org), body: { gameRules: { foulLimit: 6, foulText: 'tiro livre direto sem barreira', maxRoster: null } } });
    assert.strictEqual(back.json.rules.foulLimit, 6);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: Q.tournament.id, action: 'category.rules' } }));
  });
  const qm = await prisma.tournamentMatch.findFirst({ where: { tournamentId: Q.tournament.id, homeEntryId: { not: null }, awayEntryId: { not: null } } });
  const rp = await prisma.rosterPlayer.create({ data: { entryId: qm.homeEntryId, name: 'Camisa 10', number: 10 } });
  await ok('súmula entrega a regra (6ª falta vem da regra, padrão 6) e recusa evento fora da regra', async () => {
    const s = await call('GET', `/api/tournaments/matches/${qm.id}/sheet`);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.json.rules.foulLimit, 6);
    assert.strictEqual(s.json.rules.source, 'category');
    const bad = await call('POST', `/api/tournaments/matches/${qm.id}/events`, { token: tok(U.org), body: { entryId: qm.homeEntryId, type: 'PT3', playerId: rp.id } });
    assert.strictEqual(bad.status, 400);
    assert.ok(/regra/.test(bad.json.error));
    const g = await call('POST', `/api/tournaments/matches/${qm.id}/events`, { token: tok(U.org), body: { entryId: qm.homeEntryId, type: 'GOAL', playerId: rp.id } });
    assert.strictEqual(g.status, 201, g.text);
  });
  let checkLegacy;
  await ok('categoria SEM regra salva (Master Cup) = comportamento antigo: eventos de futsal, 6ª falta, placar por gol', async () => {
    checkLegacy = async () => {
      const s = await call('GET', `/api/tournaments/matches/${mcMatch.id}/sheet`);
      assert.strictEqual(s.status, 200);
      assert.strictEqual(s.json.rules.source, 'legacy');
      assert.strictEqual(s.json.rules.foulLimit, 6);
      assert.strictEqual(s.json.rules.foulText, 'tiro livre direto sem barreira');
      assert.deepStrictEqual(s.json.rules.events, ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT']);
      const cats = await call('GET', `/api/tournaments/${MC.id}/categories`);
      assert.strictEqual(cats.json.categories[0].rules.source, 'legacy');
      assert.strictEqual(cats.json.categories[0].gameRules, null);
    };
    await checkLegacy();
  });
  await ok('basquete: cestas de 1/2/3 somam o placar (ao vivo e no fechamento); gol é recusado', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport: 'BASKETBALL', preset: 'liga-pontos-corridos', teams: ['Bulls ' + RUN, 'Lakers ' + RUN] } });
    assert.strictEqual(r.status, 201, r.text.slice(0, 200));
    const m = await prisma.tournamentMatch.findFirst({ where: { tournamentId: r.json.tournament.id } });
    const pa = await prisma.rosterPlayer.create({ data: { entryId: m.homeEntryId, name: 'Armador', number: 7 } });
    const pb = await prisma.rosterPlayer.create({ data: { entryId: m.awayEntryId, name: 'Pivô', number: 15 } });
    const ev = (entryId, type, playerId) => call('POST', `/api/tournaments/matches/${m.id}/events`, { token: tok(U.org2), body: { entryId, type, playerId } });
    assert.strictEqual((await ev(m.homeEntryId, 'GOAL', pa.id)).status, 400);
    for (const [e, t, p] of [[m.homeEntryId, 'PT3', pa.id], [m.homeEntryId, 'PT2', pa.id], [m.homeEntryId, 'PT1', pa.id], [m.awayEntryId, 'PT2', pb.id], [m.homeEntryId, 'FOUL', null]]) {
      const x = await ev(e, t, p);
      assert.strictEqual(x.status, 201, t + ' ' + x.text);
    }
    const s = await call('GET', `/api/tournaments/matches/${m.id}/sheet`);
    assert.deepStrictEqual(s.json.liveScore, { home: 6, away: 2 });
    assert.strictEqual(s.json.rules.foulLimit, 5);
    const pub = await call('GET', `/api/tournaments/${r.json.tournament.id}/categories/${r.json.categoryId}/matches`);
    const pm = pub.json.matches.find((x) => x.id === m.id);
    assert.deepStrictEqual(pm.liveScore, { home: 6, away: 2 }, 'placar ao vivo público');
    const f = await call('POST', `/api/tournaments/matches/${m.id}/finalize`, { token: tok(U.org2), body: {} });
    assert.strictEqual(f.status, 200, f.text);
    const after = await prisma.tournamentMatch.findUnique({ where: { id: m.id } });
    assert.strictEqual(after.homeScore, 6);
    assert.strictEqual(after.awayScore, 2);
    const st = await call('GET', `/api/tournaments/${r.json.tournament.id}/stats/scorers?categoryId=${r.json.categoryId}`);
    const top = st.json.ranking.find((x) => x.playerId === pa.id);
    assert.ok(top && top.goals === 6, 'artilharia do basquete = pontos: ' + JSON.stringify(st.json.ranking));
  });
  await ok('vôlei: placar em sets (SET), ponto não soma no placar', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport: 'VOLLEY', format: 'ROUND_ROBIN', teams: ['Saque ' + RUN, 'Bloqueio ' + RUN] } });
    const m = await prisma.tournamentMatch.findFirst({ where: { tournamentId: r.json.tournament.id } });
    for (const [e, t] of [[m.homeEntryId, 'POINT'], [m.homeEntryId, 'SET'], [m.awayEntryId, 'SET'], [m.homeEntryId, 'SET']]) {
      const x = await call('POST', `/api/tournaments/matches/${m.id}/events`, { token: tok(U.org2), body: { entryId: e, type: t } });
      assert.strictEqual(x.status, 201, t + ' ' + x.text);
    }
    const f = await call('POST', `/api/tournaments/matches/${m.id}/finalize`, { token: tok(U.org2), body: {} });
    assert.strictEqual(f.status, 200, f.text);
    const after = await prisma.tournamentMatch.findUnique({ where: { id: m.id } });
    assert.deepStrictEqual([after.homeScore, after.awayScore], [2, 1]);
  });
  await ok('categoria nova (POST /categories) grava o padrão do esporte; categoria antiga editada parte do legado', async () => {
    const c = await call('POST', `/api/tournaments/${Q.tournament.id}/categories`, { token: tok(U.org), body: { name: 'Sub-17' } });
    assert.strictEqual(c.status, 201, c.text);
    assert.strictEqual(c.json.gameRules.foulLimit, 6);
    assert.deepStrictEqual(c.json.gameRules.events, ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT']);
    // outra categoria antiga (fora do Master Cup) sem regra: editar 1 campo mantém o resto do legado
    const oldT = await prisma.tournament.create({ data: { slug: 'f3-antigo-' + RUN, name: 'Antigo', sport: 'BASKETBALL', format: 'ROUND_ROBIN', ownerId: U.org.id } });
    const oc = await prisma.tournamentCategory.create({ data: { tournamentId: oldT.id, name: 'Livre' } });
    const p = await call('PATCH', `/api/tournaments/${oldT.id}/categories/${oc.id}`, { token: tok(U.org), body: { gameRules: { foulLimit: 4 } } });
    assert.strictEqual(p.status, 200, p.text);
    assert.deepStrictEqual(p.json.rules.events, ['GOAL', 'ASSIST', 'YELLOW', 'RED', 'FOUL', 'TIMEOUT'], 'não virou regra de basquete sozinho');
    assert.strictEqual(p.json.rules.foulLimit, 4);
  });

  // ================================================================ c. racha
  console.log('  — c. racha');
  const RT = RACHA.tournament;
  const rachaPlayers = await prisma.pickupPlayer.findMany({ where: { tournamentId: RT.id }, orderBy: { name: 'asc' } });
  const LV = [6, 5.5, 2, 3, 4, 1.5, 5, 2.5];
  for (let i = 0; i < rachaPlayers.length; i++) await prisma.pickupPlayer.update({ where: { id: rachaPlayers[i].id }, data: { level: LV[i] } });
  await ok('organização adiciona jogadores (com nível); qualquer um não', async () => {
    const r = await call('POST', `/api/tournaments/${RT.id}/pickup/players`, { token: tok(U.org), body: { names: ['Igor ' + RUN, 'Juca ' + RUN], level: 4 } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.json.created, 2);
    const dup = await call('POST', `/api/tournaments/${RT.id}/pickup/players`, { token: tok(U.org), body: { names: ['IGOR ' + RUN] } });
    assert.strictEqual(dup.json.created, 0, 'nome repetido não duplica');
    const o = await call('POST', `/api/tournaments/${RT.id}/pickup/players`, { token: tok(U.other), body: { names: ['Intruso'] } });
    assert.strictEqual(o.status, 403);
    const lv = await call('PATCH', `/api/tournaments/pickup/players/${r.json.players[1].id}`, { token: tok(U.org), body: { level: 9 } });
    assert.strictEqual(lv.status, 400, 'nível fora de 0–7');
  });
  const igorJuca = await prisma.pickupPlayer.findMany({ where: { tournamentId: RT.id, name: { in: ['Igor ' + RUN, 'Juca ' + RUN] } } });
  await ok('presença: organização marca; jogador confirma/desconfirma pelo link; anônimo = 401', async () => {
    for (const p of rachaPlayers) {
      const r = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { token: tok(U.org), body: { playerId: p.id, confirm: true } });
      assert.strictEqual(r.status, 200, r.text);
    }
    const o = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { token: tok(U.other), body: { playerId: igorJuca[0].id, confirm: true } });
    assert.strictEqual(o.status, 403, 'qualquer um marcando presença de outro');
    const me = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { token: tok(U.racheiro), body: { confirm: true } });
    assert.strictEqual(me.status, 200, me.text);
    assert.strictEqual(me.json.status, 'IN');
    const mine = await prisma.pickupPlayer.findFirst({ where: { tournamentId: RT.id, userId: U.racheiro.id } });
    assert.ok(mine, 'jogador do racha criado com a conta');
    const out = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { token: tok(U.racheiro), body: { confirm: false } });
    assert.strictEqual(out.json.status, 'OUT');
    const back = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { token: tok(U.racheiro), body: { confirm: true } });
    assert.strictEqual(back.json.status, 'IN');
    const anon = await call('POST', `/api/tournaments/${RT.id}/pickup/attendance`, { body: { confirm: true } });
    assert.strictEqual(anon.status, 401);
    const v = await call('GET', `/api/tournaments/${RT.slug}/pickup`, { token: tok(U.racheiro) });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.json.confirmed, 9);
    assert.strictEqual(v.json.me.status, 'IN');
    assert.strictEqual(v.json.me.canManage, false);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(v.json.session.dayKey));
  });
  // nível pelo Glicko do esporte quando houver
  await prisma.glickoRating.create({ data: { sport: 'FUTSAL', format: 'SINGLES', subjectType: 'USER', subjectKey: U.racheiro.id, userId: U.racheiro.id, rating: 1900, matches: 5 } });
  let DRAW;
  const checkDrawBalanced = async () => {
    const levels = DRAW.teams.flatMap((t) => t.players.map((p) => p.level));
    const diff = Math.abs(DRAW.teams[0].levelSum - DRAW.teams[1].levelSum);
    assert.ok(Math.abs(diff - bruteMinDiff(levels)) < 1e-9, `diferença ${diff} ≠ mínima ${bruteMinDiff(levels)}`);
  };
  await ok('sorteio equilibrado: diferença mínima de soma de nível, semente registrada, Glicko usado quando há', async () => {
    const o = await call('POST', `/api/tournaments/${RT.id}/pickup/draw`, { token: tok(U.other), body: { teamCount: 2 } });
    assert.strictEqual(o.status, 403);
    const r = await call('POST', `/api/tournaments/${RT.id}/pickup/draw`, { token: tok(U.org), body: { teamCount: 2, seed: 'quinta-' + RUN } });
    assert.strictEqual(r.status, 200, r.text);
    DRAW = r.json;
    assert.strictEqual(DRAW.teams.length, 2);
    assert.strictEqual(DRAW.teams[0].players.length + DRAW.teams[1].players.length, 9);
    await checkDrawBalanced();
    const gl = DRAW.teams.flatMap((t) => t.players).find((p) => p.playerId && p.levelSource === 'glicko');
    assert.ok(gl && gl.level === 5, 'Glicko 1900 = nível 5,0');
    const s = await prisma.pickupSession.findUnique({ where: { id: DRAW.sessionId } });
    assert.strictEqual(s.seed, 'quinta-' + RUN);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: RT.id, action: 'pickup.draw' } }));
  });
  await ok('mesma semente + mesma lista = mesmos times (determinístico)', async () => {
    const r = await call('POST', `/api/tournaments/${RT.id}/pickup/draw`, { token: tok(U.org), body: { teamCount: 2, seed: 'quinta-' + RUN } });
    assert.strictEqual(r.status, 200, r.text);
    const ids = (d) => d.teams.map((t) => t.players.map((p) => p.playerId).sort().join(','));
    assert.deepStrictEqual(ids(r.json), ids(DRAW));
    DRAW = r.json;
    const ents = await prisma.tournamentEntry.count({ where: { tournamentId: RT.id } });
    assert.strictEqual(ents, 2, 'refazer o sorteio não acumula times');
  });
  let GAME;
  await ok('placar rápido: +1 com e sem autor, −1 desfaz; qualquer um não marca', async () => {
    // o autor dos gols é o jogador com conta (racheiro) — o time dele joga em casa
    const hi = DRAW.teams.findIndex((t) => t.players.some((p) => p.levelSource === 'glicko'));
    const g = await call('POST', `/api/tournaments/${RT.id}/pickup/games`, { token: tok(U.org), body: { home: hi, away: 1 - hi } });
    assert.strictEqual(g.status, 201, g.text);
    GAME = g.json.game;
    const scorer = DRAW.teams[hi].players.find((p) => p.levelSource === 'glicko');
    const sc = (body, who = U.org) => call('POST', `/api/tournaments/pickup/games/${GAME.id}/score`, { token: tok(who), body });
    assert.strictEqual((await sc({ side: 'home', delta: 1 }, U.other)).status, 403);
    await sc({ side: 'home', delta: 1, playerId: scorer.rosterPlayerId });
    await sc({ side: 'home', delta: 1, playerId: scorer.rosterPlayerId });
    await sc({ side: 'home', delta: 1 });
    await sc({ side: 'away', delta: 1 });
    const last = await sc({ side: 'away', delta: -1 });
    assert.deepStrictEqual([last.json.homeScore, last.json.awayScore], [3, 0]);
    const wrong = await sc({ side: 'away', delta: 1, playerId: scorer.rosterPlayerId });
    assert.strictEqual(wrong.status, 400, 'autor de outro time');
    const f = await call('POST', `/api/tournaments/pickup/games/${GAME.id}/finish`, { token: tok(U.org) });
    assert.strictEqual(f.status, 200, f.text);
    assert.deepStrictEqual([f.json.homeScore, f.json.awayScore], [3, 0]);
    assert.strictEqual((await sc({ side: 'home', delta: 1 })).status, 409, 'jogo encerrado');
    const redraw = await call('POST', `/api/tournaments/${RT.id}/pickup/draw`, { token: tok(U.org), body: { seed: 'outra' } });
    assert.strictEqual(redraw.status, 409, 'sorteio refeito com jogo jogado');
    GAME.scorer = scorer;
  });
  await ok('artilharia acumulada da temporada (ano em Fortaleza) + histórico do atleta + fora do rating', async () => {
    const r = await call('GET', `/api/tournaments/${RT.id}/pickup/scorers`);
    assert.strictEqual(r.status, 200);
    const yearNow = require('../src/services/athleteHistory').seasonOf(new Date());
    assert.strictEqual(r.json.season, yearNow);
    const top = r.json.scorers[0];
    assert.ok(top && top.goals === 2 && top.playerId === GAME.scorer.playerId, JSON.stringify(r.json.scorers));
    assert.strictEqual(top.games, 1);
    const old = await call('GET', `/api/tournaments/${RT.id}/pickup/scorers?season=${yearNow - 1}`);
    assert.strictEqual(old.json.scorers.length, 0);
    const hist = await require('../src/services/athleteHistory').history(U.racheiro.id, { viewer: { userId: U.racheiro.id } });
    assert.ok(hist.totals.goals >= 2 && hist.totals.games >= 1, 'gol do racha no histórico: ' + JSON.stringify(hist.totals));
    const evs = await require('../src/services/clubRating').collectEvents({ sport: 'FUTSAL' });
    assert.ok(!evs.some((e) => e.stage === 'PICKUP'), 'jogo de racha entrou no rating');
  });
  await ok('/t/:slug do racha vira /racha/:slug na página; GET /pickup de torneio que não é racha = 400', async () => {
    const r = await call('GET', `/api/tournaments/${Q.tournament.id}/pickup`);
    assert.strictEqual(r.status, 400);
  });

  // ================================================================ d. link do time
  console.log('  — d. link do time');
  const qEntries = await prisma.tournamentEntry.findMany({ where: { tournamentId: Q.tournament.id }, orderBy: { seed: 'asc' } });
  const E = qEntries[0];
  await prisma.tournamentRole.create({ data: { tournamentId: Q.tournament.id, userId: U.teamAdmin.id, role: 'TEAM_ADMIN', entryId: E.id } });
  await prisma.tournamentRole.create({ data: { tournamentId: Q.tournament.id, userId: U.coord.id, role: 'COORDINATOR' } });
  let L1; let L2;
  const checkInvitePerm = async () => {
    const r = await call('POST', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.other), body: {} });
    assert.strictEqual(r.status, 403, 'qualquer um gerou link do time: ' + r.status);
    const other = await call('POST', `/api/tournaments/entries/${qEntries[1].id}/team-invite`, { token: tok(U.teamAdmin), body: {} });
    assert.strictEqual(other.status, 403, 'admin de um time gerou link de outro');
  };
  await ok('permissão: qualquer um / admin de outro time = 403; admin do time e coordenação geram', async () => {
    await checkInvitePerm();
    const a = await call('POST', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.teamAdmin), body: { days: 3 } });
    assert.strictEqual(a.status, 201, a.text);
    L1 = a.json;
    assert.ok(L1.url.includes('/convite-time/') && L1.whatsappUrl.startsWith('https://wa.me/?text='));
    const c = await call('POST', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.coord), body: {} });
    assert.strictEqual(c.status, 201);
    L2 = c.json;
    const inv = await prisma.teamInvite.findMany({ where: { entryId: E.id } });
    assert.ok(inv.every((i) => i.tokenHash !== L2.token), 'token em texto no banco');
  });
  await ok('link novo revoga o anterior (410 revoked); válido mostra o time', async () => {
    const i1 = await call('GET', `/api/tournaments/team-invites/${L1.token}`);
    assert.strictEqual(i1.json.status, 'revoked');
    const j = await call('POST', `/api/tournaments/team-invites/${L1.token}/join`, { token: tok(U.p1) });
    assert.strictEqual(j.status, 410);
    const i2 = await call('GET', `/api/tournaments/team-invites/${L2.token}`);
    assert.strictEqual(i2.json.status, 'valid');
    assert.strictEqual(i2.json.team.name, E.name);
    assert.strictEqual((await call('GET', '/api/tournaments/team-invites/' + 'x'.repeat(43))).status, 404);
  });
  await ok('entrar pelo link: vira RosterPlayer com userId e PLAYER (+ vínculo ativo); 2ª vez = 409; sem login = 401', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, {})).status, 401);
    const j = await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, { token: tok(U.p1) });
    assert.strictEqual(j.status, 201, j.text);
    const rp1 = await prisma.rosterPlayer.findUnique({ where: { id: j.json.playerId } });
    assert.strictEqual(rp1.userId, U.p1.id);
    assert.strictEqual(rp1.role, 'PLAYER');
    assert.strictEqual(rp1.entryId, E.id);
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: Q.tournament.id, userId: U.p1.id, role: 'PLAYER', entryId: E.id } }));
    assert.ok(await prisma.teamMembership.findFirst({ where: { tournamentId: Q.tournament.id, userId: U.p1.id, status: 'ACTIVE' } }));
    const again = await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, { token: tok(U.p1) });
    assert.strictEqual(again.status, 409);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: Q.tournament.id, action: 'roster.join' } }));
  });
  const checkRosterLimit = async () => {
    const before = await prisma.rosterPlayer.count({ where: { entryId: E.id, role: 'PLAYER' } });
    const r = await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, { token: tok(U.p3) });
    assert.strictEqual(r.status, 409, 'passou do limite do elenco: ' + r.status);
    assert.strictEqual(await prisma.rosterPlayer.count({ where: { entryId: E.id, role: 'PLAYER' } }), before);
  };
  await ok('limite do elenco da categoria: cheio = 409 (status full)', async () => {
    const n = await prisma.rosterPlayer.count({ where: { entryId: E.id, role: 'PLAYER' } });
    const p = await call('PATCH', `/api/tournaments/${Q.tournament.id}/categories/${qcat.id}`, { token: tok(U.org), body: { gameRules: { maxRoster: n + 1 } } });
    assert.strictEqual(p.status, 200, p.text);
    const j2 = await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, { token: tok(U.p2) });
    assert.strictEqual(j2.status, 201, j2.text);
    await checkRosterLimit();
    const info = await call('GET', `/api/tournaments/team-invites/${L2.token}`);
    assert.strictEqual(info.json.status, 'full');
  });
  await ok('link vencido = 410 expired; revogado pelo DELETE = 410 revoked', async () => {
    await prisma.teamInvite.updateMany({ where: { entryId: E.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.strictEqual((await call('GET', `/api/tournaments/team-invites/${L2.token}`)).json.status, 'expired');
    const j = await call('POST', `/api/tournaments/team-invites/${L2.token}/join`, { token: tok(U.p3) });
    assert.strictEqual(j.status, 410);
    assert.strictEqual(j.json.status, 'expired');
    await prisma.tournamentCategory.update({ where: { id: qcat.id }, data: { gameRules: { ...(await prisma.tournamentCategory.findUnique({ where: { id: qcat.id } })).gameRules, maxRoster: null } } });
    const n = await call('POST', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.org), body: {} });
    const del = await call('DELETE', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.other) });
    assert.strictEqual(del.status, 403);
    const del2 = await call('DELETE', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.teamAdmin) });
    assert.strictEqual(del2.status, 200);
    const j3 = await call('POST', `/api/tournaments/team-invites/${n.json.token}/join`, { token: tok(U.p3) });
    assert.strictEqual(j3.status, 410);
    assert.strictEqual(j3.json.status, 'revoked');
  });

  // ================================================================ e. duplicar
  console.log('  — e. duplicar para a próxima temporada');
  // resultado num jogo da origem (não pode ir para a cópia)
  const fin = await call('POST', `/api/tournaments/matches/${qm.id}/finalize`, { token: tok(U.org), body: {} });
  assert.strictEqual(fin.status, 200, fin.text);
  const srcSnap = async () => JSON.stringify({ t: await prisma.tournament.findUnique({ where: { id: Q.tournament.id } }), m: await prisma.tournamentMatch.count({ where: { tournamentId: Q.tournament.id } }), e: await prisma.tournamentEntry.count({ where: { tournamentId: Q.tournament.id } }) });
  const srcBefore = await srcSnap();
  let DUP;
  await ok('permissão: anônimo 401, qualquer um 403', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/${Q.tournament.id}/duplicate`, {})).status, 401);
    assert.strictEqual((await call('POST', `/api/tournaments/${Q.tournament.id}/duplicate`, { token: tok(U.other) })).status, 403);
  });
  await ok('duplica: mesmas categorias/regras, mesmos clubes, elencos com conta, sem jogos, rascunho, edição +1', async () => {
    const r = await call('POST', `/api/tournaments/${Q.tournament.id}/duplicate`, { token: tok(U.coord) });
    assert.strictEqual(r.status, 201, r.text);
    DUP = r.json;
    const t = await prisma.tournament.findUnique({ where: { id: DUP.tournament.id } });
    assert.strictEqual(t.status, 'DRAFT');
    assert.strictEqual(t.ownerId, U.org.id, 'dono continua o fundador');
    assert.strictEqual(t.edition, '2027', 'ano do nome sobe 1 (nome sugerido termina em /2026)');
    assert.ok(/2027$/.test(t.name), t.name);
    assert.ok(t.seriesSlug, 'série ligada');
    assert.strictEqual(t.cashEnabled, false);
    assert.strictEqual(await prisma.tournamentMatch.count({ where: { tournamentId: t.id } }), 0);
    assert.strictEqual(await prisma.tournamentStanding.count({ where: { tournamentId: t.id } }), 0);
    const [c0, c1] = [await prisma.tournamentCategory.findMany({ where: { tournamentId: Q.tournament.id }, orderBy: { id: 'asc' } }), await prisma.tournamentCategory.findMany({ where: { tournamentId: t.id }, orderBy: { id: 'asc' } })];
    assert.strictEqual(c1.length, c0.length);
    assert.deepStrictEqual(c1.map((c) => [c.name, c.pointsWin, JSON.stringify(c.tiebreakers), JSON.stringify(c.gameRules)]), c0.map((c) => [c.name, c.pointsWin, JSON.stringify(c.tiebreakers), JSON.stringify(c.gameRules)]));
    const e0 = await prisma.tournamentEntry.findMany({ where: { tournamentId: Q.tournament.id } });
    const e1 = await prisma.tournamentEntry.findMany({ where: { tournamentId: t.id } });
    assert.deepStrictEqual(e1.map((e) => e.clubId).sort(), e0.map((e) => e.clubId).sort(), 'mesmos clubes');
    const r1 = await prisma.rosterPlayer.findMany({ where: { entryId: { in: e1.map((e) => e.id) } } });
    assert.ok(r1.some((x) => x.userId === U.p1.id) && r1.some((x) => x.userId === U.p2.id), 'elenco com conta copiado');
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: t.id, userId: U.coord.id, role: 'COORDINATOR' } }));
    const newE = e1.find((e) => e.name === E.name);
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: t.id, userId: U.teamAdmin.id, role: 'TEAM_ADMIN', entryId: newE.id } }), 'admin do time vai junto');
    assert.strictEqual(await srcSnap(), srcBefore, 'origem mudou');
  });
  await ok('duplicar racha copia os jogadores (sem os times do dia)', async () => {
    const r = await call('POST', `/api/tournaments/${RT.id}/duplicate`, { token: tok(U.org) });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(await prisma.pickupPlayer.count({ where: { tournamentId: r.json.tournament.id } }), await prisma.pickupPlayer.count({ where: { tournamentId: RT.id, active: true } }));
    assert.strictEqual(await prisma.tournamentEntry.count({ where: { tournamentId: r.json.tournament.id } }), 0);
  });
  await ok('torneio privado: quem não é membro recebe 404 (não 403) ao duplicar', async () => {
    const priv = await prisma.tournament.create({ data: { slug: 'f3-priv-' + RUN, name: 'Privado', sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, visibility: 'private' } });
    const r = await call('POST', `/api/tournaments/${priv.id}/duplicate`, { token: tok(U.other) });
    assert.strictEqual(r.status, 404);
  });

  // ================================================================ f. achados da auditoria (regra 29)
  console.log('  — f. travas pedidas pela auditoria');
  await ok('GET do racha não grava nada (nem sessão de outro dia) e dia inválido = 400', async () => {
    const before = await prisma.pickupSession.count();
    const fut = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
    const r = await call('GET', `/api/tournaments/${RT.slug}/pickup?day=${fut}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.session.id, null);
    assert.strictEqual(await prisma.pickupSession.count(), before, 'leitura criou sessão');
    for (const d of ['9999-99-99', '2026-02-30', '1990-01-01']) {
      const x = await call('GET', `/api/tournaments/${RT.slug}/pickup?day=${d}`);
      assert.strictEqual(x.status, 400, d + ' → ' + x.status);
    }
  });
  await ok('racha PRIVADO: anônimo e não membro = 404 (pickup e artilharia); jogador do racha com conta vê', async () => {
    const pr = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', preset: 'racha-semanal', visibility: 'private', teams: ['Zé ' + RUN] } });
    assert.strictEqual(pr.status, 201, pr.text);
    const slug = pr.json.tournament.slug; const pid = pr.json.tournament.id;
    for (const u of ['/pickup', '/pickup/scorers']) {
      assert.strictEqual((await call('GET', `/api/tournaments/${slug}${u}`)).status, 404, 'anônimo ' + u);
      assert.strictEqual((await call('GET', `/api/tournaments/${slug}${u}`, { token: tok(U.other) })).status, 404, 'não membro ' + u);
    }
    const zp = await prisma.pickupPlayer.findFirst({ where: { tournamentId: pid } });
    assert.strictEqual((await call('PATCH', `/api/tournaments/pickup/players/${zp.id}`, { token: tok(U.other), body: { level: 5 } })).status, 404, 'PATCH de jogador de racha privado por estranho');
    assert.strictEqual((await call('POST', `/api/tournaments/${pid}/pickup/attendance`, { token: tok(U.other), body: { confirm: true } })).status, 404);
    await prisma.pickupPlayer.update({ where: { id: zp.id }, data: { userId: U.p3.id } });
    const m = await call('GET', `/api/tournaments/${slug}/pickup`, { token: tok(U.p3) });
    assert.strictEqual(m.status, 200, 'membro do racha não vê');
    // racha público: organizador de OUTRO torneio não mexe no jogador (403)
    const o = await call('PATCH', `/api/tournaments/pickup/players/${rachaPlayers[0].id}`, { token: tok(U.org2), body: { level: 1 } });
    assert.strictEqual(o.status, 403);
  });
  await ok('link do time de torneio ARQUIVADO = 404 (ver e entrar)', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', format: 'ROUND_ROBIN', teams: ['Arq1 ' + RUN, 'Arq2 ' + RUN] } });
    const e1 = await prisma.tournamentEntry.findFirst({ where: { tournamentId: r.json.tournament.id } });
    const inv = await call('POST', `/api/tournaments/entries/${e1.id}/team-invite`, { token: tok(U.org), body: {} });
    assert.strictEqual(inv.status, 201);
    await prisma.tournament.update({ where: { id: r.json.tournament.id }, data: { archivedAt: new Date() } });
    assert.strictEqual((await call('GET', `/api/tournaments/team-invites/${inv.json.token}`)).status, 404);
    assert.strictEqual((await call('POST', `/api/tournaments/team-invites/${inv.json.token}/join`, { token: tok(U.p3) })).status, 404);
  });
  await ok('limite do elenco sob CONCORRÊNCIA: 3 entradas ao mesmo tempo com 1 vaga = só 1 entra', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', preset: 'liga-pontos-corridos', teams: ['Conc1 ' + RUN, 'Conc2 ' + RUN] } });
    const e1 = await prisma.tournamentEntry.findFirst({ where: { tournamentId: r.json.tournament.id } });
    await call('PATCH', `/api/tournaments/${r.json.tournament.id}/categories/${r.json.categoryId}`, { token: tok(U.org), body: { gameRules: { maxRoster: 1 } } });
    const inv = await call('POST', `/api/tournaments/entries/${e1.id}/team-invite`, { token: tok(U.org), body: {} });
    const rs = await Promise.all([U.p1, U.p2, U.p3].map((u) => call('POST', `/api/tournaments/team-invites/${inv.json.token}/join`, { token: tok(u) })));
    assert.deepStrictEqual(rs.map((x) => x.status).sort(), [201, 409, 409], rs.map((x) => x.status).join(','));
    assert.strictEqual(await prisma.rosterPlayer.count({ where: { entryId: e1.id, role: 'PLAYER' } }), 1);
    // a inclusão manual respeita o mesmo limite (comissão técnica não conta)
    const man = await call('POST', `/api/tournaments/entries/${e1.id}/players`, { token: tok(U.org), body: { name: 'Extra' } });
    assert.strictEqual(man.status, 409, 'inclusão manual passou do limite');
    const coach = await call('POST', `/api/tournaments/entries/${e1.id}/players`, { token: tok(U.org), body: { name: 'Técnico', role: 'COACH' } });
    assert.strictEqual(coach.status, 201);
  });
  await ok('dois sorteios AO MESMO TEMPO: um conjunto de times só, nenhuma inscrição órfã', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'FUTSAL', preset: 'racha-semanal', teams: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'].map((x) => x + ' ' + RUN) } });
    const tid = r.json.tournament.id;
    for (const p of await prisma.pickupPlayer.findMany({ where: { tournamentId: tid } })) {
      await call('POST', `/api/tournaments/${tid}/pickup/attendance`, { token: tok(U.org), body: { playerId: p.id, confirm: true } });
    }
    const rs = await Promise.all([1, 2, 3].map((i) => call('POST', `/api/tournaments/${tid}/pickup/draw`, { token: tok(U.org), body: { seed: 'corrida-' + i } })));
    assert.ok(rs.every((x) => x.status === 200), rs.map((x) => x.status).join(','));
    const ents = await prisma.tournamentEntry.findMany({ where: { tournamentId: tid } });
    const sess = await prisma.pickupSession.findFirst({ where: { tournamentId: tid } });
    assert.strictEqual(ents.length, 2, 'inscrições órfãs: ' + ents.length);
    assert.deepStrictEqual(ents.map((e) => e.id).sort(), sess.teams.map((x) => x.entryId).sort());
    assert.strictEqual(await prisma.rosterPlayer.count({ where: { entryId: { in: ents.map((e) => e.id) } } }), 6);
  });
  await ok('basquete: pontos das cestas entram no histórico do atleta (gols = pontos)', async () => {
    const r = await call('POST', '/api/tournaments/quick', { token: tok(U.org), body: { sport: 'BASKETBALL', format: 'ROUND_ROBIN', teams: ['Hist1 ' + RUN, 'Hist2 ' + RUN] } });
    const m = await prisma.tournamentMatch.findFirst({ where: { tournamentId: r.json.tournament.id } });
    const rp = await prisma.rosterPlayer.create({ data: { entryId: m.homeEntryId, name: 'Cestinha', userId: U.p2.id } });
    const before = (await require('../src/services/athleteHistory').history(U.p2.id, { viewer: { userId: U.p2.id } })).totals.goals || 0;
    for (const t of ['PT3', 'PT2']) await call('POST', `/api/tournaments/matches/${m.id}/events`, { token: tok(U.org), body: { entryId: m.homeEntryId, type: t, playerId: rp.id } });
    await call('POST', `/api/tournaments/matches/${m.id}/finalize`, { token: tok(U.org), body: {} });
    const after = (await require('../src/services/athleteHistory').history(U.p2.id, { viewer: { userId: U.p2.id } })).totals.goals;
    assert.strictEqual(after - before, 5);
  });

  // ================================================================ Master Cup intacto
  await ok('Master Cup intacto byte a byte depois de tudo (nenhuma regra nova mexeu nele)', async () => {
    assert.strictEqual(await snapMC(), mcBefore);
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
      await check(); // restaurado, volta a passar
    });
  }
  const origRules = gr.rulesForMatch;
  await sabotage('categoria sem regra passando a usar o padrão de outro esporte (mudaria o Master Cup)',
    () => { gr.rulesForMatch = async () => gr.resolveRules({ gameRules: gr.defaultsFor('BASKETBALL') }, 'BASKETBALL'); },
    checkLegacy,
    () => { gr.rulesForMatch = origRules; });
  const origBal = pickup.balancedTeams;
  const sabDrawCheck = async () => {
    const lv = [7, 6.5, 6, 1, 1.5, 2, 4, 3];
    const t = pickup.balancedTeams(lv.map((l, i) => ({ id: 's' + i, level: l })), 2, 'fixa');
    const diff = Math.abs(t[0].levelSum - t[1].levelSum);
    assert.ok(Math.abs(diff - bruteMinDiff(lv)) < 1e-9, 'sorteio desequilibrado');
  };
  await sabotage('sorteio sem equilíbrio (metade/metade na ordem)',
    () => { pickup.balancedTeams = (ps) => [{ index: 0, ids: ps.slice(0, 4).map((p) => p.id), levelSum: ps.slice(0, 4).reduce((s, p) => s + p.level, 0) }, { index: 1, ids: ps.slice(4).map((p) => p.id), levelSum: ps.slice(4).reduce((s, p) => s + p.level, 0) }]; },
    sabDrawCheck,
    () => { pickup.balancedTeams = origBal; });
  const origCan = roles.can;
  await sabotage('link do time sem checar permissão',
    () => { roles.can = async () => true; },
    checkInvitePerm,
    () => { roles.can = origCan; });
  // limite do elenco: sabotagem no serviço (ignora maxRoster)
  const L3 = await call('POST', `/api/tournaments/entries/${E.id}/team-invite`, { token: tok(U.org), body: {} });
  L2.token = L3.json.token;
  const nNow = await prisma.rosterPlayer.count({ where: { entryId: E.id, role: 'PLAYER' } });
  await prisma.tournamentCategory.update({ where: { id: qcat.id }, data: { gameRules: { ...(await prisma.tournamentCategory.findUnique({ where: { id: qcat.id } })).gameRules, maxRoster: nNow } } });
  const origResolve = gr.resolveRules;
  await sabotage('link do time ignorando o limite do elenco',
    () => { gr.resolveRules = (c, s) => ({ ...origResolve(c, s), maxRoster: null }); },
    checkRosterLimit,
    async () => {
      gr.resolveRules = origResolve;
      await prisma.rosterPlayer.deleteMany({ where: { entryId: E.id, userId: U.p3.id } });
    });
  await sabotage('criação rápida fora de transação (falha no meio deixaria lixo)',
    () => {
      engine.generateFixtures = async () => { throw new Error('falha simulada'); };
      prisma.__origTx = prisma.$transaction;
      prisma.$transaction = (fn) => fn(prisma); // "transação" que não desfaz nada
    },
    checkNoGarbage,
    async () => {
      engine.generateFixtures = origGen;
      prisma.$transaction = prisma.__origTx;
      // remove o lixo que a sabotagem deixou
      const junk = await prisma.tournament.findMany({ where: { ownerId: U.org.id, matches: { none: {} }, format: 'ROUND_ROBIN', name: { startsWith: 'Liga de Futsal' } }, select: { id: true } });
      for (const j of junk) {
        const es = await prisma.tournamentEntry.findMany({ where: { tournamentId: j.id }, select: { clubId: true } });
        await prisma.tournament.delete({ where: { id: j.id } });
        const ids = es.map((e) => e.clubId).filter(Boolean);
        if (ids.length) await prisma.club.deleteMany({ where: { id: { in: ids } } });
      }
      engine.generateFixtures = async () => { throw new Error('falha simulada no meio'); };
    });
  engine.generateFixtures = origGen;
  assert.ok(teamInvite.join);

  // ================================================================ app real
  console.log('  — páginas no app real (src/index.js)');
  const PORT = 4400 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', TREG_SWEEPER: 'off', RNA_ATIVA: '0', RNA_RELOGIO: '0' },
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
    const mobile = (t) => /max-width:480px/.test(t) && /min-height:4[48]px/.test(t) && /safe-area-inset-bottom/.test(t) && /viewport-fit=cover/.test(t);
    await ok('/criar-liga, /racha/:slug e /convite-time/:token abrem mobile-first (480px, 44px, safe-area)', async () => {
      for (const p of ['/criar-liga', '/racha/' + RT.slug, '/convite-time/' + 'a'.repeat(43)]) {
        const r = await page(p);
        assert.strictEqual(r.status, 200, p + ' ' + r.status);
        assert.ok(mobile(r.text), p + ' não é mobile-first');
      }
    });
    await ok('/t/:slug de racha redireciona para /racha/:slug; torneio normal segue na página do torneio', async () => {
      const r = await page('/t/' + RT.slug);
      assert.strictEqual(r.status, 302);
      assert.ok(String(r.headers.location).endsWith('/racha/' + RT.slug));
      const n = await page('/t/' + Q.tournament.slug);
      assert.strictEqual(n.status, 200);
    });
    await ok('/api/tournaments/presets no app real devolve JSON', async () => {
      const r = await page('/api/tournaments/presets');
      assert.strictEqual(r.status, 200);
      assert.ok(r.json && r.json.presets.length === 5);
    });
  }
  child.kill();
  server.close();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F3 — criação: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exit(failed ? 1 : 0);
  });
