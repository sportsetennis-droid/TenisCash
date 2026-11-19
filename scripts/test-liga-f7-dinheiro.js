'use strict';
// =====================================================================
// Liga Aberta — FASE 7 (dinheiro). npm run test:liga-f7
//
// Parte 1 (sem banco): schema F7 no lugar certo do ensureApexSchema (depois da F6, antes da
//   F3; nada no "Tournament"), regras validadas, tetos padrão (0 por conquista = nada paga
//   até o dono definir), planos sem preço, serviços sem WhatsApp/atendente.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. planos por tamanho: catálogo público sem preço, "Meu plano" com os planos e o link de
//      contato só https, troca de plano SÓ pelo admin global (papel × ação), registro
//      OrganizerPlanLog, limite muda de verdade, env/tabela sobrepõem, preço nunca gravado
//   b. orçamento de uniforme: papel × ação (anônimo, estranho, jogador, árbitro, treinador,
//      admin de OUTRO time, admin do time, coordenador, dono, admin), consentimento,
//      lead certo (source liga, status novo, escudo por /media, nunca base64, nome/telefone
//      só de quem pediu), sem duplicar (24 h, mesmo clube, corrida com 3 iguais), menor não
//      pede, filtro de texto, privado = 404, suspenso/arquivado, limitador 429, NENHUMA
//      mensagem enviada (WhatsAppOutbox, whatsapp.js e atendente da Meta Fardamentos)
//   c. TenisCash por conquista: papel × ação (ver/editar/pagar), cashEnabled só o admin liga,
//      desligado = não paga, teto por conquista e por torneio, idempotente (2º pagamento e
//      corrida com 3 iguais), menor/vaga de menor/conta desativada/time sem conta não recebem,
//      suspenso/arquivado/Master Cup não pagam, Transaction + auditoria, aviso só no sininho
//   d. medalha verificada: título (ouro) e participação (concluinte) assinadas pelo
//      organizador, credencial Open Badges 3.0 sem CPF (só o hash), reemissão não duplica
//   e. privacidade: export traz pedidos de uniforme e TenisCash por conquista; apagar tira
//      nome/telefone do lead
//   f. Master Cup intacto byte a byte
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

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
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f7-' + crypto.randomBytes(8).toString('hex');
  if (!process.env.RESEND_API_KEY) process.env.RESEND_API_KEY = 're_test_dummy';
  for (const k of ['LIGA_CASH_RULE_MAX', 'LIGA_CASH_TOURNAMENT_MAX', 'LIGA_PLANS_JSON', 'LIGA_PLAN_CONTACT_URL', 'LIGA_MINORS']) delete process.env[k];

  await ok('schema F7 no INÍCIO do ensureApexSchema: depois da F6, antes da F3; nada destrutivo; nada novo no "Tournament"', () => {
    const { STATEMENTS } = require('../src/services/ensureApexSchema');
    const idx = (rx) => STATEMENTS.findIndex((s) => rx.test(s));
    const f6last = idx(/MinorProfile_guardianUserId_idx/);
    const f3 = idx(/"gameRules"/);
    // colunas do MfLead: logo depois do bloco do clubId da F2 (o teste da F3 exige o 1º "clubId" lá) e antes da F1
    const mf = idx(/"MfLead" ADD COLUMN IF NOT EXISTS "crestUrl"/);
    assert.ok(mf === idx(/TournamentEntry_clubId_fkey/) + 1 && mf < idx(/ADD COLUMN IF NOT EXISTS "archivedAt"/), 'MfLead em ' + mf);
    for (const rx of [/CREATE TABLE IF NOT EXISTS "OrganizerPlanLog"/, /CREATE TABLE IF NOT EXISTS "TournamentCashConfig"/, /CREATE TABLE IF NOT EXISTS "TournamentCashAward"/, /TournamentCashAward_tournamentId_categoryId_rule_userId_key/]) {
      const i = idx(rx); assert.ok(i > f6last && i < f3, rx + ' em ' + i + ' (F6 até ' + f6last + ', F3 em ' + f3 + ')');
    }
    assert.ok(/to_regclass\('"MfLead"'\)/.test(STATEMENTS[idx(/"MfLead" ADD COLUMN/)]), 'MfLead com to_regclass');
    assert.ok(!STATEMENTS.some((s) => /"Tournament" ADD COLUMN IF NOT EXISTS "cashRules"/i.test(s)), 'coluna nova no Tournament derruba toda leitura na janela pós-deploy');
    const tModel = read('prisma/schema.prisma').match(/model Tournament \{[\s\S]*?\n\}/)[0];
    assert.ok(!/cashRules|TournamentCash/.test(tModel), 'regras de TenisCash ficam em tabela própria, não no Tournament');
    assert.ok(!STATEMENTS.some((s) => /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b/i.test(s)), 'nada destrutivo');
    const pr = read('prisma/schema.prisma');
    for (const m of ['OrganizerPlanLog', 'TournamentCashConfig', 'TournamentCashAward']) assert.ok(new RegExp('model ' + m + ' \\{').test(pr), m);
    assert.ok(/@@unique\(\[tournamentId, categoryId, rule, userId\]\)/.test(pr), 'chave única da conquista');
    assert.ok(/requestedByUserId String\?/.test(pr) && /consentAt\s+DateTime\?/.test(pr) && /athleteCount\s+Int\?/.test(pr), 'colunas do MfLead');
  });
  const cashRules = require('../src/services/ligaCashRules');
  await ok('regras: padrão 0; valor negativo/texto/conquista desconhecida = 400; tetos padrão (0 por conquista, teto do prêmio por torneio)', () => {
    assert.deepStrictEqual(cashRules.defaultRules(), { TITLE: { amount: 0 }, RUNNER_UP: { amount: 0 }, TOP_SCORER: { amount: 0 } });
    for (const bad of [{ TITLE: -1 }, { TITLE: 'abc' }, { MVP: 10 }, { TITLE: { amount: '' } }, [1], null]) {
      let err = null; try { cashRules.normalizeRules(bad); } catch (e) { err = e; }
      assert.ok(err && err.status === 400, JSON.stringify(bad));
    }
    assert.deepStrictEqual(cashRules.normalizeRules({ TITLE: { amount: 10.555 } }).TITLE, { amount: 10.56 });
    assert.deepStrictEqual(cashRules.caps(), { perRule: 0, perTournament: require('../src/services/tournamentCash').PRIZE_CASH_MAX });
  });
  await ok('serviços novos não importam WhatsApp, atendente da Meta Fardamentos nem e-mail', () => {
    for (const f of ['src/services/uniformQuote.js', 'src/services/ligaCashRules.js', 'src/routes/ligaPlans.js']) {
      const src = read(f);
      assert.ok(!/require\([^)]*(whatsapp|metaFardamentosAttendant|email|systemMessenger)[^)]*\)/i.test(src), f);
    }
    assert.ok(/whatsapp: false/.test(read('src/services/ligaCashRules.js')), 'aviso do crédito só no sininho');
  });
  await ok('planos por tamanho: sem preço no código (nada de priceCents/preço nos tiers)', () => {
    const plans = require('../src/services/organizerPlan');
    assert.deepStrictEqual(Object.keys(plans.PAID_TIERS), ['pequeno', 'medio', 'grande']);
    for (const t of Object.values(plans.PAID_TIERS)) assert.ok(!('priceCents' in t) && !('price' in t));
    const src = read('src/services/organizerPlan.js');
    assert.ok(!/priceCents\s*:\s*\d/.test(src), 'nenhum preço definido');
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('planos, uniforme, TenisCash, medalhas', 'DATABASE_URL local (localhost) não definido');
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
  const plans = require('../src/services/organizerPlan');
  const cashRules = require('../src/services/ligaCashRules');
  const uniform = require('../src/services/uniformQuote');
  const medals = require('../src/services/medals');
  const privacy = require('../src/services/ligaPrivacy');
  // Banco "como produção antes do deploy": sem as colunas novas do MfLead e sem as tabelas da F7
  // (o deploy não roda db push). O ensureApexSchema do boot tem que criar tudo do jeito que o
  // Prisma espera — o resto deste teste roda em cima do que ELE criou.
  await prisma.$executeRawUnsafe('ALTER TABLE "MfLead" DROP COLUMN IF EXISTS "crestUrl", DROP COLUMN IF EXISTS "colors", DROP COLUMN IF EXISTS "athleteCount", DROP COLUMN IF EXISTS "tournamentId", DROP COLUMN IF EXISTS "entryId", DROP COLUMN IF EXISTS "clubId", DROP COLUMN IF EXISTS "requestedByUserId", DROP COLUMN IF EXISTS "consentAt"');
  for (const tb of ['OrganizerPlanLog', 'TournamentCashConfig', 'TournamentCashAward']) await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tb}"`);
  await ensureApexSchema(prisma);
  await ok('boot (ensureApexSchema) recria as colunas do MfLead e as 3 tabelas da F7 num banco antigo', async () => {
    const cols = await prisma.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns WHERE table_name = 'MfLead'`);
    const names = cols.map((c) => c.column_name);
    for (const c of ['crestUrl', 'colors', 'athleteCount', 'tournamentId', 'entryId', 'clubId', 'requestedByUserId', 'consentAt']) assert.ok(names.includes(c), c);
    for (const tb of ['OrganizerPlanLog', 'TournamentCashConfig', 'TournamentCashAward']) assert.ok((await prisma.$queryRawUnsafe(`SELECT to_regclass('"${tb}"')::text AS r`))[0].r, tb);
    await prisma.mfLead.findFirst(); await prisma.tournamentCashAward.findFirst(); await prisma.organizerPlanLog.findFirst(); await prisma.tournamentCashConfig.findFirst();
  });

  // ---- espiões: NENHUMA mensagem pode sair (WhatsApp, atendente MF, Cloud API) ----
  const sent = [];
  const spyModule = (rel) => {
    let mod; try { mod = require(rel); } catch (_) { return; }
    for (const [k, v] of Object.entries(mod)) if (typeof v === 'function' && !/^(isEnabled|enabled|getMetaReply)$/.test(k)) mod[k] = (...a) => { sent.push(rel + '.' + k); return v(...a); };
  };
  spyModule('../src/whatsapp');
  spyModule('../src/services/metaFardamentosAttendant');
  const wc = require('../src/services/whatsappCloud');
  for (const k of ['sendText', 'sendNotification', 'sendTemplate']) if (typeof wc[k] === 'function') { const v = wc[k]; wc[k] = (...a) => { sent.push('whatsappCloud.' + k); return v(...a); }; }
  process.env.WA_BRIDGE_KEY = 'teste-f7-ponte'; // canal "ligado": se algo tentasse mandar, iria pra fila
  const outbox = async (ids) => prisma.whatsAppOutbox.count({ where: ids ? { userId: { in: ids } } : {} }).catch(() => 0);
  const OUTBOX0 = await outbox();

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  app.use(['/api/tournaments', '/api/public'], mediaStore.jsonMiddleware);
  app.get('/media/:file', mediaStore.serveMedia);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use('/api/liga', require('../src/routes/ligaSafety'));
  app.use('/api/liga', require('../src/routes/ligaPlans'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipSeq = 0;
  const call = (method, url, { token, body } = {}) => {
    const h = { 'cf-connecting-ip': `198.51.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}` };
    if (token) h.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, h, body);
  };

  const RUN = Date.now().toString(36);
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  let cpfSeq = 0;
  const cpfBase = String(Date.now() % 1000000).padStart(6, '0');
  const cpfOf = () => cpfBase + String(++cpfSeq).padStart(5, '0');
  const mkUser = (label, extra = {}) => { ++seq; return prisma.user.create({ data: { name: `F7 ${label} ${RUN}-${seq}`, phone: '837' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } }); };
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const U = {};
  for (const k of ['owner', 'coord', 'teamAdmin', 'teamAdminB', 'coach', 'referee', 'player', 'stranger', 'rl', 'c1']) U[k] = await mkUser(k);
  U.admin = await mkUser('admin', { role: 'admin' });
  U.a1 = await mkUser('artilheiro', { cpf: cpfOf(), username: 'f7a1' + RUN });
  U.a2 = await mkUser('atleta2', { cpf: cpfOf() });
  U.b1 = await mkUser('vice', { cpf: cpfOf() });
  U.c1 = await prisma.user.update({ where: { id: U.c1.id }, data: { cpf: cpfOf() } });
  U.minorAcct = await mkUser('conta de menor', { birthDate: '2012-03-01', cpf: cpfOf() });
  U.inactive = await mkUser('desativada', { active: false });
  U.minorAdmin = await mkUser('admin menor', { birthDate: '2011-05-05' });
  const T_ = (u) => tok(u);
  const balance = async (u) => (await prisma.user.findUnique({ where: { id: u.id }, select: { balance: true } })).balance;
  const txCount = async () => prisma.transaction.count({ where: { type: 'tournament_award' } });
  const leadCount = async () => prisma.mfLead.count({ where: { source: 'liga' } });

  // ---------------------------------------------------------------- dados
  const crestBuf = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: crypto.randomInt(256), g: 80, b: 160 } } }).png().toBuffer();
  const crest = await mediaStore.putBuffer(crestBuf, { ownerUserId: U.owner.id });
  const T = await prisma.tournament.create({ data: { slug: 'f7-copa-' + RUN, name: 'Copa F7 ' + RUN, sport: 'FUTSAL', format: 'KNOCKOUT', ownerId: U.owner.id, status: 'ONGOING', visibility: 'public', city: 'João Pessoa', state: 'PB' } });
  await prisma.tournamentRole.createMany({ data: [{ tournamentId: T.id, userId: U.coord.id, role: 'COORDINATOR' }, { tournamentId: T.id, userId: U.referee.id, role: 'REFEREE' }] });
  const club = await prisma.club.create({ data: { name: 'Leões F7 ' + RUN, slug: 'f7-leoes-' + RUN, ownerId: U.owner.id, crestUrl: crest.url, primaryColor: '#123456', secondaryColor: '#FFFFFF', originTournamentId: T.id } });
  const cat1 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Livre' } });
  const cat2 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Master' } });
  const cat3 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Sub-sem-conta' } });
  const eA = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat1.id, name: 'Leões F7 ' + RUN, status: 'CONFIRMED', clubId: club.id } });
  const eA2 = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat2.id, name: 'Leões F7 ' + RUN, status: 'CONFIRMED', clubId: club.id } });
  const eB = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat1.id, name: 'Tubarões F7 ' + RUN, status: 'CONFIRMED' } });
  const eC = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat1.id, name: 'Corujas F7 ' + RUN, status: 'CONFIRMED' } });
  const eD = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat2.id, name: 'Garças F7 ' + RUN, status: 'CONFIRMED' } });
  const eX = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat3.id, name: 'Sem Conta A ' + RUN, status: 'CONFIRMED' } });
  const eY = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat3.id, name: 'Sem Conta B ' + RUN, status: 'CONFIRMED' } });
  await prisma.tournamentRole.createMany({ data: [
    { tournamentId: T.id, userId: U.teamAdmin.id, role: 'TEAM_ADMIN', entryId: eA.id }, { tournamentId: T.id, userId: U.teamAdmin.id, role: 'TEAM_ADMIN', entryId: eA2.id },
    { tournamentId: T.id, userId: U.teamAdminB.id, role: 'TEAM_ADMIN', entryId: eB.id }, { tournamentId: T.id, userId: U.coach.id, role: 'COACH', entryId: eA.id },
    { tournamentId: T.id, userId: U.player.id, role: 'PLAYER', entryId: eA.id }, { tournamentId: T.id, userId: U.minorAdmin.id, role: 'TEAM_ADMIN', entryId: eC.id },
  ] });
  const pA1 = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Artilheiro', number: 9, userId: U.a1.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Atleta 2', number: 10, userId: U.a2.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Conta de menor', number: 11, userId: U.minorAcct.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Desativado', number: 12, userId: U.inactive.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Atleta (menor)', number: 13, minorProfileId: 'mp-f7-' + RUN } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Técnico', role: 'COACH', userId: U.coach.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Sem conta', number: 14 } });
  const pB1 = await prisma.rosterPlayer.create({ data: { entryId: eB.id, name: 'Vice', number: 7, userId: U.b1.id } });
  await prisma.rosterPlayer.create({ data: { entryId: eC.id, name: 'Coruja', number: 5, userId: U.c1.id } });
  const fin1 = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat1.id, stage: 'FINAL', round: 1, homeEntryId: eA.id, awayEntryId: eB.id, status: 'FINISHED', homeScore: 2, awayScore: 1, winnerEntryId: eA.id, scheduledAt: new Date() } });
  await prisma.matchEvent.createMany({ data: [{ matchId: fin1.id, entryId: eA.id, playerId: pA1.id, type: 'GOAL' }, { matchId: fin1.id, entryId: eA.id, playerId: pA1.id, type: 'GOAL' }, { matchId: fin1.id, entryId: eB.id, playerId: pB1.id, type: 'GOAL' }] });
  // categoria 2: final AINDA não jogada
  await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat2.id, stage: 'FINAL', round: 1, homeEntryId: eA2.id, awayEntryId: eD.id, status: 'SCHEDULED', scheduledAt: new Date() } });
  // categoria 3: final encerrada, times SEM conta
  await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat3.id, stage: 'FINAL', round: 1, homeEntryId: eX.id, awayEntryId: eY.id, status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: eX.id, scheduledAt: new Date() } });

  const P = await prisma.tournament.create({ data: { slug: 'f7-priv-' + RUN, name: 'Privado F7', sport: 'FUTSAL', ownerId: U.owner.id, status: 'ONGOING', visibility: 'private' } });
  const pCat = await prisma.tournamentCategory.create({ data: { tournamentId: P.id, name: 'Livre' } });
  const pE = await prisma.tournamentEntry.create({ data: { tournamentId: P.id, categoryId: pCat.id, name: 'Time Privado ' + RUN, status: 'CONFIRMED' } });

  // Master Cup (lista de exclusão) — dinheiro ligado e final encerrada, para provar que não paga
  const mcFound = await prisma.tournament.findUnique({ where: { slug: 'futsal-master-cup-2026' } });
  const MC = mcFound || await prisma.tournament.create({ data: { slug: 'futsal-master-cup-2026', name: 'II Futsal Master Cup 2026', sport: 'FUTSAL', format: 'GROUPS_KNOCKOUT', ownerId: U.owner.id, status: 'ONGOING', visibility: 'public', cashEnabled: true } });
  if (!mcFound) {
    const mcc = await prisma.tournamentCategory.create({ data: { tournamentId: MC.id, name: '40+' } });
    const m1 = await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcc.id, name: 'Cabo Branco - PB', status: 'CONFIRMED', logoUrl: 'data:image/png;base64,' + crestBuf.toString('base64') } });
    const m2 = await prisma.tournamentEntry.create({ data: { tournamentId: MC.id, categoryId: mcc.id, name: 'Unipê', status: 'CONFIRMED' } });
    await prisma.rosterPlayer.create({ data: { entryId: m1.id, name: 'Craque MC', number: 10, userId: U.a2.id } });
    await prisma.tournamentMatch.create({ data: { tournamentId: MC.id, categoryId: mcc.id, stage: 'FINAL', round: 1, homeEntryId: m1.id, awayEntryId: m2.id, status: 'FINISHED', homeScore: 3, awayScore: 1, winnerEntryId: m1.id } });
  }
  const mcSnap = async () => JSON.stringify([
    await prisma.tournament.findUnique({ where: { id: MC.id }, include: { categories: true, entries: { orderBy: { id: 'asc' } }, matches: { orderBy: { id: 'asc' } } } }),
    await prisma.rosterPlayer.findMany({ where: { entryId: { in: (await prisma.tournamentEntry.findMany({ where: { tournamentId: MC.id }, select: { id: true } })).map((e) => e.id) } }, orderBy: { id: 'asc' } }),
    await prisma.tournamentAudit.count({ where: { tournamentId: MC.id } }),
    await prisma.tournamentCashAward.count({ where: { tournamentId: MC.id } }),
    await prisma.mfLead.count({ where: { tournamentId: MC.id } }),
  ]);
  const MC_BEFORE = await mcSnap();

  // ================================================================ a. planos
  console.log('  — a. planos por tamanho (sem preço)');
  await ok('GET /api/liga/plans (público): Grátis + Pequeno/Médio/Grande com limites e NENHUM preço', async () => {
    const r = await call('GET', '/api/liga/plans');
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.plans.map((p) => p.key), ['free', 'pequeno', 'medio', 'grande']);
    assert.ok(!/price|preço|R\$/i.test(JSON.stringify(r.json.plans)), 'preço apareceu');
    assert.strictEqual(r.json.contactUrl, null);
  });
  await ok('Meu plano: catálogo com o plano atual marcado; link de contato só https (javascript: = nulo)', async () => {
    let r = await call('GET', '/api/tournaments/me/plan', { token: T_(U.owner) });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.catalog.find((p) => p.key === 'free').current && r.json.catalog.length === 4);
    assert.strictEqual(r.json.plan.priceCents, null);
    process.env.LIGA_PLAN_CONTACT_URL = 'javascript:alert(1)';
    r = await call('GET', '/api/tournaments/me/plan', { token: T_(U.owner) }); assert.strictEqual(r.json.contactUrl, null);
    process.env.LIGA_PLAN_CONTACT_URL = 'https://example.com/ampliar';
    r = await call('GET', '/api/tournaments/me/plan', { token: T_(U.owner) }); assert.strictEqual(r.json.contactUrl, 'https://example.com/ampliar');
    delete process.env.LIGA_PLAN_CONTACT_URL;
  });
  const assign = (u, body) => call('POST', '/api/liga/admin/organizer-plan', { token: u ? T_(u) : null, body });
  await ok('trocar plano: anônimo 401; usuário, dono, coordenador, admin do time 403 (can PLAN_ADMIN só admin global)', async () => {
    assert.strictEqual((await assign(null, { userId: U.owner.id, planKey: 'medio' })).status, 401);
    for (const u of [U.stranger, U.owner, U.coord, U.teamAdmin]) assert.strictEqual((await assign(u, { userId: U.owner.id, planKey: 'medio' })).status, 403, u.name);
    assert.strictEqual(await roles.can(U.owner.id, 'user', null, 'PLAN_ADMIN'), false);
    assert.strictEqual(await roles.can(U.admin.id, 'admin', null, 'PLAN_ADMIN'), true);
    assert.strictEqual(await prisma.organizerSubscription.count({ where: { userId: U.owner.id } }), 0);
    const g = await call('GET', '/api/liga/admin/organizer-plan?userId=' + U.owner.id, { token: T_(U.coord) });
    assert.strictEqual(g.status, 403);
  });
  await ok('admin troca o plano (por @ e por telefone): registro OrganizerPlanLog, limite muda de verdade, voltar pro grátis apaga a assinatura', async () => {
    process.env.LIGA_PLAN_START = '2020-01-01T00:00:00Z';
    process.env.LIGA_FREE_ACTIVE_TOURNAMENTS = '2';
    const org = await mkUser('organizador plano', { username: 'f7org' + RUN });
    for (let i = 0; i < 2; i++) await prisma.tournament.create({ data: { slug: 'f7-org-' + RUN + '-' + i, name: 'Liga ' + i, sport: 'FUTSAL', ownerId: org.id, status: 'ONGOING' } });
    let r = await call('POST', '/api/tournaments', { token: T_(org), body: { name: 'Terceira liga F7', sport: 'FUTSAL' } });
    assert.strictEqual(r.status, 402, r.text); assert.ok(/plano grátis/.test(r.json.error));
    r = await assign(U.admin, { username: '@f7org' + RUN, planKey: 'pequeno', note: 'liga com 3 divisões' });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.from, 'free'); assert.strictEqual(r.json.plan.key, 'pequeno');
    const log = await prisma.organizerPlanLog.findMany({ where: { userId: org.id } });
    assert.strictEqual(log.length, 1); assert.strictEqual(log[0].actorId, U.admin.id); assert.strictEqual(log[0].toPlan, 'pequeno'); assert.strictEqual(log[0].note, 'liga com 3 divisões');
    r = await call('POST', '/api/tournaments', { token: T_(org), body: { name: 'Terceira liga F7', sport: 'FUTSAL' } });
    assert.strictEqual(r.status, 201, 'plano pequeno libera: ' + r.text);
    assert.strictEqual((await plans.planFor(org.id)).limits.teamsPerCategory, 96);
    r = await assign(U.admin, { phone: org.phone, planKey: 'pequeno' });
    assert.ok(r.json.unchanged, 'mesmo plano não registra de novo'); assert.strictEqual(await prisma.organizerPlanLog.count({ where: { userId: org.id } }), 1);
    r = await assign(U.admin, { userId: org.id, planKey: 'free' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await prisma.organizerSubscription.count({ where: { userId: org.id } }), 0);
    assert.strictEqual((await call('GET', '/api/liga/admin/organizer-plan?phone=' + org.phone, { token: T_(U.admin) })).status, 404, 'telefone na URL não é aceito');
    const g = await call('GET', '/api/liga/admin/organizer-plan?username=f7org' + RUN, { token: T_(U.admin) });
    assert.strictEqual(g.status, 200, g.text); assert.strictEqual(g.json.log.length, 2); assert.strictEqual(g.json.plan.key, 'free');
    delete process.env.LIGA_FREE_ACTIVE_TOURNAMENTS;
  });
  await ok('plano inexistente/desativado = 400; organizador inexistente = 404; env LIGA_PLANS_JSON e linha da tabela sobrepõem (tabela vence); preço nunca gravado', async () => {
    assert.strictEqual((await assign(U.admin, { userId: U.owner.id, planKey: 'ouro' })).status, 400);
    assert.strictEqual((await assign(U.admin, { userId: 'nao-existe', planKey: 'medio' })).status, 404);
    process.env.LIGA_PLANS_JSON = JSON.stringify({ medio: { name: 'Médio PB', limits: { teamsPerCategory: 150 } } });
    let m = (await plans.catalog()).find((p) => p.key === 'medio');
    assert.strictEqual(m.name, 'Médio PB'); assert.strictEqual(m.limits.teamsPerCategory, 150);
    await prisma.organizerPlan.upsert({ where: { key: 'medio' }, create: { key: 'medio', name: 'Médio (tabela)', limits: { teamsPerCategory: 160 } }, update: { name: 'Médio (tabela)', limits: { teamsPerCategory: 160 }, active: true } });
    m = (await plans.catalog()).find((p) => p.key === 'medio');
    assert.strictEqual(m.name, 'Médio (tabela)'); assert.strictEqual(m.limits.teamsPerCategory, 160);
    await prisma.organizerPlan.update({ where: { key: 'medio' }, data: { active: false } });
    assert.strictEqual((await assign(U.admin, { userId: U.owner.id, planKey: 'medio' })).status, 400, 'desativado');
    await prisma.organizerPlan.delete({ where: { key: 'medio' } });
    delete process.env.LIGA_PLANS_JSON;
    assert.strictEqual(await prisma.organizerPlan.count({ where: { priceCents: { not: null } } }), 0);
  });

  // ================================================================ b. uniforme
  console.log('  — b. orçamento de uniforme (Meta Fardamentos)');
  const uq = (u, eid, body) => call('POST', `/api/tournaments/entries/${eid}/uniform-quote`, { token: u ? T_(u) : null, body });
  await ok('papel × ação: anônimo 401; estranho, jogador, árbitro, treinador e admin de OUTRO time 403 — nenhum lead', async () => {
    const before = await leadCount();
    assert.strictEqual((await uq(null, eA.id, { consent: true })).status, 401);
    for (const u of [U.stranger, U.player, U.referee, U.coach, U.teamAdminB]) assert.strictEqual((await uq(u, eA.id, { consent: true })).status, 403, u.name);
    assert.strictEqual((await call('GET', `/api/tournaments/entries/${eA.id}/uniform-quote`, { token: T_(U.stranger) })).status, 403);
    assert.strictEqual(await leadCount(), before);
  });
  await ok('sem o consentimento "autorizo a Meta Fardamentos a me contatar" = 400 e nada gravado', async () => {
    const before = await leadCount();
    for (const body of [{}, { consent: 'sim' }, { consent: false }]) { const r = await uq(U.teamAdmin, eA.id, body); assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'CONSENT_REQUIRED'); }
    assert.strictEqual(await leadCount(), before);
  });
  let lead1 = null;
  await ok('admin do time pede: lead source "liga", status "novo", escudo por /media, cores do clube, nº de atletas do elenco, nome/telefone SÓ de quem pediu, sem base64', async () => {
    const st = await call('GET', `/api/tournaments/entries/${eA.id}/uniform-quote`, { token: T_(U.teamAdmin) });
    assert.strictEqual(st.status, 200, st.text); assert.strictEqual(st.json.team.crestUrl, crest.url); assert.strictEqual(st.json.team.colors, '#123456 / #FFFFFF');
    assert.ok(!st.json.contact.phoneMasked.includes(U.teamAdmin.phone), 'telefone mascarado');
    const r = await uq(U.teamAdmin, eA.id, { consent: true, note: 'camisa e calção' });
    assert.strictEqual(r.status, 201, r.text); assert.strictEqual(r.json.duplicate, false);
    lead1 = await prisma.mfLead.findUnique({ where: { id: r.json.lead.id } });
    assert.strictEqual(lead1.source, 'liga'); assert.strictEqual(lead1.status, 'novo');
    assert.strictEqual(lead1.crestUrl, crest.url); assert.strictEqual(lead1.colors, '#123456 / #FFFFFF');
    assert.strictEqual(lead1.athleteCount, 6, 'jogadores (sem técnico) do elenco'); assert.strictEqual(lead1.quantidade, '6');
    assert.strictEqual(lead1.name, U.teamAdmin.name); assert.strictEqual(lead1.phone, U.teamAdmin.phone);
    assert.strictEqual(lead1.requestedByUserId, U.teamAdmin.id); assert.ok(lead1.consentAt);
    assert.strictEqual(lead1.tournamentId, T.id); assert.strictEqual(lead1.entryId, eA.id); assert.strictEqual(lead1.clubId, club.id);
    const all = JSON.stringify(lead1);
    assert.ok(!/data:image|base64/i.test(all), 'base64 no lead');
    assert.ok(lead1.resumo.includes(T.name) && lead1.resumo.includes(club.name) && /Atletas: 6/.test(lead1.resumo) && lead1.resumo.includes(crest.url));
    assert.ok(!lead1.resumo.includes(U.teamAdmin.phone), 'telefone fora do resumo');
    const au = await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'uniform.quote' } });
    assert.ok(au && au.entityId === lead1.id);
  });
  await ok('SEM DUPLICAR: mesma pessoa + mesmo clube em 24 h (inclusive pela outra categoria do clube) devolve o pedido existente', async () => {
    const before = await leadCount();
    let r = await uq(U.teamAdmin, eA.id, { consent: true, athleteCount: 20 });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.duplicate, true); assert.strictEqual(r.json.lead.id, lead1.id);
    r = await uq(U.teamAdmin, eA2.id, { consent: true, athleteCount: 12 });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.duplicate, true, 'outra categoria do mesmo clube');
    assert.strictEqual(await leadCount(), before);
    const st = await call('GET', `/api/tournaments/entries/${eA.id}/uniform-quote`, { token: T_(U.teamAdmin) });
    assert.strictEqual(st.json.recent.id, lead1.id);
  });
  await ok('coordenador, dono e admin global também pedem (pedido de cada pessoa); 3 toques ao MESMO tempo = 1 pedido', async () => {
    assert.strictEqual((await uq(U.coord, eA.id, { consent: true, colors: 'Azul e branco', athleteCount: 15 })).status, 201);
    assert.strictEqual((await uq(U.admin, eA.id, { consent: true })).status, 201);
    const before = await leadCount();
    const rs = await Promise.all([1, 2, 3].map(() => uq(U.owner, eB.id, { consent: true, athleteCount: 9 })));
    assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 200, 201]);
    assert.strictEqual(await leadCount(), before + 1);
    const l = await prisma.mfLead.findFirst({ where: { requestedByUserId: U.owner.id, entryId: eB.id } });
    assert.strictEqual(l.clubId, null); assert.strictEqual(l.colors, null); assert.strictEqual(l.athleteCount, 9);
  });
  await ok('escudo antigo em data URI (sem clube) vai pro lead como /media — nunca base64', async () => {
    await prisma.tournamentEntry.update({ where: { id: eD.id }, data: { logoUrl: 'data:image/png;base64,' + crestBuf.toString('base64') } });
    const r = await uq(U.coord, eD.id, { consent: true, athleteCount: 11 });
    assert.strictEqual(r.status, 201, r.text);
    const l = await prisma.mfLead.findUnique({ where: { id: r.json.lead.id } });
    assert.ok(/^\/media\/[0-9a-f]{64}\.png$/.test(l.crestUrl), l.crestUrl);
    assert.ok(!/data:image/.test(JSON.stringify(l)));
  });
  await ok('número de atletas inválido = 400; texto ofensivo nas cores = 400 sem repetir a palavra', async () => {
    for (const n of [0, -3, 9999, 'abc']) assert.strictEqual((await uq(U.teamAdminB, eB.id, { consent: true, athleteCount: n })).status, 400, String(n));
    const r = await uq(U.teamAdminB, eB.id, { consent: true, colors: 'Time do Caralho' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.json.code, 'CONTENT_BLOCKED'); assert.ok(!/caralho/i.test(r.json.error));
  });
  await ok('conta que declara menor de 18 não pede (403) e nada é gravado', async () => {
    const before = await leadCount();
    const r = await uq(U.minorAdmin, eC.id, { consent: true, athleteCount: 10 });
    assert.strictEqual(r.status, 403, r.text); assert.strictEqual(r.json.code, 'MINOR');
    assert.strictEqual(await leadCount(), before);
  });
  await ok('torneio PRIVADO: quem não é membro recebe o MESMO 404 de "não existe"; o dono pede', async () => {
    const a = await uq(U.stranger, pE.id, { consent: true, athleteCount: 5 });
    const b = await uq(U.stranger, 'nao-existe-' + RUN, { consent: true, athleteCount: 5 });
    assert.strictEqual(a.status, 404); assert.strictEqual(b.status, 404); assert.strictEqual(a.text, b.text);
    assert.strictEqual((await uq(U.owner, pE.id, { consent: true, athleteCount: 5 })).status, 201);
  });
  await ok('limitador: o 11º pedido na hora → 429 em PT', async () => {
    await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: U.rl.id, role: 'COORDINATOR' } });
    let last = null;
    for (let i = 0; i < 11; i++) last = await uq(U.rl, eA.id, { consent: true });
    assert.strictEqual(last.status, 429); assert.ok(/orçamento de uniforme/.test(last.json.error));
  });
  await ok('painel da Meta Fardamentos mostra o pedido da Liga (resumo + escudo escapado)', async () => {
    const html = read('public/metafardamentos.html');
    assert.ok(/l\.source==='liga'/.test(html) && /H\(l\.resumo/.test(html) && /H\(l\.crestUrl\)/.test(html));
    const crie = read('public/criar-liga.html');
    assert.ok(/data-testid="uni-offer"/.test(crie), 'oferta de uniforme ao criar a liga');
  });
  await ok('NENHUMA mensagem enviada: WhatsAppOutbox igual, whatsapp.js/Cloud API/atendente MF não chamados', async () => {
    assert.strictEqual(await outbox(), OUTBOX0);
    assert.deepStrictEqual(sent, []);
  });

  // ================================================================ c. TenisCash por conquista
  console.log('  — c. TenisCash por conquista');
  const cr = (u, tid = T.id) => call('GET', `/api/tournaments/${tid}/cash-rules`, { token: u ? T_(u) : null });
  const save = (u, rules, tid = T.id) => call('PUT', `/api/tournaments/${tid}/cash-rules`, { token: u ? T_(u) : null, body: { rules } });
  const pay = (u, body = { confirm: true }, tid = T.id) => call('POST', `/api/tournaments/${tid}/cash-rules/pay`, { token: u ? T_(u) : null, body });
  await ok('ver regras: anônimo 401; estranho/jogador/árbitro/treinador/admin do time 403; coordenador, dono e admin 200 (padrão 0, desligado)', async () => {
    assert.strictEqual((await cr(null)).status, 401);
    for (const u of [U.stranger, U.player, U.referee, U.coach, U.teamAdmin]) assert.strictEqual((await cr(u)).status, 403, u.name);
    for (const u of [U.coord, U.owner, U.admin]) {
      const r = await cr(u); assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.cashEnabled, false); assert.strictEqual(r.json.rules.TITLE.amount, 0); assert.strictEqual(r.json.canPay, false);
    }
    assert.strictEqual((await cr(U.coord)).json.canEdit, false, 'coordenador não mexe em dinheiro');
    assert.strictEqual((await cr(U.owner)).json.canEdit, true);
  });
  await ok('editar rascunho: só o fundador/admin (coordenador e admin do time 403); inválido 400; auditoria cash.rules', async () => {
    const rules = { TITLE: { amount: 100 }, RUNNER_UP: { amount: 50 }, TOP_SCORER: { amount: 30 } };
    assert.strictEqual((await save(U.coord, rules)).status, 403);
    assert.strictEqual((await save(U.teamAdmin, rules)).status, 403);
    assert.strictEqual((await save(U.owner, { TITLE: -5 })).status, 400);
    assert.strictEqual((await save(U.owner, { MVP: 5 })).status, 400);
    const r = await save(U.owner, rules);
    assert.strictEqual(r.status, 200, r.text); assert.ok(r.json.warnings.length === 3, 'avisa que está acima do teto (0)');
    assert.deepStrictEqual(await cashRules.getRules(T.id), rules);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'cash.rules' } }));
  });
  await ok('cashEnabled: o organizador NÃO liga (403); só o admin global', async () => {
    const r = await call('PATCH', `/api/tournaments/${T.id}`, { token: T_(U.owner), body: { cashEnabled: true } });
    assert.strictEqual(r.status, 403);
    assert.strictEqual((await prisma.tournament.findUnique({ where: { id: T.id } })).cashEnabled, false);
  });
  await ok('cashEnabled=false NÃO paga (409) — nem com confirm, nem pelo admin; zero Transaction, saldos iguais', async () => {
    const b0 = await balance(U.a1); const t0 = await txCount();
    for (const u of [U.owner, U.admin]) { const r = await pay(u); assert.strictEqual(r.status, 409, r.text); assert.strictEqual(r.json.code, 'CASH_BLOCKED'); }
    assert.strictEqual(await balance(U.a1), b0); assert.strictEqual(await txCount(), t0);
    assert.strictEqual(await prisma.tournamentCashAward.count({ where: { tournamentId: T.id } }), 0);
  });
  await ok('admin liga o TenisCash; teto por conquista padrão 0 → 409 RULE_CAP e nada pago; pagar sem confirm → 400', async () => {
    const r = await call('PATCH', `/api/tournaments/${T.id}`, { token: T_(U.admin), body: { cashEnabled: true } });
    assert.strictEqual(r.status, 200, r.text);
    let p = await pay(U.owner); assert.strictEqual(p.status, 409); assert.strictEqual(p.json.code, 'RULE_CAP');
    process.env.LIGA_CASH_RULE_MAX = '100';
    p = await pay(U.owner, {}); assert.strictEqual(p.status, 400); assert.strictEqual(p.json.code, 'CONFIRM_REQUIRED');
    assert.strictEqual(await txCount(), 0);
  });
  await ok('com TenisCash ligado as regras TRAVAM: fundador 409 LOCKED; admin global muda', async () => {
    const r = await save(U.owner, { TITLE: { amount: 99 } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.json.code, 'LOCKED');
    assert.strictEqual((await cr(U.owner)).json.locked, true);
    assert.strictEqual((await save(U.admin, { TITLE: { amount: 100 }, RUNNER_UP: { amount: 50 }, TOP_SCORER: { amount: 30 } })).status, 200);
  });
  // o artilheiro LIGOU "resultado" no WhatsApp: mesmo assim o crédito só vai pro sininho
  await prisma.clubNotifyPref.upsert({ where: { userId: U.a1.id }, create: { userId: U.a1.id, whatsapp: { result: true } }, update: { whatsapp: { result: true } } });
  let firstPay = null;
  await ok('pagar: coordenador 403; fundador paga título/vice/artilharia SÓ a atleta com conta, adulto e ativo', async () => {
    assert.strictEqual((await pay(U.coord)).status, 403);
    assert.strictEqual((await pay(U.teamAdmin)).status, 403);
    const before = { a1: await balance(U.a1), a2: await balance(U.a2), b1: await balance(U.b1), minor: await balance(U.minorAcct), inactive: await balance(U.inactive), coach: await balance(U.coach) };
    const r = await pay(U.owner);
    assert.strictEqual(r.status, 200, r.text);
    firstPay = r.json;
    assert.strictEqual(await balance(U.a1), before.a1 + 130, 'título + artilharia');
    assert.strictEqual(await balance(U.a2), before.a2 + 100);
    assert.strictEqual(await balance(U.b1), before.b1 + 50, 'vice');
    assert.strictEqual(await balance(U.minorAcct), before.minor, 'conta de menor não recebe');
    assert.strictEqual(await balance(U.inactive), before.inactive, 'conta desativada não recebe');
    assert.strictEqual(await balance(U.coach), before.coach, 'técnico não recebe título de jogador');
    assert.strictEqual(r.json.total, 280); assert.strictEqual(r.json.paid.length, 4);
    const reasons = JSON.stringify(r.json.skipped);
    assert.ok(/menor de 18/.test(reasons) && /desativada/.test(reasons) && /sem atleta com conta/.test(reasons) && /sem campeão definido/.test(reasons), reasons);
    const txs = await prisma.transaction.findMany({ where: { type: 'tournament_award' } });
    assert.strictEqual(txs.length, 4);
    const awards = await prisma.tournamentCashAward.findMany({ where: { tournamentId: T.id } });
    assert.strictEqual(awards.length, 4); assert.ok(awards.every((a) => a.transactionId && txs.some((t) => t.id === a.transactionId)));
    const a1tx = txs.filter((t) => t.receiverId === U.a1.id);
    assert.ok(a1tx.every((t) => JSON.parse(t.metadata).tournamentId === T.id && t.balanceAfter > 0));
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T.id, action: 'cash.award' } }));
    const n = await prisma.appNotification.count({ where: { userId: U.a1.id, title: 'TenisCash recebido' } });
    assert.strictEqual(n, 2, 'aviso no sininho');
  });
  await ok('aviso do crédito NÃO vai pro WhatsApp mesmo com o atleta tendo ligado "resultado" no WhatsApp', async () => {
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(await outbox([U.a1.id, U.a2.id, U.b1.id]), 0);
    assert.deepStrictEqual(sent, []);
  });
  await ok('IDEMPOTENTE: pagar de novo não paga nada; mudar o valor depois não paga a diferença', async () => {
    const b = await balance(U.a1); const t0 = await txCount();
    await save(U.admin, { TITLE: { amount: 100 }, RUNNER_UP: { amount: 50 }, TOP_SCORER: { amount: 60 } });
    const r = await pay(U.owner);
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.paid.length, 0);
    assert.ok(/já pago/.test(JSON.stringify(r.json.skipped)));
    assert.strictEqual(await balance(U.a1), b); assert.strictEqual(await txCount(), t0);
    await save(U.admin, { TITLE: { amount: 100 }, RUNNER_UP: { amount: 50 }, TOP_SCORER: { amount: 30 } });
  });
  await ok('CORRIDA: categoria 2 encerra e 3 pagamentos ao mesmo tempo creditam UMA vez', async () => {
    await prisma.tournamentMatch.updateMany({ where: { categoryId: cat2.id, stage: 'FINAL' }, data: { status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: eA2.id } });
    await prisma.rosterPlayer.create({ data: { entryId: eA2.id, name: 'Artilheiro Master', number: 9, userId: U.a2.id } });
    const b = await balance(U.a2); const t0 = await txCount();
    const rs = await Promise.all([1, 2, 3].map(() => pay(U.owner)));
    assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status + r.text).join(' | '));
    assert.strictEqual(rs.reduce((s, r) => s + r.json.paid.length, 0), 1);
    assert.strictEqual(await balance(U.a2), b + 100); assert.strictEqual(await txCount(), t0 + 1);
  });
  await ok('TETO TOTAL do torneio: acima dele → 409 TOURNAMENT_CAP e nada pago (soma o que já foi pago)', async () => {
    const cat4 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Extra' } });
    const e1 = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat4.id, name: 'Extra 1 ' + RUN, status: 'CONFIRMED' } });
    const e2 = await prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: cat4.id, name: 'Extra 2 ' + RUN, status: 'CONFIRMED' } });
    await prisma.rosterPlayer.create({ data: { entryId: e1.id, name: 'X1', number: 1, userId: U.c1.id } });
    await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: cat4.id, stage: 'FINAL', round: 1, homeEntryId: e1.id, awayEntryId: e2.id, status: 'FINISHED', homeScore: 2, awayScore: 0, winnerEntryId: e1.id } });
    process.env.LIGA_CASH_TOURNAMENT_MAX = '400'; // já pago 380; título de 100 passaria
    const b = await balance(U.c1); const t0 = await txCount();
    const r = await pay(U.owner);
    assert.strictEqual(r.status, 409, r.text); assert.strictEqual(r.json.code, 'TOURNAMENT_CAP'); assert.strictEqual(r.json.already, 380);
    assert.strictEqual(await balance(U.c1), b); assert.strictEqual(await txCount(), t0);
    delete process.env.LIGA_CASH_TOURNAMENT_MAX;
    const ok2 = await pay(U.owner, { confirm: true, categoryId: cat4.id });
    assert.strictEqual(ok2.status, 200); assert.strictEqual(ok2.json.paid.length, 1); assert.strictEqual(await balance(U.c1), b + 100);
  });
  await ok('RESULTADO MUDOU depois do pagamento: a mesma conquista NÃO é paga de novo a outro time (fica para o admin)', async () => {
    await prisma.tournamentMatch.update({ where: { id: fin1.id }, data: { homeScore: 1, awayScore: 2, winnerEntryId: eB.id } });
    const b = await balance(U.b1); const a = await balance(U.a1); const t0 = await txCount();
    const r = await pay(U.owner, { confirm: true, categoryId: cat1.id });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.paid.length, 0);
    assert.ok(/resultado mudou/.test(JSON.stringify(r.json.skipped)), JSON.stringify(r.json.skipped));
    assert.strictEqual(await balance(U.b1), b); assert.strictEqual(await balance(U.a1), a); assert.strictEqual(await txCount(), t0);
    await prisma.tournamentMatch.update({ where: { id: fin1.id }, data: { homeScore: 2, awayScore: 1, winnerEntryId: eA.id } });
  });
  await ok('categoria com jogo pendente (3º lugar) não paga; a ORGANIZAÇÃO (coordenador no elenco) não recebe', async () => {
    const c5 = await prisma.tournamentCategory.create({ data: { tournamentId: T.id, name: 'Quinta' } });
    const mk5 = (n) => prisma.tournamentEntry.create({ data: { tournamentId: T.id, categoryId: c5.id, name: n + ' ' + RUN, status: 'CONFIRMED' } });
    const [w, l, t3a, t3b] = [await mk5('Campeão 5'), await mk5('Vice 5'), await mk5('Terceiro A'), await mk5('Terceiro B')];
    const ath = await mkUser('atleta da quinta');
    await prisma.rosterPlayer.createMany({ data: [{ entryId: w.id, name: 'Atleta', number: 1, userId: ath.id }, { entryId: w.id, name: 'Coordenador jogando', number: 2, userId: U.coord.id }] });
    await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: c5.id, stage: 'FINAL', round: 2, homeEntryId: w.id, awayEntryId: l.id, status: 'FINISHED', homeScore: 3, awayScore: 0, winnerEntryId: w.id } });
    const third = await prisma.tournamentMatch.create({ data: { tournamentId: T.id, categoryId: c5.id, stage: 'THIRD', round: 2, homeEntryId: t3a.id, awayEntryId: t3b.id, status: 'SCHEDULED' } });
    let r = await pay(U.owner, { confirm: true, categoryId: c5.id });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.paid.length, 0);
    assert.ok(/jogo\(s\) ainda sem resultado/.test(JSON.stringify(r.json.skipped)));
    await prisma.tournamentMatch.update({ where: { id: third.id }, data: { status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: t3a.id } });
    const cb = await balance(U.coord);
    r = await pay(U.owner, { confirm: true, categoryId: c5.id });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.json.paid.map((p) => p.userId), [ath.id]);
    assert.strictEqual(await balance(U.coord), cb, 'coordenador recebeu');
    assert.ok(/organização do torneio não recebe/.test(JSON.stringify(r.json.skipped)));
  });
  await ok('prévia não mostra o NOME da conta de menor (só o motivo)', async () => {
    const v = await cr(U.coord);
    const items = v.json.categories.flatMap((c) => c.items).filter((it) => /menor de 18/.test(it.reason || ''));
    assert.ok(items.length >= 1);
    assert.ok(items.every((it) => it.name == null && it.userId == null), JSON.stringify(items));
    assert.ok(!v.text.includes(U.minorAcct.name));
  });
  await ok('prêmio do campeão (legado) respeita o MESMO teto total junto com as conquistas (e a mesma trava)', async () => {
    const tc = require('../src/services/tournamentCash');
    const Z = await prisma.tournament.create({ data: { slug: 'f7-premio-' + RUN, name: 'Prêmio F7', sport: 'BEACH_TENNIS', ownerId: U.owner.id, status: 'ONGOING', cashEnabled: true, prizeCash: 1990 } });
    const zc = await prisma.tournamentCategory.create({ data: { tournamentId: Z.id, name: 'Duplas' } });
    const d1 = await prisma.tournamentEntry.create({ data: { tournamentId: Z.id, categoryId: zc.id, name: 'Dupla 1', status: 'CONFIRMED' } });
    const d2 = await prisma.tournamentEntry.create({ data: { tournamentId: Z.id, categoryId: zc.id, name: 'Dupla 2', status: 'CONFIRMED' } });
    const z1 = await mkUser('dupla z1');
    await prisma.entryMember.create({ data: { entryId: d1.id, userId: z1.id } });
    await prisma.tournamentMatch.create({ data: { tournamentId: Z.id, categoryId: zc.id, stage: 'FINAL', round: 1, homeEntryId: d1.id, awayEntryId: d2.id, status: 'FINISHED', homeScore: 2, awayScore: 0, winnerEntryId: d1.id } });
    await prisma.tournamentCashConfig.create({ data: { tournamentId: Z.id, rules: { TITLE: { amount: 20 } } } });
    const r = await pay(U.owner, { confirm: true }, Z.id);
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.json.total, 20);
    const pr = await tc.payPrize(Z.id); // 20 + 1990 > 2000
    assert.strictEqual(pr.ok, false); assert.ok(/teto total/.test(pr.error), pr.error);
    assert.strictEqual(await balance(z1), 20);
    assert.strictEqual((await prisma.tournament.findUnique({ where: { id: Z.id } })).prizePaidAt, null);
  });
  await ok('torneio SUSPENSO não paga (fundador 403, admin 409) e ARQUIVADO = 404; nenhum crédito', async () => {
    const S = await prisma.tournament.create({ data: { slug: 'f7-susp-' + RUN, name: 'Suspenso F7', sport: 'FUTSAL', ownerId: U.owner.id, status: 'ONGOING', cashEnabled: true } });
    const sc = await prisma.tournamentCategory.create({ data: { tournamentId: S.id, name: 'Livre' } });
    const s1 = await prisma.tournamentEntry.create({ data: { tournamentId: S.id, categoryId: sc.id, name: 'S1', status: 'CONFIRMED' } });
    const s2 = await prisma.tournamentEntry.create({ data: { tournamentId: S.id, categoryId: sc.id, name: 'S2', status: 'CONFIRMED' } });
    await prisma.rosterPlayer.create({ data: { entryId: s1.id, name: 'S1 jogador', userId: U.b1.id } });
    await prisma.tournamentMatch.create({ data: { tournamentId: S.id, categoryId: sc.id, stage: 'FINAL', round: 1, homeEntryId: s1.id, awayEntryId: s2.id, status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: s1.id } });
    await prisma.tournamentCashConfig.create({ data: { tournamentId: S.id, rules: { TITLE: { amount: 10 } } } });
    await prisma.tournament.update({ where: { id: S.id }, data: { suspendedAt: new Date(), suspendedReason: 'teste', suspendedBy: U.admin.id } });
    const b = await balance(U.b1);
    let r = await pay(U.owner, { confirm: true }, S.id); assert.strictEqual(r.status, 403, r.text);
    r = await pay(U.admin, { confirm: true }, S.id); assert.strictEqual(r.status, 409, r.text); assert.ok(/suspenso/.test(r.json.error));
    await prisma.tournament.update({ where: { id: S.id }, data: { suspendedAt: null, archivedAt: new Date() } });
    r = await pay(U.owner, { confirm: true }, S.id); assert.strictEqual(r.status, 404);
    r = await pay(U.admin, { confirm: true }, S.id); assert.strictEqual(r.status, 404);
    let err = null; try { await cashRules.pay({ userId: U.admin.id, userRole: 'admin' }, S.id, { confirm: true }); } catch (e) { err = e; }
    assert.ok(err && err.status === 409, 'serviço também recusa arquivado');
    assert.strictEqual(await balance(U.b1), b);
  });
  await ok('MASTER CUP (lista de exclusão): não paga nem com TenisCash ligado e admin; regras não gravam (409); dados intactos', async () => {
    await prisma.tournamentCashConfig.upsert({ where: { tournamentId: MC.id }, create: { tournamentId: MC.id, rules: { TITLE: { amount: 10 } } }, update: {} }).catch(() => null);
    const b = await balance(U.a2);
    const r = await pay(U.admin, { confirm: true }, MC.id);
    assert.strictEqual(r.status, 409, r.text); assert.ok(/Master Cup/.test(r.json.error));
    const s = await save(U.admin, { TITLE: { amount: 1 } }, MC.id);
    assert.strictEqual(s.status, 409); assert.strictEqual(s.json.code, 'EXCLUDED');
    assert.strictEqual(await balance(U.a2), b);
    assert.strictEqual(await prisma.tournamentCashAward.count({ where: { tournamentId: MC.id } }), 0);
    await prisma.tournamentCashConfig.deleteMany({ where: { tournamentId: MC.id } });
  });
  await ok('torneio PRIVADO: regras de TenisCash para quem não é membro = MESMO 404 de "não existe"', async () => {
    const a = await cr(U.stranger, P.id); const b = await cr(U.stranger, 'nao-existe-' + RUN);
    assert.strictEqual(a.status, 404); assert.strictEqual(a.text, b.text);
  });

  // ================================================================ d. medalha verificada
  console.log('  — d. medalha verificada (título e participação, CPF só em hash)');
  await ok('organizador emite: OURO do título e CONCLUINTE (participação) assinadas; credencial Open Badges 3.0 sem CPF; reemitir não duplica', async () => {
    await medals.createIssuer({ ownerUserId: U.owner.id, name: 'Liga F7 Org ' + RUN, signatoryName: 'Dono F7' });
    const out = await medals.issueTournament(T.id, { id: U.owner.id, role: 'user' }, { categoryIds: [cat1.id] });
    const mine = await prisma.medal.findMany({ where: { tournamentId: T.id, categoryId: cat1.id } });
    const gold = mine.find((m) => m.userId === U.a1.id && m.achievement === 'PLACEMENT');
    const fin = mine.find((m) => m.userId === U.c1.id && m.achievement === 'PLACEMENT');
    assert.ok(gold && gold.tier === 'GOLD' && gold.placement === 1, 'título');
    assert.ok(fin && fin.tier === 'FINISHER', 'participação');
    assert.ok(!mine.some((m) => m.userId === U.minorAcct.id), 'conta que declara menor de 18 não recebe medalha (tem CPF e está no elenco)');
    for (const m of [gold, fin]) {
      const u = await prisma.user.findUnique({ where: { id: m.userId }, select: { cpf: true } });
      const payload = JSON.parse(Buffer.from(m.credentialJwt.split('.')[1], 'base64url').toString('utf8'));
      const txt = JSON.stringify(payload) + JSON.stringify(await medals.bySerial(m.serial));
      assert.ok(!txt.includes(u.cpf), 'CPF em claro na credencial');
      assert.ok(payload.type.includes('OpenBadgeCredential') && payload['@context'].some((c) => /ob\/v3p0/.test(c)), 'Open Badges 3.0');
      const id = payload.credentialSubject.identifier.find((x) => x.identityType === 'nationalIdentityNumber');
      assert.strictEqual(id.hashed, true); assert.strictEqual(id.identityHash, m.identityHash); assert.notStrictEqual(m.identityHash, u.cpf);
      assert.ok(require('../src/services/medalCrypto').verifyCredentialJwt(m.credentialJwt).valid, 'assinatura do organizador');
    }
    assert.ok(out.issued.length >= 2);
    const again = await medals.issueTournament(T.id, { id: U.owner.id, role: 'user' }, { categoryIds: [cat1.id] });
    assert.strictEqual(again.issued.length, 0);
    let err = null; try { await medals.issueTournament(T.id, { id: U.stranger.id, role: 'user' }); } catch (e) { err = e; }
    assert.ok(err && err.status === 403, 'só o organizador assina');
  });

  // ================================================================ e. privacidade
  console.log('  — e. privacidade');
  await ok('export traz pedidos de uniforme e TenisCash por conquista; apagar tira nome/telefone do lead (o crédito fica)', async () => {
    const ex = await privacy.exportData(U.teamAdmin.id);
    assert.ok(ex.pedidosDeUniforme.some((l) => l.id === lead1.id && /camisa e calção/.test(l.resumo)), 'export com o resumo (observação)');
    const ex2 = await privacy.exportData(U.a1.id);
    assert.strictEqual(ex2.tenisCashPorConquista.length, 2);
    const r = await privacy.eraseSportData(U.teamAdmin.id, { confirm: 'APAGAR MEUS DADOS' });
    assert.ok(r.ok);
    const l = await prisma.mfLead.findUnique({ where: { id: lead1.id } });
    assert.strictEqual(l.name, null); assert.strictEqual(l.phone, null); assert.strictEqual(l.consentAt, null);
    assert.ok(!/camisa e calção/.test(l.resumo) && /Atletas: 6/.test(l.resumo), 'observação livre saiu; o pedido fica');
    assert.strictEqual(await prisma.tournamentCashAward.count({ where: { userId: U.a1.id } }), 2, 'crédito é dado financeiro, fica');
  });

  // ================================================================ f. Master Cup
  await ok('Master Cup intacto byte a byte', async () => { assert.strictEqual(await mcSnap(), MC_BEFORE); });

  // ================================================================ PROVA DE SABOTAGEM
  console.log('  — prova de sabotagem');
  // torneio novo com TenisCash DESLIGADO, final encerrada e regra configurada
  const fresh = async (label, extra = {}) => {
    const t = await prisma.tournament.create({ data: { slug: 'f7-sab-' + label + '-' + RUN, name: 'Sab ' + label, sport: 'FUTSAL', ownerId: U.owner.id, status: 'ONGOING', ...extra } });
    const c = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Livre' } });
    const h = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'H ' + label, status: 'CONFIRMED' } });
    const a = await prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name: 'A ' + label, status: 'CONFIRMED' } });
    const u = await mkUser('sab ' + label);
    await prisma.rosterPlayer.create({ data: { entryId: h.id, name: 'P', number: 1, userId: u.id } });
    await prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, stage: 'FINAL', round: 1, homeEntryId: h.id, awayEntryId: a.id, status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: h.id } });
    await prisma.tournamentCashConfig.create({ data: { tournamentId: t.id, rules: { TITLE: { amount: 10 } } } });
    return { t, u, h };
  };
  const origBlock = cashRules.blockReason;
  await sabotage('trava do cashEnabled (pagaria com TenisCash desligado)',
    () => { cashRules.blockReason = () => null; },
    async () => {
      const { t, u } = await fresh('off');
      const r = await pay(U.owner, { confirm: true }, t.id);
      assert.notStrictEqual(r.status, 200, 'pagou');
      assert.strictEqual(await balance(u), 0);
    },
    () => { cashRules.blockReason = origBlock; });
  const origScreen = cashRules.screenUser;
  await sabotage('trava de menor (pagaria conta que declara menor de 18)',
    () => { cashRules.screenUser = () => null; },
    async () => {
      const { t, u } = await fresh('minor', { cashEnabled: true });
      await prisma.user.update({ where: { id: u.id }, data: { birthDate: '2013-01-01' } });
      const r = await pay(U.owner, { confirm: true }, t.id);
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(await balance(u), 0, 'menor recebeu');
    },
    () => { cashRules.screenUser = origScreen; });
  const origCaps = cashRules.caps;
  await sabotage('teto total do torneio (pagaria acima do teto)',
    () => { cashRules.caps = () => ({ perRule: 1e9, perTournament: 1e9 }); },
    async () => {
      const { t, u } = await fresh('cap', { cashEnabled: true });
      await prisma.tournamentCashConfig.update({ where: { tournamentId: t.id }, data: { rules: { TITLE: { amount: 5000 } } } });
      const r = await pay(U.owner, { confirm: true }, t.id);
      assert.strictEqual(r.status, 409, 'pagou acima do teto: ' + r.text);
      assert.strictEqual(await balance(u), 0);
    },
    () => { cashRules.caps = origCaps; });
  const origCompute = cashRules.computeAwards;
  await sabotage('idempotência: sem a leitura do que já foi pago E sem a chave única, pagaria 2x a mesma conquista',
    async () => {
      await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "TournamentCashAward_tournamentId_categoryId_rule_userId_key"');
      cashRules.computeAwards = async (...a) => { const r = await origCompute(...a); r.categories.forEach((c) => c.items.forEach((it) => { if (it.status === 'paid') it.status = 'pay'; })); return r; };
    },
    async () => {
      const { t, u } = await fresh('dup', { cashEnabled: true });
      const r1 = await pay(U.owner, { confirm: true }, t.id);
      const r2 = await pay(U.owner, { confirm: true }, t.id);
      assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
      assert.strictEqual(await balance(u), 10, 'pagou 2x');
    },
    async () => {
      cashRules.computeAwards = origCompute;
      // apaga o que a sabotagem duplicou e devolve a chave única
      const dups = await prisma.$queryRawUnsafe('SELECT "tournamentId","categoryId","rule","userId", array_agg("id" ORDER BY "createdAt") AS ids FROM "TournamentCashAward" GROUP BY 1,2,3,4 HAVING count(*) > 1');
      for (const d of dups) await prisma.tournamentCashAward.deleteMany({ where: { id: { in: d.ids.slice(1) } } });
      await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS "TournamentCashAward_tournamentId_categoryId_rule_userId_key" ON "TournamentCashAward"("tournamentId", "categoryId", "rule", "userId")');
    });
  await ok('chave única da conquista existe no banco (pg_indexes) depois da prova', async () => {
    const r = await prisma.$queryRawUnsafe(`SELECT indexdef FROM pg_indexes WHERE indexname = 'TournamentCashAward_tournamentId_categoryId_rule_userId_key'`);
    assert.ok(r.length && /UNIQUE/.test(r[0].indexdef));
  });
  const origRecent = uniform.recentLead;
  await sabotage('sem duplicar o pedido de uniforme (criaria 2 leads iguais)',
    () => { uniform.recentLead = async () => null; },
    async () => {
      const u = await mkUser('sab uniforme');
      await prisma.tournamentRole.create({ data: { tournamentId: T.id, userId: u.id, role: 'TEAM_ADMIN', entryId: eB.id } });
      await uq(u, eB.id, { consent: true, athleteCount: 8 });
      await uq(u, eB.id, { consent: true, athleteCount: 8 });
      assert.strictEqual(await prisma.mfLead.count({ where: { requestedByUserId: u.id } }), 1, 'duplicou');
    },
    () => { uniform.recentLead = origRecent; });
  const origCan = roles.can;
  await sabotage('permissão do pedido de uniforme (estranho criaria lead)',
    () => { roles.can = async () => true; },
    async () => {
      const u = await mkUser('sab estranho');
      roles.can = async (...a) => (a[3] === 'MANAGE_TEAM' ? true : origCan(...a));
      await uq(u, eA.id, { consent: true, athleteCount: 8 });
      assert.strictEqual(await prisma.mfLead.count({ where: { requestedByUserId: u.id } }), 0, 'estranho pediu');
    },
    () => { roles.can = origCan; });
  await sabotage('troca de plano só pelo admin (usuário trocaria o próprio plano)',
    () => { roles.can = async (...a) => (a[3] === 'PLAN_ADMIN' ? true : origCan(...a)); },
    async () => {
      const u = await mkUser('sab plano');
      await assign(u, { userId: u.id, planKey: 'grande' });
      assert.strictEqual(await prisma.organizerSubscription.count({ where: { userId: u.id } }), 0, 'trocou o próprio plano');
    },
    () => { roles.can = origCan; });

  server.close();
  await prisma.$disconnect();
}

main().then(() => {
  console.log(`\n${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
