// =====================================================================
// /api/marketing — geração e curadoria de criativos IA
// =====================================================================
// Endpoints:
//   POST   /generate/:productId              gera trio (foto editorial + reel + sem fundo) + copies
//   GET    /creatives                        lista criativos (filtro por status, productId)
//   GET    /creatives/:id                    detalhe
//   PATCH  /creatives/:id                    aprovar/rejeitar/editar copy
//   DELETE /creatives/:id                    apaga (só pending)
//   POST   /creatives/:id/publish            publica em IG/TikTok/WA (futuro)
//   GET    /publications                     histórico
//   GET    /stats                            volume gerado, custo do mês, taxa aprovação
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const falAi = require('../services/falAi');
const openaiImage = require('../services/openaiImage');
const copyGen = require('../services/copyGenerator');

const router = express.Router();
router.use(authMiddleware);

// Só admin/superadmin pode mexer em marketing
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

// ====================================================
// POST /generate/:productId — gera trio + copies
// ====================================================
// Body opcional: { skipVideo: bool, skipBgRemove: bool, sceneHint: string }

router.post('/generate/:productId', async (req, res) => {
  try {
    const {
      skipVideo = false,
      skipBgRemove = false,
      sceneHint = '',
      provider = 'fal',         // 'fal' | 'openai' | 'both'
      openaiQuality = 'medium',  // 'low' | 'medium' | 'high'
    } = req.body || {};
    const product = await prisma.product.findUnique({
      where: { id: req.params.productId },
      select: { id: true, name: true, brand: true, category: true, price: true, shortDescription: true, imageUrl: true, sku: true },
    });
    if (!product) return res.status(404).json({ error: 'produto não encontrado' });
    if (!product.imageUrl) return res.status(400).json({ error: 'produto sem imageUrl — não dá pra usar como referência' });

    console.log(`[marketing/generate] iniciando ${product.sku} (${product.name}) · provider=${provider}`);

    // Roda as gerações em paralelo (fal.ai e OpenAI aguentam)
    const tasks = [];

    // Foto editorial — pelo provider escolhido
    if (provider === 'fal' || provider === 'both') {
      tasks.push(
        falAi.generateEditorialPhoto({
          productName: product.name,
          brand: product.brand,
          imageUrl: product.imageUrl,
          aspectRatio: '16:9',
          sceneHint,
        }).then(r => ({ kind: 'editorial_photo', provider: 'fal', ...r }))
      );
    }
    if (provider === 'openai' || provider === 'both') {
      tasks.push(
        openaiImage.generateEditorialPhoto({
          productName: product.name,
          brand: product.brand,
          imageUrl: product.imageUrl,
          aspectRatio: '16:9',
          sceneHint,
          quality: openaiQuality,
        }).then(r => ({ kind: 'editorial_photo', provider: 'openai', ...r }))
      );
    }

    if (!skipVideo) {
      // Pra video, ideal seria usar a foto editorial gerada. Mas pra paralelizar usamos a do catálogo.
      tasks.push(
        falAi.generateReelVideo({
          imageUrl: product.imageUrl,
          productName: product.name,
        }).then(r => ({ kind: 'reel_video', provider: 'fal', ...r }))
      );
    }
    if (!skipBgRemove) {
      tasks.push(
        falAi.removeBackground({ imageUrl: product.imageUrl })
          .then(r => ({ kind: 'transparent_photo', provider: 'fal', ...r }))
      );
    }

    // Espera as 3 (ou 1, dependendo dos skips)
    const settled = await Promise.allSettled(tasks);
    const created = [];
    const errors = [];

    // Em paralelo, gera as copies
    let copies = { captionIg: '', captionTiktok: '', captionWa: '', hashtags: '' };
    try {
      copies = await copyGen.generateCopies({
        productName: product.name,
        brand: product.brand,
        category: product.category,
        price: product.price,
        shortDesc: product.shortDescription,
        sceneHint,
      });
    } catch (e) {
      console.warn('[marketing/generate] copy gen falhou:', e.message);
      errors.push({ step: 'copy_generator', error: e.message });
    }

    // Salva cada criativo no banco
    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        errors.push({ step: 'fal_ai', error: result.reason?.message || String(result.reason) });
        continue;
      }
      const r = result.value;
      const creative = await prisma.productCreative.create({
        data: {
          productId: product.id,
          kind: r.kind,
          outputUrl: r.outputUrl,
          model: r.model,
          prompt: r.prompt,
          costUsd: r.costUsd,
          captionIg: copies.captionIg,
          captionTiktok: copies.captionTiktok,
          captionWa: copies.captionWa,
          hashtags: copies.hashtags,
          status: 'pending_review',
          params: { sceneHint },
        },
      });
      created.push(creative);
    }

    res.json({
      product: { id: product.id, name: product.name, sku: product.sku },
      created,
      copies,
      errors,
      totalCostUsd: created.reduce((s, c) => s + (c.costUsd || 0), 0),
    });
  } catch (err) {
    console.error('[marketing/generate]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /creatives — lista com filtros
// ====================================================
router.get('/creatives', async (req, res) => {
  try {
    const { status, productId, kind, limit = '50' } = req.query;
    const where = {};
    if (status) where.status = String(status);
    if (productId) where.productId = String(productId);
    if (kind) where.kind = String(kind);

    const creatives = await prisma.productCreative.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 50, 200),
      include: {
        product: { select: { id: true, name: true, sku: true, brand: true, category: true, price: true, imageUrl: true } },
        publications: { select: { id: true, platform: true, status: true, externalUrl: true, publishedAt: true } },
      },
    });

    res.json({ creatives });
  } catch (err) {
    console.error('[marketing/creatives GET]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/creatives/:id', async (req, res) => {
  try {
    const c = await prisma.productCreative.findUnique({
      where: { id: req.params.id },
      include: {
        product: true,
        publications: true,
      },
    });
    if (!c) return res.status(404).json({ error: 'criativo não encontrado' });
    res.json({ creative: c });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// PATCH /creatives/:id — aprovar/rejeitar/editar
// ====================================================
// Body: { status?: 'approved'|'rejected', captionIg?, captionTiktok?, captionWa?, hashtags?, rejectionReason? }
router.patch('/creatives/:id', async (req, res) => {
  try {
    const data = {};
    const allowed = ['status', 'captionIg', 'captionTiktok', 'captionWa', 'hashtags', 'rejectionReason'];
    for (const k of allowed) {
      if (req.body[k] !== undefined) data[k] = req.body[k];
    }
    if (data.status && ['approved', 'rejected'].includes(data.status)) {
      data.reviewedById = req.userId;
      data.reviewedAt = new Date();
    }
    const c = await prisma.productCreative.update({ where: { id: req.params.id }, data });
    res.json({ creative: c });
  } catch (err) {
    console.error('[marketing/creatives PATCH]', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/creatives/:id', async (req, res) => {
  try {
    const c = await prisma.productCreative.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'não encontrado' });
    if (c.status === 'published') return res.status(400).json({ error: 'criativo já publicado, não pode apagar' });
    await prisma.productCreative.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// POST /creatives/:id/publish — publica no Instagram (e futuramente outros)
// ====================================================
// Body: { platform: 'instagram', caption?: string (override) }
router.post('/creatives/:id/publish', async (req, res) => {
  try {
    const platform = String(req.body?.platform || 'instagram').toLowerCase();
    const caption = req.body?.caption || null;

    const creative = await prisma.productCreative.findUnique({
      where: { id: req.params.id },
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    if (!creative) return res.status(404).json({ error: 'criativo não existe' });
    if (creative.status !== 'approved') {
      return res.status(400).json({ error: 'criativo precisa estar approved antes de publicar' });
    }

    // Cria registro de publication (status queued) ANTES de chamar API
    const pub = await prisma.marketingPublication.create({
      data: {
        creativeId: creative.id,
        productId: creative.productId,
        platform,
        caption: caption || creative.captionIg || '',
        mediaUrl: creative.outputUrl,
        status: 'publishing',
        publishedById: req.userId,
      },
    });

    try {
      let result;
      if (platform === 'instagram') {
        const ig = require('../services/instagramPublisher');
        const captionFull = (caption || creative.captionIg || '') + (creative.hashtags ? '\n\n' + creative.hashtags.split(/\s+/).filter(Boolean).map(h => '#' + h.replace(/^#/, '')).join(' ') : '');
        if (creative.kind === 'reel_video') {
          result = await ig.publishReel({ videoUrl: creative.outputUrl, caption: captionFull });
        } else {
          result = await ig.publishPhoto({ imageUrl: creative.outputUrl, caption: captionFull });
        }
      } else {
        throw new Error('platform não suportada ainda: ' + platform);
      }

      // Marca como sucesso
      await prisma.marketingPublication.update({
        where: { id: pub.id },
        data: {
          status: 'success',
          externalId: result.mediaId,
          externalUrl: result.permalink,
          publishedAt: new Date(),
        },
      });
      // Marca o criativo como published
      await prisma.productCreative.update({
        where: { id: creative.id },
        data: { status: 'published' },
      });

      res.json({ success: true, publication: { id: pub.id, externalId: result.mediaId, externalUrl: result.permalink } });
    } catch (apiErr) {
      await prisma.marketingPublication.update({
        where: { id: pub.id },
        data: { status: 'failed', errorMessage: apiErr.message },
      });
      throw apiErr;
    }
  } catch (err) {
    console.error('[marketing/publish]', err);
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /publications — histórico
// ====================================================
router.get('/publications', async (req, res) => {
  try {
    const { platform, status, limit = '100' } = req.query;
    const where = {};
    if (platform) where.platform = String(platform);
    if (status) where.status = String(status);
    const pubs = await prisma.marketingPublication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit, 10) || 100, 300),
      include: {
        creative: { include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } } },
      },
    });
    res.json({ publications: pubs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ====================================================
// GET /stats — KPIs do mês
// ====================================================
router.get('/stats', async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

    const [
      totalGeneratedThisMonth,
      totalApprovedThisMonth,
      totalPublishedThisMonth,
      totalCostThisMonth,
      byStatus,
    ] = await Promise.all([
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth } } }),
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth }, status: 'approved' } }),
      prisma.productCreative.count({ where: { createdAt: { gte: startOfMonth }, status: 'published' } }),
      prisma.productCreative.aggregate({
        where: { createdAt: { gte: startOfMonth } },
        _sum: { costUsd: true },
      }),
      prisma.productCreative.groupBy({
        by: ['status'],
        _count: true,
      }),
    ]);

    res.json({
      thisMonth: {
        generated: totalGeneratedThisMonth,
        approved: totalApprovedThisMonth,
        published: totalPublishedThisMonth,
        costUsd: totalCostThisMonth._sum.costUsd || 0,
        approvalRate: totalGeneratedThisMonth ? (totalApprovedThisMonth / totalGeneratedThisMonth) : 0,
      },
      byStatus,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
