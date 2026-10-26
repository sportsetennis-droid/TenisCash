'use strict';

const express = require('express');
const { localDay, validDay, attendance, canRecord, validateEntry, sameEntry, groupProduction, UUID } = require('../services/mfDailyProduction');

module.exports = function createDailyRoutes({ prisma, mfAuth }) {
  const router = express.Router();
  const recorderOnly = (req, res, next) => canRecord(req.emp) ? next() : res.status(403).json({ error: 'Apenas o responsável pela produção pode lançar para a equipe.' });
  const fail = (res, err) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[mf/daily]', err.code || err.message);
    return res.status(500).json({ error: 'Não foi possível salvar ou consultar os registros. Tente novamente.' });
  };
  const reject = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const parseDay = req => {
    const day = req.query.day || localDay();
    if (!validDay(day)) reject(400, 'Data inválida.');
    return day;
  };

  router.post('/ponto', mfAuth, async (req, res) => {
    try {
      const { kind, requestId, lat, lng } = req.body || {};
      if (!['in', 'break_in', 'break_out', 'out'].includes(kind)) reject(400, 'Tipo de batida inválido.');
      if (requestId != null && !UUID.test(requestId)) reject(400, 'Identificador de batida inválido.');
      if (req.body.employeeId && req.body.employeeId !== req.emp.id) reject(403, 'Cada pessoa deve bater o próprio ponto.');
      const result = await prisma.$transaction(async tx => {
        // Serializa batidas da mesma pessoa, inclusive em instâncias diferentes do servidor.
        await tx.$queryRaw`SELECT id FROM "MfEmployee" WHERE id = ${req.emp.id} FOR UPDATE`;
        if (requestId) {
          const prior = await tx.mfTimeEntry.findUnique({ where: { requestId } });
          if (prior) {
            if (prior.employeeId !== req.emp.id || prior.kind !== kind) reject(409, 'Identificador já utilizado em outra batida.');
            return prior;
          }
        }
        const now = new Date(), day = localDay(now);
        const entries = await tx.mfTimeEntry.findMany({ where: { employeeId: req.emp.id, day }, orderBy: { at: 'asc' } });
        if (!attendance(entries, day, now).allowedKinds.includes(kind)) reject(409, 'Essa batida não corresponde à sequência do ponto. Confira os registros de hoje.');
        return tx.mfTimeEntry.create({ data: {
          employeeId: req.emp.id, kind, day, at: now, requestId: requestId || null,
          lat: typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90 ? lat : null,
          lng: typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180 ? lng : null,
        } });
      });
      return res.json({ ok: true, at: result.at, kind: result.kind });
    } catch (err) { return fail(res, err); }
  });

  router.get('/ponto/today', mfAuth, async (req, res) => {
    try {
      const day = localDay();
      const entries = await prisma.mfTimeEntry.findMany({ where: { employeeId: req.emp.id, day }, orderBy: { at: 'asc' } });
      res.json({ day, entries, attendance: attendance(entries, day) });
    } catch (err) { fail(res, err); }
  });

  router.get('/ponto/board', mfAuth, recorderOnly, async (req, res) => {
    try {
      const day = parseDay(req);
      const entries = await prisma.mfTimeEntry.findMany({ where: { day }, orderBy: { at: 'asc' } });
      const employees = await prisma.mfEmployee.findMany({ where: { OR: [{ active: true }, { id: { in: [...new Set(entries.map(e => e.employeeId))] } }] }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      res.json({ day, employees: employees.map(e => {
        const punches = entries.filter(p => p.employeeId === e.id);
        return { id: e.id, name: e.name, punches, attendance: attendance(punches, day) };
      }) });
    } catch (err) { fail(res, err); }
  });

  router.get('/production-daily', mfAuth, async (req, res) => {
    try {
      const day = parseDay(req), team = canRecord(req.emp);
      const scope = team ? {} : { employeeId: req.emp.id };
      const [entries, punches] = await Promise.all([
        prisma.mfProductionEntry.findMany({ where: { day, ...scope }, orderBy: { createdAt: 'asc' }, include: { employee: { select: { name: true } }, recorder: { select: { name: true } } } }),
        prisma.mfTimeEntry.findMany({ where: { day, ...scope }, orderBy: { at: 'asc' } }),
      ]);
      const ids = [...new Set([...entries, ...punches].map(e => e.employeeId))];
      const employees = await prisma.mfEmployee.findMany({
        where: team ? { OR: [{ active: true }, { id: { in: ids } }] } : { id: req.emp.id },
        select: { id: true, name: true, active: true }, orderBy: { name: 'asc' },
      });
      res.json({ day, canRecord: team, entries, byActivity: groupProduction(entries), employees: employees.map(e => ({
        ...e, attendance: attendance(punches.filter(p => p.employeeId === e.id), day),
        punches: punches.filter(p => p.employeeId === e.id).map(p => ({ kind: p.kind, at: p.at })),
        production: groupProduction(entries.filter(p => p.employeeId === e.id)),
      })) });
    } catch (err) { fail(res, err); }
  });

  router.post('/production-daily', mfAuth, recorderOnly, async (req, res) => {
    try {
      let data;
      try { data = { ...validateEntry(req.body || {}), recorderId: req.emp.id }; }
      catch (err) { reject(400, err.message); }
      const prior = await prisma.mfProductionEntry.findUnique({ where: { requestId: data.requestId } });
      if (prior) {
        if (!sameEntry(prior, data)) reject(409, 'Identificador já utilizado em outro lançamento.');
        return res.json({ ok: true, entry: prior, repeated: true });
      }
      const employee = await prisma.mfEmployee.findUnique({ where: { id: data.employeeId }, select: { id: true, active: true } });
      if (!employee || !employee.active) reject(400, 'Selecione um funcionário ativo da Meta Fardamentos.');
      try {
        const entry = await prisma.mfProductionEntry.create({ data });
        return res.status(201).json({ ok: true, entry });
      } catch (err) {
        if (err.code !== 'P2002') throw err;
        const entry = await prisma.mfProductionEntry.findUnique({ where: { requestId: data.requestId } });
        if (!entry || !sameEntry(entry, data)) reject(409, 'Identificador já utilizado em outro lançamento.');
        return res.json({ ok: true, entry, repeated: true });
      }
    } catch (err) { return fail(res, err); }
  });

  router.delete('/production-daily/:id', mfAuth, recorderOnly, async (req, res) => {
    try {
      const entry = await prisma.mfProductionEntry.findUnique({ where: { id: req.params.id } });
      if (!entry) reject(404, 'Lançamento não encontrado.');
      await prisma.mfProductionEntry.updateMany({ where: { id: entry.id, voidedAt: null }, data: { voidedAt: new Date(), voidedById: req.emp.id } });
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });
  return router;
};
