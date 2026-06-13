// =====================================================================
// VIRTUAL TRY-ON (provador virtual) — dados públicos pro app do cliente.
// Tênis com foto + estoque real + proxy de imagem (CORS-safe pro screenshot
// não dar "tainted canvas"). Sem auth: catálogo é público.
// =====================================================================
const express = require('express');
const { prisma } = require('../middleware');
const router = express.Router();

const TENIS_CATS = ['tenis', 'Tênis', 'Calçados'];

function ctxOf(p) { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } }
function bipadoOf(p) { return (p.sizes || []).reduce((a, s) => a + (s.storeStocks || []).reduce((b, x) => b + (x.stock || 0), 0), 0); }

// GET /api/tryon/featured — top tênis COM foto pra começar o provador.
router.get('/featured', async (_req, res) => {
  try {
    const prods = await prisma.product.findMany({
      where: { active: true, category: { in: TENIS_CATS }, imageUrl: { not: null } },
      select: { id: true, name: true, brand: true, price: true, imageUrl: true, aiContext: true,
        sizes: { select: { storeStocks: { select: { stock: true } } } } },
    });
    const items = prods.map((p) => ({ id: p.id, name: p.name, brand: p.brand, price: p.price || 0, imageUrl: p.imageUrl, color: ctxOf(p).color || '', bipado: bipadoOf(p), arEffect: ctxOf(p).arEffect || null }))
      .filter((x) => x.bipado > 0).sort((a, b) => b.bipado - a.bipado).slice(0, 18);
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tryon/search?q= — busca tênis com foto.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const prods = await prisma.product.findMany({
      where: { active: true, category: { in: TENIS_CATS }, imageUrl: { not: null },
        OR: [{ name: { contains: q, mode: 'insensitive' } }, { brand: { contains: q, mode: 'insensitive' } }] },
      select: { id: true, name: true, brand: true, price: true, imageUrl: true, aiContext: true,
        sizes: { select: { storeStocks: { select: { stock: true } } } } },
      take: 24,
    });
    const items = prods.map((p) => ({ id: p.id, name: p.name, brand: p.brand, price: p.price || 0, imageUrl: p.imageUrl, color: ctxOf(p).color || '', bipado: bipadoOf(p) }));
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tryon/product/:id — detalhe pro provador: foto, preço, tamanhos com estoque, outras cores.
router.get('/product/:id', async (req, res) => {
  try {
    const p = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, brand: true, price: true, imageUrl: true, imageUrls: true, aiContext: true,
        sizes: { select: { size: true, storeStocks: { select: { stock: true } } } } },
    });
    if (!p) return res.status(404).json({ error: 'Produto não encontrado' });
    const ctx = ctxOf(p);
    // tamanhos com estoque físico real (Σ StoreStock > 0)
    const sizes = (p.sizes || []).map((s) => ({ size: s.size, stock: (s.storeStocks || []).reduce((a, x) => a + (x.stock || 0), 0) }))
      .filter((s) => s.stock > 0 && /^[0-9]/.test(String(s.size || '')))
      .sort((a, b) => parseFloat(a.size) - parseFloat(b.size));
    // outras cores (mesmo modelGroup) com foto
    let variants = [];
    const mg = ctx.modelGroup;
    if (mg) {
      const others = await prisma.$queryRaw`
        SELECT id, name, brand, price, "imageUrl", "aiContext"->>'color' AS color
        FROM "Product"
        WHERE active = true AND brand = ${p.brand} AND "aiContext"->>'modelGroup' = ${mg}
          AND "imageUrl" IS NOT NULL AND id != ${p.id}
        LIMIT 12`;
      variants = others.map((o) => ({ id: o.id, name: o.name, color: o.color || '', price: o.price || 0, imageUrl: o.imageUrl }));
    }
    res.json({ id: p.id, name: p.name, brand: p.brand, price: p.price || 0, color: ctx.color || '', imageUrl: p.imageUrl, sizes, variants, arEffect: ctx.arEffect || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tryon/ar-config — License Key do DeepAR pro provador AR (provar-ar.html).
// A chave Web do DeepAR é client-side por design (trava por domínio = teniscash.com.br),
// mas mesmo assim fica em ENV (DEEPAR_LICENSE_KEY), nunca hardcoded no repo.
router.get('/ar-config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ licenseKey: process.env.DEEPAR_LICENSE_KEY || '' });
});

// GET /api/tryon/img?u=<url> — PROXY de imagem (CORS-safe). Sem isso o canvas vira
// "tainted" e o screenshot falha. Só https; bloqueia host interno/privado (anti-SSRF).
router.get('/img', async (req, res) => {
  try {
    const raw = String(req.query.u || '');
    let url;
    try { url = new URL(raw); } catch { return res.status(400).send('url inválida'); }
    if (url.protocol !== 'https:') return res.status(400).send('só https');
    const host = url.hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(host) || host.endsWith('.local') || host.includes('railway') || host.includes('teniscash')) {
      return res.status(400).send('host bloqueado');
    }
    const r = await fetch(url.href, { headers: { 'User-Agent': 'TenisCash/1.0' } });
    if (!r.ok) return res.status(502).send('upstream ' + r.status);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!ct.startsWith('image/')) return res.status(415).send('não é imagem');
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) { res.status(500).send('erro proxy'); }
});

module.exports = router;
