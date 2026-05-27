// =====================================================================
// Routes: /api/admin/curation — Curadoria Exposta por loja
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../../../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// ZONAS
router.get('/zones', async (req, res) => {
  try {
    const { storeId } = req.query;
    const zones = await prisma.storeCurationZone.findMany({
      where: storeId ? { storeId } : {},
      orderBy: [{ storeId: 'asc' }, { priority: 'asc' }],
    });
    res.json({ zones });
  } catch (err) {
    console.error('[curation/zones] erro:', err);
    res.status(500).json({ error: 'Erro ao listar zonas' });
  }
});

router.post('/zones', async (req, res) => {
  try {
    const { storeId, name, type, description, priority } = req.body || {};
    if (!storeId || !name || !type) return res.status(400).json({ error: 'storeId, name e type são obrigatórios' });
    const zone = await prisma.storeCurationZone.create({
      data: { storeId, name, type, description: description || null, priority: priority || 0 },
    });
    res.json({ zone });
  } catch (err) {
    console.error('[curation/zones POST] erro:', err);
    res.status(500).json({ error: 'Erro ao criar zona', detail: err.message });
  }
});

router.put('/zones/:id', async (req, res) => {
  try {
    const zone = await prisma.storeCurationZone.update({
      where: { id: req.params.id },
      data: req.body || {},
    });
    res.json({ zone });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar zona', detail: err.message });
  }
});

router.delete('/zones/:id', async (req, res) => {
  try {
    await prisma.storeCurationZone.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover zona', detail: err.message });
  }
});

// CURADORIAS
router.get('/', async (req, res) => {
  try {
    const { storeId, status } = req.query;
    const where = {
      ...(storeId ? { storeId } : {}),
      ...(status ? { status } : {}),
    };
    const list = await prisma.storeCuration.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { items: true, checklist: true, photos: true } },
      },
    });
    res.json({ curations: list });
  } catch (err) {
    console.error('[curation list] erro:', err);
    res.status(500).json({ error: 'Erro ao listar curadorias' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const curation = await prisma.storeCuration.findUnique({
      where: { id: req.params.id },
      include: {
        items: { include: { zone: true } },
        checklist: { orderBy: { dueDate: 'asc' } },
        photos: { orderBy: { createdAt: 'desc' } },
        result: true,
      },
    });
    if (!curation) return res.status(404).json({ error: 'Curadoria não encontrada' });
    res.json({ curation });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar curadoria' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.storeId || !data.name) return res.status(400).json({ error: 'storeId e name são obrigatórios' });
    const curation = await prisma.storeCuration.create({
      data: {
        storeId: data.storeId,
        name: data.name,
        storeDNA: data.storeDNA || null,
        theme: data.theme || null,
        commercialObjective: data.commercialObjective || null,
        startDate: data.startDate ? new Date(data.startDate) : null,
        endDate: data.endDate ? new Date(data.endDate) : null,
        status: data.status || 'DRAFT',
        responsibleUserId: data.responsibleUserId || null,
        notes: data.notes || null,
      },
    });
    // Cria checklist padrão
    const defaultChecklist = [
      'Separar produtos',
      'Imprimir etiquetas',
      'Conferir preços',
      'Montar vitrine',
      'Organizar mesa central',
      'Fotografar zonas',
      'Treinar vendedores',
      'Ativar campanha',
      'Publicar story',
      'Verificar QR Codes/Nuvemshop',
    ];
    await prisma.storeCurationChecklist.createMany({
      data: defaultChecklist.map((task) => ({ curationId: curation.id, task })),
    });
    res.json({ curation });
  } catch (err) {
    console.error('[curation POST] erro:', err);
    res.status(500).json({ error: 'Erro ao criar curadoria', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.startDate) data.startDate = new Date(data.startDate);
    if (data.endDate) data.endDate = new Date(data.endDate);
    const curation = await prisma.storeCuration.update({
      where: { id: req.params.id },
      data,
    });
    res.json({ curation });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar curadoria', detail: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.storeCuration.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover curadoria', detail: err.message });
  }
});

// ITEMS
router.post('/:id/items', async (req, res) => {
  try {
    const { productId, inventoryId, zoneId, commercialRole, displayPriority, storytellingText, priceStrategy, expectedGoal, notes } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId é obrigatório' });
    const item = await prisma.storeCurationItem.create({
      data: {
        curationId: req.params.id,
        productId,
        inventoryId: inventoryId || null,
        zoneId: zoneId || null,
        commercialRole: commercialRole || null,
        displayPriority: displayPriority || 0,
        storytellingText: storytellingText || null,
        priceStrategy: priceStrategy || null,
        expectedGoal: expectedGoal || null,
        notes: notes || null,
      },
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar item', detail: err.message });
  }
});

router.put('/:id/items/:itemId', async (req, res) => {
  try {
    const item = await prisma.storeCurationItem.update({
      where: { id: req.params.itemId },
      data: req.body || {},
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar item', detail: err.message });
  }
});

router.delete('/:id/items/:itemId', async (req, res) => {
  try {
    await prisma.storeCurationItem.delete({ where: { id: req.params.itemId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover item', detail: err.message });
  }
});

// CHECKLIST
router.post('/:id/checklist', async (req, res) => {
  try {
    const { task, responsibleUserId, dueDate } = req.body || {};
    const item = await prisma.storeCurationChecklist.create({
      data: {
        curationId: req.params.id,
        task,
        responsibleUserId: responsibleUserId || null,
        dueDate: dueDate ? new Date(dueDate) : null,
      },
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar tarefa', detail: err.message });
  }
});

router.put('/:id/checklist/:taskId', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.status === 'DONE') data.completedAt = new Date();
    const item = await prisma.storeCurationChecklist.update({
      where: { id: req.params.taskId },
      data,
    });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar tarefa', detail: err.message });
  }
});

router.delete('/:id/checklist/:taskId', async (req, res) => {
  try {
    await prisma.storeCurationChecklist.delete({ where: { id: req.params.taskId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover tarefa', detail: err.message });
  }
});

// FOTOS (URL — upload de arquivo virá depois)
router.post('/:id/photos', async (req, res) => {
  try {
    const { zoneId, imageUrl, caption } = req.body || {};
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl é obrigatório' });
    const photo = await prisma.storeCurationPhoto.create({
      data: {
        curationId: req.params.id,
        zoneId: zoneId || null,
        uploadedById: req.userId,
        imageUrl,
        caption: caption || null,
      },
    });
    res.json({ photo });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao adicionar foto', detail: err.message });
  }
});

router.delete('/:id/photos/:photoId', async (req, res) => {
  try {
    await prisma.storeCurationPhoto.delete({ where: { id: req.params.photoId } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover foto', detail: err.message });
  }
});

// RESULTADO
router.put('/:id/result', async (req, res) => {
  try {
    const data = req.body || {};
    const existing = await prisma.storeCurationResult.findUnique({ where: { curationId: req.params.id } });
    let result;
    if (existing) {
      result = await prisma.storeCurationResult.update({ where: { curationId: req.params.id }, data });
    } else {
      result = await prisma.storeCurationResult.create({ data: { curationId: req.params.id, ...data } });
    }
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar resultado', detail: err.message });
  }
});

// Sugestões de IA por regra (sem IA real — usa heurística sobre catálogo)
router.get('/:id/suggestions', async (req, res) => {
  try {
    const curation = await prisma.storeCuration.findUnique({ where: { id: req.params.id } });
    if (!curation) return res.status(404).json({ error: 'Curadoria não encontrada' });

    const suggestions = [];

    // Produtos parados (sem promoPrice e ativos, com maior preço — heurística simplificada)
    const oldProducts = await prisma.product.findMany({
      where: { active: true, promoPrice: null },
      orderBy: { createdAt: 'asc' },
      take: 10,
      select: { id: true, sku: true, name: true, brand: true, price: true },
    });
    if (oldProducts.length) {
      suggestions.push({
        type: 'OLD_PRODUCTS_EXPOSE',
        title: 'Expor produtos antigos sem promoção',
        description: 'Considere colocar estes em mesa central ou área promocional.',
        products: oldProducts,
      });
    }

    // Produtos em promoção — pra vitrine
    const promoProducts = await prisma.product.findMany({
      where: { active: true, promoPrice: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, sku: true, name: true, brand: true, price: true, promoPrice: true },
    });
    if (promoProducts.length) {
      suggestions.push({
        type: 'PROMO_FOR_WINDOW',
        title: 'Produtos em promoção para vitrine',
        description: 'Heróis de campanha — destacar.',
        products: promoProducts,
      });
    }

    // Featured — para áreas de destaque
    const featured = await prisma.product.findMany({
      where: { active: true, featured: true },
      take: 10,
      select: { id: true, sku: true, name: true, brand: true, price: true },
    });
    if (featured.length) {
      suggestions.push({
        type: 'FEATURED_HERO',
        title: 'Featured como produto herói',
        description: 'Use em mesa central ou parede de destaque.',
        products: featured,
      });
    }

    res.json({ suggestions });
  } catch (err) {
    console.error('[curation suggestions] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar sugestões' });
  }
});

module.exports = router;
