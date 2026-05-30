// =====================================================================
// DESAPEGA — marketplace de produtos USADOS (C2C moderado)
// =====================================================================
// Fluxo (FASE 1, sem pagamento):
//   1. Vendedor cadastra item por link público: POST /api/desapega/listings
//      (fotos sobem antes via POST /api/desapega/upload)
//   2. Item entra com status=pending → equipe S&T MODERA
//   3. Admin aprova/reprova: /api/desapega/admin/listings/:id/(approve|reject)
//   4. Aprovados aparecem na vitrine pública: GET /api/desapega/listings
//
// PRIVACIDADE: a vitrine pública NUNCA expõe telefone/email/Pix do vendedor.
// O contato/negociação passa pela S&T (modelo escrow vem na fase 2).
// =====================================================================

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();

// ---------------------------------------------------------------------
// Upload de fotos → fal.storage (com fallback data URL se faltar FAL_KEY)
// ---------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|webp|gif|heic|heif)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não suportado. Use JPG/PNG/WebP.'));
  },
});

let _fal = null;
async function getFal() {
  if (_fal) return _fal;
  const mod = await import('@fal-ai/client');
  _fal = mod.fal;
  _fal.config({ credentials: process.env.FAL_KEY });
  return _fal;
}
function getFileCtor() {
  if (typeof File !== 'undefined') return File;
  try { const { File: NF } = require('node:buffer'); if (NF) return NF; } catch (e) {}
  return false;
}
async function uploadToFal(buffer, filename) {
  const fal = await getFal();
  const FileC = getFileCtor();
  const payload = FileC ? new FileC([buffer], filename, { type: 'image/jpeg' }) : new Blob([buffer], { type: 'image/jpeg' });
  const url = await fal.storage.upload(payload);
  if (!url) throw new Error('fal.storage retornou vazio');
  return url;
}

// Rate limit pros endpoints públicos de escrita (anti-spam)
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente de novo em alguns minutos.' },
});

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const CATEGORIES = ['tenis', 'roupa', 'acessorio', 'outro'];
const CONDITIONS = ['novo_na_caixa', 'seminovo', 'usado', 'bastante_usado'];
const GENDERS = ['masculino', 'feminino', 'unissex', 'infantil'];

function clean(v, max = 500) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}
function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

// Projeção PÚBLICA — sem nenhum PII do vendedor
function publicView(l) {
  return {
    id: l.id,
    category: l.category,
    brand: l.brand,
    model: l.model,
    size: l.size,
    color: l.color,
    gender: l.gender,
    condition: l.condition,
    description: l.description,
    askingPrice: l.askingPrice,
    originalPrice: l.originalPrice,
    photos: Array.isArray(l.photos) ? l.photos : [],
    sellerCity: l.sellerCity,
    sellerState: l.sellerState,
    sellerFirstName: (l.sellerName || '').split(' ')[0] || null,
    status: l.status,
    publishedAt: l.publishedAt,
    createdAt: l.createdAt,
  };
}

// =====================================================================
// PÚBLICO
// =====================================================================

// Upload de 1+ fotos. FormData field "files" (até 8). Retorna URLs.
router.post('/upload', writeLimiter,
  (req, res, next) => upload.array('files', 8)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo maior que 15MB' });
      return res.status(400).json({ error: err.message });
    }
    next();
  }),
  async (req, res) => {
    try {
      if (!req.files || !req.files.length) return res.status(400).json({ error: 'Nenhuma foto enviada (campo "files")' });
      const urls = [];
      for (const f of req.files) {
        // normaliza: rotaciona por EXIF, redimensiona pra caber em 1280, jpeg 85
        const buf = await sharp(f.buffer, { failOn: 'none' })
          .rotate()
          .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        if (process.env.FAL_KEY) {
          urls.push(await uploadToFal(buf, `desapega-${Date.now()}-${urls.length}.jpg`));
        } else {
          // fallback (dev/local sem FAL_KEY): embute como data URL
          urls.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
        }
      }
      res.json({ ok: true, urls });
    } catch (err) {
      console.error('[desapega/upload] erro:', err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Cadastra um anúncio (entra como pending pra moderação)
router.post('/listings', writeLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    const sellerName = clean(b.sellerName, 120);
    const sellerPhone = onlyDigits(b.sellerPhone);
    const model = clean(b.model, 160);
    const description = clean(b.description, 4000);
    const askingPrice = Number(b.askingPrice);
    const photos = Array.isArray(b.photos) ? b.photos.filter((u) => typeof u === 'string' && u).slice(0, 8) : [];

    // Validação
    const missing = [];
    if (!sellerName) missing.push('seu nome');
    if (!sellerPhone || sellerPhone.length < 10) missing.push('um telefone válido (com DDD)');
    if (!model) missing.push('o nome/modelo do produto');
    if (!description) missing.push('uma descrição');
    if (!askingPrice || !(askingPrice > 0)) missing.push('o valor que você quer receber');
    if (!photos.length) missing.push('pelo menos 1 foto');
    if (missing.length) return res.status(400).json({ error: 'Faltou: ' + missing.join(', ') + '.' });

    const category = CATEGORIES.includes(b.category) ? b.category : 'tenis';
    const condition = CONDITIONS.includes(b.condition) ? b.condition : 'seminovo';
    const gender = GENDERS.includes(b.gender) ? b.gender : null;

    const listing = await prisma.desapegaListing.create({
      data: {
        sellerName,
        sellerPhone,
        sellerEmail: clean(b.sellerEmail, 160),
        sellerPixKey: clean(b.sellerPixKey, 160),
        sellerCity: clean(b.sellerCity, 80),
        sellerState: clean(b.sellerState, 40),
        category,
        brand: clean(b.brand, 80),
        model,
        size: clean(b.size, 40),
        color: clean(b.color, 60),
        gender,
        condition,
        description,
        askingPrice,
        originalPrice: b.originalPrice ? Number(b.originalPrice) || null : null,
        photos,
        status: 'pending',
      },
    });

    res.json({
      ok: true,
      id: listing.id,
      trackToken: listing.trackToken,
      status: listing.status,
      message: 'Anúncio recebido! Nossa equipe vai revisar e publicar em breve.',
    });
  } catch (err) {
    console.error('[desapega/listings POST] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Vitrine pública — só aprovados (não vendidos). Filtros opcionais.
router.get('/listings', async (req, res) => {
  try {
    const { category, brand, size, gender, q, limit } = req.query;
    const take = Math.min(parseInt(limit || '60', 10), 120);
    const where = { status: 'approved' };
    if (category && CATEGORIES.includes(category)) where.category = category;
    if (brand) where.brand = { contains: String(brand), mode: 'insensitive' };
    if (size) where.size = String(size);
    if (gender && GENDERS.includes(gender)) where.gender = gender;
    if (q) {
      where.OR = [
        { model: { contains: String(q), mode: 'insensitive' } },
        { brand: { contains: String(q), mode: 'insensitive' } },
        { description: { contains: String(q), mode: 'insensitive' } },
      ];
    }
    const listings = await prisma.desapegaListing.findMany({
      where,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
      take,
    });
    res.json({ ok: true, count: listings.length, listings: listings.map(publicView) });
  } catch (err) {
    console.error('[desapega/listings GET] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Detalhe público de um anúncio. Se ?token=trackToken bater, devolve a
// visão do PRÓPRIO vendedor (inclui status mesmo se não aprovado).
router.get('/listings/:id', async (req, res) => {
  try {
    const l = await prisma.desapegaListing.findUnique({ where: { id: req.params.id } });
    if (!l) return res.status(404).json({ error: 'Anúncio não encontrado' });

    const isOwner = req.query.token && req.query.token === l.trackToken;
    if (l.status !== 'approved' && !isOwner) {
      return res.status(404).json({ error: 'Anúncio não disponível' });
    }
    // conta view só pra visitante público de item aprovado
    if (l.status === 'approved' && !isOwner) {
      prisma.desapegaListing.update({ where: { id: l.id }, data: { views: { increment: 1 } } }).catch(() => {});
    }
    res.json({ ok: true, listing: publicView(l), owner: !!isOwner });
  } catch (err) {
    console.error('[desapega/listings/:id] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Acompanhamento do vendedor pelo trackToken (status do anúncio)
router.get('/track/:token', async (req, res) => {
  try {
    const l = await prisma.desapegaListing.findUnique({ where: { trackToken: req.params.token } });
    if (!l) return res.status(404).json({ error: 'Token inválido' });
    res.json({
      ok: true,
      id: l.id,
      model: l.model,
      status: l.status,
      rejectionReason: l.rejectionReason,
      photos: Array.isArray(l.photos) ? l.photos : [],
      askingPrice: l.askingPrice,
      createdAt: l.createdAt,
      publishedAt: l.publishedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// ADMIN (moderação) — exige login + papel admin
// =====================================================================
router.use('/admin', authMiddleware, adminMiddleware);

// Fila de moderação (todos os status, default pending)
router.get('/admin/listings', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const take = Math.min(parseInt(limit || '100', 10), 300);
    const where = {};
    if (status && status !== 'all') where.status = String(status);
    const listings = await prisma.desapegaListing.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
    });
    // contagem por status pra abas
    const grouped = await prisma.desapegaListing.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = grouped.reduce((acc, g) => { acc[g.status] = g._count._all; return acc; }, {});
    res.json({ ok: true, counts, count: listings.length, listings });
  } catch (err) {
    console.error('[desapega/admin/listings] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Detalhe completo (com PII) pra moderação
router.get('/admin/listings/:id', async (req, res) => {
  try {
    const l = await prisma.desapegaListing.findUnique({ where: { id: req.params.id } });
    if (!l) return res.status(404).json({ error: 'Anúncio não encontrado' });
    res.json({ ok: true, listing: l });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edita campos do anúncio (correção antes de aprovar)
router.patch('/admin/listings/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const data = {};
    for (const f of ['brand', 'model', 'size', 'color', 'description']) {
      if (b[f] !== undefined) data[f] = clean(b[f], f === 'description' ? 4000 : 160);
    }
    if (b.category !== undefined && CATEGORIES.includes(b.category)) data.category = b.category;
    if (b.condition !== undefined && CONDITIONS.includes(b.condition)) data.condition = b.condition;
    if (b.gender !== undefined) data.gender = GENDERS.includes(b.gender) ? b.gender : null;
    if (b.askingPrice !== undefined && Number(b.askingPrice) > 0) data.askingPrice = Number(b.askingPrice);
    if (b.originalPrice !== undefined) data.originalPrice = b.originalPrice ? Number(b.originalPrice) || null : null;
    if (Array.isArray(b.photos)) data.photos = b.photos.filter((u) => typeof u === 'string' && u).slice(0, 8);
    const l = await prisma.desapegaListing.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, listing: l });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Aprova → publica na vitrine
router.post('/admin/listings/:id/approve', async (req, res) => {
  try {
    const l = await prisma.desapegaListing.update({
      where: { id: req.params.id },
      data: {
        status: 'approved',
        publishedAt: new Date(),
        reviewedAt: new Date(),
        reviewedById: req.userId || null,
        rejectionReason: null,
      },
    });
    res.json({ ok: true, listing: l });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reprova (com motivo)
router.post('/admin/listings/:id/reject', async (req, res) => {
  try {
    const reason = clean((req.body || {}).reason, 1000) || 'Não atende aos critérios.';
    const l = await prisma.desapegaListing.update({
      where: { id: req.params.id },
      data: {
        status: 'rejected',
        rejectionReason: reason,
        reviewedAt: new Date(),
        reviewedById: req.userId || null,
        publishedAt: null,
      },
    });
    res.json({ ok: true, listing: l });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Marca como vendido / pausado / volta pra pending (re-fila)
router.post('/admin/listings/:id/status', async (req, res) => {
  try {
    const next = String((req.body || {}).status || '');
    const allowed = ['pending', 'approved', 'rejected', 'sold', 'paused'];
    if (!allowed.includes(next)) return res.status(400).json({ error: 'status inválido' });
    const data = { status: next };
    if (next === 'sold') data.soldAt = new Date();
    if (next === 'approved') { data.publishedAt = new Date(); data.rejectionReason = null; }
    const l = await prisma.desapegaListing.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, listing: l });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
