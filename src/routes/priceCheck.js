// =====================================================================
// /api/price-check — Consulta de Preço GERAL (sem estoque, sem loja)
// =====================================================================
// Tela: public/consulta-precos.html
// Objetivo: vendedor/gerente busca qualquer produto da base e vê o PREÇO.
// NÃO mostra estoque. NÃO mostra loja. NÃO mostra dados fiscais.
// Read-only: nenhum endpoint escreve no banco.
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

// Monta o objeto de saída — SOMENTE campos de exibição + preço. Zero estoque.
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
  };
}

const SELECT = {
  id: true, name: true, brand: true, sku: true,
  price: true, promoPrice: true, imageUrl: true, aiContext: true,
};

// GET /api/price-check?q=termo&limit=60
// Busca por nome, marca, referência (Product.sku) ou código de barras (ProductSize.barcode).
router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);

    if (!q || q.length < 2) {
      return res.json({ products: [], total: 0, hint: 'Digite nome, marca, referência ou bipe o código de barras.' });
    }

    // 1) Busca por texto em Product
    const where = {
      active: true,
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { brand: { contains: q, mode: 'insensitive' } },
        { sku: { contains: q, mode: 'insensitive' } },
      ],
    };
    let products = await prisma.product.findMany({
      where,
      select: SELECT,
      orderBy: { name: 'asc' },
      take: limit,
    });

    // 2) Se nada por texto e o termo parece código de barras → busca por ProductSize.barcode
    if (products.length === 0 && /^\d{6,}$/.test(q)) {
      const sizes = await prisma.productSize.findMany({
        where: { barcode: q },
        select: { product: { select: SELECT } },
        take: 5,
      });
      const seen = new Set();
      for (const s of sizes) {
        if (s.product && s.product.active !== false && !seen.has(s.product.id)) {
          seen.add(s.product.id);
          products.push(s.product);
        }
      }
      // variante sem zeros à esquerda
      if (products.length === 0) {
        const stripped = q.replace(/^0+/, '');
        if (stripped && stripped !== q) {
          const sizes2 = await prisma.productSize.findMany({
            where: { barcode: stripped },
            select: { product: { select: SELECT } },
            take: 5,
          });
          for (const s of sizes2) if (s.product) products.push(s.product);
        }
      }
    }

    res.json({
      products: products.map(toResult),
      total: products.length,
    });
  } catch (err) {
    console.error('[price-check]', err.message);
    res.status(500).json({ error: 'Erro na consulta de preço' });
  }
});

module.exports = router;
