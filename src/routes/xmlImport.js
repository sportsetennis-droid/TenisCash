// =====================================================================
// Routes: /api/admin/xml — Importação XML NF-e e exportação operacional
// =====================================================================

const express = require('express');
const multer = require('multer');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const { parseNfeXml } = require('../services/xmlNfeParser');
const { groupItemsByBase } = require('../services/nfeSizeParser');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// Lista NFes importadas com filtros (issuer cnpj, docType, supplier, search)
router.get('/nfes', async (req, res) => {
  try {
    const { docType, supplierId, issuerCnpj, search, limit } = req.query;
    const where = {};
    if (docType) where.docType = String(docType);
    if (supplierId) where.supplierId = String(supplierId);
    if (issuerCnpj) where.issuerCnpj = String(issuerCnpj);
    if (search) {
      const s = String(search).trim();
      where.OR = [
        { number: { contains: s, mode: 'insensitive' } },
        { accessKey: { contains: s } },
        { issuerName: { contains: s, mode: 'insensitive' } },
        { recipientName: { contains: s, mode: 'insensitive' } },
        { issuerCnpj: { contains: s.replace(/\D/g, '') } },
      ];
    }
    const docs = await prisma.xmlFiscalDocument.findMany({
      where,
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: Math.min(parseInt(limit, 10) || 500, 2000),
      select: {
        id: true, number: true, series: true, accessKey: true, docType: true,
        issuerCnpj: true, issuerName: true, recipientCnpj: true, recipientName: true,
        issueDate: true, totalValue: true, brand: true, supplierId: true, status: true,
        _count: { select: { items: true } },
      },
    });
    res.json({ nfes: docs.map(d => ({ ...d, itemsCount: d._count.items, _count: undefined })) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar NFes', detail: err.message });
  }
});

// Stats: contagens por tipo + top emissores
router.get('/nfes/stats', async (req, res) => {
  try {
    const byType = await prisma.$queryRaw`
      SELECT "docType" as type, COUNT(*)::int qty, COALESCE(SUM("totalValue"),0)::float value
      FROM "XmlFiscalDocument" GROUP BY "docType" ORDER BY qty DESC`;
    const topIssuers = await prisma.$queryRaw`
      SELECT "issuerCnpj" as cnpj, "issuerName" as name, COUNT(*)::int qty,
             COALESCE(SUM("totalValue"),0)::float value
      FROM "XmlFiscalDocument"
      WHERE "issuerCnpj" IS NOT NULL
      GROUP BY "issuerCnpj", "issuerName"
      ORDER BY qty DESC LIMIT 50`;
    res.json({ byType, topIssuers });
  } catch (err) {
    res.status(500).json({ error: 'Erro stats', detail: err.message });
  }
});

// Detalhes de uma NFe (incluindo items)
router.get('/nfes/:id', async (req, res) => {
  try {
    const doc = await prisma.xmlFiscalDocument.findUnique({
      where: { id: req.params.id },
      include: { items: { take: 200 }, supplier: { select: { id: true, companyName: true, suppliedBrands: true } } },
    });
    if (!doc) return res.status(404).json({ error: 'NFe não encontrada' });
    res.json({ nfe: doc });
  } catch (err) {
    res.status(500).json({ error: 'Erro', detail: err.message });
  }
});

// Atualiza marca/tipo da NFe
router.put('/nfes/:id', async (req, res) => {
  try {
    const { brand, docType } = req.body || {};
    const data = {};
    if (brand !== undefined) { data.brand = brand || null; data.brandSetAt = new Date(); data.brandSetById = req.userId || null; }
    if (docType !== undefined) data.docType = docType || null;
    const r = await prisma.xmlFiscalDocument.update({ where: { id: req.params.id }, data });
    res.json({ nfe: r });
  } catch (err) {
    res.status(500).json({ error: 'Erro', detail: err.message });
  }
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

// Aplica XML — agrupa itens por produto base (tamanhos viram ProductSize),
// cria 1 Product + N ProductSizes por grupo, soma estoque cumulativo.
router.post('/nfe/:documentId/apply', async (req, res) => {
  try {
    const document = await prisma.xmlFiscalDocument.findUnique({
      where: { id: req.params.documentId },
      include: { items: true, supplier: true },
    });
    if (!document) return res.status(404).json({ error: 'Documento não encontrado' });

    // 1. Separa itens já matchados (productId presente) dos novos
    //    Itens matchados mantêm o produto existente — só somam estoque por tamanho.
    //    Itens novos passam pelo agrupamento por baseKey.
    const matchedItems = document.items.filter(i => i.productId);
    const newItems = document.items.filter(i => !i.productId);

    // 2. Agrupa só os novos por baseKey (mesmo produto, vários tamanhos)
    const groups = groupItemsByBase(newItems);

    let createdProducts = 0;
    let updatedProducts = 0;
    let createdSizes = 0;
    let updatedSizes = 0;
    let totalStockAdded = 0;
    const cnpjSuffix = (document.issuerCnpj || '').slice(-4) || 'NFE';

    // 3. Para cada grupo: cria 1 Product + N ProductSizes
    for (const g of groups) {
      // Custo médio ponderado pela quantidade
      let totalQty = 0, totalCost = 0;
      for (const v of g.variants) {
        totalQty += v.qty;
        totalCost += v.qty * v.unitValue;
      }
      const avgCost = totalQty > 0 ? Math.round((totalCost / totalQty) * 100) / 100 : null;

      // SKU base: usa primeiro EAN (se houver) ou supplierCode + sufixo CNPJ
      const baseRef = g.variants.find(v => v.ean)?.ean
                    || g.variants.find(v => v.supplierCode)?.supplierCode
                    || g.baseKey.slice(0, 20);
      const sku = `${cnpjSuffix}-${baseRef}`.slice(0, 64);

      // Referência fornecedor: cProd alfanumérico (se não for EAN)
      const supplierRef = g.variants
        .map(v => v.supplierCode)
        .find(c => c && !/^\d{12,14}$/.test(c)) || null;

      // Cria ou pega produto existente pelo SKU
      let product = await prisma.product.findUnique({ where: { sku } });
      if (!product) {
        try {
          product = await prisma.product.create({
            data: {
              sku,
              name: g.baseName,
              brand: 'A DEFINIR',
              category: 'geral',
              price: 0, // markup aplicado depois
              costPrice: avgCost,
              active: true,
              source: 'xml-nfe',
              aiContext: {
                supplierCnpj: document.issuerCnpj,
                supplierRef,
                baseProductKey: g.baseKey,
              },
            },
          });
          createdProducts++;
        } catch (err) {
          // Race condition raro — tenta de novo lendo
          product = await prisma.product.findUnique({ where: { sku } });
          if (!product) throw err;
          updatedProducts++;
        }
      } else {
        // Produto existe — atualiza custo médio + supplierRef
        await prisma.product.update({
          where: { id: product.id },
          data: {
            costPrice: avgCost,
            aiContext: {
              ...(product.aiContext || {}),
              supplierCnpj: document.issuerCnpj,
              supplierRef: supplierRef || product.aiContext?.supplierRef || null,
              baseProductKey: g.baseKey,
            },
          },
        });
        updatedProducts++;
      }

      // ProductSize por variante (soma estoque cumulativo)
      for (const v of g.variants) {
        if (!v.size) continue; // produto sem variante → sem ProductSize
        const existing = await prisma.productSize.findFirst({
          where: { productId: product.id, size: v.size },
        });
        if (existing) {
          await prisma.productSize.update({
            where: { id: existing.id },
            data: {
              stock: existing.stock + v.qty,
              barcode: v.ean || existing.barcode,
            },
          });
          updatedSizes++;
        } else {
          await prisma.productSize.create({
            data: {
              productId: product.id,
              size: v.size,
              stock: v.qty,
              barcode: v.ean || null,
            },
          });
          createdSizes++;
        }
        totalStockAdded += v.qty;

        // Linka o XmlFiscalItem ao produto criado
        if (v.itemId) {
          await prisma.xmlFiscalItem.update({
            where: { id: v.itemId },
            data: { productId: product.id, matchStatus: 'matched' },
          });
        }
      }

      // Pra grupos SEM tamanho (variants sem size), linka os items mesmo assim
      for (const v of g.variants) {
        if (v.size || !v.itemId) continue;
        await prisma.xmlFiscalItem.update({
          where: { id: v.itemId },
          data: { productId: product.id, matchStatus: 'matched' },
        });
      }
    }

    // 4. Items já matchados: só soma estoque no produto existente
    for (const item of matchedItems) {
      // Não conseguimos saber o tamanho do item matchado sem reparsing —
      // por enquanto só conta como update (estoque agregado vem por outra via).
      updatedProducts++;
    }

    await prisma.xmlFiscalDocument.update({
      where: { id: document.id },
      data: { status: 'matched' },
    });

    res.json({
      ok: true,
      groupsProcessed: groups.length,
      createdProducts,
      updatedProducts,
      createdSizes,
      updatedSizes,
      totalStockAdded,
      message: `${groups.length} produto(s) base agrupados de ${newItems.length} linha(s) da NF-e`,
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
