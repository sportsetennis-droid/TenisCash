'use strict';
process.env.LIGA_MEDIA_JSON_START = process.env.LIGA_MEDIA_JSON_START || '2020-01-01T00:00:00Z';
// =====================================================================
// Liga Aberta — FASE 2 (clube e atleta como identidade). npm run test:liga-f2
//
// Parte 1 (sem banco): normalização de nome, lista de exclusão, rotas.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   a. migração: agrupa por nome SÓ dentro do torneio, não junta torneios
//      diferentes, reaproveita vínculo explícito, é idempotente, pula o
//      Futsal Master Cup (slug futsal-master-cup-2026 fica intacto) + CLI dry-run
//   a. nome/escudo/cores do clube na API pública, nas rotas de jogos/tabela,
//      no escudo servido e na arte — com fallback quando clubId é nulo
//   a. inscrição nova de time liga/cria clube; Master Cup segue sem clube
//   a. permissão de editar clube (dono do clube, MANAGE_TEAM, outros)
//   b. convite de elenco: válido, expirado, reutilizado, substituído, sem
//      permissão; desvincular só o próprio atleta ou a coordenação (auditado)
//   c. histórico: gol numa liga + gol em outra liga aparecem juntos (critério
//      de pronto); card sem "0 jogos" no futsal; títulos; esporte individual;
//      público não mostra privado/arquivado; o próprio atleta vê o privado
//   d. fusão de perfis: exige confirmação (código / senha), migra tudo,
//      medalha fica no relatório, perfil antigo desativado, bloqueios
//   PROVA DE SABOTAGEM: estraga cada trava e confere que o teste pega.
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

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
        resolve({ status: res.statusCode, json, text, headers: res.headers, buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('1. Sem banco');
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f2-' + crypto.randomBytes(8).toString('hex');
  const ci = require('../src/services/clubIdentity');
  await ok('normName junta caixa, espaço e acento ("CABO  Brânco " = "cabo branco")', () => {
    assert.strictEqual(ci.normName('CABO  Brânco '), 'cabo branco');
    assert.strictEqual(ci.normName('Cabo Branco'), ci.normName('cabo branco'));
    assert.notStrictEqual(ci.normName('Cabo Branco'), ci.normName('Cabo Branco FC'));
  });
  await ok('Futsal Master Cup está na lista de exclusão da migração', () => {
    assert.ok(ci.EXCLUDED_SLUGS.includes('futsal-master-cup-2026'));
    assert.ok(ci.isExcludedSlug('futsal-master-cup-2026'));
    assert.ok(!ci.isExcludedSlug('outra-liga'));
  });
  await ok('rotas novas existem (clube, convite, histórico, fusão) e can() segue a porta', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/tournaments.js'), 'utf8');
    for (const r of ["'/entries/:entryId/club'", "'/players/:playerId/invite'", "'/roster-invites/:token'", "'/roster-invites/:token/claim'", "'/players/:playerId/unlink'", "'/athletes/:handle/history'", "'/athletes/merge/start'", "'/athletes/merge/confirm'"]) {
      assert.ok(src.includes(r), 'faltou rota ' + r);
    }
    assert.ok(!/ownerId !== req\.userId/.test(src), 'checagem de dono inline');
    const sch = fs.readFileSync(path.join(__dirname, '../src/services/ensureApexSchema.js'), 'utf8');
    const first = sch.indexOf('STATEMENTS = [');
    // (F5 pôs um índice com "archivedAt" no início; a referência é o ALTER da F1)
    assert.ok(sch.indexOf('"clubId"', first) < sch.indexOf('ADD COLUMN IF NOT EXISTS "archivedAt"', first), 'clubId tem que vir no início do ensureApexSchema');
  });

  console.log('2. Banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('migração, clube, convite, histórico, fusão', 'DATABASE_URL local (localhost) não definido');
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');
  const sharp = require('sharp');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const ci = require('../src/services/clubIdentity');
  const signupCode = require('../src/services/athleteSignupCode');
  await ensureApexSchema(prisma);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use('/api/clubs', require('../src/routes/clubs'));
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
  const mkUser = (label, extra = {}) => prisma.user.create({ data: { name: `F2 ${label} ${RUN}-${++seq}`, phone: '839' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...extra } });
  const tok = (u) => jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' });
  const png = async (color) => 'data:image/png;base64,' + (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64');
  const LOGO_ENTRY = await png('#00ff00');
  const CREST = await png('#ff0000');

  const U = {
    org: await mkUser('organizador'),
    org2: await mkUser('organizador 2'),
    teamAdmin: await mkUser('admin Cabo Branco'),
    otherAdmin: await mkUser('admin Amigos'),
    clubOwner: await mkUser('dono de clube'),
    athlete: await mkUser('atleta', { username: 'f2atleta' + RUN }),
    anyone: await mkUser('qualquer'),
    coord: await mkUser('coordenador'),
  };

  // ------------------------------------------------------------------ dados
  const mkT = (slug, extra = {}) => prisma.tournament.create({ data: { slug, name: 'F2 ' + slug, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.org.id, status: 'OPEN', ...extra } });
  const T1 = await mkT('f2-a-' + RUN);
  const T2 = await mkT('f2-b-' + RUN, { ownerId: U.org2.id });
  const T3 = await mkT('f2-c-' + RUN);
  const MC = await mkT('futsal-master-cup-2026', { name: 'II Futsal Master Cup 2026 (teste)', status: 'ONGOING' });
  const cat = async (t, name) => prisma.tournamentCategory.create({ data: { tournamentId: t.id, name } });
  const c1a = await cat(T1, '40+'); const c1b = await cat(T1, '50+');
  const c2 = await cat(T2, 'Livre');
  const c3 = await cat(T3, 'Livre');
  const cmc = await cat(MC, '40+ A');
  const mkE = (t, c, name, extra = {}) => prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name, status: 'CONFIRMED', ...extra } });
  const eCB1 = await mkE(T1, c1a, 'Cabo Branco');
  const eCB2 = await mkE(T1, c1b, 'CABO  BRANCO ');
  const eAm = await mkE(T1, c1a, 'Amigos', { logoUrl: LOGO_ENTRY });
  const eSolo = await mkE(T1, c1a, 'Atleta Solo');
  await prisma.entryMember.create({ data: { entryId: eSolo.id, userId: U.anyone.id } });
  const eCBt2 = await mkE(T2, c2, 'Cabo Branco');
  const eLeoes = await mkE(T3, c3, 'Leões');
  const eMC1 = await mkE(MC, cmc, 'Cabo Branco', { logoUrl: LOGO_ENTRY, groupName: 'A' });
  const eMC2 = await mkE(MC, cmc, 'Amigos CG', { groupName: 'A' });
  await prisma.tournamentRole.create({ data: { tournamentId: T1.id, userId: U.teamAdmin.id, role: 'TEAM_ADMIN', entryId: eCB1.id } });
  await prisma.tournamentRole.create({ data: { tournamentId: T1.id, userId: U.otherAdmin.id, role: 'TEAM_ADMIN', entryId: eAm.id } });
  await prisma.tournamentRole.create({ data: { tournamentId: T1.id, userId: U.coord.id, role: 'COORDINATOR' } });
  const linkedClub = await prisma.club.create({ data: { ownerId: U.clubOwner.id, name: 'Leões FC (permanente)', slug: 'leoes-' + RUN, memberships: { create: { userId: U.clubOwner.id, role: 'owner', status: 'ACTIVE' } } } });
  await prisma.clubTournamentLink.create({ data: { clubId: linkedClub.id, tournamentId: T3.id, entryName: 'Leões' } });
  const mcMatch = await prisma.tournamentMatch.create({ data: { tournamentId: MC.id, categoryId: cmc.id, stage: 'GROUP', groupName: 'A', round: 1, homeEntryId: eMC1.id, awayEntryId: eMC2.id, status: 'SCHEDULED' } });
  const snapMC = async () => JSON.stringify({
    t: await prisma.tournament.findUnique({ where: { id: MC.id } }),
    e: await prisma.tournamentEntry.findMany({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } }),
    m: await prisma.tournamentMatch.findMany({ where: { tournamentId: MC.id }, orderBy: { id: 'asc' } }),
  });
  const mcBefore = await snapMC();
  const SLUGS = [T1.slug, T2.slug, T3.slug, MC.slug];

  // ================================================================ a. migração
  console.log('  — a. migração (clubId)');
  const clubsBefore = await prisma.club.count();
  await ok('CLI dry-run lista o plano e NÃO grava nada', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'migrate-liga-f2-clubs.js'), '--only=' + SLUGS.join(',')], { env: process.env, encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
    assert.ok(/DRY-RUN/.test(r.stdout), r.stdout);
    assert.ok(/futsal-master-cup-2026 — lista de exclusão/.test(r.stdout), 'Master Cup deveria aparecer como pulado');
    assert.ok(/nada gravado/.test(r.stdout));
  });
  await ok('dry-run não criou clube nem ligou inscrição', async () => {
    assert.strictEqual(await prisma.club.count(), clubsBefore);
    assert.strictEqual(await prisma.tournamentEntry.count({ where: { tournamentId: { in: [T1.id, T2.id, T3.id, MC.id] }, clubId: { not: null } } }), 0);
  });
  const plan = await ci.planMigration(prisma, { onlySlugs: SLUGS });
  const applied = await ci.applyMigration(prisma, plan);
  const ent = async (e) => prisma.tournamentEntry.findUnique({ where: { id: e.id } });
  await ok('mesmo torneio: "Cabo Branco" e "CABO  BRANCO " viram UM clube', async () => {
    const a = await ent(eCB1); const b = await ent(eCB2);
    assert.ok(a.clubId); assert.strictEqual(a.clubId, b.clubId);
  });
  await ok('torneios diferentes com o mesmo nome NÃO se juntam', async () => {
    const a = await ent(eCB1); const c = await ent(eCBt2);
    assert.ok(c.clubId); assert.notStrictEqual(a.clubId, c.clubId);
  });
  await ok('dono do clube = admin do time (com membership owner); escudo copiado da inscrição', async () => {
    const club = await prisma.club.findUnique({ where: { id: (await ent(eCB1)).clubId }, include: { memberships: true } });
    assert.strictEqual(club.ownerId, U.teamAdmin.id);
    assert.ok(club.memberships.some((m) => m.userId === U.teamAdmin.id && m.role === 'owner'));
    const am = await prisma.club.findUnique({ where: { id: (await ent(eAm)).clubId } });
    assert.strictEqual(am.crestUrl, LOGO_ENTRY);
    assert.strictEqual(am.ownerId, U.otherAdmin.id);
    const t2club = await prisma.club.findUnique({ where: { id: (await ent(eCBt2)).clubId }, include: { memberships: true } });
    assert.strictEqual(t2club.ownerId, U.org2.id, 'sem admin do time → organizador');
    assert.strictEqual(t2club.memberships.length, 0, 'organizador não vira membro do clube');
  });
  await ok('vínculo explícito (ClubTournamentLink) é reaproveitado', async () => {
    assert.strictEqual((await ent(eLeoes)).clubId, linkedClub.id);
  });
  await ok('inscrição individual (com atleta) não vira clube', async () => {
    assert.strictEqual((await ent(eSolo)).clubId, null);
  });
  await ok('Futsal Master Cup fica INTACTO (byte a byte)', async () => {
    assert.strictEqual(await snapMC(), mcBefore);
    assert.ok(plan.skipped.some((s) => s.slug === 'futsal-master-cup-2026'));
  });
  await ok('idempotente: 2ª rodada não liga nem cria nada', async () => {
    const before = await prisma.club.count();
    const p2 = await ci.planMigration(prisma, { onlySlugs: SLUGS });
    assert.strictEqual(p2.totals.entriesToLink, 0);
    assert.strictEqual(p2.totals.clubsToCreate, 0);
    await ci.applyMigration(prisma, p2);
    assert.strictEqual(await prisma.club.count(), before);
    assert.ok(applied.clubsCreated.length >= 3);
  });
  await ok('inscrição nova do mesmo nome entra no clube já existente na próxima rodada', async () => {
    const extra = await mkE(T1, await cat(T1, '60+'), 'cabo branco');
    const p3 = await ci.planMigration(prisma, { onlySlugs: [T1.slug] });
    assert.strictEqual(p3.totals.entriesToLink, 1);
    assert.strictEqual(p3.totals.clubsToCreate, 0);
    await ci.applyMigration(prisma, p3);
    assert.strictEqual((await ent(extra)).clubId, (await ent(eCB1)).clubId);
  });
  await ok('dupla sem membro (esporte individual) NÃO vira clube; com elenco vira; arquivado é pulado', async () => {
    const TB = await mkT('f2-bt-' + RUN, { sport: 'BEACH_TENNIS', isDoubles: true });
    const cb = await cat(TB, 'Duplas');
    const dupla = await mkE(TB, cb, 'João & Maria'); // @ não achado na inscrição online: 0 membros
    const comElenco = await mkE(TB, cb, 'Equipe BT');
    await prisma.rosterPlayer.create({ data: { entryId: comElenco.id, name: 'Fulano' } });
    const TX = await mkT('f2-arq-mig-' + RUN, { archivedAt: new Date() });
    const ex = await mkE(TX, await cat(TX, 'Livre'), 'Time Arquivado');
    const p = await ci.planMigration(prisma, { onlySlugs: [TB.slug, TX.slug] });
    assert.ok(p.skipped.some((x) => x.slug === TX.slug && x.reason === 'arquivado'));
    await ci.applyMigration(prisma, p);
    assert.strictEqual((await ent(dupla)).clubId, null);
    assert.ok((await ent(comElenco)).clubId);
    assert.strictEqual((await ent(ex)).clubId, null);
  });
  await ok('clube criado pela migração guarda o torneio de origem', async () => {
    const c = await prisma.club.findUnique({ where: { id: (await ent(eCB1)).clubId } });
    assert.strictEqual(c.originTournamentId, T1.id);
    const leoes = await prisma.club.findUnique({ where: { id: linkedClub.id } });
    assert.strictEqual(leoes.originTournamentId, null, 'clube permanente reaproveitado continua permanente');
  });
  await ok('reverter (backup do apply) devolve clubId nulo sem apagar clube', async () => {
    const tmpT = await mkT('f2-rev-' + RUN);
    const tc = await cat(tmpT, 'Livre');
    const e1 = await mkE(tmpT, tc, 'Reversível');
    const p = await ci.planMigration(prisma, { onlySlugs: [tmpT.slug] });
    const a = await ci.applyMigration(prisma, p);
    const cid = (await ent(e1)).clubId;
    assert.ok(cid);
    const r = await ci.revertMigration(prisma, a);
    assert.strictEqual(r.entries, 1);
    assert.strictEqual((await ent(e1)).clubId, null);
    assert.ok(await prisma.club.findUnique({ where: { id: cid } }), 'clube não pode ser apagado');
  });

  // ============================================ a. nome/escudo/cores do clube
  console.log('  — a. clube na API pública, jogos, tabela, escudo e arte (com fallback)');
  const cbClubId = (await ent(eCB1)).clubId;
  await prisma.club.update({ where: { id: cbClubId }, data: { name: 'Cabo Branco Futsal', crestUrl: CREST, primaryColor: '#112233', secondaryColor: '#FFEE00' } });
  const m1 = await prisma.tournamentMatch.create({ data: { tournamentId: T1.id, categoryId: c1a.id, stage: 'LEAGUE', round: 1, homeEntryId: eCB1.id, awayEntryId: eAm.id, status: 'SCHEDULED' } });
  await ok('API pública: nome, escudo e cores do CLUBE; nome da inscrição preservado em entryName não vaza', async () => {
    const r = await call('GET', `/api/public/tournaments/${T1.slug}`);
    assert.strictEqual(r.status, 200, r.text);
    const catA = r.json.categories.find((c) => c.id === c1a.id);
    const m = catA.matches.find((x) => x.id === m1.id);
    assert.strictEqual(m.home.name, 'Cabo Branco Futsal');
    assert.strictEqual(m.home.primaryColor, '#112233');
    assert.strictEqual(m.home.secondaryColor, '#FFEE00');
    assert.ok(/\/api\/public\/entries\/.+\/logo$/.test(m.home.logoUrl), 'escudo data URI vira rota de escudo');
    const st = catA.standings.find((s) => s.entry.id === eCB1.id);
    assert.strictEqual(st.entry.name, 'Cabo Branco Futsal');
  });
  await ok('rota do escudo serve o escudo do CLUBE', async () => {
    const r = await call('GET', `/api/public/entries/${eCB1.id}/logo`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['content-type'], 'image/png');
    assert.strictEqual(r.buf.toString('base64'), CREST.split(',')[1]);
  });
  await ok('jogos e classificação da categoria trazem o clube', async () => {
    const r = await call('GET', `/api/tournaments/${T1.id}/categories/${c1a.id}/matches`);
    const m = r.json.matches.find((x) => x.id === m1.id);
    assert.strictEqual(m.homeEntry.name, 'Cabo Branco Futsal');
    assert.strictEqual(m.homeEntry.logoUrl, CREST);
    assert.strictEqual(m.awayEntry.logoUrl, LOGO_ENTRY, 'Amigos: clube sem escudo próprio → escudo copiado');
    const s = await call('GET', `/api/tournaments/${T1.id}/categories/${c1a.id}/standings`);
    assert.ok(s.json.standings.some((x) => x.entry.name === 'Cabo Branco Futsal' && x.entry.primaryColor === '#112233'));
    const l = await call('GET', `/api/tournaments/${T1.id}/entries?categoryId=${c1a.id}`);
    const cb = l.json.entries.find((x) => x.id === eCB1.id);
    assert.strictEqual(cb.name, 'Cabo Branco Futsal');
    assert.strictEqual(cb.entryName, 'Cabo Branco');
  });
  await ok('fallback (clubId nulo — Master Cup): nome/escudo da própria inscrição, sem cores', async () => {
    const r = await call('GET', `/api/public/tournaments/${MC.slug}`);
    assert.strictEqual(r.status, 200);
    const m = r.json.categories[0].matches.find((x) => x.id === mcMatch.id);
    assert.strictEqual(m.home.name, 'Cabo Branco');
    assert.ok(m.home.logoUrl);
    assert.strictEqual(m.home.primaryColor, undefined);
    const lg = await call('GET', `/api/public/entries/${eMC1.id}/logo`);
    assert.strictEqual(lg.buf.toString('base64'), LOGO_ENTRY.split(',')[1]);
  });
  const art = require('../src/services/tournamentArt');
  await ok('arte (resultado) usa nome/escudo do clube; Master Cup cai no da inscrição', async () => {
    const tFull = await prisma.tournament.findUnique({ where: { id: T1.id } });
    const d = await art._buildData(tFull, 'resultado', { matchId: m1.id });
    assert.strictEqual(d.match.homeEntry.name, 'Cabo Branco Futsal');
    assert.ok(d.match.homeEntry.logo, 'escudo do clube carregado');
    const mcFull = await prisma.tournament.findUnique({ where: { id: MC.id } });
    const d2 = await art._buildData(mcFull, 'resultado', { matchId: mcMatch.id });
    assert.strictEqual(d2.match.homeEntry.name, 'Cabo Branco');
    const png1 = await art.buildArt(T1.slug, 'resultado', { matchId: m1.id, formato: 'og' });
    assert.ok(png1.png && png1.png.length > 1000);
  });
  await ok('página /clube/:slug lista o jogo do time ligado pelo clubId (sem vínculo manual)', async () => {
    const club = await prisma.club.findUnique({ where: { id: cbClubId } });
    const r = await call('GET', `/api/clubs/${club.slug}`);
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(r.json.upcoming.some((m) => m.id === m1.id && m.home === 'Cabo Branco Futsal'), JSON.stringify(r.json.upcoming));
    assert.ok(r.json.links.some((l) => l.viaClubId && l.tournamentId === T1.id));
  });

  // ============================================ a. inscrição nova de time
  console.log('  — a. inscrição nova liga/cria clube');
  await ok('usuário comum cria o próprio time → clube novo (ele é o dono) e categoria 2 reusa o clube', async () => {
    const r = await call('POST', `/api/tournaments/${T1.id}/entries`, { token: tok(U.anyone), body: { team: true, teamName: 'Novo FC', categoryId: c1a.id } });
    assert.strictEqual(r.status, 201, r.text);
    const e1 = await ent(r.json);
    assert.ok(e1.clubId);
    const club = await prisma.club.findUnique({ where: { id: e1.clubId }, include: { memberships: true } });
    assert.strictEqual(club.ownerId, U.anyone.id);
    assert.ok(club.memberships.some((m) => m.userId === U.anyone.id && m.role === 'owner'));
    const r2 = await call('POST', `/api/tournaments/${T1.id}/entries`, { token: tok(U.anyone), body: { team: true, teamName: 'novo fc', categoryId: c1b.id } });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual((await ent(r2.json)).clubId, e1.clubId);
  });
  await ok('BLOQUEIO: "Cabo Brànco" / "cabo  branco" de quem não é admin NÃO entra no clube do Cabo Branco (409)', async () => {
    const c60 = await prisma.tournamentCategory.findFirst({ where: { tournamentId: T1.id, name: '60+' } });
    for (const nm of ['Cabo Brànco', 'cabo  branco']) {
      const r = await call('POST', `/api/tournaments/${T1.id}/entries`, { token: tok(U.otherAdmin), body: { team: true, teamName: nm, categoryId: c60.id } });
      assert.strictEqual(r.status, 409, nm + ' → ' + r.text);
    }
    // direto no serviço (caminho da inscrição online): também barra
    await assert.rejects(prisma.$transaction((tx) => ci.clubForNewTeam(tx, T1, { teamName: 'CABO BRÁNCO', userId: U.anyone.id })), (e) => e.status === 409);
    // o admin do clube pode inscrever o clube em outra categoria
    const ok2 = await prisma.$transaction((tx) => ci.clubForNewTeam(tx, T1, { teamName: 'Cabo Brànco', userId: U.teamAdmin.id }));
    assert.strictEqual(ok2.clubId, cbClubId);
  });
  await ok('organizador escolhe clube que NÃO administra → 403; o próprio clube → ok', async () => {
    const r = await call('POST', `/api/tournaments/${T1.id}/entries`, { token: tok(U.org), body: { team: true, teamName: 'Leões Visitante', categoryId: c1a.id, clubId: linkedClub.id } });
    assert.strictEqual(r.status, 403, r.text);
    const own = await prisma.club.create({ data: { ownerId: U.org.id, name: 'Clube do Org', slug: 'org-' + RUN } });
    const r2 = await call('POST', `/api/tournaments/${T1.id}/entries`, { token: tok(U.org), body: { team: true, teamName: 'Clube do Org', categoryId: c1a.id, clubId: own.id } });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual((await ent(r2.json)).clubId, own.id);
  });
  await ok('Master Cup (lista de exclusão): time novo segue SEM clube', async () => {
    const r = await call('POST', `/api/tournaments/${MC.id}/entries`, { token: tok(U.org), body: { team: true, teamName: 'Time Extra MC', categoryId: cmc.id } });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual((await ent(r.json)).clubId, null);
    await prisma.tournamentEntry.delete({ where: { id: r.json.id } });
  });

  // ============================================ a. permissão de editar clube
  console.log('  — a. permissão de editar o clube');
  const editClub = (u, e, body) => call('PATCH', `/api/tournaments/entries/${e.id}/club`, { token: u ? tok(u) : null, body });
  await ok('admin do time (MANAGE_TEAM, clube exclusivo do torneio) edita nome/cores', async () => {
    const r = await editClub(U.teamAdmin, eCB1, { primaryColor: '#123456' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.club.primaryColor, '#123456');
  });
  await ok('coordenação edita; admin de OUTRO time, qualquer um e anônimo não', async () => {
    assert.strictEqual((await editClub(U.coord, eCB1, { secondaryColor: '#FFFFFF' })).status, 200);
    assert.strictEqual((await editClub(U.otherAdmin, eCB1, { name: 'Hack' })).status, 403);
    assert.strictEqual((await editClub(U.anyone, eCB1, { name: 'Hack' })).status, 403);
    assert.strictEqual((await editClub(null, eCB1, { name: 'Hack' })).status, 401);
  });
  await ok('clube permanente que joga OUTRO torneio: só o dono do clube edita', async () => {
    await prisma.tournamentRole.create({ data: { tournamentId: T3.id, userId: U.coord.id, role: 'COORDINATOR' } });
    await mkE(T2, c2, 'Leões FC (permanente)', { clubId: linkedClub.id });
    const deny = await editClub(U.coord, eLeoes, { name: 'Leões Hack' });
    assert.strictEqual(deny.status, 403, deny.text);
    const okR = await editClub(U.clubOwner, eLeoes, { name: 'Leões FC' });
    assert.strictEqual(okR.status, 200, okR.text);
  });
  await ok('clube permanente inscrito no 1º torneio pelo dono: a coordenação NÃO edita; o dono edita', async () => {
    const perm = await prisma.club.create({ data: { ownerId: U.clubOwner.id, name: 'Perm FC', slug: 'perm-' + RUN, memberships: { create: { userId: U.clubOwner.id, role: 'owner', status: 'ACTIVE' } } } });
    const r = await call('POST', `/api/tournaments/${T3.id}/entries`, { token: tok(U.clubOwner), body: { team: true, teamName: 'Perm FC', categoryId: c3.id, clubId: perm.id } });
    assert.strictEqual(r.status, 201, r.text);
    const e = await ent(r.json);
    assert.strictEqual(e.clubId, perm.id);
    assert.strictEqual((await editClub(U.coord, e, { name: 'Perm Hack' })).status, 403);
    assert.strictEqual((await editClub(U.clubOwner, e, { primaryColor: '#000000' })).status, 200);
  });
  await ok('escudo pelo time grava no CLUBE (imageGuard) e não mexe na inscrição; lixo = 400', async () => {
    const r = await call('POST', `/api/tournaments/entries/${eCB1.id}/logo`, { token: tok(U.teamAdmin), body: { logo: LOGO_ENTRY } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.savedOn, 'club');
    const club = await prisma.club.findUnique({ where: { id: cbClubId } });
    assert.ok(club.crestUrl && /^\/media\/[a-f0-9]{64}\.png$/.test(club.crestUrl), club.crestUrl); // Liga F5: escudo no mediaStore
    assert.strictEqual((await ent(eCB1)).logoUrl, null);
    const bad = await call('POST', `/api/tournaments/entries/${eCB1.id}/logo`, { token: tok(U.teamAdmin), body: { logo: 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64') } });
    assert.strictEqual(bad.status, 400, bad.text);
    const noPerm = await call('POST', `/api/tournaments/entries/${eCB1.id}/logo`, { token: tok(U.otherAdmin), body: { logo: null } });
    assert.strictEqual(noPerm.status, 403);
  });
  await ok('escudo removido do clube → escudo antigo da inscrição não volta', async () => {
    const r = await call('POST', `/api/tournaments/entries/${eAm.id}/logo`, { token: tok(U.otherAdmin), body: { logo: null } });
    assert.strictEqual(r.status, 200, r.text);
    const m = await call('GET', `/api/tournaments/${T1.id}/categories/${c1a.id}/matches`);
    assert.strictEqual(m.json.matches.find((x) => x.id === m1.id).awayEntry.logoUrl, null);
  });

  // ============================================ b. convite de elenco
  console.log('  — b. convite de elenco');
  const pCB = await prisma.rosterPlayer.create({ data: { entryId: eCB1.id, name: 'Atleta Artilheiro', number: 10 } });
  const invite = (u, p, body = {}) => call('POST', `/api/tournaments/players/${p.id}/invite`, { token: u ? tok(u) : null, body });
  let inv1;
  await ok('sem permissão não gera convite (admin de outro time, qualquer um, anônimo)', async () => {
    assert.strictEqual((await invite(U.otherAdmin, pCB)).status, 403);
    assert.strictEqual((await invite(U.anyone, pCB)).status, 403);
    assert.strictEqual((await invite(null, pCB)).status, 401);
  });
  await ok('admin do time gera link + texto de WhatsApp (o sistema não envia nada)', async () => {
    const r = await invite(U.teamAdmin, pCB);
    assert.strictEqual(r.status, 201, r.text);
    inv1 = r.json;
    assert.ok(/\/convite-elenco\/[A-Za-z0-9_-]{40,}$/.test(inv1.url));
    assert.ok(inv1.whatsappText.includes(inv1.url) && inv1.whatsappText.includes('Cabo Branco Futsal'));
    assert.ok(inv1.whatsappUrl.startsWith('https://wa.me/?text='));
    const row = await prisma.rosterInvite.findFirst({ where: { rosterPlayerId: pCB.id, usedAt: null, revokedAt: null } });
    assert.ok(row && row.tokenHash !== inv1.token, 'no banco só o hash do token');
    const info = await call('GET', `/api/tournaments/roster-invites/${inv1.token}`);
    assert.strictEqual(info.json.status, 'valid');
    assert.strictEqual(info.json.team.name, 'Cabo Branco Futsal');
  });
  await ok('convite substituído (gerar de novo) invalida o anterior', async () => {
    const r = await invite(U.teamAdmin, pCB);
    assert.strictEqual(r.status, 201);
    const old = await call('POST', `/api/tournaments/roster-invites/${inv1.token}/claim`, { token: tok(U.athlete) });
    assert.strictEqual(old.status, 410);
    assert.strictEqual(old.json.status, 'revoked');
    inv1 = r.json;
  });
  await ok('convite expirado: 410 e página mostra expirado', async () => {
    const pExp = await prisma.rosterPlayer.create({ data: { entryId: eCB1.id, name: 'Vaga Expirada' } });
    const r = await invite(U.teamAdmin, pExp);
    await prisma.rosterInvite.updateMany({ where: { rosterPlayerId: pExp.id }, data: { expiresAt: new Date(Date.now() - 60000) } });
    const c = await call('POST', `/api/tournaments/roster-invites/${r.json.token}/claim`, { token: tok(U.anyone) });
    assert.strictEqual(c.status, 410);
    assert.strictEqual(c.json.status, 'expired');
    assert.strictEqual((await call('GET', `/api/tournaments/roster-invites/${r.json.token}`)).json.status, 'expired');
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pExp.id } })).userId, null);
  });
  await ok('token inválido = 404; sem login = 401', async () => {
    assert.strictEqual((await call('GET', '/api/tournaments/roster-invites/abc')).status, 404);
    assert.strictEqual((await call('POST', '/api/tournaments/roster-invites/' + 'x'.repeat(43) + '/claim', { token: tok(U.athlete) })).status, 404);
    assert.strictEqual((await call('POST', `/api/tournaments/roster-invites/${inv1.token}/claim`)).status, 401);
  });
  await ok('atleta reivindica: vaga ligada à conta, vínculo ATIVO, papel PLAYER, auditoria', async () => {
    const r = await call('POST', `/api/tournaments/roster-invites/${inv1.token}/claim`, { token: tok(U.athlete) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pCB.id } })).userId, U.athlete.id);
    const tm = await prisma.teamMembership.findFirst({ where: { tournamentId: T1.id, userId: U.athlete.id } });
    assert.strictEqual(tm.status, 'ACTIVE');
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: T1.id, userId: U.athlete.id, role: 'PLAYER' } }));
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T1.id, action: 'roster.claim', entityId: pCB.id } }));
  });
  await ok('convite reutilizado: 410 (uso único); vaga já ligada não gera convite (409)', async () => {
    const again = await call('POST', `/api/tournaments/roster-invites/${inv1.token}/claim`, { token: tok(U.anyone) });
    assert.strictEqual(again.status, 410);
    assert.strictEqual(again.json.status, 'used');
    assert.strictEqual((await invite(U.teamAdmin, pCB)).status, 409);
  });
  await ok('desvincular: admin do time NÃO (rota nova e /link); o próprio atleta sim (auditado)', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/players/${pCB.id}/unlink`, { token: tok(U.teamAdmin) })).status, 403);
    assert.strictEqual((await call('POST', `/api/tournaments/players/${pCB.id}/link`, { token: tok(U.teamAdmin), body: { userId: null } })).status, 403);
    const self = await call('POST', `/api/tournaments/players/${pCB.id}/unlink`, { token: tok(U.athlete), body: { reason: 'teste' } });
    assert.strictEqual(self.status, 200, self.text);
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pCB.id } })).userId, null);
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T1.id, action: 'roster.unlink', entityId: pCB.id } }));
    // desfaz o que o convite criou: vínculo ativo e papel PLAYER
    const tm = await prisma.teamMembership.findFirst({ where: { tournamentId: T1.id, userId: U.athlete.id } });
    assert.strictEqual(tm.status, 'REMOVED');
    assert.strictEqual(await prisma.tournamentRole.count({ where: { tournamentId: T1.id, userId: U.athlete.id, role: 'PLAYER' } }), 0);
  });
  await ok('coordenação desvincula; depois o atleta reivindica de novo por convite novo', async () => {
    const r = await invite(U.teamAdmin, pCB);
    assert.strictEqual((await call('POST', `/api/tournaments/roster-invites/${r.json.token}/claim`, { token: tok(U.athlete) })).status, 200);
    assert.strictEqual((await call('POST', `/api/tournaments/players/${pCB.id}/unlink`, { token: tok(U.coord) })).status, 200);
    const r2 = await invite(U.teamAdmin, pCB);
    assert.strictEqual((await call('POST', `/api/tournaments/roster-invites/${r2.json.token}/claim`, { token: tok(U.athlete) })).status, 200);
  });
  await ok('adicionar ao elenco já com conta de quem NÃO tem vínculo ativo → 400', async () => {
    const r = await call('POST', `/api/tournaments/entries/${eCB1.id}/players`, { token: tok(U.teamAdmin), body: { name: 'Fantasma', userId: U.anyone.id } });
    assert.strictEqual(r.status, 400, r.text);
  });

  // ============================================ c. histórico entre ligas
  console.log('  — c. histórico do atleta entre ligas');
  const finish = async (m, hs, as, winner) => prisma.tournamentMatch.update({ where: { id: m.id }, data: { status: 'FINISHED', homeScore: hs, awayScore: as, winnerEntryId: winner, scheduledAt: new Date('2026-06-10T22:00:00Z') } });
  // liga 1 (T1): gol do atleta
  await prisma.matchEvent.create({ data: { matchId: m1.id, entryId: eCB1.id, playerId: pCB.id, type: 'GOAL' } });
  await finish(m1, 1, 0, eCB1.id);
  // liga 2 (T2): o atleta reivindica a vaga lá também e marca + dá assistência + amarelo, e o time é campeão
  const eOp2 = await mkE(T2, c2, 'Rival');
  const pT2 = await prisma.rosterPlayer.create({ data: { entryId: eCBt2.id, name: 'Atleta (liga 2)', number: 7 } });
  await prisma.tournamentRole.create({ data: { tournamentId: T2.id, userId: U.org2.id, role: 'COORDINATOR' } });
  const inv2 = await call('POST', `/api/tournaments/players/${pT2.id}/invite`, { token: tok(U.org2) });
  assert.strictEqual(inv2.status, 201, inv2.text);
  assert.strictEqual((await call('POST', `/api/tournaments/roster-invites/${inv2.json.token}/claim`, { token: tok(U.athlete) })).status, 200);
  const mFinal = await prisma.tournamentMatch.create({ data: { tournamentId: T2.id, categoryId: c2.id, stage: 'FINAL', round: 1, homeEntryId: eCBt2.id, awayEntryId: eOp2.id, status: 'SCHEDULED' } });
  for (const type of ['GOAL', 'ASSIST', 'YELLOW']) await prisma.matchEvent.create({ data: { matchId: mFinal.id, entryId: eCBt2.id, playerId: pT2.id, type } });
  await prisma.tournamentMatch.update({ where: { id: mFinal.id }, data: { status: 'FINISHED', homeScore: 2, awayScore: 2, winnerEntryId: eCBt2.id, decidedByPenalties: true, homePenalties: 4, awayPenalties: 3, scheduledAt: new Date('2025-08-01T22:00:00Z') } });
  // esporte individual (tênis, EntryMember)
  const TT = await mkT('f2-tenis-' + RUN, { sport: 'TENNIS', format: 'KNOCKOUT' });
  const ct = await cat(TT, 'Simples');
  const eT1 = await mkE(TT, ct, 'Atleta'); const eT2 = await mkE(TT, ct, 'Oponente');
  await prisma.entryMember.create({ data: { entryId: eT1.id, userId: U.athlete.id } });
  await prisma.entryMember.create({ data: { entryId: eT2.id, userId: U.anyone.id } });
  const mT = await prisma.tournamentMatch.create({ data: { tournamentId: TT.id, categoryId: ct.id, stage: 'LEAGUE', round: 1, homeEntryId: eT1.id, awayEntryId: eT2.id, status: 'SCHEDULED' } });
  await finish(mT, 2, 1, eT1.id);
  // liga PRIVADA e liga ARQUIVADA (com gol do atleta) — não podem aparecer em público
  const TP = await mkT('f2-priv-' + RUN, { visibility: 'private', name: 'Liga Secreta ' + RUN });
  const cp = await cat(TP, 'Livre');
  const eP = await mkE(TP, cp, 'Time Secreto'); const eP2 = await mkE(TP, cp, 'Outro Secreto');
  const pP = await prisma.rosterPlayer.create({ data: { entryId: eP.id, name: 'Atleta', userId: U.athlete.id } });
  const mP = await prisma.tournamentMatch.create({ data: { tournamentId: TP.id, categoryId: cp.id, stage: 'LEAGUE', round: 1, homeEntryId: eP.id, awayEntryId: eP2.id, status: 'SCHEDULED' } });
  await prisma.matchEvent.create({ data: { matchId: mP.id, entryId: eP.id, playerId: pP.id, type: 'GOAL' } });
  await prisma.matchEvent.create({ data: { matchId: mP.id, entryId: eP.id, playerId: pP.id, type: 'GOAL' } });
  await finish(mP, 2, 0, eP.id);
  const TA = await mkT('f2-arq-' + RUN, { archivedAt: new Date(), name: 'Liga Arquivada ' + RUN });
  const ca = await cat(TA, 'Livre');
  const eA1 = await mkE(TA, ca, 'Time Arq'); const eA2 = await mkE(TA, ca, 'Outro Arq');
  const pA = await prisma.rosterPlayer.create({ data: { entryId: eA1.id, name: 'Atleta', userId: U.athlete.id } });
  const mA = await prisma.tournamentMatch.create({ data: { tournamentId: TA.id, categoryId: ca.id, stage: 'LEAGUE', round: 1, homeEntryId: eA1.id, awayEntryId: eA2.id, status: 'SCHEDULED' } });
  await prisma.matchEvent.create({ data: { matchId: mA.id, entryId: eA1.id, playerId: pA.id, type: 'GOAL' } });
  await finish(mA, 1, 0, eA1.id);
  // W.O. conta jogo e vitória (como no resto do sistema)
  const mWO = await prisma.tournamentMatch.create({ data: { tournamentId: T1.id, categoryId: c1a.id, stage: 'LEAGUE', round: 4, homeEntryId: eCB1.id, awayEntryId: eAm.id, status: 'SCHEDULED' } });
  await prisma.tournamentMatch.update({ where: { id: mWO.id }, data: { status: 'WALKOVER', winnerEntryId: eCB1.id, scheduledAt: new Date('2026-06-11T22:00:00Z') } });
  // jogo NÃO encerrado não conta
  const mLive = await prisma.tournamentMatch.create({ data: { tournamentId: T1.id, categoryId: c1a.id, stage: 'LEAGUE', round: 2, homeEntryId: eCB1.id, awayEntryId: eAm.id, status: 'LIVE' } });
  await prisma.matchEvent.create({ data: { matchId: mLive.id, entryId: eCB1.id, playerId: pCB.id, type: 'GOAL' } });

  const handle = U.athlete.username;
  const histPublic = async () => (await call('GET', `/api/tournaments/athletes/${handle}/history`)).json;
  const checkCrossLeague = async () => {
    const h = await histPublic();
    assert.strictEqual(h.totals.goals, 2, 'gol da liga 1 + gol da liga 2 = 2 (público): ' + JSON.stringify(h.totals));
    assert.ok(h.tournaments.some((t) => t.tournamentId === T1.id) && h.tournaments.some((t) => t.tournamentId === T2.id));
  };
  const checkPrivateHidden = async () => {
    const h = await histPublic();
    assert.ok(!h.tournaments.some((t) => t.tournamentId === TP.id), 'torneio privado vazou no histórico público');
    assert.ok(!h.tournaments.some((t) => t.tournamentId === TA.id), 'torneio arquivado vazou no histórico público');
  };
  await ok('CRITÉRIO DE PRONTO: gol numa liga + gol em outra liga aparecem juntos no histórico', checkCrossLeague);
  await ok('histórico: jogos/V/E/D, assistência, cartão, por esporte e por temporada (Fortaleza)', async () => {
    const h = await histPublic();
    assert.strictEqual(h.totals.games, 4, JSON.stringify(h.totals)); // T1 + W.O. T1 + final T2 + tênis
    assert.strictEqual(h.totals.wins, 4);
    assert.strictEqual(h.totals.assists, 1);
    assert.strictEqual(h.totals.yellow, 1);
    const fut = h.bySport.find((x) => x.sport === 'FUTSAL');
    const ten = h.bySport.find((x) => x.sport === 'TENNIS');
    assert.strictEqual(fut.games, 3); assert.strictEqual(fut.goals, 2);
    assert.strictEqual(ten.games, 1);
    assert.ok(h.bySeason.some((s) => s.season === 2026 && s.games === 3));
    assert.ok(h.bySeason.some((s) => s.season === 2025 && s.games === 1 && s.titles === 1));
  });
  await ok('títulos: campeão da categoria pela FINAL (pênaltis) conta 1 título', async () => {
    const h = await histPublic();
    assert.strictEqual(h.totals.titles, 1);
    assert.strictEqual(h.titles[0].tournamentId, T2.id);
    assert.strictEqual(h.titles[0].season, 2025);
  });
  await ok('público NÃO mostra torneio privado nem arquivado', checkPrivateHidden);
  await ok('o próprio atleta logado vê o privado (nunca o arquivado); outro usuário não', async () => {
    const mine = (await call('GET', `/api/tournaments/athletes/${handle}/history`, { token: tok(U.athlete) })).json;
    assert.ok(mine.tournaments.some((t) => t.tournamentId === TP.id));
    assert.ok(!mine.tournaments.some((t) => t.tournamentId === TA.id));
    assert.strictEqual(mine.totals.goals, 4);
    assert.strictEqual(mine.includesNonPublic, true);
    const other = (await call('GET', `/api/tournaments/athletes/${handle}/history`, { token: tok(U.anyone) })).json;
    assert.strictEqual(other.totals.goals, 2);
  });
  await ok('card do atleta (futsal) não mostra mais "0 jogos": jogos, gols e títulos', async () => {
    const r = await call('GET', `/api/tournaments/athletes/${handle}/card`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.stats.matchesPlayed, 4, 'inclui o W.O.');
    assert.strictEqual(r.json.stats.goals, 2);
    assert.strictEqual(r.json.stats.titles, 1);
    assert.strictEqual(r.json.stats.tournaments, 3);
  });
  await ok('arte do atleta (og:image pública) usa os números novos e só torneios públicos', async () => {
    const d = await art._buildData({ id: '__none__', slug: '', name: 'Club', bannerUrl: null }, 'atleta', { handle });
    assert.strictEqual(d.athlete.goals, 2);
    assert.strictEqual(d.athlete.matches, 4);
    assert.strictEqual(d.athlete.titles, 1);
    const p = await art.buildArt('club', 'atleta', { handle, formato: 'og' });
    assert.ok(p.png.length > 1000);
  });

  // ============================================ d. fusão de perfis duplicados
  console.log('  — d. fusão de perfis duplicados');
  const codes = [];
  signupCode.setSenderForTests(async (phone, code) => { codes.push({ phone, code }); return { success: true, provider: 'teste' }; });
  const keep = U.athlete;
  const old = await mkUser('perfil antigo', { phone: '83' + String(900000000 + (Date.now() % 90000000)) });
  // dados do perfil antigo
  const pOld = await prisma.rosterPlayer.create({ data: { entryId: eCB1.id, name: 'Atleta (perfil antigo)', number: 99, userId: old.id } });
  const mOld = await prisma.tournamentMatch.create({ data: { tournamentId: T1.id, categoryId: c1a.id, stage: 'LEAGUE', round: 3, homeEntryId: eCB1.id, awayEntryId: eAm.id, status: 'SCHEDULED' } });
  await prisma.matchEvent.create({ data: { matchId: mOld.id, entryId: eCB1.id, playerId: pOld.id, type: 'GOAL' } });
  await finish(mOld, 1, 0, eCB1.id);
  const eTold = await mkE(TT, ct, 'Atleta antigo');
  await prisma.entryMember.create({ data: { entryId: eTold.id, userId: old.id } });
  await prisma.tournamentRole.create({ data: { tournamentId: T3.id, userId: old.id, role: 'REFEREE' } });
  await prisma.athleteRating.create({ data: { userId: old.id, sport: 'TENNIS', rating: 4, matchesCount: 2, wins: 2, losses: 0 } });
  await prisma.athleteRating.create({ data: { userId: keep.id, sport: 'TENNIS', rating: 2, matchesCount: 2, wins: 1, losses: 1 } });
  await prisma.glickoRating.create({ data: { sport: 'TENNIS', format: 'SINGLES', subjectType: 'USER', subjectKey: old.id, userId: old.id } });
  await prisma.medal.create({ data: { serial: 'F2-' + RUN, credentialId: 'urn:uuid:' + crypto.randomUUID(), userId: old.id, issuerId: 'x', templateId: 'y', sport: 'FUTSAL', series: 's', eventName: 'Copa Antiga', tier: 'GOLD', placement: 1, editionNumber: 1, editionTotal: 1, recipientName: 'Atleta', identitySalt: 's', identityHash: 'h', credentialJwt: 'jwt', verificationCode: 'AAAA-BBBB-CCCC', issuedByUserId: U.org.id } });
  const sameName = await mkUser('xará'); await prisma.user.update({ where: { id: sameName.id }, data: { name: keep.name } });

  let reqId;
  await ok('pedido manda código ao WhatsApp do OUTRO perfil (mascarado na resposta)', async () => {
    const r = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(keep), body: { phone: old.phone, method: 'CODE' } });
    assert.strictEqual(r.status, 200, r.text);
    reqId = r.json.requestId;
    assert.ok(/•••• \d{4}/.test(r.json.sentTo));
    assert.ok(!('other' in r.json) && !r.text.includes(old.name), 'não pode devolver dado do outro perfil antes da prova');
    assert.strictEqual(codes.length, 1);
    assert.strictEqual(codes[0].phone, '55' + old.phone);
  });
  await ok('sem confirmação nada muda: código errado = 400 e o perfil antigo segue intacto', async () => {
    const wrong = codes[0].code === '000000' ? '111111' : '000000';
    const r = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(keep), body: { requestId: reqId, code: wrong } });
    assert.strictEqual(r.status, 400, r.text);
    assert.strictEqual((await prisma.user.findUnique({ where: { id: old.id } })).active, true);
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pOld.id } })).userId, old.id);
    // outra pessoa não confirma o pedido alheio
    const alheio = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(U.anyone), body: { requestId: reqId, code: codes[0].code } });
    assert.strictEqual(alheio.status, 404);
  });
  let report;
  await ok('confirma com o código → migra elenco, inscrição, papel, ratings; medalha só no relatório', async () => {
    const r = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(keep), body: { requestId: reqId, code: codes[0].code } });
    assert.strictEqual(r.status, 200, r.text);
    report = r.json.report;
    assert.strictEqual((await prisma.rosterPlayer.findUnique({ where: { id: pOld.id } })).userId, keep.id);
    assert.ok(await prisma.entryMember.findFirst({ where: { entryId: eTold.id, userId: keep.id } }));
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: T3.id, userId: keep.id, role: 'REFEREE' } }));
    const ar = await prisma.athleteRating.findMany({ where: { userId: { in: [keep.id, old.id] }, sport: 'TENNIS' } });
    assert.strictEqual(ar.length, 1);
    assert.strictEqual(ar[0].userId, keep.id);
    assert.strictEqual(ar[0].matchesCount, 4);
    assert.ok(Math.abs(ar[0].rating - 3) < 1e-9, 'média ponderada (2×2 + 4×2)/4 = 3');
    assert.strictEqual(await prisma.glickoRating.count({ where: { subjectType: 'USER', subjectKey: old.id } }), 0);
    const medal = await prisma.medal.findFirst({ where: { serial: 'F2-' + RUN } });
    assert.strictEqual(medal.userId, old.id, 'credencial assinada não muda de titular');
    assert.ok(report.medalsNotMoved.some((m) => m.serial === 'F2-' + RUN));
  });
  await ok('perfil antigo DESATIVADO (não apagado); pedido DONE; auditoria nos torneios; xará intacto', async () => {
    const o = await prisma.user.findUnique({ where: { id: old.id } });
    assert.ok(o, 'não pode apagar');
    assert.strictEqual(o.active, false);
    assert.strictEqual((await prisma.profileMergeRequest.findUnique({ where: { id: reqId } })).status, 'DONE');
    assert.ok(await prisma.tournamentAudit.findFirst({ where: { tournamentId: T1.id, action: 'profile.merge', entityId: old.id } }));
    assert.strictEqual((await prisma.user.findUnique({ where: { id: sameName.id } })).active, true, 'nada de fusão automática por nome');
  });
  await ok('histórico do perfil que ficou soma o gol do perfil antigo', async () => {
    const h = await histPublic();
    assert.strictEqual(h.totals.goals, 3);
  });
  await ok('pedido já usado não confirma de novo', async () => {
    const r = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(keep), body: { requestId: reqId, code: codes[0].code } });
    assert.strictEqual(r.status, 404);
  });
  await ok('"login nos dois": senha errada = 400, senha certa junta', async () => {
    const pinHash = await bcrypt.hash('senha-velha', 10);
    const old2 = await mkUser('perfil antigo 2', { pin: pinHash, username: 'f2old2' + RUN });
    const s1 = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(keep), body: { username: '@' + old2.username, method: 'PASSWORD' } });
    assert.strictEqual(s1.status, 200, s1.text);
    assert.strictEqual(codes.length, 1, 'método senha não manda código');
    const bad = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(keep), body: { requestId: s1.json.requestId, password: 'errada' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await prisma.user.findUnique({ where: { id: old2.id } })).active, true);
    const good = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(keep), body: { requestId: s1.json.requestId, password: 'senha-velha' } });
    assert.strictEqual(good.status, 200, good.text);
    assert.strictEqual((await prisma.user.findUnique({ where: { id: old2.id } })).active, false);
  });
  await ok('bloqueios: saldo TenisCash, conta de equipe e inexistente = MESMA resposta genérica (sem vazar); o próprio 400; anônimo 401', async () => {
    const rich = await mkUser('com saldo', { balance: 10 });
    const staff = await mkUser('vendedor', { role: 'seller' });
    const a = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(U.coord), body: { phone: rich.phone, method: 'PASSWORD' } });
    const b = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(U.coord), body: { phone: staff.phone, method: 'PASSWORD' } });
    const c = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(U.coord), body: { phone: '83999999999', method: 'PASSWORD' } });
    assert.strictEqual(a.status, 400); assert.strictEqual(b.status, 400); assert.strictEqual(c.status, 400);
    assert.strictEqual(a.text, c.text); assert.strictEqual(b.text, c.text);
    assert.strictEqual((await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(keep), body: { username: keep.username, method: 'PASSWORD' } })).status, 400);
    assert.strictEqual((await call('POST', '/api/tournaments/athletes/merge/start', { body: { phone: rich.phone } })).status, 401);
    assert.strictEqual((await prisma.user.findUnique({ where: { id: rich.id } })).balance, 10);
  });

  // ============================================ PROVA DE SABOTAGEM
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
  const access = require('../src/services/tournamentAccess');
  const origNorm = access.normalizeVisibility;
  await sabotage('histórico público passando a mostrar torneio privado',
    () => { access.normalizeVisibility = () => 'public'; },
    checkPrivateHidden,
    () => { access.normalizeVisibility = origNorm; });
  const origClubOfT2 = (await ent(eCBt2)).clubId;
  await sabotage('migração juntando clubes de torneios diferentes',
    () => prisma.tournamentEntry.update({ where: { id: eCBt2.id }, data: { clubId: cbClubId } }),
    async () => { assert.notStrictEqual((await ent(eCB1)).clubId, (await ent(eCBt2)).clubId); },
    () => prisma.tournamentEntry.update({ where: { id: eCBt2.id }, data: { clubId: origClubOfT2 } }));
  await sabotage('migração sem a lista de exclusão (mexeria no Master Cup)',
    async () => { const p = await ci.planMigration(prisma, { onlySlugs: [MC.slug], includeExcluded: true }); await ci.applyMigration(prisma, p); },
    async () => assert.strictEqual(await snapMC(), mcBefore),
    () => prisma.tournamentEntry.updateMany({ where: { tournamentId: MC.id }, data: { clubId: null } }));
  const roles = require('../src/services/tournamentRoles');
  const origCan = roles.can;
  await sabotage('editar clube liberado para qualquer um',
    () => { roles.can = async () => true; },
    async () => assert.strictEqual((await editClub(U.otherAdmin, eCB1, { name: 'Hack' })).status, 403),
    () => { roles.can = origCan; });
  const origCheck = signupCode.checkSignupCode;
  const origMark = signupCode.markSignupCodeUsed;
  const victim = await mkUser('vítima da sabotagem');
  await sabotage('fusão sem conferir o código',
    () => { signupCode.checkSignupCode = async () => ({ ok: true, rowId: 'nenhum' }); signupCode.markSignupCodeUsed = async () => true; },
    async () => {
      const s = await call('POST', '/api/tournaments/athletes/merge/start', { token: tok(U.org2), body: { phone: victim.phone, method: 'CODE' } });
      const r = await call('POST', '/api/tournaments/athletes/merge/confirm', { token: tok(U.org2), body: { requestId: s.json && s.json.requestId, code: '000000' } });
      assert.notStrictEqual(r.status, 200, 'juntou com código errado');
      assert.strictEqual((await prisma.user.findUnique({ where: { id: victim.id } })).active, true);
    },
    async () => { signupCode.checkSignupCode = origCheck; signupCode.markSignupCodeUsed = origMark; await prisma.user.update({ where: { id: victim.id }, data: { active: true } }); });
  await sabotage('convite reutilizável (marca de uso e vaga zeradas → a API reaceitaria o link)',
    async () => {
      await prisma.rosterInvite.updateMany({ where: { rosterPlayerId: pT2.id }, data: { usedAt: null } });
      await prisma.rosterPlayer.update({ where: { id: pT2.id }, data: { userId: null } });
    },
    async () => {
      const r = await call('POST', `/api/tournaments/roster-invites/${inv2.json.token}/claim`, { token: tok(U.anyone) });
      assert.strictEqual(r.status, 410, 'link usado foi aceito de novo: ' + r.status);
    },
    async () => {
      await prisma.rosterInvite.updateMany({ where: { rosterPlayerId: pT2.id }, data: { usedAt: new Date() } });
      await prisma.rosterPlayer.update({ where: { id: pT2.id }, data: { userId: U.athlete.id } });
    });
  signupCode.setSenderForTests(null);

  // ============================================ app real (src/index.js)
  console.log('  — páginas no app real (src/index.js)');
  const PORT = 4300 + Math.floor(Math.random() * 80);
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
    skip('/atleta e /convite-elenco no app real', 'app não subiu: ' + childOut.slice(-400));
  } else {
    await ok('/atleta/:username mostra o histórico público (gols e títulos) sem o torneio privado', async () => {
      const r = await page('/atleta/' + handle);
      assert.strictEqual(r.status, 200, r.text.slice(0, 200));
      assert.ok(r.text.includes('var HIST='), 'histórico embutido');
      assert.ok(r.text.includes('"goals":3'), 'gols públicos (2 + 1 do perfil juntado)');
      assert.ok(!r.text.includes('Liga Secreta'), 'privado vazou na página pública');
      assert.ok(r.text.includes('og:image') && r.text.includes('/arte/atleta.png'));
      assert.ok(/max-width:480px/.test(r.text) && /safe-area-inset-top/.test(r.text) && /min-height:44px/.test(r.text), 'mobile-first');
    });
    await ok('perfil antigo juntado redireciona (302) para o perfil que ficou', async () => {
      const r = await page('/atleta/' + old.id);
      assert.strictEqual(r.status, 302);
      assert.ok(String(r.headers.location).endsWith('/atleta/' + handle));
    });
    await ok('/convite-elenco/:token abre a página mobile-first (480px, 44px, safe-area)', async () => {
      const r = await page('/convite-elenco/' + 'a'.repeat(43));
      assert.strictEqual(r.status, 200);
      assert.ok(/max-width:480px/.test(r.text) && /min-height:4[48]px/.test(r.text) && /safe-area-inset-bottom/.test(r.text));
      assert.ok(r.text.includes('/roster-invites/'));
    });
  }
  child.kill();

  server.close();
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('ERRO FATAL', e); })
  .finally(() => {
    console.log(`\nLiga F2 — identidade: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exit(failed ? 1 : 0);
  });
