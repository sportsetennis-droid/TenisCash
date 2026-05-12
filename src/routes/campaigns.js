// =====================================================================
// Routes: /api/admin/campaigns — CRUD + vincular clientes/produtos
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/', async (req, res) => {
  try {
    const { status, storeId } = req.query;
    const where = {
      ...(status ? { status } : {}),
      ...(storeId ? { storeId } : {}),
    };
    const list = await prisma.campaign.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { customers: true, products: true } } },
    });
    res.json({ campaigns: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar campanhas' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: {
        customers: true,
        products: true,
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Campanha não encontrada' });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar campanha' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.name) return res.status(400).json({ error: 'name é obrigatório' });
    const campaign = await prisma.campaign.create({
      data: {
        name: data.name,
        channel: data.channel || null,
        storeId: data.storeId || null,
        budget: data.budget != null ? parseFloat(data.budget) : null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        status: data.status || 'DRAFT',
        notes: data.notes || null,
      },
    });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar campanha', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.startDate) data.startDate = new Date(data.startDate);
    if (data.endDate) data.endDate = new Date(data.endDate);
    if (data.budget != null) data.budget = parseFloat(data.budget);
    if (data.generatedRevenue != null) data.generatedRevenue = parseFloat(data.generatedRevenue);
    if (data.roi != null) data.roi = parseFloat(data.roi);
    const campaign = await prisma.campaign.update({ where: { id: req.params.id }, data });
    res.json({ campaign });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar campanha', detail: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.campaign.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover campanha' });
  }
});

// Vincular cliente
router.post('/:id/customers', async (req, res) => {
  try {
    const { customerId, status } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'customerId é obrigatório' });
    const link = await prisma.campaignCustomer.upsert({
      where: { campaignId_customerId: { campaignId: req.params.id, customerId } },
      update: { status: status || 'targeted' },
      create: { campaignId: req.params.id, customerId, status: status || 'targeted' },
    });
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao vincular cliente', detail: err.message });
  }
});

router.delete('/:id/customers/:customerId', async (req, res) => {
  try {
    await prisma.campaignCustomer.delete({
      where: { campaignId_customerId: { campaignId: req.params.id, customerId: req.params.customerId } },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desvincular' });
  }
});

// Vincular produto
router.post('/:id/products', async (req, res) => {
  try {
    const { productId, role } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId é obrigatório' });
    const link = await prisma.campaignProduct.upsert({
      where: { campaignId_productId: { campaignId: req.params.id, productId } },
      update: { role: role || null },
      create: { campaignId: req.params.id, productId, role: role || null },
    });
    res.json({ link });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao vincular produto', detail: err.message });
  }
});

router.delete('/:id/products/:productId', async (req, res) => {
  try {
    await prisma.campaignProduct.delete({
      where: { campaignId_productId: { campaignId: req.params.id, productId: req.params.productId } },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao desvincular' });
  }
});

module.exports = router;
