// =====================================================================
// Routes: /api/admin/labels — gestão de templates, lotes, geração de PDF
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { generateLabelsPDF, defaultTemplates } = require('../services/labelGenerator');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

// Garante que os templates default existem (idempotente)
async function ensureDefaultTemplates() {
  const defaults = defaultTemplates();
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    const existing = await prisma.labelTemplate.findFirst({ where: { name: def.name } });
    if (!existing) {
      await prisma.labelTemplate.create({
        data: {
          name: def.name,
          type: def.type,
          paperSize: def.paperSize,
          widthMm: def.widthMm,
          heightMm: def.heightMm,
          columns: def.columns || 1,
          rows: def.rows || 1,
          marginTopMm: def.marginTopMm || 0,
          marginLeftMm: def.marginLeftMm || 0,
          gapHorizontalMm: def.gapHorizontalMm || 0,
          gapVerticalMm: def.gapVerticalMm || 0,
          showLogo: true,
          showPrice: true,
          showPromotionalPrice: def.type === 'PROMOTIONAL' || def.type === 'PRICE',
          showBarcode: def.type !== 'PROMOTIONAL',
          showQRCode: false,
          showSku: true,
          showProductName: true,
          showBrand: true,
          showSize: def.type === 'PRODUCT',
          showColor: def.type === 'PRODUCT',
          showStore: false,
          isDefault: true,
        },
      });
    }
  }
}

router.get('/templates', async (_req, res) => {
  try {
    await ensureDefaultTemplates();
    const templates = await prisma.labelTemplate.findMany({ orderBy: { name: 'asc' } });
    res.json({ templates });
  } catch (err) {
    console.error('[labels/templates] erro:', err);
    res.status(500).json({ error: 'Erro ao listar templates' });
  }
});

router.post('/batches', async (req, res) => {
  try {
    const { name, templateId, storeId, items } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId é obrigatório' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items é obrigatório' });

    const batch = await prisma.labelBatch.create({
      data: {
        name: name || 'Lote ' + new Date().toLocaleString('pt-BR'),
        templateId,
        storeId: storeId || null,
        createdById: req.userId,
        status: 'DRAFT',
        totalLabels: items.reduce((s, x) => s + (parseInt(x.quantity, 10) || 1), 0),
        items: {
          create: items.map((it) => ({
            productId: it.productId || null,
            inventoryId: it.inventoryId || null,
            quantity: parseInt(it.quantity, 10) || 1,
            price: it.price != null ? Number(it.price) : null,
            promotionalPrice: it.promotionalPrice != null ? Number(it.promotionalPrice) : null,
            barcode: it.barcode || null,
            qrCodeValue: it.qrCodeValue || null,
            customText: it.customText || null,
          })),
        },
      },
      include: { items: true, template: true },
    });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches POST] erro:', err);
    res.status(500).json({ error: 'Erro ao criar lote', detail: err.message });
  }
});

router.get('/batches', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '30', 10), 100);
    const batches = await prisma.labelBatch.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { template: true },
    });
    res.json({ batches });
  } catch (err) {
    console.error('[labels/batches GET] erro:', err);
    res.status(500).json({ error: 'Erro ao listar lotes' });
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const batch = await prisma.labelBatch.findUnique({
      where: { id: req.params.id },
      include: { items: true, template: true, prints: { orderBy: { printedAt: 'desc' } } },
    });
    if (!batch) return res.status(404).json({ error: 'Lote não encontrado' });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches/:id] erro:', err);
    res.status(500).json({ error: 'Erro ao carregar lote' });
  }
});

// Gera PDF do lote
router.get('/batches/:id/pdf', async (req, res) => {
  try {
    const batch = await prisma.labelBatch.findUnique({
      where: { id: req.params.id },
      include: { items: true, template: true },
    });
    if (!batch) return res.status(404).json({ error: 'Lote não encontrado' });

    // Enriquece com dados de produto
    const productIds = batch.items.map((i) => i.productId).filter(Boolean);
    const products = productIds.length
      ? await prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));

    const items = batch.items.map((it) => {
      const p = it.productId ? byId[it.productId] : null;
      return {
        name: p ? p.name : (it.customText || ''),
        brand: p ? p.brand : '',
        sku: p ? p.sku : '',
        price: it.price != null ? it.price : (p ? p.price : null),
        promotionalPrice: it.promotionalPrice != null ? it.promotionalPrice : (p ? p.promoPrice : null),
        barcode: it.barcode || (p ? p.sku : null),
        qrCodeValue: it.qrCodeValue || null,
        quantity: it.quantity || 1,
      };
    });

    const pdfBuffer = await generateLabelsPDF({
      template: batch.template,
      items,
    });

    await prisma.labelBatch.update({
      where: { id: batch.id },
      data: { status: 'GENERATED' },
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="etiquetas-${batch.id}.pdf"`,
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[labels/batches/:id/pdf] erro:', err);
    res.status(500).json({ error: 'Erro ao gerar PDF', detail: err.message });
  }
});

// Marca lote como impresso
router.post('/batches/:id/print', async (req, res) => {
  try {
    const { copies, printerName, notes } = req.body || {};
    const log = await prisma.labelPrintLog.create({
      data: {
        labelBatchId: req.params.id,
        printedById: req.userId,
        copies: parseInt(copies, 10) || 1,
        printerName: printerName || null,
        notes: notes || null,
      },
    });
    await prisma.labelBatch.update({
      where: { id: req.params.id },
      data: { status: 'PRINTED' },
    });
    res.json({ log });
  } catch (err) {
    console.error('[labels/batches/:id/print] erro:', err);
    res.status(500).json({ error: 'Erro ao registrar impressão' });
  }
});

router.delete('/batches/:id', async (req, res) => {
  try {
    await prisma.labelBatch.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    console.error('[labels/batches/:id DELETE] erro:', err);
    res.status(500).json({ error: 'Erro ao remover lote' });
  }
});

// Cria lote rápido a partir de filtros de produto
router.post('/batches/quick', async (req, res) => {
  try {
    const { templateId, name, productIds, quantityPerProduct, usePromo } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId é obrigatório' });
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds é obrigatório' });

    const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
    const items = products.map((p) => ({
      productId: p.id,
      quantity: parseInt(quantityPerProduct, 10) || 1,
      price: p.price,
      promotionalPrice: usePromo ? p.promoPrice : null,
      barcode: p.sku,
    }));
    const totalLabels = items.reduce((s, x) => s + (x.quantity || 1), 0);
    const batch = await prisma.labelBatch.create({
      data: {
        name: name || ('Lote rápido ' + new Date().toLocaleString('pt-BR')),
        templateId,
        createdById: req.userId,
        status: 'DRAFT',
        totalLabels,
        items: { create: items },
      },
      include: { items: true, template: true },
    });
    res.json({ batch });
  } catch (err) {
    console.error('[labels/batches/quick] erro:', err);
    res.status(500).json({ error: 'Erro ao criar lote rápido', detail: err.message });
  }
});

module.exports = router;
