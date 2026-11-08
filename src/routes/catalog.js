const {loadVerification,attachVerification,matchesVerification}=require('../services/stockVerification');
const express = require('express');
const { prisma, authMiddleware, JWT_SECRET } = require('../middleware');
const jwt = require('jsonwebtoken');
const { formatProductCard, searchProductsForAI } = require('../services/catalogSearch');

const router = express.Router();

// Cache de handle da Nuvemshop (nuvemshopProductId -> handle) pra montar link direto ao produto.
// Atualiza no máximo 1x/hora; se falhar, cai no fallback de busca por nome.
let _nsHandleCache = { at: 0, map: new Map() };
async function nsHandleMap() {
  if (Date.now() - _nsHandleCache.at < 3600 * 1000 && _nsHandleCache.map.size) return _nsHandleCache.map;
  try {
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return _nsHandleCache.map;
    const store = conn.storeId || conn.nuvemshopUserId;
    const HDR = { Authentication: 'bearer ' + conn.accessToken, 'User-Agent': 'Sports&Tennis (bernardo_douglas@icloud.com)' };
    const map = new Map();
    for (let page = 1; page <= 12; page++) {
      const r = await fetch(`https://api.tiendanube.com/v1/${store}/products?per_page=200&page=${page}&fields=id,handle`, { headers: HDR });
      if (!r.ok) break;
      const lote = await r.json();
      if (!Array.isArray(lote) || !lote.length) break;
      for (const p of lote) { const h = typeof p.handle === 'object' ? (p.handle.pt || Object.values(p.handle)[0]) : p.handle; if (h) map.set(String(p.id), h); }
      if (lote.length < 200) break;
    }
    if (map.size) _nsHandleCache = { at: Date.now(), map };
  } catch (e) { console.warn('nsHandleMap', e.message); }
  return _nsHandleCache.map;
}

// Mapeia a intenção da busca -> categoria da vitrine (pra botão "ver tudo" e fallback).
function categoriaDaBusca(q) {
  const s = (q || '').toLowerCase();
  if (/chuteir|society|futsal|campo/.test(s)) return '/chuteiras/';
  if (/tenis|tênis|corr|caminhad|running|academia|treino/.test(s)) return '/tenis/';
  if (/legging|top|short|calc|camis|regata|bermuda|roupa|vestu|moda|blusa|conjunto/.test(s)) return '/roupas/';
  if (/mochil|meia|bolsa|bone|boné|garrafa|acess|joelheir|munhequeir/.test(s)) return '/acessorios/';
  return null;
}

function optionalCatalogAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.userId = null;
    req.userRole = null;
    return next();
  }
  // Expired visitor sessions still see the public catalog, as before.
  // Only a valid app identity proceeds to the current database-role check.
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    if (typeof decoded?.userId !== 'string' || !decoded.userId.trim()) throw new Error('identity');
  } catch (_) {
    req.userId = null;
    req.userRole = null;
    return next();
  }
  // A valid token must use the current database role, including after an
  // administrator is reassigned to the product-only Design role.
  return authMiddleware(req, res, next);
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
    // preço/estoque mudam o tempo todo — nunca deixar o navegador servir do cache
    res.set('Cache-Control', 'no-store');
    const myStore = await resolveMyStoreScope(req);
    const search = String(req.query.search || req.query.q || '').trim();
    const salesSearch = String(req.query.salesSearch || '') === '1';
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
    // Valores do seletor vêm diretamente de ProductSize.size, inclusive espaços.
    const size = String(req.query.exactSize || '') === '1'
      ? String(req.query.size || '') : String(req.query.size || '').trim();
    const includeSizeOptions = String(req.query.includeSizeOptions || '') === '1';
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
    const verification = ['seller','store','manager','admin','superadmin'].includes(req.userRole) ? await loadVerification(prisma,storeId) : {rows:[],rounds:[]};
    const verificationFilter = ['seller','store','manager','admin','superadmin'].includes(req.userRole) ? String(req.query.verification||'') : '';
    const verificationSizeIds = verification.rows.filter(r=> !verificationFilter || verificationFilter==='all' || r.status===verificationFilter).map(r=>r.productSizeId);
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
    if (storeId) sizesSome.OR = [{storeStocks:{some:{stock:{gt:0},storeId}}},{id:{in:verification.rows.map(r=>r.productSizeId)}}];
    else if (inStore) sizesSome.OR = [{storeStocks:{some:{stock:{gt:0}}}},{id:{in:verification.rows.map(r=>r.productSizeId)}}];
    if(verificationFilter && verificationFilter!=='all') sizesSome.id = verificationFilter==='unverified'?{notIn:verification.rows.map(r=>r.productSizeId)}:{in:verificationSizeIds};

    // GARANTIA (só staff logado: vendedor/admin) — mostra produto ATIVO **ou** inativo-mas-REAL
    // (tem PREÇO>0 e estoque), pra dar pra VENDER qualquer produto comprado. Cliente anônimo: só ativo.
    // ⛔ Cópia-lixo do scanner (inativa + R$0, SEM nota) NUNCA aparece — era ela que poluía a busca
    // com dezenas de "Nike Revolution zerado" acima dos 2 cards reais. (dono 2026-06-13)
    const isStaff = ['seller', 'admin', 'superadmin', 'manager'].includes(req.userRole);
    const staffVisibleProduct = {
      OR: [
        { active: true },
        { AND: [{ price: { gt: 0 } }, { OR: [
          { sizes: { some: { stock: { gt: 0 } } } },
          { sizes: { some: { storeStocks: { some: { stock: { gt: 0 } } } } } },
        ] }] },
      ],
    };
    const andConds = [
      isStaff ? staffVisibleProduct : { active: true },
    ];
    if (brand) andConds.push({ brand: { equals: brand, mode: 'insensitive' } });
    if (category) andConds.push({ category: { equals: category, mode: 'insensitive' } });
    if (aiFilters.length) andConds.push(...aiFilters);
    const sizeCondition = Object.keys(sizesSome).length ? { sizes: { some: sizesSome } } : null;
    if (sizeCondition) andConds.push(sizeCondition);
    const baseAndConds = andConds.slice();
    const stopWords = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas', 'com', 'sem', 'para', 'pra', 'por', 'um', 'uma', 'uns', 'umas']);
    const salesTerms = (search.match(/[\p{L}\p{N}]+/gu) || [])
      .filter(s => s.length >= 2 && !stopWords.has(s.toLocaleLowerCase('pt-BR')));
    // BUSCA INTELIGENTE multi-palavra: "bola reebok" acha quem tem bola E reebok (qualquer ordem/campo).
    if (search) {
      // Busca ABRANGENTE: nome, REF (sku), marca, categoria/sub, FORN (supplierRef),
      // modalidade/especialidade, cor E código de barras (EAN) de qualquer tamanho.
      const fields = t => ([
        { name: { contains: t, mode: 'insensitive' } },
        { sku: { contains: t, mode: 'insensitive' } },
        { internalBarcode: { contains: t, mode: 'insensitive' } },
        { brand: { contains: t, mode: 'insensitive' } },
        { category: { contains: t, mode: 'insensitive' } },
        { subcategory: { contains: t, mode: 'insensitive' } },
        { aiContext: { path: ['supplierRef'], string_contains: t } },
        { aiContext: { path: ['classification', 'modality'], string_contains: t } },
        { aiContext: { path: ['classification', 'tier'], string_contains: t } },
        { aiContext: { path: ['color'], string_contains: t } },
        { sizes: { some: { barcode: { contains: t, mode: 'insensitive' } } } },
      ]);
      const termos = salesSearch
        ? salesTerms
        : search.split(/\s+/).map(s => s.trim()).filter(s => s.length >= 2);
      for (const t of (termos.length ? termos : [search])) andConds.push({ OR: fields(t) });
    }
    const where = { AND: andConds };

    const [total, rows, sizeOptionRows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: [{ featured: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          sku: true,
          internalBarcode: true,
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
              id: true,
              size: true,
              stock: true,
              barcode: true,
              sizeConfirmedAt: true,
              storeStocks: {
                ...(storeId ? { where: { storeId } } : {}),
                include: { store: { select: { id: true, code: true, name: true } } },
              },
            },
          },
        },
      }),
      // Faceta de tamanhos: mesmo universo de produtos, sem a numeração atual
      // e sem paginação. Disponibilidade pertence à própria variante e loja.
      includeSizeOptions ? prisma.productSize.findMany({
        where: {
          product: { AND: andConds.filter(condition => condition !== sizeCondition) },
          OR:[{storeStocks:{some:{stock:{gt:0},...(storeId?{storeId}:{})}}},{id:{in:verification.rows.map(r=>r.productSizeId)}}],
          ...(verificationFilter && verificationFilter!=='all'?{id:verificationFilter==='unverified'?{notIn:verification.rows.map(r=>r.productSizeId)}:{in:verificationSizeIds}}:{}),
        },
        distinct: ['size'],
        select: { size: true },
      }) : Promise.resolve(null),
    ]);

    // Só a busca da tela Vender tem fallback aproximado. Mantém exatos primeiro;
    // sem resultado, tolera acentos e erros pequenos e ordena os candidatos por proximidade.
    if (salesSearch && search && total === 0) {
      const normalize = value => String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const candidateTerms = new Set();
      for (const rawTerm of salesTerms) {
        const term = normalize(rawTerm).replace(/[^a-z0-9]/g, '');
        if (term.length <= 3) candidateTerms.add(term);
        else {
          candidateTerms.add(term.slice(0, 3));
          candidateTerms.add(term.slice(-3));
        }
      }
      const fragments = [...candidateTerms].slice(0, 24);
      if (fragments.length) {
        const candidates = await prisma.product.findMany({
          where: {
            AND: [
              ...baseAndConds,
              { OR: fragments.flatMap(t => [
                { name: { contains: t, mode: 'insensitive' } },
                { sku: { contains: t, mode: 'insensitive' } },
                { brand: { contains: t, mode: 'insensitive' } },
                { category: { contains: t, mode: 'insensitive' } },
                { subcategory: { contains: t, mode: 'insensitive' } },
              ]) },
            ],
          },
          take: 300,
          orderBy: [{ featured: 'desc' }, { name: 'asc' }],
          select: { id: true, name: true, sku: true, internalBarcode: true, brand: true, category: true, subcategory: true, aiContext: true },
        });
        const bigrams = value => {
          const word = normalize(value).replace(/[^a-z0-9]/g, '');
          const result = new Set();
          if (word.length <= 2) result.add(word);
          else for (let i = 0; i < word.length - 1; i++) result.add(word.slice(i, i + 2));
          return result;
        };
        const similarity = (term, value) => {
          const normalizedValue = normalize(value);
          if (!normalizedValue) return 0;
          if (normalizedValue.includes(term)) return 1;
          let best = 0;
          const targetTerms = normalizedValue.split(/[^a-z0-9]+/).filter(Boolean);
          const queryBigrams = bigrams(term);
          for (const targetTerm of targetTerms) {
            if (targetTerm.includes(term) || term.includes(targetTerm)) {
              best = Math.max(best, Math.min(targetTerm.length, term.length) / Math.max(targetTerm.length, term.length));
            }
            const targetBigrams = bigrams(targetTerm);
            let shared = 0;
            for (const bigram of queryBigrams) if (targetBigrams.has(bigram)) shared++;
            best = Math.max(best, (2 * shared) / Math.max(1, queryBigrams.size + targetBigrams.size));
          }
          return best;
        };
        const ranked = candidates.map(product => {
          const context = product.aiContext && typeof product.aiContext === 'object' ? product.aiContext : {};
          const contextText = [context.supplierRef, context.color, context.classification?.modality, context.classification?.tier].filter(Boolean).join(' ');
          const searchable = [
            [product.name, 1.2], [product.brand, 1.05], [product.sku, 1], [product.internalBarcode, 1],
            [product.category, 0.85], [product.subcategory, 0.8], [contextText, 0.65],
          ];
          const scores = salesTerms.map(term =>
            Math.max(...searchable.map(([value, weight]) => similarity(normalize(term), value) * weight))
          );
          const average = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
          const matched = scores.filter(score => score >= 0.45).length;
          return { product, score: average + (matched / Math.max(1, scores.length)) * 0.15, matched };
        }).filter(result => result.matched > 0 && result.score >= 0.28)
          .sort((a, b) => b.score - a.score || String(a.product.name).localeCompare(String(b.product.name), 'pt-BR'));

        const pageIds = ranked.slice(skip, skip + pageSize).map(result => result.product.id);
        const fullRows = pageIds.length ? await prisma.product.findMany({
          where: { AND: [...baseAndConds, { id: { in: pageIds } }] },
          select: {
            id: true, sku: true, internalBarcode: true, name: true, brand: true, category: true, subcategory: true,
            shortDescription: true, longDescription: true, price: true, promoPrice: true, imageUrl: true, imageUrls: true,
            aiContext: true, featured: true,
            sizes: {
              orderBy: { size: 'asc' },
              select: {
                id: true, size: true, stock: true, barcode: true, sizeConfirmedAt: true,
                storeStocks: {
                  ...(storeId ? { where: { storeId } } : {}),
                  include: { store: { select: { id: true, code: true, name: true } } },
                },
              },
            },
          },
        }) : [];
        const fullRowsById = new Map(fullRows.map(product => [product.id, product]));
        rows = pageIds.map(id => fullRowsById.get(id)).filter(Boolean);
        total = ranked.length;
      }
    }

    const products = rows.map((p) => {
      const card = formatProductCard(p);
      return myStore.wantsMyStore ? addStoreStockSummary(card, storeId, myStore.store, myStore.stockScope) : card;
    });

    attachVerification(products,verification);
    let sizeOptions;
    if (includeSizeOptions) {
      const apparelOrder = ['PP', 'P', 'M', 'G', 'GG', 'XG', 'XXG', 'XXXG', 'G1', 'G2', 'G3', 'G4', 'G5'];
      sizeOptions = (sizeOptionRows || []).map(row => row.size).filter(value => {
        const label = String(value || '').trim();
        const pending = label.toUpperCase().replace(/\s+/g, '');
        return label && !/^T-/i.test(label) && !['?', 'ADEFINIR', 'SEMTAMANHO', '—', '-'].includes(pending);
      }).sort((a, b) => {
        const aRank = apparelOrder.indexOf(String(a).trim().toUpperCase());
        const bRank = apparelOrder.indexOf(String(b).trim().toUpperCase());
        if (aRank >= 0 || bRank >= 0) return aRank < 0 ? 1 : bRank < 0 ? -1 : aRank - bRank;
        return String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
      });
    }

    res.json({
      products,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
      ...(includeSizeOptions ? { sizeOptions } : {}),
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
        internalBarcode: true,
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
            id: true,
            size: true,
            stock: true,
            barcode: true,
            sizeConfirmedAt: true,
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
    if(['seller','store','manager','admin','superadmin'].includes(req.userRole)) attachVerification([product],await loadVerification(prisma,myStore.storeId));
    res.set('Cache-Control','no-store');
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

/**
 * BUSCA IA PÚBLICA — a barra de busca da loja (sportsetennis.com.br) chama isto.
 * Entende linguagem natural ("quero um tênis confortável") e devolve produtos +
 * um destino que a loja abre. store_url usa a busca nativa da Nuvemshop pelo NOME
 * exato (sempre acha o produto certo, sem depender de handle).
 * GET /api/catalog/search-ai?q=...&limit=8
 */
router.get('/search-ai', optionalCatalogAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 24);
    if (q.length < 2) return res.json({ query: q, products: [], redirect: null });
    const result = await searchProductsForAI(q);
    const raw = Array.isArray(result) ? result : (result.products || []);
    // resolve handle real da loja; SÓ mostra produto que está PUBLICADO (tem handle = comprável)
    const hmap = await nsHandleMap();
    const ids = raw.map((p) => p.id).filter(Boolean);
    const mappings = ids.length ? await prisma.nuvemshopProductMapping.findMany({ where: { localProductId: { in: ids } }, select: { localProductId: true, nuvemshopProductId: true } }) : [];
    const localToNs = new Map(mappings.map((m) => [m.localProductId, String(m.nuvemshopProductId)]));
    const products = [];
    for (const p of raw) {
      const nsId = localToNs.get(p.id);
      const handle = nsId ? hmap.get(nsId) : null;
      if (!handle) continue; // não está na loja → não mostra (evita produto sem como comprar)
      products.push({
        name: p.name,
        brand: p.brand || null,
        price: p.price != null ? p.price : null,
        promoPrice: p.promoPrice != null ? p.promoPrice : null,
        image: p.image || p.imageUrl || null,
        inStock: p.inStock !== false,
        store_url: '/produtos/' + handle + '/',
      });
      if (products.length >= limit) break;
    }
    const redirect = categoriaDaBusca(q) || (products.length ? null : '/search/?q=' + encodeURIComponent(q));
    res.json({ query: q, count: products.length, products, redirect, message: result.message || null });
  } catch (err) {
    console.error('catalog/search-ai', err);
    res.status(500).json({ error: 'Erro na busca', products: [], redirect: '/search/?q=' + encodeURIComponent(String(req.query.q || '')) });
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
