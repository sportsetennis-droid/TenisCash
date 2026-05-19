// =====================================================================
// Routes: /api/admin/size-charts — CRUD de tabelas de medidas
// =====================================================================
// Usado pelo admin.html pra criar/aprovar/editar SizeCharts.
// Charts criadas pelo harvester (scraping de fornecedor) chegam aqui com
// status="pending_review" e precisam de aprovação humana.
// =====================================================================

const express = require('express');
const { adminMiddleware } = require('../middleware');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const router = express.Router();

// GET /api/admin/size-charts?status=pending_review&garmentType=camisa
router.get('/', adminMiddleware, async (req, res) => {
  try {
    const { status, garmentType, brand } = req.query;
    const where = {};
    if (status) where.status = status;
    if (garmentType) where.garmentType = garmentType;
    if (brand) where.brand = brand;

    const charts = await prisma.sizeChart.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, companyName: true } },
      },
    });
    res.json({ charts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/size-charts/:id
router.get('/:id', adminMiddleware, async (req, res) => {
  try {
    const chart = await prisma.sizeChart.findUnique({
      where: { id: req.params.id },
      include: {
        product: { select: { id: true, name: true, sku: true } },
        supplier: { select: { id: true, companyName: true } },
      },
    });
    if (!chart) return res.status(404).json({ error: 'não encontrado' });
    res.json(chart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/size-charts — cria manualmente
router.post('/', adminMiddleware, async (req, res) => {
  try {
    const { brand, garmentType, gender, supplierId, productId, sizes, sourceUrl, status } = req.body || {};
    if (!garmentType) return res.status(400).json({ error: 'garmentType obrigatório' });
    if (!Array.isArray(sizes) || sizes.length === 0) {
      return res.status(400).json({ error: 'sizes deve ser array não-vazio' });
    }

    const chart = await prisma.sizeChart.create({
      data: {
        brand: brand || null,
        garmentType,
        gender: gender || null,
        supplierId: supplierId || null,
        productId: productId || null,
        sizes,
        source: 'manual',
        sourceUrl: sourceUrl || null,
        status: status || 'approved',
        reviewedBy: req.user?.id,
        reviewedAt: new Date(),
      },
    });
    res.status(201).json(chart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/admin/size-charts/:id — edita/aprova/rejeita
router.patch('/:id', adminMiddleware, async (req, res) => {
  try {
    const { brand, garmentType, gender, sizes, status, sourceUrl } = req.body || {};
    const data = {};
    if (brand !== undefined) data.brand = brand;
    if (garmentType !== undefined) data.garmentType = garmentType;
    if (gender !== undefined) data.gender = gender;
    if (sizes !== undefined) data.sizes = sizes;
    if (sourceUrl !== undefined) data.sourceUrl = sourceUrl;
    if (status !== undefined) {
      data.status = status;
      if (status === 'approved') {
        data.reviewedBy = req.user?.id;
        data.reviewedAt = new Date();
      }
    }
    const chart = await prisma.sizeChart.update({
      where: { id: req.params.id },
      data,
    });
    res.json(chart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/size-charts/:id
router.delete('/:id', adminMiddleware, async (req, res) => {
  try {
    await prisma.sizeChart.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/size-charts/stats/overview
router.get('/stats/overview', adminMiddleware, async (req, res) => {
  try {
    const [total, pending, approved, rejected] = await Promise.all([
      prisma.sizeChart.count(),
      prisma.sizeChart.count({ where: { status: 'pending_review' } }),
      prisma.sizeChart.count({ where: { status: 'approved' } }),
      prisma.sizeChart.count({ where: { status: 'rejected' } }),
    ]);
    const byGarment = await prisma.sizeChart.groupBy({
      by: ['garmentType'],
      _count: { id: true },
      where: { status: 'approved' },
    });
    res.json({ total, pending, approved, rejected, byGarment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
