const express = require('express');
const { prisma, authMiddleware } = require('../middleware');
const { formatProductCard } = require('../services/catalogSearch');

const router = express.Router();

function optionalCatalogAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userId = null;
    req.userRole = null;
    return next();
  }
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware');
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
  } catch {
    req.userId = null;
    req.userRole = null;
  }
  next();
}

router.get('/products', optionalCatalogAuth, async (req, res) => {
  try {
    const search = String(req.query.search || req.query.q || '').trim();
    const brand = String(req.query.brand || '').trim();
    const category = String(req.query.category || '').trim();
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(40, Math.max(1, parseInt(req.query.pageSize || req.query.limit || '12', 10) || 12));
    const skip = (page - 1) * pageSize;

    // Filtros estruturados da árvore Sports & Tennis (aiContext.classification)
    const type = String(req.query.type || '').trim();
    const gender = String(req.query.gender || '').trim();
    const modality = String(req.query.modality || '').trim();
    const tier = String(req.query.tier || '').trim();
    const size = String(req.query.size || '').trim();
    // inStore=1 → só produtos que TÊM estoque físico em alguma loja (StoreStock>0).
    // Usado pela Curadoria pra mostrar os bipados (com tamanhos por loja no card).
    const inStore = String(req.query.inStore || req.query.instore || '') === '1';
    const aiFilters = [];
    if (type) aiFilters.push({ aiContext: { path: ['classification', 'type'], equals: type } });
    if (gender) aiFilters.push({ aiContext: { path: ['classification', 'gender'], equals: gender } });
    if (modality) aiFilters.push({ aiContext: { path: ['classification', 'modality'], equals: modality } });
    if (tier) aiFilters.push({ aiContext: { path: ['classification', 'tier'], equals: tier } });

    // Condições sobre ProductSize (tamanho e/ou estoque em loja) — merge num único some
    const sizesSome = {};
    if (size) sizesSome.size = size;
    if (inStore) sizesSome.storeStocks = { some: { stock: { gt: 0 } } };

    const where = {
      active: true,
      ...(brand ? { brand: { equals: brand, mode: 'insensitive' } } : {}),
      ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
      ...(aiFilters.length ? { AND: aiFilters } : {}),
      // Tamanho e/ou estoque em loja
      ...(Object.keys(sizesSome).length ? { sizes: { some: sizesSome } } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
              { brand: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ featured: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          sku: true,
          name: true,
          brand: true,
          category: true,
          subcategory: true,
          shortDescription: true,
          longDescription: true,
          price: true,
          promoPrice: true,
          imageUrl: true,
          imageUrls: true,
          aiContext: true,
          featured: true,
          sizes: {
            orderBy: { size: 'asc' },
            select: {
              size: true,
              stock: true,
              storeStocks: { include: { store: { select: { id: true, code: true, name: true } } } },
            },
          },
        },
      }),
    ]);

    res.json({
      products: rows.map(formatProductCard),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
    });
  } catch (err) {
    console.error('catalog/products', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

router.get('/products/:id', optionalCatalogAuth, async (req, res) => {
  try {
    const p = await prisma.product.findFirst({
      where: { id: req.params.id, active: true },
      select: {
        id: true,
        sku: true,
        name: true,
        brand: true,
        category: true,
        subcategory: true,
        shortDescription: true,
        longDescription: true,
        features: true,
        recommendedFor: true,
        notRecommendedFor: true,
        imageUrl: true,
        imageUrls: true,
        price: true,
        promoPrice: true,
        featured: true,
        source: true,
        sizes: { orderBy: { size: 'asc' }, select: { size: true, stock: true, barcode: true } },
      },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ product: p });
  } catch (err) {
    console.error('catalog/product id', err);
    res.status(500).json({ error: 'Erro ao carregar produto' });
  }
});

// GET /api/catalog/form-options — opções do filtro padrão da loja (público)
router.get('/form-options', optionalCatalogAuth, async (_req, res) => {
  try {
    const [brandRows, catRows] = await Promise.all([
      prisma.$queryRaw`SELECT DISTINCT brand FROM "Product" WHERE active=true AND brand IS NOT NULL AND brand!='' AND brand!='A DEFINIR' ORDER BY brand ASC`,
      prisma.$queryRaw`SELECT DISTINCT category FROM "Product" WHERE active=true AND category IS NOT NULL AND category!='' ORDER BY category ASC`,
    ]);
    res.json({
      brands: brandRows.map(r => r.brand),
      categories: catRows.map(r => r.category),
      genders: ['Homem', 'Mulher', 'Menino', 'Menina'],
      tree: {
        types: ['Tênis', 'Chuteira', 'Outro'],
        modalities: {
          'Tênis': ['Corrida', 'Caminhada / Treino leve', 'LifeStyle', 'Recuperação', 'Musculação / CrossFit / Hyrox', 'Streetwear', 'Sapatilha'],
          'Chuteira': ['Futsal', 'Society', 'Campo'],
        },
        tiers: {
          'Corrida': ['máximo conforto', 'confortável', 'velocidade', 'custo benefício', 'super treino', 'pau pra toda obra', 'maratona'],
          'LifeStyle': ['premium', 'clássico', 'casual'],
          'Musculação / CrossFit / Hyrox': ['pro', 'intermediário', 'custo benefício'],
          'Futsal': ['entrada', 'custo benefício', 'treino', 'pro'],
          'Society': ['entrada', 'custo benefício', 'treino', 'pro'],
          'Campo': ['entrada', 'custo benefício', 'treino', 'pro'],
        },
      },
    });
  } catch (err) {
    console.error('catalog/form-options', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/brands', optionalCatalogAuth, async (req, res) => {
  try {
    const rows = await prisma.product.findMany({
      where: { active: true },
      distinct: ['brand'],
      select: { brand: true },
      orderBy: { brand: 'asc' },
    });
    res.json({ brands: rows.map((r) => r.brand) });
  } catch (err) {
    console.error('catalog/brands', err);
    res.status(500).json({ error: 'Erro ao listar marcas' });
  }
});

router.get('/categories', optionalCatalogAuth, async (req, res) => {
  try {
    const rows = await prisma.product.findMany({
      where: { active: true },
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    res.json({ categories: rows.map((r) => r.category) });
  } catch (err) {
    console.error('catalog/categories', err);
    res.status(500).json({ error: 'Erro ao listar categorias' });
  }
});

/** Cliente: avisa interesse em reservar produto (envia mensagem interna ao admin) */
router.post('/request-reservation', authMiddleware, async (req, res) => {
  try {
    if (req.userRole !== 'user') {
      return res.status(403).json({ error: 'Apenas clientes podem solicitar reserva por aqui' });
    }
    const { productId, size, notes } = req.body || {};
    if (!productId) return res.status(400).json({ error: 'productId é obrigatório' });

    const product = await prisma.product.findFirst({
      where: { id: String(productId), active: true },
      select: { sku: true, name: true, brand: true },
    });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const admin = await prisma.user.findFirst({
      where: { active: true, role: { in: ['superadmin', 'admin', 'manager'] } },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (!admin) return res.status(400).json({ error: 'Nenhum administrador disponível' });

    const sz = size ? String(size).trim() : '—';
    const note = notes ? String(notes).trim().slice(0, 500) : '';
    const content = `Reserva / interesse em produto\nSKU: ${product.sku}\nNome: ${product.name}\nMarca: ${product.brand}\nTamanho desejado: ${sz}${note ? `\nObs.: ${note}` : ''}`;

    await prisma.message.create({
      data: {
        fromId: req.userId,
        toId: admin.id,
        type: 'message',
        title: 'Interesse em produto (catálogo)',
        content,
        status: 'sent',
      },
    });

    res.json({ success: true, message: 'Sua solicitação foi enviada à loja.' });
  } catch (err) {
    console.error('catalog/request-reservation', err);
    res.status(500).json({ error: 'Erro ao enviar solicitação' });
  }
});

module.exports = router;
