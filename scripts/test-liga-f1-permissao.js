'use strict';
// =====================================================================
// Liga Aberta — FASE 1 (permissão única e privacidade). npm run test:liga-f1
//
// Parte 1 (sem banco): matriz de ações do can() e normalização de visibilidade.
// Parte 2 (banco LOCAL descartável — DATABASE_URL em localhost):
//   - MATRIZ: cada papel (fundador, coordenador, árbitro escalado, árbitro não
//     escalado, admin do time, admin de outro time, treinador, jogador, usuário
//     qualquer, anônimo, admin global) × cada ação de escrita (editar torneio,
//     categoria, aprovar inscrição, grupo, gerar chave, resultado, ao vivo,
//     súmula/evento/finalizar, agenda, times do jogo, mural, elenco, logo,
//     treino, papel, arbitragem do jogo, patrocinador, situação, arquivar,
//     restaurar, transferir, pagar prêmio, auditoria, baixa/estorno de inscrição)
//   - jogo sem árbitro escalado: só fundador/coordenador (brecha fechada)
//   - jogo encerrado: árbitro não regrava; coordenação corrige e AUDITA
//   - regerar chave: confirmação; com jogo encerrado só fundador + frase; auditoria
//   - VISIBILIDADE: privado / não listado / arquivado em TODAS as rotas GET
//     (membro × não membro × anônimo; privado = 404 IDÊNTICO ao inexistente;
//     não listado = abre por link e some da vitrine/série/ranking)
//   - página /t/:slug no app real (src/index.js) — privado/arquivado = 404 igual
// Nunca roda contra produção (recusa DATABASE_URL que não seja localhost).
// =====================================================================

const assert = require('assert');
const path = require('path');
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

// HTTP sem keep-alive (Windows + undici deixa socket aberto). stream:true resolve
// no cabeçalho e fecha (SSE).
function httpCall(method, url, headers = {}, body, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = { ...headers, Connection: 'close' };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request(url, { method, headers: h, agent: false }, (res) => {
      if (stream && res.statusCode === 200) { resolve({ status: 200, json: null, text: '', headers: res.headers }); req.destroy(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', (e) => { if (stream && e.code === 'ECONNRESET') return; reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('1. can() e visibilidade (sem banco)');
  const rolesMod = require('../src/services/tournamentRoles');
  await ok('ações novas existem na matriz (DELETE/RESTORE/TRANSFER/MONEY/RESULT/LIVE/POST/CORRECT/AUDIT/SELF)', () => {
    for (const a of ['DELETE_TOURNAMENT', 'RESTORE', 'TRANSFER', 'MONEY', 'RESULT', 'LIVE', 'POST', 'CORRECT_RESULT', 'VIEW_AUDIT', 'REGENERATE_FORCE', 'ASSIGN_LEAD_ROLES', 'SELF']) {
      assert.ok(rolesMod.ACTIONS.includes(a), a);
    }
  });
  const accessMod = require('../src/services/tournamentAccess');
  await ok('normalizeVisibility: public/unlisted/private; lixo cai no padrão', () => {
    assert.strictEqual(accessMod.normalizeVisibility('PRIVATE'), 'private');
    assert.strictEqual(accessMod.normalizeVisibility('unlisted'), 'unlisted');
    assert.strictEqual(accessMod.normalizeVisibility('nao-listado'), 'unlisted');
    assert.strictEqual(accessMod.normalizeVisibility('xyz'), 'public');
    assert.strictEqual(accessMod.normalizeVisibility('xyz', null), null);
    assert.deepStrictEqual(accessMod.LISTED_WHERE, { visibility: 'public', archivedAt: null });
  });
  await ok('nenhuma checagem inline de dono sobrou nas rotas de torneio (can() é a porta)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/tournaments.js'), 'utf8');
    assert.ok(!/loadOwned/.test(src), 'loadOwned ainda existe');
    assert.ok(!/ownerId !== req\.userId/.test(src), 'checagem ownerId inline');
    assert.ok(!/\['admin', 'superadmin', 'manager'\]\.includes\(req\.userRole\)/.test(src), 'checagem de admin inline');
    const media = fs.readFileSync(path.join(__dirname, '../src/routes/tournamentMedia.js'), 'utf8');
    assert.ok(!/visibility === 'private'/.test(media), 'mídia ainda checa visibilidade na mão');
  });

  console.log('2. Rotas com banco descartável');
  const URL_DB = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL_DB) && !/railway|rlwy|amazonaws/i.test(URL_DB);
  if (!isLocal) {
    skip('matriz de permissão, visibilidade, auditoria, chave, arquivar/transferir', 'DATABASE_URL local (localhost) não definido');
    return;
  }
  await dbSuite();
}

async function dbSuite() {
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'teste-liga-f1-' + crypto.randomBytes(8).toString('hex');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { prisma, JWT_SECRET, designIsolationMiddleware } = require('../src/middleware');
  const { ensureApexSchema } = require('../src/services/ensureApexSchema');
  const roles = require('../src/services/tournamentRoles');
  await ensureApexSchema(prisma);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use('/api', designIsolationMiddleware);
  const media = require('../src/routes/tournamentMedia');
  app.use('/api/tournaments', media.apiRouter);
  app.use('/api/public', media.publicRouter);
  app.use('/t', media.pageRouter);
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  app.use(require('../src/routes/tournamentRegistration'));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipSeq = 0;
  const call = (method, url, { token, body, stream } = {}) => {
    const headers = { 'cf-connecting-ip': `203.0.${Math.floor(++ipSeq / 250) % 250}.${ipSeq % 250}` };
    if (token) headers.Authorization = 'Bearer ' + token;
    return httpCall(method, base + url, headers, body, { stream });
  };

  const RUN = Date.now().toString(36);
  let seq = 0;
  const phoneBase = String(Date.now() % 100000).padStart(5, '0');
  const mkUser = (label, role) => prisma.user.create({ data: { name: `F1 ${label} ${RUN}-${++seq}`, phone: '838' + phoneBase + String(seq).padStart(3, '0'), pin: 'x', ...(role ? { role } : {}) } });
  const tok = (u) => (u ? jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '1h' }) : null);

  // ------------------------------------------------------------------ pessoas
  const U = {
    founder: await mkUser('fundador'),
    coord: await mkUser('coordenador'),
    refOn: await mkUser('árbitro escalado'),
    refOff: await mkUser('árbitro não escalado'),
    teamA: await mkUser('admin time A'),
    teamB: await mkUser('admin time B'),
    coachA: await mkUser('treinador A'),
    playerA: await mkUser('jogador A'),
    anyone: await mkUser('qualquer'),
    admin: await mkUser('admin global', 'admin'),
  };
  const target = await mkUser('alvo');
  const target2 = await mkUser('alvo 2');
  const ROLE_NAMES = ['founder', 'coord', 'refOn', 'refOff', 'teamA', 'teamB', 'coachA', 'playerA', 'anyone', 'anon', 'admin'];

  // ------------------------------------------------------------------ torneio
  const t = await prisma.tournament.create({ data: { slug: 'f1-' + RUN, name: 'F1 Liga ' + RUN, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.founder.id, status: 'ONGOING' } });
  const cat = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Livre' } });
  const catGen = await prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: 'Geração' } });
  const mkEntry = (c, name, status = 'CONFIRMED') => prisma.tournamentEntry.create({ data: { tournamentId: t.id, categoryId: c.id, name, status } });
  const eA = await mkEntry(cat, 'Time A');
  const eB = await mkEntry(cat, 'Time B');
  const eC = await mkEntry(cat, 'Time C');
  const ePend = await mkEntry(cat, 'Time Pendente', 'PENDING');
  await mkEntry(catGen, 'Gen 1');
  await mkEntry(catGen, 'Gen 2');
  await prisma.entryMember.create({ data: { entryId: eA.id, userId: U.playerA.id } });
  for (const [u, role, entryId] of [[U.coord, 'COORDINATOR', null], [U.refOn, 'REFEREE', null], [U.refOff, 'REFEREE', null], [U.teamA, 'TEAM_ADMIN', eA.id], [U.teamB, 'TEAM_ADMIN', eB.id], [U.coachA, 'COACH', eA.id], [U.playerA, 'PLAYER', eA.id]]) {
    await prisma.tournamentRole.create({ data: { tournamentId: t.id, userId: u.id, role, entryId } });
  }
  const mkMatch = (home, away, round, ordering) => prisma.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: cat.id, stage: 'LEAGUE', round, ordering, homeEntryId: home.id, awayEntryId: away.id, status: 'SCHEDULED' } });
  const M1 = await mkMatch(eA, eB, 1, 1); // árbitro escalado: refOn
  const M2 = await mkMatch(eA, eC, 2, 1); // SEM ninguém escalado
  await prisma.matchOfficial.create({ data: { matchId: M1.id, userId: U.refOn.id, role: 'REF1' } });
  const pA = await prisma.rosterPlayer.create({ data: { entryId: eA.id, name: 'Artilheiro A', number: 9 } });
  const resetMatch = (m) => prisma.tournamentMatch.update({ where: { id: m.id }, data: { status: 'SCHEDULED', homeScore: null, awayScore: null, winnerEntryId: null, liveState: null } });
  const clearEvents = (m) => prisma.matchEvent.deleteMany({ where: { matchId: m.id } });

  // ------------------------------------------------------------------ MATRIZ
  console.log('  — matriz papel × ação de escrita');
  const ALLOW = (...names) => new Set(names);
  const ORG = ['founder', 'coord', 'admin'];
  const FOUNDER = ['founder', 'admin'];
  const REF_MATCH = ['founder', 'coord', 'refOn', 'admin'];
  const ACTIONS = [
    { name: 'editar torneio', allow: ORG, run: (k) => call('PATCH', `/api/tournaments/${t.id}`, { token: k, body: { description: 'desc ' + RUN } }) },
    { name: 'situação do torneio', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/status`, { token: k, body: { status: 'ONGOING' } }) },
    { name: 'criar categoria', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/categories`, { token: k, body: { name: 'Nova ' + (++seq) } }) },
    { name: 'editar categoria', allow: ORG, run: (k) => call('PATCH', `/api/tournaments/${t.id}/categories/${cat.id}`, { token: k, body: { levelLabel: 'A' } }) },
    { name: 'aprovar inscrição', allow: ORG, reset: () => prisma.tournamentEntry.update({ where: { id: ePend.id }, data: { status: 'PENDING' } }), run: (k) => call('POST', `/api/tournaments/entries/${ePend.id}/approve`, { token: k }) },
    { name: 'definir grupo', allow: ORG, run: (k) => call('POST', `/api/tournaments/entries/${eC.id}/group`, { token: k, body: { groupName: null } }) },
    { name: 'gerar chave', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/categories/${catGen.id}/generate`, { token: k, body: { confirm: true } }) },
    { name: 'resultado (jogo com árbitro escalado)', allow: REF_MATCH, reset: () => resetMatch(M1), run: (k) => call('POST', `/api/tournaments/matches/${M1.id}/result`, { token: k, body: { homeScore: 1, awayScore: 0 } }) },
    { name: 'resultado (jogo SEM árbitro escalado)', allow: ORG, reset: () => resetMatch(M2), run: (k) => call('POST', `/api/tournaments/matches/${M2.id}/result`, { token: k, body: { homeScore: 2, awayScore: 0 } }) },
    { name: 'ao vivo', allow: REF_MATCH, reset: () => resetMatch(M1), run: (k) => call('POST', `/api/tournaments/matches/${M1.id}/live`, { token: k, body: { liveState: { sets: [] }, status: 'LIVE' } }) },
    { name: 'súmula: lançar evento', allow: REF_MATCH, reset: async () => { await resetMatch(M1); await clearEvents(M1); }, run: (k) => call('POST', `/api/tournaments/matches/${M1.id}/events`, { token: k, body: { type: 'GOAL', entryId: eA.id, playerId: pA.id } }) },
    { name: 'súmula: finalizar', allow: REF_MATCH, reset: async () => { await resetMatch(M1); await clearEvents(M1); }, run: (k) => call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: k, body: {} }) },
    { name: 'súmula: finalizar jogo SEM escala', allow: ORG, reset: async () => { await resetMatch(M2); await clearEvents(M2); }, run: (k) => call('POST', `/api/tournaments/matches/${M2.id}/finalize`, { token: k, body: {} }) },
    { name: 'arbitragem da súmula (nomes)', allow: REF_MATCH, reset: () => resetMatch(M1), run: (k) => call('POST', `/api/tournaments/matches/${M1.id}/officials`, { token: k, body: { referee1: 'Fulano' } }) },
    { name: 'agenda do jogo', allow: ORG, run: (k) => call('POST', `/api/tournaments/matches/${M2.id}/schedule`, { token: k, body: { location: 'Ginásio F1' } }) },
    { name: 'times do jogo', allow: ORG, run: (k) => call('POST', `/api/tournaments/matches/${M2.id}/teams`, { token: k, body: { homeEntryId: eA.id } }) },
    { name: 'escalar árbitro no jogo', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/matches/${M2.id}/referees`, { token: k, body: { userId: target2.id, role: 'REF2' } }) },
    { name: 'mural: publicar', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/posts`, { token: k, body: { body: 'aviso ' + RUN } }) },
    { name: 'mural: apagar', allow: ORG, setup: () => prisma.tournamentPost.create({ data: { tournamentId: t.id, authorId: U.founder.id, body: 'apagar' } }), run: (k, post) => call('DELETE', `/api/tournaments/posts/${post.id}`, { token: k }) },
    { name: 'elenco do time A', allow: [...ORG, 'teamA', 'coachA'], run: (k) => call('POST', `/api/tournaments/entries/${eA.id}/players`, { token: k, body: { name: 'Reforço ' + (++seq) } }) },
    { name: 'logo do time A', allow: [...ORG, 'teamA'], run: (k) => call('POST', `/api/tournaments/entries/${eA.id}/logo`, { token: k, body: { logo: null } }) },
    { name: 'treino do time A', allow: [...ORG, 'teamA', 'coachA'], run: (k) => call('POST', `/api/tournaments/${t.id}/teams/${eA.id}/trainings`, { token: k, body: { title: 'Treino F1', scheduledAt: '2026-12-01T19:00' } }) },
    { name: 'dar papel (árbitro)', allow: ORG, reset: () => prisma.tournamentRole.deleteMany({ where: { tournamentId: t.id, userId: target.id } }), run: (k) => call('POST', `/api/tournaments/${t.id}/roles`, { token: k, body: { userId: target.id, role: 'REFEREE' } }) },
    { name: 'dar papel de COORDENADOR', allow: FOUNDER, reset: () => prisma.tournamentRole.deleteMany({ where: { tournamentId: t.id, userId: target.id } }), run: (k) => call('POST', `/api/tournaments/${t.id}/roles`, { token: k, body: { userId: target.id, role: 'COORDINATOR' } }) },
    { name: 'tirar papel (árbitro)', allow: ORG, setup: () => prisma.tournamentRole.create({ data: { tournamentId: t.id, userId: target.id, role: 'REFEREE' } }), run: (k, row) => call('DELETE', `/api/tournaments/${t.id}/roles/${row.id}`, { token: k }), after: () => prisma.tournamentRole.deleteMany({ where: { tournamentId: t.id, userId: target.id } }) },
    { name: 'patrocinador', allow: ORG, run: (k) => call('POST', `/api/tournaments/${t.id}/sponsors`, { token: k, body: { name: 'Patro ' + (++seq) } }) },
    { name: 'pagar prêmio (dinheiro)', allow: FOUNDER, okStatus: [200, 400], run: (k) => call('POST', `/api/tournaments/${t.id}/pay-prize`, { token: k }) },
    { name: 'baixa manual de inscrição paga (dinheiro)', allow: FOUNDER, okStatus: [404], run: (k) => call('POST', `/api/tournament-registration/manage/${t.id}/registrations/inexistente/mark-paid`, { token: k, body: { note: 'x' } }) },
    { name: 'estorno de inscrição paga (dinheiro)', allow: FOUNDER, okStatus: [404], run: (k) => call('POST', `/api/tournament-registration/manage/${t.id}/registrations/inexistente/refund`, { token: k, body: { note: 'x' } }) },
    { name: 'ver auditoria', allow: ORG, deny: [403, 404], run: (k) => call('GET', `/api/tournaments/${t.id}/audit`, { token: k }) },
    { name: 'arquivar (excluir)', allow: FOUNDER, after: () => prisma.tournament.update({ where: { id: t.id }, data: { archivedAt: null, archivedBy: null } }), run: (k) => call('POST', `/api/tournaments/${t.id}/archive`, { token: k, body: { confirm: true } }) },
    { name: 'restaurar', allow: FOUNDER, deny: [403, 404], setup: () => prisma.tournament.update({ where: { id: t.id }, data: { archivedAt: new Date(), archivedBy: U.founder.id } }), after: () => prisma.tournament.update({ where: { id: t.id }, data: { archivedAt: null, archivedBy: null } }), run: (k) => call('POST', `/api/tournaments/${t.id}/restore`, { token: k }) },
    {
      name: 'transferir dono', allow: FOUNDER,
      after: async () => {
        await prisma.tournament.update({ where: { id: t.id }, data: { ownerId: U.founder.id } });
        await prisma.tournamentRole.deleteMany({ where: { tournamentId: t.id, userId: U.founder.id } });
      },
      run: (k) => call('POST', `/api/tournaments/${t.id}/transfer`, { token: k, body: { userId: target2.id } }),
    },
  ];
  const matrix = {};
  for (const a of ACTIONS) {
    const allowSet = ALLOW(...a.allow);
    const okStatus = a.okStatus || null;
    const denyStatus = a.deny || [403];
    const row = {};
    for (const rn of ROLE_NAMES) {
      if (a.reset) await a.reset();
      const ctx = a.setup ? await a.setup() : null;
      const k = rn === 'anon' ? null : tok(U[rn]);
      const r = await a.run(k, ctx);
      if (a.after) await a.after();
      const allowed = allowSet.has(rn);
      let good;
      if (rn === 'anon') good = r.status === 401;
      else if (allowed) good = okStatus ? okStatus.includes(r.status) : r.status >= 200 && r.status < 300;
      else good = denyStatus.includes(r.status);
      row[rn] = (allowed ? 'OK' : 'NEGA') + ':' + r.status + (good ? '' : '!!');
      if (!good) row.__bad = (row.__bad || []).concat(`${rn} → ${r.status} ${r.text.slice(0, 90)}`);
    }
    matrix[a.name] = row;
    await ok(`matriz · ${a.name} (permite: ${a.allow.join(', ')})`, () => { assert.ok(!row.__bad, (row.__bad || []).join(' || ')); });
  }
  console.log('\n  Matriz (OK = permitido, NEGA = negado, :status):');
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + pad('ação', 42) + ROLE_NAMES.map((r) => pad(r, 11)).join(''));
  for (const [name, row] of Object.entries(matrix)) console.log('  ' + pad(name.slice(0, 41), 42) + ROLE_NAMES.map((r) => pad(row[r], 11)).join(''));
  console.log('');

  await ok('PLAYER: o próprio perfil (SELF) sim; o de outro não', async () => {
    assert.strictEqual(await roles.can(U.playerA.id, null, t.id, 'SELF', { targetUserId: U.playerA.id }), true);
    assert.strictEqual(await roles.can(U.playerA.id, null, t.id, 'SELF', { targetUserId: U.anyone.id }), false);
    assert.strictEqual(await roles.can(U.playerA.id, null, t.id, 'MANAGE_TOURNAMENT'), false);
  });
  await ok('my-roles: coordenador sem dinheiro/excluir/transferir; fundador com tudo', async () => {
    const c = (await call('GET', `/api/tournaments/${t.id}/my-roles`, { token: tok(U.coord) })).json.caps;
    assert.strictEqual(c.manageTournament, true);
    assert.strictEqual(c.money, false);
    assert.strictEqual(c.archive, false);
    assert.strictEqual(c.transfer, false);
    const f = (await call('GET', `/api/tournaments/${t.id}/my-roles`, { token: tok(U.founder) })).json.caps;
    assert.ok(f.money && f.archive && f.transfer && f.restore && f.regenerateForce && f.viewAudit);
  });
  await ok('my-matches: árbitro vê SÓ o jogo em que está escalado', async () => {
    const on = (await call('GET', `/api/tournaments/${t.id}/my-matches`, { token: tok(U.refOn) })).json.matches.map((m) => m.id);
    const off = (await call('GET', `/api/tournaments/${t.id}/my-matches`, { token: tok(U.refOff) })).json.matches.map((m) => m.id);
    assert.ok(on.includes(M1.id) && !on.includes(M2.id));
    assert.deepStrictEqual(off, []);
  });

  // ------------------------------------------------------------------ CAMINHO FELIZ + JOGO ENCERRADO
  console.log('  — árbitro escalado fecha a súmula; jogo encerrado; auditoria');
  await resetMatch(M1); await clearEvents(M1); await resetMatch(M2); await clearEvents(M2);
  const auditCount = (action, entityId) => prisma.tournamentAudit.count({ where: { tournamentId: t.id, action, ...(entityId ? { entityId } : {}) } });
  await ok('árbitro escalado (não é dono) lança gol e FECHA a súmula → 200 + auditoria sheet.finalize', async () => {
    const before = await auditCount('sheet.finalize', M1.id);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/events`, { token: tok(U.refOn), body: { type: 'GOAL', entryId: eA.id, playerId: pA.id } })).status, 201);
    const r = await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.refOn), body: {} });
    assert.strictEqual(r.status, 200, r.text);
    const m = await prisma.tournamentMatch.findUnique({ where: { id: M1.id } });
    assert.strictEqual(m.status, 'FINISHED');
    assert.strictEqual(m.homeScore, 1);
    assert.strictEqual(await auditCount('sheet.finalize', M1.id), before + 1);
    const row = await prisma.tournamentAudit.findFirst({ where: { tournamentId: t.id, action: 'sheet.finalize', entityId: M1.id }, orderBy: { createdAt: 'desc' } });
    assert.strictEqual(row.userId, U.refOn.id);
    assert.strictEqual(row.after.homeScore, 1);
    assert.notStrictEqual(row.before.status, 'FINISHED', 'antes = jogo aberto (o 1º gol põe AO VIVO)');
  });
  await ok('usuário qualquer e árbitro NÃO escalado não fecham a súmula (403)', async () => {
    await resetMatch(M1);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.anyone), body: {} })).status, 403);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.refOff), body: {} })).status, 403);
    await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.refOn), body: {} });
  });
  await ok('jogo encerrado: árbitro não regrava (finalizar/resultado/evento/ao vivo = 409)', async () => {
    const st = (await prisma.tournamentMatch.findUnique({ where: { id: M1.id } })).status;
    assert.strictEqual(st, 'FINISHED');
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.refOn), body: {} })).status, 409);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/result`, { token: tok(U.refOn), body: { homeScore: 5, awayScore: 0 } })).status, 409);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/events`, { token: tok(U.refOn), body: { type: 'GOAL', entryId: eA.id, playerId: pA.id } })).status, 409);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M1.id}/live`, { token: tok(U.refOn), body: { status: 'LIVE' } })).status, 409);
    assert.strictEqual((await prisma.tournamentMatch.findUnique({ where: { id: M1.id } })).homeScore, 1, 'placar intacto');
  });
  await ok('coordenação CORRIGE jogo encerrado → result.correct / sheet.correct na auditoria (antes e depois)', async () => {
    const r = await call('POST', `/api/tournaments/matches/${M1.id}/result`, { token: tok(U.coord), body: { homeScore: 3, awayScore: 1 } });
    assert.strictEqual(r.status, 200, r.text);
    const a = await prisma.tournamentAudit.findFirst({ where: { tournamentId: t.id, action: 'result.correct', entityId: M1.id }, orderBy: { createdAt: 'desc' } });
    assert.ok(a, 'auditoria result.correct');
    assert.strictEqual(a.before.homeScore, 1);
    assert.strictEqual(a.after.homeScore, 3);
    assert.strictEqual(a.userId, U.coord.id);
    const f = await call('POST', `/api/tournaments/matches/${M1.id}/finalize`, { token: tok(U.founder), body: {} });
    assert.strictEqual(f.status, 200, f.text);
    assert.ok(await auditCount('sheet.correct', M1.id) >= 1);
  });
  await ok('ao vivo não encerra jogo por fora (status FINISHED via /live = 400)', async () => {
    await resetMatch(M2);
    assert.strictEqual((await call('POST', `/api/tournaments/matches/${M2.id}/live`, { token: tok(U.coord), body: { status: 'FINISHED' } })).status, 400);
  });
  await ok('papel dado/tirado e árbitro escalado ficam na auditoria', async () => {
    assert.ok(await auditCount('role.add') >= 1);
    assert.ok(await auditCount('role.remove') >= 1);
    assert.ok(await auditCount('official.add') >= 1);
  });

  // ------------------------------------------------------------------ REGERAR CHAVE
  console.log('  — gerar chave de novo');
  await ok('regerar sem confirm → 409 CONFIRM_REQUIRED (nada apagado)', async () => {
    const n = await prisma.tournamentMatch.count({ where: { categoryId: catGen.id } });
    assert.ok(n > 0, 'categoria já tem jogos da matriz');
    const r = await call('POST', `/api/tournaments/${t.id}/categories/${catGen.id}/generate`, { token: tok(U.founder), body: {} });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'CONFIRM_REQUIRED');
    assert.strictEqual(await prisma.tournamentMatch.count({ where: { categoryId: catGen.id } }), n);
  });
  await ok('com jogo ENCERRADO: confirm:true → 409 HAS_RESULTS; coordenador com a frase → 403; fundador com a frase → 200 + auditoria', async () => {
    const gm = await prisma.tournamentMatch.findFirst({ where: { categoryId: catGen.id } });
    await prisma.tournamentMatch.update({ where: { id: gm.id }, data: { status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: gm.homeEntryId } });
    const a = await call('POST', `/api/tournaments/${t.id}/categories/${catGen.id}/generate`, { token: tok(U.coord), body: { confirm: true } });
    assert.strictEqual(a.status, 409);
    assert.strictEqual(a.json.code, 'HAS_RESULTS');
    assert.strictEqual(a.json.finishedMatches, 1);
    const b = await call('POST', `/api/tournaments/${t.id}/categories/${catGen.id}/generate`, { token: tok(U.coord), body: { confirm: 'APAGAR RESULTADOS' } });
    assert.strictEqual(b.status, 403);
    assert.ok(await prisma.tournamentMatch.findUnique({ where: { id: gm.id } }), 'jogo encerrado continua lá');
    const before = await auditCount('bracket.generate', catGen.id);
    const c = await call('POST', `/api/tournaments/${t.id}/categories/${catGen.id}/generate`, { token: tok(U.founder), body: { confirm: 'APAGAR RESULTADOS' } });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(await auditCount('bracket.generate', catGen.id), before + 1);
    const row = await prisma.tournamentAudit.findFirst({ where: { tournamentId: t.id, action: 'bracket.generate', entityId: catGen.id }, orderBy: { createdAt: 'desc' } });
    assert.strictEqual(row.after.forced, true);
    assert.strictEqual(row.after.deletedFinished, 1);
    assert.ok(row.after.deletedMatches >= 1);
  });

  // ------------------------------------------------------------------ AUDITORIA paginada
  await ok('GET auditoria paginada (limit + nextCursor) para fundador', async () => {
    const p1 = await call('GET', `/api/tournaments/${t.id}/audit?limit=2`, { token: tok(U.founder) });
    assert.strictEqual(p1.status, 200);
    assert.strictEqual(p1.json.items.length, 2);
    assert.ok(p1.json.nextCursor);
    const p2 = await call('GET', `/api/tournaments/${t.id}/audit?limit=2&cursor=${p1.json.nextCursor}`, { token: tok(U.founder) });
    assert.strictEqual(p2.status, 200);
    assert.ok(!p2.json.items.some((x) => p1.json.items.some((y) => y.id === x.id)), 'páginas não se repetem');
  });

  // ------------------------------------------------------------------ ARQUIVAR / RESTAURAR / TRANSFERIR
  console.log('  — arquivar, restaurar, transferir');
  const tz = await prisma.tournament.create({ data: { slug: 'f1z-' + RUN, name: 'F1 Arquivo ' + RUN, sport: 'FUTSAL', ownerId: U.founder.id, status: 'OPEN' } });
  await ok('arquivar exige confirm; arquivado some (404) até pro fundador nas rotas públicas e aparece em /mine', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/${tz.id}/archive`, { token: tok(U.founder), body: {} })).status, 409);
    assert.strictEqual((await call('DELETE', `/api/tournaments/${tz.id}`, { token: tok(U.founder), body: { confirm: true } })).status, 200);
    for (const k of [null, tok(U.founder), tok(U.anyone)]) assert.strictEqual((await call('GET', `/api/tournaments/${tz.slug}`, { token: k })).status, 404);
    assert.strictEqual((await call('PATCH', `/api/tournaments/${tz.id}`, { token: tok(U.founder), body: { name: 'x' } })).status, 404, 'arquivado não aceita escrita');
    const mine = (await call('GET', '/api/tournaments/mine', { token: tok(U.founder) })).json.tournaments;
    assert.ok(mine.find((x) => x.id === tz.id && x.archivedAt));
    const vit = (await call('GET', '/api/tournaments?limit=100')).json.tournaments;
    assert.ok(!vit.some((x) => x.id === tz.id));
    assert.ok(await auditCount.call(null, 'tournament.archive') >= 0);
    assert.strictEqual(await prisma.tournamentAudit.count({ where: { tournamentId: tz.id, action: 'tournament.archive' } }), 1);
  });
  await ok('restaurar em até 30 dias → volta; depois de 30 dias → 410 e continua arquivado', async () => {
    const r = await call('POST', `/api/tournaments/${tz.id}/restore`, { token: tok(U.founder) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await call('GET', `/api/tournaments/${tz.slug}`)).status, 200);
    await prisma.tournament.update({ where: { id: tz.id }, data: { archivedAt: new Date(Date.now() - 31 * 86400000), archivedBy: U.founder.id } });
    const late = await call('POST', `/api/tournaments/${tz.id}/restore`, { token: tok(U.founder) });
    assert.strictEqual(late.status, 410);
    assert.ok((await prisma.tournament.findUnique({ where: { id: tz.id } })).archivedAt, 'segue arquivado (sem apagar)');
    assert.strictEqual(await prisma.tournamentAudit.count({ where: { tournamentId: tz.id, action: 'tournament.restore' } }), 1);
  });
  await ok('transferir: novo dono vira fundador, antigo vira COORDENADOR (perde dinheiro/excluir), auditoria', async () => {
    const tt = await prisma.tournament.create({ data: { slug: 'f1t-' + RUN, name: 'F1 Transfer ' + RUN, sport: 'FUTSAL', ownerId: U.founder.id } });
    const r = await call('POST', `/api/tournaments/${tt.id}/transfer`, { token: tok(U.founder), body: { phone: target.phone } });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual((await prisma.tournament.findUnique({ where: { id: tt.id } })).ownerId, target.id);
    assert.ok(await prisma.tournamentRole.findFirst({ where: { tournamentId: tt.id, userId: U.founder.id, role: 'COORDINATOR' } }));
    assert.strictEqual(await roles.can(U.founder.id, null, tt.id, 'MANAGE_TOURNAMENT'), true);
    assert.strictEqual(await roles.can(U.founder.id, null, tt.id, 'MONEY'), false);
    assert.strictEqual(await roles.can(U.founder.id, null, tt.id, 'DELETE_TOURNAMENT'), false);
    assert.strictEqual(await roles.can(target.id, null, tt.id, 'TRANSFER'), true);
    const a = await prisma.tournamentAudit.findFirst({ where: { tournamentId: tt.id, action: 'tournament.transfer' } });
    assert.strictEqual(a.before.ownerId, U.founder.id);
    assert.strictEqual(a.after.ownerId, target.id);
    assert.strictEqual((await call('POST', `/api/tournaments/${tt.id}/transfer`, { token: tok(U.founder), body: { userId: U.anyone.id } })).status, 403, 'antigo dono não transfere mais');
  });
  await ok('mudança de visibilidade vai pra auditoria; valor inválido = 400', async () => {
    const tv = await prisma.tournament.create({ data: { slug: 'f1v-' + RUN, name: 'F1 Vis ' + RUN, sport: 'FUTSAL', ownerId: U.founder.id } });
    assert.strictEqual((await call('PATCH', `/api/tournaments/${tv.id}`, { token: tok(U.founder), body: { visibility: 'secreto' } })).status, 400);
    assert.strictEqual((await call('PATCH', `/api/tournaments/${tv.id}`, { token: tok(U.founder), body: { visibility: 'unlisted' } })).status, 200);
    const a = await prisma.tournamentAudit.findFirst({ where: { tournamentId: tv.id, action: 'tournament.visibility' } });
    assert.strictEqual(a.before.visibility, 'public');
    assert.strictEqual(a.after.visibility, 'unlisted');
    const c = await call('POST', '/api/tournaments', { token: tok(U.anyone), body: { name: 'Criado privado ' + RUN, visibility: 'private' } });
    assert.strictEqual(c.status, 201);
    assert.strictEqual(c.json.visibility, 'private');
  });

  // ------------------------------------------------------------------ VISIBILIDADE
  console.log('  — visibilidade em todas as rotas de leitura');
  const PNG = 'data:image/png;base64,' + (await require('sharp')({ create: { width: 8, height: 8, channels: 3, background: '#E5571E' } }).png().toBuffer()).toString('base64');
  async function mkFull(vis, label) {
    const x = await prisma.tournament.create({ data: { slug: `f1${label}-${RUN}`, name: `F1 ${label} ${RUN}`, sport: 'FUTSAL', format: 'ROUND_ROBIN', ownerId: U.founder.id, status: 'ONGOING', visibility: vis, seriesSlug: 'serie-f1-' + RUN, seriesName: 'Série F1' } });
    const c = await prisma.tournamentCategory.create({ data: { tournamentId: x.id, name: 'Cat' } });
    const e1 = await prisma.tournamentEntry.create({ data: { tournamentId: x.id, categoryId: c.id, name: 'Casa ' + label, status: 'CONFIRMED', logoUrl: PNG } });
    const e2 = await prisma.tournamentEntry.create({ data: { tournamentId: x.id, categoryId: c.id, name: 'Fora ' + label, status: 'CONFIRMED' } });
    const m = await prisma.tournamentMatch.create({ data: { tournamentId: x.id, categoryId: c.id, stage: 'LEAGUE', round: 1, ordering: 1, homeEntryId: e1.id, awayEntryId: e2.id, status: 'FINISHED', homeScore: 1, awayScore: 0, winnerEntryId: e1.id, scheduledAt: new Date('2026-12-05T22:00:00Z') } });
    const pl = await prisma.rosterPlayer.create({ data: { entryId: e1.id, name: 'Craque ' + label } });
    await prisma.matchEvent.create({ data: { matchId: m.id, entryId: e1.id, playerId: pl.id, type: 'GOAL' } });
    const sp = await prisma.tournamentSponsor.create({ data: { tournamentId: x.id, name: 'Patro ' + label, logoUrl: PNG } });
    await prisma.tournamentPost.create({ data: { tournamentId: x.id, authorId: U.founder.id, body: 'aviso ' + label } });
    return { t: x, c, e1, e2, m, sp };
  }
  const PRIV = await mkFull('private', 'priv');
  const UNL = await mkFull('unlisted', 'unl');
  const ARC = await mkFull('public', 'arc');
  await prisma.tournament.update({ where: { id: ARC.t.id }, data: { archivedAt: new Date(), archivedBy: U.founder.id } });
  const member = await mkUser('membro do privado');
  await prisma.entryMember.create({ data: { entryId: PRIV.e1.id, userId: member.id } });
  const teamMember = await mkUser('vínculo ativo no time');
  await prisma.teamMembership.create({ data: { tournamentId: PRIV.t.id, clubName: PRIV.e1.name, userId: teamMember.id, status: 'ACTIVE' } });
  const outsider = await mkUser('não membro');
  const GHOST = { t: { id: 'nao-existe-' + RUN, slug: 'nao-existe-' + RUN }, c: { id: 'cat-x' }, e1: { id: 'entry-x' }, m: { id: 'match-x' }, sp: { id: 'sp-x' } };

  // rota → função(set, viewerKind) ; ghostKey: com qual "inexistente" comparar o 404
  const READS = [
    ['GET torneio por id', (S) => `/api/tournaments/${S.t.id}`],
    ['GET torneio por slug', (S) => `/api/tournaments/${S.t.slug}`],
    ['categorias', (S) => `/api/tournaments/${S.t.id}/categories`],
    ['inscritos', (S) => `/api/tournaments/${S.t.id}/entries`],
    ['jogos da categoria', (S) => `/api/tournaments/${S.t.id}/categories/${S.c.id}/matches`],
    ['classificação', (S) => `/api/tournaments/${S.t.id}/categories/${S.c.id}/standings`],
    ['súmula', (S) => `/api/tournaments/matches/${S.m.id}/sheet`],
    ['suspensões', (S) => `/api/tournaments/${S.t.id}/suspensions`],
    ['estatísticas', (S) => `/api/tournaments/${S.t.id}/stats/scorers`],
    ['mural (posts)', (S) => `/api/tournaments/${S.t.slug}/posts`],
    ['elenco', (S) => `/api/tournaments/entries/${S.e1.id}/players`],
    ['patrocinadores', (S) => `/api/tournaments/${S.t.id}/sponsors`],
    ['arte PNG', (S) => `/api/tournaments/${S.t.id}/arte/torneio.png?formato=quadrado`],
    ['QR', (S) => `/api/tournaments/${S.t.id}/qr.png`],
    ['ao vivo (SSE)', (S) => `/api/tournaments/${S.t.id}/live`, { stream: true }],
    ['API pública', (S) => `/api/public/tournaments/${S.t.slug}`],
    ['escudo público', (S) => `/api/public/entries/${S.e1.id}/logo`],
    ['logo de patrocinador', (S) => `/api/public/sponsors/${S.sp.id}/logo`],
    ['calendário ICS', (S) => `/t/${S.t.slug}/calendario.ics`],
    ['telão', (S) => `/t/${S.t.slug}/telao`],
    ['embed', (S) => `/t/${S.t.slug}/embed`],
    ['inscrição pública', (S) => `/api/tournament-registration/public/${S.t.slug}`],
  ];
  for (const [name, path_, opts] of READS) {
    await ok(`privado · ${name}: membro 200; não membro e anônimo = 404 IDÊNTICO ao inexistente`, async () => {
      const ghost = await call('GET', path_(GHOST), { stream: opts && opts.stream });
      assert.strictEqual(ghost.status, 404, 'inexistente deveria ser 404: ' + ghost.status);
      for (const k of [tok(member), tok(U.founder), tok(U.admin)]) {
        const r = await call('GET', path_(PRIV), { token: k, stream: opts && opts.stream });
        assert.strictEqual(r.status, 200, `membro/fundador/admin: ${r.status} ${r.text.slice(0, 120)}`);
      }
      for (const k of [tok(outsider), null]) {
        const r = await call('GET', path_(PRIV), { token: k, stream: opts && opts.stream });
        assert.strictEqual(r.status, 404, `não membro: ${r.status}`);
        assert.strictEqual(r.text, ghost.text, 'corpo diferente do inexistente (vaza existência)');
      }
    });
    await ok(`não listado · ${name}: abre por link (anônimo 200)`, async () => {
      const r = await call('GET', path_(UNL), { stream: opts && opts.stream });
      assert.strictEqual(r.status, 200, `${r.status} ${r.text.slice(0, 120)}`);
    });
    await ok(`arquivado · ${name}: 404 idêntico (até pro fundador)`, async () => {
      const ghost = await call('GET', path_(GHOST), { stream: opts && opts.stream });
      for (const k of [null, tok(U.founder)]) {
        const r = await call('GET', path_(ARC), { token: k, stream: opts && opts.stream });
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.text, ghost.text);
      }
    });
  }
  await ok('privado: atleta com vínculo ATIVO no time também é membro (200)', async () => {
    assert.strictEqual((await call('GET', `/api/tournaments/${PRIV.t.id}`, { token: tok(teamMember) })).status, 200);
  });
  await ok('categoria de torneio privado não vaza por baixo de torneio público', async () => {
    const r = await call('GET', `/api/tournaments/${UNL.t.id}/categories/${PRIV.c.id}/matches`);
    assert.strictEqual(r.status, 404);
  });
  await ok('vitrine e busca: só público (não listado, privado e arquivado fora)', async () => {
    const vit = (await call('GET', '/api/tournaments?limit=100&sport=FUTSAL')).json.tournaments.map((x) => x.id);
    assert.ok(!vit.includes(UNL.t.id) && !vit.includes(PRIV.t.id) && !vit.includes(ARC.t.id));
  });
  await ok('série (histórico público) e ranking de artilharia do esporte: só torneio público', async () => {
    const s = (await call('GET', `/api/tournaments/series/serie-f1-${RUN}/champions`)).json;
    assert.deepStrictEqual(s.editions, []);
    const rk = (await call('GET', '/api/tournaments/rankings/FUTSAL/scorers')).json;
    const names = JSON.stringify(rk);
    assert.ok(!/Craque (priv|unl|arc)/.test(names), 'ranking público mostrou jogador de torneio não público');
  });
  await ok('privado: não membro não inscreve nem pede vaga (404); membro do time pede', async () => {
    assert.strictEqual((await call('POST', `/api/tournaments/${PRIV.t.id}/entries`, { token: tok(outsider), body: { categoryId: PRIV.c.id } })).status, 404);
    assert.strictEqual((await call('POST', `/api/tournaments/${PRIV.t.id}/entries/request`, { token: tok(outsider), body: { categoryId: PRIV.c.id } })).status, 404);
    assert.strictEqual((await call('GET', `/api/tournaments/${PRIV.t.id}/teams`, { token: tok(outsider) })).status, 404);
    assert.strictEqual((await call('GET', `/api/tournaments/${PRIV.t.id}/teams`, { token: tok(member) })).status, 200);
  });

  // ------------------------------------------------------------------ PÁGINA /t/:slug no app real
  console.log('  — página pública /t/:slug no app real (src/index.js)');
  const PORT = 4100 + Math.floor(Math.random() * 80);
  const child = spawn(process.execPath, [path.join(__dirname, '../src/index.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', TREG_SWEEPER: 'off', RNA_ATIVA: '0', RNA_RELOGIO: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errTail = '';
  child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
  const page = (p) => httpCall('GET', `http://127.0.0.1:${PORT}${p}`, {});
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { const r = await page('/api/health'); up = r.status === 200; } catch (_) { /* subindo */ }
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) {
    failed++;
    console.error('  ❌ app real não subiu: ' + errTail.slice(-600));
  } else {
    await ok('/t/:slug — público/não listado 200 (não listado com noindex); privado e arquivado = 404 igual ao inexistente', async () => {
      const ghost = await page(`/t/${GHOST.t.slug}`);
      assert.strictEqual(ghost.status, 404);
      const pub = await page(`/t/${t.slug}`);
      assert.strictEqual(pub.status, 200);
      const unl = await page(`/t/${UNL.t.slug}`);
      assert.strictEqual(unl.status, 200);
      assert.match(String(unl.headers['x-robots-tag'] || ''), /noindex/);
      for (const S of [PRIV, ARC]) {
        const r = await page(`/t/${S.t.slug}`);
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.text, ghost.text);
        assert.ok(!r.text.includes(S.t.name), 'nome do torneio vazou');
      }
    });
    await ok('app real: GET /api/tournaments/:id privado com token de membro (designIsolation) 200; sem token 404', async () => {
      const k = tok(member);
      const a = await httpCall('GET', `http://127.0.0.1:${PORT}/api/tournaments/${PRIV.t.id}`, { Authorization: 'Bearer ' + k });
      assert.strictEqual(a.status, 200, a.text.slice(0, 120));
      const b = await page(`/api/tournaments/${PRIV.t.id}`);
      assert.strictEqual(b.status, 404);
    });
  }
  try { child.kill(); } catch (_) { /* */ }

  // ------------------------------------------------------------------ limpeza
  const tids = (await prisma.tournament.findMany({ where: { slug: { contains: RUN } }, select: { id: true } })).map((x) => x.id);
  const createdByAnyone = await prisma.tournament.findMany({ where: { ownerId: { in: Object.values(U).map((u) => u.id).concat([target.id, target2.id]) } }, select: { id: true } });
  const all = [...new Set(tids.concat(createdByAnyone.map((x) => x.id)))];
  const matchIds = (await prisma.tournamentMatch.findMany({ where: { tournamentId: { in: all } }, select: { id: true } })).map((m) => m.id);
  const entryIds = (await prisma.tournamentEntry.findMany({ where: { tournamentId: { in: all } }, select: { id: true } })).map((e) => e.id);
  await prisma.matchEvent.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.matchOfficial.deleteMany({ where: { matchId: { in: matchIds } } });
  await prisma.rosterPlayer.deleteMany({ where: { entryId: { in: entryIds } } });
  await prisma.tournamentAudit.deleteMany({ where: { tournamentId: { in: all } } });
  await prisma.tournamentRole.deleteMany({ where: { tournamentId: { in: all } } });
  await prisma.teamMembership.deleteMany({ where: { tournamentId: { in: all } } });
  await prisma.trainingSession.deleteMany({ where: { tournamentId: { in: all } } }).catch(() => {});
  await prisma.tournamentSponsor.deleteMany({ where: { tournamentId: { in: all } } });
  await prisma.tournament.deleteMany({ where: { id: { in: all } } }).catch((e) => console.log('  (limpeza parcial: ' + e.message.slice(0, 80) + ')'));

  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
}

main()
  .catch((e) => { failed++; console.error('💥', e); })
  .finally(() => {
    console.log(`\nLiga Aberta F1 — permissão e privacidade: ${passed} ok, ${failed} falha(s), ${skipped} pulado(s)`);
    process.exitCode = failed ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 3000).unref();
  });
