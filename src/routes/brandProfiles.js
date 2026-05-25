// =====================================================================
// /api/brand-profiles — CRUD multi-tenant pra IA de marketing
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const bp = require('../services/brandProfiles');

const router = express.Router();
router.use(authMiddleware);

function requireAdmin(req, res, next) {
  prisma.user.findUnique({ where: { id: req.userId }, select: { role: true } })
    .then((u) => {
      if (!u || !['admin', 'superadmin'].includes(u.role)) {
        return res.status(403).json({ error: 'apenas admin' });
      }
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}
router.use(requireAdmin);

// Lista todas (default: só ativas)
router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.all === '1';
    const brands = await bp.listAll(includeInactive);
    res.json({ brands, archetypeDefaults: bp.ARCHETYPE_DEFAULTS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Detalhe por slug ou id
router.get('/:idOrSlug', async (req, res) => {
  try {
    const brand = await bp.getBySlug(req.params.idOrSlug) || await bp.getById(req.params.idOrSlug);
    if (!brand) return res.status(404).json({ error: 'não encontrado' });
    res.json({ brand });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cria ou atualiza (upsert por slug)
router.put('/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!/^[a-z0-9_-]+$/.test(slug)) return res.status(400).json({ error: 'slug inválido (use a-z, 0-9, -, _)' });
    const data = { slug, ...req.body };
    delete data.id; delete data.createdAt; delete data.updatedAt;
    const saved = await bp.upsert(data);
    res.json({ brand: saved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Deleta
router.delete('/:id', async (req, res) => {
  try {
    await bp.deleteBrand(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roda seed (cria as 9 marcas padrão se não existirem)
router.post('/seed', async (_req, res) => {
  try {
    const created = await bp.seedDefaults();
    res.json({ created, message: 'seed completo (preencher DNA pela UI)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
