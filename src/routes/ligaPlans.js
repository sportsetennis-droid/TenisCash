// =====================================================================
// /api/liga — Liga Aberta F7: planos do organizador (por TAMANHO, SEM PREÇO)
// ---------------------------------------------------------------------
// GET  /api/liga/plans                      catálogo público (nome + limites; sem preço)
// GET  /api/liga/admin/organizer-plan       admin global: plano/uso de um organizador + histórico
//      ?userId= | ?username=   (telefone NÃO vai na URL — fica em log; use o POST)
// POST /api/liga/admin/organizer-plan       admin global: troca o plano { userId|username|phone, planKey, note }
// GET  /api/liga/admin/plan-log             admin global: últimas trocas de plano
// Permissão por roles.can() (ação global PLAN_ADMIN). Nada de cobrança, cartão ou Pix.
// =====================================================================

const express = require('express');
const { authMiddleware } = require('../middleware');
const { limits } = require('../services/ligaRateLimit');
const roles = require('../services/tournamentRoles');
const plans = require('../services/organizerPlan');

const router = express.Router();

function send(res, e) {
  const st = e && Number.isInteger(e.status) ? e.status : 500;
  if (st >= 500) { console.error('[liga F7 planos]', e); return res.status(500).json({ error: 'erro interno' }); }
  return res.status(st).json({ error: e.message, ...(e.code ? { code: e.code } : {}) });
}
const wrap = (fn) => async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); const out = await fn(req, res); if (!res.headersSent) res.json(out); } catch (e) { send(res, e); }
};
async function requireAdmin(req) {
  if (!(await roles.can(req.userId, req.userRole, null, 'PLAN_ADMIN'))) throw new plans.PlanError(403, 'só o administrador do sistema vê e troca o plano dos organizadores');
}

router.get('/plans', wrap(async () => ({
  plans: (await plans.catalog()).filter((p) => p.active).map((p) => ({ key: p.key, name: p.name, paid: p.paid, limits: p.limits })),
  contactUrl: plans.contactUrl(),
  note: 'Planos por tamanho, sem preço definido no sistema. Para ampliar, fale com a equipe do Club.',
})));

router.get('/admin/organizer-plan', authMiddleware, wrap(async (req) => {
  await requireAdmin(req);
  const q = req.query || {};
  const u = await roles.resolveUser({ userId: q.userId, username: q.username });
  if (!u) throw new plans.PlanError(404, 'organizador não encontrado');
  const summary = await plans.summary(u.id, null);
  return { user: { id: u.id, name: u.name, username: u.username || null }, plan: summary.plan, limits: summary.limits, usage: summary.usage, catalog: summary.catalog, log: await plans.planLog(u.id) };
}));

router.post('/admin/organizer-plan', authMiddleware, limits.planAdmin, wrap(async (req) => {
  const b = req.body || {};
  return plans.assignPlan({ actorId: req.userId, actorRole: req.userRole, target: { userId: b.userId, username: b.username, phone: b.phone }, planKey: b.planKey, note: b.note });
}));

router.get('/admin/plan-log', authMiddleware, wrap(async (req) => {
  await requireAdmin(req);
  return { log: await plans.planLog(null, { limit: (req.query || {}).limit }) };
}));

module.exports = router;
