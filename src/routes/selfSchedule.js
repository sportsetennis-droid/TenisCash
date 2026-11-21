// /api/minha-escala — o vendedor informa os dias, horários e intervalo que vai trabalhar no mês.
// Acesso: link pessoal assinado (?k=..., enviado pelo WhatsApp, sem login) OU login do app (Bearer).
// Só mexe na escala do próprio vendedor.

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const selfSchedule = require('../services/selfSchedule');

const router = express.Router();
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function todayYmd() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

async function identify(req, res, next) {
  const k = req.query.k || req.get('x-escala-key');
  if (k) {
    const sellerId = selfSchedule.sellerFromLink(k);
    if (!sellerId) return res.status(401).json({ error: 'Este link venceu. Peça um novo ou entre pelo app TenisCash.' });
    req.userId = sellerId; req.viaLink = true; return next();
  }
  return authMiddleware(req, res, next);
}
router.use(identify);

async function loadSeller(req, res) {
  const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, name: true, role: true, active: true, storeId: true, store: { select: { id: true, code: true, name: true } } } });
  if (!u || !u.active || u.role !== 'seller') { res.status(403).json({ error: 'Esta escala é só para a equipe de vendas.' }); return null; }
  return u;
}

router.get('/', async (req, res) => {
  try {
    const u = await loadSeller(req, res); if (!u) return;
    const today = todayYmd();
    const month = MONTH_RE.test(String(req.query.month || '')) ? String(req.query.month) : today.slice(0, 7);
    const days = await selfSchedule.listMonth(prisma, u.id, month);
    // Sugestão de horário: o último que ele usou; senão 09:00–18:00 com intervalo 12:00–13:00.
    let last = days[days.length - 1];
    if (!last) { const prev = await selfSchedule.shiftsMap(prisma, '2000-01-01', today, u.id); const all = Object.values(prev[u.id] || {}).sort((a, b) => a.date.localeCompare(b.date)); last = all[all.length - 1]; }
    // Dono 21/11/2026: a sugestão nunca começa antes da loja abrir (só Manaíra e Tambiá abrem 9h).
    const storeHours = require('../services/storeHours');
    const opening = storeHours.openingFor(u.store) || '09:00';
    const defaults = last
      ? { start: storeHours.clampStart(u.store, last.start), end: last.end, breakStart: last.breakStart || '', breakEnd: last.breakEnd || '' }
      : { start: opening, end: '18:00', breakStart: '12:00', breakEnd: '13:00' };
    res.json({ seller: { name: u.name, store: u.store ? u.store.name : null }, month, today, days, defaults });
  } catch (err) { console.error('[minha-escala:get]', err); res.status(500).json({ error: 'Não foi possível carregar sua escala.' }); }
});

router.put('/', async (req, res) => {
  try {
    const u = await loadSeller(req, res); if (!u) return;
    const month = String((req.body || {}).month || '');
    if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'Mês inválido.' });
    const today = todayYmd();
    if (month < today.slice(0, 7)) return res.status(400).json({ error: 'Esse mês já passou.' });
    const r = await selfSchedule.replaceMonth(prisma, u.id, u.storeId, month, (req.body || {}).days, today);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, saved: r.saved });
  } catch (err) { console.error('[minha-escala:put]', err); res.status(500).json({ error: 'Não foi possível salvar. Tente de novo.' }); }
});

module.exports = router;
