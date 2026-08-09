// =====================================================================
// Routes: /api/product-request — cadastro de produto pela loja (PDV)
// =====================================================================
// O vendedor registra um produto que o sistema NÃO achou (bipe sem cadastro
// ou não aparece na busca). Fica gravado pro DONO revisar e resolver depois.
// O vendedor SÓ cadastra e vê os SEUS registros com status neutro — nunca vê
// a resolução (o que será feito). Revisão/resolução é admin.
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');

const router = express.Router();
router.use(authMiddleware);

function sellerOnly(req, res, next) {
  if (!['seller', 'store', 'admin', 'superadmin', 'manager'].includes(req.userRole)) {
    return res.status(403).json({ error: 'Acesso restrito ao vendedor / loja' });
  }
  next();
}

async function actorStoreIds(userId) {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { storeId: true, storeIds: true, role: true } });
  if (!u) return { ids: [], role: null };
  const ids = [...new Set([...(u.storeIds || []), ...(u.storeId ? [u.storeId] : [])])];
  return { ids, role: u.role };
}

async function resolveSeller(sellerId, storeId, fallbackUserId) {
  const id = String(sellerId || '').trim();
  if (!id) return fallbackUserId;
  const u = await prisma.user.findUnique({ where: { id }, select: { id: true, storeId: true, storeIds: true } });
  if (!u) return fallbackUserId;
  const belongs = (u.storeIds || []).includes(storeId) || u.storeId === storeId;
  return belongs ? u.id : fallbackUserId;
}

// Vendedor NÃO vê a resolução — status vira rótulo neutro.
function publicRequest(r) {
  const statusLabel = r.status === 'resolved' ? 'resolvido' : r.status === 'dismissed' ? 'encerrado' : 'em análise';
  return {
    id: r.id, code: r.code, statusLabel,
    barcode: r.barcode || null, name: r.name || null, brand: r.brand || null, size: r.size || null,
    quantity: r.quantity, note: r.note || null,
    createdByName: r.createdBy ? r.createdBy.name : null,
    createdAt: r.createdAt,
  };
}

async function nextCode(tx) {
  const max = await tx.productRegistrationRequest.aggregate({ _max: { code: true } });
  return (max._max.code || 2000) + 1;
}

// Criar cadastro (vendedor).
router.post('/', sellerOnly, async (req, res) => {
  try {
    const { storeId, barcode, name, brand, size, quantity, note, sellerId, photoUrl } = req.body || {};
    if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
    if (!barcode && !name) return res.status(400).json({ error: 'Informe pelo menos o código de barras OU o nome do produto.' });
    const { ids, role } = await actorStoreIds(req.userId);
    const isPrivileged = ['admin', 'superadmin', 'manager'].includes(role);
    if (!isPrivileged && ids.length && !ids.includes(String(storeId))) {
      return res.status(403).json({ error: 'Você não atua nesta loja.' });
    }
    const createdById = await resolveSeller(sellerId, String(storeId), req.userId);
    const qty = Math.max(1, Math.trunc(Number(quantity) || 1));
    const created = await prisma.$transaction(async (tx) => {
      const code = await nextCode(tx);
      return tx.productRegistrationRequest.create({
        data: {
          code, storeId: String(storeId), createdById,
          barcode: barcode ? String(barcode).trim().slice(0, 60) : null,
          name: name ? String(name).trim().slice(0, 200) : null,
          brand: brand ? String(brand).trim().slice(0, 100) : null,
          size: size ? String(size).trim().slice(0, 30) : null,
          quantity: qty,
          note: note ? String(note).trim().slice(0, 400) : null,
          photoUrl: photoUrl ? String(photoUrl).slice(0, 500000) : null,
          status: 'pending',
        },
        include: { createdBy: { select: { name: true } } },
      });
    });
    res.json({ ok: true, request: publicRequest(created) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Os cadastros DESTA loja (vendedor vê os seus, status neutro).
router.get('/mine', sellerOnly, async (req, res) => {
  try {
    const storeId = String(req.query.storeId || '');
    if (!storeId) return res.status(400).json({ error: 'storeId obrigatório' });
    const rows = await prisma.productRegistrationRequest.findMany({
      where: { storeId },
      include: { createdBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
    res.json({ requests: rows.map(publicRequest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===================== ADMIN (revisão do dono) =====================
router.get('/admin/list', adminMiddleware, async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    const rows = await prisma.productRegistrationRequest.findMany({
      where: status === 'all' ? {} : { status },
      include: { createdBy: { select: { name: true } }, store: { select: { name: true, code: true } }, resolvedBy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, take: 300,
    });
    res.json({ requests: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/:id/resolve', adminMiddleware, async (req, res) => {
  try {
    const { action, note, productId } = req.body || {};
    const status = action === 'dismiss' ? 'dismissed' : 'resolved';
    const r = await prisma.productRegistrationRequest.update({
      where: { id: req.params.id },
      data: { status, resolvedById: req.userId, resolvedNote: note ? String(note).slice(0, 400) : null, productId: productId || null, resolvedAt: new Date() },
    });
    res.json({ ok: true, id: r.id, status: r.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
