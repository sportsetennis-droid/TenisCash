// =====================================================================
// CLUB F3 — Rotas da INSCRIÇÃO PAGA / LISTA DE ESPERA / CHECK-IN
// ---------------------------------------------------------------------
// Montado na raiz (uma linha no index.js) porque serve a API e a página:
//   GET  /t/:slug/inscricao                         → public/inscricao.html
//   /api/tournament-registration/public/*           → inscrição pública (sem login)
//   /api/tournament-registration/r/:token/*         → página da inscrição (token secreto)
//   /api/tournament-registration/pagbank/webhook    → PIX confirmado (re-consulta o PSP)
//   /api/tournament-registration/manage/:tid/*      → painel do organizador (login + papel)
// =====================================================================

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { prisma, authMiddleware, JWT_SECRET } = require('../middleware');
const roles = require('../services/tournamentRoles');
const reg = require('../services/tournamentRegistration');
const { limits } = require('../services/ligaRateLimit');
const access = require('../services/tournamentAccess');

const router = express.Router();
const BASE = '/api/tournament-registration';

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------
function send(res, fn) {
  return Promise.resolve()
    .then(fn)
    .then((out) => res.json(out))
    .catch((e) => {
      if (e instanceof reg.RegError) return res.status(e.status).json({ error: e.message });
      console.error('[treg]', e.message);
      return res.status(500).json({ error: 'erro interno' });
    });
}

// Login opcional (página pública): só lê o Bearer; nunca bloqueia.
async function optionalUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const d = jwt.verify(h.slice(7), JWT_SECRET);
    if (!d || typeof d.userId !== 'string') return null;
    const u = await prisma.user.findUnique({ where: { id: d.userId }, select: { id: true, name: true, phone: true, email: true, username: true, balance: true, active: true } });
    return u && u.active !== false ? u : null;
  } catch (_) {
    return null;
  }
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || (req.socket && req.socket.remoteAddress) || '';
}

// Papel no torneio (Liga F1: roles.can é a porta única): MANAGE_TOURNAMENT | REFEREE | MONEY
function requireCan(action) {
  return async (req, res, next) => {
    try {
      const t = await prisma.tournament.findUnique({ where: { id: req.params.tid }, select: { id: true, ownerId: true, visibility: true, archivedAt: true } });
      if (!t || t.archivedAt) return access.sendNotFound(res);
      if (!(await roles.can(req.userId, req.userRole, t.id, action))) {
        // privado sem acesso = mesmo 404 de "não existe" (M9)
        if (!(await access.canSee({ userId: req.userId, userRole: req.userRole }, t))) return access.sendNotFound(res);
        return res.status(403).json({ error: 'sem permissão neste torneio' });
      }
      next();
    } catch (e) {
      res.status(500).json({ error: 'erro interno' });
    }
  };
}
const manage = [authMiddleware, requireCan('MANAGE_TOURNAMENT')];
const money = [authMiddleware, requireCan('MONEY')]; // dinheiro (baixa manual/estorno): só fundador/admin

// Inscrição pública respeita a visibilidade: privado = só membro; arquivado = 404 igual.
function visibleSlug(req, res, next) {
  access.loadVisibleTournament(req, req.params.slug, { select: { id: true } })
    .then((t) => (t ? next() : access.sendNotFound(res)))
    .catch(() => res.status(500).json({ error: 'erro interno' }));
}
const desk = [authMiddleware, requireCan('REFEREE')]; // mesa/arbitragem também faz check-in

// ---------------------------------------------------------------------
// página pública
// ---------------------------------------------------------------------
router.get('/t/:slug/inscricao', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, '../../public/inscricao.html'), { cacheControl: false });
});

// ---------------------------------------------------------------------
// público (sem login)
// ---------------------------------------------------------------------
router.get(BASE + '/public/:slug', visibleSlug, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  send(res, async () => reg.publicTournament(req.params.slug, await optionalUser(req)));
});

router.post(BASE + '/public/:slug/coupon', visibleSlug, (req, res) =>
  send(res, () => reg.checkCoupon(req.params.slug, (req.body || {}).code, (req.body || {}).categoryId)));

// Liga Aberta F0: limitador próprio (por usuário logado, senão por IP).
async function attachOptionalUser(req, _res, next) {
  try { const u = await optionalUser(req); req.optionalUser = u; if (u) req.userId = u.id; } catch (_) { req.optionalUser = null; }
  next();
}
router.post(BASE + '/public/:slug/register', attachOptionalUser, visibleSlug, limits.publicRegister, async (req, res) => {
  try {
    const user = req.optionalUser || null;
    const r = await reg.register(req.params.slug, req.body || {}, user, { ip: clientIp(req), userAgent: req.headers['user-agent'] });
    res.status(201).json({ token: r.publicToken, status: r.status, statusLabel: reg.STATUS_LABEL[r.status] || r.status, dueCents: reg.dueCents(r) });
  } catch (e) {
    if (e instanceof reg.RegError) return res.status(e.status).json({ error: e.message });
    console.error('[treg register]', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

router.get(BASE + '/r/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  send(res, async () => reg.publicStatus(req.params.token, await optionalUser(req)));
});

// Liga F1: inscrição de torneio ARQUIVADO não gera cobrança nova.
async function tokenOfArchived(token) {
  const r = await prisma.tournamentRegistration.findUnique({ where: { publicToken: String(token || '') }, select: { tournamentId: true } });
  if (!r) return false;
  const t = await prisma.tournament.findUnique({ where: { id: r.tournamentId }, select: { archivedAt: true } });
  return !t || !!t.archivedAt;
}
router.post(BASE + '/r/:token/pay', async (req, res) =>
  send(res, async () => {
    if (await tokenOfArchived(req.params.token)) throw new reg.RegError(404, 'inscrição não encontrada');
    return reg.startPayment(req.params.token, req.body || {}, await optionalUser(req));
  }));

router.post(BASE + '/r/:token/cancel', async (req, res) =>
  send(res, async () => reg.cancelByToken(req.params.token, await optionalUser(req))));

router.post(BASE + '/r/:token/refund-request', async (req, res) =>
  send(res, async () => reg.requestRefund(req.params.token, (req.body || {}).reason, await optionalUser(req))));

// Webhook PagBank: responde 2xx na hora (senão reenvia) e liquida em seguida.
// Não confia no payload: settleCharge re-consulta a API com o token da loja.
router.post(BASE + '/pagbank/webhook', (req, res) => {
  res.json({ received: true });
  reg.handlePagbankWebhook(req.body || {}).catch((e) => console.error('[treg webhook]', e.message));
});

// ---------------------------------------------------------------------
// organizador
// ---------------------------------------------------------------------
router.get(BASE + '/manage/:tid/config', ...manage, (req, res) =>
  send(res, async () => {
    const cfg = await reg.getConfig(req.params.tid);
    const cats = await prisma.tournamentCategory.findMany({ where: { tournamentId: req.params.tid }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { config: cfg, categories: cats, isGlobalAdmin: roles.isGlobalAdmin(req.userRole), shirtSizes: reg.SHIRT_SIZES };
  }));

router.put(BASE + '/manage/:tid/config', ...manage, (req, res) =>
  send(res, async () => {
    const cfg = await reg.saveConfig(req.params.tid, req.body || {}, { isGlobalAdmin: roles.isGlobalAdmin(req.userRole) });
    // vaga pode ter aumentado → promove a fila
    for (const cid of Object.keys(cfg.categories || {})) await reg.promoteWaitlist(req.params.tid, cid).catch(() => {});
    return { config: cfg };
  }));

// Lojas com PIX PagBank (só admin escolhe). Nunca devolve token.
router.get(BASE + '/manage/:tid/stores', ...manage, (req, res) =>
  send(res, async () => {
    if (!roles.isGlobalAdmin(req.userRole)) return { stores: [] };
    const stores = await prisma.store.findMany({ select: { id: true, code: true, name: true, pagbankEnabled: true, pagbankToken: true, pagbankSandbox: true }, orderBy: { code: 'asc' } });
    return { stores: stores.map((s) => ({ id: s.id, code: s.code, name: s.name, pixReady: !!(s.pagbankEnabled && s.pagbankToken), sandbox: !!s.pagbankSandbox })) };
  }));

router.get(BASE + '/manage/:tid/registrations', ...manage, (req, res) =>
  send(res, () => reg.listForOrganizer(req.params.tid, req.query || {})));

router.get(BASE + '/manage/:tid/registrations.csv', ...manage, async (req, res) => {
  try {
    const csv = await reg.exportCsv(req.params.tid);
    const t = await prisma.tournament.findUnique({ where: { id: req.params.tid }, select: { slug: true } });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="inscricoes-${(t && t.slug) || 'torneio'}.csv"`);
    res.set('Cache-Control', 'no-store');
    res.send(csv);
  } catch (e) {
    console.error('[treg csv]', e.message);
    res.status(500).json({ error: 'erro interno' });
  }
});

router.get(BASE + '/manage/:tid/audit', ...manage, (req, res) =>
  send(res, async () => ({ audit: await reg.listAudit(req.params.tid, req.query.registrationId) })));

async function ownReg(req) {
  const r = await prisma.tournamentRegistration.findFirst({ where: { id: req.params.rid, tournamentId: req.params.tid } });
  if (!r) throw new reg.RegError(404, 'inscrição não encontrada');
  return r;
}

router.post(BASE + '/manage/:tid/registrations/:rid/mark-paid', ...money, (req, res) =>
  send(res, async () => { await ownReg(req); return reg.markPaidOnsite(req.params.rid, req.body || {}, req.userId); }));

router.post(BASE + '/manage/:tid/registrations/:rid/refund', ...money, (req, res) =>
  send(res, async () => { await ownReg(req); return reg.registerRefund(req.params.rid, req.body || {}, req.userId); }));

router.post(BASE + '/manage/:tid/registrations/:rid/cancel', ...manage, (req, res) =>
  send(res, async () => reg.cancelUnpaid(await ownReg(req), { actorUserId: req.userId, reason: String((req.body || {}).reason || 'cancelada pelo organizador').slice(0, 200) })));

router.post(BASE + '/manage/:tid/waitlist/promote', ...manage, (req, res) =>
  send(res, async () => ({ promoted: (await reg.promoteWaitlist(req.params.tid, String((req.body || {}).categoryId || ''))).length })));

router.get(BASE + '/manage/:tid/coupons', ...manage, (req, res) =>
  send(res, async () => ({ coupons: await reg.listCoupons(req.params.tid) })));

router.post(BASE + '/manage/:tid/coupons', ...manage, (req, res) =>
  send(res, () => reg.saveCoupon(req.params.tid, req.body || {}, req.userId)));

router.post(BASE + '/manage/:tid/coupons/:cid/active', ...manage, (req, res) =>
  send(res, () => reg.setCouponActive(req.params.tid, req.params.cid, !!(req.body || {}).active, req.userId)));

// ---------------------------------------------------------------------
// check-in (mesa / arbitragem / coordenação)
// ---------------------------------------------------------------------
router.post(BASE + '/manage/:tid/checkin', ...desk, (req, res) =>
  send(res, () => reg.checkin(req.params.tid, req.body || {}, req.userId)));

router.post(BASE + '/manage/:tid/checkin/undo', ...desk, (req, res) =>
  send(res, () => reg.undoCheckin(req.params.tid, req.body || {}, req.userId)));

router.get(BASE + '/manage/:tid/attendance', ...desk, (req, res) =>
  send(res, () => reg.attendance(req.params.tid, req.query || {})));

router.get(BASE + '/manage/:tid/board', ...desk, (req, res) =>
  send(res, () => reg.matchesBoard(req.params.tid, req.query || {})));

// W.O.: o sistema só SUGERE; aplicar exige o coordenador (MANAGE_TOURNAMENT).
router.post(BASE + '/manage/:tid/walkover', ...manage, (req, res) =>
  send(res, () => reg.confirmWalkover(req.params.tid, req.body || {}, req.userId)));

// ---------------------------------------------------------------------
// varredura: expira prazos vencidos, promove a fila e confere PIX sem webhook
// ---------------------------------------------------------------------
let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    await reg.pollPendingCharges();
    await reg.expireStale();
  } catch (e) {
    console.error('[treg sweep]', e.message);
  } finally {
    sweeping = false;
  }
}
if (process.env.TREG_SWEEPER !== 'off') {
  const timer = setInterval(sweep, 60000);
  if (timer.unref) timer.unref();
}

router._sweep = sweep;
module.exports = router;
