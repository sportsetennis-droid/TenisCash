// =====================================================================
// GET /api/_loopview — leitura da pauta do loop de marketing (/loop.html).
// Liga Aberta F0: antes era público com ?g= fixo (e o segredo estava no
// próprio loop.html, ou seja, aberto pra qualquer um). Agora exige login
// de ADMIN (authMiddleware + adminMiddleware), mesmo token do admin.html.
// =====================================================================

const { authMiddleware, adminMiddleware } = require('../middleware');

async function loopViewHandler(req, res) {
  try {
    res.set('Cache-Control', 'no-store');
    const loop = require('../services/marketingLoop');
    const state = await loop.getLoopState();
    const slate = await loop.getLoopSlate();
    res.json({
      ok: true,
      learnings: state.learnings || '',
      learningsUpdatedAt: state.learningsUpdatedAt || null,
      lastBrainAt: state.lastBrainAt || null,
      brain: loop.BRAIN_MODEL,
      slate,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { loopViewHandler, loopViewChain: [authMiddleware, adminMiddleware, loopViewHandler] };
