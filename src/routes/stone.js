'use strict';

// =====================================================================
// /api/stone — maquininha Stone integrada (Connect 2.0)
// =====================================================================
// POST /webhook/:token        Stone/Pagar.me avisa pagamento (sem login; token na URL
//                             identifica a loja; o pedido é RE-CONSULTADO na API)
// GET  /status/:saleId        PDV acompanha o pagamento (e auto-cura se o webhook falhar)
// POST /cancel/:saleId        cancela o pedido na maquininha (só se ainda não pagou)
// GET  /admin/stores          configuração por loja (admin)
// POST /admin/stores/:id      salva chave / serial / liga-desliga (admin)
// POST /admin/stores/:id/test confere se a chave funciona (admin)
// =====================================================================

const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const stone = require('../services/stoneConnect');
const stonePos = require('../services/stonePos');

const router = express.Router();

function publicBase() { return process.env.PUBLIC_BASE_URL || 'https://teniscash.com.br'; }

router.post('/webhook/:token', async (req, res) => {
  res.json({ received: true }); // responde rápido; processa em seguida
  try {
    await stonePos.ensureSchema();
    const cfg = await prisma.stoneConfig.findUnique({ where: { webhookToken: String(req.params.token || '') } });
    if (!cfg) { console.warn('[stone webhook] token desconhecido'); return; }
    const p = req.body || {};
    const d = p.data || {};
    const orderId = (d.order && d.order.id) || (String(d.id || '').startsWith('or_') ? d.id : null);
    if (!orderId) { console.warn('[stone webhook] sem pedido', p.type, String(d.id || '')); return; }
    const row = await prisma.stonePosOrder.findUnique({ where: { orderId: String(orderId) } });
    if (!row || row.storeId !== cfg.storeId) {
      console.warn('[stone webhook] pedido fora do sistema (venda avulsa na maquininha?)', { type: p.type, orderId, store: cfg.storeId });
      return;
    }
    await stonePos.confirmAndEmit(row, 'webhook:' + (p.type || '?'));
  } catch (e) {
    console.error('[stone webhook] erro:', e.message);
  }
});

router.get('/status/:saleId', authMiddleware, async (req, res) => {
  try {
    const row = await stonePos.findOrderForSale(req.params.saleId);
    if (!row) return res.status(404).json({ error: 'Venda sem pedido na maquininha' });
    let result = null;
    if (row.status === 'open' || (row.status === 'paid' && !row.fiscalDocumentId)) {
      result = await stonePos.confirmAndEmit(row, 'poll').catch((e) => ({ paid: false, error: e.message }));
    }
    const fresh = await prisma.stonePosOrder.findUnique({ where: { id: row.id } });
    const doc = await prisma.fiscalDocument.findFirst({ where: { saleId: row.saleId, docType: 'NFCE', status: 'authorized' }, orderBy: { createdAt: 'desc' } });
    res.json({
      status: fresh.status,
      paid: fresh.status === 'paid',
      amountCents: fresh.amountCents,
      paidCents: fresh.paidCents,
      brand: fresh.brand,
      authCode: fresh.authCode,
      installments: fresh.paidInstallments || fresh.installments,
      cupom: doc ? { documentId: doc.id, number: doc.number, accessKey: doc.accessKey } : null,
      error: (result && result.error) || (fresh.status === 'paid' && !doc ? fresh.lastError : null),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/cancel/:saleId', authMiddleware, async (req, res) => {
  try {
    const row = await stonePos.findOrderForSale(req.params.saleId);
    if (!row) return res.status(404).json({ error: 'Venda sem pedido na maquininha' });
    if (row.status !== 'open') return res.status(409).json({ error: 'Pedido já está ' + row.status });
    const r = await stonePos.cancelPosOrder(row);
    if (r.paid) return res.status(409).json({ paid: true, error: 'O cliente já pagou — o cupom vai sair. Para desfazer, estorne na maquininha.' });
    res.json({ ok: true, canceled: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ----------------------------- Configuração (admin) -----------------------------

function view(store, cfg) {
  return {
    id: store.id, code: store.code, name: store.name,
    enabled: !!(cfg && cfg.enabled),
    hasKey: !!(cfg && cfg.secretKey),
    keyMasked: cfg && cfg.secretKey ? '••••' + cfg.secretKey.slice(-4) : '',
    serviceRefererName: (cfg && cfg.serviceRefererName) || '',
    deviceSerials: (cfg && cfg.deviceSerials) || '',
    webhookUrl: cfg ? publicBase() + '/api/stone/webhook/' + cfg.webhookToken : '',
    ready: stone.isConfigured(cfg) && !!stone.serviceRefererName(cfg),
  };
}

router.get('/admin/stores', authMiddleware, adminMiddleware, async (_req, res) => {
  try {
    await stonePos.ensureSchema();
    const [stores, cfgs] = await Promise.all([
      prisma.store.findMany({ where: { active: true }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } }),
      prisma.stoneConfig.findMany(),
    ]);
    const byStore = new Map(cfgs.map((c) => [c.storeId, c]));
    res.json({ envServiceReferer: !!process.env.STONE_SERVICE_REFERER_NAME, stores: stores.map((s) => view(s, byStore.get(s.id))) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/stores/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await stonePos.ensureSchema();
    const store = await prisma.store.findUnique({ where: { id: req.params.id }, select: { id: true, code: true, name: true } });
    if (!store) return res.status(404).json({ error: 'Loja não encontrada' });
    const { secretKey, serviceRefererName, deviceSerials, enabled } = req.body || {};
    const data = {};
    if (typeof secretKey === 'string' && secretKey.trim()) {
      if (!/^sk_[A-Za-z0-9_]+$/.test(secretKey.trim())) return res.status(400).json({ error: 'A Secret Key da Stone começa com "sk_".' });
      data.secretKey = secretKey.trim();
    }
    if (typeof serviceRefererName === 'string') data.serviceRefererName = serviceRefererName.trim() || null;
    if (typeof deviceSerials === 'string') data.deviceSerials = stone.parseSerials(deviceSerials).join(',') || null;
    if (typeof enabled === 'boolean') data.enabled = enabled;
    const current = await prisma.stoneConfig.findUnique({ where: { storeId: store.id } });
    const merged = { ...(current || {}), ...data };
    if (merged.enabled && !stone.isConfigured(merged)) {
      return res.status(400).json({ error: 'Para ligar, preencha a Secret Key e o número de série da maquininha.' });
    }
    const cfg = await prisma.stoneConfig.upsert({
      where: { storeId: store.id },
      create: { storeId: store.id, webhookToken: stone.newWebhookToken(), ...data },
      update: data,
    });
    res.json({ ok: true, store: view(store, cfg) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/stores/:id/test', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const cfg = await stonePos.loadConfig(req.params.id);
    if (!cfg || !cfg.secretKey) return res.status(400).json({ error: 'Salve a Secret Key primeiro.' });
    await stone.stoneFetch(cfg, '/core/v5/orders?size=1');
    res.json({ ok: true, message: 'Chave aceita pela Stone/Pagar.me.' });
  } catch (e) { res.status(e.status === 401 ? 400 : 502).json({ error: e.status === 401 ? 'Chave recusada pela Stone (401). Confira a Secret Key.' : e.message }); }
});

module.exports = router;
