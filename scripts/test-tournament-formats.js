'use strict';
// =====================================================================
// Teste das funções PURAS do motor de campeonato (sem banco):
// desempate configurável (inclui confronto direto com 3 empatados),
// ida e volta, dupla eliminação (simulação completa), suíço, Americano
// (Super 8 / Super 12), suspensão automática e campeão da série.
// Roda com: node scripts/test-tournament-formats.js
// =====================================================================

const assert = require('assert');
const F = require('../src/services/tournamentFormats');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✅ ' + name);
  } catch (e) {
    console.error('  ❌ ' + name + ' → ' + e.message);
    process.exitCode = 1;
  }
}
const P = { win: 3, draw: 1, loss: 0 };
const ids = (rows) => rows.map((r) => r.entryId);
const M = (h, a, hs, as) => ({
  homeEntryId: h,
  awayEntryId: a,
  homeScore: hs,
  awayScore: as,
  winnerEntryId: hs > as ? h : as > hs ? a : null,
  status: 'FINISHED',
});
const tableOf = (teams, matches, opts = {}) =>
  Object.values(F.tallyTable(teams.map((id) => ({ id })), matches, P, opts));

// Mulberry32 — PRNG determinístico pros testes de propriedade
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
console.log('normalizeTiebreakers');
ok('vazio/inválido → padrão histórico (pontos, saldo, gols pró)', () => {
  assert.deepStrictEqual(F.normalizeTiebreakers(null), ['POINTS', 'GOAL_DIFF', 'GOALS_FOR']);
  assert.deepStrictEqual(F.normalizeTiebreakers(['xx', '']), ['POINTS', 'GOAL_DIFF', 'GOALS_FOR']);
});
ok('aceita string JSON/CSV, remove duplicado e desconhecido, mantém a ordem', () => {
  assert.deepStrictEqual(F.normalizeTiebreakers('["wins","points","wins","foo"]'), ['WINS', 'POINTS']);
  assert.deepStrictEqual(F.normalizeTiebreakers('HEAD_TO_HEAD,DRAW'), ['HEAD_TO_HEAD', 'DRAW']);
});

// ---------------------------------------------------------------------
console.log('rankTable — padrão idêntico ao motor antigo');
ok('300 tabelas aleatórias: mesma ordem do comparador antigo (pontos→saldo→marcados, estável)', () => {
  const r = rng(42);
  for (let t = 0; t < 300; t++) {
    const n = 3 + Math.floor(r() * 6);
    const rows = [];
    for (let i = 0; i < n; i++) {
      const sf = Math.floor(r() * 6);
      const sa = Math.floor(r() * 6);
      rows.push({ entryId: 'e' + i, points: Math.floor(r() * 4) * 3, scoreFor: sf, scoreAgainst: sa, won: 0 });
    }
    const old = rows
      .slice()
      .sort((x, y) => y.points - x.points || y.scoreFor - y.scoreAgainst - (x.scoreFor - x.scoreAgainst) || y.scoreFor - x.scoreFor);
    const neu = F.rankTable(rows, {});
    assert.deepStrictEqual(ids(neu), old.map((x) => x.entryId));
    neu.forEach((x, i) => assert.strictEqual(x.rank, i + 1));
  }
});

console.log('rankTable — cada critério');
ok('VITÓRIAS desempata antes do saldo', () => {
  const rows = [
    { entryId: 'A', points: 9, won: 2, scoreFor: 10, scoreAgainst: 2 },
    { entryId: 'B', points: 9, won: 3, scoreFor: 5, scoreAgainst: 4 },
  ];
  assert.deepStrictEqual(ids(F.rankTable(rows, { criteria: ['POINTS', 'WINS', 'GOAL_DIFF'] })), ['B', 'A']);
  assert.deepStrictEqual(ids(F.rankTable(rows, { criteria: ['POINTS', 'GOAL_DIFF', 'WINS'] })), ['A', 'B']);
});
ok('GOLS PRÓ e MENOS GOLS SOFRIDOS', () => {
  const rows = [
    { entryId: 'A', points: 3, scoreFor: 5, scoreAgainst: 5 },
    { entryId: 'B', points: 3, scoreFor: 2, scoreAgainst: 2 },
  ];
  assert.deepStrictEqual(ids(F.rankTable(rows, { criteria: ['POINTS', 'GOAL_DIFF', 'GOALS_FOR'] })), ['A', 'B']);
  const r = F.rankTable(rows, { criteria: ['POINTS', 'GOAL_DIFF', 'GOALS_AGAINST'] });
  assert.deepStrictEqual(ids(r), ['B', 'A']);
  assert.strictEqual(r[0].decidedBy, 'GOALS_AGAINST');
});
ok('FAIR PLAY: menos pontos de cartão vence (amarelo=1, vermelho=3)', () => {
  const fp = F.fairPlayByEntry([
    { entryId: 'A', type: 'RED' }, // 3
    { entryId: 'B', type: 'YELLOW' },
    { entryId: 'B', type: 'YELLOW' }, // 2
    { entryId: 'B', type: 'GOAL' },
  ]);
  assert.deepStrictEqual(fp, { A: 3, B: 2 });
  const rows = [
    { entryId: 'A', points: 4, scoreFor: 3, scoreAgainst: 3, fairPlay: fp.A },
    { entryId: 'B', points: 4, scoreFor: 3, scoreAgainst: 3, fairPlay: fp.B },
  ];
  const r = F.rankTable(rows, { criteria: ['POINTS', 'GOAL_DIFF', 'FAIR_PLAY'] });
  assert.deepStrictEqual(ids(r), ['B', 'A']);
  assert.strictEqual(r[0].decidedBy, 'FAIR_PLAY');
});
ok('SORTEIO: determinístico pela semente, auditável (mesma semente = mesma ordem)', () => {
  const rows = ['A', 'B', 'C', 'D', 'E'].map((id) => ({ entryId: id, points: 3, scoreFor: 1, scoreAgainst: 1 }));
  const a = ids(F.rankTable(rows, { criteria: ['POINTS', 'DRAW'], seed: 'abc' }));
  const b = ids(F.rankTable(rows, { criteria: ['POINTS', 'DRAW'], seed: 'abc' }));
  assert.deepStrictEqual(a, b);
  // ordem = valor do hash(semente:id) decrescente (qualquer um recalcula)
  const manual = rows.map((r) => r.entryId).sort((x, y) => F.drawValue('abc', y) - F.drawValue('abc', x));
  assert.deepStrictEqual(a, manual);
  const seeds = ['s1', 's2', 's3', 's4', 's5', 's6'].map((sd) => ids(F.rankTable(rows, { criteria: ['DRAW'], seed: sd })).join());
  assert.ok(new Set(seeds).size > 1, 'sementes diferentes devem poder mudar a ordem');
});
ok('BUCHHOLZ soma os pontos dos adversários (suíço)', () => {
  // A venceu C (fraco); B venceu D (forte: D venceu C)
  const t = tableOf(['A', 'B', 'C', 'D'], [M('A', 'C', 1, 0), M('B', 'D', 1, 0), M('D', 'C', 1, 0)]);
  const by = Object.fromEntries(t.map((r) => [r.entryId, r]));
  assert.strictEqual(by.A.buchholz, 0);
  assert.strictEqual(by.B.buchholz, 3);
  // A, B, D com 3 pts: B (enfrentou D=3) e D (enfrentou B=3 + C=0) à frente de A (enfrentou C=0)
  const r = F.rankTable(t, { criteria: ['POINTS', 'BUCHHOLZ'] });
  assert.deepStrictEqual(ids(r), ['B', 'D', 'A', 'C']);
  assert.strictEqual(r.find((x) => x.entryId === 'A').decidedBy, 'BUCHHOLZ');
});

console.log('rankTable — confronto direto');
ok('2 empatados: quem venceu o confronto fica na frente (mesmo com saldo pior)', () => {
  const ms = [M('A', 'B', 1, 0), M('A', 'C', 0, 5), M('B', 'C', 6, 0)];
  const t = tableOf(['A', 'B', 'C'], ms);
  // A 3pts (1-0, 0-5) saldo -4 · B 3pts saldo +5 · C 3pts
  const r = F.rankTable(t, { criteria: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'], matches: ms, points: P });
  // os 3 empatam em pontos; mini-tabela entre os 3 = tabela geral (cíclico) → saldo da mini: B +5, A -4, C -1
  assert.deepStrictEqual(ids(r), ['B', 'C', 'A']);
  const r2 = F.rankTable(t.filter((x) => x.entryId !== 'C'), {
    criteria: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'],
    matches: ms,
    points: P,
  });
  assert.deepStrictEqual(ids(r2), ['A', 'B']);
  assert.strictEqual(r2[0].decidedBy, 'HEAD_TO_HEAD');
});
ok('3 empatados: mini-tabela entre eles separa (pontos no confronto)', () => {
  // A, C, D vencem B e ficam com 6 pts; entre si é cíclico: A×C 1-0, C×D 9-0, D×A 3-0.
  // D goleou B (10-0) → no SALDO GERAL D fica à frente de A; no CONFRONTO DIRETO, não.
  const ms = [M('A', 'B', 1, 0), M('C', 'B', 1, 0), M('D', 'B', 10, 0), M('A', 'C', 1, 0), M('C', 'D', 9, 0), M('D', 'A', 3, 0)];
  const t = tableOf(['A', 'B', 'C', 'D'], ms);
  const pts = Object.fromEntries(t.map((r) => [r.entryId, r.points]));
  assert.deepStrictEqual([pts.A, pts.B, pts.C, pts.D], [6, 0, 6, 6]);
  // mini-tabela entre A, C, D: 3 pts cada · saldo da mini: A (1-0)+(0-3) = -2 · C (0-1)+(9-0) = +8 · D (3-0)+(0-9) = -6
  const h2h = F.rankTable(t, { criteria: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'], matches: ms, points: P });
  assert.deepStrictEqual(ids(h2h), ['C', 'A', 'D', 'B']);
  assert.strictEqual(h2h[0].decidedBy, 'HEAD_TO_HEAD');
  // saldo geral: C +9, D +4, A -1 → ordem diferente (prova que o critério muda o resultado)
  const gd = F.rankTable(t, { criteria: ['POINTS', 'GOAL_DIFF', 'HEAD_TO_HEAD'], matches: ms, points: P });
  assert.deepStrictEqual(ids(gd), ['C', 'D', 'A', 'B']);
});
ok('3 empatados, 1 se destaca e os outros 2 recalculam o confronto só entre eles', () => {
  // A, B, C empatados. A venceu B e C (6 na mini). B×C: C venceu → C à frente de B
  // mesmo que B tenha saldo geral muito melhor.
  const ms = [M('A', 'B', 1, 0), M('A', 'C', 1, 0), M('C', 'B', 1, 0), M('B', 'X', 20, 0)];
  const rows = [
    { entryId: 'A', points: 6, scoreFor: 2, scoreAgainst: 0 },
    { entryId: 'B', points: 6, scoreFor: 20, scoreAgainst: 2 },
    { entryId: 'C', points: 6, scoreFor: 1, scoreAgainst: 1 },
  ];
  const r = F.rankTable(rows, { criteria: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'], matches: ms, points: P });
  assert.deepStrictEqual(ids(r), ['A', 'C', 'B']);
});
ok('confronto direto empatado (empate no jogo) cai pro próximo critério', () => {
  const ms = [M('A', 'B', 2, 2)];
  const rows = [
    { entryId: 'A', points: 4, scoreFor: 3, scoreAgainst: 3 },
    { entryId: 'B', points: 4, scoreFor: 5, scoreAgainst: 3 },
  ];
  const r = F.rankTable(rows, { criteria: ['POINTS', 'HEAD_TO_HEAD', 'GOAL_DIFF'], matches: ms, points: P });
  assert.deepStrictEqual(ids(r), ['B', 'A']);
  assert.strictEqual(r[0].decidedBy, 'GOAL_DIFF');
});

// ---------------------------------------------------------------------
console.log('ida e volta');
ok('4 times: 6 rodadas, 12 jogos, cada confronto 2x com mando invertido', () => {
  const rounds = F.withReturnLeg(F.circleRounds(['a', 'b', 'c', 'd']));
  assert.strictEqual(rounds.length, 6);
  const all = rounds.flat();
  assert.strictEqual(all.length, 12);
  const seen = {};
  for (const [h, a] of all) seen[h + '>' + a] = (seen[h + '>' + a] || 0) + 1;
  for (const k of Object.keys(seen)) {
    assert.strictEqual(seen[k], 1, 'mando repetido ' + k);
    const [h, a] = k.split('>');
    assert.ok(seen[a + '>' + h], 'falta o returno de ' + k);
  }
});
ok('5 times (ímpar): 10 rodadas, 20 jogos', () => {
  const rounds = F.withReturnLeg(F.circleRounds(['a', 'b', 'c', 'd', 'e']));
  assert.strictEqual(rounds.length, 10);
  assert.strictEqual(rounds.flat().length, 20);
});

// ---------------------------------------------------------------------
console.log('dupla eliminação');
function simulateDE(n, seed, reset = true, lbChampWinsGF = null) {
  const plan = F.doubleElimPlan(n, { reset });
  const r = rng(seed);
  const by = Object.fromEntries(plan.matches.map((m) => [m.key, { ...m, h: null, a: null, done: false }]));
  for (const m of Object.values(by)) {
    if (m.home.type === 'seed') m.h = 'S' + m.home.seed;
    if (m.away.type === 'seed') m.a = 'S' + m.away.seed;
  }
  const losses = {};
  for (let i = 1; i <= n; i++) losses['S' + i] = 0;
  let played = 0;
  let champion = null;
  for (let guard = 0; guard < 500; guard++) {
    const ready = Object.values(by).find((m) => !m.done && m.h && m.a);
    if (!ready) break;
    let w;
    if (ready.key === 'GF' && lbChampWinsGF !== null) w = lbChampWinsGF ? ready.a : ready.h;
    else w = r() < 0.5 ? ready.h : ready.a;
    const l = w === ready.h ? ready.a : ready.h;
    ready.done = true;
    played++;
    losses[l]++;
    if (ready.winnerTo) by[ready.winnerTo.key][ready.winnerTo.slot === 'home' ? 'h' : 'a'] = w;
    if (ready.loserTo) by[ready.loserTo.key][ready.loserTo.slot === 'home' ? 'h' : 'a'] = l;
    if (ready.key === 'GF') {
      if (w === ready.a && by.GF2) {
        by.GF2.h = ready.h;
        by.GF2.a = ready.a;
      } else {
        champion = w;
        if (by.GF2) by.GF2.done = true; // reset não é jogado
      }
    }
    if (ready.key === 'GF2') champion = w;
  }
  return { plan, by, losses, played, champion };
}
ok('n = 2..16, 20 simulações cada: todos jogos com 2 lados, ninguém some', () => {
  for (let n = 2; n <= 16; n++) {
    for (let s = 1; s <= 20; s++) {
      const { plan, by, losses, played, champion } = simulateDE(n, n * 100 + s);
      assert.ok(champion, `n=${n}: sem campeão`);
      // todo jogo real (menos o reset quando não foi necessário) foi jogado
      for (const m of Object.values(by)) assert.ok(m.done, `n=${n} jogo ${m.key} não foi disputado`);
      // cada eliminado tem exatamente 2 derrotas; campeão no máx 1
      for (const [e, l] of Object.entries(losses)) {
        if (e === champion) assert.ok(l <= 1, `n=${n} campeão com ${l} derrotas`);
        else assert.strictEqual(l, 2, `n=${n} ${e} saiu com ${l} derrota(s)`);
      }
      // 2n-2 jogos (sem reset) ou 2n-1 (com reset)
      assert.ok(played === 2 * n - 2 || played === 2 * n - 1, `n=${n} jogou ${played}`);
      assert.ok(plan.matches.filter((m) => m.bracket !== 'GF2').length === 2 * n - 2, `n=${n}: estrutura com ${plan.matches.length} jogos`);
    }
  }
});
ok('reset: só acontece se o campeão da chave dos perdedores vencer a final', () => {
  const a = simulateDE(8, 7, true, true);
  assert.strictEqual(a.played, 2 * 8 - 1);
  const b = simulateDE(8, 7, true, false);
  assert.strictEqual(b.played, 2 * 8 - 2);
  const c = simulateDE(8, 7, false, true); // sem reset: final única
  assert.strictEqual(c.played, 2 * 8 - 2);
  assert.ok(!c.plan.matches.some((m) => m.bracket === 'GF2'));
});
ok('n=5: byes resolvidos na geração (sem jogo fantasma) e cabeças 1/2/3 avançam direto', () => {
  const plan = F.doubleElimPlan(5);
  const wb1 = plan.matches.filter((m) => m.bracket === 'W' && m.round === 1);
  assert.strictEqual(wb1.length, 1, '5 inscritos: só 4×5 joga a 1ª rodada');
  for (const m of plan.matches) {
    for (const src of [m.home, m.away]) if (src.type === 'seed') assert.ok(src.seed <= 5);
  }
});

// ---------------------------------------------------------------------
console.log('sistema suíço');
ok('1ª rodada: metade de cima × metade de baixo; ímpar = bye pro último', () => {
  const r = F.swissFirstRound(['1', '2', '3', '4', '5', '6', '7']);
  assert.deepStrictEqual(r.pairs, [['1', '4'], ['2', '5'], ['3', '6']]);
  assert.strictEqual(r.bye, '7');
});
ok('8 jogadores × 5 rodadas (simulado): nunca repete confronto', () => {
  const r = rng(9);
  const players = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const pts = Object.fromEntries(players.map((p) => [p, 0]));
  const played = new Set();
  let round = F.swissFirstRound(players);
  for (let k = 0; k < 5; k++) {
    for (const [x, y] of round.pairs) {
      assert.ok(!played.has(F.pairKey(x, y)), 'repetiu ' + x + y);
      played.add(F.pairKey(x, y));
      pts[r() < 0.5 ? x : y] += 1;
    }
    const ranked = players.slice().sort((x, y) => pts[y] - pts[x]);
    round = F.swissPair(ranked, played, new Set());
    assert.strictEqual(round.repeats, 0);
  }
});
ok('7 e 9 jogadores × 5 rodadas (100 simulações): ninguém folga 2x e nunca repete confronto', () => {
  for (const n of [7, 9]) {
    for (let sd = 1; sd <= 100; sd++) {
      const r = rng(sd * 31 + n);
      const players = Array.from({ length: n }, (_, i) => 'p' + i);
      const pts = Object.fromEntries(players.map((p) => [p, 0]));
      const played = new Set();
      const byes = new Set();
      for (let k = 0; k < 5; k++) {
        const ranked = players.slice().sort((x, y) => pts[y] - pts[x]);
        const rd = k === 0 ? F.swissFirstRound(players) : F.swissPair(ranked, played, byes);
        assert.ok(rd.bye, 'ímpar sempre tem bye');
        assert.ok(!byes.has(rd.bye), rd.bye + ' folgou 2x');
        assert.strictEqual(rd.repeats || 0, 0);
        byes.add(rd.bye);
        pts[rd.bye] += 1;
        for (const [x, y] of rd.pairs) {
          assert.ok(!played.has(F.pairKey(x, y)), 'repetiu');
          played.add(F.pairKey(x, y));
          pts[r() < 0.5 ? x : y] += 1;
        }
      }
    }
  }
});
ok('impossível evitar repetição → não trava (pareia e informa repeats)', () => {
  const played = new Set([F.pairKey('a', 'b')]);
  const r = F.swissPair(['a', 'b'], played, new Set());
  assert.strictEqual(r.pairs.length, 1);
  assert.strictEqual(r.repeats, 1);
});
ok('bye conta como vitória na tabela (sem gols) e não entra no Buchholz', () => {
  const t = tableOf(['a', 'b', 'c'], [M('a', 'b', 2, 0), { homeEntryId: 'c', awayEntryId: null, winnerEntryId: 'c', status: 'WALKOVER' }]);
  const by = Object.fromEntries(t.map((r) => [r.entryId, r]));
  assert.strictEqual(by.c.points, 3);
  assert.strictEqual(by.c.won, 1);
  assert.strictEqual(by.c.scoreFor, 0);
  assert.strictEqual(by.c.buchholz, 0);
});

// ---------------------------------------------------------------------
console.log('Americano / Super 8 / Super 12');
function checkAmericano(n) {
  const players = Array.from({ length: n }, (_, i) => 'p' + i);
  const sched = F.americanoSchedule(players);
  assert.strictEqual(sched.length, n - 1, 'n-1 rodadas');
  const partners = new Set();
  const opp = {};
  for (const r of sched) {
    assert.strictEqual(r.matches.length, n / 4);
    const inRound = r.matches.flatMap((m) => [...m.home, ...m.away]);
    assert.strictEqual(new Set(inRound).size, n, 'todo mundo joga 1x por rodada');
    for (const m of r.matches) {
      for (const side of [m.home, m.away]) {
        const k = F.pairKey(side[0], side[1]);
        assert.ok(!partners.has(k), 'parceria repetida ' + k);
        partners.add(k);
      }
      for (const x of m.home) for (const y of m.away) opp[F.pairKey(x, y)] = (opp[F.pairKey(x, y)] || 0) + 1;
    }
  }
  assert.strictEqual(partners.size, (n * (n - 1)) / 2, 'cada atleta joga com cada outro exatamente 1x');
  const counts = Object.values(opp);
  return { sched, max: Math.max(...counts), min: Math.min(...counts), pairs: Object.keys(opp).length };
}
ok('Super 8: 7 rodadas, 14 jogos, parceiro diferente toda rodada, adversários equilibrados', () => {
  const r = checkAmericano(8);
  assert.strictEqual(r.sched.flatMap((x) => x.matches).length, 14);
  assert.strictEqual(r.pairs, 28, 'todo mundo enfrenta todo mundo');
  assert.ok(r.max === 2 && r.min === 2, `cada adversário deveria ser enfrentado 2x (${r.min}..${r.max})`);
});
ok('Super 12: 11 rodadas, 33 jogos', () => {
  const r = checkAmericano(12);
  assert.strictEqual(r.sched.flatMap((x) => x.matches).length, 33);
  assert.ok(r.max === 2 && r.min === 2, `cada adversário deveria ser enfrentado 2x (${r.min}..${r.max})`);
});
ok('Americano 16 e 20 atletas: também equilíbrio perfeito (whist)', () => {
  for (const n of [16, 20]) {
    const r = checkAmericano(n);
    assert.ok(r.max === 2 && r.min === 2, `n=${n} (${r.min}..${r.max})`);
  }
});
ok('nº que não é múltiplo de 4 é recusado (sem chute)', () => {
  assert.throws(() => F.americanoSchedule(['a', 'b', 'c', 'd', 'e', 'f']));
});
ok('ranking individual por games: cada atleta soma os games da sua dupla', () => {
  const ms = [
    { homeEntryId: 'a', homeEntry2Id: 'b', awayEntryId: 'c', awayEntry2Id: 'd', homeScore: 6, awayScore: 3 },
    { homeEntryId: 'a', homeEntry2Id: 'c', awayEntryId: 'b', awayEntry2Id: 'd', homeScore: 2, awayScore: 6 },
  ];
  const t = F.tallyAmericano(['a', 'b', 'c', 'd'].map((id) => ({ id })), ms);
  assert.deepStrictEqual([t.a.points, t.b.points, t.c.points, t.d.points], [8, 12, 5, 9]);
  const r = F.rankTable(Object.values(t), { criteria: F.AMERICANO_TIEBREAKERS, seed: 'x' });
  assert.deepStrictEqual(ids(r), ['b', 'd', 'a', 'c']);
});

// ---------------------------------------------------------------------
console.log('suspensão automática');
const day = (d) => new Date(Date.UTC(2026, 10, d, 22)).toISOString();
const G = (id, d, status = 'FINISHED', h = 'T', a = 'X') => ({ id, homeEntryId: h, awayEntryId: a, status, scheduledAt: day(d), round: d });
const players = [{ id: 'p1', name: 'Zé', number: 10, entryId: 'T' }];
ok('3 amarelos acumulados = suspenso no PRÓXIMO jogo; cumpriu → liberado e zerado', () => {
  const matches = [G('m1', 1), G('m2', 2), G('m3', 3), G('m4', 4, 'SCHEDULED'), G('m5', 5, 'SCHEDULED')];
  const events = ['m1', 'm2', 'm3'].map((m) => ({ matchId: m, playerId: 'p1', entryId: 'T', type: 'YELLOW' }));
  const r = F.computeSuspensions({ matches, events, players, rule: { enabled: true } });
  assert.strictEqual(r.suspended.length, 1);
  assert.deepStrictEqual(r.suspended[0].matchIds, ['m4']);
  assert.strictEqual(r.suspended[0].yellowCount, 0, 'acúmulo zera ao gerar a suspensão');
  assert.ok(F.suspensionFor(r, 'p1', 'm4'));
  assert.ok(!F.suspensionFor(r, 'p1', 'm5'));
  assert.match(F.suspensionReasonText(r.suspended[0]), /3 amarelos/);
  // m4 encerrado = cumpriu
  matches[3].status = 'FINISHED';
  const r2 = F.computeSuspensions({ matches, events, players, rule: { enabled: true } });
  assert.strictEqual(r2.suspended.length, 0);
});
ok('vermelho = 1 jogo; 2 amarelos no mesmo jogo = expulsão e NÃO somam no acúmulo', () => {
  const matches = [G('m1', 1), G('m2', 2, 'SCHEDULED'), G('m3', 3, 'SCHEDULED')];
  const ev = [
    { matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'YELLOW' },
    { matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'YELLOW' },
  ];
  const r = F.computeSuspensions({ matches, events: ev, players, rule: { enabled: true } });
  assert.deepStrictEqual(r.suspended[0].matchIds, ['m2']);
  assert.strictEqual(r.suspended[0].reasons[0].type, 'RED');
  assert.strictEqual(r.suspended[0].yellowCount, 0);
  // amarelo + vermelho no mesmo jogo: 1 jogo (vermelho) e o amarelo conta no acúmulo
  const ev2 = [
    { matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'YELLOW' },
    { matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'RED' },
  ];
  const r2 = F.computeSuspensions({ matches, events: ev2, players, rule: { enabled: true } });
  assert.strictEqual(r2.suspended[0].gamesRemaining, 1);
  assert.strictEqual(r2.suspended[0].yellowCount, 1);
});
ok('regra configurável: 2 amarelos = 2 jogos; vermelho = 3 jogos', () => {
  const rule = { yellowLimit: 2, yellowBan: 2, redBan: 3 };
  const matches = [G('m1', 1), G('m2', 2), G('m3', 3, 'SCHEDULED'), G('m4', 4, 'SCHEDULED'), G('m5', 5, 'SCHEDULED')];
  const ev = [
    { matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'YELLOW' },
    { matchId: 'm2', playerId: 'p1', entryId: 'T', type: 'YELLOW' },
  ];
  const r = F.computeSuspensions({ matches, events: ev, players, rule });
  assert.deepStrictEqual(r.suspended[0].matchIds, ['m3', 'm4']);
  const r2 = F.computeSuspensions({ matches, events: [{ matchId: 'm2', playerId: 'p1', entryId: 'T', type: 'RED' }], players, rule });
  assert.deepStrictEqual(r2.suspended[0].matchIds, ['m3', 'm4', 'm5']);
});
ok('cartão de jogo NÃO encerrado (ao vivo) não conta; regra desligada = ninguém suspenso', () => {
  const matches = [G('m1', 1, 'LIVE'), G('m2', 2, 'SCHEDULED')];
  const ev = [{ matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'RED' }];
  assert.strictEqual(F.computeSuspensions({ matches, events: ev, players, rule: { enabled: true } }).suspended.length, 0);
  const m2 = [G('m1', 1), G('m2', 2, 'SCHEDULED')];
  assert.strictEqual(F.computeSuspensions({ matches: m2, events: ev, players, rule: { enabled: false } }).suspended.length, 0);
  // categoria SEM regra salva (torneio que já rodava) = desligada: ninguém é suspenso de surpresa
  assert.strictEqual(F.computeSuspensions({ matches: m2, events: ev, players }).suspended.length, 0);
});
ok('pendurado: 2 amarelos com limite 3', () => {
  const matches = [G('m1', 1), G('m2', 2), G('m3', 3, 'SCHEDULED')];
  const ev = ['m1', 'm2'].map((m) => ({ matchId: m, playerId: 'p1', entryId: 'T', type: 'YELLOW' }));
  const r = F.computeSuspensions({ matches, events: ev, players, rule: { enabled: true } });
  assert.strictEqual(r.suspended.length, 0);
  assert.strictEqual(r.hanging.length, 1);
});
ok('ordem cronológica: jogo de rodada posterior encerrado ANTES conta na ordem real', () => {
  // m3 (rodada 3) jogado antes de m2 (rodada 2, adiado)
  const matches = [
    { id: 'm1', homeEntryId: 'T', awayEntryId: 'X', status: 'FINISHED', scheduledAt: day(1), round: 1 },
    { id: 'm3', homeEntryId: 'T', awayEntryId: 'X', status: 'FINISHED', scheduledAt: day(2), round: 3 },
    { id: 'm2', homeEntryId: 'T', awayEntryId: 'X', status: 'SCHEDULED', scheduledAt: day(9), round: 2 },
  ];
  const ev = [{ matchId: 'm1', playerId: 'p1', entryId: 'T', type: 'RED' }];
  // vermelho no m1 → cumpre no m3 (próximo jogo REAL), m2 liberado
  const r = F.computeSuspensions({ matches, events: ev, players, rule: { enabled: true } });
  assert.strictEqual(r.suspended.length, 0);
});

// ---------------------------------------------------------------------
console.log('campeão da categoria (histórico da série)');
ok('mata-mata: vencedor da FINAL encerrada', () => {
  const ms = [{ stage: 'FINAL', status: 'FINISHED', homeEntryId: 'A', awayEntryId: 'B', winnerEntryId: 'B' }];
  assert.deepStrictEqual(F.categoryChampion(ms), { championId: 'B', runnerUpId: 'A', source: 'FINAL' });
  assert.strictEqual(F.categoryChampion([{ stage: 'FINAL', status: 'SCHEDULED' }]), null);
});
ok('dupla eliminação: reset decide; reset pendente = ainda sem campeão', () => {
  const gf = { stage: 'FINAL', status: 'FINISHED', homeEntryId: 'A', awayEntryId: 'B', winnerEntryId: 'B' };
  assert.strictEqual(F.categoryChampion([gf, { stage: 'FINAL_RESET', status: 'SCHEDULED', homeEntryId: 'A', awayEntryId: 'B' }]), null);
  const done = F.categoryChampion([gf, { stage: 'FINAL_RESET', status: 'FINISHED', homeEntryId: 'A', awayEntryId: 'B', winnerEntryId: 'A' }]);
  assert.deepStrictEqual(done, { championId: 'A', runnerUpId: 'B', source: 'FINAL_RESET' });
  const gfA = { ...gf, winnerEntryId: 'A' };
  assert.strictEqual(F.categoryChampion([gfA, { stage: 'FINAL_RESET', status: 'CANCELED' }]).championId, 'A');
});
ok('pontos corridos: 1º da tabela quando TODOS os jogos acabaram', () => {
  const ms = [{ stage: 'LEAGUE', status: 'FINISHED' }, { stage: 'LEAGUE', status: 'FINISHED' }];
  const st = [{ entryId: 'B', rank: 2 }, { entryId: 'A', rank: 1 }];
  assert.strictEqual(F.categoryChampion(ms, st).championId, 'A');
  assert.strictEqual(F.categoryChampion([...ms, { stage: 'LEAGUE', status: 'SCHEDULED' }], st), null);
});

if (process.exitCode) {
  console.error('\n❌ Falhou — veja acima.');
} else {
  console.log('\n✅ ' + passed + ' testes passaram.');
}
