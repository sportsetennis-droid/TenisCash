'use strict';
// =====================================================================
// Teste das funções PURAS do motor de torneios (sem banco):
// nextPow2, seedSlots (ordem de cabeças de chave) e roundRobinRounds
// (todos jogam contra todos, uma vez). Roda com: node scripts/test-tournament-engine.js
// =====================================================================

const assert = require('assert');
const { seedSlots, roundRobinRounds, nextPow2 } = require('../src/services/tournamentEngine');

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

console.log('nextPow2');
ok('arredonda pra cima pra potência de 2', () => {
  assert.strictEqual(nextPow2(1), 1);
  assert.strictEqual(nextPow2(2), 2);
  assert.strictEqual(nextPow2(3), 4);
  assert.strictEqual(nextPow2(5), 8);
  assert.strictEqual(nextPow2(8), 8);
  assert.strictEqual(nextPow2(9), 16);
});

console.log('seedSlots');
ok('bracket de 2 = [1,2]', () => {
  assert.deepStrictEqual(seedSlots(2), [1, 2]);
});
ok('bracket de 4 = [1,4,2,3]', () => {
  assert.deepStrictEqual(seedSlots(4), [1, 4, 2, 3]);
});
ok('bracket de 8 = [1,8,4,5,2,7,3,6]', () => {
  assert.deepStrictEqual(seedSlots(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});
ok('cabeça 1 e 2 em metades opostas (não se cruzam antes da final)', () => {
  const s = seedSlots(8);
  const i1 = s.indexOf(1);
  const i2 = s.indexOf(2);
  assert.ok(i1 < 4 && i2 >= 4, 'seed 1 e 2 devem cair em metades diferentes');
});

console.log('roundRobinRounds');
ok('par (4 times): 3 rodadas, 6 jogos, cada par 1x', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const rounds = roundRobinRounds(entries);
  assert.strictEqual(rounds.length, 3, '4 times = 3 rodadas');
  const pairs = rounds.flat();
  assert.strictEqual(pairs.length, 6, '4 times = 6 confrontos');
  const seen = new Set();
  for (const [h, a] of pairs) {
    const key = [h.id, a.id].sort().join('-');
    assert.ok(!seen.has(key), 'confronto repetido: ' + key);
    seen.add(key);
    assert.notStrictEqual(h.id, a.id, 'time não joga contra si mesmo');
  }
  assert.strictEqual(seen.size, 6);
});
ok('ímpar (3 times): 3 rodadas, 3 jogos, cada par 1x (bye descartado)', () => {
  const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const rounds = roundRobinRounds(entries);
  assert.strictEqual(rounds.length, 3, '3 times = 3 rodadas (round-robin com bye)');
  const pairs = rounds.flat();
  assert.strictEqual(pairs.length, 3, '3 times = 3 confrontos');
  for (const [h, a] of pairs) assert.ok(h && a, 'sem par nulo (bye) nos confrontos');
});

if (process.exitCode) {
  console.error('\n❌ Falhou — veja acima.');
} else {
  console.log('\n✅ ' + passed + ' testes passaram.');
}
