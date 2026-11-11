'use strict';

// Financeiro — Fase 1 (funções puras, sem banco).
const assert = require('assert');
const money = require('../src/services/money');
const catalog = require('../src/services/finCatalog');
const { buildAuditData } = require('../src/services/finAudit');
const { loadStatements, splitStatements } = require('../src/services/finSchema');

// ---------- money ----------
assert.strictEqual(money.toCents(1.005), 101);
assert.strictEqual(money.toCents(0.1 + 0.2), 30);
assert.strictEqual(money.toCents('1.234,56'), 123456);
assert.strictEqual(money.toCents('R$ 12,50'), 1250);
assert.strictEqual(money.toCents('12.50'), 1250);
assert.strictEqual(money.toCents(''), 0);
assert.strictEqual(money.toCents(null), 0);
assert.strictEqual(money.toCents(-2.675), -268);
assert.strictEqual(money.fromCents(12345), 123.45);
assert.strictEqual(money.sumCents([100, 250, -50]), 300);
assert.throws(() => money.sumCents([1.5]), /centavos inteiros/);
assert.deepStrictEqual(money.allocateCents(10000, [1, 1, 1]), [3334, 3333, 3333]);
assert.deepStrictEqual(money.allocateCents(100, [0, 0]), [50, 50]);
assert.deepStrictEqual(money.allocateCents(-1001, [1, 1]), [-501, -500]);
for (const [t, w] of [[99999, [3, 7, 11]], [1, [1, 1, 1]], [123457, [0.2, 0.3, 0.5]]]) {
  const parts = money.allocateCents(t, w);
  assert.strictEqual(parts.reduce((s, x) => s + x, 0), t, 'allocateCents perdeu centavo');
}
assert.strictEqual(money.fmtBRL(123456789), 'R$ 1.234.567,89');
assert.strictEqual(money.fmtBRL(-5), '-R$ 0,05');

// ---------- plano de contas ----------
const group = { id: 'g06', code: '06', analytic: false, active: true };
let n = catalog.validateNatureCreate({ code: '06.07', name: ' Seguro ', kind: 'despesa', dreGroup: 'ocupacao' }, group);
assert.deepStrictEqual(n, { code: '06.07', name: 'Seguro', kind: 'DESPESA', dreGroup: 'OCUPACAO', parentId: 'g06', analytic: true });
n = catalog.validateNatureCreate({ code: '11', name: 'Novo grupo', kind: 'DESPESA', dreGroup: 'ADMINISTRATIVA' }, null);
assert.strictEqual(n.analytic, false);
assert.throws(() => catalog.validateNatureCreate({ code: '07.01', name: 'x', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, group), /logo abaixo de 06/);
assert.throws(() => catalog.validateNatureCreate({ code: '06.07.01', name: 'x', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, group), /logo abaixo/);
assert.throws(() => catalog.validateNatureCreate({ code: '06.07', name: 'x', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, { ...group, analytic: true }), /recebe lançamento/);
assert.throws(() => catalog.validateNatureCreate({ code: '06.07', name: 'x', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, null), /conta-mãe/);
assert.throws(() => catalog.validateNatureCreate({ code: '6.7', name: 'x', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, null), /formato/);
assert.throws(() => catalog.validateNatureCreate({ code: '06.07', name: 'x', kind: 'LUCRO', dreGroup: 'OCUPACAO' }, group), /Tipo inválido/);
assert.throws(() => catalog.validateNatureCreate({ code: '06.07', name: '', kind: 'DESPESA', dreGroup: 'OCUPACAO' }, group), /Nome/);
assert.deepStrictEqual(catalog.validateNatureUpdate({ name: 'Outro' }), { name: 'Outro' });
assert.throws(() => catalog.validateNatureUpdate({ code: '06.08' }), /não podem ser alterados/);
assert.throws(() => catalog.validateNatureUpdate({}), /Nada para alterar/);
assert.throws(() => catalog.validateReason('  '), /Motivo/);
assert.throws(() => catalog.validateReason('ab'), /Explique/);

// ---------- contas financeiras ----------
let a = catalog.validateAccount({ type: 'banco', name: 'BB Bessa', bankCode: '001', openingBalance: '1.500,00', openingDate: '2026-11-01' });
assert.strictEqual(a.type, 'BANCO');
assert.strictEqual(a.openingBalanceCents, 150000);
assert.strictEqual(a.openingDate.toISOString(), '2026-11-01T03:00:00.000Z');
assert.throws(() => catalog.validateAccount({ type: 'CAIXA_LOJA', name: 'Caixa' }), /precisam de loja/);
assert.throws(() => catalog.validateAccount({ type: 'BANCO', name: 'x', openingDate: '2026-02-30' }), /inválida/);
assert.throws(() => catalog.validateAccount({ type: 'BANCO' }, { partial: true }), /não pode ser alterado/);
assert.deepStrictEqual(catalog.validateAccount({ name: 'Novo nome' }, { partial: true }), { name: 'Novo nome' });

const stores = [
  { id: 's1', code: 'LOJA02', name: 'Bessa', active: true, fiscalIssuerId: 'i2', pagbankEnabled: true },
  { id: 's2', code: 'LOJA05', name: 'Tambaú', active: true, fiscalIssuerId: 'i5', pagbankEnabled: false },
  { id: 's3', code: 'LOJA99', name: 'Fechada', active: false },
];
let plan = catalog.planStoreAccounts(stores, []);
assert.deepStrictEqual(plan.map((p) => p.storeId + ':' + p.type), ['s1:CAIXA_LOJA', 's1:ADQUIRENTE_STONE', 's1:PSP_PAGBANK', 's2:CAIXA_LOJA', 's2:ADQUIRENTE_STONE']);
assert.strictEqual(plan[0].fiscalIssuerId, 'i2');
assert.ok(plan.every((p) => !p.bankCode && !p.accountNumber), 'não inventa dado bancário');
plan = catalog.planStoreAccounts(stores, plan);
assert.strictEqual(plan.length, 0, 'rodar 2x não duplica');

// ---------- auditoria ----------
const data = buildAuditData({ entity: 'FinAccount', entityId: 'a1', action: 'update', before: { x: 1 }, after: { x: 2, at: new Date('2026-11-12T00:00:00Z') }, reason: 'teste', req: { userId: 'u1', userRole: 'admin', headers: { 'x-request-id': 'r1' } } });
assert.deepStrictEqual(data, { entity: 'FinAccount', entityId: 'a1', action: 'update', actorId: 'u1', actorRole: 'admin', before: { x: 1 }, after: { x: 2, at: '2026-11-12T00:00:00.000Z' }, reason: 'teste', requestId: 'r1' });
assert.throws(() => buildAuditData({ entity: 'X' }), /exige/);

// ---------- SQL do schema ----------
const stmts = loadStatements();
assert.ok(stmts.length >= 10, 'comandos do schema carregados');
assert.ok(stmts.every((s) => !/^\s*$/.test(s)));
assert.ok(stmts.some((s) => s.includes('$fin$') && s.includes('RAISE EXCEPTION')), 'função do trigger inteira num comando só');
assert.ok(stmts.some((s) => s.startsWith('-- Plano de contas') && s.includes('ON CONFLICT ("code") DO NOTHING')), 'seed com comentário não é descartado');
assert.deepStrictEqual(splitStatements('-- só comentário\n-- @statement\nSELECT 1'), ['SELECT 1']);

// Seed: códigos únicos, toda conta analítica tem grupo existente e inativo-de-lançamento.
const seed = stmts.find((s) => s.includes('INSERT INTO "FinNature"'));
const rows = [...seed.matchAll(/\('(finnat_[\d_]+)', '([\d.]+)', '([^']+)', '(\w+)', '(\w+)', (NULL|'finnat_[\d_]+'), (true|false)\)/g)]
  .map((m) => ({ id: m[1], code: m[2], kind: m[4], dre: m[5], parent: m[6] === 'NULL' ? null : m[6].slice(1, -1), analytic: m[7] === 'true' }));
assert.ok(rows.length >= 50, 'plano de contas completo');
assert.strictEqual(new Set(rows.map((r) => r.code)).size, rows.length, 'código duplicado no seed');
assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, 'id duplicado no seed');
for (const r of rows) {
  assert.ok(catalog.NATURE_KINDS.includes(r.kind), 'tipo inválido ' + r.code);
  assert.ok(catalog.DRE_GROUPS.includes(r.dre), 'grupo DRE inválido ' + r.code);
  if (r.parent) {
    const p = rows.find((x) => x.id === r.parent);
    assert.ok(p && !p.analytic && r.code.startsWith(p.code + '.'), 'conta ' + r.code + ' fora do grupo');
  } else {
    assert.strictEqual(r.analytic, false, 'grupo ' + r.code + ' não pode receber lançamento');
  }
}
assert.ok(rows.some((r) => r.code === '99.99' && r.analytic), 'conta "A classificar" existe');

console.log('test-fin-core: ok');
