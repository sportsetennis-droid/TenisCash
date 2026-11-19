// =====================================================================
// Routes: /api/beacon — leitura PÚBLICA (sem conta) da posição ao vivo
// ---------------------------------------------------------------------
// GET /api/beacon/:token → 200 {athlete, last, trail} | 404 | 410 (acabou)
// O token cru só existe no link; no banco fica o hash.
// =====================================================================

const express = require('express');
const rateLimit = require('express-rate-limit');
const beacon = require('../services/apexBeacon');

const router = express.Router();
router.use(rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false }));

// Config pública dos mapas (atividade.html e ao-vivo.html). Tiles configuráveis por env:
// o tile.openstreetmap.org tem política de uso que PROÍBE tráfego pesado de app —
// em produção com volume, setar APEX_TILE_URL para um provedor com plano compatível
// (MapTiler, Stadia, Thunderforest, Carto…) e APEX_TILE_ATTRIBUTION com a atribuição exigida.
router.get('/_config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    tileUrl: process.env.APEX_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: process.env.APEX_TILE_ATTRIBUTION || '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: Number(process.env.APEX_TILE_MAXZOOM) || 19,
  });
});

router.get('/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const r = await beacon.publicView(req.params.token);
    if (r.status === 404) return res.status(404).json({ error: 'link inválido' });
    return res.status(r.status).json(r.body);
  } catch (e) {
    res.status(500).json({ error: 'erro ao ler posição' });
  }
});

module.exports = router;
