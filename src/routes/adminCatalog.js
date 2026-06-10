const express = require('express');
const multer = require('multer');
const Papa = require('papaparse');
const Anthropic = require('@anthropic-ai/sdk');
const { prisma, authMiddleware } = require('../middleware');
const nsHandlers = require('../services/nuvemshopHandlers');

// Sync com Nuvemshop se produto tem mapping. Fire-and-forget para nao
// travar HTTP response em operações de classificação em lote.
async function syncProductToNuvemshop(productId) {
  try {
    const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: productId } });
    if (!mapping) return { synced: false, reason: 'sem mapping' };
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return { synced: false, reason: 'sem conexão' };
    const r = await nsHandlers.pushProductToNuvemshop(productId, conn);
    return { synced: true, action: r.action };
  } catch (err) {
    console.error('[adminCatalog ns sync]', err.message);
    return { synced: false, error: err.message };
  }
}

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function multerErrorHandler(err, _req, res, _next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo muito grande. Limite: 50MB.' });
  }
  return res.status(400).json({ error: err && err.message ? err.message : 'Erro no upload' });
}

function adminOnly(req, res, next) {
  if (req.userRole !== 'admin' && req.userRole !== 'superadmin' && req.userRole !== 'manager') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

function sellerOrAdmin(req, res, next) {
  if (!['seller', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso negado' });
  }
  next();
}

function parseJsonSafe(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

// GET /api/admin/catalog/form-options
// Devolve TUDO que o formulário de produto precisa em 1 só chamada:
// marcas distintas, categorias distintas, fornecedores ativos, lojas, árvore IA.
router.get('/form-options', adminOnly, async (_req, res) => {
  try {
    const [brandRows, catRows, suppliers, stores, categoryNodes] = await Promise.all([
      prisma.$queryRaw`SELECT DISTINCT brand FROM "Product" WHERE active=true AND brand IS NOT NULL AND brand!='' AND brand!='A DEFINIR' ORDER BY brand ASC`,
      prisma.$queryRaw`SELECT DISTINCT category FROM "Product" WHERE active=true AND category IS NOT NULL AND category!='' ORDER BY category ASC`,
      prisma.supplier.findMany({
        where: { active: true },
        select: { id: true, companyName: true, cnpj: true, suppliedBrands: true },
        orderBy: { companyName: 'asc' },
      }),
      prisma.store.findMany({
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      // DINAMICO: arvore real do banco (CategoryNode)
      prisma.categoryNode.findMany({
        where: { active: true },
        select: { id: true, name: true, level: true, parentId: true, position: true },
        orderBy: [{ position: 'asc' }, { name: 'asc' }],
      }),
    ]);

    // Constroi tree { types, modalities, tiers } a partir dos CategoryNode
    // types = nomes de CATEGORY (raiz)
    // modalities[CategoryName] = MODALITY descendentes dessa CATEGORY (atravessa SUBCATEGORY)
    // tiers[ModalityName] = SPECIALTY filhos diretos da MODALITY
    const byId = Object.fromEntries(categoryNodes.map(n => [n.id, n]));
    const childrenOf = (id) => categoryNodes.filter(n => n.parentId === id);
    const categories = categoryNodes.filter(n => n.level === 'CATEGORY');
    const modalities = {};
    const tiers = {};

    for (const cat of categories) {
      const modsForCat = [];
      // Atravessa SUBCATEGORY -> MODALITY
      const subs = childrenOf(cat.id);
      for (const sub of subs) {
        if (sub.level === 'MODALITY') modsForCat.push(sub.name); // alguns Catalogs tem MODALITY direto
        else if (sub.level === 'SUBCATEGORY') {
          const subMods = childrenOf(sub.id).filter(n => n.level === 'MODALITY');
          subMods.forEach(m => modsForCat.push(m.name));
        }
      }
      if (modsForCat.length) modalities[cat.name] = [...new Set(modsForCat)].sort();
    }

    // tiers: pra cada MODALITY, seus SPECIALTY filhos
    const mods = categoryNodes.filter(n => n.level === 'MODALITY');
    for (const mod of mods) {
      const specs = childrenOf(mod.id).filter(n => n.level === 'SPECIALTY');
      if (specs.length) tiers[mod.name] = specs.map(s => s.name).sort();
    }

    res.json({
      brands: brandRows.map(r => r.brand),
      categories: catRows.map(r => r.category),
      suppliers,
      stores,
      genders: ['Homem', 'Mulher', 'Menino', 'Menina'],
      tree: {
        types: categories.map(c => c.name),
        modalities,
        tiers,
      },
    });
  } catch (err) {
    console.error('[form-options]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/catalog/products/:id/color-variants
// Retorna outras Products com mesmo modelGroup (cores diferentes do mesmo modelo)
router.get('/products/:id/color-variants', adminOnly, async (req, res) => {
  try {
    const productId = req.params.id;
    const p = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, brand: true, aiContext: true },
    });
    if (!p) return res.status(404).json({ error: 'produto nao encontrado' });

    const ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {});
    const mg = ctx.modelGroup;
    if (!mg) return res.json({ variants: [] }); // produto sem modelGroup, sem variantes a mostrar

    // Busca outros Products do mesmo modelo (mesma brand + mesmo modelGroup)
    const all = await prisma.$queryRaw`
      SELECT id, name, "imageUrl", "aiContext"->>'color' AS color,
             "aiContext"->>'supplierRef' AS ref
      FROM "Product"
      WHERE brand = ${p.brand}
        AND "aiContext"->>'modelGroup' = ${mg}
        AND active = true
      ORDER BY "aiContext"->>'supplierRef'
    `;

    // Dedupe: 1 miniatura por COR. O catálogo às vezes tem 1 card por TAMANHO
    // (ex: ASICS "1011B958 004040" e "1011B958 004043" = mesma cor 004, tamanhos
    // diferentes). Metade desses cards vem sem cor rotulada e com imagem genérica,
    // o que gera miniaturas repetidas. Regra:
    //  - mantém 1 por cor (prefere o que tem imagem);
    //  - cards SEM cor são descartados quando já existe variante rotulada
    //    (são duplicatas incompletas por tamanho);
    //  - se NENHUMA variante tiver cor, deduplica por imagem.
    const norm = (s) => (s == null ? '' : String(s)).trim().toUpperCase();
    const labeled = all.filter((v) => norm(v.color));
    let chosen;
    if (labeled.length) {
      const byColor = new Map();
      for (const v of labeled) {
        const k = norm(v.color);
        const cur = byColor.get(k);
        if (!cur || (!cur.imageUrl && v.imageUrl)) byColor.set(k, v);
      }
      chosen = [...byColor.values()];
    } else {
      const byImg = new Map();
      for (const v of all) {
        const k = v.imageUrl || v.id;
        if (!byImg.has(k)) byImg.set(k, v);
      }
      chosen = [...byImg.values()];
    }

    const variants = chosen.map((v) => ({
      id: v.id,
      ref: v.ref,
      color: v.color,
      imageUrl: v.imageUrl,
      name: v.name,
      isCurrent: v.id === productId,
    }));
    res.json({ modelGroup: mg, variants, total: variants.length });
  } catch (err) {
    console.error('[color-variants]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/products/:id/nfe-summary
// Retorna histórico de entradas via NFe + total comprado vs total contado (bipe)
router.get('/products/:id/nfe-summary', adminOnly, async (req, res) => {
  try {
    const productId = req.params.id;

    // Todas as linhas de NFe vinculadas a esse produto
    const items = await prisma.xmlFiscalItem.findMany({
      where: { productId },
      include: {
        fiscalDocument: { select: { issueDate: true, issuerName: true, docType: true, number: true, recipientCnpj: true, brand: true } },
      },
      orderBy: { fiscalDocument: { issueDate: 'desc' } },
    });

    // Separa por tipo (entrada de fornecedor vs transferência interna)
    // REGRA CLAUDE.md: Transferência NUNCA conta como compra/estoque novo.
    // Pra comprado: SÓ docType='entrada' (não considera null/desconhecido pra evitar contar errado)
    const entradas = items.filter(i => i.fiscalDocument?.docType === 'entrada');
    const transferencias = items.filter(i => i.fiscalDocument?.docType === 'transferencia');

    const totalComprado = entradas.reduce((s, i) => s + (i.quantity || 0), 0);
    const totalTransferido = transferencias.reduce((s, i) => s + (i.quantity || 0), 0);

    // Estoque atual por loja (somando todos os tamanhos)
    const storeStocks = await prisma.storeStock.findMany({
      where: { productSize: { productId } },
      include: { store: { select: { code: true, name: true } }, productSize: { select: { size: true, barcode: true } } },
    });
    const totalEmEstoque = storeStocks.reduce((s, ss) => s + (ss.stock || 0), 0);

    // Bipes recentes do produto (last 30 days)
    const bipes30d = await prisma.stocktakeBipe.count({
      where: {
        productId,
        bipedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    });

    // VENDAS (SaleItem com esse productId)
    const saleItems = await prisma.saleItem.findMany({
      where: { productId },
      include: {
        sale: { select: { id: true, createdAt: true, storeId: true, status: true } },
      },
      orderBy: { sale: { createdAt: 'desc' } },
    });
    const totalVendido = saleItems.reduce((s, i) => s + (i.quantity || 0), 0);
    const totalRevenue = saleItems.reduce((s, i) => s + (i.totalPrice || 0), 0);

    // Hidrata nomes de lojas pras vendas
    const saleStoreIds = [...new Set(saleItems.map(i => i.sale?.storeId).filter(Boolean))];
    const saleStoresList = saleStoreIds.length ? await prisma.store.findMany({
      where: { id: { in: saleStoreIds } },
      select: { id: true, code: true, name: true },
    }) : [];
    const saleStoreMap = Object.fromEntries(saleStoresList.map(s => [s.id, s]));

    // Breakdown VENDIDO por loja
    const vendidoPorLojaMap = {};
    saleItems.forEach(i => {
      const sid = i.sale?.storeId || 'sem_loja';
      vendidoPorLojaMap[sid] = (vendidoPorLojaMap[sid] || 0) + (i.quantity || 0);
    });
    const vendidoPorLoja = Object.entries(vendidoPorLojaMap).map(([sid, qty]) => ({
      loja: saleStoreMap[sid]?.code || (sid === 'sem_loja' ? '?' : sid.slice(0, 8)),
      lojaNome: saleStoreMap[sid]?.name || null,
      qtd: qty,
    })).sort((a, b) => b.qtd - a.qtd);

    // Breakdown COMPRADO por loja (NFe → recipientCnpj → store)
    // Usa o cnpjToStore que será criado abaixo, faz depois

    // CNPJ → loja (pra mostrar pra que loja a NFe foi destinada)
    // FiscalIssuer.stores é PLURAL (1 CNPJ pode ter várias lojas físicas)
    const cnpjs = [...new Set([...entradas, ...transferencias].map(e => e.fiscalDocument?.recipientCnpj).filter(Boolean))];
    const issuers = cnpjs.length ? await prisma.fiscalIssuer.findMany({
      where: { cnpj: { in: cnpjs } },
      select: { cnpj: true, stores: { select: { code: true, name: true } } },
    }) : [];
    // Pega a 1ª loja vinculada (caso de 1-pra-1, que é o normal)
    const cnpjToStore = Object.fromEntries(issuers.map(i => [i.cnpj, i.stores?.[0] || null]));

    // Breakdown COMPRADO por loja (pelo CNPJ destinatário de cada NFe)
    const compradoPorLojaMap = {};
    entradas.forEach(e => {
      const cnpj = e.fiscalDocument?.recipientCnpj;
      const code = cnpj ? (cnpjToStore[cnpj]?.code || '?') : '?';
      compradoPorLojaMap[code] = (compradoPorLojaMap[code] || 0) + (e.quantity || 0);
    });
    const compradoPorLoja = Object.entries(compradoPorLojaMap).map(([code, qtd]) => ({
      loja: code, qtd,
    })).sort((a, b) => b.qtd - a.qtd);

    // Breakdown ESTOQUE por loja (já tenho storeStocks)
    const estoquePorLojaMap = {};
    storeStocks.forEach(ss => {
      const code = ss.store?.code || '?';
      estoquePorLojaMap[code] = (estoquePorLojaMap[code] || 0) + (ss.stock || 0);
    });
    const estoquePorLojaResumo = Object.entries(estoquePorLojaMap).map(([code, qtd]) => ({
      loja: code, qtd,
    })).filter(x => x.qtd > 0).sort((a, b) => b.qtd - a.qtd);

    res.json({
      productId,
      totals: {
        comprado: totalComprado,
        transferido: totalTransferido,
        vendido: totalVendido,
        receita: totalRevenue,
        emEstoque: totalEmEstoque,
        diferenca: totalComprado - totalVendido - totalEmEstoque,
        bipes30d,
      },
      breakdown: {
        compradoPorLoja,   // [{ loja, qtd }] — pra que loja foi destinada cada NFe
        vendidoPorLoja,    // [{ loja, lojaNome, qtd }] — qual loja vendeu quanto
        estoquePorLoja: estoquePorLojaResumo, // [{ loja, qtd }] — estoque físico
      },
      entradas: entradas.map(i => ({
        id: i.id,
        data: i.fiscalDocument?.issueDate,
        fornecedor: i.fiscalDocument?.issuerName,
        numero: i.fiscalDocument?.number,
        quantidade: i.quantity,
        valorUnit: i.unitValue,
        valorTotal: i.totalValue,
        ean: i.ean,
        ref: i.supplierCode,
        descricao: i.description,
        lojaDestino: cnpjToStore[i.fiscalDocument?.recipientCnpj]?.code || null,
        lojaNome: cnpjToStore[i.fiscalDocument?.recipientCnpj]?.name || null,
      })),
      vendas: saleItems.slice(0, 50).map(i => ({
        id: i.id,
        saleId: i.saleId,
        data: i.sale?.createdAt,
        quantidade: i.quantity,
        valorUnit: i.unitPrice,
        valorTotal: i.totalPrice,
        tamanho: i.size,
        loja: saleStoreMap[i.sale?.storeId]?.code || null,
        lojaNome: saleStoreMap[i.sale?.storeId]?.name || null,
        status: i.sale?.status,
      })),
      transferencias: transferencias.map(i => ({
        id: i.id,
        data: i.fiscalDocument?.issueDate,
        de: i.fiscalDocument?.issuerName,
        para: cnpjToStore[i.fiscalDocument?.recipientCnpj]?.code || null,
        quantidade: i.quantity,
      })),
      estoquePorLoja: storeStocks.map(ss => ({
        loja: ss.store?.code,
        lojaNome: ss.store?.name,
        tamanho: ss.productSize?.size,
        estoque: ss.stock,
        atualizadoEm: ss.updatedAt,
      })),
    });
  } catch (err) {
    console.error('[nfe-summary]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/products/:id', adminOnly, async (req, res) => {
  try {
    const p = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        sizes: {
          orderBy: { size: 'asc' },
          include: { storeStocks: { include: { store: { select: { id: true, code: true, name: true } } } } },
        },
      },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json({ product: p });
  } catch (err) {
    console.error('admin catalog get', err);
    res.status(500).json({ error: 'Erro ao carregar produto' });
  }
});

// Lista as UNIDADES (bipes) de codigos SEM tamanho (placeholder T-) agrupadas por loja.
router.get('/products/:id/unidades-sem-tamanho', adminOnly, async (req, res) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, sizes: { select: { barcode: true, size: true } } } });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    const phBarcodes = p.sizes.filter((s) => s.barcode && /^T-/.test(String(s.size))).map((s) => s.barcode);
    if (!phBarcodes.length) return res.json({ productName: p.name, lojas: [] });
    const bipes = await prisma.stocktakeBipe.findMany({ where: { productId: p.id, barcode: { in: phBarcodes } }, select: { id: true, barcode: true, storeId: true, productSize: true, bipedAt: true }, orderBy: { bipedAt: 'asc' } });
    const storeIds = [...new Set(bipes.map((b) => b.storeId).filter(Boolean))];
    const stores = await prisma.store.findMany({ where: { id: { in: storeIds } }, select: { id: true, code: true, name: true } });
    const sm = {}; for (const s of stores) sm[s.id] = s;
    const byLoja = {};
    for (const b of bipes) {
      const st = sm[b.storeId] || { code: '?', name: '(sem loja)' };
      byLoja[st.code] = byLoja[st.code] || { code: st.code, name: st.name, unidades: [] };
      const tam = b.productSize && !/^T-/.test(String(b.productSize)) ? b.productSize : '';
      byLoja[st.code].unidades.push({ bipeId: b.id, barcode: b.barcode, size: tam });
    }
    res.json({ productName: p.name, lojas: Object.values(byLoja).sort((a, b) => a.code.localeCompare(b.code)) });
  } catch (err) {
    console.error('[unidades-sem-tamanho]', err);
    res.status(500).json({ error: err.message });
  }
});

// Salva o tamanho de cada UNIDADE (bipe) em StocktakeBipe.productSize. Rollup: se todos os bipes de um codigo
// tem o MESMO tamanho, grava no ProductSize (o card passa a mostrar o numero). Nunca chuta — so o que voce digitou.
router.post('/products/:id/bipe-tamanhos', adminOnly, async (req, res) => {
  try {
    const sizes = Array.isArray(req.body && req.body.sizes) ? req.body.sizes : [];
    let saved = 0;
    for (const it of sizes) {
      if (!it || !it.bipeId) continue;
      const tam = String(it.size || '').trim().slice(0, 20);
      await prisma.stocktakeBipe.update({ where: { id: String(it.bipeId) }, data: { productSize: tam || null } }).then(() => { saved++; }).catch(() => {});
    }
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, sizes: { select: { id: true, barcode: true, size: true } } } });
    const resolvidos = [];
    for (const s of (p && p.sizes) || []) {
      if (!s.barcode || !/^T-/.test(String(s.size))) continue;
      const bps = await prisma.stocktakeBipe.findMany({ where: { productId: p.id, barcode: s.barcode }, select: { productSize: true } });
      if (!bps.length) continue;
      const tams = [...new Set(bps.map((b) => (b.productSize || '').trim()).filter(Boolean))];
      const allFilled = bps.every((b) => (b.productSize || '').trim());
      if (allFilled && tams.length === 1) {
        try { await prisma.productSize.update({ where: { id: s.id }, data: { size: tams[0] } }); resolvidos.push({ barcode: s.barcode, size: tams[0] }); } catch (e) { /* conflito de tamanho unico no card — mantem placeholder */ }
      }
    }
    res.json({ ok: true, saved, resolvidos });
  } catch (err) {
    console.error('[bipe-tamanhos]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/products', adminOnly, async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const brand = String(req.query.brand || '').trim();
    const category = String(req.query.category || '').trim();
    const gender = String(req.query.gender || '').trim();
    const modality = String(req.query.modality || '').trim();
    const tier = String(req.query.tier || req.query.especialidade || '').trim();
    const supplier = String(req.query.supplier || '').trim(); // CNPJ ou supplierId
    const nuvemshop = String(req.query.nuvemshop || '').trim(); // 'yes' = só os que foram pra Nuvemshop | 'no' = só os que não foram
    const release = String(req.query.release || '').trim(); // 'yes' = marcados p/ liberar | 'no' = não marcados
    const active = req.query.active;
    const featured = req.query.featured;

    // Filtros JSON em aiContext (suportados nativamente pelo Postgres via Prisma)
    const jsonFilters = [];
    if (gender) jsonFilters.push({ aiContext: { path: ['classification', 'gender'], equals: gender } });
    if (modality) jsonFilters.push({ aiContext: { path: ['classification', 'modality'], equals: modality } });
    if (tier) jsonFilters.push({ aiContext: { path: ['classification', 'tier'], equals: tier } });
    if (supplier) {
      // Aceita CNPJ (14 dígitos) ou supplierId. Tenta os 2 campos.
      jsonFilters.push({
        OR: [
          { aiContext: { path: ['supplierCnpj'], equals: supplier } },
          { aiContext: { path: ['supplierId'], equals: supplier } },
        ],
      });
    }

    // Produtos já enviados pra Nuvemshop (mapeados por localProductId — não há relação Prisma, então busca o set)
    const nsMaps = await prisma.nuvemshopProductMapping.findMany({ select: { localProductId: true } });
    const nsSet = new Set(nsMaps.map((m) => m.localProductId));
    const nsIds = [...nsSet];

    const where = {
      ...(nuvemshop === 'yes' ? { id: { in: nsIds } } : nuvemshop === 'no' ? { id: { notIn: nsIds } } : {}),
      ...(release === 'yes' ? { aiContext: { path: ['releaseToNuvemshop'], equals: true } }
        : release === 'no' ? { NOT: { aiContext: { path: ['releaseToNuvemshop'], equals: true } } } : {}),
      ...(brand ? { brand: { equals: brand, mode: 'insensitive' } } : {}),
      ...(category ? { category: { equals: category, mode: 'insensitive' } } : {}),
      // Default: só ativos. Pra ver inativos use ?active=false. Pra todos use ?active=all
      // Exceção: filtro "Foi pra Nuvemshop" mostra TODOS (inclusive inativos) — o dono quer ver tudo que subiu pra loja
      ...(active === 'all' || (nuvemshop === 'yes' && !active) ? {} : active === 'false' ? { active: false } : { active: true }),
      ...(featured === 'true' ? { featured: true } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { sku: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(jsonFilters.length ? { AND: jsonFilters } : {}),
    };

    const products = await prisma.product.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      take: 500,
      include: {
        sizes: {
          orderBy: { size: 'asc' },
          include: { storeStocks: { include: { store: { select: { id: true, code: true, name: true } } } } },
        },
        createdBy: { select: { id: true, name: true } },
      },
    });
    res.json({
      products: products.map((p) => {
        const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } })();
        return { ...p, naNuvemshop: nsSet.has(p.id), releaseToNuvemshop: ctx.releaseToNuvemshop === true, confirmedForNuvemshop: ctx.confirmedForNuvemshop === true, hideFromNuvemshop: ctx.hideFromNuvemshop === true };
      }),
    });
  } catch (err) {
    console.error('admin catalog products list', err);
    res.status(500).json({ error: 'Erro ao listar produtos' });
  }
});

// PASSO 1 — LIBERAR (candidato). Só MARCA pra conferência; NÃO sobe pra loja.
// A subida acontece só no PASSO 2 (confirmar). Desliberar tira da fila e desconfirma.
router.post('/products/:id/release', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const release = req.body?.release !== false; // default true
    const product = await prisma.product.findUnique({ where: { id }, select: { id: true, aiContext: true } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = parseJsonSafe(product.aiContext) || {};
    if (release) { ctx.releaseToNuvemshop = true; }
    else { delete ctx.releaseToNuvemshop; delete ctx.confirmedForNuvemshop; }
    await prisma.product.update({ where: { id }, data: { aiContext: ctx } });
    res.json({ ok: true, release }); // NÃO sobe aqui — vai pra fila de confirmação
  } catch (err) {
    console.error('release product', err);
    res.status(500).json({ error: err.message });
  }
});

// PASSO 2 — CONFIRMAR + SUBIR. Marca confirmado e sobe pra loja AGORA
// (respeita as 4 classificações + estoque físico). confirm=false só desconfirma (não remove da loja).
router.post('/products/:id/confirm', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const confirm = req.body?.confirm !== false; // default true
    const product = await prisma.product.findUnique({ where: { id }, select: { id: true, aiContext: true } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = parseJsonSafe(product.aiContext) || {};
    if (confirm) { ctx.releaseToNuvemshop = true; ctx.confirmedForNuvemshop = true; }
    else { delete ctx.confirmedForNuvemshop; }
    await prisma.product.update({ where: { id }, data: { aiContext: ctx } });

    let upload = null;
    if (confirm) {
      const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
      if (!conn) upload = { ok: false, reason: 'sem conexão Nuvemshop ativa' };
      else {
        try { const r = await nsHandlers.pushProductToNuvemshop(id, conn); upload = { ok: !r?.skipped, action: r?.action || 'ok', reason: r?.reason || null }; }
        catch (e) { upload = { ok: false, reason: String(e.message).slice(0, 160) }; }
      }
    }
    res.json({ ok: true, confirm, upload });
  } catch (err) {
    console.error('confirm product', err);
    res.status(500).json({ error: err.message });
  }
});

// PASSO 2 em MASSA — confirma + sobe os selecionados (retorna o que subiu e o que travou + motivo).
router.post('/products/bulk-confirm', adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ error: 'nenhum produto selecionado' });
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return res.status(400).json({ error: 'sem conexão Nuvemshop ativa' });
    let uploaded = 0, skipped = 0; const skips = [];
    for (const id of ids) {
      const product = await prisma.product.findUnique({ where: { id }, select: { aiContext: true, name: true } });
      if (!product) continue;
      const ctx = parseJsonSafe(product.aiContext) || {};
      ctx.releaseToNuvemshop = true; ctx.confirmedForNuvemshop = true;
      await prisma.product.update({ where: { id }, data: { aiContext: ctx } });
      try { const r = await nsHandlers.pushProductToNuvemshop(id, conn); if (r?.skipped) { skipped++; skips.push({ name: product.name, reason: r.reason }); } else uploaded++; }
      catch (e) { skipped++; skips.push({ name: product.name, reason: String(e.message).slice(0, 100) }); }
    }
    res.json({ ok: true, uploaded, skipped, skips: skips.slice(0, 20) });
  } catch (err) {
    console.error('bulk-confirm', err);
    res.status(500).json({ error: err.message });
  }
});

// Oculta/mostra o produto na loja Nuvemshop SEM apagar (despublica/republica). Reversível.
// hide=true → published=false na loja (some da vitrine, mantém link/dados); o cron NÃO republica.
// hide=false → tira a marca e republica (se classificado + estoque).
router.post('/products/:id/hide-nuvemshop', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const hide = req.body?.hide !== false; // default true
    const product = await prisma.product.findUnique({ where: { id }, select: { id: true, aiContext: true } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = parseJsonSafe(product.aiContext) || {};
    if (hide) ctx.hideFromNuvemshop = true; else delete ctx.hideFromNuvemshop;
    // muda o físico → invalida assinatura do cron pra forçar re-sync no próximo ciclo
    delete ctx.nsStockSig;
    await prisma.product.update({ where: { id }, data: { aiContext: ctx } });

    let applied = null;
    const mapping = await prisma.nuvemshopProductMapping.findUnique({ where: { localProductId: id } });
    if (!mapping) {
      applied = { ok: true, reason: 'não está na loja — marcação salva (vale quando subir)' };
    } else {
      const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
      if (!conn) applied = { ok: false, reason: 'sem conexão Nuvemshop ativa' };
      else {
        try { const r = await nsHandlers.pushProductToNuvemshop(id, conn); applied = { ok: !r?.skipped, reason: r?.reason || null }; }
        catch (e) { applied = { ok: false, reason: String(e.message).slice(0, 160) }; }
      }
    }
    res.json({ ok: true, hide, applied });
  } catch (err) {
    console.error('hide nuvemshop', err);
    res.status(500).json({ error: err.message });
  }
});

// PASSO 1 em massa — LIBERAR vários (candidatos). Só marca; NÃO sobe (subir = confirmar).
router.post('/products/bulk-release', adminOnly, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const release = req.body?.release !== false;
    if (!ids.length) return res.status(400).json({ error: 'nenhum produto selecionado' });
    let marked = 0;
    for (const id of ids) {
      const product = await prisma.product.findUnique({ where: { id }, select: { aiContext: true } });
      if (!product) continue;
      const ctx = parseJsonSafe(product.aiContext) || {};
      if (release) { ctx.releaseToNuvemshop = true; }
      else { delete ctx.releaseToNuvemshop; delete ctx.confirmedForNuvemshop; }
      await prisma.product.update({ where: { id }, data: { aiContext: ctx } });
      marked++;
    }
    res.json({ ok: true, marked }); // NÃO sobe — vão pra fila de confirmação
  } catch (err) {
    console.error('bulk-release', err);
    res.status(500).json({ error: err.message });
  }
});

// Remove o produto da loja Nuvemshop (deleta lá + limpa mappings + desmarca liberação).
router.post('/products/:id/remove-nuvemshop', adminOnly, async (req, res) => {
  try {
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return res.status(400).json({ error: 'sem conexão Nuvemshop ativa' });
    const r = await nsHandlers.removeProductFromNuvemshop(req.params.id, conn);
    res.json(r);
  } catch (err) {
    console.error('remove from nuvemshop', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/products', adminOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const sku = String(b.sku || '').trim();
    const name = String(b.name || '').trim();
    const brand = String(b.brand || '').trim();
    const category = String(b.category || '').trim();
    const price = parseFloat(b.price);
    if (!sku || !name || !brand || !category || Number.isNaN(price)) {
      return res.status(400).json({ error: 'sku, name, brand, category e price são obrigatórios' });
    }

    const sizes = Array.isArray(b.sizes) ? b.sizes : [];

    const product = await prisma.product.create({
      data: {
        sku,
        name,
        brand,
        category,
        subcategory: b.subcategory ? String(b.subcategory) : null,
        shortDescription: b.shortDescription ? String(b.shortDescription).slice(0, 2000) : null,
        longDescription: b.longDescription ? String(b.longDescription).slice(0, 8000) : null,
        features: parseJsonSafe(b.features),
        aiContext: parseJsonSafe(b.aiContext),
        recommendedFor: parseJsonSafe(b.recommendedFor),
        notRecommendedFor: parseJsonSafe(b.notRecommendedFor),
        imageUrl: b.imageUrl ? String(b.imageUrl) : null,
        imageUrls: parseJsonSafe(b.imageUrls),
        price,
        promoPrice: b.promoPrice != null && b.promoPrice !== '' ? parseFloat(b.promoPrice) : null,
        ncm: b.ncm ? String(b.ncm).replace(/\D/g, '').slice(0, 8) : null,
        cest: b.cest ? String(b.cest).replace(/\D/g, '').slice(0, 7) : null,
        cfop: b.cfop ? String(b.cfop).replace(/\D/g, '').slice(0, 4) : null,
        origem: b.origem != null ? parseInt(b.origem, 10) || 0 : 0,
        unidade: b.unidade ? String(b.unidade).slice(0, 6) : 'UN',
        active: b.active !== false,
        featured: !!b.featured,
        source: b.source ? String(b.source).slice(0, 32) : 'manual',
        createdById: req.userId,
        sizes: {
          create: sizes
            .filter((s) => s && s.size)
            .map((s) => ({
              size: String(s.size),
              stock: Math.max(0, parseInt(s.stock, 10) || 0),
              barcode: s.barcode ? String(s.barcode) : null,
            })),
        },
      },
      include: { sizes: true },
    });
    res.json({ product });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU já cadastrado' });
    console.error('admin catalog create', err);
    res.status(500).json({ error: 'Erro ao criar produto' });
  }
});

router.put('/products/:id', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    const b = req.body || {};
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Produto não encontrado' });

    const data = {
      ...(b.sku != null ? { sku: String(b.sku).trim() } : {}),
      ...(b.name != null ? { name: String(b.name).trim() } : {}),
      ...(b.brand != null ? { brand: String(b.brand).trim() } : {}),
      ...(b.category != null ? { category: String(b.category).trim() } : {}),
      ...(b.subcategory !== undefined ? { subcategory: b.subcategory ? String(b.subcategory) : null } : {}),
      ...(b.shortDescription !== undefined
        ? { shortDescription: b.shortDescription ? String(b.shortDescription).slice(0, 2000) : null }
        : {}),
      ...(b.longDescription !== undefined
        ? { longDescription: b.longDescription ? String(b.longDescription).slice(0, 8000) : null }
        : {}),
      ...(b.features !== undefined ? { features: parseJsonSafe(b.features) } : {}),
      ...(b.aiContext !== undefined ? { aiContext: parseJsonSafe(b.aiContext) } : {}),
      ...(b.recommendedFor !== undefined ? { recommendedFor: parseJsonSafe(b.recommendedFor) } : {}),
      ...(b.notRecommendedFor !== undefined ? { notRecommendedFor: parseJsonSafe(b.notRecommendedFor) } : {}),
      ...(b.imageUrl !== undefined ? { imageUrl: b.imageUrl ? String(b.imageUrl) : null } : {}),
      ...(b.imageUrls !== undefined ? { imageUrls: parseJsonSafe(b.imageUrls) } : {}),
      ...(b.price != null ? { price: parseFloat(b.price) } : {}),
      ...(b.promoPrice !== undefined
        ? { promoPrice: b.promoPrice != null && b.promoPrice !== '' ? parseFloat(b.promoPrice) : null }
        : {}),
      ...(b.ncm !== undefined ? { ncm: b.ncm ? String(b.ncm).replace(/\D/g, '').slice(0, 8) : null } : {}),
      ...(b.cest !== undefined ? { cest: b.cest ? String(b.cest).replace(/\D/g, '').slice(0, 7) : null } : {}),
      ...(b.cfop !== undefined ? { cfop: b.cfop ? String(b.cfop).replace(/\D/g, '').slice(0, 4) : null } : {}),
      ...(b.origem !== undefined ? { origem: parseInt(b.origem, 10) || 0 } : {}),
      ...(b.unidade !== undefined ? { unidade: b.unidade ? String(b.unidade).slice(0, 6) : 'UN' } : {}),
      ...(b.active !== undefined ? { active: !!b.active } : {}),
      ...(b.featured !== undefined ? { featured: !!b.featured } : {}),
      ...(b.source != null ? { source: String(b.source).slice(0, 32) } : {}),
    };

    let sizesWithStore = null;
    if (Array.isArray(b.sizes)) {
      // Detecta formato novo (com storeId) vs antigo (apenas size+stock)
      const hasStoreInfo = b.sizes.some((s) => s && s.storeId);

      if (hasStoreInfo) {
        // FORMATO NOVO: agrega por size, mas guarda os storeStocks pra criar depois
        const bySizeStore = new Map();
        const sizesSet = new Map();
        b.sizes.filter((s) => s && s.size).forEach((s) => {
          const sz = String(s.size);
          const qty = Math.max(0, parseInt(s.stock, 10) || 0);
          if (qty === 0) return;
          // Acumula no tamanho (total)
          sizesSet.set(sz, (sizesSet.get(sz) || 0) + qty);
          // Acumula por loja
          if (s.storeId) {
            const key = sz + '||' + s.storeId;
            bySizeStore.set(key, { size: sz, storeId: s.storeId, stock: (bySizeStore.get(key)?.stock || 0) + qty });
          }
        });
        // Apaga sizes anteriores (cascade apaga StoreStock por causa do onDelete: Cascade)
        await prisma.productSize.deleteMany({ where: { productId: id } });
        data.sizes = {
          create: [...sizesSet.entries()].map(([sz, total]) => ({
            size: sz,
            stock: total,
            barcode: null,
          })),
        };
        sizesWithStore = [...bySizeStore.values()];
      } else {
        await prisma.productSize.deleteMany({ where: { productId: id } });
        data.sizes = {
          create: b.sizes
            .filter((s) => s && s.size)
            .map((s) => ({
              size: String(s.size),
              stock: Math.max(0, parseInt(s.stock, 10) || 0),
              barcode: s.barcode ? String(s.barcode) : null,
            })),
        };
      }
    }

    const product = await prisma.product.update({
      where: { id },
      data,
      include: { sizes: true },
    });

    // Cria StoreStocks (formato novo)
    if (sizesWithStore && sizesWithStore.length) {
      for (const ss of sizesWithStore) {
        const ps = product.sizes.find((x) => x.size === ss.size);
        if (!ps) continue;
        await prisma.storeStock.create({
          data: { storeId: ss.storeId, productSizeId: ps.id, stock: ss.stock },
        }).catch(() => {});
      }
    }

    // Sync automatica com Nuvemshop (se produto tem mapping)
    const nsSync = await syncProductToNuvemshop(product.id);

    res.json({ product, nuvemshop: nsSync });
  } catch (err) {
    if (err.code === 'P2002') return res.status(400).json({ error: 'SKU já cadastrado' });
    console.error('admin catalog update', err);
    res.status(500).json({ error: 'Erro ao atualizar produto' });
  }
});

router.delete('/products/:id', adminOnly, async (req, res) => {
  try {
    const id = req.params.id;
    await prisma.productSize.deleteMany({ where: { productId: id } });
    await prisma.product.delete({ where: { id } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2003') {
      return res.status(400).json({ error: 'Produto vinculado a outras tabelas — não é possível excluir' });
    }
    console.error('admin catalog delete', err);
    res.status(500).json({ error: 'Erro ao remover produto' });
  }
});

/* ====================== IMPORTAÇÃO CSV ====================== */

const REQUIRED_HEADERS = ['sku', 'nome', 'marca', 'categoria', 'subcategoria', 'preco_custo', 'preco_venda'];

function normalizeBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parsePtNumber(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  s = s.replace(/\s+/g, '').replace(/[Rr]\$/g, '');
  // 1.234,56 -> 1234.56
  if (s.indexOf(',') >= 0 && s.indexOf('.') >= 0) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.indexOf(',') >= 0) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseCatalogCsv(text) {
  const cleaned = normalizeBom(text);
  const parsed = Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => String(h || '').trim().toLowerCase(),
  });
  return parsed;
}

function summarizeBrands(grouped) {
  const counts = new Map();
  for (const it of grouped) {
    counts.set(it.brand, (counts.get(it.brand) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([brand, count]) => ({ brand, count }))
    .sort((a, b) => b.count - a.count);
}

function groupCatalogRows(rows) {
  const bySku = new Map();
  const errors = [];
  let totalRows = 0;
  let totalVariants = 0;

  rows.forEach((row, idx) => {
    const lineNumber = idx + 2; // +2 = cabeçalho + 1 (linhas humanas)
    if (!row || typeof row !== 'object') return;

    const sku = String(row.sku || '').trim();
    const nome = String(row.nome || '').trim();
    const marca = String(row.marca || '').trim();
    const categoria = String(row.categoria || '').trim();
    const subcategoria = String(row.subcategoria || '').trim();
    const tamanho = String(row.tamanho || '').trim();
    const codigoBarras = String(row.codigo_barras || '').trim();
    const fornecedor = String(row.fornecedor || '').trim();

    if (!sku && !nome && !marca && !tamanho) return;
    totalRows += 1;

    if (!sku) {
      errors.push({ line: lineNumber, error: 'SKU vazio' });
      return;
    }
    if (!nome) {
      errors.push({ line: lineNumber, sku, error: 'Nome vazio' });
      return;
    }
    if (!marca) {
      errors.push({ line: lineNumber, sku, error: 'Marca vazia' });
      return;
    }
    if (!categoria) {
      errors.push({ line: lineNumber, sku, error: 'Categoria vazia' });
      return;
    }

    const precoCusto = parsePtNumber(row.preco_custo);
    const precoVenda = parsePtNumber(row.preco_venda);
    if (Number.isNaN(precoVenda) || precoVenda <= 0) {
      errors.push({ line: lineNumber, sku, error: 'preco_venda inválido' });
      return;
    }
    if (Number.isNaN(precoCusto) || precoCusto < 0) {
      errors.push({ line: lineNumber, sku, error: 'preco_custo inválido' });
      return;
    }

    if (!bySku.has(sku)) {
      bySku.set(sku, {
        sku,
        name: nome,
        brand: marca,
        category: categoria.toLowerCase(),
        subcategory: subcategoria || null,
        price: precoVenda,
        costPrice: precoCusto,
        supplier: fornecedor || null,
        sizes: [],
      });
    }
    const g = bySku.get(sku);
    if (precoVenda && (!g.price || g.price < precoVenda)) {
      // mantém o maior preço de venda visto entre as linhas (caso variem)
      // mas idealmente deve ser o mesmo em todas as linhas
    }
    if (tamanho) {
      const seen = g.sizes.find((s) => s.size === tamanho);
      if (!seen) {
        g.sizes.push({
          size: tamanho,
          stock: 0,
          barcode: codigoBarras || null,
        });
        totalVariants += 1;
      } else if (codigoBarras && !seen.barcode) {
        seen.barcode = codigoBarras;
      }
    }
  });

  return {
    items: Array.from(bySku.values()),
    totalRows,
    totalVariants,
    errors,
  };
}

function validateHeaders(parsed) {
  const headers = (parsed.meta && parsed.meta.fields) || [];
  const set = new Set(headers.map((h) => String(h || '').trim().toLowerCase()));
  const missing = REQUIRED_HEADERS.filter((h) => !set.has(h));
  return missing;
}

router.post(
  '/import-preview',
  adminOnly,
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? multerErrorHandler(err, req, res, next) : next())),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Envie o arquivo CSV no campo file' });
      }
      const text = req.file.buffer.toString('utf8');
      const parsed = parseCatalogCsv(text);

      const missing = validateHeaders(parsed);
      if (missing.length) {
        return res.status(400).json({
          error: 'Cabeçalhos obrigatórios faltando: ' + missing.join(', '),
          required: REQUIRED_HEADERS,
        });
      }

      const parseErrs = (parsed.errors || []).slice(0, 20).map((e) => ({
        line: (e.row != null ? e.row + 2 : null),
        error: e.message || 'Erro de parse CSV',
      }));

      const grouped = groupCatalogRows(parsed.data || []);
      const errors = parseErrs.concat(grouped.errors).slice(0, 200);

      const items = grouped.items;
      const brands = summarizeBrands(items);

      res.json({
        ok: true,
        totalRows: grouped.totalRows,
        uniqueProducts: items.length,
        totalVariants: grouped.totalVariants,
        brandsCount: brands.length,
        brands,
        preview: items.slice(0, 10).map((it) => ({
          sku: it.sku,
          name: it.name,
          brand: it.brand,
          category: it.category,
          subcategory: it.subcategory,
          costPrice: it.costPrice,
          price: it.price,
          sizes: it.sizes,
        })),
        errors,
      });
    } catch (err) {
      console.error('import-preview', err);
      res.status(500).json({ error: 'Erro ao processar CSV' });
    }
  },
);

router.post(
  '/import-csv',
  adminOnly,
  (req, res, next) => upload.single('file')(req, res, (err) => (err ? multerErrorHandler(err, req, res, next) : next())),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'Envie o arquivo CSV no campo file' });
      }
      const text = req.file.buffer.toString('utf8');
      const parsed = parseCatalogCsv(text);

      const missing = validateHeaders(parsed);
      if (missing.length) {
        return res.status(400).json({
          error: 'Cabeçalhos obrigatórios faltando: ' + missing.join(', '),
          required: REQUIRED_HEADERS,
        });
      }

      const grouped = groupCatalogRows(parsed.data || []);
      const errors = grouped.errors.slice();
      const items = grouped.items;

      let productsCreated = 0;
      let productsUpdated = 0;
      let sizesCreated = 0;

      for (const it of items) {
        try {
          const aiContext = {
            costPrice: it.costPrice,
            supplier: it.supplier || null,
          };

          const sizesData = it.sizes
            .filter((s) => s && s.size)
            .map((s) => ({
              size: String(s.size).slice(0, 20),
              stock: 0,
              barcode: s.barcode ? String(s.barcode).slice(0, 64) : null,
            }));

          const existing = await prisma.product.findUnique({
            where: { sku: it.sku },
            select: { id: true, sizes: { select: { size: true } } },
          });

          if (existing) {
            await prisma.product.update({
              where: { id: existing.id },
              data: {
                name: it.name,
                brand: it.brand,
                category: it.category,
                subcategory: it.subcategory || null,
                price: it.price,
                source: 'csv',
                aiContext,
              },
            });
            const existingSizes = new Set(existing.sizes.map((s) => s.size));
            const toCreate = sizesData.filter((s) => !existingSizes.has(s.size));
            if (toCreate.length) {
              for (const s of toCreate) {
                try {
                  await prisma.productSize.create({
                    data: { ...s, productId: existing.id },
                  });
                  sizesCreated += 1;
                } catch (e2) {
                  errors.push({ sku: it.sku, error: 'Falha ao criar tamanho ' + s.size + ': ' + (e2.code || e2.message || 'erro') });
                }
              }
            }
            productsUpdated += 1;
          } else {
            const created = await prisma.product.create({
              data: {
                sku: it.sku,
                name: it.name,
                brand: it.brand,
                category: it.category,
                subcategory: it.subcategory || null,
                price: it.price,
                source: 'csv',
                createdById: req.userId,
                aiContext,
                sizes: sizesData.length ? { create: sizesData } : undefined,
              },
              select: { id: true, sizes: { select: { id: true } } },
            });
            productsCreated += 1;
            sizesCreated += created.sizes.length;
          }
        } catch (eRow) {
          errors.push({ sku: it.sku, error: eRow.code || eRow.message || 'erro' });
        }
      }

      res.json({
        ok: true,
        totalRows: grouped.totalRows,
        productsCreated,
        productsUpdated,
        sizesCreated,
        errors: errors.slice(0, 200),
      });
    } catch (err) {
      console.error('import-csv', err);
      res.status(500).json({ error: 'Erro ao importar CSV' });
    }
  },
);

/* ====================== ENRIQUECIMENTO COM IA ====================== */

const enrichJobs = new Map();
let activeEnrichJobId = null;

const ENRICH_BATCH_CONCURRENCY = 5;
const ENRICH_PER_PRODUCT_BRL_ESTIMATE = parseFloat(process.env.AI_ENRICH_PER_PRODUCT_BRL || '0.20');

const ALLOWED_CATEGORIES = ['Tênis', 'Vestuário', 'Acessórios', 'Calçado', 'Esportes'];
const ALLOWED_SUBCATEGORIES = {
  'Tênis': ['Corrida', 'Casual', 'Futebol Campo', 'Futsal', 'Society', 'Lifestyle', 'Treino', 'Caminhada'],
  'Vestuário': ['Camiseta', 'Short', 'Calça', 'Jaqueta'],
  'Acessórios': ['Meias', 'Boné', 'Mochila', 'Proteção'],
  'Calçado': ['Sandália', 'Chinelo'],
  'Esportes': ['Bola', 'Luvas'],
};

function normalizeCategory(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  for (const c of ALLOWED_CATEGORIES) {
    if (c.toLowerCase() === s) return c;
  }
  if (s === 'tenis' || s === 'tênis') return 'Tênis';
  if (s === 'vestuario' || s === 'vestuário' || s === 'roupa' || s === 'roupas') return 'Vestuário';
  if (s === 'acessorio' || s === 'acessório' || s === 'acessorios' || s === 'acessórios') return 'Acessórios';
  if (s === 'calcado' || s === 'calçado' || s === 'calcados' || s === 'calçados') return 'Calçado';
  if (s === 'esporte' || s === 'esportes') return 'Esportes';
  return null;
}

function normalizeSubcategory(category, raw) {
  if (!raw || !category) return null;
  const list = ALLOWED_SUBCATEGORIES[category] || [];
  const s = String(raw).trim().toLowerCase();
  for (const sub of list) {
    if (sub.toLowerCase() === s) return sub;
  }
  return null;
}

function buildEnrichmentPrompt(p) {
  const brand = String(p.brand || '').trim();
  const name = String(p.name || '').trim();
  const cat = String(p.category || '').trim();
  const sub = String(p.subcategory || '').trim();
  const sku = String(p.sku || '').trim();
  const cabec = (sub ? cat + ' / ' + sub : cat);

  return (
    'Busque online o produto "' + brand + ' ' + name + '" '
    + '(categoria atual no banco: ' + cabec + ', SKU ' + sku + ') e me retorne JSON estruturado com:\n'
    + '{\n'
    + '  "imageUrl": "URL DIRETA da imagem oficial — DEVE terminar em .jpg, .jpeg, .png ou .webp. NUNCA URL de página HTML.",\n'
    + '  "category": "uma de: Tênis, Vestuário, Acessórios, Calçado, Esportes",\n'
    + '  "subcategory": "subcategoria conforme tabela abaixo",\n'
    + '  "shortDescription": "1 frase descrevendo o produto",\n'
    + '  "longDescription": "parágrafo de 2-3 frases sobre o produto, construção, propósito",\n'
    + '  "features": {\n'
    + '    "peso": "peso em gramas se for tênis",\n'
    + '    "drop": "drop em mm se for tênis",\n'
    + '    "amortecimento": "tipo de amortecimento",\n'
    + '    "tecnologias": ["lista", "de", "tecnologias"],\n'
    + '    "material": "material do upper/cabedal",\n'
    + '    "uso_indicado": "corrida iniciante / treino / casual / etc"\n'
    + '  },\n'
    + '  "recommendedFor": ["lista de perfis - ex: corrida_iniciante, pisada_neutra, peso_acima_80kg"],\n'
    + '  "notRecommendedFor": ["lista - ex: trail_running, alta_velocidade"]\n'
    + '}\n\n'
    + 'REGRAS DE imageUrl — TENTE GOOGLE IMAGES PRIMEIRO:\n'
    + '- Use a tool web_search NESTA ORDEM até achar URL de imagem:\n'
    + '   1. "images.google.com ' + brand + ' ' + name + '"\n'
    + '   2. "' + brand + ' ' + name + ' ' + sku + ' imagem"\n'
    + '   3. "' + brand + ' ' + name + ' foto produto"\n'
    + '   4. "site:assets.adidas.com OR site:static.nike.com OR site:images.puma.com ' + sku + '"\n'
    + '   5. "site:netshoes.com.br OR site:centauro.com.br ' + brand + ' ' + name + ' jpg"\n'
    + '- ACEITE qualquer uma destas:\n'
    + '   • URL terminando em .jpg, .jpeg, .png, .webp, .gif ou .avif\n'
    + '   • URL Google Images: encrypted-tbn0.gstatic.com, googleusercontent.com\n'
    + '   • CDNs de imagem conhecidos: cloudfront.net, cdn.shopify.com, mlcdn.com.br, mlstatic.com, akamaihd.net, imgix.net, cloudinary.com, imagedelivery.net, assets.adidas.com, static.nike.com, images.puma.com, static.netshoes.com.br, static.centauro.com.br\n'
    + '- REJEITE (retorne imageUrl: null) se a URL:\n'
    + '   (a) contém ".html" ou ".htm" em qualquer lugar\n'
    + '   (b) é "google.com/search?q=..." (página de busca, não thumbnail)\n'
    + '   (c) termina em "/p/SLUG", "/produto/SLUG", "/produtos/SLUG", "/product/SLUG" ou "/products/SLUG" sem extensão de imagem\n'
    + '   (d) tem ?q= ?search= ?query= como parâmetro principal\n'
    + '- Se nada funcionar, retorne imageUrl: null. NÃO INVENTE URL.\n'
    + '- VÁLIDO: https://encrypted-tbn0.gstatic.com/images?q=tbn:abc..., https://imagedelivery.net/abc/foto.png, https://assets.adidas.com/.../JP5219_01.jpg, https://cdn.shopify.com/s/files/.../foo.jpg\n'
    + '- INVÁLIDO: https://adidas.com.br/tenis-alphaedge/JP5219.html, https://google.com/search?q=adidas, https://www.adidas.com.br/p/JP5219, https://nike.com.br/algumacoisa\n\n'
    + 'REGRAS DE category / subcategory:\n'
    + '- category DEVE ser exatamente uma de: ' + ALLOWED_CATEGORIES.join(', ') + '\n'
    + '- subcategory baseada na category:\n'
    + Object.entries(ALLOWED_SUBCATEGORIES).map(([k, v]) => '  - ' + k + ': ' + v.join(', ')).join('\n') + '\n'
    + '- Se não souber a subcategory, use "Geral".\n'
    + '- Identifique a category mesmo que a categoria atual no banco esteja errada (ex.: "outros").\n\n'
    + 'OUTRAS REGRAS:\n'
    + '- Se for vestuário/acessório, foque em material, tecnologias, uso indicado.\n'
    + '- NUNCA invente especificações — se não souber, omite o campo dentro de features.\n'
    + '- Retorne APENAS o JSON, sem texto antes ou depois, sem markdown.\n'
    + '- Se o produto não for encontrado online, retorne { "error": "Produto não localizado" }'
  );
}

function extractJsonObject(text) {
  const s = String(text || '');
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j <= i) return null;
  const snippet = s.slice(i, j + 1);
  try {
    return JSON.parse(snippet);
  } catch {
    return null;
  }
}

function isValidHttpUrl(v) {
  if (!v) return false;
  try {
    const u = new URL(String(v));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|gif|avif)$/i;
const IMAGE_PATH_HINT_RE = /\/(image|img|photo|foto|asset)s?\//i;
const HTML_ANY_RE = /\.html?(?:[/?#]|$)/i;
const PRODUCT_PAGE_END_RE = /\/(p|produto|produtos|product|products)\/[^/]+\/?$/i;
const KNOWN_IMAGE_CDNS = [
  'encrypted-tbn0.gstatic.com',
  'googleusercontent.com',
  'cloudfront.net',
  'akamaihd.net',
  'mlcdn.com.br',
  'mlstatic.com',
  'cdn.shopify.com',
  'shopify.com',
  'imgix.net',
  'cloudinary.com',
  'imagedelivery.net',
  'assets.adidas.com',
  'static.nike.com',
  'images.puma.com',
  'static.netshoes.com.br',
  'static.centauro.com.br',
  'imgnike-a.akamaihd.net',
];

function pathOnly(url) {
  try { return new URL(url).pathname || ''; } catch { return ''; }
}

function validateImageUrl(raw) {
  if (raw == null || raw === '') return { ok: false, reason: 'imageUrl ausente' };
  if (!isValidHttpUrl(raw)) return { ok: false, reason: 'URL não-http(s)' };
  const url = String(raw).trim();
  const lower = url.toLowerCase();
  const pathname = pathOnly(url);
  const pathLower = pathname.toLowerCase();

  // Rejeições incondicionais (mesmo se vier de CDN conhecido)
  if (HTML_ANY_RE.test(lower)) return { ok: false, reason: 'URL contém .html / .htm (página HTML)' };
  if (/\.(aspx|php|jsp|asp)(?:[/?#]|$)/i.test(lower)) return { ok: false, reason: 'URL é página dinâmica' };
  if (lower.includes('google.com/search')) return { ok: false, reason: 'URL é busca Google (google.com/search)' };

  // Aceites prioritários
  if (IMAGE_EXT_RE.test(pathname)) return { ok: true, url };
  for (const cdn of KNOWN_IMAGE_CDNS) {
    if (lower.includes(cdn)) return { ok: true, url, cdn };
  }

  // Rejeições contextuais (só aplicam se não é CDN conhecido nem extensão de imagem)
  if (PRODUCT_PAGE_END_RE.test(pathname)) {
    return { ok: false, reason: 'URL é página de produto (termina em /p|produto|products/SLUG)' };
  }
  if (/[?&](q|search|query)=/i.test(lower)) {
    return { ok: false, reason: 'URL é uma busca, não imagem' };
  }

  if (IMAGE_PATH_HINT_RE.test(pathLower)) {
    return { ok: true, url, soft: true };
  }
  return { ok: false, reason: 'URL não termina em extensão de imagem nem é CDN de imagem conhecido' };
}

function computeAiCost(usage) {
  const inM = parseFloat(process.env.AI_PRICE_INPUT_PER_1M || '1');
  const outM = parseFloat(process.env.AI_PRICE_OUTPUT_PER_1M || '5');
  const brl = parseFloat(process.env.BRL_PER_USD || '5.5');
  const inT = (usage && usage.input_tokens) || 0;
  const outT = (usage && usage.output_tokens) || 0;
  const usd = (inT / 1e6) * inM + (outT / 1e6) * outM;
  return { inT, outT, usd, brl: usd * brl };
}

async function enrichProductOnce(product) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'IA indisponível (ANTHROPIC_API_KEY ausente)' };

  const client = new Anthropic({ apiKey: key });
  const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

  const t0 = Date.now();
  let resp;
  try {
    resp = await client.messages.create({
      model,
      max_tokens: 1500,
      system:
        'Você é especialista em calçados e artigos esportivos. Use web_search para encontrar dados reais do produto antes de responder. Responda APENAS com JSON válido (sem markdown, sem texto extra antes ou depois).',
      tools,
      messages: [{ role: 'user', content: buildEnrichmentPrompt(product) }],
    });
  } catch (err) {
    return { ok: false, error: 'Erro Anthropic: ' + (err.message || 'desconhecido') };
  }

  const textOut = (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const data = extractJsonObject(textOut);
  if (!data) {
    return { ok: false, error: 'Resposta da IA sem JSON', raw: textOut.slice(0, 300) };
  }
  if (data.error) {
    return { ok: false, error: String(data.error).slice(0, 200) };
  }

  const updates = {};
  let imageRejectReason = null;
  let rawImageUrlSeen = data.imageUrl != null ? String(data.imageUrl) : null;
  console.log('[enrich] sku=' + product.sku + ' URL recebida da IA: ' + (rawImageUrlSeen ? rawImageUrlSeen.slice(0, 300) : '(null)'));
  if (rawImageUrlSeen == null || rawImageUrlSeen === '') {
    updates.imageUrl = null;
    console.log('[enrich] sku=' + product.sku + ' URL válida? false (IA retornou null/vazia)');
  } else {
    const v = validateImageUrl(rawImageUrlSeen);
    console.log('[enrich] sku=' + product.sku + ' URL válida? ' + v.ok + (v.ok ? '' : ' — motivo: ' + v.reason) + (v.soft ? ' (soft)' : ''));
    if (v.ok) {
      updates.imageUrl = v.url.slice(0, 1000);
    } else {
      updates.imageUrl = null;
      imageRejectReason = v.reason;
      console.warn('[enrich] sku=' + product.sku + ' URL inválida descartada (' + v.reason + '): ' + rawImageUrlSeen.slice(0, 200));
    }
  }
  const cat = normalizeCategory(data.category);
  if (cat) {
    updates.category = cat;
    const sub = normalizeSubcategory(cat, data.subcategory);
    updates.subcategory = sub || (data.subcategory ? String(data.subcategory).slice(0, 60) : 'Geral');
  } else if (data.subcategory) {
    updates.subcategory = String(data.subcategory).slice(0, 60);
  }

  if (data.shortDescription) updates.shortDescription = String(data.shortDescription).slice(0, 1000);
  if (data.longDescription) updates.longDescription = String(data.longDescription).slice(0, 4000);
  if (data.features && typeof data.features === 'object' && !Array.isArray(data.features)) {
    updates.features = data.features;
  }
  if (Array.isArray(data.recommendedFor)) {
    updates.recommendedFor = data.recommendedFor.map((x) => String(x).slice(0, 80)).slice(0, 20);
  }
  if (Array.isArray(data.notRecommendedFor)) {
    updates.notRecommendedFor = data.notRecommendedFor.map((x) => String(x).slice(0, 80)).slice(0, 20);
  }

  if (!Object.keys(updates).length) {
    return { ok: false, error: 'IA não retornou campos utilizáveis' };
  }

  updates.aiContext = {
    ...(product.aiContext && typeof product.aiContext === 'object' ? product.aiContext : {}),
    enrichedAt: new Date().toISOString(),
    enrichedModel: model,
    ...(imageRejectReason ? { imageRejectReason, rawImageUrl: String(data.imageUrl).slice(0, 500) } : {}),
  };

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: updates,
  });

  console.log('[enrich] sku=' + product.sku + ' URL final salva: ' + (updated.imageUrl || '(null)'));

  const cost = computeAiCost(resp.usage);
  cost.ms = Date.now() - t0;

  return { ok: true, product: updated, cost, raw: data };
}

router.post('/enrich/:productId', adminOnly, async (req, res) => {
  try {
    const id = String(req.params.productId);
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) return res.status(404).json({ error: 'Produto não encontrado' });

    const r = await enrichProductOnce(product);
    if (!r.ok) {
      console.warn('[enrich] sku=' + product.sku + ' fail:', r.error);
      return res.status(422).json({ error: r.error, raw: r.raw });
    }
    console.log(
      '[enrich] sku=' + product.sku
      + ' ok ms=' + r.cost.ms
      + ' usd=' + r.cost.usd.toFixed(4)
      + ' brl=' + r.cost.brl.toFixed(4),
    );
    res.json({ success: true, product: r.product, cost: r.cost });
  } catch (err) {
    console.error('[enrich] route error', err);
    res.status(500).json({ error: 'Erro no enriquecimento' });
  }
});

function buildEnrichWhere({ onlyMissing, category, brand, productIds, source }) {
  const where = { active: true };
  if (Array.isArray(productIds) && productIds.length) {
    where.id = { in: productIds.map(String) };
    return where;
  }
  if (onlyMissing) where.imageUrl = null;
  if (category) where.category = { equals: String(category), mode: 'insensitive' };
  if (brand) where.brand = { equals: String(brand), mode: 'insensitive' };
  if (source) where.source = String(source);
  return where;
}

router.get('/enrich-estimate', adminOnly, async (req, res) => {
  try {
    const where = buildEnrichWhere({
      onlyMissing: req.query.onlyMissing === 'true',
      category: req.query.category,
      brand: req.query.brand,
      source: req.query.source,
    });
    const total = await prisma.product.count({ where });
    const estimateBRL = total * ENRICH_PER_PRODUCT_BRL_ESTIMATE;
    res.json({
      total,
      estimateBRL: Number(estimateBRL.toFixed(2)),
      perProductBRL: ENRICH_PER_PRODUCT_BRL_ESTIMATE,
      activeJobId: activeEnrichJobId,
    });
  } catch (err) {
    console.error('[enrich-estimate] error', err);
    res.status(500).json({ error: 'Erro ao estimar enriquecimento' });
  }
});

router.post('/enrich-batch', adminOnly, async (req, res) => {
  try {
    if (activeEnrichJobId && enrichJobs.get(activeEnrichJobId) && !enrichJobs.get(activeEnrichJobId).completed) {
      return res.status(409).json({ error: 'Já existe um enriquecimento em andamento', jobId: activeEnrichJobId });
    }

    const body = req.body || {};
    const where = buildEnrichWhere({
      onlyMissing: !!body.onlyMissing,
      category: body.category,
      brand: body.brand,
      productIds: body.productIds,
      source: body.source,
    });

    const products = await prisma.product.findMany({
      where,
      select: { id: true, sku: true, name: true, brand: true, category: true, subcategory: true, aiContext: true },
      orderBy: { updatedAt: 'asc' },
    });

    if (!products.length) {
      return res.status(400).json({ error: 'Nenhum produto encontrado para enriquecer com esses filtros' });
    }

    const jobId = 'enrich_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const job = {
      id: jobId,
      total: products.length,
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [],
      totalCostBRL: 0,
      totalCostUSD: 0,
      completed: false,
      cancelled: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      lastSku: null,
      filters: {
        onlyMissing: !!body.onlyMissing,
        category: body.category || null,
        brand: body.brand || null,
        productIdsCount: Array.isArray(body.productIds) ? body.productIds.length : 0,
      },
    };
    enrichJobs.set(jobId, job);
    activeEnrichJobId = jobId;

    console.log('[enrich] batch start jobId=' + jobId + ' total=' + products.length, job.filters);

    res.json({ jobId, total: products.length });

    setImmediate(async () => {
      try {
        let i = 0;
        while (i < products.length) {
          if (job.cancelled) break;
          const slice = products.slice(i, i + ENRICH_BATCH_CONCURRENCY);
          await Promise.allSettled(slice.map(async (p) => {
            try {
              job.lastSku = p.sku;
              const r = await enrichProductOnce(p);
              job.processed += 1;
              if (r.ok) {
                job.succeeded += 1;
                job.totalCostBRL += r.cost.brl;
                job.totalCostUSD += r.cost.usd;
                console.log(
                  '[enrich] ' + p.sku
                  + ' ok ' + r.cost.ms + 'ms'
                  + ' brl=' + r.cost.brl.toFixed(4),
                );
              } else {
                job.failed += 1;
                job.errors.push({ sku: p.sku, productId: p.id, error: r.error });
                console.warn('[enrich] ' + p.sku + ' fail: ' + r.error);
              }
            } catch (eP) {
              job.processed += 1;
              job.failed += 1;
              job.errors.push({ sku: p.sku, productId: p.id, error: eP.message || 'erro' });
              console.error('[enrich] ' + p.sku + ' throw:', eP);
            }
          }));
          i += ENRICH_BATCH_CONCURRENCY;
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (eAll) {
        console.error('[enrich] batch fatal:', eAll);
      } finally {
        job.completed = true;
        job.finishedAt = new Date().toISOString();
        if (activeEnrichJobId === jobId) activeEnrichJobId = null;
        console.log(
          '[enrich] batch done jobId=' + jobId
          + ' processed=' + job.processed
          + ' succeeded=' + job.succeeded
          + ' failed=' + job.failed
          + ' brl=' + job.totalCostBRL.toFixed(2),
        );
      }
    });
  } catch (err) {
    console.error('[enrich-batch] route error', err);
    res.status(500).json({ error: 'Erro ao iniciar enriquecimento em lote' });
  }
});

router.get('/enrich-status/:jobId', adminOnly, (req, res) => {
  const job = enrichJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json({
    jobId: job.id,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    errorCount: job.errors.length,
    errors: job.errors.slice(-50),
    totalCostBRL: Number(job.totalCostBRL.toFixed(4)),
    totalCostUSD: Number(job.totalCostUSD.toFixed(4)),
    completed: job.completed,
    cancelled: job.cancelled,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastSku: job.lastSku,
    filters: job.filters,
  });
});

router.post('/enrich-cancel', adminOnly, (req, res) => {
  const targetId = String(req.body?.jobId || activeEnrichJobId || '');
  if (!targetId) return res.json({ ok: true, message: 'Nenhum job ativo' });
  const job = enrichJobs.get(targetId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  job.cancelled = true;
  res.json({ ok: true, jobId: targetId });
});

router.post('/products/auto-fill', sellerOrAdmin, async (req, res) => {
  try {
    const sku = String(req.body?.sku || '').trim();
    if (!sku) return res.status(400).json({ error: 'sku é obrigatório' });
    const brandHint = String(req.body?.brand || '').trim();

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(503).json({ error: 'IA indisponível' });

    const client = new Anthropic({ apiKey: key });
    const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

    const userMsg = `Pesquise informações sobre o produto com SKU ou código de modelo: "${sku}"${brandHint ? ` da marca ${brandHint}` : ''}.
Retorne APENAS um objeto JSON válido (sem markdown) com as chaves:
name, brand, category, subcategory, shortDescription, longDescription, features (objeto com specs), recommendedFor (array de strings), notRecommendedFor (array de strings), imageUrls (array de URLs se encontrar), suggestedRetailPrice (número), suggestedSizes (array de {size, stock} com estoques plausíveis).`;

    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];

    let textOut = '';
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'Você é especialista em calçados e artigos esportivos. Use web_search quando necessário. Responda somente JSON válido.',
        messages: [{ role: 'user', content: userMsg }],
        tools,
      });
      const blocks = resp.content || [];
      textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    } catch (e1) {
      console.warn('auto-fill web_search falhou, tentando sem web:', e1.message);
      const resp = await client.messages.create({
        model,
        max_tokens: 1500,
        system:
          'Você é especialista em calçados e artigos esportivos. Com base no SKU e marca, sugira dados plausíveis. Responda somente JSON válido.',
        messages: [{ role: 'user', content: userMsg }],
      });
      const blocks = resp.content || [];
      textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }

    let json = null;
    const m = textOut.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        json = JSON.parse(m[0]);
      } catch {
        json = null;
      }
    }
    if (!json) return res.status(422).json({ error: 'Não foi possível interpretar a resposta da IA', raw: textOut.slice(0, 500) });

    res.json({ fill: json, sku });
  } catch (err) {
    console.error('auto-fill', err);
    res.status(500).json({ error: 'Erro no auto-preenchimento' });
  }
});

module.exports = router;
