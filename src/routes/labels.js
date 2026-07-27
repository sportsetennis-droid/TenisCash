// =====================================================================
// Routes: /api/admin/labels — gestão de templates, lotes, geração de PDF
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const {
  generateLabelsPDF,
  defaultTemplates,
  isSTHorizontalTemplate,
  isDuplexTemplate,
  isFourSideProductTemplate,
} = require('../services/labelGenerator');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

function labelsPerProduct(template) {
  return isFourSideProductTemplate(template) ? 2 : 1;
}

// Garante que os templates default existem (idempotente)
async function ensureDefaultTemplates() {
  const defaults = defaultTemplates();
  for (const key of Object.keys(defaults)) {
    const def = defaults[key];
    let existing = await prisma.labelTemplate.findFirst({ where: { name: def.name } });
    if (!existing) {
      for (const legacyName of def.legacyNames || []) {
        existing = await prisma.labelTemplate.findFirst({ where: { name: legacyName } });
        if (existing) break;
      }
    }
    // O template S&T horizontal usa QR e não usa código de barras.
    const isST = isSTHorizontalTemplate(def);
    const isDuplex = isDuplexTemplate(def);
    const isFourSide = isFourSideProductTemplate(def);
    const wantedData = {
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
      showPromotionalPrice: isST || def.type === 'PROMOTIONAL' || def.type === 'PRICE',
      showBarcode: isST ? false : def.type !== 'PROMOTIONAL',
      showQRCode: isST || isFourSide,
      showSku: true,
      showProductName: true,
      showBrand: true,
      showSize: def.type === 'PRODUCT',
      showColor: def.type === 'PRODUCT',
      showStore: false,
      layoutConfig: def.layoutConfig || null,
      isDefault: key === 'a4_16_5x7_duplex',
    };
    let templateRecord = existing;
    if (!existing) {
      templateRecord = await prisma.labelTemplate.create({ data: wantedData });
    } else if (isST || isDuplex) {
      const needsSync = Object.entries(wantedData).some(([field, value]) => {
        if (field === 'layoutConfig') {
          return JSON.stringify(existing[field] || null) !== JSON.stringify(value || null);
        }
        return existing[field] !== value;
      });
      if (needsSync) {
        // Migra o modelo S&T legado sem sobrescrever ajustes dos outros templates.
        templateRecord = await prisma.labelTemplate.update({ where: { id: existing.id }, data: wantedData });
      }
    }
    if (key === 'a4_16_5x7_duplex' && templateRecord) {
      await prisma.labelTemplate.updateMany({
        where: { id: { not: templateRecord.id } },
        data: { isDefault: false },
      });
    }
  }
}

router.get('/templates', async (_req, res) => {
  try {
    await ensureDefaultTemplates();
    const deprecatedNames = Object.values(defaultTemplates())
      .flatMap((template) => template.legacyNames || []);
    const templates = await prisma.labelTemplate.findMany({
      where: deprecatedNames.length ? { name: { notIn: deprecatedNames } } : undefined,
      orderBy: { name: 'asc' },
    });
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

    const templateMeta = await prisma.labelTemplate.findUnique({ where: { id: templateId } });
    const physicalPerProduct = labelsPerProduct(templateMeta);
    const batch = await prisma.labelBatch.create({
      data: {
        name: name || 'Lote ' + new Date().toLocaleString('pt-BR'),
        templateId,
        storeId: storeId || null,
        createdById: req.userId,
        status: 'DRAFT',
        totalLabels: items.reduce((s, x) => s + (parseInt(x.quantity, 10) || 1), 0) * physicalPerProduct,
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
      ? await prisma.product.findMany({
        where: { id: { in: productIds } },
        include: { sizes: { select: { size: true, stock: true }, orderBy: { size: 'asc' } } },
      })
      : [];
    const byId = Object.fromEntries(products.map((p) => [p.id, p]));
    const store = batch.storeId
      ? await prisma.store.findUnique({ where: { id: batch.storeId }, select: { name: true } })
      : null;
    const storeName = store?.name || 'Sports & Tennis';
    const brandProfile = await prisma.brandProfile.findUnique({
      where: { slug: 'sportsetennis' },
      select: { logoUrl: true },
    });

    // Base URL pra QRs apontarem pra página pública do produto
    const baseUrl = (req.headers.origin || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const items = batch.items.map((it) => {
      const p = it.productId ? byId[it.productId] : null;
      const ctx = (() => {
        if (!p) return {};
        try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); }
        catch { return {}; }
      })();
      const cls = ctx.classification || {};
      // Mapeia gênero pra label curta de etiqueta
      const genderLabel = { 'Masculino': 'HOMEM', 'Feminino': 'MULHER', 'Inf. M': 'MENINO', 'Inf. F': 'MENINA' }[cls.gender] || cls.gender || '';
      // Tamanho: extrai do customText ("Tam: 38") ou it.size se houver
      let sizeStr = it.size || null;
      if (!sizeStr && it.customText) {
        const m = String(it.customText).match(/Tam[:\s]+([\w\d\/\-]+)/i);
        if (m) sizeStr = m[1];
      }
      // Nome com tamanho embutido (etiqueta mostra "TENIS X - TAM 38")
      const baseName = p ? p.name : (it.customText || '');
      const availableSizes = p?.sizes
        ?.filter((s) => Number(s.stock || 0) > 0)
        .map((s) => s.size)
        .filter(Boolean)
        .join(' | ') || '';
      const finalName = sizeStr ? `${baseName} • TAM ${sizeStr}` : baseName;
      return {
        name: finalName,
        description: p ? (p.longDescription || p.shortDescription || p.name) : baseName,
        availableSizes,
        storeName,
        storeLogoUrl: brandProfile?.logoUrl || null,
        brand: p ? p.brand : '',
        sku: p ? p.sku : '',
        supplierRef: ctx.supplierRef || null,
        gender: genderLabel,
        category: p ? p.category : '',
        modality: cls.modality || '',
        tier: cls.tier || '',
        size: sizeStr,
        price: it.price != null ? it.price : (p ? p.price : null),
        promotionalPrice: it.promotionalPrice != null ? it.promotionalPrice : (p ? p.promoPrice : null),
        barcode: it.barcode || (p ? p.sku : null),
        qrCodeValue: it.qrCodeValue || (p ? `${baseUrl}/p/${p.id}` : null),
        quantity: it.quantity || 1,
      };
    });

    const pdfBuffer = await generateLabelsPDF({
      template: batch.template,
      items,
      storeName,
      storeLogoUrl: brandProfile?.logoUrl || null,
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

// Cria lote rápido a partir de filtros de produto.
// Aceita 2 formatos:
//   1) { productIds: [...], quantityPerProduct: N }  (legado)
//   2) { selections: [{ productId, size?, quantity }] } (novo — por tamanho)
router.post('/batches/quick', async (req, res) => {
  try {
    const { templateId, name, storeId, productIds, quantityPerProduct, usePromo, selections } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId é obrigatório' });

    let items = [];
    if (Array.isArray(selections) && selections.length) {
      // Formato novo: lista de seleções com size opcional + qty
      const uniqueIds = [...new Set(selections.map(s => s.productId).filter(Boolean))];
      const products = await prisma.product.findMany({ where: { id: { in: uniqueIds } } });
      const byId = Object.fromEntries(products.map(p => [p.id, p]));
      items = selections.filter(s => s.productId && byId[s.productId]).map(s => {
        const p = byId[s.productId];
        // OBS: LabelItem (Prisma) não tem campo "size" — guardamos no customText
        return {
          productId: p.id,
          quantity: Math.max(1, parseInt(s.quantity, 10) || 1),
          price: p.price,
          promotionalPrice: usePromo ? p.promoPrice : null,
          barcode: p.sku,
          customText: s.size ? ('Tam: ' + s.size) : null,
        };
      });
    } else if (Array.isArray(productIds) && productIds.length) {
      const products = await prisma.product.findMany({ where: { id: { in: productIds } } });
      items = products.map((p) => ({
        productId: p.id,
        quantity: parseInt(quantityPerProduct, 10) || 1,
        price: p.price,
        promotionalPrice: usePromo ? p.promoPrice : null,
        barcode: p.sku,
      }));
    } else {
      return res.status(400).json({ error: 'Envie productIds ou selections' });
    }
    if (!items.length) return res.status(400).json({ error: 'Nenhum item gerado' });
    const templateMeta = await prisma.labelTemplate.findUnique({ where: { id: templateId } });
    const totalLabels = items.reduce((s, x) => s + (x.quantity || 1), 0) * labelsPerProduct(templateMeta);
    const batch = await prisma.labelBatch.create({
      data: {
        name: name || ('Lote rápido ' + new Date().toLocaleString('pt-BR')),
        templateId,
        storeId: storeId || null,
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
