// =====================================================================
// /api/brand-profiles — CRUD multi-tenant pra IA de marketing
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, prisma } = require('../middleware');
const bp = require('../services/brandProfiles');

const router = express.Router();
router.use(authMiddleware);

// Multer pra upload de logo — 5MB max, em memória (não escreve em disco)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpeg|jpg|webp|svg\+xml)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas PNG, JPG, WebP ou SVG'));
  },
});

// Upload pra fal.storage (mesma CDN das imagens de marketing)
async function uploadToFalStorage(buffer, filename, mimetype) {
  const mod = await import('@fal-ai/client');
  const fal = mod.fal;
  if (!process.env.FAL_KEY) throw new Error('FAL_KEY não configurada');
  fal.config({ credentials: process.env.FAL_KEY });

  // File construtor (Node 20+ tem global, fallback node:buffer)
  let FileC = (typeof File !== 'undefined') ? File : null;
  if (!FileC) {
    try { FileC = require('node:buffer').File; } catch {}
  }
  const payload = FileC
    ? new FileC([buffer], filename, { type: mimetype })
    : new Blob([buffer], { type: mimetype });
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('fal.storage retornou vazio');
  return url;
}

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

// Upload de logo — multipart com campo "file" OU body.logoUrl pra URL direta
router.post('/:slug/logo', upload.single('file'), async (req, res) => {
  try {
    const { slug } = req.params;
    let logoUrl;

    if (req.file) {
      // Upload do arquivo
      const safe = (slug || 'logo').replace(/[^a-z0-9-]/gi, '');
      const ext = (req.file.originalname?.split('.').pop() || 'png').toLowerCase().slice(0, 5);
      const filename = `logo-${safe}-${Date.now()}.${ext}`;
      logoUrl = await uploadToFalStorage(req.file.buffer, filename, req.file.mimetype);
    } else if (req.body?.logoUrl) {
      // URL direta colada
      logoUrl = String(req.body.logoUrl).trim();
      if (!/^https?:\/\//.test(logoUrl)) return res.status(400).json({ error: 'logoUrl precisa começar com http(s)://' });
    } else {
      return res.status(400).json({ error: 'envie um arquivo no campo "file" OU body.logoUrl com URL' });
    }

    // Update direto (marca já existe via seed). Não usa upsert pra evitar
    // criar brand incompleto sem displayName.
    const brand = await bp.update(slug, { logoUrl });
    res.json({ logoUrl, brand });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove logo
router.delete('/:slug/logo', async (req, res) => {
  try {
    const brand = await bp.update(req.params.slug, { logoUrl: null });
    res.json({ brand });
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
