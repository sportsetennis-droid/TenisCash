// =====================================================================
// /api/price-check — Consulta de Preço GERAL (sem estoque, sem loja)
// =====================================================================
// Tela: card "Preços" dentro de public/loja.html (app do VENDEDOR) + consulta-precos.html
// Objetivo: vendedor busca qualquer produto da base e vê PREÇO + ESTOQUE COMPRADO.
// Mostra ESTOQUE (quantidade comprada = soma de ProductSize.stock).
// NUNCA mostra CUSTO (o que pagamos) nem dados fiscais — custo é SÓ no admin (regra do dono).
// Read-only: nenhum endpoint escreve no banco.
//
// Dois modos:
//   1) SEM termo (q vazio)  -> lista TODO o banco (paginado, ordem alfabética)
//   2) COM termo (q >= 2)    -> busca por nome/marca/ref/código de barras
// Em ambos os modos há paginação via ?offset= para "carregar mais".
// =====================================================================

const express = require('express');
const { prisma } = require('../middleware');

const router = express.Router();

function ctxOf(p) {
  try {
    const c = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {});
    return c || {};
  } catch {
    return {};
  }
}

// Monta o objeto de saída — campos de exibição + preço + ESTOQUE comprado. NUNCA custo/fiscal.
function toResult(p) {
  const ctx = ctxOf(p);
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    ref: p.sku || ctx.supplierRef || null,
    color: ctx.color || null,
    price: p.price ?? null,
    promoPrice: p.promoPrice ?? null,
    imageUrl: p.imageUrl || null,
    // estoque comprado = soma dos tamanhos (ProductSize.stock). Quantidade, NÃO custo.
    stock: (p.sizes || []).reduce((a, s) => a + (s.stock || 0), 0),
  };
}

const SELECT = {
  id: true, name: true, brand: true, sku: true,
  price: true, promoPrice: true, imageUrl: true, aiContext: true,
  sizes: { select: { stock: true } }, // só a quantidade — nunca custo
};

// GARANTIA — produto aparece se está ATIVO **OU** tem estoque (>0). Assim qualquer
// mercadoria comprada NUNCA some da busca por causa do status "inativo".
// Insumo (estoque 0 + inativo) continua de fora. Vale pros 2 modos (lista e busca).
const VISIBLE = { OR: [{ active: true }, { sizes: { some: { stock: { gt: 0 } } } }] };

// GET /api/price-check?q=termo&limit=60&offset=0
// - q vazio  -> lista todo o catálogo ativo (paginado)
// - q >= 2   -> busca por nome, marca, referência (Product.sku) ou código de barras
router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // ---------------------------------------------------------------
    // MODO 1 — SEM termo: lista TODO o banco (paginado)
    // ---------------------------------------------------------------
    if (!q || q.length < 2) {
      const where = VISIBLE; // garantia: ativo OU com estoque
      const [total, products] = await Promise.all([
        prisma.product.count({ where }),
        prisma.product.findMany({
          where,
          select: SELECT,
          orderBy: { name: 'asc' },
          skip: offset,
          take: limit,
        }),
      ]);
      return res.json({
        products: products.map(toResult),
        total,
        offset,
        limit,
        hasMore: offset + products.length < total,
        mode: 'all',
      });
    }

    // ---------------------------------------------------------------
    // MODO 2 — COM termo: busca por texto
    // ---------------------------------------------------------------
    // 2a) Busca também por FORNECEDOR: o nome do fornecedor não fica no
    // produto, mora na NFe (XmlFiscalDocument). Cadeia:
    //   Supplier/issuerName ~ q  ->  XmlFiscalDocument  ->  XmlFiscalItem.productId
    // Assim digitar "siker" traz todos os produtos comprados do SIKER,
    // mesmo que a marca esteja "A DEFINIR".
    let supplierProductIds = [];
    try {
      const sups = await prisma.supplier.findMany({
        where: { companyName: { contains: q, mode: 'insensitive' } },
        select: { id: true },
        take: 50,
      });
      const docs = await prisma.xmlFiscalDocument.findMany({
        where: {
          OR: [
            { issuerName: { contains: q, mode: 'insensitive' } },
            ...(sups.length ? [{ supplierId: { in: sups.map(s => s.id) } }] : []),
          ],
        },
        select: { id: true },
        take: 500,
      });
      if (docs.length) {
        const items = await prisma.xmlFiscalItem.findMany({
          where: { fiscalDocumentId: { in: docs.map(d => d.id) }, productId: { not: null } },
          select: { productId: true },
        });
        supplierProductIds = [...new Set(items.map(i => i.productId))];
      }
    } catch (e) {
      console.error('[price-check] busca por fornecedor falhou:', e.message);
    }

    // BUSCA INTELIGENTE: cada palavra (>=2 chars) precisa casar em nome/marca/ref.
    // "bola reebok" => produtos que tenham bola E reebok (qualquer ordem, qualquer campo),
    // não a frase exata. Palavras ANDadas; cada palavra ORada entre nome/marca/ref.
    const termos = q.split(/\s+/).map(t => t.trim()).filter(t => t.length >= 2);
    const termAnd = (termos.length ? termos : [q]).map(t => ({
      OR: [
        { name: { contains: t, mode: 'insensitive' } },
        { brand: { contains: t, mode: 'insensitive' } },
        { sku: { contains: t, mode: 'insensitive' } },
        { category: { contains: t, mode: 'insensitive' } },
        { subcategory: { contains: t, mode: 'insensitive' } },
        { aiContext: { path: ['supplierRef'], string_contains: t } },
        { aiContext: { path: ['color'], string_contains: t } },
        { sizes: { some: { barcode: { contains: t, mode: 'insensitive' } } } },
      ],
    }));
    // produto casa se: (TODAS as palavras batem) OU (veio de fornecedor que casa com a frase)
    const matchOr = [{ AND: termAnd }];
    if (supplierProductIds.length) matchOr.push({ id: { in: supplierProductIds } });

    const where = {
      AND: [VISIBLE, { OR: matchOr }], // garantia + busca inteligente
    };
    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        select: SELECT,
        orderBy: { name: 'asc' },
        skip: offset,
        take: limit,
      }),
    ]);

    // 2b) Se nada por texto e o termo parece código de barras → ProductSize.barcode
    if (total === 0 && offset === 0 && /^\d{6,}$/.test(q)) {
      const found = [];
      const seen = new Set();
      const sizes = await prisma.productSize.findMany({
        where: { barcode: q },
        select: { product: { select: SELECT } },
        take: 5,
      });
      for (const s of sizes) {
        if (s.product && s.product.active !== false && !seen.has(s.product.id)) {
          seen.add(s.product.id);
          found.push(s.product);
        }
      }
      // variante sem zeros à esquerda
      if (found.length === 0) {
        const stripped = q.replace(/^0+/, '');
        if (stripped && stripped !== q) {
          const sizes2 = await prisma.productSize.findMany({
            where: { barcode: stripped },
            select: { product: { select: SELECT } },
            take: 5,
          });
          for (const s of sizes2) {
            if (s.product && !seen.has(s.product.id)) {
              seen.add(s.product.id);
              found.push(s.product);
            }
          }
        }
      }
      return res.json({
        products: found.map(toResult),
        total: found.length,
        offset: 0,
        limit,
        hasMore: false,
        mode: 'barcode',
      });
    }

    res.json({
      products: products.map(toResult),
      total,
      offset,
      limit,
      hasMore: offset + products.length < total,
      mode: 'search',
    });
  } catch (err) {
    console.error('[price-check]', err.message);
    res.status(500).json({ error: 'Erro na consulta de preço' });
  }
});

module.exports = router;
