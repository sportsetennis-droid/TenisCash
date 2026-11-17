// =====================================================================
// Busca de produto tolerante a erro de digitação (vendedor/admin).
// ---------------------------------------------------------------------
// - Com a extensão pg_trgm: cada palavra digitada precisa "parecer" com
//   alguma palavra do nome, da marca ou da referência (word_similarity),
//   então "asics nimbu" acha "GEL-NIMBUS" e "chutera kapa" acha
//   "CHUTEIRA KAPPA". Parte de EAN (4+ dígitos) acha pelo código de barras.
// - Sem pg_trgm (permissão negada no banco): cai num LIKE por palavra.
//   Não quebra; só deixa de perdoar erro de digitação.
// - Acento: o mesmo translate() que src/routes/catalog.js já usa (não
//   depende da extensão unaccent). As expressões abaixo são IGUAIS às dos
//   índices GIN criados em ensureApexSchema.js — se mudar uma, mude a outra.
// - Estoque devolvido = físico localizado (Σ StoreStock > 0) por loja. Nunca
//   o comprado (ProductSize.stock) e nunca custo.
// - "SEM GTIN" não é código de barras: nunca entra em busca nem resposta.
// =====================================================================

const ACCENT_FROM = 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ';
const ACCENT_TO = 'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn';

// Expressão SQL "dobrada" (minúscula, sem acento). Literal fixo: precisa
// bater byte a byte com a expressão do índice pro planner usar o índice.
function foldSql(col) {
  return `translate(lower(coalesce(${col},'')), '${ACCENT_FROM}', '${ACCENT_TO}')`;
}
const F_NAME = foldSql('p."name"');
const F_BRAND = foldSql('p."brand"');
const F_SKU = foldSql('p."sku"');
const F_COLOR = foldSql(`p."aiContext"->>'color'`);

// Índices (usados por ensureApexSchema). Mesma expressão, sem o alias "p.".
const SEARCH_INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING gin ((${foldSql('"name"')}) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "Product_brand_trgm_idx" ON "Product" USING gin ((${foldSql('"brand"')}) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "Product_sku_trgm_idx" ON "Product" USING gin ((${foldSql('"sku"')}) gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "ProductSize_barcode_trgm_idx" ON "ProductSize" USING gin ("barcode" gin_trgm_ops)`,
];

const NO_BARCODE = 'SEM GTIN';
const WORD_THRESHOLD = 0.5; // 0..1 — "chutera"→"chuteira" ≈ 0.75, "nimbu"→"nimbus" ≈ 0.83

function foldText(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Quebra a busca em palavras úteis. Tira curinga de LIKE e pontuação solta.
function tokenize(q) {
  const folded = foldText(q).replace(/[%_\\]/g, ' ').replace(/[^a-z0-9./-]+/g, ' ').trim();
  const words = folded.split(/\s+/).filter(Boolean).slice(0, 8);
  return [...new Set(words)];
}

function realBarcode(code) {
  const c = String(code || '').trim();
  if (!c || c.toUpperCase() === NO_BARCODE) return null;
  return c;
}

// Foto em base64 no banco pode ter MBs: não vai na busca (a tela mostra o ícone).
function lightImage(url) {
  const u = String(url || '');
  if (!u || u.startsWith('data:') || u.length > 1000) return null;
  return u;
}

let trgmCache = { at: 0, value: null };
async function hasTrgm(prisma) {
  if (process.env.SEARCH_FORCE_FALLBACK === '1') return false;
  const now = Date.now();
  if (trgmCache.value !== null && now - trgmCache.at < 5 * 60 * 1000) return trgmCache.value;
  try {
    const rows = await prisma.$queryRawUnsafe(`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm' LIMIT 1`);
    trgmCache = { at: now, value: rows.length > 0 };
  } catch (_) {
    trgmCache = { at: now, value: false };
  }
  return trgmCache.value;
}
function resetTrgmCache() { trgmCache = { at: 0, value: null }; }

// Monta o SQL da busca. Parâmetros posicionais ($1..$n) — nada do usuário
// é concatenado no texto do SQL.
function buildSearchSql(tokens, { trgm, limit, digits }) {
  const params = [];
  const p = (v) => { params.push(v); return '$' + params.length; };
  const filters = [];
  const scores = [];
  for (const t of tokens) {
    const like = p('%' + t + '%');
    if (trgm && t.length >= 3) {
      const tp = p(t);
      filters.push(`(${tp} <% ${F_NAME} OR ${tp} <% ${F_BRAND} OR ${tp} <% ${F_SKU} OR ${F_NAME} LIKE ${like} OR ${F_SKU} LIKE ${like})`);
      scores.push(`greatest(word_similarity(${tp}, ${F_NAME}), word_similarity(${tp}, ${F_BRAND}), word_similarity(${tp}, ${F_SKU}), word_similarity(${tp}, ${F_COLOR}) * 0.6)`);
    } else if (t.length >= 3 || /^\d+$/.test(t)) {
      filters.push(`(${F_NAME} LIKE ${like} OR ${F_BRAND} LIKE ${like} OR ${F_SKU} LIKE ${like} OR ${F_COLOR} LIKE ${like})`);
      scores.push(`(CASE WHEN ${F_NAME} LIKE ${like} OR ${F_BRAND} LIKE ${like} OR ${F_SKU} LIKE ${like} THEN 1 ELSE 0 END)`);
    } else {
      // palavra de 1-2 letras ("gt", "x"): não filtra, só ajuda a ordenar
      scores.push(`(CASE WHEN ${F_NAME} LIKE ${like} THEN 0.3 ELSE 0 END)`);
    }
  }
  let barcodeClause = 'FALSE';
  let barcodeScore = '0';
  if (digits) {
    const dl = p('%' + digits + '%');
    const de = p(digits);
    barcodeClause = `EXISTS (SELECT 1 FROM "ProductSize" ps WHERE ps."productId" = p."id" AND ps."barcode" <> '${NO_BARCODE}' AND ps."barcode" LIKE ${dl})`;
    barcodeScore = `(CASE WHEN EXISTS (SELECT 1 FROM "ProductSize" ps WHERE ps."productId" = p."id" AND ps."barcode" = ${de}) THEN 10
                     WHEN ${barcodeClause} THEN 3 ELSE 0 END)`;
  }
  const textClause = filters.length ? filters.join(' AND ') : 'FALSE';
  const scoreExpr = `(${scores.length ? scores.join(' + ') : '0'}) + ${barcodeScore}`;
  const lim = p(limit);
  const sql = `SELECT p."id", p."name", p."brand", p."sku", p."price", p."promoPrice", p."imageUrl",
      p."aiContext"->>'color' AS "color", ${scoreExpr} AS "score"
    FROM "Product" p
    WHERE p."active" = true AND ((${textClause}) OR ${barcodeClause})
    ORDER BY "score" DESC, p."name" ASC
    LIMIT ${lim}`;
  return { sql, params };
}

async function searchProducts(prisma, q, { limit = 20 } = {}) {
  const raw = String(q || '').trim().slice(0, 120);
  const tokens = tokenize(raw);
  const digitsOnly = raw.replace(/\D/g, '');
  const digits = /^[\d\s.-]+$/.test(raw) && digitsOnly.length >= 4 ? digitsOnly : null;
  if (!tokens.length && !digits) return { mode: 'empty', products: [] };
  const lim = Math.max(1, Math.min(50, Number(limit) || 20));
  const trgm = await hasTrgm(prisma);
  const { sql, params } = buildSearchSql(tokens, { trgm, limit: lim, digits });
  let rows;
  if (trgm) {
    rows = await prisma.$transaction(async (tx) => {
      // SET LOCAL vale só dentro desta transação (não vaza pro pool).
      await tx.$executeRawUnsafe(`SET LOCAL pg_trgm.word_similarity_threshold = ${WORD_THRESHOLD}`);
      return tx.$queryRawUnsafe(sql, ...params);
    });
  } else {
    rows = await prisma.$queryRawUnsafe(sql, ...params);
  }
  const products = await attachSizes(prisma, rows);
  return { mode: trgm ? 'trgm' : 'like', products };
}

// Tamanhos + estoque físico por loja (Σ StoreStock com saldo > 0).
async function attachSizes(prisma, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const sizes = await prisma.productSize.findMany({
    where: { productId: { in: ids } },
    select: {
      id: true, productId: true, size: true, barcode: true,
      storeStocks: { where: { stock: { gt: 0 } }, select: { storeId: true, stock: true, store: { select: { code: true, name: true } } } },
    },
  });
  const byProduct = new Map();
  for (const s of sizes) {
    if (!byProduct.has(s.productId)) byProduct.set(s.productId, []);
    byProduct.get(s.productId).push({
      id: s.id,
      size: s.size,
      barcode: realBarcode(s.barcode),
      storeStocks: s.storeStocks.map((ss) => ({ storeId: ss.storeId, storeCode: ss.store ? ss.store.code : null, storeName: ss.store ? ss.store.name : null, stock: ss.stock })),
    });
  }
  return rows.map((r) => {
    const list = (byProduct.get(r.id) || []).sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }));
    const physicalStock = list.reduce((sum, s) => sum + s.storeStocks.reduce((a, ss) => a + ss.stock, 0), 0);
    return {
      id: r.id,
      name: r.name,
      brand: r.brand,
      sku: r.sku,
      color: r.color || null,
      price: r.price,
      promoPrice: r.promoPrice,
      imageUrl: lightImage(r.imageUrl),
      score: Math.round(Number(r.score || 0) * 1000) / 1000,
      physicalStock,
      sizes: list,
    };
  });
}

// ---------------------------------------------------------------------
// Snapshot compacto do catálogo pro modo offline do vendedor.
// Formato (arrays pra caber pequeno):
//   { v:1, generatedAt, stores:[[id,code,name]],
//     products:[[id,name,brand,ref,color,price,promoPrice,[[size,barcode,[[storeIdx,qty]]]]]] }
// Sem custo, sem markup, sem comprado. Só ativos.
// ---------------------------------------------------------------------
async function buildCatalogSnapshot(prisma) {
  const [stores, products] = await Promise.all([
    prisma.store.findMany({ select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
    prisma.product.findMany({
      where: { active: true },
      select: {
        id: true, name: true, brand: true, sku: true, price: true, promoPrice: true, aiContext: true,
        sizes: {
          select: { size: true, barcode: true, storeStocks: { where: { stock: { gt: 0 } }, select: { storeId: true, stock: true } } },
        },
      },
      orderBy: { id: 'asc' },
    }),
  ]);
  const storeIdx = new Map(stores.map((s, i) => [s.id, i]));
  const rows = products.map((p) => {
    const color = p.aiContext && typeof p.aiContext === 'object' && typeof p.aiContext.color === 'string' ? p.aiContext.color : null;
    const sizes = p.sizes
      .slice()
      .sort((a, b) => String(a.size).localeCompare(String(b.size), 'pt-BR', { numeric: true }))
      .map((s) => [s.size, realBarcode(s.barcode), s.storeStocks.filter((ss) => storeIdx.has(ss.storeId)).map((ss) => [storeIdx.get(ss.storeId), ss.stock])]);
    return [p.id, p.name, p.brand, p.sku, color, p.price, p.promoPrice, sizes];
  });
  return {
    v: 1,
    stores: stores.map((s) => [s.id, s.code, s.name]),
    products: rows,
  };
}

module.exports = {
  ACCENT_FROM, ACCENT_TO, SEARCH_INDEX_STATEMENTS, NO_BARCODE,
  foldText, tokenize, realBarcode, hasTrgm, resetTrgmCache, buildSearchSql,
  searchProducts, buildCatalogSnapshot,
};
