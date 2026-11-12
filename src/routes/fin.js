'use strict';

// =====================================================================
// /api/fin — Financeiro do varejo (Fase 1: plano de contas, contas financeiras,
// auditoria). Admin lê e cadastra; nada é apagado (desativa com motivo);
// toda escrita grava FinAuditLog na mesma transação.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { createFinSchemaReadiness } = require('../services/finSchema');
const { audit } = require('../services/finAudit');
const { isFinOwner } = require('../services/finOwner');
const catalog = require('../services/finCatalog');

const router = express.Router();
const ensureFinSchema = createFinSchemaReadiness(prisma);

router.use(authMiddleware);
router.use(adminMiddleware);
router.use(ensureFinSchema.middleware);

function fail(res, err, tag) {
  if (err instanceof catalog.FinValidationError) return res.status(400).json({ error: err.message });
  if (err && err.code === 'P2002') return res.status(409).json({ error: 'Já existe um cadastro com esse código' });
  if (err && err.code === 'P2025') return res.status(404).json({ error: 'Cadastro não encontrado' });
  console.error('[fin ' + tag + ']', err);
  return res.status(500).json({ error: 'Erro interno no financeiro' });
}

router.get('/me', async (req, res) => {
  try {
    res.json({ userId: req.userId, role: req.userRole, isOwner: await isFinOwner(prisma, req) });
  } catch (err) { fail(res, err, 'me'); }
});

// ----------------------------- Plano de contas -----------------------------

router.get('/natures', async (req, res) => {
  try {
    const where = req.query.all === '1' ? {} : { active: true };
    const natures = await prisma.finNature.findMany({ where, orderBy: { code: 'asc' } });
    res.json({ natures, kinds: catalog.NATURE_KINDS, dreGroups: catalog.DRE_GROUPS });
  } catch (err) { fail(res, err, 'natures'); }
});

router.post('/natures', async (req, res) => {
  try {
    const body = req.body || {};
    const parent = body.parentId ? await prisma.finNature.findUnique({ where: { id: String(body.parentId) } }) : null;
    if (body.parentId && !parent) return res.status(400).json({ error: 'Conta-mãe não encontrada' });
    const data = catalog.validateNatureCreate(body, parent);
    const nature = await prisma.$transaction(async (tx) => {
      const created = await tx.finNature.create({ data });
      await audit(tx, { entity: 'FinNature', entityId: created.id, action: 'create', after: created, req });
      return created;
    });
    res.status(201).json({ nature });
  } catch (err) { fail(res, err, 'natures:create'); }
});

router.patch('/natures/:id', async (req, res) => {
  try {
    const data = catalog.validateNatureUpdate(req.body || {});
    const nature = await prisma.$transaction(async (tx) => {
      const before = await tx.finNature.findUnique({ where: { id: req.params.id } });
      if (!before) { const e = new Error('nf'); e.code = 'P2025'; throw e; }
      const after = await tx.finNature.update({ where: { id: before.id }, data });
      await audit(tx, { entity: 'FinNature', entityId: before.id, action: 'update', before, after, req });
      return after;
    });
    res.json({ nature });
  } catch (err) { fail(res, err, 'natures:update'); }
});

async function setNatureActive(req, res, active) {
  try {
    const reason = catalog.validateReason((req.body || {}).reason);
    const nature = await prisma.$transaction(async (tx) => {
      const before = await tx.finNature.findUnique({ where: { id: req.params.id } });
      if (!before) { const e = new Error('nf'); e.code = 'P2025'; throw e; }
      if (!active && !before.analytic) {
        const activeChildren = await tx.finNature.count({ where: { parentId: before.id, active: true } });
        if (activeChildren) throw new catalog.FinValidationError('Desative antes as ' + activeChildren + ' contas deste grupo');
      }
      if (active && before.parentId) {
        const parent = await tx.finNature.findUnique({ where: { id: before.parentId } });
        if (parent && !parent.active) throw new catalog.FinValidationError('Reative antes o grupo ' + parent.code);
      }
      const after = await tx.finNature.update({ where: { id: before.id }, data: { active, inactiveReason: active ? null : reason } });
      await audit(tx, { entity: 'FinNature', entityId: before.id, action: active ? 'activate' : 'deactivate', before, after, reason, req });
      return after;
    });
    res.json({ nature });
  } catch (err) { fail(res, err, 'natures:active'); }
}
router.post('/natures/:id/deactivate', (req, res) => setNatureActive(req, res, false));
router.post('/natures/:id/activate', (req, res) => setNatureActive(req, res, true));

// ----------------------------- Contas financeiras -----------------------------

router.get('/accounts', async (req, res) => {
  try {
    const where = req.query.all === '1' ? {} : { active: true };
    const [accounts, stores] = await Promise.all([
      prisma.finAccount.findMany({ where, orderBy: [{ storeId: 'asc' }, { type: 'asc' }, { name: 'asc' }] }),
      prisma.store.findMany({ select: { id: true, code: true, name: true, active: true, fiscalIssuerId: true, pagbankEnabled: true }, orderBy: { code: 'asc' } }),
    ]);
    res.json({ accounts, stores, types: catalog.ACCOUNT_TYPES });
  } catch (err) { fail(res, err, 'accounts'); }
});

async function assertStore(tx, storeId) {
  if (!storeId) return null;
  const store = await tx.store.findUnique({ where: { id: storeId }, select: { id: true, fiscalIssuerId: true } });
  if (!store) throw new catalog.FinValidationError('Loja não encontrada');
  return store;
}

router.post('/accounts', async (req, res) => {
  try {
    const data = catalog.validateAccount(req.body || {});
    const account = await prisma.$transaction(async (tx) => {
      const store = await assertStore(tx, data.storeId);
      if (store && !data.fiscalIssuerId) data.fiscalIssuerId = store.fiscalIssuerId || null;
      const created = await tx.finAccount.create({ data });
      await audit(tx, { entity: 'FinAccount', entityId: created.id, action: 'create', after: created, req });
      return created;
    });
    res.status(201).json({ account });
  } catch (err) { fail(res, err, 'accounts:create'); }
});

router.patch('/accounts/:id', async (req, res) => {
  try {
    const data = catalog.validateAccount(req.body || {}, { partial: true });
    const account = await prisma.$transaction(async (tx) => {
      const before = await tx.finAccount.findUnique({ where: { id: req.params.id } });
      if (!before) { const e = new Error('nf'); e.code = 'P2025'; throw e; }
      if (data.storeId !== undefined) await assertStore(tx, data.storeId);
      const after = await tx.finAccount.update({ where: { id: before.id }, data });
      await audit(tx, { entity: 'FinAccount', entityId: before.id, action: 'update', before, after, req });
      return after;
    });
    res.json({ account });
  } catch (err) { fail(res, err, 'accounts:update'); }
});

async function setAccountActive(req, res, active) {
  try {
    const reason = catalog.validateReason((req.body || {}).reason);
    const account = await prisma.$transaction(async (tx) => {
      const before = await tx.finAccount.findUnique({ where: { id: req.params.id } });
      if (!before) { const e = new Error('nf'); e.code = 'P2025'; throw e; }
      const after = await tx.finAccount.update({ where: { id: before.id }, data: { active, inactiveReason: active ? null : reason } });
      await audit(tx, { entity: 'FinAccount', entityId: before.id, action: active ? 'activate' : 'deactivate', before, after, reason, req });
      return after;
    });
    res.json({ account });
  } catch (err) { fail(res, err, 'accounts:active'); }
}
router.post('/accounts/:id/deactivate', (req, res) => setAccountActive(req, res, false));
router.post('/accounts/:id/activate', (req, res) => setAccountActive(req, res, true));

// Cria (sem duplicar) caixa + Stone (+ PagBank se a loja usa) para cada loja ativa.
router.post('/accounts/seed-stores', async (req, res) => {
  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('fin-seed-store-accounts'))) AS fin_seed_lock`;
      const stores = await tx.store.findMany({ select: { id: true, code: true, name: true, active: true, fiscalIssuerId: true, pagbankEnabled: true } });
      const existing = await tx.finAccount.findMany({ select: { storeId: true, type: true } });
      const plan = catalog.planStoreAccounts(stores, existing);
      const out = [];
      for (const data of plan) {
        const acc = await tx.finAccount.create({ data });
        await audit(tx, { entity: 'FinAccount', entityId: acc.id, action: 'create', after: acc, reason: 'contas padrão das lojas', req });
        out.push(acc);
      }
      return out;
    });
    res.json({ created: created.length, accounts: created });
  } catch (err) { fail(res, err, 'accounts:seed'); }
});

// ----------------------------- Contas a pagar por loja -----------------------------

router.use(require('./finPayablesRoutes'));

// ----------------------------- Auditoria -----------------------------

router.get('/audit', async (req, res) => {
  try {
    const where = {};
    if (req.query.entity) where.entity = String(req.query.entity);
    if (req.query.entityId) where.entityId = String(req.query.entityId);
    const take = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const logs = await prisma.finAuditLog.findMany({ where, orderBy: { at: 'desc' }, take });
    const actorIds = [...new Set(logs.map((l) => l.actorId).filter(Boolean))];
    const actors = actorIds.length ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
    const nameById = Object.fromEntries(actors.map((a) => [a.id, a.name]));
    res.json({ logs: logs.map((l) => ({ ...l, actorName: nameById[l.actorId] || null })) });
  } catch (err) { fail(res, err, 'audit'); }
});

module.exports = router;
module.exports.ensureFinSchema = ensureFinSchema;
