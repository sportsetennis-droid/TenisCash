// =====================================================================
// Routes: /api/admin/suppliers — CRUD de fornecedores
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);
router.use(adminMiddleware);

router.get('/', async (req, res) => {
  try {
    const { search, active } = req.query;
    const where = {
      ...(active != null ? { active: active === 'true' } : {}),
      ...(search
        ? {
            OR: [
              { companyName: { contains: search, mode: 'insensitive' } },
              { cnpj: { contains: search } },
              { representativeName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const list = await prisma.supplier.findMany({ where, orderBy: { companyName: 'asc' }, take: 200 });
    res.json({ suppliers: list });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar fornecedores' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    // Estatísticas: contas a pagar, XMLs vinculados
    const [accountsCount, documents, openAmount] = await Promise.all([
      prisma.accountPayable.count({ where: { supplierId: supplier.id } }),
      prisma.xmlFiscalDocument.count({ where: { supplierId: supplier.id } }),
      prisma.accountPayable.aggregate({
        where: { supplierId: supplier.id, status: 'PENDING' },
        _sum: { amount: true },
      }),
    ]);
    res.json({
      supplier,
      stats: {
        accountsCount,
        documentsImported: documents,
        openPayableAmount: openAmount._sum.amount || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao carregar fornecedor' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.companyName) return res.status(400).json({ error: 'companyName é obrigatório' });
    const supplier = await prisma.supplier.create({
      data: {
        companyName: data.companyName,
        cnpj: data.cnpj || null,
        representativeName: data.representativeName || null,
        phone: data.phone || null,
        email: data.email || null,
        suppliedBrands: data.suppliedBrands || null,
        commercialTerms: data.commercialTerms || null,
        averageMarkup: data.averageMarkup != null ? parseFloat(data.averageMarkup) : null,
        paymentDeadline: data.paymentDeadline != null ? parseInt(data.paymentDeadline, 10) : null,
        notes: data.notes || null,
        profitabilityRating: data.profitabilityRating != null ? parseInt(data.profitabilityRating, 10) : null,
        active: data.active !== false,
      },
    });
    res.json({ supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao criar fornecedor', detail: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const data = req.body || {};
    if (data.averageMarkup != null) data.averageMarkup = parseFloat(data.averageMarkup);
    if (data.paymentDeadline != null) data.paymentDeadline = parseInt(data.paymentDeadline, 10);
    if (data.profitabilityRating != null) data.profitabilityRating = parseInt(data.profitabilityRating, 10);
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data });
    res.json({ supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar fornecedor', detail: err.message });
  }
});

// Lista PRODUTOS do fornecedor (base real — XmlFiscalDocument está vazio)
router.get('/:id/products', async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    // Match por supplierCnpj OU supplierId em aiContext
    const products = await prisma.$queryRaw`
      SELECT p.id, p.sku, p.name, p.brand, p.active, p.price,
             p."aiContext"->>'supplierRef' AS "supplierRef",
             p."updatedAt"
      FROM "Product" p
      WHERE (
        p."aiContext"->>'supplierCnpj' = ${supplier.cnpj || ''}
        OR p."aiContext"->>'supplierId' = ${supplier.id}
      )
      ORDER BY p.brand NULLS LAST, p.name ASC
      LIMIT 2000`;
    res.json({ products, supplier });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar produtos', detail: err.message });
  }
});

// Atribui marca em lote a vários produtos do fornecedor
router.post('/:id/products/bulk-brand', async (req, res) => {
  try {
    const { productIds, brand } = req.body || {};
    if (!Array.isArray(productIds) || !productIds.length) return res.status(400).json({ error: 'productIds obrigatório' });
    const brandClean = (brand || '').trim();
    if (!brandClean) return res.status(400).json({ error: 'brand obrigatório (não vazio)' });
    // Garante que os produtos pertencem ao fornecedor (por segurança)
    const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } });
    if (!supplier) return res.status(404).json({ error: 'Fornecedor não encontrado' });
    const r = await prisma.$queryRaw`
      UPDATE "Product"
      SET brand = ${brandClean}, "updatedAt" = NOW()
      WHERE id = ANY(${productIds}::text[])
        AND (
          "aiContext"->>'supplierCnpj' = ${supplier.cnpj || ''}
          OR "aiContext"->>'supplierId' = ${supplier.id}
        )
      RETURNING id`;
    res.json({ ok: true, updated: r.length, brand: brandClean });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir marca', detail: err.message });
  }
});

// Lista NFes do fornecedor com a marca atribuída
router.get('/:id/nfes', async (req, res) => {
  try {
    const docs = await prisma.xmlFiscalDocument.findMany({
      where: { supplierId: req.params.id },
      orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
      take: 500,
      select: {
        id: true, number: true, series: true, accessKey: true, issueDate: true,
        totalValue: true, brand: true, brandSetAt: true, status: true,
        _count: { select: { items: true } },
      },
    });
    res.json({ nfes: docs.map(d => ({
      id: d.id, number: d.number, series: d.series, accessKey: d.accessKey,
      issueDate: d.issueDate, totalValue: d.totalValue,
      brand: d.brand, brandSetAt: d.brandSetAt, status: d.status,
      itemsCount: d._count.items,
    })) });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar NFes', detail: err.message });
  }
});

// Atribui marca em lote a várias NFes do fornecedor
router.post('/:id/nfes/bulk-brand', async (req, res) => {
  try {
    const { nfeIds, brand } = req.body || {};
    if (!Array.isArray(nfeIds) || !nfeIds.length) return res.status(400).json({ error: 'nfeIds obrigatório' });
    const brandClean = (brand || '').trim() || null;
    const r = await prisma.xmlFiscalDocument.updateMany({
      where: { id: { in: nfeIds }, supplierId: req.params.id },
      data: { brand: brandClean, brandSetAt: new Date(), brandSetById: req.userId || null },
    });
    res.json({ ok: true, updated: r.count, brand: brandClean });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atribuir marca', detail: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    // Soft delete (desativa)
    const supplier = await prisma.supplier.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    res.json({ supplier, soft: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao remover fornecedor' });
  }
});

module.exports = router;
