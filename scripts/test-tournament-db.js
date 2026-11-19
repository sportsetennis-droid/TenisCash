'use strict';
// =====================================================================
// Teste de INTEGRAÇÃO do motor de campeonato com banco DESCARTÁVEL.
// NUNCA roda contra produção: exige DATABASE_URL apontando pra localhost.
//
//   DATABASE_URL=postgresql://postgres@localhost:55432/club_f1 \
//   DATABASE_URL_OLD=postgresql://postgres@localhost:55432/club_f1_old \
//   node scripts/test-tournament-db.js
//
// club_f1      = schema NOVO (prisma db push)            → fluxos completos + HTTP
// club_f1_old  = schema do MAIN (sem as colunas novas)   → prova que o SQL aditivo
//                do ensureApexSchema cria tudo e o client novo funciona em cima.
// =====================================================================

const assert = require('assert');
const http = require('http');

const URL_NEW = process.env.DATABASE_URL || '';
const URL_OLD = process.env.DATABASE_URL_OLD || '';
const isLocal = (u) => /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(u) && !/railway|rlwy|amazonaws/i.test(u);
if (!isLocal(URL_NEW)) {
  console.error('❌ DATABASE_URL precisa ser um banco LOCAL descartável (localhost). Abortado.');
  process.exit(2);
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const engine = require('../src/services/tournamentEngine');
const sheet = require('../src/services/matchSheet');
const discipline = require('../src/services/tournamentDiscipline');
const { ensureApexSchema } = require('../src/services/ensureApexSchema');

let passed = 0;
let failed = 0;
async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    failed++;
    console.error('  ❌ ' + name + ' → ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
}

const RUN = Date.now().toString(36);
let seq = 0;
const uid = (p) => `${p}-${RUN}-${++seq}`;

async function mkUser(role = 'admin') {
  return prisma.user.create({ data: { name: uid('User'), phone: uid('ph'), pin: 'x', role } });
}
async function mkTournament(owner, extra = {}) {
  return prisma.tournament.create({
    data: { slug: uid('t'), name: extra.name || uid('Torneio'), sport: 'FUTSAL', format: 'KNOCKOUT', ownerId: owner.id, ...extra },
  });
}
async function mkCat(t, data = {}) {
  return prisma.tournamentCategory.create({ data: { tournamentId: t.id, name: uid('Cat'), ...data } });
}
async function mkEntries(t, cat, names) {
  const out = [];
  for (let i = 0; i < names.length; i++) {
    out.push(
      await prisma.tournamentEntry.create({
        data: { tournamentId: t.id, categoryId: cat.id, name: names[i], seed: i + 1, status: 'CONFIRMED' },
      })
    );
  }
  return out;
}
const matchesOf = (categoryId, where = {}) =>
  prisma.tournamentMatch.findMany({ where: { categoryId, ...where }, orderBy: [{ round: 'asc' }, { ordering: 'asc' }] });
const standingsOf = async (categoryId) =>
  prisma.tournamentStanding.findMany({ where: { categoryId }, orderBy: [{ groupName: 'asc' }, { rank: 'asc' }] });
const nameOf = (entries) => Object.fromEntries(entries.map((e) => [e.id, e.name]));

// Joga o jogo entre dois times pelo nome (acha a partida da tabela)
async function playByNames(cat, E, h, a, hs, as) {
  const byName = Object.fromEntries(E.map((e) => [e.name, e.id]));
  let m = await prisma.tournamentMatch.findFirst({ where: { categoryId: cat.id, homeEntryId: byName[h], awayEntryId: byName[a], status: { not: 'FINISHED' } } });
  if (!m) {
    m = await prisma.tournamentMatch.findFirst({ where: { categoryId: cat.id, homeEntryId: byName[a], awayEntryId: byName[h], status: { not: 'FINISHED' } } });
    if (!m) throw new Error(`jogo ${h}×${a} não existe`);
    const r = await engine.applyMatchResult(m.id, { homeScore: as, awayScore: hs });
    assert.ok(r.ok, r.error);
    return m;
  }
  const r = await engine.applyMatchResult(m.id, { homeScore: hs, awayScore: as });
  assert.ok(r.ok, r.error);
  return m;
}

async function main() {
  // ===================================================================
  console.log('ensureApexSchema (SQL aditivo)');
  await ok('no banco NOVO: idempotente, todos os statements passam', async () => {
    const { STATEMENTS_COUNT } = { STATEMENTS_COUNT: null };
    void STATEMENTS_COUNT;
    const n1 = await ensureApexSchema(prisma);
    const n2 = await ensureApexSchema(prisma);
    assert.strictEqual(n1, n2);
    const total = require('../src/services/ensureApexSchema').STATEMENTS_TOTAL();
    assert.strictEqual(n1, total, `${n1}/${total} aplicados`);
  });
  if (isLocal(URL_OLD)) {
    await ok('no banco com schema do MAIN: cria colunas/tabela novas e o client novo funciona', async () => {
      const old = new PrismaClient({ datasources: { db: { url: URL_OLD } } });
      try {
        const before = await old.$queryRawUnsafe(
          `SELECT column_name FROM information_schema.columns WHERE table_name='TournamentCategory' AND column_name='tiebreakers'`
        );
        assert.strictEqual(before.length, 0, 'banco antigo já tinha a coluna (não prova nada)');
        const n = await ensureApexSchema(old);
        assert.ok(n > 0);
        const cols = await old.$queryRawUnsafe(`SELECT table_name, column_name FROM information_schema.columns
          WHERE (table_name, column_name) IN (('Tournament','seriesSlug'),('Tournament','seriesName'),('Tournament','edition'),
          ('TournamentCategory','tiebreakers'),('TournamentCategory','tiebreakSeed'),('TournamentCategory','doubleRound'),
          ('TournamentCategory','suspensionRule'),('TournamentCategory','formatConfig'),('TournamentMatch','bracket'),
          ('TournamentMatch','loserNextMatchId'),('TournamentMatch','loserNextSlot'),('TournamentMatch','homeEntry2Id'),
          ('TournamentMatch','awayEntry2Id'),('TournamentMatch','lineup'),('TournamentStanding','fairPlay'),('TournamentStanding','tiebreak'))`);
        assert.strictEqual(cols.length, 16, 'colunas criadas: ' + cols.length);
        // client NOVO lê/escreve em cima do banco antigo migrado
        const u = await old.user.create({ data: { name: uid('U'), phone: uid('p'), pin: 'x', role: 'admin' } });
        const t = await old.tournament.create({ data: { slug: uid('t'), name: 'x', sport: 'FUTSAL', ownerId: u.id, seriesSlug: 'serie-x', edition: '2026' } });
        const c = await old.tournamentCategory.create({ data: { tournamentId: t.id, name: 'c', tiebreakers: ['POINTS', 'HEAD_TO_HEAD'], doubleRound: true, suspensionRule: { yellowLimit: 2 } } });
        await old.tournamentMatch.create({ data: { tournamentId: t.id, categoryId: c.id, bracket: 'W', lineup: { a: ['b'] } } });
        await old.suspensionOverride.create({ data: { tournamentId: t.id, matchId: 'm', playerId: 'p', entryId: 'e', action: 'EVENT', reason: 'teste' } });
        const back = await old.tournamentCategory.findUnique({ where: { id: c.id } });
        assert.deepStrictEqual(back.tiebreakers, ['POINTS', 'HEAD_TO_HEAD']);
        // idempotente no banco antigo também
        const n2 = await ensureApexSchema(old);
        assert.strictEqual(n, n2);
      } finally {
        await old.$disconnect();
      }
    });
  } else {
    console.log('  (DATABASE_URL_OLD ausente — pulando a prova no schema antigo)');
  }

  const owner = await mkUser('admin');

  // ===================================================================
  console.log('pontos corridos — ida e volta + desempate configurável');
  await ok('ida e volta: 4 times = 12 jogos, cada confronto 2x com mando invertido', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'ROUND_ROBIN', doubleRound: true });
    await mkEntries(t, cat, ['A', 'B', 'C', 'D']);
    const r = await engine.generateFixtures(cat.id);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.matchesCreated, 12);
    const ms = await matchesOf(cat.id);
    const k = new Set(ms.map((m) => m.homeEntryId + '>' + m.awayEntryId));
    assert.strictEqual(k.size, 12);
    for (const m of ms) assert.ok(k.has(m.awayEntryId + '>' + m.homeEntryId));
    assert.strictEqual(Math.max(...ms.map((m) => m.round)), 6);
  });

  await ok('padrão (sem config) = classificação idêntica ao motor antigo', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'ROUND_ROBIN' });
    const E = await mkEntries(t, cat, ['A', 'B', 'C', 'D', 'E']);
    await engine.generateFixtures(cat.id);
    const ms = await matchesOf(cat.id);
    const scores = [[2, 1], [0, 0], [3, 3], [1, 2], [4, 0], [1, 1], [0, 2], [2, 2], [5, 1], [0, 1]];
    for (let i = 0; i < ms.length; i++) await engine.applyMatchResult(ms[i].id, { homeScore: scores[i][0], awayScore: scores[i][1] });
    const st = await standingsOf(cat.id);
    const old = st
      .slice()
      .sort((x, y) => y.points - x.points || y.scoreFor - y.scoreAgainst - (x.scoreFor - x.scoreAgainst) || y.scoreFor - x.scoreFor);
    // as posições gravadas batem com o comparador antigo (critério por critério)
    for (let i = 0; i < st.length; i++) {
      const a = st[i];
      const b = old[i];
      assert.deepStrictEqual([a.points, a.scoreFor - a.scoreAgainst, a.scoreFor], [b.points, b.scoreFor - b.scoreAgainst, b.scoreFor]);
    }
    assert.strictEqual(E.length, st.length);
  });

  let h2hCat = null;
  let h2hT = null;
  await ok('confronto direto com 3 empatados (mini-tabela) e troca de critério recalcula', async () => {
    h2hT = await mkTournament(owner);
    h2hCat = await mkCat(h2hT, { format: 'ROUND_ROBIN', tiebreakers: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'] });
    const E = await mkEntries(h2hT, h2hCat, ['A', 'B', 'C', 'D']);
    await engine.generateFixtures(h2hCat.id);
    await playByNames(h2hCat, E, 'A', 'B', 1, 0);
    await playByNames(h2hCat, E, 'C', 'B', 1, 0);
    await playByNames(h2hCat, E, 'D', 'B', 10, 0);
    await playByNames(h2hCat, E, 'A', 'C', 1, 0);
    await playByNames(h2hCat, E, 'C', 'D', 9, 0);
    await playByNames(h2hCat, E, 'D', 'A', 3, 0);
    const N = nameOf(E);
    let st = await standingsOf(h2hCat.id);
    assert.deepStrictEqual(st.map((s) => N[s.entryId]), ['C', 'A', 'D', 'B']);
    assert.strictEqual(st[0].tiebreak, 'HEAD_TO_HEAD');
    await prisma.tournamentCategory.update({ where: { id: h2hCat.id }, data: { tiebreakers: ['POINTS', 'GOAL_DIFF'] } });
    await engine.recomputeStandings(h2hCat.id);
    st = await standingsOf(h2hCat.id);
    assert.deepStrictEqual(st.map((s) => N[s.entryId]), ['C', 'D', 'A', 'B']);
  });

  await ok('SORTEIO: semente gerada 1x, gravada e estável entre recálculos', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'ROUND_ROBIN', tiebreakers: ['POINTS', 'DRAW'] });
    await mkEntries(t, cat, ['A', 'B', 'C', 'D']);
    await engine.generateFixtures(cat.id);
    for (const m of await matchesOf(cat.id)) await engine.applyMatchResult(m.id, { homeScore: 1, awayScore: 1 });
    const c1 = await prisma.tournamentCategory.findUnique({ where: { id: cat.id } });
    assert.ok(c1.tiebreakSeed && c1.tiebreakSeed.length >= 8);
    const o1 = (await standingsOf(cat.id)).map((s) => s.entryId).join();
    await engine.recomputeStandings(cat.id);
    const c2 = await prisma.tournamentCategory.findUnique({ where: { id: cat.id } });
    assert.strictEqual(c2.tiebreakSeed, c1.tiebreakSeed);
    assert.strictEqual((await standingsOf(cat.id)).map((s) => s.entryId).join(), o1);
    assert.ok((await standingsOf(cat.id)).every((s) => s.tiebreak === 'DRAW'));
  });

  await ok('grupos com ida e volta: 2 grupos de 3 = 12 jogos', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'GROUPS', doubleRound: true });
    await mkEntries(t, cat, ['A', 'B', 'C', 'D', 'E', 'F']);
    const r = await engine.generateFixtures(cat.id, { groupCount: 2 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.matchesCreated, 12);
  });

  // ===================================================================
  console.log('súmula — fair play, suspensão automática e bloqueio');
  const tS = await mkTournament(owner, { name: 'Copa Disciplina' });
  const catS = await mkCat(tS, { format: 'ROUND_ROBIN', doubleRound: true, tiebreakers: ['POINTS', 'GOAL_DIFF', 'FAIR_PLAY'], suspensionRule: { enabled: true } });
  const ES = await mkEntries(tS, catS, ['Leões', 'Tigres', 'Falcões', 'Lobos']);
  await engine.generateFixtures(catS.id);
  const NS = nameOf(ES);
  const leoes = ES[0];
  const pZe = await prisma.rosterPlayer.create({ data: { entryId: leoes.id, name: 'Zé Suspenso', number: 10 } });
  const pOutro = await prisma.rosterPlayer.create({ data: { entryId: leoes.id, name: 'Outro', number: 7 } });
  // agenda os jogos dos Leões em ordem cronológica
  const leoesMatches = (await matchesOf(catS.id)).filter((m) => m.homeEntryId === leoes.id || m.awayEntryId === leoes.id);
  for (let i = 0; i < leoesMatches.length; i++) {
    await prisma.tournamentMatch.update({ where: { id: leoesMatches[i].id }, data: { scheduledAt: new Date(Date.UTC(2026, 10, 1 + i, 22)) } });
  }
  const goal = (m, e, p) => sheet.addEvent(m, { type: 'GOAL', entryId: e, playerId: p }, { canOverride: true });

  await ok('3 amarelos em 3 jogos ENCERRADOS → suspenso no 4º; bloqueia evento sem liberação', async () => {
    for (let i = 0; i < 3; i++) {
      const m = leoesMatches[i];
      const r = await sheet.addEvent(m.id, { type: 'YELLOW', entryId: leoes.id, playerId: pZe.id });
      assert.ok(r.ok, r.error);
      await goal(m.id, leoes.id, pOutro.id);
      const f = await sheet.finalizeMatch(m.id);
      assert.ok(f.ok, f.error);
    }
    const s = await discipline.tournamentSuspensions(tS.id, catS.id);
    assert.strictEqual(s.suspended.length, 1);
    assert.strictEqual(s.suspended[0].playerId, pZe.id);
    assert.deepStrictEqual(s.suspended[0].matchIds, [leoesMatches[3].id]);
    assert.match(s.suspended[0].reasonText, /3 amarelos/);
    const blocked = await sheet.addEvent(leoesMatches[3].id, { type: 'GOAL', entryId: leoes.id, playerId: pZe.id }, { canOverride: true });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'SUSPENDED');
    // o companheiro NÃO suspenso lança normal
    assert.ok((await goal(leoesMatches[3].id, leoes.id, pOutro.id)).ok);
  });
  await ok('liberação: sem permissão nega; sem motivo nega; árbitro com motivo libera e AUDITA', async () => {
    const mid = leoesMatches[3].id;
    const a = await sheet.addEvent(mid, { type: 'GOAL', entryId: leoes.id, playerId: pZe.id, overrideSuspension: true, overrideReason: 'efeito suspensivo' }, { canOverride: false });
    assert.strictEqual(a.code, 'OVERRIDE_DENIED');
    const b = await sheet.addEvent(mid, { type: 'GOAL', entryId: leoes.id, playerId: pZe.id, overrideSuspension: true, overrideReason: 'x' }, { canOverride: true, userId: owner.id });
    assert.strictEqual(b.code, 'REASON_REQUIRED');
    const c = await sheet.addEvent(mid, { type: 'GOAL', entryId: leoes.id, playerId: pZe.id, overrideSuspension: true, overrideReason: 'efeito suspensivo do TJD' }, { canOverride: true, userId: owner.id });
    assert.ok(c.ok, c.error);
    const audit = await prisma.suspensionOverride.findMany({ where: { matchId: mid } });
    assert.strictEqual(audit.length, 1);
    assert.strictEqual(audit[0].reason, 'efeito suspensivo do TJD');
    assert.strictEqual(audit[0].userId, owner.id);
    assert.strictEqual(audit[0].action, 'EVENT');
    // remove o gol liberado pra seguir o roteiro
    await sheet.deleteEvent(c.event.id);
  });
  await ok('escalação: suspenso bloqueado (treinador não libera); árbitro libera com motivo', async () => {
    const mid = leoesMatches[3].id;
    const a = await sheet.setLineup(mid, { entryId: leoes.id, playerIds: [pOutro.id, pZe.id] }, { canOverride: false });
    assert.strictEqual(a.code, 'SUSPENDED');
    const b = await sheet.setLineup(mid, { entryId: leoes.id, playerIds: [pOutro.id, pZe.id], overrideSuspension: true, overrideReason: 'liminar' }, { canOverride: false });
    assert.strictEqual(b.code, 'OVERRIDE_DENIED');
    const ok1 = await sheet.setLineup(mid, { entryId: leoes.id, playerIds: [pOutro.id] }, { canOverride: false });
    assert.ok(ok1.ok, ok1.error);
    const c = await sheet.setLineup(mid, { entryId: leoes.id, playerIds: [pOutro.id, pZe.id], overrideSuspension: true, overrideReason: 'liminar da federação' }, { canOverride: true, userId: owner.id });
    assert.ok(c.ok, c.error);
    assert.deepStrictEqual(c.lineup[leoes.id], [pOutro.id, pZe.id]);
    const audit = await prisma.suspensionOverride.findMany({ where: { matchId: mid, action: 'LINEUP' } });
    assert.strictEqual(audit.length, 1);
    // tira ele de novo (remover não exige liberação)
    const d = await sheet.setLineup(mid, { entryId: leoes.id, playerIds: [pOutro.id] }, { canOverride: false });
    assert.ok(d.ok);
  });
  await ok('súmula mostra o suspenso do jogo; ranking OFICIAL ignora jogo aberto e "ao vivo" marca parcial', async () => {
    const s = await sheet.buildSheet(leoesMatches[3].id);
    assert.ok(s.suspensions.some((x) => x.playerId === pZe.id));
    const official = await sheet.playerStats(tS.id, { kind: 'scorers', categoryId: catS.id });
    const live = await sheet.playerStats(tS.id, { kind: 'scorers', categoryId: catS.id, scope: 'live' });
    const o = official.find((r) => r.playerId === pOutro.id);
    const l = live.find((r) => r.playerId === pOutro.id);
    assert.strictEqual(o.goals, 3, 'oficial = 3 gols de jogos encerrados');
    assert.strictEqual(l.goals, 4, 'ao vivo soma o gol do jogo aberto');
    assert.strictEqual(l.partial, true);
    assert.strictEqual(l.live.goals, 1);
    assert.ok(!o.partial);
  });
  await ok('cumpriu a suspensão (4º jogo encerrado) → liberado; cartões entram no fair play', async () => {
    const f = await sheet.finalizeMatch(leoesMatches[3].id);
    assert.ok(f.ok, f.error);
    const s = await discipline.tournamentSuspensions(tS.id, catS.id);
    assert.strictEqual(s.suspended.length, 0);
    const st = await standingsOf(catS.id);
    const le = st.find((x) => x.entryId === leoes.id);
    assert.strictEqual(le.fairPlay, 3, '3 amarelos = 3 pontos de cartão');
    assert.ok(NS[leoes.id]);
  });
  await ok('vermelho = 1 jogo de suspensão', async () => {
    const m5 = leoesMatches[4];
    await sheet.addEvent(m5.id, { type: 'RED', entryId: leoes.id, playerId: pOutro.id });
    await sheet.finalizeMatch(m5.id);
    const s = await discipline.tournamentSuspensions(tS.id, catS.id);
    assert.strictEqual(s.suspended.length, 1);
    assert.strictEqual(s.suspended[0].playerId, pOutro.id);
    assert.deepStrictEqual(s.suspended[0].matchIds, [leoesMatches[5].id]);
    assert.match(s.suspended[0].reasonText, /vermelho/);
  });

  // ===================================================================
  console.log('dupla eliminação');
  const serie = 'copa-teste-' + RUN;
  let deT = null;
  await ok('6 times: perdedor cai na chave B, final + reset; campeão = vencedor do reset', async () => {
    deT = await mkTournament(owner, { seriesSlug: serie, seriesName: 'Copa Teste', edition: '2026' });
    const cat = await mkCat(deT, { format: 'DOUBLE_ELIM' });
    const E = await mkEntries(deT, cat, ['Clube X', 'B2', 'B3', 'B4', 'B5', 'B6']);
    const r = await engine.generateFixtures(cat.id);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.matchesCreated, 2 * 6 - 2 + 1);
    const losses = Object.fromEntries(E.map((e) => [e.id, 0]));
    for (let guard = 0; guard < 40; guard++) {
      const ms = await matchesOf(cat.id, { status: 'SCHEDULED' });
      const m = ms.find((x) => x.homeEntryId && x.awayEntryId);
      if (!m) break;
      // regra do teste: mandante vence; na grande final o visitante (campeão da chave B) vence → reset
      const homeWins = m.stage !== 'FINAL';
      const res = await engine.applyMatchResult(m.id, { homeScore: homeWins ? 2 : 0, awayScore: homeWins ? 0 : 2 });
      assert.ok(res.ok, res.error);
      losses[homeWins ? m.awayEntryId : m.homeEntryId]++;
    }
    const all = await matchesOf(cat.id);
    const reset = all.find((m) => m.stage === 'FINAL_RESET');
    assert.strictEqual(reset.status, 'FINISHED', 'reset foi jogado');
    const champ = reset.winnerEntryId;
    for (const [id, l] of Object.entries(losses)) {
      if (id === champ) assert.strictEqual(l, 1);
      else assert.strictEqual(l, 2, 'eliminado sem 2 derrotas');
    }
    assert.ok(all.every((m) => m.status === 'FINISHED'), 'todos os jogos disputados');
    // a chave dos perdedores existe e recebeu perdedores
    assert.ok(all.some((m) => m.stage === 'LB'));
    assert.ok(all.filter((m) => m.loserNextMatchId).length >= 4);
  });
  await ok('vencedor da chave A ganha a final → reset CANCELADO e campeão definido', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'DOUBLE_ELIM' });
    await mkEntries(t, cat, ['A', 'B', 'C', 'D']);
    await engine.generateFixtures(cat.id);
    for (let guard = 0; guard < 30; guard++) {
      const m = (await matchesOf(cat.id, { status: 'SCHEDULED' })).find((x) => x.homeEntryId && x.awayEntryId);
      if (!m) break;
      await engine.applyMatchResult(m.id, { homeScore: 1, awayScore: 0 });
    }
    const all = await matchesOf(cat.id);
    assert.strictEqual(all.find((m) => m.stage === 'FINAL_RESET').status, 'CANCELED');
    const ch = require('../src/services/tournamentFormats').categoryChampion(all, []);
    assert.ok(ch && ch.source === 'FINAL');
  });
  await ok('mata-mata não aceita empate na dupla eliminação', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'DOUBLE_ELIM' });
    await mkEntries(t, cat, ['A', 'B', 'C']);
    await engine.generateFixtures(cat.id);
    const m = (await matchesOf(cat.id)).find((x) => x.homeEntryId && x.awayEntryId);
    const r = await engine.applyMatchResult(m.id, { homeScore: 1, awayScore: 1 });
    assert.strictEqual(r.ok, false);
  });

  // ===================================================================
  console.log('sistema suíço');
  let swT = null;
  let swCat = null;
  await ok('7 times × 3 rodadas: sem repetir confronto, bye único, trava na 4ª', async () => {
    swT = await mkTournament(owner);
    swCat = await mkCat(swT, { format: 'SWISS', formatConfig: { rounds: 3 } });
    await mkEntries(swT, swCat, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    const r1 = await engine.generateFixtures(swCat.id);
    assert.ok(r1.ok, r1.error);
    assert.strictEqual(r1.totalRounds, 3);
    const early = await engine.generateSwissNextRound(swCat.id);
    assert.strictEqual(early.ok, false, 'não gera com rodada pendente');
    for (let round = 1; round <= 3; round++) {
      for (const m of await matchesOf(swCat.id, { round, status: 'SCHEDULED' })) {
        await engine.applyMatchResult(m.id, { homeScore: 2, awayScore: 1 });
      }
      if (round < 3) {
        const nx = await engine.generateSwissNextRound(swCat.id);
        assert.ok(nx.ok, nx.error);
        assert.strictEqual(nx.repeats, 0);
      }
    }
    const fourth = await engine.generateSwissNextRound(swCat.id);
    assert.strictEqual(fourth.ok, false);
    const all = await matchesOf(swCat.id);
    const pairs = all.filter((m) => m.homeEntryId && m.awayEntryId).map((m) => [m.homeEntryId, m.awayEntryId].sort().join());
    assert.strictEqual(new Set(pairs).size, pairs.length, 'repetiu confronto');
    const byes = all.filter((m) => !m.awayEntryId).map((m) => m.homeEntryId);
    assert.strictEqual(byes.length, 3);
    assert.strictEqual(new Set(byes).size, 3, 'alguém folgou 2x');
    const st = await standingsOf(swCat.id);
    const totalPts = st.reduce((s, x) => s + x.points, 0);
    assert.strictEqual(totalPts, 3 * 3 * 4, '3 rodadas × (3 jogos + 1 bye) × 3 pts');
  });

  // ===================================================================
  console.log('Americano / Super 8');
  let amCat = null;
  await ok('Super 8: 14 jogos em duplas rotativas; ranking individual por games', async () => {
    const t = await mkTournament(owner, { sport: 'BEACH_TENNIS' });
    amCat = await mkCat(t, { format: 'AMERICANO' });
    const E = await mkEntries(t, amCat, ['Ana', 'Bia', 'Cau', 'Dani', 'Edu', 'Fê', 'Gabi', 'Hugo']);
    const r = await engine.generateFixtures(amCat.id);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.matchesCreated, 14);
    assert.strictEqual(r.variant, 'SUPER8');
    const ms = await matchesOf(amCat.id);
    const games = Object.fromEntries(E.map((e) => [e.id, 0]));
    for (const m of ms) {
      assert.ok(m.homeEntry2Id && m.awayEntry2Id);
      const hs = 6;
      const as = (m.round + m.ordering) % 6;
      await engine.applyMatchResult(m.id, { homeScore: hs, awayScore: as });
      games[m.homeEntryId] += hs;
      games[m.homeEntry2Id] += hs;
      games[m.awayEntryId] += as;
      games[m.awayEntry2Id] += as;
    }
    const st = await standingsOf(amCat.id);
    for (const s of st) assert.strictEqual(s.points, games[s.entryId], 'pontos = games pró');
    for (let i = 1; i < st.length; i++) assert.ok(st[i - 1].points >= st[i].points);
    assert.strictEqual(await prisma.athleteRating.count(), 0, 'Americano não mexe no rating');
  });
  await ok('Americano com 6 atletas é recusado (múltiplo de 4)', async () => {
    const t = await mkTournament(owner);
    const cat = await mkCat(t, { format: 'AMERICANO' });
    await mkEntries(t, cat, ['a', 'b', 'c', 'd', 'e', 'f']);
    const r = await engine.generateFixtures(cat.id);
    assert.strictEqual(r.ok, false);
  });

  // ===================================================================
  console.log('regressão — grupos + mata-mata (formato do Futsal Master Cup)');
  await ok('GROUPS_KNOCKOUT 8 times: grupos → semis → 3º lugar → final', async () => {
    const t = await mkTournament(owner, { seriesSlug: serie, seriesName: 'Copa Teste', edition: '2025', startDate: new Date('2025-05-01') });
    const cat = await mkCat(t, { format: 'GROUPS_KNOCKOUT' });
    const E = await mkEntries(t, cat, ['Clube X', 'Y2', 'Y3', 'Y4', 'Y5', 'Y6', 'Y7', 'Y8']);
    const g = await engine.generateFixtures(cat.id, { groupCount: 2 });
    assert.ok(g.ok, g.error);
    for (const m of await matchesOf(cat.id, { stage: 'GROUP' })) {
      // Clube X sempre vence; nos outros jogos o mandante vence
      const xHome = m.homeEntryId === E[0].id;
      const xAway = m.awayEntryId === E[0].id;
      await engine.applyMatchResult(m.id, xAway ? { homeScore: 0, awayScore: 3 } : { homeScore: xHome ? 3 : 1, awayScore: 0 });
    }
    const ko = await engine.generateKnockoutFromGroups(cat.id, 2);
    assert.ok(ko.ok, ko.error);
    for (let guard = 0; guard < 10; guard++) {
      const m = (await matchesOf(cat.id, { status: 'SCHEDULED' })).find((x) => x.homeEntryId && x.awayEntryId);
      if (!m) break;
      const xAway = m.awayEntryId === E[0].id;
      await engine.applyMatchResult(m.id, xAway ? { homeScore: 0, awayScore: 1 } : { homeScore: 1, awayScore: 0 });
    }
    const fin = (await matchesOf(cat.id)).find((m) => m.stage === 'FINAL');
    assert.strictEqual(fin.status, 'FINISHED');
    assert.strictEqual(fin.winnerEntryId, E[0].id);
    assert.strictEqual((await matchesOf(cat.id)).find((m) => m.stage === 'THIRD').status, 'FINISHED');
  });

  // ===================================================================
  console.log('temporadas — histórico de campeões da série');
  await ok('2 edições da mesma série: campeões por edição e títulos somados por clube', async () => {
    const r = await discipline.seriesChampions(serie);
    assert.strictEqual(r.series.name, 'Copa Teste');
    assert.strictEqual(r.editions.length, 2);
    const eds = r.editions.map((e) => e.edition);
    assert.ok(eds.includes('2025') && eds.includes('2026'));
    const e25 = r.editions.find((e) => e.edition === '2025');
    assert.strictEqual(e25.categories[0].champion.name, 'Clube X');
    assert.strictEqual(e25.categories[0].decidedBy, 'FINAL');
    const e26 = r.editions.find((e) => e.edition === '2026');
    assert.strictEqual(e26.categories[0].decidedBy, 'FINAL_RESET');
    const total = r.titles.reduce((s, x) => s + x.titles, 0);
    assert.strictEqual(total, 2);
  });

  // ===================================================================
  console.log('HTTP — rotas reais (Express + JWT)');
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../src/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/tournaments', require('../src/routes/tournaments'));
  const server = await new Promise((res) => {
    const s = app.listen(0, () => res(s));
  });
  const port = server.address().port;
  const token = jwt.sign({ userId: owner.id }, JWT_SECRET);
  const call = (method, path, body) =>
    new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/tournaments' + path, method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            let json = null;
            try {
              json = JSON.parse(buf);
            } catch (_) {
              /* corpo não-JSON */
            }
            resolve({ status: res.statusCode, json, raw: buf });
          });
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  try {
    await ok('GET /:id/suspensions devolve JSON com suspensos + pendurados + regra', async () => {
      const r = await call('GET', `/${tS.id}/suspensions?categoryId=${catS.id}`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.json && Array.isArray(r.json.suspended), r.raw.slice(0, 120));
      assert.strictEqual(r.json.suspended[0].playerId, pOutro.id);
      assert.strictEqual(r.json.rules[catS.id].yellowLimit, 3);
    });
    await ok('POST /matches/:id/events com suspenso → 409 SUSPENDED; com motivo → 201', async () => {
      const mid = leoesMatches[5].id;
      const a = await call('POST', `/matches/${mid}/events`, { type: 'GOAL', entryId: leoes.id, playerId: pOutro.id });
      assert.strictEqual(a.status, 409);
      assert.strictEqual(a.json.code, 'SUSPENDED');
      const b = await call('POST', `/matches/${mid}/events`, { type: 'GOAL', entryId: leoes.id, playerId: pOutro.id, overrideSuspension: true, overrideReason: 'decisão da comissão' });
      assert.strictEqual(b.status, 201, b.raw);
      const audit = await prisma.suspensionOverride.findFirst({ where: { matchId: mid } });
      assert.strictEqual(audit.userId, owner.id);
    });
    await ok('POST /matches/:id/lineup bloqueia suspenso (409)', async () => {
      const r = await call('POST', `/matches/${leoesMatches[5].id}/lineup`, { entryId: leoes.id, playerIds: [pOutro.id] });
      assert.strictEqual(r.status, 409);
    });
    await ok('GET standings traz os critérios usados; PATCH troca critério e recalcula na hora', async () => {
      const a = await call('GET', `/${h2hT.id}/categories/${h2hCat.id}/standings`);
      assert.deepStrictEqual(a.json.criteria, ['POINTS', 'GOAL_DIFF']);
      assert.deepStrictEqual(a.json.criteriaLabels, ['Pontos', 'Saldo']);
      const p = await call('PATCH', `/${h2hT.id}/categories/${h2hCat.id}`, { tiebreakers: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF', 'lixo'] });
      assert.strictEqual(p.status, 200, p.raw);
      assert.deepStrictEqual(p.json.tiebreakers, ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF']);
      const b = await call('GET', `/${h2hT.id}/categories/${h2hCat.id}/standings`);
      assert.strictEqual(b.json.standings[0].tiebreak, 'HEAD_TO_HEAD');
      assert.strictEqual(b.json.standings[1].entry.name, 'A', 'A sobe pelo confronto direto');
    });
    await ok('PATCH formato depois de gerar a chave → 409 (não bagunça tabela existente)', async () => {
      const r = await call('PATCH', `/${h2hT.id}/categories/${h2hCat.id}`, { format: 'SWISS' });
      assert.strictEqual(r.status, 409);
      const r2 = await call('PATCH', `/${h2hT.id}/categories/${h2hCat.id}`, { doubleRound: true });
      assert.strictEqual(r2.status, 409);
      // salvar regras reenviando o MESMO formato (efetivo) não é troca → 200
      const r3 = await call('PATCH', `/${h2hT.id}/categories/${h2hCat.id}`, { format: 'ROUND_ROBIN', doubleRound: false, tiebreakers: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'] });
      assert.strictEqual(r3.status, 200, r3.raw);
      // categoria SEM formato próprio herda o do torneio: reenviar o do torneio também é 200
      const t2 = await mkTournament(owner, { format: 'ROUND_ROBIN' });
      const c2 = await mkCat(t2, {});
      await mkEntries(t2, c2, ['A', 'B', 'C']);
      await engine.generateFixtures(c2.id);
      const r4 = await call('PATCH', `/${t2.id}/categories/${c2.id}`, { format: 'ROUND_ROBIN', tiebreakers: ['POINTS', 'WINS'] });
      assert.strictEqual(r4.status, 200, r4.raw);
      assert.strictEqual(r4.json.format, null, 'continua herdando');
    });
    await ok('POST /:id/categories aceita formato novo + regras normalizadas', async () => {
      const r = await call('POST', `/${h2hT.id}/categories`, {
        name: 'Nova', format: 'DOUBLE_ELIM', doubleRound: true, tiebreakers: 'WINS,POINTS', suspensionRule: { yellowLimit: 99, redBan: 2 }, formatConfig: { reset: false, rounds: 4 },
      });
      assert.strictEqual(r.status, 201, r.raw);
      assert.strictEqual(r.json.format, 'DOUBLE_ELIM');
      assert.deepStrictEqual(r.json.tiebreakers, ['WINS', 'POINTS']);
      assert.strictEqual(r.json.suspensionRule.yellowLimit, 20, 'limite saneado');
      assert.strictEqual(r.json.suspensionRule.redBan, 2);
      assert.deepStrictEqual(r.json.formatConfig, { rounds: 4, reset: false });
    });
    await ok('POST swiss-next quando tudo já foi gerado → 400 com mensagem', async () => {
      const r = await call('POST', `/${swT.id}/categories/${swCat.id}/swiss-next`);
      assert.strictEqual(r.status, 400);
      assert.match(r.json.error, /rodadas/);
    });
    await ok('GET /series/:slug/champions (rota pública) devolve as edições', async () => {
      const r = await call('GET', `/series/${serie}/champions`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.editions.length, 2);
    });
    await ok('GET stats: oficial por padrão; scope=live marcado', async () => {
      const a = await call('GET', `/${tS.id}/stats/scorers?categoryId=${catS.id}`);
      assert.strictEqual(a.json.scope, 'official');
      const b = await call('GET', `/${tS.id}/stats/scorers?categoryId=${catS.id}&scope=live`);
      assert.strictEqual(b.json.scope, 'live');
      assert.ok(b.json.ranking.some((x) => x.partial), 'o gol liberado no jogo aberto aparece como parcial');
      assert.ok(!a.json.ranking.some((x) => x.partial));
    });
    await ok('GET matches do Americano mostra as duplas ("Ana & Bia")', async () => {
      // Liga F1: a categoria tem que ser do torneio da URL (antes /x/... passava por baixo de qualquer id)
      const r = await call('GET', `/${amCat.tournamentId}/categories/${amCat.id}/matches`);
      assert.strictEqual((await call('GET', `/x/categories/${amCat.id}/matches`)).status, 404, 'id de torneio errado = 404');
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.matches.every((m) => m.homeEntry.name.includes(' & ') && m.awayEntry.name.includes(' & ')));
    });
    await ok('PATCH /:id grava série/edição (slug derivado do nome)', async () => {
      const r = await call('PATCH', `/${tS.id}`, { seriesName: 'Copa Disciplina Ação', edition: 'I' });
      assert.strictEqual(r.status, 200, r.raw);
      assert.strictEqual(r.json.seriesSlug, 'copa-disciplina-acao');
      assert.strictEqual(r.json.edition, 'I');
    });
  } finally {
    server.close();
  }

  console.log(failed ? `\n❌ ${failed} falha(s), ${passed} ok.` : `\n✅ ${passed} testes de integração passaram.`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('❌ erro fatal:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  });
