// =====================================================================
// Routes: Motor de Catálogo — rodar agentes, listar planos, aprovar/executar.
// =====================================================================
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const engine = require('../services/catalogEngine');

const router = express.Router();

// --- Disparo GUARDADO (fora de /api/admin) — só pra testar/rodar por curl/cron externo.
const CATENGINE_GUARD = 'cateng_4b1f9a2e7c';
async function catEngineRunHandler(req, res) {
  if (req.query.g !== CATENGINE_GUARD) return res.status(404).json({ error: 'not found' });
  try {
    if (!engine) return res.status(500).json({ error: 'engine off' });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const mode = req.query.mode || 'quase';
    const out = await engine.runBatch({ limit, mode });
    res.json({ ok: true, ...out, results: out.results.map((r) => ({ id: r.productId, name: (r.name || '').slice(0, 40), score: r.plan?.score, ready: r.plan?.ready, actions: r.plan?.actions, err: r.error })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ===================== ADMIN =====================
router.use(authMiddleware);
router.use(adminMiddleware);

// Resumo: funil de prontidão + contadores de planos.
router.get('/summary', async (_req, res) => {
  try {
    const CLASS = `pr.category IS NOT NULL AND pr.category<>'A CLASSIFICAR' AND pr.subcategory IS NOT NULL AND pr."aiContext"->'classification'->>'modality' IS NOT NULL AND pr."aiContext"->'classification'->>'tier' IS NOT NULL`;
    const f = (await prisma.$queryRawUnsafe(`
      WITH ps AS (SELECT "productId", SUM(stock) c FROM "ProductSize" GROUP BY "productId"),
      loc AS (SELECT pz."productId", SUM(ss.stock) l FROM "StoreStock" ss JOIN "ProductSize" pz ON pz.id=ss."productSizeId" GROUP BY pz."productId")
      SELECT count(*)::int total,
        count(*) FILTER (WHERE ${CLASS})::int classificado,
        count(*) FILTER (WHERE pr."imageUrl" IS NOT NULL)::int com_imagem,
        count(*) FILTER (WHERE COALESCE(ps.c,0)>0 AND COALESCE(loc.l,0) >= 0.8*COALESCE(ps.c,0))::int estoque_ok,
        count(*) FILTER (WHERE (${CLASS}) AND pr."imageUrl" IS NOT NULL AND COALESCE(ps.c,0)>0 AND COALESCE(loc.l,0) >= 0.8*COALESCE(ps.c,0))::int pronto,
        count(*) FILTER (WHERE pr."aiContext"->'catalogPlan' IS NOT NULL)::int com_plano,
        count(*) FILTER (WHERE pr."aiContext"->'catalogPlan'->>'ready' = 'true')::int plano_ready
      FROM "Product" pr LEFT JOIN ps ON ps."productId"=pr.id LEFT JOIN loc ON loc."productId"=pr.id WHERE pr.active`))[0];
    res.json({ funnel: f });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lista de planos (produtos analisados), filtrável.
router.get('/plans', async (req, res) => {
  try {
    const onlyReady = req.query.ready === '1';
    const status = req.query.status || null;
    let where = `pr.active=true AND pr."aiContext"->'catalogPlan' IS NOT NULL`;
    if (onlyReady) where += ` AND pr."aiContext"->'catalogPlan'->>'ready'='true'`;
    if (status) where += ` AND pr."aiContext"->'catalogPlan'->>'status'='${String(status).replace(/'/g, '')}'`;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT pr.id, pr.name, pr.brand, pr.price,
        (pr."aiContext"->'catalogPlan'->>'score')::int score,
        pr."aiContext"->'catalogPlan'->>'ready' ready,
        pr."aiContext"->'catalogPlan'->>'status' status,
        pr."aiContext"->'catalogPlan'->'actions' actions
      FROM "Product" pr WHERE ${where}
      ORDER BY (pr."aiContext"->'catalogPlan'->>'ready'='true') DESC, (pr."aiContext"->'catalogPlan'->>'score')::int DESC NULLS LAST
      LIMIT 300`);
    res.json({ total: rows.length, plans: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plano completo de 1 produto (com re-análise opcional).
router.get('/plan/:id', async (req, res) => {
  try {
    if (req.query.fresh === '1') { const r = await engine.analyzeProduct(req.params.id); return res.json(r); }
    const p = await prisma.product.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, brand: true, price: true, aiContext: true } });
    if (!p) return res.status(404).json({ error: 'não encontrado' });
    let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
    res.json({ productId: p.id, name: p.name, brand: p.brand, price: p.price, plan: ctx.catalogPlan || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roda um lote (admin dispara da tela).
router.post('/run', async (req, res) => {
  try {
    const out = await engine.runBatch({ limit: Math.min(20, Number(req.body?.limit) || 8), mode: req.body?.mode || 'quase' });
    res.json({ ok: true, processed: out.processed, ready: out.ready });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aprova e EXECUTA o que o dono liberou: classificação / preço / publicar.
router.post('/approve/:id', async (req, res) => {
  try {
    const { applyClassification, price, publish } = req.body || {};
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'não encontrado' });
    let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
    const plan = ctx.catalogPlan || {};
    const data = {}; const done = [];

    if (applyClassification && plan.classification?.suggestion) {
      const sg = plan.classification.suggestion;
      data.category = sg.category; data.subcategory = sg.subcategory;
      ctx.classification = { ...(ctx.classification || {}), modality: sg.modality, tier: sg.tier, type: sg.category === 'Calçados' ? 'Tênis' : 'Outro', gender: sg.subcategory, source: 'motor-aprovado', classifiedAt: new Date().toISOString() };
      done.push('classificação aplicada');
    }
    if (typeof price === 'number' && price > 0) { data.price = price; done.push('preço R$' + price); }

    if (plan) { plan.status = 'executed'; plan.executedAt = new Date().toISOString(); }
    ctx.catalogPlan = plan;
    data.aiContext = ctx;
    await prisma.product.update({ where: { id: p.id }, data });

    let published = null;
    if (publish) {
      try {
        const nh = require('../services/nuvemshopHandlers');
        const connection = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
        if (!connection) published = { ok: false, error: 'sem conexão Nuvemshop' };
        else { const r = await nh.pushProductToNuvemshop(p.id, connection); published = r; if (r && (r.ok || r.synced || r.nuvemshopProductId)) done.push('publicado no Nuvemshop'); }
      } catch (e) { published = { ok: false, error: e.message }; }
    }
    res.json({ ok: true, done, published });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.catEngineRunHandler = catEngineRunHandler;
