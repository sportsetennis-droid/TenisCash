'use strict';
// =====================================================================
// Liga Aberta — FASE 6 (moderação e menores). npm run test:liga-f6
//
// Parte 1 (sem banco): filtro de texto ofensivo (casos positivos, leetspeak, letra
//   repetida, letras soltas) e FALSO-POSITIVO com todos os times do Master Cup (lidos
//   da tabela oficial) + bairros/cidades da PB + nomes comuns; idade de menor em
//   Fortaleza; schema F6 no INÍCIO do ensureApexSchema.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. permissão de cada papel × ação nova (anônimo, usuário, dono, coordenador,
//      admin, organizador suspenso) — can() e HTTP
//   b. denúncia: 4 alvos, motivo, texto limitado, dedup em aberto, privado = 404,
//      limitador 429
//   c. fila: descartar, ocultar aviso (+ voltar), ocultar imagem (campo nulo + /media
//      404 + reenvio recusado), auditoria + registro global
//   d. torneio suspenso: invisível em TODAS as rotas públicas (lista abaixo) com o
//      MESMO 404 de "não existe"; dono/admin veem; ninguém escreve (só admin)
//   e. organizador suspenso: não cria, can() nega gestão, torneios dele seguem visíveis
//   f. filtro nas rotas (torneio, categoria, time, clube, jogador, aviso, racha,
//      cadastro de atleta, inscrição pública, /quick) — 400 em PT sem repetir a palavra
//   g. menores: flag off = rotas fechadas e nada coletado; flag on = fluxo funciona
//   h. privacidade: export sem CPF em claro; apagar anonimiza o esportivo, mantém o
//      fiscal e o saldo, cria pedido quando há saldo
//   i. Master Cup: denúncia funciona, nada da F6 altera os dados dele
//   j. app real (src/index.js): /t/:slug (botão, aviso oculto, suspenso 404), /atleta
//      de quem apagou = 404, /moderacao e /privacidade-club
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });

let passed = 0;
let failed = 0;
let skipped = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log('  ✅ ' + name); } catch (e) { failed++; console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e)); }
}
function skip(name, why) { skipped++; console.log('  ⏭️  ' + name + ' — PULADO: ' + why); }
async function sabotage(name, breakIt, check, restore) {
  let caught = false;
  try { await breakIt(); try { await check(); } catch (_) { caught = true; } } finally { await restore(); }
  if (caught) { passed++; console.log('  ✅ sabotagem pega: ' + name); } else { failed++; console.error('  ❌ sabotagem NÃO pega: ' + name); }
}
function httpCall(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers, Connection: 'close' };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request(url, { method, headers: h, agent: false }, (res) => {
      // SSE: não espera o fim (lê o cabeçalho e fecha)
      if (/text\/event-stream/.test(res.headers['content-type'] || '')) { res.destroy(); return resolve({ status: res.statusCode, headers: res.headers, text: '', json: null }); }
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

// Nomes REAIS que não podem ser barrados (falso-positivo)
function masterCupNames() {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/futsalMasterCupSeed.js'), 'utf8');
  const block = src.slice(src.indexOf('const TEAMS'), src.indexOf('const CAT_FORMAT'));
  const names = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((n) => !/^[A-Z]$|^\d|^U$|^AxB$/.test(n));
  return [...new Set(names)].concat(['II Futsal Master Cup 2026', 'Ginásio Ronaldão', 'Ginásio Marista', '40+', '45+', '50+', '55+', '60+', 'Perdedor do Jogo 01', 'Vencedor do Jogo 01']);
}
const PB_NAMES = [
  'João Pessoa', 'Campina Grande', 'Cuité', 'Bayeux', 'Santa Rita', 'Cabedelo', 'Patos', 'Sousa', 'Cajazeiras', 'Guarabira', 'Pombal', 'Mamanguape',
  'Esperança', 'Pocinhos', 'Picuí', 'Queimadas', 'Sapé', 'Bananeiras', 'Areia', 'Conde', 'Pitimbu', 'Lucena', 'Alhandra', 'Itabaiana', 'Monteiro',
  'Princesa Isabel', 'Catolé do Rocha', 'Itaporanga', 'Boqueirão', 'Soledade', 'Sumé', 'Cuitegi', 'Cacimba de Dentro', 'Caiçara', 'Coremas', 'Piancó',
  'São Bento', 'Pedras de Fogo', 'Bessa', 'Tambaú', 'Manaíra', 'Cabo Branco', 'Tambiá', 'Pirâmide', 'Mangabeira', 'Valentina', 'Bancários',
  'Cristo Redentor', 'Torre', 'Jaguaribe', 'Cruz das Armas', 'Oitizeiro', 'Altiplano', 'Castelo Branco', 'Bairro dos Estados', 'Miramar',
  'Expedicionários', 'Geisel', 'Muçumagro', 'Gramame', 'Mandacaru', 'Róger', 'Treze de Maio', 'Varadouro', 'Ilha do Bispo', 'Padre Zé',
  'Alto do Mateus', 'Funcionários', 'Costa e Silva', 'Água Fria', 'José Américo', 'Penha', 'Seixas', 'Portal do Sol', 'Ponta do Seixas',
  'Catolé', 'Bodocongó', 'Liberdade', 'Prata', 'Palmeira', 'Alto Branco', 'José Pinheiro', 'Malvinas', 'Rainha da Borborema', 'Sertão',
  'Treze FC', 'Campinense', 'Botafogo-PB', 'Auto Esporte', 'Sousa EC', 'Nacional de Patos', 'Sports & Tennis', 'Baratão dos Esportes',
  'Pinto', 'Rola', 'Cunha', 'Cuca', 'Pica-Pau', 'Piranhas', 'Rotariano', 'Macacos FC', 'Veado Futsal', 'Frango', 'Pau Brasil',
  'Cassino', 'Raposa', 'Gaviões', 'Peixe', 'Jacaré', 'Galo', 'Cabrito', 'Bode', 'Ana Cuíca', 'Maria da Penha',
  'Sexo masculino e feminino', 'Pagamento via dinheiro ou pix', 'Jogo às 19h no ginásio', 'Fanáticos', 'Raça Rubro-Negra',
];
const OFFENSIVE = ['Time do Caralho', 'P0RR4 FC', 'putaaaa', 'p u t a', 'P.U.T.A', 'Fdp Futsal', 'Viados FC', 'Nazistas da Bola', 'caralhinho fc',
  'Vai tomar no cu', 'merda total', 'B0$TA', 'Cuzão', 'Arrombados', 'filhodaputa', 'Bucetas', 'S4p4t40', 'traveco fc', 'Retardados', 'Hitler FC', 'Buceteiro', 'Bucetinha', 'Vamos, porra!'];

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f6-' + crypto.randomBytes(8).toString('hex');
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 're_test_dummy';
  delete process.env.LIGA_MINORS;
  const filter = require('../src/services/contentFilter');
  const minors = require('../src/services/ligaMinors');

  await ok('filtro pega palavrão/ofensa/discriminação com acento, caixa, leetspeak, letra repetida e letras soltas (' + OFFENSIVE.length + ' casos)', () => {
    const miss = OFFENSIVE.filter((t) => !filter.findOffense(t));
    assert.deepStrictEqual(miss, []);
  });
  await ok('FALSO-POSITIVO: todos os times/categorias do Master Cup (tabela oficial) passam', () => {
    const names = masterCupNames();
    assert.ok(names.length >= 20, 'nomes lidos: ' + names.length);
    const hit = names.filter((n) => filter.findOffense(n));
    assert.deepStrictEqual(hit, []);
  });
  await ok('FALSO-POSITIVO: ' + PB_NAMES.length + ' bairros/cidades da PB, times locais e nomes comuns (Pinto, Rola, Cunha, Cuité…) passam', () => {
    const hit = PB_NAMES.filter((n) => filter.findOffense(n, { kind: 'name' }) || filter.findOffense(n, { kind: 'text' }));
    assert.deepStrictEqual(hit, []);
  });
  await ok('mensagem de bloqueio é em português e NÃO repete a palavra', () => {
    let err = null;
    try { filter.assertClean([{ field: 'team', value: 'Time do Caralho' }]); } catch (e) { err = e; }
    assert.ok(err && err.status === 400 && err.code === 'CONTENT_BLOCKED');
    assert.ok(/ofensiva/.test(err.message) && !/caralho/i.test(err.message), err.message);
  });
  await ok('menor de 18: idade calculada em America/Fortaleza; data inválida não vale', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    assert.strictEqual(minors.declaresMinor('2010-01-01', now), true);
    assert.strictEqual(minors.declaresMinor('2008-11-19', now), false, 'faz 18 hoje');
    assert.strictEqual(minors.declaresMinor('2008-11-20', now), true, 'faz 18 amanhã');
    assert.strictEqual(minors.declaresMinor('20/05/2012', now), true);
    assert.strictEqual(minors.declaresMinor('1990-02-30', now), false);
    assert.strictEqual(minors.declaresMinor('', now), false);
    assert.strictEqual(minors.enabled(), false, 'LIGA_MINORS desligado por padrão');
  });
  await ok('schema F6 no INÍCIO do ensureApexSchema (logo depois de F4/F5, antes de F3/F1/F0 e do resto) e repetido no FIM', () => {
    const { STATEMENTS } = require('../src/services/ensureApexSchema');
    const idx = (rx) => STATEMENTS.findIndex((s) => rx.test(s));
    const f3 = idx(/"gameRules"/);
    const f5last = idx(/PickupAttendance_playerId_idx/);
    const items = [/"suspendedAt"/, /"hiddenAt"/, /"minorProfileId"/, /"blockedAt"/, ...['ContentReport', 'ModerationLog', 'OrganizerSuspension', 'PrivacyRequest', 'MinorProfile'].map((tb) => new RegExp('CREATE TABLE IF NOT EXISTS "' + tb + '"'))];
    for (const rx of items) { const i = idx(rx); assert.ok(i > f5last && i < f3 && i < 45, rx + ' em ' + i + ' (F5 até ' + f5last + ', F3 em ' + f3 + ')'); }
    assert.ok(idx(/"blockedAt"/) > idx(/CREATE TABLE IF NOT EXISTS "MediaObject"/), 'ALTER do MediaObject depois do CREATE');
    const tail = STATEMENTS.slice(-10).join('\n');
    assert.ok(/"blockedAt"/.test(tail) && /"hiddenAt"/.test(tail) && /"suspendedAt"/.test(tail), 'repetido no fim (banco novo)');
    assert.ok(!STATEMENTS.some((s) => /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/i.test(s)), 'nada destrutivo');
    const prismaSrc = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
    for (const m of ['ContentReport', 'ModerationLog', 'OrganizerSuspension', 'PrivacyRequest', 'MinorProfile']) assert.ok(new RegExp('model ' + m + ' \\{').test(prismaSrc), 'schema.prisma: ' + m);
    assert.ok(/suspendedAt\s+DateTime\?/.test(prismaSrc) && /hiddenAt\s+DateTime\?/.test(prismaSrc) && /blockedAt\s+DateTime\?/.test(prismaSrc) && /minorProfileId String\?/.test(prismaSrc));
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('moderação, menores, privacidade, páginas', 'DATABASE_URL local (localhost) não definido');
    if (process.env.CI) { failed++; console.error('  ❌ no CI a parte de banco não pode ser pulada'); }
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const sharp = require('sharp');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const mediaStore = require('../src/services/mediaStore');
  const roles = require('../src/services/tournamentRoles');
  const access = require('../src/services/tournamentAccess');
  const filter = require('../src/services/contentFilter');
  const minors = require('../src/services/ligaMinors');
  await ensureApexSchema(prisma);
  try { require('../src/services/clubs').setPrisma(prisma); } catch (_) {}
  try { require('../src/services/clubRankings').setPrisma(prisma); } catch (_) {}

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  app.use(['/api/tournaments', '/api/public', '/api/club-ranking', '/api/clubs'], mediaStore.jsonMiddleware);
  app.get('/media/:file', mediaStore.serveMedia);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/t', media.pageRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use(require('../src/routes/tournamentRegistration'));
  app.use('/api/clubs', require('../src/routes/clubs'));
  app.use('/api/club-ranking', require('../src/routes/clubRanking'));
  app.use('/api/liga', require('../src/routes/ligaSafety'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipSeq = 0;
  const call = (method, url, { token, body, headers } = {}) => {
    const h = { 'cf-connecting-ip': `203.0.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}`, ...(headers || {}) };
    if (token) h.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, h, body);
  };

  const RUN = Date.now().toString(36);
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  const mkUser = (label, extra = {}) => prisma.user.create({ data: { name: `F6 ${label} ${RUN}-${++seq}`, phone: '836' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const U = {
    user: await mkUser('usuario'), user2: await mkUser('usuario2'), owner: await mkUser('dono'), coord: await mkUser('coordenador'),
    admin: await mkUser('admin', { role: 'admin' }), org2: await mkUser('organizador2'), spammer: await mkUser('limitador'),
    ath: await mkUser('atleta', { username: 'f6ath' + RUN, cpf: '529982247' + String(seq).padStart(2, '0') }), rich: await mkUser('com saldo', { balance: 50, username: 'f6rich' + RUN }),
    guardian: await mkUser('responsavel'), mcOwner: await mkUser('dono master cup'), exporter: await mkUser('exportador'),
  };
  const ATH_CPF = (await prisma.user.findUnique({ where: { id: U.ath.id }, select: { cpf: true } })).cpf;

  // ---------------------------------------------------------------- dados
  const T = await prisma.tournament.create({ data: { slug: 'f6-copa-' + RUN, name: 'Copa F6 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.owner.id, status: 'ONGOING', visibility: 'public', seriesSlug: 'f6-serie-' + RUN, seriesName: 'Série F6' } });
  await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: U.coord.id, role: 'COORDINATOR' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre' } });
  const cat2 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Master' } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Leões ' + RUN, status: 'CONFIRMED' } });
  const eA2 = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat2.id, name: 'Leões ' + RUN, status: 'CONFIRMED' } });
  const eB = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat.id, name: 'Tubarões ' + RUN, status: 'CONFIRMED' } });
  await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: U.guardian.id, role: 'TEAM_ADMIN', entryId: eB.id } });
  const pAth = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Atleta Real F6', number: 9, userId: U.ath.id } });
  const pRich = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Rico F6', number: 10, userId: U.rich.id } });
  const pMinor = await prisma.rosterPlayer.create({ data: { entryId: eB.id, name: 'Vaga Menor', number: 7 } });
  const m1 = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat.id, stage: 'LEAGUE', round: 1, homeEntryId: eA.id, awayEntryId: eB.id, status: 'FINISHED', homeScore: 2, awayScore: 1, winnerEntryId: eA.id, scheduledAt: new Date() } });
  await prisma.matchEvent.createMany({ data: [{ matchId: m1.id, entryId: eA.id, playerId: pAth.id, type: 'GOAL' }, { matchId: m1.id, entryId: eA.id, playerId: pAth.id, type: 'GOAL' }, { matchId: m1.id, entryId: eB.id, playerId: pMinor.id, type: 'GOAL' }] });
  await prisma.teamMembership.create({ data: { tournamentId: T.id, clubName: eA.name, userId: U.ath.id, status: 'ACTIVE' } });
  const post1 = await prisma.tournamentPost.create({ data: { tournamentId: T.id, authorId: U.owner.id, body: 'Aviso suspeito F6 ' + RUN } });
  const imgBuf = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: crypto.randomInt(256), g: crypto.randomInt(256), b: 99 } } }).png().toBuffer();
  const IMG_DATA_URI = 'data:image/png;base64,' + imgBuf.toString('base64');
  // escudo pelo MESMO caminho do app (imageGuard reencoda → o reenvio dá o mesmo sha)
  const upLogo = await call('POST', `/api/tournaments/entries/${eA.id}/logo`, { token: tok(U.owner), body: { logo: IMG_DATA_URI } });
  if (upLogo.status !== 200) throw new Error('upload do escudo: ' + upLogo.text);
  const logo = { url: upLogo.json.logoUrl };
  // privado (membro: owner) e um torneio do org2
  const P = await prisma.tournament.create({ data: { slug: 'f6-priv-' + RUN, name: 'Privado F6', sport: 'FUTSAL', ownerId: U.owner.id, status: 'ONGOING', visibility: 'private' } });
  const T2 = await prisma.tournament.create({ data: { slug: 'f6-org2-' + RUN, name: 'Liga do Org2 ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org2.id, status: 'ONGOING', visibility: 'public' } });
  // Master Cup (lista de exclusão)
  const mcFound = await prisma.tournament.findUnique({ where: { slug: 'futsal-master-cup-2026' } });
  const MC = mcFound || await prisma.tournament.create({ data: { slug: 'futsal-master-cup-2026', name: 'II Futsal Master Cup 2026', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', ownerId: U.mcOwner.id, status: 'ONGOING', visibility: 'public' } });
  if (!mcFound) {
    const mcc = await prisma.tournamentCategory.create({ data: { tournamentId: MC.id, name: '40+' } });
    await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcc.id, name: 'Cabo Branco - PB', status: 'CONFIRMED' } });
    await prisma.tournamentPost.create({ data: { tournamentId: MC.id, body: 'Tabela oficial publicada' } });
  }
  // atleta (com saldo) que TAMBÉM joga no Master Cup — apagar os dados não pode mexer lá
  const mcEntry = await prisma.tournamentEntry.findFirst({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } });
  const mcPlayer = await prisma.rosterPlayer.create({ data: { entryId: mcEntry.id, name: 'Rico no Master Cup', number: 4, userId: U.rich.id } });
  const mcPost = await prisma.tournamentPost.findFirst({ where: { tournamentId: MC.id } });
  const mcSnap = async () => JSON.stringify([await prisma.tournament.findUnique({ where: { id: MC.id }, include: { categories: true, entries: { orderBy: { id: 'asc' } }, posts: { orderBy: { id: 'asc' } } } }), await prisma.rosterPlayer.findMany({ where: { entryId: mcEntry.id }, orderBy: { id: 'asc' } })]);
  const MC_BEFORE = await mcSnap();
  const MC_T0 = JSON.parse(MC_BEFORE)[0];

  // ================================================================ a. permissões
  console.log('  — a. permissão de cada papel × ação nova');
  await ok('can(): REPORT anônimo não · usuário sim; MODERATE só admin global (dono/coordenador não)', async () => {
    assert.strictEqual(await roles.can(null, null, null, 'REPORT'), false);
    assert.strictEqual(await roles.can(U.user.id, 'user', null, 'REPORT'), true);
    for (const u of [U.user, U.owner, U.coord]) assert.strictEqual(await roles.can(u.id, 'user', null, 'MODERATE'), false);
    assert.strictEqual(await roles.can(null, null, null, 'MODERATE'), false);
    assert.strictEqual(await roles.can(U.admin.id, 'admin', null, 'MODERATE'), true);
  });
  await ok('can(): CREATE_TOURNAMENT logado sim, anônimo não; PRIVACY_SELF só para si mesmo', async () => {
    assert.strictEqual(await roles.can(U.user.id, 'user', null, 'CREATE_TOURNAMENT'), true);
    assert.strictEqual(await roles.can(null, null, null, 'CREATE_TOURNAMENT'), false);
    assert.strictEqual(await roles.can(U.user.id, 'user', null, 'PRIVACY_SELF', { targetUserId: U.user.id }), true);
    assert.strictEqual(await roles.can(U.user.id, 'user', null, 'PRIVACY_SELF', { targetUserId: U.user2.id }), false);
  });
  const queueAs = (u) => call('GET', '/api/liga/moderation/queue', { token: u ? tok(u) : null });
  await ok('fila de moderação: anônimo 401, usuário/dono/coordenador 403, admin 200', async () => {
    assert.strictEqual((await queueAs(null)).status, 401);
    for (const u of [U.user, U.owner, U.coord]) assert.strictEqual((await queueAs(u)).status, 403, u.name);
    const r = await queueAs(U.admin);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.items) && r.json.reasons && r.json.reasons.OFFENSIVE);
  });

  // ================================================================ b. denúncia
  console.log('  — b. denúncia');
  const report = (u, body) => call('POST', '/api/liga/reports', { token: u ? tok(u) : null, body });
  let repT; let repPost; let repImg; let repEntry;
  await ok('denunciar exige login (401); motivo inválido 400; tipo inválido 400', async () => {
    assert.strictEqual((await report(null, { targetType: 'TOURNAMENT', targetId: T.id, reason: 'OFFENSIVE' })).status, 401);
    assert.strictEqual((await report(U.user, { targetType: 'TOURNAMENT', targetId: T.id, reason: 'XYZ' })).status, 400);
    assert.strictEqual((await report(U.user, { targetType: 'USER', targetId: T.id, reason: 'OFFENSIVE' })).status, 400);
  });
  await ok('denúncia dos 4 alvos (torneio, time, aviso, imagem) → 201; texto limitado a 500', async () => {
    let r = await report(U.user, { targetType: 'TOURNAMENT', targetId: T.slug, reason: 'SCAM', text: 'x'.repeat(900) });
    assert.strictEqual(r.status, 201, r.text); repT = r.json.report.id;
    const row = await prisma.contentReport.findUnique({ where: { id: repT } });
    assert.strictEqual(row.targetId, T.id, 'slug vira id'); assert.strictEqual(row.text.length, 500); assert.strictEqual(row.status, 'OPEN');
    r = await report(U.user, { targetType: 'ENTRY', targetId: eB.id, reason: 'OFFENSIVE' }); assert.strictEqual(r.status, 201, r.text); repEntry = r.json.report.id;
    r = await report(U.user, { targetType: 'POST', targetId: post1.id, reason: 'IMPROPER' }); assert.strictEqual(r.status, 201, r.text); repPost = r.json.report.id;
    // URL FORJADA por quem denuncia (outra imagem / link externo) é ignorada: vale o valor do campo no servidor
    r = await report(U.user, { targetType: 'IMAGE', targetId: eA.id, context: { entity: 'entry', entityId: eA.id, field: 'logoUrl', url: '/media/' + 'c'.repeat(64) + '.png' }, reason: 'IMPROPER' });
    assert.strictEqual(r.status, 201, r.text); repImg = r.json.report.id;
    const img = await prisma.contentReport.findUnique({ where: { id: repImg } });
    assert.strictEqual(img.targetId, `entry:${eA.id}:logoUrl`); assert.strictEqual(img.context.url, logo.url, 'URL vem do servidor, não do denunciante');
    const noImg = await report(U.user2, { targetType: 'IMAGE', targetId: T.id, context: { entity: 'tournament', entityId: T.id, field: 'bannerUrl', url: 'https://evil.example/pixel.png' }, reason: 'OTHER' });
    assert.strictEqual(noImg.status, 400, 'campo sem imagem não vira denúncia de imagem');
  });
  const checkDedup = async () => {
    const r = await report(U.user, { targetType: 'POST', targetId: post1.id, reason: 'OFFENSIVE' });
    assert.strictEqual(r.status, 409, r.text); assert.strictEqual(r.json.code, 'ALREADY_REPORTED');
  };
  await ok('mesma pessoa não denuncia o mesmo alvo 2x em aberto (409); outra pessoa pode', async () => {
    await checkDedup();
    assert.strictEqual((await report(U.user2, { targetType: 'POST', targetId: post1.id, reason: 'OFFENSIVE' })).status, 201);
  });
  await ok('alvo de torneio PRIVADO sem ser membro = MESMO 404 de "não existe"; membro denuncia', async () => {
    const a = await report(U.user, { targetType: 'TOURNAMENT', targetId: P.id, reason: 'OTHER' });
    const b = await report(U.user, { targetType: 'TOURNAMENT', targetId: 'nao-existe-' + RUN, reason: 'OTHER' });
    assert.strictEqual(a.status, 404); assert.strictEqual(b.status, 404); assert.strictEqual(a.text, b.text);
    assert.strictEqual((await report(U.owner, { targetType: 'TOURNAMENT', targetId: P.id, reason: 'OTHER' })).status, 201);
  });
  await ok('limitador por usuário: a 21ª denúncia na hora → 429 em PT', async () => {
    let last = null;
    for (let i = 0; i < 21; i++) last = await report(U.spammer, { targetType: 'TOURNAMENT', targetId: T2.id, reason: 'OTHER' });
    assert.strictEqual(last.status, 429); assert.ok(/denúncias/.test(last.json.error));
  });

  // ================================================================ c. fila: ações
  console.log('  — c. fila de revisão: ações');
  const adm = (method, url, body) => call(method, url, { token: tok(U.admin), body });
  await ok('dono/coordenador NÃO executam ação de moderação (403)', async () => {
    for (const u of [U.owner, U.coord]) {
      assert.strictEqual((await call('POST', `/api/liga/moderation/reports/${repPost}/hide-post`, { token: tok(u) })).status, 403);
      assert.strictEqual((await call('POST', `/api/liga/moderation/tournaments/${T.id}/suspend`, { token: tok(u), body: { confirm: true } })).status, 403);
      assert.strictEqual((await call('POST', '/api/liga/moderation/organizers/suspend', { token: tok(u), body: { userId: U.org2.id, confirm: true } })).status, 403);
    }
  });
  await ok('fila mostra o alvo descrito e quantas denúncias o mesmo alvo tem', async () => {
    const r = await adm('GET', '/api/liga/moderation/queue');
    const it = r.json.items.find((x) => x.id === repPost);
    assert.ok(it && it.target && /Aviso suspeito/.test(it.target.body), JSON.stringify(it));
    assert.strictEqual(it.sameTargetOpen, 2);
    assert.ok(it.tournament && it.tournament.slug === T.slug && it.organizer && it.organizer.id === U.owner.id);
  });
  await ok('descartar fecha a denúncia (DISMISSED) e grava no registro global', async () => {
    const r = await adm('POST', `/api/liga/moderation/reports/${repEntry}/dismiss`);
    assert.strictEqual(r.status, 200, r.text);
    const row = await prisma.contentReport.findUnique({ where: { id: repEntry } });
    assert.strictEqual(row.status, 'DISMISSED'); assert.strictEqual(row.reviewedBy, U.admin.id); assert.ok(row.reviewedAt);
    assert.ok(await prisma.moderationLog.findFirst({ where: { action: 'report.dismiss', reportId: repEntry } }));
  });
  const postsIds = async () => ((await call('GET', `/api/tournaments/${T.id}/posts`)).json.posts || []).map((p) => p.id);
  await ok('ocultar aviso: some do mural público, fecha as 2 denúncias do mesmo aviso, auditoria post.hide; voltar mostra de novo', async () => {
    assert.ok((await postsIds()).includes(post1.id));
    const r = await adm('POST', `/api/liga/moderation/reports/${repPost}/hide-post`);
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.closed, 2);
    assert.ok(!(await postsIds()).includes(post1.id));
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'post.hide', entityId: post1.id } }));
    assert.strictEqual((await prisma.contentReport.count({ where: { targetId: post1.id, status: 'OPEN' } })), 0);
    assert.strictEqual((await report(U.user, { targetType: 'POST', targetId: post1.id, reason: 'OTHER' })).status, 404, 'aviso oculto não é alvo');
    const u = await adm('POST', `/api/liga/moderation/posts/${post1.id}/unhide`);
    assert.strictEqual(u.status, 200); assert.ok((await postsIds()).includes(post1.id));
    await adm('POST', `/api/liga/moderation/reports/${repPost}/hide-post`); // deixa oculto para a página
  });
  const sha = logo.url.slice(7, 71);
  const checkImageHidden = async () => {
    const es = await prisma.tournamentEntry.findMany({ where: { id: { in: [eA.id, eA2.id] } }, select: { logoUrl: true } });
    assert.ok(es.every((e) => e.logoUrl === null), 'escudo nulo nas 2 categorias do time');
    const mo = await prisma.mediaObject.findUnique({ where: { sha256: sha } });
    assert.ok(mo.blockedAt, 'MediaObject bloqueado');
    assert.strictEqual((await call('GET', logo.url)).status, 404, '/media 404');
  };
  await ok('ocultar imagem: campo vira nulo (todas as categorias do time), MediaObject bloqueado, /media 404, reenvio do mesmo arquivo recusado', async () => {
    assert.strictEqual((await call('GET', logo.url)).status, 200);
    const r = await adm('POST', `/api/liga/moderation/reports/${repImg}/hide-image`, {});
    assert.strictEqual(r.status, 200, r.text);
    await checkImageHidden();
    const dataUri = 'data:image/png;base64,' + imgBuf.toString('base64');
    const up = await call('POST', `/api/tournaments/entries/${eA.id}/logo`, { token: tok(U.owner), body: { logo: dataUri } });
    assert.strictEqual(up.status, 400, up.text); assert.ok(/bloqueada/.test(up.json.error));
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'image.hide' } }));
    assert.ok(await prisma.moderationLog.findFirst({ where: { action: 'image.hide', reportId: repImg } }));
  });

  // ================================================================ d. torneio suspenso
  console.log('  — d. torneio suspenso some do público');
  await ok('suspender exige confirmação (409) e motivo vai para auditoria', async () => {
    assert.strictEqual((await adm('POST', `/api/liga/moderation/tournaments/${T.id}/suspend`, { reason: 'golpe' })).status, 409);
    const r = await adm('POST', `/api/liga/moderation/tournaments/${T.id}/suspend`, { reason: 'golpe com PIX', reportId: repT, confirm: true });
    assert.strictEqual(r.status, 200, r.text);
    const t = await prisma.tournament.findUnique({ where: { id: T.id } });
    assert.ok(t.suspendedAt && t.suspendedReason === 'golpe com PIX' && t.suspendedBy === U.admin.id);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'tournament.suspend' } }));
    assert.strictEqual((await prisma.contentReport.findUnique({ where: { id: repT } })).status, 'ACTIONED');
  });
  // Rotas públicas cobertas (todas com a MESMA resposta do torneio inexistente)
  const FAKE = 'nao-existe-' + RUN;
  const ROUTES = (id, slug) => [
    `/api/tournaments/${id}`, `/api/tournaments/${slug}`, `/api/tournaments/${id}/categories`, `/api/tournaments/${id}/entries`,
    `/api/tournaments/${id}/categories/${cat.id}/matches`, `/api/tournaments/${id}/categories/${cat.id}/standings`,
    `/api/tournaments/${id}/posts`, `/api/tournaments/${slug}/posts`, `/api/tournaments/${id}/stats/scorers`, `/api/tournaments/${id}/suspensions`,
    `/api/tournaments/${id}/sponsors`, `/api/tournaments/${id}/arte/classificacao.png`, `/api/tournaments/${id}/qr.png`, `/api/tournaments/${id}/live`,
    `/api/tournaments/${id}/join-links`, `/api/tournaments/${slug}/pickup`, `/api/public/tournaments/${slug}`,
    `/t/${slug}/calendario.ics`, `/t/${slug}/telao`, `/t/${slug}/embed`, `/api/tournament-registration/public/${slug}`,
  ];
  const ENTITY_ROUTES = [
    [`/api/tournaments/matches/${m1.id}/sheet`, 'partida/jogo'], [`/api/tournaments/entries/${eA.id}/players`, 'time'], [`/api/public/entries/${eB.id}/logo`, 'escudo'],
  ];
  let suspendedCheck = null;
  suspendedCheck = async (who) => {
    const viewer = who ? { token: tok(who) } : {};
    const bad = [];
    const a = ROUTES(T.id, T.slug); const b = ROUTES(FAKE, FAKE);
    for (let i = 0; i < a.length; i++) {
      const ra = await call('GET', a[i], viewer); const rb = await call('GET', b[i], viewer);
      if (ra.status !== 404 || ra.status !== rb.status || (ra.json && JSON.stringify(ra.json) !== JSON.stringify(rb.json)) || (!ra.json && ra.text !== rb.text)) bad.push(`${a[i]} → ${ra.status} vs ${rb.status}`);
    }
    for (const [u] of ENTITY_ROUTES) { const r = await call('GET', u, viewer); if (r.status !== 404) bad.push(`${u} → ${r.status}`); }
    assert.deepStrictEqual(bad, []);
  };
  await ok(`suspenso: ${ROUTES('x', 'x').length} rotas públicas + ${ENTITY_ROUTES.length} de entidade dão o MESMO 404 de "não existe" (anônimo)`, () => suspendedCheck(null));
  await ok('suspenso: usuário logado, coordenador (membro) e atleta do elenco também recebem 404', async () => {
    await suspendedCheck(U.user); await suspendedCheck(U.coord); await suspendedCheck(U.ath);
  });
  const listsHide = async () => {
    const v = await call('GET', '/api/tournaments?limit=50');
    assert.ok(!(v.json.tournaments || v.json || []).some((t) => t.id === T.id), 'fora da vitrine');
    const s = await call('GET', `/api/tournaments/series/${T.seriesSlug}/champions`);
    assert.ok(!JSON.stringify(s.json || {}).includes(T.id), 'fora da série');
    const rk = await call('GET', '/api/tournaments/rankings/FUTSAL/scorers?limit=200');
    assert.ok(!(rk.json.scorers || []).some((x) => x.name === 'Atleta Real F6'), 'gols do suspenso fora do ranking');
    const h = await call('GET', `/api/tournaments/athletes/${U.ath.username}/history`);
    assert.ok(!JSON.stringify(h.json || {}).includes(T.id), 'fora do histórico público');
    const mt = await call('GET', '/api/tournaments/my-tournaments', { token: tok(U.coord) });
    assert.ok(!(mt.json.tournaments || []).some((t) => t.id === T.id), 'fora de "onde atuo" do coordenador');
  };
  await ok('suspenso some das LISTAS: vitrine, série, ranking de artilharia, histórico do atleta, "onde atuo"', listsHide);
  await ok('dono e admin ainda VEEM (com aviso de suspenso em my-roles); ninguém além do admin escreve', async () => {
    const o = await call('GET', `/api/tournaments/${T.id}`, { token: tok(U.owner) });
    assert.strictEqual(o.status, 200); assert.ok(o.json.suspendedAt);
    const mr = await call('GET', `/api/tournaments/${T.id}/my-roles`, { token: tok(U.owner) });
    assert.ok(mr.json.suspension && mr.json.suspension.reason === 'golpe com PIX');
    assert.strictEqual((await call('GET', `/api/tournaments/${T.id}`, { token: tok(U.admin) })).status, 200);
    const w1 = await call('PATCH', `/api/tournaments/${T.id}`, { token: tok(U.owner), body: { city: 'JP' } });
    assert.strictEqual(w1.status, 403, w1.text); assert.strictEqual(w1.json.code, 'SUSPENDED');
    const w2 = await call('POST', `/api/tournaments/${T.id}/posts`, { token: tok(U.owner), body: { body: 'novo' } });
    assert.strictEqual(w2.status, 403); assert.strictEqual(w2.json.code, 'SUSPENDED');
    const w3 = await call('POST', `/api/tournaments/${T.id}/entries`, { token: tok(U.owner), body: { categoryId: cat.id, team: true, name: 'Novo' } });
    assert.strictEqual(w3.status, 403, 'dono não inscreve no suspenso');
    assert.strictEqual(await roles.can(U.owner.id, 'user', T.id, 'MANAGE_TOURNAMENT'), false);
    assert.strictEqual(await roles.can(U.owner.id, 'user', T.id, 'VIEW_AUDIT'), true);
    const wa = await call('PATCH', `/api/tournaments/${T.id}`, { token: tok(U.admin), body: { city: 'João Pessoa' } });
    assert.strictEqual(wa.status, 200, wa.text);
  });
  await ok('reativar: volta a aparecer para o público (200) e na vitrine', async () => {
    const r = await adm('POST', `/api/liga/moderation/tournaments/${T.id}/unsuspend`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', `/api/tournaments/${T.id}`)).status, 200);
    assert.strictEqual((await call('GET', `/api/public/tournaments/${T.slug}`)).status, 200);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'tournament.unsuspend' } }));
  });

  // ================================================================ e. organizador suspenso
  console.log('  — e. organizador suspenso');
  let repT2 = null;
  await ok('suspender organizador (pela denúncia do torneio dele) exige confirmação; admin não é suspenso', async () => {
    const r0 = await report(U.user, { targetType: 'TOURNAMENT', targetId: T2.id, reason: 'SCAM' });
    repT2 = r0.json.report.id;
    assert.strictEqual((await adm('POST', '/api/liga/moderation/organizers/suspend', { reportId: repT2 })).status, 409);
    assert.strictEqual((await adm('POST', '/api/liga/moderation/organizers/suspend', { userId: U.admin.id, confirm: true })).status, 400);
    const r = await adm('POST', '/api/liga/moderation/organizers/suspend', { reportId: repT2, reason: 'spam', confirm: true });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.userId, U.org2.id);
    assert.ok(await roles.isOrganizerSuspended(U.org2.id));
  });
  const checkOrgSuspended = async () => {
    const c = await call('POST', '/api/tournaments', { token: tok(U.org2), body: { name: 'Nova liga ' + RUN, sport: 'FUTSAL' } });
    assert.strictEqual(c.status, 403, c.text); assert.strictEqual(c.json.code, 'ORGANIZER_SUSPENDED');
    const q = await call('POST', '/api/tournaments/quick', { token: tok(U.org2), body: { sport: 'FUTSAL', preset: 'liga-pontos-corridos', teams: ['A', 'B', 'C', 'D'] } });
    assert.strictEqual(q.status, 403);
    assert.strictEqual(await roles.can(U.org2.id, 'user', T2.id, 'MANAGE_TOURNAMENT'), false);
    assert.strictEqual(await roles.can(U.org2.id, 'user', null, 'CREATE_TOURNAMENT'), false);
    const p = await call('PATCH', `/api/tournaments/${T2.id}`, { token: tok(U.org2), body: { city: 'X' } });
    assert.strictEqual(p.status, 403); assert.strictEqual(p.json.code, 'ORGANIZER_SUSPENDED');
  };
  await ok('organizador suspenso: não cria torneio (POST / e /quick), can() nega gestão e criação', checkOrgSuspended);
  await ok('torneio dele (não suspenso) segue visível para o público; my-roles avisa o organizador', async () => {
    assert.strictEqual((await call('GET', `/api/tournaments/${T2.id}`)).status, 200);
    const mr = await call('GET', `/api/tournaments/${T2.id}/my-roles`, { token: tok(U.org2) });
    assert.strictEqual(mr.json.organizerSuspended, true);
  });
  await ok('reativar organizador: volta a criar', async () => {
    assert.strictEqual((await adm('POST', `/api/liga/moderation/organizers/${U.org2.id}/unsuspend`)).status, 200);
    const c = await call('POST', '/api/tournaments', { token: tok(U.org2), body: { name: 'Liga reativada ' + RUN, sport: 'FUTSAL' } });
    assert.strictEqual(c.status, 201, c.text);
    assert.ok(await prisma.moderationLog.findFirst({ where: { action: 'organizer.unsuspend', targetId: U.org2.id } }));
  });

  // ================================================================ f. filtro nas rotas
  console.log('  — f. filtro de texto ofensivo nas rotas');
  const BAD = 'Time do C4r4lh0';
  const blocked = (r, label) => { assert.strictEqual(r.status, 400, label + ': ' + r.status + ' ' + r.text); assert.ok(!/c4r4lh0|caralho/i.test(r.text), label + ' repetiu a palavra'); };
  await ok('torneio (criar/editar), categoria (criar/editar), /quick (nome e times) → 400', async () => {
    blocked(await call('POST', '/api/tournaments', { token: tok(U.user), body: { name: BAD, sport: 'FUTSAL' } }), 'criar torneio');
    blocked(await call('PATCH', `/api/tournaments/${T.id}`, { token: tok(U.owner), body: { name: BAD } }), 'editar torneio');
    blocked(await call('POST', `/api/tournaments/${T.id}/categories`, { token: tok(U.owner), body: { name: BAD } }), 'criar categoria');
    blocked(await call('PATCH', `/api/tournaments/${T.id}/categories/${cat.id}`, { token: tok(U.owner), body: { name: BAD } }), 'editar categoria');
    blocked(await call('POST', '/api/tournaments/quick', { token: tok(U.user), body: { sport: 'FUTSAL', preset: 'liga-pontos-corridos', teams: ['Bessa', 'Tambaú', BAD, 'Manaíra'] } }), '/quick times');
    blocked(await call('POST', '/api/tournaments/quick', { token: tok(U.user), body: { sport: 'FUTSAL', preset: 'racha-semanal', name: 'Racha dos Viados', teams: ['A', 'B'] } }), '/quick nome do racha');
  });
  await ok('time (inscrição), clube (editar e /api/clubs), jogador do elenco, aviso → 400', async () => {
    blocked(await call('POST', `/api/tournaments/${T.id}/entries`, { token: tok(U.owner), body: { categoryId: cat.id, team: true, name: BAD } }), 'time');
    blocked(await call('POST', `/api/tournaments/entries/${eA.id}/players`, { token: tok(U.owner), body: { name: 'Zé Arrombado' } }), 'jogador');
    blocked(await call('POST', `/api/tournaments/${T.id}/posts`, { token: tok(U.owner), body: { body: 'Vamos com tudo, porra!' } }), 'aviso');
    blocked(await call('POST', '/api/clubs', { token: tok(U.user), body: { name: 'Nazistas FC' } }), 'criar clube');
  });
  await ok('racha (jogadores), cadastro de atleta (nome e @) e inscrição pública (time/elenco) → 400', async () => {
    const R = await prisma.tournament.create({ data: { slug: 'f6-racha-' + RUN, name: 'Racha F6', sport: 'FUTSAL', format: 'PICKUP', ownerId: U.owner.id, status: 'ONGOING' } });
    blocked(await call('POST', `/api/tournaments/${R.id}/pickup/players`, { token: tok(U.owner), body: { names: ['Pedro', 'Merda Total'] } }), 'racha');
    const before = await prisma.user.count();
    blocked(await call('POST', '/api/tournaments/athletes/register', { body: { name: 'Fulano Cuzão', whatsapp: '83999990001', password: '1234', code: '000000' } }), 'cadastro nome');
    blocked(await call('POST', '/api/tournaments/athletes/register', { body: { name: 'Fulano', instagram: '@put4ria', whatsapp: '83999990001', password: '1234', code: '000000' } }), 'cadastro @');
    assert.strictEqual(await prisma.user.count(), before);
    const RT = await prisma.tournament.create({ data: { slug: 'f6-insc-' + RUN, name: 'Inscrição F6', sport: 'FUTSAL', ownerId: U.owner.id, status: 'OPEN' } });
    const rc = await prisma.tournamentCategory.create({ data: { tournamentId: RT.id, name: 'Livre' } });
    assert.strictEqual((await call('PUT', `/api/tournament-registration/manage/${RT.id}/config`, { token: tok(U.owner), body: { enabled: true, categories: { [rc.id]: { feeCents: 0 } } } })).status, 200);
    blocked(await call('POST', `/api/tournament-registration/public/${RT.slug}/register`, { token: tok(U.user), body: { categoryId: rc.id, teamName: 'Os Fdp', contactName: 'Capitão', contactPhone: '83999990002', responsibleAdult: true, roster: [{ name: 'Goleiro' }] } }), 'inscrição time');
    blocked(await call('POST', `/api/tournament-registration/public/${RT.slug}/register`, { token: tok(U.user), body: { categoryId: rc.id, teamName: 'Bessa FC', contactName: 'Capitão', contactPhone: '83999990002', responsibleAdult: true, roster: [{ name: 'Bosta Silva' }] } }), 'inscrição elenco');
    const okr = await call('POST', `/api/tournament-registration/public/${RT.slug}/register`, { token: tok(U.user), body: { categoryId: rc.id, teamName: 'Cuité Futsal', contactName: 'Capitão', contactPhone: '83999990002', responsibleAdult: true, roster: [{ name: 'Zé Pinto' }] } });
    assert.strictEqual(okr.status, 201, 'nome real passa: ' + okr.text);
  });
  await ok('nomes reais passam pelas rotas (Cabo Branco, Cuité, Bessa, jogador Pinto)', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/${T.id}/entries`, { token: tok(U.owner), body: { categoryId: cat.id, team: true, name: 'Cabo Branco ' + RUN } })).status, 201);
    assert.strictEqual((await call('POST', `/api/tournaments/entries/${eB.id}/players`, { token: tok(U.owner), body: { name: 'João Pinto da Cunha' } })).status, 201);
    assert.strictEqual((await call('POST', '/api/tournaments', { token: tok(U.user), body: { name: 'Copa Cuité-Bessa ' + RUN, sport: 'FUTSAL' } })).status, 201);
  });

  // ================================================================ g. menores
  console.log('  — g. menores (LIGA_MINORS)');
  const checkMinorsOff = async () => {
    assert.strictEqual(minors.enabled(), false);
    const st = await call('GET', '/api/liga/minors/status');
    assert.deepStrictEqual(st.json, { enabled: false });
    for (const [m, u, who] of [['GET', '/api/liga/minors/consent', null], ['POST', '/api/liga/minors', null], ['POST', '/api/liga/minors', U.guardian], ['GET', '/api/liga/minors/mine', U.guardian], ['POST', '/api/liga/minors/x/roster', U.guardian], ['POST', '/api/liga/minors/x/revoke', U.guardian]]) {
      const r = await call(m, u, { token: who ? tok(who) : null, body: m === 'POST' ? { firstName: 'Ana', birthDate: '2014-03-03', consent: { accepted: true, version: minors.CONSENT_VERSION } } : undefined });
      assert.strictEqual(r.status, 404, `${m} ${u} ${r.status}`); assert.strictEqual(r.json.error, 'indisponível');
    }
    assert.strictEqual(await prisma.minorProfile.count(), 0, 'nenhum dado de menor gravado');
  };
  await ok('flag OFF: status false, todas as rotas do responsável 404 "indisponível" (anônimo e logado), zero MinorProfile', checkMinorsOff);
  await ok('flag OFF: cadastro de atleta com data de menor → 403 sem criar conta e sem gravar a data; inscrição pública de menor → 403', async () => {
    const before = await prisma.user.count();
    const r = await call('POST', '/api/tournaments/athletes/register', { body: { name: 'Joãozinho', whatsapp: '83999990003', password: '1234', code: '123456', birthDate: '2013-06-01' } });
    assert.strictEqual(r.status, 403); assert.strictEqual(r.json.code, 'MINOR_SIGNUP_UNAVAILABLE');
    assert.strictEqual(await prisma.user.count(), before);
    const AT = await prisma.tournament.create({ data: { slug: 'f6-beach-' + RUN, name: 'Beach F6', sport: 'BEACH_TENNIS', ownerId: U.owner.id, status: 'OPEN' } });
    const ac = await prisma.tournamentCategory.create({ data: { tournamentId: AT.id, name: 'Simples' } });
    await call('PUT', `/api/tournament-registration/manage/${AT.id}/config`, { token: tok(U.owner), body: { enabled: true, categories: { [ac.id]: { feeCents: 0 } } } });
    const rr = await call('POST', `/api/tournament-registration/public/${AT.slug}/register`, { body: { categoryId: ac.id, athletes: [{ name: 'Kid Teste', birthDate: '2014-05-05', guardian: { name: 'Mãe', phone: '83999990004' } }], contactPhone: '83999990004', acceptTerms: true } });
    assert.strictEqual(rr.status, 403, rr.text); assert.ok(/menor/.test(rr.json.error));
    assert.strictEqual(await prisma.tournamentRegistration.count({ where: { tournamentId: AT.id } }), 0);
  });
  await ok('flag ON: termo em destaque (versão+hash), sem termo 400, maior de 18 400, cria perfil SEM verificação; sem permissão no elenco 403', async () => {
    process.env.LIGA_MINORS = '1';
    try {
      const c = await call('GET', '/api/liga/minors/consent');
      assert.strictEqual(c.status, 200); assert.strictEqual(c.json.version, minors.CONSENT_VERSION); assert.ok(c.json.text.length > 100 && c.json.ageVerification === 'NONE');
      assert.strictEqual((await call('POST', '/api/liga/minors', { token: tok(U.guardian), body: { firstName: 'Ana', birthDate: '2014-03-03' } })).status, 400);
      assert.strictEqual((await call('POST', '/api/liga/minors', { token: tok(U.guardian), body: { firstName: 'Ana', birthDate: '1990-03-03', consent: { accepted: true, version: minors.CONSENT_VERSION } } })).status, 400);
      assert.strictEqual((await call('POST', '/api/liga/minors', { body: { firstName: 'Ana', birthDate: '2014-03-03', consent: { accepted: true, version: minors.CONSENT_VERSION } } })).status, 401);
      const usersBefore = await prisma.user.count();
      const r = await call('POST', '/api/liga/minors', { token: tok(U.guardian), body: { firstName: 'Ana Clara Souza', birthDate: '2014-03-03', ageVerification: 'VERIFIED', consent: { accepted: true, version: minors.CONSENT_VERSION } } });
      assert.strictEqual(r.status, 201, r.text);
      assert.strictEqual(r.json.firstName, 'Ana', 'só o primeiro nome'); assert.strictEqual(r.json.ageVerification, 'NONE', 'autodeclaração não verifica');
      assert.strictEqual(await prisma.user.count(), usersBefore, 'menor NÃO vira conta');
      const row = await prisma.minorProfile.findUnique({ where: { id: r.json.id } });
      assert.strictEqual(row.consentTextHash, minors.CONSENT_HASH); assert.ok(row.consentAt);
      // outra conta (sem papel no time do menor) não liga
      assert.strictEqual((await call('POST', `/api/liga/minors/${r.json.id}/roster`, { token: tok(U.user), body: { playerId: pMinor.id } })).status, 404, 'não é o responsável');
      const own = await call('POST', '/api/liga/minors', { token: tok(U.user), body: { firstName: 'Beto', birthDate: '2015-01-01', consent: { accepted: true, version: minors.CONSENT_VERSION } } });
      assert.strictEqual((await call('POST', `/api/liga/minors/${own.json.id}/roster`, { token: tok(U.user), body: { playerId: pMinor.id } })).status, 403, 'sem permissão de elenco');
      // responsável que é admin do time liga a vaga → nome público anônimo, fora da artilharia
      const l = await call('POST', `/api/liga/minors/${r.json.id}/roster`, { token: tok(U.guardian), body: { playerId: pMinor.id } });
      assert.strictEqual(l.status, 200, l.text);
      const pl = await prisma.rosterPlayer.findUnique({ where: { id: pMinor.id } });
      assert.strictEqual(pl.name, minors.MINOR_LABEL); assert.strictEqual(pl.minorProfileId, r.json.id);
      // vaga do menor não recebe conta (nem convite, nem ligação direta)
      assert.strictEqual((await call('POST', `/api/tournaments/players/${pMinor.id}/invite`, { token: tok(U.owner) })).status, 409, 'convite para vaga de menor');
      assert.strictEqual((await call('POST', `/api/tournaments/players/${pMinor.id}/link`, { token: tok(U.owner), body: { userId: U.user2.id } })).status, 409, 'ligar conta em vaga de menor');
      const sc = await call('GET', `/api/tournaments/${T.id}/stats/scorers`);
      assert.ok(!(sc.json.ranking || []).some((x) => x.playerId === pMinor.id || x.name === minors.MINOR_LABEL), 'menor fora da artilharia: ' + sc.text.slice(0, 200));
      const m = await prisma.tournamentMatch.findUnique({ where: { id: m1.id } });
      assert.strictEqual(m.awayScore, 1, 'gol do menor segue no placar do time');
      const rk = await call('GET', '/api/tournaments/rankings/FUTSAL/scorers?limit=200');
      assert.ok(!(rk.json.scorers || []).some((x) => x.name === minors.MINOR_LABEL), 'fora do ranking do esporte');
      // aviso só para o responsável (in-app, nunca WhatsApp)
      const n0 = await prisma.appNotification.count({ where: { userId: U.guardian.id } });
      await minors.notifyGuardian(r.json.id, { title: 'Jogo', body: 'amanhã 19h' });
      assert.strictEqual(await prisma.appNotification.count({ where: { userId: U.guardian.id } }), n0 + 1);
      const mine = await call('GET', '/api/liga/minors/mine', { token: tok(U.guardian) });
      assert.strictEqual(mine.json.items.length, 1);
      const rv = await call('POST', `/api/liga/minors/${r.json.id}/revoke`, { token: tok(U.guardian) });
      assert.strictEqual(rv.json.status, 'REVOKED');
    } finally { delete process.env.LIGA_MINORS; }
  });
  await ok('conta do app que DECLARA menor de 18 (User.birthDate) não entra em time pelo link do time nem pelo convite da vaga (403); adulto entra', async () => {
    const kid = await mkUser('conta de menor', { birthDate: '2012-06-01' });
    const adult = await mkUser('conta adulta', { birthDate: '1990-06-01' });
    const ti = await call('POST', `/api/tournaments/entries/${eB.id}/team-invite`, { token: tok(U.owner), body: {} });
    assert.strictEqual(ti.status, 201, ti.text);
    const token = String(ti.json.url).split('/').pop();
    const j = await call('POST', `/api/tournaments/team-invites/${token}/join`, { token: tok(kid) });
    assert.strictEqual(j.status, 403, j.text); assert.ok(/menor/.test(j.json.error));
    assert.strictEqual(await prisma.rosterPlayer.count({ where: { userId: kid.id } }), 0, 'nada gravado do menor');
    const vaga = await prisma.rosterPlayer.create({ data: { entryId: eB.id, name: 'Vaga convite', number: 30 } });
    const inv = await call('POST', `/api/tournaments/players/${vaga.id}/invite`, { token: tok(U.owner) });
    const itok = String(inv.json.url).split('/').pop();
    assert.strictEqual((await call('POST', `/api/tournaments/roster-invites/${itok}/claim`, { token: tok(kid) })).status, 403);
    assert.strictEqual((await call('POST', `/api/tournaments/team-invites/${token}/join`, { token: tok(adult) })).status, 201);
  });
  await ok('flag OFF de novo: rotas voltam a 404', async () => {
    const r = await call('GET', '/api/liga/minors/mine', { token: tok(U.guardian) });
    assert.strictEqual(r.status, 404);
  });

  // ================================================================ h. privacidade
  console.log('  — h. privacidade: baixar e apagar');
  await prisma.athleteProfile.create({ data: { userId: U.ath.id, username: 'f6ath' + RUN, avatarUrl: '/media/' + 'b'.repeat(64) + '.png', bio: 'camisa 9' } });
  await prisma.athleteRating.create({ data: { userId: U.ath.id, sport: 'FUTSAL', rating: 3.1 } });
  await prisma.glickoRating.create({ data: { sport: 'FUTSAL', format: 'TEAM', subjectType: 'USER', subjectKey: U.ath.id, userId: U.ath.id } }).catch(() => {});
  await prisma.clubNotifyPref.create({ data: { userId: U.ath.id, push: true } });
  await prisma.pushSubscription.create({ data: { userId: U.ath.id, endpoint: 'https://push.test/club-' + RUN, p256dh: 'k', authKey: 'a', app: 'club' } });
  await prisma.pushSubscription.create({ data: { userId: U.ath.id, endpoint: 'https://push.test/varejo-' + RUN, p256dh: 'k', authKey: 'a', app: null } });
  await prisma.consent.createMany({ data: [{ userId: U.ath.id, scope: 'live_tracking', granted: true, version: 'v1' }, { userId: U.ath.id, scope: 'marketing', granted: true, version: 'v1' }] });
  let medalOk = true;
  try {
    const iss = await prisma.medalIssuer.findFirst();
    const tpl = await prisma.medalTemplate.findFirst();
    if (iss && tpl) await prisma.medal.create({ data: { serial: 'F6-' + RUN, credentialId: 'urn:uuid:' + crypto.randomUUID(), userId: U.ath.id, issuerId: iss.id, templateId: tpl.id, sport: 'FUTSAL', series: 'f6', eventName: 'Copa F6', tier: 'GOLD', editionNumber: 1, editionTotal: 1, recipientName: 'Atleta Real F6', identitySalt: 'SAL-SECRETO-' + RUN, identityHash: crypto.createHash('sha256').update(ATH_CPF + 'SAL-SECRETO-' + RUN).digest('hex'), credentialJwt: 'jwt', verificationCode: 'AAAA-BBBB-CCCC', issuedByUserId: U.admin.id } });
    else medalOk = false;
  } catch (_) { medalOk = false; }
  await ok('baixar: exige login (401); JSON com perfil, elenco, lances, avisos, preferências, consentimentos, medalhas; SEM CPF em claro nem sal; pedido registrado', async () => {
    assert.strictEqual((await call('GET', '/api/liga/privacy/export')).status, 401);
    const r = await call('GET', '/api/liga/privacy/export', { token: tok(U.ath) });
    assert.strictEqual(r.status, 200, r.text.slice(0, 200));
    assert.ok(/attachment/.test(r.headers['content-disposition'] || ''));
    const j = r.json;
    assert.strictEqual(j.perfilAtleta.bio, 'camisa 9');
    assert.ok(j.elenco.some((x) => x.id === pAth.id)); assert.ok(j.lancesDaSumula.filter((e) => e.type === 'GOAL').length >= 2);
    assert.ok(j.preferenciasDeAviso && j.consentimentos.length === 2 && j.vinculosComTimes.length >= 1);
    assert.strictEqual(j.conta.cpfCadastrado, true);
    assert.ok(!r.text.includes(ATH_CPF), 'CPF em claro no arquivo');
    assert.ok(!/identitySalt|SAL-SECRETO/.test(r.text), 'sal da medalha no arquivo');
    if (medalOk) assert.ok(j.medalhas.length === 1 && /^[a-f0-9]{64}$/.test(j.medalhas[0].identityHash), 'medalha só com o hash');
    assert.ok(await prisma.privacyRequest.findFirst({ where: { userId: U.ath.id, kind: 'EXPORT', status: 'DONE' } }));
  });
  await ok('baixar: limitador (6º pedido na hora → 429)', async () => {
    let last = null;
    for (let i = 0; i < 6; i++) last = await call('GET', '/api/liga/privacy/export', { token: tok(U.exporter) });
    assert.strictEqual(last.status, 429);
  });
  const balanceBefore = 50;
  const sale = await prisma.sale.create({ data: { customerUserId: U.rich.id, total: 100, subtotal: 100 } }).catch(() => null);
  await ok('apagar: frase errada → 400 (nada muda)', async () => {
    const r = await call('POST', '/api/liga/privacy/delete', { token: tok(U.ath), body: { confirm: 'apagar' } });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'CONFIRM_REQUIRED');
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pAth.id } })).userId, U.ath.id);
  });
  const checkErased = async () => {
    const p = await prisma.rosterPlayer.findUnique({ where: { id: pAth.id } });
    assert.strictEqual(p.name, 'Atleta removido'); assert.strictEqual(p.userId, null);
    assert.strictEqual(await prisma.matchEvent.count({ where: { playerId: pAth.id, type: 'GOAL' } }), 2, 'gols continuam');
    const sc = await call('GET', `/api/tournaments/${T.id}/stats/scorers`);
    assert.ok(JSON.stringify(sc.json).includes('Atleta removido') && !JSON.stringify(sc.json).includes('Atleta Real F6'), 'súmula/artilharia com "Atleta removido"');
    const prof = await prisma.athleteProfile.findUnique({ where: { userId: U.ath.id } });
    assert.ok(prof.username === null && prof.avatarUrl === null && prof.bio === null);
    assert.strictEqual(await prisma.clubNotifyPref.count({ where: { userId: U.ath.id } }), 0);
    assert.strictEqual(await prisma.pushSubscription.count({ where: { userId: U.ath.id, app: 'club' } }), 0);
    assert.strictEqual(await prisma.pushSubscription.count({ where: { userId: U.ath.id, app: null } }), 1, 'push do varejo fica');
    assert.deepStrictEqual((await prisma.consent.findMany({ where: { userId: U.ath.id } })).map((c) => c.scope), ['marketing'], 'só o esportivo sai');
    assert.strictEqual((await prisma.teamMembership.findFirst({ where: { userId: U.ath.id } })).status, 'REMOVED');
  };
  await ok('apagar (sem saldo/compra): anonimiza o esportivo, gols seguem do time, push/consentimento esportivos saem, login desativado, pedido DONE', async () => {
    const r = await call('POST', '/api/liga/privacy/delete', { token: tok(U.ath), body: { confirm: 'APAGAR MEUS DADOS' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.loginExcluded, true); assert.strictEqual(r.json.status, 'DONE');
    await checkErased();
    const u = await prisma.user.findUnique({ where: { id: U.ath.id } });
    assert.strictEqual(u.active, false); assert.strictEqual(u.username, null); assert.strictEqual(u.cpf, null);
    if (medalOk) assert.strictEqual(await prisma.medal.count({ where: { userId: U.ath.id } }), 1, 'medalha (credencial assinada) fica');
    assert.strictEqual(await prisma.athleteRating.count({ where: { userId: U.ath.id } }), 0, 'nível do atleta (ranking público com nome) sai');
    assert.strictEqual(await prisma.glickoRating.count({ where: { userId: U.ath.id } }), 0, 'Glicko do atleta sai');
    assert.strictEqual((await call('GET', `/api/tournaments/athletes/${U.ath.id}/card`)).status, 404, 'card público some');
  });
  await ok('apagar (com saldo e compra): conta de login FICA, saldo e venda intocados, pedido PENDING_ADMIN aparece na fila do admin', async () => {
    const txBefore = await prisma.transaction.count({ where: { OR: [{ senderId: U.rich.id }, { receiverId: U.rich.id }] } });
    const r = await call('POST', '/api/liga/privacy/delete', { token: tok(U.rich), body: { confirm: 'apagar meus dados' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.loginExcluded, false); assert.strictEqual(r.json.status, 'PENDING_ADMIN');
    assert.ok(r.json.keptBecause.includes('saldo TenisCash'));
    const u = await prisma.user.findUnique({ where: { id: U.rich.id } });
    assert.strictEqual(u.active, true); assert.strictEqual(u.balance, balanceBefore, 'saldo intocado');
    if (sale) assert.ok(await prisma.sale.findUnique({ where: { id: sale.id } }), 'venda intocada');
    assert.strictEqual(await prisma.transaction.count({ where: { OR: [{ senderId: U.rich.id }, { receiverId: U.rich.id }] } }), txBefore);
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pRich.id } })).name, 'Atleta removido');
    const mp = await prisma.rosterPlayer.findUnique({ where: { id: mcPlayer.id } });
    assert.ok(mp.name === 'Rico no Master Cup' && mp.userId === U.rich.id, 'vaga no Master Cup intocada');
    assert.ok(r.json.summary.mantidoNoMasterCup && r.json.summary.mantidoNoMasterCup.vagas === 1, JSON.stringify(r.json.summary));
    assert.ok(r.json.keptBecause.some((x) => /Master Cup/.test(x)));
    const q = await adm('GET', '/api/liga/moderation/privacy-requests');
    const it = (q.json.items || []).find((x) => x.userId === U.rich.id);
    assert.ok(it && it.status === 'PENDING_ADMIN');
    assert.ok((await adm('GET', '/api/liga/moderation/queue')).json.pendingPrivacy >= 1);
    assert.strictEqual((await call('GET', '/api/liga/moderation/privacy-requests', { token: tok(U.rich) })).status, 403);
    const c = await adm('POST', `/api/liga/moderation/privacy-requests/${it.id}/close`, { note: 'combinado com o atleta' });
    assert.strictEqual(c.json.request.status, 'CLOSED');
  });

  // ================================================================ i. Master Cup
  console.log('  — i. Master Cup');
  await ok('Master Cup: denúncia funciona (201) e fica na fila; nada é suspenso sozinho', async () => {
    const r = await report(U.user, { targetType: 'TOURNAMENT', targetId: MC.slug, reason: 'OTHER' });
    assert.strictEqual(r.status, 201, r.text);
    const q = await adm('GET', '/api/liga/moderation/queue');
    const it = q.json.items.find((x) => x.id === r.json.report.id);
    assert.ok(it && it.tournament.excluded === true);
    assert.strictEqual((await prisma.tournament.findUnique({ where: { id: MC.id } })).suspendedAt, null);
  });
  await ok('Master Cup: ocultar aviso dele exige confirmação manual (409 sem confirm) — nada muda', async () => {
    const r = await report(U.user, { targetType: 'POST', targetId: mcPost.id, reason: 'OTHER' });
    assert.strictEqual(r.status, 201, r.text);
    const h = await adm('POST', `/api/liga/moderation/reports/${r.json.report.id}/hide-post`, {});
    assert.strictEqual(h.status, 409, h.text); assert.strictEqual(h.json.code, 'CONFIRM_REQUIRED');
    assert.strictEqual((await prisma.tournamentPost.findUnique({ where: { id: mcPost.id } })).hiddenAt, null);
    assert.strictEqual((await adm('POST', '/api/liga/moderation/organizers/suspend', { reportId: r.json.report.id, confirm: true })).status, 400, 'denúncia de aviso não suspende organizador');
  });
  await ok('Master Cup: edição não passa pelo filtro (nada da F6 interfere no evento)', async () => {
    const r = await call('PATCH', `/api/tournaments/${MC.id}`, { token: tok(U.admin), body: { prizeDescription: 'Troféu' } });
    assert.strictEqual(r.status, 200, r.text);
    await prisma.tournament.update({ where: { id: MC.id }, data: { prizeDescription: MC_T0.prizeDescription, updatedAt: MC_T0.updatedAt } });
  });
  await ok('Master Cup intacto byte a byte depois de toda a suíte', async () => {
    assert.strictEqual(await mcSnap(), MC_BEFORE);
  });

  // ================================================================ sabotagem
  console.log('  — prova de sabotagem');
  await prisma.tournament.update({ where: { id: T.id }, data: { suspendedAt: new Date(), suspendedReason: 'teste' } });
  const origSB = access.suspendedBlocks;
  await sabotage('tournamentAccess sem a checagem de suspenso → as rotas públicas do suspenso abririam',
    () => { access.suspendedBlocks = async () => false; }, () => suspendedCheck(null), () => { access.suspendedBlocks = origSB; });
  await prisma.tournament.update({ where: { id: T.id }, data: { suspendedAt: null, suspendedReason: null } });
  await prisma.organizerSuspension.update({ where: { userId: U.org2.id }, data: { liftedAt: null } });
  const origOS = roles.isOrganizerSuspended;
  await sabotage('can() sem olhar a suspensão do organizador → organizador suspenso criaria torneio',
    () => { roles.isOrganizerSuspended = async () => false; }, checkOrgSuspended, () => { roles.isOrganizerSuspended = origOS; });
  await prisma.organizerSuspension.update({ where: { userId: U.org2.id }, data: { liftedAt: new Date() } });
  const origFO = filter.findOffense;
  await sabotage('filtro desligado (findOffense sempre null) → nome ofensivo passaria nas rotas',
    () => { filter.findOffense = () => null; },
    async () => { const r = await call('POST', '/api/tournaments', { token: tok(U.user2), body: { name: BAD, sport: 'FUTSAL' } }); assert.strictEqual(r.status, 400); },
    () => { filter.findOffense = origFO; });
  const origEn = minors.enabled;
  await sabotage('fluxo de menores aberto com a flag desligada → rotas do responsável deixariam de dar 404',
    () => { minors.enabled = () => true; }, checkMinorsOff, () => { minors.enabled = origEn; });
  const origFF = prisma.contentReport.findFirst;
  await sabotage('denúncia sem trava de duplicata → a mesma pessoa denunciaria 2x',
    async () => { prisma.contentReport.findFirst = async () => null; await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "ContentReport_open_reporter_target_key"'); },
    async () => {
      await prisma.contentReport.updateMany({ where: { targetId: post1.id }, data: { status: 'OPEN' } });
      await prisma.tournamentPost.update({ where: { id: post1.id }, data: { hiddenAt: null } });
      await checkDedup();
    },
    async () => {
      prisma.contentReport.findFirst = origFF;
      // desfaz a duplicata criada pela sabotagem e recria o índice parcial
      const dups = await prisma.contentReport.findMany({ where: { reporterId: U.user.id, targetId: post1.id, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
      for (const d of dups.slice(1)) await prisma.contentReport.update({ where: { id: d.id }, data: { status: 'DISMISSED' } });
      await ensureApexSchema(prisma);
    });
  await ok('índice único parcial: 2 denúncias EM ABERTO iguais ao mesmo tempo → só 1 grava (a outra 409)', async () => {
    const tgt = await prisma.tournamentPost.create({ data: { tournamentId: T.id, body: 'corrida ' + RUN } });
    const rs = await Promise.all([1, 2, 3].map(() => report(U.user2, { targetType: 'POST', targetId: tgt.id, reason: 'OTHER' })));
    assert.strictEqual(rs.filter((x) => x.status === 201).length, 1, rs.map((x) => x.status).join(','));
    assert.strictEqual(await prisma.contentReport.count({ where: { reporterId: U.user2.id, targetId: tgt.id, status: 'OPEN' } }), 1);
  });
  const imgBuf2 = await sharp({ create: { width: 31, height: 31, channels: 3, background: { r: crypto.randomInt(256), g: 7, b: crypto.randomInt(256) } } }).png().toBuffer();
  const logo2 = await mediaStore.putBuffer(imgBuf2, { ownerUserId: U.owner.id });
  await prisma.tournamentEntry.updateMany({ where: { id: { in: [eA.id, eA2.id] } }, data: { logoUrl: logo2.url } });
  const rImg2 = await report(U.user2, { targetType: 'IMAGE', targetId: eA.id, context: { entity: 'entry', entityId: eA.id, field: 'logoUrl', url: logo2.url }, reason: 'IMPROPER' });
  const origBlock = mediaStore.block;
  await sabotage('ocultar imagem sem bloquear o MediaObject → /media continuaria abrindo',
    () => { mediaStore.block = async () => ({ ok: true, blocked: 0 }); },
    async () => {
      await adm('POST', `/api/liga/moderation/reports/${rImg2.json.report.id}/hide-image`, {});
      const mo = await prisma.mediaObject.findUnique({ where: { sha256: logo2.url.slice(7, 71) } });
      assert.ok(mo.blockedAt, 'bloqueado');
      assert.strictEqual((await call('GET', logo2.url)).status, 404);
    },
    () => { mediaStore.block = origBlock; });

  // ================================================================ j. app real
  console.log('  — j. app real (src/index.js)');
  // estado para a página: aviso oculto (post1) + aviso visível; T2 suspenso
  await prisma.tournamentPost.update({ where: { id: post1.id }, data: { hiddenAt: new Date() } });
  const post2 = await prisma.tournamentPost.create({ data: { tournamentId: T.id, body: 'Aviso normal F6 ' + RUN } });
  await prisma.tournament.update({ where: { id: T2.id }, data: { suspendedAt: new Date() } });
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
    await ok('/t/:slug: botão "Denunciar" no rodapé e no aviso; aviso oculto NÃO aparece; script denunciar.js', async () => {
      const r = await page('/t/' + T.slug);
      assert.strictEqual(r.status, 200);
      assert.ok(/data-testid="report-open"/.test(r.text) && /data-report="post" data-report-id="/.test(r.text) && /\/club\/denunciar\.js/.test(r.text));
      assert.ok(r.text.includes('Aviso normal F6') && !r.text.includes('Aviso suspeito F6'), 'aviso oculto fora da página');
      assert.strictEqual((await page('/club/denunciar.js')).status, 200);
    });
    await ok('/t/:slug de torneio SUSPENSO = o MESMO 404 de "não existe"', async () => {
      const a = await page('/t/' + T2.slug); const b = await page('/t/nao-existe-' + RUN);
      assert.strictEqual(a.status, 404); assert.strictEqual(a.text, b.text);
    });
    await ok('/atleta de quem apagou os dados = 404; páginas /moderacao e /privacidade-club servidas (mobile-first)', async () => {
      assert.strictEqual((await page('/atleta/' + U.ath.id)).status, 404);
      for (const p of ['/moderacao', '/privacidade-club']) {
        const r = await page(p);
        assert.strictEqual(r.status, 200, p);
        assert.ok(/width=device-width/.test(r.text) && /safe-area-inset-bottom/.test(r.text) && /max-width:480px/.test(r.text), p + ' mobile-first');
      }
    });
    await ok('/api/liga no app real: fila exige admin; denúncia exige login', async () => {
      assert.strictEqual((await page('/api/liga/moderation/queue')).status, 401);
      const r = await httpCall('POST', `http://127.0.0.1:${PORT}/api/liga/reports`, {}, { targetType: 'TOURNAMENT', targetId: T.id, reason: 'OTHER' });
      assert.strictEqual(r.status, 401);
    });
  }
  child.kill();
  void post2;
  server.close();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F6 — moderação e menores: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exit(failed ? 1 : 0);
  });
