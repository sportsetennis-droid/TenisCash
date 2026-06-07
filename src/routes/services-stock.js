// =====================================================================
// SERVIÇOS — ESTOQUE AVANÇADO (KEY=stock)
// ---------------------------------------------------------------------
// Parity AppBarber: alerta de baixa, validade, custo x lucro, histórico
// de movimentação. Trabalha sobre VenueProduct (EXISTENTE) + tabela nova
// StockMovement (additiva). Colunas additivas em VenueProduct: minStock,
// expiresAt (o orchestrator aplica via scripts/_parity/stock.json).
//
// Mesmo padrão de services.js: ownedVenue (posse do dono), wrap, round2,
// timezone America/Fortaleza (UTC-3 fixo) via TZ_OFFSET_MIN + localToUtc,
// e o "hoje" copiado de /cash e /report.
// =====================================================================

const express = require('express');
const { prisma, authMiddleware } = require('../middleware');

const router = express.Router();

// América/Fortaleza = UTC-3 fixo, sem horário de verão (regra CLAUDE.md).
const TZ_OFFSET_MIN = -180;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[services-stock]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  });

// (dia local 'YYYY-MM-DD', minuto do dia) → instante UTC. Idêntico ao services.js.
function localToUtc(dateStr, minOfDay) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - TZ_OFFSET_MIN * 60000 + minOfDay * 60000);
}

// "hoje" no fuso local — MESMO approach dos endpoints /cash e /report (mesmo sinal).
function todayLocalStr() {
  return new Date(Date.now() + TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

// Posse do estabelecimento (idêntico ao services.js).
async function ownedVenue(req, res) {
  const v = await prisma.serviceVenue.findUnique({ where: { id: req.params.id } });
  if (!v) {
    res.status(404).json({ error: 'Estabelecimento não encontrado' });
    return null;
  }
  if (v.ownerUserId !== req.userId) {
    res.status(403).json({ error: 'Sem permissão' });
    return null;
  }
  return v;
}

const MOVE_TYPES = ['in', 'out', 'adjust'];

// =====================================================================
// MOVIMENTAÇÃO — aplica no VenueProduct.stock + grava StockMovement
//   in     → increment(qty)
//   out    → decrement(qty) (não deixa negativo)
//   adjust → set(qty) (contagem/acerto)
// =====================================================================
router.post(
  '/venues/:id/stock/movement',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    const type = String(b.type || '').toLowerCase();
    const qty = Math.trunc(Number(b.qty));
    if (!b.venueProductId) return res.status(400).json({ error: 'venueProductId obrigatório' });
    if (!MOVE_TYPES.includes(type)) return res.status(400).json({ error: 'type deve ser in|out|adjust' });
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: 'qty inválida' });
    if (type !== 'adjust' && qty <= 0) return res.status(400).json({ error: 'qty deve ser > 0' });

    const prod = await prisma.venueProduct.findFirst({ where: { id: String(b.venueProductId), venueId: v.id } });
    if (!prod) return res.status(404).json({ error: 'Produto não encontrado' });

    const out = await prisma.$transaction(
      async (tx) => {
        let newStock;
        if (type === 'in') newStock = (prod.stock || 0) + qty;
        else if (type === 'out') newStock = Math.max(0, (prod.stock || 0) - qty);
        else newStock = qty; // adjust: define o valor exato
        const updated = await tx.venueProduct.update({ where: { id: prod.id }, data: { stock: newStock } });
        const movement = await tx.stockMovement.create({
          data: {
            venueId: v.id,
            venueProductId: prod.id,
            type,
            qty,
            reason: b.reason || null,
            createdById: req.userId,
          },
        });
        return { updated, movement };
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.status(201).json({ movement: out.movement, product: out.updated });
  })
);

// =====================================================================
// HISTÓRICO de movimentações (recentes)
// =====================================================================
router.get(
  '/venues/:id/stock/movements',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const where = { venueId: v.id };
    if (req.query.venueProductId) where.venueProductId = String(req.query.venueProductId);
    const movements = await prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    // anexa nome do produto pra UI não precisar de 2ª request
    const prodIds = [...new Set(movements.map((m) => m.venueProductId))];
    const prods = await prisma.venueProduct.findMany({
      where: { id: { in: prodIds } },
      select: { id: true, name: true },
    });
    const nameById = Object.fromEntries(prods.map((p) => [p.id, p.name]));
    res.json(movements.map((m) => ({ ...m, productName: nameById[m.venueProductId] || '—' })));
  })
);

// =====================================================================
// ALERTAS — estoque baixo (stock <= minStock, minStock>0) OU validade
//           vencida/próxima (até 30 dias).
// =====================================================================
router.get(
  '/venues/:id/stock/alerts',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const products = await prisma.venueProduct.findMany({
      where: { venueId: v.id, active: true },
      orderBy: { name: 'asc' },
    });
    const horizon = new Date(Date.now() + 30 * 86400000); // próximos 30 dias
    const now = new Date();

    const lowStock = [];
    const expiring = [];
    for (const p of products) {
      if ((p.minStock || 0) > 0 && (p.stock || 0) <= p.minStock) {
        lowStock.push({ id: p.id, name: p.name, stock: p.stock || 0, minStock: p.minStock });
      }
      if (p.expiresAt) {
        const exp = new Date(p.expiresAt);
        if (exp <= horizon) {
          expiring.push({
            id: p.id,
            name: p.name,
            expiresAt: p.expiresAt,
            expired: exp < now,
            stock: p.stock || 0,
          });
        }
      }
    }
    res.json({
      lowStockCount: lowStock.length,
      expiringCount: expiring.length,
      lowStock,
      expiring,
    });
  })
);

// =====================================================================
// LUCRO — por produto (price, cost, margem absoluta e %) + totais.
// margem% = (price-cost)/price*100 quando price>0.
// =====================================================================
router.get(
  '/venues/:id/stock/profit',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const products = await prisma.venueProduct.findMany({
      where: { venueId: v.id, active: true },
      orderBy: { name: 'asc' },
    });
    const items = products.map((p) => {
      const price = round2(p.price);
      const cost = round2(p.cost);
      const margin = round2(price - cost);
      const marginPct = price > 0 ? round2((margin / price) * 100) : 0;
      const stock = p.stock || 0;
      return {
        id: p.id,
        name: p.name,
        price,
        cost,
        margin,
        marginPct,
        stock,
        stockCostValue: round2(cost * stock),
        stockSaleValue: round2(price * stock),
        potentialProfit: round2(margin * stock),
      };
    });
    const totals = {
      stockCostValue: round2(items.reduce((a, i) => a + i.stockCostValue, 0)),
      stockSaleValue: round2(items.reduce((a, i) => a + i.stockSaleValue, 0)),
      potentialProfit: round2(items.reduce((a, i) => a + i.potentialProfit, 0)),
    };
    res.json({ count: items.length, items, totals });
  })
);

// =====================================================================
// CONFIG — define minStock e/ou expiresAt num VenueProduct (do venue).
// =====================================================================
router.patch(
  '/venues/:id/stock/config/:pid',
  authMiddleware,
  wrap(async (req, res) => {
    const v = await ownedVenue(req, res);
    if (!v) return;
    const b = req.body || {};
    const data = {};
    if (b.minStock !== undefined) {
      const ms = Math.trunc(Number(b.minStock));
      if (!Number.isFinite(ms) || ms < 0) return res.status(400).json({ error: 'minStock inválido' });
      data.minStock = ms;
    }
    if (b.expiresAt !== undefined) {
      if (b.expiresAt === null || b.expiresAt === '') {
        data.expiresAt = null;
      } else {
        // aceita 'YYYY-MM-DD' (interpreta no fuso local) ou ISO completo
        const s = String(b.expiresAt);
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? localToUtc(s, 0) : new Date(s);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'expiresAt inválido' });
        data.expiresAt = d;
      }
    }
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar (minStock e/ou expiresAt)' });
    const r = await prisma.venueProduct.updateMany({ where: { id: req.params.pid, venueId: v.id }, data });
    if (!r.count) return res.status(404).json({ error: 'Produto não encontrado' });
    const prod = await prisma.venueProduct.findUnique({ where: { id: req.params.pid } });
    res.json(prod);
  })
);

module.exports = router;
