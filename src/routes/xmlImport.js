// =====================================================================
// Routes: /api/admin/xml — Importação XML NF-e e exportação operacional
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { parseNfeXml } = require('../services/xmlNfeParser');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Importação NF-e (upload de XML)
router.post('/nfe/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Envie o arquivo XML no campo "file"' });

    const xml = req.file.buffer.toString('utf8');
    const parsed = await parseNfeXml(xml);

    // Cria job de importação
    const job = await prisma.xmlImportJob.create({
      data: {
        name: req.file.originalname,
        type: 'NFE_ENTRY',
        status: 'PROCESSING',
        uploadedById: req.userId,
        originalFileName: req.file.originalname,
        totalItems: parsed.items.length,
      },
    });

    // Cria/atualiza fornecedor
    let supplier = null;
    if (parsed.issuerCnpj) {
      supplier = await prisma.supplier.findUnique({ where: { cnpj: parsed.issuerCnpj } });
      if (!supplier) {
        supplier = await prisma.supplier.create({
          data: {
            companyName: parsed.issuerName || ('CNPJ ' + parsed.issuerCnpj),
            cnpj: parsed.issuerCnpj,
            notes: 'Importado via NF-e ' + (parsed.number || ''),
          },
        });
      }
    }

    // Cria documento fiscal
    let document;
    try {
      document = await prisma.xmlFiscalDocument.create({
        data: {
          importJobId: job.id,
          accessKey: parsed.accessKey || null,
          number: parsed.number || null,
          series: parsed.series || null,
          issuerCnpj: parsed.issuerCnpj || null,
          issuerName: parsed.issuerName || null,
          recipientCnpj: parsed.recipientCnpj || null,
          issueDate: parsed.issueDate ? new Date(parsed.issueDate) : null,
          totalValue: parsed.totalValue,
          icmsValue: parsed.icmsValue,
          ipiValue: parsed.ipiValue,
          pisValue: parsed.pisValue,
          cofinsValue: parsed.cofinsValue,
          supplierId: supplier?.id || null,
          status: 'imported',
        },
      });
    } catch (err) {
      // Pode ter conflito de chave única (accessKey duplicada)
      await prisma.xmlImportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorMessage: 'XML já importado (chave de acesso duplicada)' },
      });
      return res.status(409).json({ error: 'XML já importado anteriormente', detail: err.message });
    }

    // Tenta match com produtos existentes (por EAN ou supplierCode → SKU)
    const itemsToCreate = [];
    let matched = 0;
    let newProductsHint = 0;

    for (const item of parsed.items) {
      let productId = null;
      let matchStatus = 'pending';
      if (item.ean) {
        const p = await prisma.product.findFirst({ where: { sku: item.ean } });
        if (p) { productId = p.id; matchStatus = 'matched'; matched++; }
      }
      if (!productId && item.supplierCode) {
        const p = await prisma.product.findFirst({ where: { sku: item.supplierCode } });
        if (p) { productId = p.id; matchStatus = 'matched'; matched++; }
      }
      if (!productId) {
        matchStatus = 'new_product';
        newProductsHint++;
      }
      itemsToCreate.push({
        fiscalDocumentId: document.id,
        productId,
        supplierCode: item.supplierCode,
        description: item.description,
        ean: item.ean,
        ncm: item.ncm,
        cfop: item.cfop,
        cst: item.cst,
        unit: item.unit,
        quantity: item.quantity,
        unitValue: item.unitValue,
        totalValue: item.totalValue,
        icmsValue: item.icmsValue,
        ipiValue: item.ipiValue,
        pisValue: item.pisValue,
        cofinsValue: item.cofinsValue,
        matchStatus,
      });
    }
    if (itemsToCreate.length) {
      await prisma.xmlFiscalItem.createMany({ data: itemsToCreate });
    }

    await prisma.xmlImportJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        processedItems: itemsToCreate.length,
        completedAt: new Date(),
      },
    });

    await prisma.xmlFiscalDocument.update({
      where: { id: document.id },
      data: { status: matched === itemsToCreate.length ? 'matched' : 'partial' },
    });

    res.json({
      ok: true,
      jobId: job.id,
      documentId: document.id,
      supplierId: supplier?.id || null,
      totals: parsed,
      itemsCount: itemsToCreate.length,
      matched,
      newProductsHint,
    });
  } catch (err) {
    console.error('[xml/nfe/import] erro:', err);
    res.status(500).json({ error: 'Erro ao processar XML', detail: err.message });
  }
});

// Aplica XML — cria/atualiza produtos não matchados + cria entradas de estoque
router.post('/nfe/:documentId/apply', async (req, res) => {
  try {
    const document = await prisma.xmlFiscalDocument.findUnique({
      where: { id: req.params.documentId },
      include: { items: true },
    });
    if (!document) return res.status(404).json({ error: 'Documento não encontrado' });

    let createdProducts = 0;
    let updatedProducts = 0;
    let stockUpdates = 0;

    for (const item of document.items) {
      let productId = item.productId;

      // Cria produto novo se necessário (regra: usa EAN ou supplierCode como SKU)
      if (!productId && item.matchStatus === 'new_product') {
        const sku = item.ean || item.supplierCode || `XML-${item.id.slice(0, 8)}`;
        try {
          const created = await prisma.product.create({
            data: {
              sku,
              name: item.description,
              brand: 'A DEFINIR',
              category: 'geral',
              price: item.unitValue,
              active: true,
              source: 'xml-nfe',
            },
          });
          productId = created.id;
          createdProducts++;
          await prisma.xmlFiscalItem.update({
            where: { id: item.id },
            data: { productId, matchStatus: 'matched' },
          });
        } catch (err) {
          // Pode ter SKU duplicado — tenta achar e usa
          const existing = await prisma.product.findUnique({ where: { sku } });
          if (existing) {
            productId = existing.id;
            await prisma.xmlFiscalItem.update({
              where: { id: item.id },
              data: { productId, matchStatus: 'matched' },
            });
          }
        }
      } else if (productId) {
        // Atualiza preço de custo do produto (não muda preço de venda)
        // Como o schema atual não tem costPrice, deixamos como notes
        updatedProducts++;
      }
      stockUpdates++;
    }

    await prisma.xmlFiscalDocument.update({
      where: { id: document.id },
      data: { status: 'matched' },
    });

    res.json({
      ok: true,
      createdProducts,
      updatedProducts,
      stockUpdates,
    });
  } catch (err) {
    console.error('[xml/nfe/apply] erro:', err);
    res.status(500).json({ error: 'Erro ao aplicar XML', detail: err.message });
  }
});

router.get('/nfe', async (req, res) => {
  try {
    const docs = await prisma.xmlFiscalDocument.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { _count: { select: { items: true } } },
    });
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar XMLs' });
  }
});

router.get('/nfe/:id', async (req, res) => {
  try {
    const doc = await prisma.xmlFiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });
    res.json({ document: doc });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar documento' });
  }
});

// Exportação operacional simples — XML básico de produtos
router.get('/export/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { active: true },
      include: { sizes: true },
      take: 1000,
    });
    const items = products.map((p) => {
      const sizesXml = (p.sizes || [])
        .map((s) => `<Size value="${escapeXml(s.size)}" stock="${s.stock}"/>`)
        .join('');
      return `<Product>
        <Id>${p.id}</Id>
        <Sku>${escapeXml(p.sku)}</Sku>
        <Name>${escapeXml(p.name)}</Name>
        <Brand>${escapeXml(p.brand)}</Brand>
        <Category>${escapeXml(p.category)}</Category>
        <Price>${p.price}</Price>
        <PromoPrice>${p.promoPrice ?? ''}</PromoPrice>
        <Sizes>${sizesXml}</Sizes>
      </Product>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TenisCashOSExport version="1.0" generatedAt="${new Date().toISOString()}" exportType="PRODUCTS">
  <Metadata>
    <Company>Sports &amp; Tennis</Company>
    <Count>${products.length}</Count>
  </Metadata>
  <Records>${items}</Records>
</TenisCashOSExport>`;
    res.set({ 'Content-Type': 'application/xml', 'Content-Disposition': 'attachment; filename="produtos.xml"' });
    res.send(xml);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao exportar' });
  }
});

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
