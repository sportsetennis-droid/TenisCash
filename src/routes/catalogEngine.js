// =====================================================================
// Routes: Motor de Catálogo — rodar agentes, listar planos, aprovar/executar.
// =====================================================================
const express = require('express');
const { authMiddleware, adminMiddleware, prisma } = require('../middleware');
const engine = require('../services/catalogEngine');
const { opsKeyOk } = require('../opsGuard');

const router = express.Router();

// --- Disparo GUARDADO (fora de /api/admin) — só pra testar/rodar por curl/cron externo.
const CATENGINE_GUARD = 'cateng_4b1f9a2e7c';
async function catEngineRunHandler(req, res) {
  if (!opsKeyOk(req, CATENGINE_GUARD)) return res.status(404).json({ error: 'not found' });
  try {
    if (!engine) return res.status(500).json({ error: 'engine off' });
    const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 6));
    const mode = req.query.mode || 'quase';
    const part = Math.max(0, Number(req.query.part) || 0);
    const of = Math.max(1, Number(req.query.of) || 1);
    const out = await engine.runBatch({ limit, mode, part, of });
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

// Lista sugestões de classificação (regra) pendentes de aprovação — pra tela de revisão em lote.
router.get('/suggestions', async (req, res) => {
  try {
    const PAGE = 50;
    const page = Math.max(0, Number(req.query.page) || 0);
    const minConf = Number(req.query.minConf) || 0;
    const cat = (req.query.category || '').replace(/[^A-Za-zÀ-ÿ ]/g, '');
    const onlyImg = req.query.img === '1';
    let where = `pr.active=true
      AND pr."aiContext"->'catalogPlan'->'classification'->'suggestion'->>'category' IS NOT NULL
      AND COALESCE(pr."aiContext"->'catalogPlan'->'classification'->>'classified','false')='false'
      AND (pr.category IS NULL OR pr.category='A CLASSIFICAR' OR pr.subcategory IS NULL OR pr."aiContext"->'classification'->>'modality' IS NULL OR pr."aiContext"->'classification'->>'tier' IS NULL)`;
    if (cat) where += ` AND pr."aiContext"->'catalogPlan'->'classification'->'suggestion'->>'category'='${cat}'`;
    if (minConf) where += ` AND COALESCE((pr."aiContext"->'catalogPlan'->'classification'->>'confidence')::float,0) >= ${minConf}`;
    if (onlyImg) where += ` AND pr."imageUrl" IS NOT NULL`;
    const rows = await prisma.$queryRawUnsafe(`
      SELECT pr.id, pr.name, pr.brand, pr."imageUrl" image,
        pr."aiContext"->'catalogPlan'->'classification'->'suggestion' suggestion,
        (pr."aiContext"->'catalogPlan'->'classification'->>'confidence')::float confidence
      FROM "Product" pr WHERE ${where}
      ORDER BY confidence DESC NULLS LAST, pr.brand NULLS LAST, pr.name LIMIT ${PAGE} OFFSET ${page * PAGE}`);
    const tot = await prisma.$queryRawUnsafe(`SELECT count(*)::int n FROM "Product" pr WHERE ${where}`);
    res.json({ total: tot[0].n, page, pageSize: PAGE, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Aprova classificação em LOTE (o dono revisou/editou). Aplica as 4 nos produtos.
router.post('/approve-bulk', async (req, res) => {
  try {
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.json({ ok: true, applied: 0, published: 0, results: [] });
    const doPublish = !!(req.body && req.body.publish);
    let published = 0, pubCap = 25, conn = null; // trava: no máx 25 publish por requisição (Cloudflare 100s)
    const results = [];
    for (const it of items) {
      try {
        const p = await prisma.product.findUnique({ where: { id: it.id } });
        if (!p) { results.push({ id: it.id, ok: false, err: 'não encontrado' }); continue; }
        const cat = (it.category || '').trim(), sub = (it.subcategory || '').trim();
        const mod = (it.modality || '').trim(), tier = (it.tier || '').trim();
        if (!cat || !sub || !mod || !tier) { results.push({ id: it.id, ok: false, err: 'faltam campos' }); continue; }
        let ctx = {}; try { ctx = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch (_) {}
        ctx.classification = { ...(ctx.classification || {}), modality: mod, tier,
          type: cat === 'Calçados' ? 'Calçado' : (cat === 'Vestuário' ? 'Roupa' : (cat === 'INSUMO' ? 'Insumo' : 'Acessório')),
          gender: sub, source: 'regra-aprovada', classifiedAt: new Date().toISOString() };
        const plan = ctx.catalogPlan || {};
        if (plan.classification) { plan.classification.classified = true; }
        plan.status = 'classified'; ctx.catalogPlan = plan;
        await prisma.product.update({ where: { id: p.id }, data: { category: cat, subcategory: sub, aiContext: ctx } });

        const iq = (ctx.catalogPlan && ctx.catalogPlan.imageQuality) || {};
        const badImg = ['quebrada', 'pessima', 'desconhecida'].includes(iq.flag); // não publica foto ruim
        let pub = null;
        if (doPublish && cat !== 'INSUMO' && pubCap > 0 && p.imageUrl && !badImg) {
          try {
            const sizes = await prisma.productSize.findMany({ where: { productId: p.id }, select: { id: true, stock: true } });
            const comprado = sizes.reduce((s, x) => s + (x.stock || 0), 0);
            let loc = 0;
            if (sizes.length) { const ss = await prisma.storeStock.aggregate({ where: { productSizeId: { in: sizes.map((s) => s.id) } }, _sum: { stock: true } }); loc = ss._sum.stock || 0; }
            if (comprado > 0 && loc >= 0.8 * comprado) { // pronto: foto + estoque>=80% localizado
              if (!conn) conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
              if (conn) {
                const nh = require('../services/nuvemshopHandlers');
                const pr = await nh.pushProductToNuvemshop(p.id, conn);
                if (pr && (pr.ok || pr.synced || pr.nuvemshopProductId)) { published++; pubCap--; pub = 'publicado'; }
              }
            }
          } catch (_) {}
        }
        results.push({ id: it.id, ok: true, published: pub });
      } catch (e) { results.push({ id: it.id, ok: false, err: e.message }); }
    }
    res.json({ ok: true, applied: results.filter((r) => r.ok).length, published, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Priorização pro site: produtos por % LOCALIZADO (bipado/comprado). minPct/maxPct ajustáveis.
router.get('/prioritize', async (req, res) => {
  try {
    const minPct = Math.max(0, Math.min(100, Number(req.query.minPct) || 50));
    const maxPct = Math.max(minPct, Math.min(1000, Number(req.query.maxPct) || 1000));
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const CLASS = `pr.category IS NOT NULL AND pr.category<>'A CLASSIFICAR' AND pr.subcategory IS NOT NULL AND pr."aiContext"->'classification'->>'modality' IS NOT NULL AND pr."aiContext"->'classification'->>'tier' IS NOT NULL`;
    const rows = await prisma.$queryRawUnsafe(`
      WITH ps AS (SELECT "productId", SUM(stock) c FROM "ProductSize" GROUP BY "productId"),
      loc AS (SELECT pz."productId", SUM(ss.stock) l FROM "StoreStock" ss JOIN "ProductSize" pz ON pz.id=ss."productSizeId" GROUP BY pz."productId")
      SELECT pr.id, pr.name, pr.brand, pr."imageUrl" image,
        COALESCE(ps.c,0)::int comprado, COALESCE(loc.l,0)::int localizado,
        CASE WHEN COALESCE(ps.c,0)>0 THEN round(COALESCE(loc.l,0)::numeric*100/ps.c)::int ELSE 0 END pct,
        (${CLASS}) classificado,
        (pr."imageUrl" IS NOT NULL) tem_imagem,
        pr."aiContext"->'catalogPlan'->'imageQuality'->>'flag' img_flag,
        (pr."aiContext"->'catalogPlan'->'classification'->'suggestion'->>'category') sugestao_cat,
        EXISTS(SELECT 1 FROM "NuvemshopProductMapping" m WHERE m."localProductId"=pr.id) publicado
      FROM "Product" pr JOIN ps ON ps."productId"=pr.id LEFT JOIN loc ON loc."productId"=pr.id
      WHERE pr.active AND COALESCE(ps.c,0)>0
        AND round(COALESCE(loc.l,0)::numeric*100/ps.c) >= ${minPct}
        AND round(COALESCE(loc.l,0)::numeric*100/ps.c) <= ${maxPct}
      ORDER BY pct DESC, comprado DESC LIMIT ${limit}`);
    res.json({ minPct, maxPct, total: rows.length, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Publica 1 produto no Nuvemshop (respeita o gate das 4 — pula se incompleto).
router.post('/publish/:id', async (req, res) => {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) return res.status(404).json({ error: 'não encontrado' });
    const nh = require('../services/nuvemshopHandlers');
    const conn = await prisma.nuvemshopConnection.findFirst({ where: { status: 'active' } });
    if (!conn) return res.json({ ok: false, error: 'sem conexão Nuvemshop' });
    const r = await nh.pushProductToNuvemshop(p.id, conn);
    res.json({ ok: !!(r && (r.ok || r.synced || r.nuvemshopProductId)), result: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.catEngineRunHandler = catEngineRunHandler;
