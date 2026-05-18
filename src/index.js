const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const transferRoutes = require('./routes/transfer');
const promoRoutes = require('./routes/promo');
const adminRoutes = require('./routes/admin');
const qrRoutes = require('./routes/qr');
const sellerRoutes = require('./routes/seller');
const storesRoutes = require('./routes/stores');
const messagesRoutes = require('./routes/messages');
const sellersRoutes = require('./routes/sellers');
const catalogRoutes = require('./routes/catalog');
const aiRoutes = require('./routes/ai');
const adminCatalogRoutes = require('./routes/adminCatalog');
const partnersRoutes = require('./routes/partners');
const adminAIRoutes = require('./ai/orchestrator/orchestrator.routes');
const lifeRoutes = require('./routes/life');
const labelsRoutes = require('./routes/labels');
const curationRoutes = require('./routes/curation');
const sellerPortfolioRoutes = require('./routes/sellerPortfolio');
const weeklyInterviewRoutes = require('./routes/weeklyInterview');
const xmlImportRoutes = require('./routes/xmlImport');
const recommendationsRoutes = require('./routes/recommendations');
const nuvemshopRoutes = require('./routes/nuvemshop');
const financialRoutes = require('./routes/financial');
const suppliersRoutes = require('./routes/suppliers');
const campaignsRoutes = require('./routes/campaigns');
const inventoryRoutes = require('./routes/inventory');
const productImagesRoutes = require('./routes/productImages');
const markupRoutes = require('./routes/markup');
const productsRoutes = require('./routes/products');
const aiCurationRoutes = require('./routes/aiCuration');
const anthropicToolsRoutes = require('./routes/anthropicTools');
const orchestratorRoutes = require('./routes/orchestrator');
const activitiesRoutes = require('./routes/activities');
const coachRoutes = require('./routes/coach');
const adminClassificationRoutes = require('./routes/adminClassification');
const whatsappRoutes = require('./routes/whatsapp');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Segurança
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/whatsapp/webhook')) {
      req.rawBody = buf;
    }
  },
}));

// Rate limiting global — generoso pra não travar admin trabalhando em massa,
// mas o suficiente pra bloquear scripts maliciosos.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 3000, // ~3 req/seg sustentado por 15 min
  standardHeaders: true,
  legacyHeaders: false,
  // Pula rotas administrativas internas com auth (já protegidas via authMiddleware+adminMiddleware)
  skip: (req) => /^\/api\/admin\//.test(req.path),
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/api/', limiter);

// Rate limiting mais restrito SÓ para login (anti força-bruta)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});
app.use('/api/auth/', authLimiter);

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/transfer', transferRoutes);
app.use('/api/promos', promoRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/seller', sellerRoutes);
app.use('/api/stores', storesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/sellers', sellersRoutes);
app.use('/api/catalog', catalogRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/admin/catalog', adminCatalogRoutes);
app.use('/api/admin/ai', adminAIRoutes);
app.use('/api/life', lifeRoutes);
app.use('/api/admin/labels', labelsRoutes);
app.use('/api/admin/curation', curationRoutes);
app.use('/api/seller/portfolio', sellerPortfolioRoutes);
app.use('/api/seller/interview', weeklyInterviewRoutes);
app.use('/api/admin/xml', xmlImportRoutes);
app.use('/api/admin/recommendations', recommendationsRoutes);
app.use('/api/admin/financial', financialRoutes);
app.use('/api/admin/suppliers', suppliersRoutes);
app.use('/api/admin/campaigns', campaignsRoutes);
app.use('/api/admin/inventory', inventoryRoutes);
app.use('/api/admin/product-images', productImagesRoutes);
app.use('/api/admin/markup', markupRoutes);
app.use('/api/admin/products', productsRoutes);
app.use('/api/admin/ai-curation', aiCurationRoutes);
app.use('/api/admin/anthropic-tools', anthropicToolsRoutes);
app.use('/api/admin/orchestrator', orchestratorRoutes);
app.use('/api/admin/classification', adminClassificationRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api', nuvemshopRoutes);
app.use('/api', partnersRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TenisCash API', version: '1.0.0' });
});

// Servir frontend (produção)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// Rota amigável: teniscash.com.br/loja → portal das lojas
app.get('/loja', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/loja.html'));
});

// Página pública de produto (QR Code aponta pra cá)
app.get('/p/:id', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prismaP = new PrismaClient();
    const p = await prismaP.product.findFirst({
      where: { id: req.params.id, active: true },
      include: {
        sizes: {
          orderBy: { size: 'asc' },
          include: { storeStocks: { include: { store: { select: { code: true, name: true } } } } },
        },
      },
    });
    if (!p) {
      return res.status(404).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto não encontrado</h1></body></html>');
    }
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const ctx = (() => { try { return typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch { return {}; } })();
    const cls = ctx.classification || {};
    const ref = ctx.supplierRef || '';
    const photos = [];
    if (p.imageUrl) photos.push(p.imageUrl);
    try {
      const extras = typeof p.imageUrls === 'string' ? JSON.parse(p.imageUrls) : (p.imageUrls || []);
      if (Array.isArray(extras)) extras.forEach(u => { if (u && !photos.includes(u)) photos.push(u); });
    } catch {}

    // Tamanhos por loja
    const storeColors = { LOJA01: '#0066cc', LOJA02: '#0a843d', LOJA03: '#b06b00', LOJA04: '#8a2be2' };
    const byStore = {};
    (p.sizes || []).forEach(sz => {
      (sz.storeStocks || []).forEach(ss => {
        const code = ss.store?.code || '?';
        const name = ss.store?.name || code;
        if (!byStore[code]) byStore[code] = { color: storeColors[code] || '#8e8e93', name, items: [] };
        for (let i = 0; i < (ss.stock || 0); i++) byStore[code].items.push(sz.size);
      });
    });

    let storesHtml = '';
    Object.keys(byStore).sort().forEach(code => {
      const info = byStore[code];
      const counts = {};
      info.items.forEach(s => { counts[s] = (counts[s] || 0) + 1; });
      const sortedSizes = Object.keys(counts).sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0));
      const pills = sortedSizes.map(sz => {
        const q = counts[sz];
        return `<span style="display:inline-flex;align-items:center;gap:4px;padding:8px 14px;background:white;border:2px solid ${info.color};border-radius:12px;font-size:16px;font-weight:800;color:#1d1d1f;margin:4px;">${sz}${q > 1 ? `<span style="background:${info.color};color:white;padding:2px 8px;border-radius:8px;font-size:12px;">×${q}</span>` : ''}</span>`;
      }).join('');
      storesHtml += `
        <div style="margin-bottom:14px;padding:14px;background:white;border-radius:12px;border-left:5px solid ${info.color};">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
            <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${info.color};"></span>
            <div style="flex:1;">
              <div style="font-size:15px;font-weight:800;color:${info.color};">${esc(code)}</div>
              <div style="font-size:12px;color:#8e8e93;">${esc(info.name)}</div>
            </div>
            <span style="font-size:14px;font-weight:800;color:${info.color};background:${info.color}20;padding:5px 12px;border-radius:8px;">${info.items.length} un.</span>
          </div>
          <div>${pills}</div>
        </div>`;
    });

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name || 'Produto')} — Sports & Tennis</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5}
  .container{max-width:680px;margin:0 auto;padding:16px;}
  .header{background:linear-gradient(135deg,#FF6D00,#FF9248);color:white;padding:16px 20px;border-radius:14px;margin-bottom:14px;text-align:center;box-shadow:0 8px 24px rgba(255,109,0,0.25);}
  .header h1{font-size:18px;font-weight:800;}
  .header p{font-size:12px;opacity:0.9;margin-top:2px;}
  .card{background:white;border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:0 4px 12px rgba(0,0,0,0.04);}
  .photo{width:100%;aspect-ratio:1;background:#f5f5f7;object-fit:contain;padding:12px;}
  .photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:6px;padding:8px;}
  .photos img{width:100%;aspect-ratio:1;object-fit:contain;background:#f5f5f7;border-radius:8px;padding:4px;}
  .info{padding:18px;}
  .brand{display:inline-block;padding:4px 12px;background:linear-gradient(135deg,#1d1d1f,#3a3a3c);color:white;font-size:12px;font-weight:800;border-radius:8px;letter-spacing:0.5px;}
  .price{font-size:28px;font-weight:800;color:#FF6D00;margin-top:8px;}
  .name{font-size:20px;font-weight:700;color:#1d1d1f;line-height:1.3;margin-top:8px;}
  .sku{font-size:12px;color:#8e8e93;font-family:monospace;margin-top:6px;}
  .ref{display:inline-block;background:#FFE5D0;color:#FF6D00;padding:3px 10px;border-radius:6px;font-weight:700;font-size:11px;font-family:monospace;margin-top:6px;}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
  .pill{padding:5px 10px;border-radius:8px;font-size:11px;font-weight:700;}
  .pill-type{background:#FFE5D0;color:#FF6D00;}
  .pill-gender{background:#e3f2fd;color:#0066cc;}
  .pill-modality{background:#f0f0f3;color:#1d1d1f;}
  .pill-tier{background:#fff8e0;color:#b06b00;}
  .section{padding:16px 18px;border-top:1px solid #f0f0f3;}
  .section h3{font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:1px;font-weight:700;margin-bottom:10px;}
  .desc{font-size:14px;color:#1d1d1f;line-height:1.6;}
  .specs{background:#fafafa;border-radius:10px;padding:14px;font-family:monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;color:#1d1d1f;}
  .footer{text-align:center;padding:20px;color:#8e8e93;font-size:11px;}
</style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🏪 Sports & Tennis</h1><p>Informações do produto</p></div>

    <div class="card">
      ${photos.length ? `<img class="photo" src="${esc(photos[0])}" onerror="this.style.opacity='0.3'">` : ''}
      ${photos.length > 1 ? `<div class="photos">${photos.slice(1).map(u => `<img src="${esc(u)}" onerror="this.style.opacity='0.3'">`).join('')}</div>` : ''}

      <div class="info">
        ${!ctx.deactivatedReason ? `<span class="brand">${esc(p.brand || 'A DEFINIR')}</span>` : ''}
        <div class="name">${esc(p.name || '?')}</div>
        <div class="price">R$ ${Number(p.price || 0).toFixed(2)}</div>
        <div class="sku">📋 ${esc(p.sku || '')}</div>
        ${ref ? `<div><span class="ref">REF: ${esc(ref)}</span></div>` : ''}
        ${(cls.type || cls.gender || cls.modality || cls.tier) ? `
          <div class="pills">
            ${cls.type ? `<span class="pill pill-type">${esc(cls.type)}</span>` : ''}
            ${cls.gender ? `<span class="pill pill-gender">${esc(cls.gender)}</span>` : ''}
            ${cls.modality ? `<span class="pill pill-modality">${esc(cls.modality)}</span>` : ''}
            ${cls.tier ? `<span class="pill pill-tier">⭐ ${esc(cls.tier)}</span>` : ''}
          </div>
        ` : ''}
      </div>

      ${p.shortDescription ? `<div class="section"><h3>📝 Descrição</h3><p class="desc">${esc(p.shortDescription)}</p></div>` : ''}
      ${p.longDescription ? `<div class="section"><h3>📋 Especificações Técnicas</h3><div class="specs">${esc(p.longDescription)}</div></div>` : ''}
      ${Object.keys(byStore).length ? `<div class="section"><h3>📦 Estoque por loja</h3>${storesHtml}</div>` : ''}
    </div>

    <div class="footer">teniscash.com.br · Sports &amp; Tennis</div>
  </div>
</body>
</html>`;
    res.send(html);
    await prismaP.$disconnect();
  } catch (err) {
    console.error('[/p/:id] erro:', err);
    res.status(500).send('Erro ao carregar produto');
  }
});

// Fallback SPA → app cliente
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TenisCash API rodando na porta ${PORT}`);
});
