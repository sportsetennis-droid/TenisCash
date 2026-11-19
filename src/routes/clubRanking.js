// =====================================================================
// /api/club-ranking — Rating Glicko-2 (nível 0–7 + confiabilidade),
// ranking por temporada/mês e CIRCUITO por pontos (melhores N em 52 sem.).
// GETs públicos (no-store). Recalcular e mexer na tabela de pontos = admin.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware } = require('../middleware');
const rating = require('../services/clubRating');
const rankings = require('../services/clubRankings');
const engine = require('../services/tournamentEngine');

const router = express.Router();
const SPORT_RE = /^[A-Z_]{2,30}$/;

function sportOf(req, res) {
  const sp = String(req.params.sport || '').toUpperCase();
  if (!SPORT_RE.test(sp)) { res.status(400).json({ error: 'esporte inválido' }); return null; }
  return sp;
}
function pub(fn) {
  return async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      const bad = /inválid|deve ser|desconhecida/.test((e && e.message) || '');
      if (!bad) console.error('[club-ranking]', e);
      res.status(bad ? 400 : 500).json({ error: e.message });
    }
  };
}

// Tabela de pontos do circuito
router.get('/circuit/points', pub(() => rankings.getCircuitConfig()));
router.put('/circuit/points', authMiddleware, adminMiddleware, pub((req) => rankings.setCircuitConfig(req.body || {})));

// Recalcula do histórico (idempotente). body.sport opcional (sem = todos).
router.post('/recompute', authMiddleware, adminMiddleware, pub(async (req) => {
  const sp = req.body && req.body.sport ? String(req.body.sport).toUpperCase() : null;
  if (sp && !SPORT_RE.test(sp)) throw new Error('esporte inválido');
  return rating.recomputeSport(sp);
}));

// Níveis de um atleta (id, @username ou handle do perfil) + posição
router.get('/athlete/:handle', pub(async (req, res) => {
  const userId = await engine.resolveUserId(req.params.handle);
  if (!userId) { res.status(404).json({ error: 'atleta não encontrado' }); return undefined; }
  return { userId, levels: await rating.athleteLevels(userId) };
}));

router.get('/:sport/categories', pub(async (req, res) => {
  const sp = sportOf(req, res); if (!sp) return undefined;
  return { sport: sp, categories: await rankings.sportCategories(sp) };
}));
router.get('/:sport/rating', pub(async (req, res) => {
  const sp = sportOf(req, res); if (!sp) return undefined;
  const q = req.query;
  return rankings.ratingRanking({ sport: sp, format: q.format, gender: q.gender, limit: q.limit, provisional: q.provisional !== '0' });
}));
router.get('/:sport/season', pub(async (req, res) => {
  const sp = sportOf(req, res); if (!sp) return undefined;
  const q = req.query;
  return rankings.seasonRanking({ sport: sp, format: q.format, year: q.year, month: q.month, gender: q.gender, category: q.category, limit: q.limit });
}));
router.get('/:sport/circuit', pub(async (req, res) => {
  const sp = sportOf(req, res); if (!sp) return undefined;
  const q = req.query;
  return rankings.circuitRanking({ sport: sp, category: q.category, gender: q.gender, best: q.best, weeks: q.weeks, asOf: q.asOf, limit: q.limit });
}));

module.exports = router;
