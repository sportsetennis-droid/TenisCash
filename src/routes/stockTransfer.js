// =====================================================================
// Routes: /api/stock-transfer — transferência de produto entre lojas (PDV)
// =====================================================================
// Executada pelo VENDEDOR. Espelha o fluxo de venda: monta itens (bipe),
// escolhe destino, confirma. A loja destino confirma o recebimento.
// NENHUMA resposta aqui expõe custo nem a nota fiscal (regra do dono).
// =====================================================================

const express = require('express');
const { authMiddleware, prisma } = require('../middleware');
const svc = require('../services/stockTransfer');
const { SaleStockError } = require('../services/storeStockLedger');

const router = express.Router();
router.use(authMiddleware);

function sellerOnly(req, res, next) {
  if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor / loja' });
  }
  next();
}

// Lojas do usuário logado (pra validar origem/destino do vendedor).
async function actorStoreIds(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { storeId: true, storeIds: true, role: true } });
  if (!u) return { ids: [], role: null };
  const ids = [...new Set([...(u.storeIds || []), ...(u.storeId ? [u.storeId] : [])])];
  return { ids, role: u.role };
}

// Só expõe campos seguros (sem custo, sem nota) — usado em toda listagem.
function publicTransfer(t) {
  return {
    id: t.id, code: t.code, status: t.status,
    fromStoreId: t.fromStoreId, fromStore: t.fromStore ? { id: t.fromStore.id, name: t.fromStore.name, code: t.fromStore.code } : null,
    toStoreId: t.toStoreId, toStore: t.toStore ? { id: t.toStore.id, name: t.toStore.name, code: t.toStore.code } : null,
    itemsCount: t.itemsCount, qtyTotal: t.qtyTotal, note: t.note || null,
    createdByName: t.createdBy ? t.createdBy.name : null,
    receivedByName: t.receivedBy ? t.receivedBy.name : null,
    createdAt: t.createdAt, receivedAt: t.receivedAt || null, cancelledAt: t.cancelledAt || null,
    items: (t.items || []).map((i) => ({ productName: i.productName, brand: i.brand, size: i.size, barcode: i.barcode, quantity: i.quantity })),
  };
}

// Valida que o sellerId escolhido é um vendedor daquela loja (senão cai no operador logado).
async function resolveSeller(sellerId, storeId, fallbackUserId) {
  const id = String(sellerId || '').trim();
  if (!id) return fallbackUserId;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, storeId: true, storeIds: true } });
  if (!u) return fallbackUserId;
  const belongs = (u.storeIds || []).includes(storeId) || u.storeId === storeId;
  return belongs ? u.id : fallbackUserId;
}

const err = (res, e) => res.status(e instanceof SaleStockError ? (e.statusCode || 400) : 500).json({ error: e.message });

// Destinos possíveis: outras lojas ativas (menos a de origem).
router.get('/stores', sellerOnly, async (req, res) => {
  try {
    const fromStoreId = String(req.query.fromStoreId || '');
    const stores = await prisma.store.findMany({ where: { active: true, id: { not: fromStoreId || undefined } }, select: { id: true, name: true, code: true }, orderBy: { code: 'asc' } });
    res.json({ stores });
  } catch (e) { err(res, e); }
});

// Criar transferência (origem = loja do vendedor).
router.post('/', sellerOnly, async (req, res) => {
  try {
    const { fromStoreId, toStoreId, items, note, sellerId } = req.body || {};
    const { ids, role } = await actorStoreIds(req.userId);
    const isPrivileged = ['admin', 'superadmin', 'manager'].includes(role);
    if (!isPrivileged && ids.length && !ids.includes(String(fromStoreId))) {
      return res.status(403).json({ error: 'Você não atua na loja de origem informada.' });
    }
    // Quem está transferindo (vendedor escolhido na tela); valida que é da loja origem.
    const createdById = await resolveSeller(sellerId, String(fromStoreId || ''), req.userId);
    const t = await svc.createTransfer({ fromStoreId: String(fromStoreId || ''), toStoreId: String(toStoreId || ''), items, createdById, note });
    res.json({ ok: true, transfer: publicTransfer(t) });
  } catch (e) { err(res, e); }
});

// Transferências CHEGANDO na loja (pra aceitar) — status in_transit.
router.get('/incoming', sellerOnly, async (req, res) => {
  try {
    const storeId = String(req.query.storeId || '');
    if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
    const rows = await prisma.stockTransfer.findMany({
      where: { toStoreId: storeId, status: 'in_transit' },
      include: { items: true, fromStore: true, toStore: true, createdBy: { select: { name: true } }, receivedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    res.json({ transfers: rows.map(publicTransfer) });
  } catch (e) { err(res, e); }
});

// Transferências que a loja ENVIOU (histórico + status).
router.get('/outgoing', sellerOnly, async (req, res) => {
  try {
    const storeId = String(req.query.storeId || '');
    if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
    const rows = await prisma.stockTransfer.findMany({
      where: { fromStoreId: storeId },
      include: { items: true, fromStore: true, toStore: true, createdBy: { select: { name: true } }, receivedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    res.json({ transfers: rows.map(publicTransfer) });
  } catch (e) { err(res, e); }
});

// Aceitar recebimento (loja destino).
router.post('/:id/receive', sellerOnly, async (req, res) => {
  try {
    const { ids, role } = await actorStoreIds(req.userId);
    const scoped = ['admin', 'superadmin', 'manager'].includes(role) ? null : ids;
    // Quem está recebendo (vendedor escolhido); valida contra a loja destino da transferência.
    const t0 = await prisma.stockTransfer.findUnique({ where: { id: req.params.id }, select: { toStoreId: true } });
    const receivedById = await resolveSeller(req.body?.sellerId, t0?.toStoreId || '', req.userId);
    const t = await svc.receiveTransfer({ transferId: req.params.id, receivedById, actorStoreIds: scoped });
    res.json({ ok: true, transfer: publicTransfer(t) });
  } catch (e) { err(res, e); }
});

// Cancelar (enquanto em trânsito).
router.post('/:id/cancel', sellerOnly, async (req, res) => {
  try {
    const { ids, role } = await actorStoreIds(req.userId);
    const scoped = ['admin', 'superadmin', 'manager'].includes(role) ? null : ids;
    const t = await svc.cancelTransfer({ transferId: req.params.id, actorStoreIds: scoped });
    res.json({ ok: true, transfer: publicTransfer(t) });
  } catch (e) { err(res, e); }
});

module.exports = router;
