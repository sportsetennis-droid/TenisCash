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

async function resolveMyStoreScope(req) {
  const requestedScope = String(req.query.stockScope || '').trim().toLowerCase();
  const wantsMyStore = String(req.query.myStoreStock || req.query.myStore || req.query.mine || '') === '1' || !!requestedScope;
  if (!wantsMyStore) return { wantsMyStore: false, stockScope: '', storeId: '', store: null };
  if (!req.userId || !['seller', 'store', 'manager', 'admin', 'superadmin'].includes(req.userRole)) {
    const err = new Error('Login de vendedor obrigatorio para ver estoque da loja');
    err.statusCode = 401;
    throw err;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      role: true,
      storeId: true,
      store: { select: { id: true, code: true, name: true, city: true } },
    },
  });
  const stockScope = ['all', 'mine', 'store'].includes(requestedScope)
    ? requestedScope
    : 'mine';
  if (stockScope === 'all') {
    return { wantsMyStore: true, stockScope, storeId: '', store: null };
  }
  if (!user?.storeId && stockScope !== 'store') {
    const err = new Error('Usuario sem loja vinculada');
    err.statusCode = 400;
    throw err;
  }
  if (stockScope === 'store') {
    const requestedStoreId = String(req.query.storeId || '').trim();
    const requestedStoreCode = String(req.query.storeCode || '').trim();
    if (!requestedStoreId && !requestedStoreCode && !user?.storeId) {
      const err = new Error('Escolha uma loja para consultar o estoque');
      err.statusCode = 400;
      throw err;
    }
    const store = await prisma.store.findFirst({
      where: {
        active: true,
        ...(requestedStoreId
          ? { id: requestedStoreId }
          : requestedStoreCode
            ? { code: requestedStoreCode }
            : { id: user.storeId }),
      },
      select: { id: true, code: true, name: true, city: true },
    });
    if (!store) {
      const err = new Error('Loja nao encontrada');
      err.statusCode = 404;
      throw err;
    }
    return { wantsMyStore: true, stockScope, storeId: store.id, store };
  }
  return { wantsMyStore: true, stockScope, storeId: user.storeId, store: user.store || null };
}

function addStoreStockSummary(card, storeId, store = null, stockScope = 'mine') {
  const bySize = new Map();
  let total = 0;
  for (const size of card.sizes || []) {
    const rows = Array.isArray(size.storeStocks) ? size.storeStocks : [];
    const qty = rows
      .filter((ss) => !storeId || ss.storeId === storeId || ss.store?.id === storeId)
      .reduce((sum, ss) => sum + Math.max(0, ss.stock || 0), 0);
    if (qty > 0) {
      bySize.set(size.size, (bySize.get(size.size) || 0) + qty);
      total += qty;
    }
  }
  const storeStockBySize = Array.from(bySize.entries())
    .map(([size, stock]) => ({ size, stock }))
    .sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }));
  return {
    ...card,
    store,
    storeStockTotal: total,
    storeAvailableSizes: storeStockBySize,
    storeStockBySize,
    storeStockLabel: total > 0
      ? `${total} un. ${stockScope === 'all' ? 'no estoque geral' : 'na loja'}${storeStockBySize.length ? ` (${storeStockBySize.map((s) => `${s.size}: ${s.stock}`).join(', ')})` : ''}`
      : (stockScope === 'all' ? 'Sem estoque geral' : 'Sem estoque nesta loja'),
  };
}

router.get('/products', optionalCatalogAuth, async (req, res) => {
  try {
    const myStore = await resolveMyStoreScope(req);
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
    let inStore = String(req.query.inStore || req.query.instore || '') === '1';
    // storeCode/storeId → vitrine de UMA loja: só produtos com estoque NESSA loja.
    const storeCode = String(req.query.storeCode || '').trim();
    let storeId = myStore.wantsMyStore ? myStore.storeId : String(req.query.storeId || '').trim();
    if (!myStore.wantsMyStore && storeCode && !storeId) {
      const st = await prisma.store.findFirst({ where: { code: storeCode }, select: { id: true } });
      storeId = st ? st.id : '__none__';
    }
    if (myStore.wantsMyStore && !storeId) inStore = true;
    const aiFilters = [];
    // Casa com a 1ª OU a 2ª classificação (classification2)
    if (type) aiFilters.push({ OR: [
      { aiContext: { path: ['classification', 'type'], equals: type } },
      { aiContext: { path: ['classification2', 'type'], equals: type } },
    ] });
    if (gender) aiFilters.push({ OR: [
      { aiContext: { path: ['classification', 'gender'], equals: gender } },
      { aiContext: { path: ['classification2', 'gender'], equals: gender } },
    ] });
    if (modality) aiFilters.push({ OR: [
      { aiContext: { path: ['classification', 'modality'], equals: modality } },
      { aiContext: { path: ['classification2', 'modality'], equals: modality } },
    ] });
    if (tier) aiFilters.push({ OR: [
      { aiContext: { path: ['classification', 'tier'], equals: tier } },
      { aiContext: { path: ['classification2', 'tier'], equals: tier } },
    ] });

    // Condições sobre ProductSize (tamanho e/ou estoque em loja) — merge num único some
    const sizesSome = {};
    if (size) sizesSome.size = size;
    if (storeId) sizesSome.storeStocks = { some: { stock: { gt: 0 }, storeId } };
    else if (inStore) sizesSome.storeStocks = { some: { stock: { gt: 0 } } };

    // GARANTIA (só staff logado: vendedor/admin) — mostra produto ATIVO **ou** com ESTOQUE,
    // pra dar pra VENDER qualquer produto comprado, mesmo sem bipe. Cliente anônimo: só ativo.
    const isStaff = ['seller', 'admin', 'superadmin', 'manager'].includes(req.userRole);
    const staffVisibleProduct = {
      OR: [
        { active: true },
        { sizes: { some: { stock: { gt: 0 } } } },
        { sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } } },
      ],
    };
    const andConds = [
      isStaff ? staffVisibleProduct : { active: true },
    ];
    if (brand) andConds.push({ brand: { equals: brand, mode: 'insensitive' } });
    if (category) andConds.push({ category: { equals: category, mode: 'insensitive' } });
    if (aiFilters.length) andConds.push(...aiFilters);
    if (Object.keys(sizesSome).length) andConds.push({ sizes: { some: sizesSome } });
    // BUSCA INTELIGENTE multi-palavra: "bola reebok" acha quem tem bola E reebok (qualquer ordem/campo).
    if (search) {
      const fields = t => ([
        { name: { contains: t, mode: 'insensitive' } },
        { sku: { contains: t, mode: 'insensitive' } },
        { brand: { contains: t, mode: 'insensitive' } },
        { category: { contains: t, mode: 'insensitive' } },
        { subcategory: { contains: t, mode: 'insensitive' } },
      ]);
      const termos = search.split(/\s+/).map(s => s.trim()).filter(s => s.length >= 2);
      for (const t of (termos.length ? termos : [search])) andConds.push({ OR: fields(t) });
    }
    const where = { AND: andConds };

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
              storeStocks: {
                ...(storeId ? { where: { storeId } } : {}),
                include: { store: { select: { id: true, code: true, name: true } } },
              },
            },
          },
        },
      }),
    ]);

    const products = rows.map((p) => {
      const card = formatProductCard(p);
      return myStore.wantsMyStore ? addStoreStockSummary(card, storeId, myStore.store, myStore.stockScope) : card;
    });

    res.json({
      products,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
      ...(myStore.wantsMyStore ? { store: myStore.store, stockScope: myStore.stockScope } : {}),
    });
  } catch (err) {
    console.error('catalog/products', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Erro ao listar produtos' });
  }
});

router.get('/products/:id', optionalCatalogAuth, async (req, res) => {
  try {
    const myStore = await resolveMyStoreScope(req);
    const isStaff = ['seller', 'admin', 'superadmin', 'manager'].includes(req.userRole);
    const visibleProduct = isStaff
      ? {
          OR: [
            { active: true },
            { sizes: { some: { stock: { gt: 0 } } } },
            { sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } } },
          ],
        }
      : { active: true };
    const p = await prisma.product.findFirst({
      where: { id: req.params.id, ...visibleProduct },
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
        sizes: {
          orderBy: { size: 'asc' },
          select: {
            size: true,
            stock: true,
            barcode: true,
            storeStocks: {
              ...(myStore.storeId ? { where: { storeId: myStore.storeId } } : {}),
              include: { store: { select: { id: true, code: true, name: true } } },
            },
          },
        },
      },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    const product = myStore.wantsMyStore ? addStoreStockSummary(p, myStore.storeId, myStore.store, myStore.stockScope) : p;
    res.json({ product, ...(myStore.wantsMyStore ? { store: myStore.store, stockScope: myStore.stockScope } : {}) });
  } catch (err) {
    console.error('catalog/product id', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Erro ao carregar produto' });
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
