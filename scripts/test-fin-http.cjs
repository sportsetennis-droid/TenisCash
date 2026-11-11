'use strict';
// Financeiro — Fase 1: rotas /api/fin com Postgres real (CI). Banco descartável apenas.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const url = process.env.ROUND_TEST_DATABASE_URL;
if (!url?.startsWith('postgresql://roundtest@127.0.0.1:55329/')) throw Error('Somente banco local isolado.');
process.env.DATABASE_URL = url;

const mw = require('../src/middleware');
const db = mw.prisma;
const { createFinSchemaReadiness } = require('../src/services/finSchema');
const { OWNER_RECORD_KEY } = require('../src/services/rankingOwner');
const router = require('../src/routes/fin');

const app = express();
app.use(express.json());
app.use('/api/fin', router);

(async () => {
  // Schema roda 2x por cima do db push sem erro (idempotente).
  await createFinSchemaReadiness(db)();
  await createFinSchemaReadiness(db)();

  const u = randomUUID();
  const users = {};
  for (const [key, role] of [['admin', 'admin'], ['owner', 'superadmin'], ['robot', 'superadmin'], ['seller', 'seller']]) {
    users[key] = await db.user.create({ data: { name: 'fin-' + key, role, phone: 'fin-' + key + '-' + u, pin: 'test-only' } });
  }
  const prevOwner = await db.config.findUnique({ where: { key: OWNER_RECORD_KEY } });
  await db.config.upsert({ where: { key: OWNER_RECORD_KEY }, create: { id: OWNER_RECORD_KEY, key: OWNER_RECORD_KEY, value: JSON.stringify({ userId: users.owner.id, evidenceId: 'test-' + u }) }, update: { value: JSON.stringify({ userId: users.owner.id, evidenceId: 'test-' + u }) } });
  const store = await db.store.create({ data: { code: 'FIN-' + u.slice(0, 8), name: 'Loja Fin Teste', pagbankEnabled: true } });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/fin';
  const call = async (path, { method, body, who = 'admin' } = {}) => {
    const r = await fetch(base + path, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { ...(who ? { Authorization: 'Bearer ' + jwt.sign({ userId: users[who].id }, mw.JWT_SECRET, { expiresIn: '5m' }) } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };

  try {
    // Acesso
    assert.equal((await call('/natures', { who: null })).status, 401);
    assert.equal((await call('/natures', { who: 'seller' })).status, 403);
    assert.equal((await call('/me', { who: 'owner' })).data.isOwner, true);
    assert.equal((await call('/me', { who: 'robot' })).data.isOwner, false, 'superadmin que não é o dono');
    assert.equal((await call('/me')).data.isOwner, false);

    // Plano de contas semeado
    const list = await call('/natures');
    assert.equal(list.status, 200);
    const g06 = list.data.natures.find((n) => n.code === '06');
    assert.ok(g06 && !g06.analytic);
    assert.ok(list.data.natures.some((n) => n.code === '99.99' && n.analytic));

    // Criar, duplicar, renomear — com auditoria
    const code = '06.' + String(50 + Math.floor(Math.random() * 49));
    const created = await call('/natures', { body: { parentId: g06.id, code, name: 'Seguro teste', kind: 'DESPESA', dreGroup: 'OCUPACAO' } });
    assert.equal(created.status, 201, JSON.stringify(created));
    const id = created.data.nature.id;
    assert.equal((await call('/natures', { body: { parentId: g06.id, code, name: 'Dup', kind: 'DESPESA', dreGroup: 'OCUPACAO' } })).status, 409);
    assert.equal((await call('/natures/' + id, { method: 'PATCH', body: { code: '06.98' } })).status, 400);
    assert.equal((await call('/natures/' + id, { method: 'PATCH', body: { name: 'Seguro da loja' } })).status, 200);
    let logs = await db.finAuditLog.findMany({ where: { entity: 'FinNature', entityId: id }, orderBy: { at: 'asc' } });
    assert.deepEqual(logs.map((l) => l.action), ['create', 'update']);
    assert.equal(logs[1].before.name, 'Seguro teste');
    assert.equal(logs[1].after.name, 'Seguro da loja');
    assert.equal(logs[1].actorId, users.admin.id);

    // Desativar exige motivo; grupo com filhos ativos não desativa
    assert.equal((await call('/natures/' + id + '/deactivate', { body: {} })).status, 400);
    assert.equal((await call('/natures/' + g06.id + '/deactivate', { body: { reason: 'teste grupo' } })).status, 400);
    const off = await call('/natures/' + id + '/deactivate', { body: { reason: 'não usamos seguro' } });
    assert.equal(off.status, 200);
    assert.equal(off.data.nature.active, false);
    assert.equal(off.data.nature.inactiveReason, 'não usamos seguro');
    assert.ok(!(await call('/natures')).data.natures.some((n) => n.id === id), 'desativada some da lista padrão');
    assert.ok((await call('/natures?all=1')).data.natures.some((n) => n.id === id), 'continua no banco');

    // Contas financeiras: padrão das lojas sem duplicar
    const seed1 = await call('/accounts/seed-stores', { body: {} });
    assert.equal(seed1.status, 200, JSON.stringify(seed1));
    const mine = seed1.data.accounts.filter((a) => a.storeId === store.id).map((a) => a.type).sort();
    assert.deepEqual(mine, ['ADQUIRENTE_STONE', 'CAIXA_LOJA', 'PSP_PAGBANK']);
    assert.equal((await call('/accounts/seed-stores', { body: {} })).data.created, 0, 'segunda vez não cria nada');
    assert.equal((await call('/accounts', { body: { type: 'CAIXA_LOJA', name: 'Caixa sem loja' } })).status, 400);
    const bank = await call('/accounts', { body: { type: 'BANCO', name: 'Banco teste', storeId: store.id, bankCode: '001', openingBalance: '1.234,56', openingDate: '2026-11-01' } });
    assert.equal(bank.status, 201, JSON.stringify(bank));
    assert.equal(bank.data.account.openingBalanceCents, 123456);
    assert.equal((await call('/accounts/' + bank.data.account.id, { method: 'PATCH', body: { type: 'COFRE' } })).status, 400);

    // Auditoria é imutável no banco
    const one = await db.finAuditLog.findFirst({ where: { entityId: id } });
    await assert.rejects(db.$executeRawUnsafe('UPDATE "FinAuditLog" SET "reason" = \'x\' WHERE "id" = $1', one.id), /somente inclusão/);
    await assert.rejects(db.$executeRawUnsafe('DELETE FROM "FinAuditLog" WHERE "id" = $1', one.id), /somente inclusão/);
    logs = await call('/audit?entity=FinNature&entityId=' + id);
    assert.equal(logs.data.logs.length, 3);
    assert.equal(logs.data.logs[0].actorName, 'fin-admin');

    console.log('PASS fin HTTP: acesso, dono, plano de contas, motivo obrigatório, contas padrão sem duplicar, centavos, auditoria imutável');
  } finally {
    await new Promise((r) => server.close(r));
    if (prevOwner) await db.config.update({ where: { key: OWNER_RECORD_KEY }, data: { value: prevOwner.value } });
    else await db.config.delete({ where: { key: OWNER_RECORD_KEY } }).catch(() => {});
  }
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
