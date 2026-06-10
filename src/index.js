const express = require('express');
const compression = require('compression');
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
const creationCampaignsRoutes = require('./routes/creationCampaigns');
const cashbackRedeemRoutes = require('./routes/cashbackRedeem');
const adminAIRoutes = require('./ai/orchestrator/orchestrator.routes');
const lifeRoutes = require('./routes/life');
const labelsRoutes = require('./routes/labels');
const fiscalRoutes = require('./routes/fiscal');
const curationRoutes = require('./routes/curation');
const sellerPortfolioRoutes = require('./routes/sellerPortfolio');
const sellerAgentRoutes = require('./routes/sellerAgent');
const weeklyInterviewRoutes = require('./routes/weeklyInterview');
const xmlImportRoutes = require('./routes/xmlImport');
const recommendationsRoutes = require('./routes/recommendations');
const nuvemshopRoutes = require('./routes/nuvemshop');
const tiktokShopRoutes = require('./routes/tiktokShop');
const shippingRoutes = require('./routes/shipping');
const financialRoutes = require('./routes/financial');
const suppliersRoutes = require('./routes/suppliers');
const categoriesRoutes = require('./routes/categories');
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
const tournamentsRoutes = require('./routes/tournaments');
const adminClassificationRoutes = require('./routes/adminClassification');
const adminVitrineRoutes = require('./routes/adminVitrine');
const whatsappRoutes = require('./routes/whatsapp');
const stocktakeRoutes = require('./routes/stocktake');
const messagesV2Routes = require('./routes/messagesV2');
const marketingRoutes = require('./routes/marketing');
const marketingConfigRoutes = require('./routes/marketingConfig');
const brandProfilesRoutes = require('./routes/brandProfiles');
const priceCheckRoutes = require('./routes/priceCheck');
const professionalsRoutes = require('./routes/professionals');
const liveCommerceRoutes = require('./routes/liveCommerce');
const infoproductsRoutes = require('./routes/infoproducts');
const desapegaRoutes = require('./routes/desapega');
const pagbankRoutes = require('./routes/pagbank');
const catalogEngineRoutes = require('./routes/catalogEngine');
const servicesRoutes = require('./routes/services');
const servicesPackagesRouter = require('./routes/services-packages');
const servicesFinanceRoutes = require('./routes/services-finance');
const servicesStockRouter = require('./routes/services-stock');
const servicesMarketingRoutes = require('./routes/services-marketing');
const servicesClubRouter = require('./routes/services-club');
const brandProfiles = require('./services/brandProfiles');
const { startMessagesCron } = require('./services/messagesCron');
const { startMarketingCron } = require('./services/marketingCron');
const { startDailyAgentsCron } = require('./services/dailyAgentsCron');
const { startCatalogEngineCron } = require('./services/catalogEngineCron');
const { startServicesCron } = require('./services/servicesCron');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Compressão gzip — reduz payload da listagem de produtos em ~70%
// Threshold 1KB pra não desperdiçar CPU em respostas pequenas
app.use(compression({ threshold: 1024 }));

// Segurança — referrer policy ajustada pra CDNs externos (moovin/vtex/simplo7
// bloqueiam hotlink quando Referer está vazio). 'strict-origin-when-cross-origin'
// envia só o origin pra HTTPS, o suficiente pros CDNs liberarem a imagem.
app.use(helmet({
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({
  // 1.5mb pra acomodar foto/audio em base64 do /api/messages-v2
  limit: '1.5mb',
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
// TEMPORÁRIO (remover após uso): re-pull foto 2026 COM COR, fora de /api/admin. Guard por ?g=.
app.post('/api/_px2026col', aiCurationRoutes.pull2026ColHandler);
app.post('/api/_catengine', catalogEngineRoutes.catEngineRunHandler); // motor de catálogo (teste/cron guardado)
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
app.use('/api/admin/fiscal', fiscalRoutes);
app.use('/api/admin/curation', curationRoutes);
app.use('/api/seller/portfolio', sellerPortfolioRoutes);
app.use('/api/seller/agent', sellerAgentRoutes);
app.use('/api/seller/interview', weeklyInterviewRoutes);
app.use('/api/admin/xml', xmlImportRoutes);
app.use('/api/admin/recommendations', recommendationsRoutes);
app.use('/api/admin/financial', financialRoutes);
app.use('/api/admin/suppliers', suppliersRoutes);
app.use('/api/admin/categories', categoriesRoutes);
app.use('/api/admin/campaigns', campaignsRoutes);
app.use('/api/admin/inventory', inventoryRoutes);
app.use('/api/admin/product-images', productImagesRoutes);
app.use('/api/admin/markup', markupRoutes);
app.use('/api/admin/products', productsRoutes);
app.use('/api/admin/ai-curation', aiCurationRoutes);
app.use('/api/admin/catalog-engine', catalogEngineRoutes);
app.use('/api/admin/anthropic-tools', anthropicToolsRoutes);
app.use('/api/admin/orchestrator', orchestratorRoutes);
app.use('/api/admin/classification', adminClassificationRoutes);
app.use('/api/admin/vitrine', adminVitrineRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/tournaments', tournamentsRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/stocktake', stocktakeRoutes);
app.use('/api/messages-v2', messagesV2Routes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/marketing-config', marketingConfigRoutes);
app.use('/api/brand-profiles', brandProfilesRoutes);
app.use('/api/price-check', priceCheckRoutes);
app.use('/api/professionals', professionalsRoutes);
app.use('/api/live', liveCommerceRoutes);
app.use('/api/infoproducts', infoproductsRoutes);
app.use('/api/desapega', desapegaRoutes);
app.use('/api/pagbank', pagbankRoutes); // webhook PIX PagBank + status (fora de /api/admin)
app.use('/api/services', servicesRoutes); // agendamento + marketplace + T$ no serviço
app.use('/api/services', servicesPackagesRouter);
app.use('/api/services', servicesFinanceRoutes);
app.use('/api/services', servicesStockRouter);
app.use('/api/services', servicesMarketingRoutes);
app.use('/api/services', servicesClubRouter);
// Seed inicial das 9 marcas (idempotente)
brandProfiles.seedDefaults().catch(e => console.warn('[brandProfiles] seed falhou:', e.message));
app.use('/api', nuvemshopRoutes);
app.use('/api', tiktokShopRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api', partnersRoutes);
app.use('/api', creationCampaignsRoutes);
app.use('/api', cashbackRedeemRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TenisCash API', version: '1.0.0' });
});

// Servir frontend (produção)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public'), {
  // ETag pro browser revalidar; imagens estáticas cacheiam normal,
  // arquivos com ?v=NNN são cacheados forever (immutable).
  etag: true,
  lastModified: true,
  setHeaders(res, filePath, stat) {
    // JS/CSS sem query string → must-revalidate; com query string → immutable
    if (/\.(js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    } else if (/\.html$/.test(filePath)) {
      // HTML é o ponto de entrada do app (JS inline) — NUNCA cachear,
      // senão PWA/Safari servem versão velha e o app fica desatualizado.
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    }
  },
}));

// Rota amigável: teniscash.com.br/loja → portal das lojas
app.get('/loja', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/loja.html'), { cacheControl: false });
});

// Rota amigável: teniscash.com.br/barber → marketplace de barbearias/salões + agendamento
app.get('/barber', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/barber.html'), { cacheControl: false });
});
// alias do nome antigo → redireciona pro novo /barber
app.get('/barbeiros', (req, res) => res.redirect(301, '/barber'));

// Vitrine por loja — consumidor vê só os produtos com estoque NAQUELA loja.
// Ex: teniscash.com.br/praiadobessa  (a página lê o slug pelo path)
const VITRINE_SLUGS = ['praiadobessa', 'bessa', 'tambau', 'tambia', 'rainhadaborborema', 'rainha', 'baratao', 'ecommerce'];
VITRINE_SLUGS.forEach((slug) => {
  app.get('/' + slug, (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.sendFile(path.join(__dirname, '../public/vitrine.html'), { cacheControl: false });
  });
});

// Página pública de produto (QR Code aponta pra cá)
app.get('/p/:id', async (req, res) => {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prismaP = new PrismaClient();
    const id = req.params.id;
    console.log('[/p/:id] lookup id=' + id);

    const includeOpts = {
      sizes: {
        orderBy: { size: 'asc' },
        include: { storeStocks: { include: { store: { select: { code: true, name: true } } } } },
      },
    };

    // 1ª tentativa: busca por id (ativo OU inativo)
    let p = await prismaP.product.findUnique({
      where: { id },
      include: includeOpts,
    });

    // 2ª tentativa: busca por SKU (talvez QR carregou SKU em vez de id)
    if (!p) {
      p = await prismaP.product.findFirst({
        where: { sku: id, active: true },
        include: includeOpts,
      });
    }

    // 3ª: produto está inativo mas foi unificado → redireciona pro canônico
    if (p && p.active === false) {
      let ctxObj = {};
      try { ctxObj = typeof p.aiContext === 'string' ? JSON.parse(p.aiContext) : (p.aiContext || {}); } catch {}
      const unifiedInto = ctxObj.unifiedInto;
      if (unifiedInto) {
        console.log('[/p/:id] produto unificado → redirecionando pra ' + unifiedInto);
        return res.redirect(302, '/p/' + unifiedInto);
      }
    }

    if (!p) {
      console.warn('[/p/:id] não encontrado: ' + id);
      return res.status(404).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto não encontrado</h1><p style="color:#888;font-size:12px;">ID: ' + String(id).replace(/[<>]/g, '') + '</p></body></html>');
    }
    if (p.active === false) {
      return res.status(410).send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h1>Produto fora de linha</h1><p>Esse produto não está mais ativo no catálogo.</p></body></html>');
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
    const storeColors = { LOJA01: '#0066cc', LOJA02: '#0a843d', LOJA03: '#b06b00', LOJA04: '#8a2be2', LOJA05: '#d70015', LOJA06: '#1d1d1f' };
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
  .header{background:linear-gradient(135deg,#E5571E,#EE7240);color:white;padding:16px 20px;border-radius:14px;margin-bottom:14px;text-align:center;box-shadow:0 8px 24px rgba(229,87,30,0.25);}
  .header h1{font-size:18px;font-weight:800;}
  .header p{font-size:12px;opacity:0.9;margin-top:2px;}
  .card{background:white;border-radius:14px;overflow:hidden;margin-bottom:14px;box-shadow:0 4px 12px rgba(0,0,0,0.04);}
  /* CARROSSEL */
  .crsl{position:relative;width:100%;aspect-ratio:1;background:#f5f5f7;}
  .crsl img.crsl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;padding:12px;display:none}
  .crsl img.crsl-img.active{display:block}
  .crsl-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,0.95);border:1px solid #e5e5ea;color:#1d1d1f;font-size:20px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:2;-webkit-tap-highlight-color:transparent;}
  .crsl-arrow:active{background:#FCDAC4;}
  .crsl-arrow.prev{left:10px}
  .crsl-arrow.next{right:10px}
  .crsl-counter{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.65);color:white;font-size:12px;font-weight:700;padding:4px 12px;border-radius:14px;z-index:2;}
  .thumbs{display:flex;gap:6px;padding:8px;overflow-x:auto;scrollbar-width:none;}
  .thumbs::-webkit-scrollbar{display:none}
  .thumb{flex-shrink:0;width:64px;height:64px;border:2px solid #e5e5ea;border-radius:8px;cursor:pointer;padding:3px;background:#f5f5f7;transition:all 0.15s;}
  .thumb.active{border-color:#E5571E;box-shadow:0 0 0 2px rgba(229,87,30,0.2);}
  .thumb img{width:100%;height:100%;object-fit:contain;}
  .info{padding:18px;}
  .brand{display:inline-block;padding:4px 12px;background:linear-gradient(135deg,#1d1d1f,#3a3a3c);color:white;font-size:12px;font-weight:800;border-radius:8px;letter-spacing:0.5px;}
  .price{font-size:28px;font-weight:800;color:#E5571E;margin-top:8px;}
  .name{font-size:20px;font-weight:700;color:#1d1d1f;line-height:1.3;margin-top:8px;}
  .sku{font-size:12px;color:#8e8e93;font-family:monospace;margin-top:6px;}
  .ref{display:inline-block;background:#FCDAC4;color:#E5571E;padding:3px 10px;border-radius:6px;font-weight:700;font-size:11px;font-family:monospace;margin-top:6px;}
  .pills{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;}
  .pill{padding:5px 10px;border-radius:8px;font-size:11px;font-weight:700;}
  .pill-type{background:#FCDAC4;color:#E5571E;}
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
      ${photos.length ? `
        <div class="crsl" id="crsl">
          ${photos.map((u, i) => `<img class="crsl-img${i === 0 ? ' active' : ''}" data-idx="${i}" src="${esc(u)}" onerror="this.style.opacity='0.3'">`).join('')}
          ${photos.length > 1 ? `
            <button class="crsl-arrow prev" onclick="crslNav(-1)">‹</button>
            <button class="crsl-arrow next" onclick="crslNav(1)">›</button>
            <div class="crsl-counter"><span id="crsl-idx">1</span> / ${photos.length}</div>
          ` : ''}
        </div>
        ${photos.length > 1 ? `
          <div class="thumbs">
            ${photos.map((u, i) => `<button class="thumb${i === 0 ? ' active' : ''}" data-idx="${i}" onclick="crslGo(${i})"><img src="${esc(u)}" onerror="this.style.opacity='0.3'"></button>`).join('')}
          </div>
        ` : ''}
      ` : ''}

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
  <script>
  (function(){
    const total = ${photos.length};
    if (total <= 1) return;
    let cur = 0;
    function update() {
      document.querySelectorAll('.crsl-img').forEach((el, i) => el.classList.toggle('active', i === cur));
      document.querySelectorAll('.thumb').forEach((el, i) => el.classList.toggle('active', i === cur));
      const c = document.getElementById('crsl-idx'); if (c) c.textContent = (cur + 1);
    }
    window.crslNav = function(dir) { cur = (cur + dir + total) % total; update(); };
    window.crslGo = function(idx) { cur = idx; update(); };
    // Swipe touch
    let startX = 0, dx = 0;
    const crsl = document.getElementById('crsl');
    if (crsl) {
      crsl.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; dx = 0; }, { passive: true });
      crsl.addEventListener('touchmove', (e) => { dx = e.touches[0].clientX - startX; }, { passive: true });
      crsl.addEventListener('touchend', () => {
        if (Math.abs(dx) > 50) crslNav(dx < 0 ? 1 : -1);
      });
    }
    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') crslNav(-1);
      if (e.key === 'ArrowRight') crslNav(1);
    });
  })();
  </script>
</body>
</html>`;
    res.send(html);
    await prismaP.$disconnect();
  } catch (err) {
    console.error('[/p/:id] erro:', err);
    res.status(500).send('Erro ao carregar produto');
  }
});

// Painel logado do profissional (cria ofertas, alunos, cobranças)
app.get('/painel', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/painel.html'), { cacheControl: false });
});

// Card público do profissional esportivo (/pro/:slug)
app.get('/pro/:slug', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/pro.html'), { cacheControl: false });
});

// Página pública de pagamento de cobrança (/c/:token)
app.get('/c/:token', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/cobranca.html'), { cacheControl: false });
});

// ===================================================================
// APEX COMPETIÇÃO — páginas públicas server-rendered (mobile-first)
// ===================================================================

const APEX_SPORT_LABEL = {
  TENNIS: '🎾 Tênis', BEACH_TENNIS: '🏖️ Beach Tennis', PADEL: '🎾 Padel',
  FUTSAL: '⚽ Futsal', SOCCER: '⚽ Futebol', VOLLEY: '🏐 Vôlei',
  BASKETBALL: '🏀 Basquete', HANDBALL: '🤾 Handebol', TABLE_TENNIS: '🏓 Tênis de Mesa',
  OTHER: '🏅 Esporte',
};
const apexEsc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Página pública do torneio (chave, jogos, classificação)
app.get('/t/:slug', async (req, res) => {
  try {
    const { prisma } = require('./middleware');
    const slug = req.params.slug;
    const t = await prisma.tournament.findFirst({
      where: { OR: [{ slug }, { id: slug }] },
      include: {
        categories: { include: { _count: { select: { entries: true } } } },
        _count: { select: { entries: true } },
      },
    });
    if (!t) {
      return res
        .status(404)
        .send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Torneio não encontrado</h1></body></html>');
    }

    const STATUS = {
      DRAFT: ['Rascunho', '#8e8e93'], OPEN: ['Inscrições abertas', '#0a843d'],
      ONGOING: ['Em andamento', '#E5571E'], FINISHED: ['Encerrado', '#1d1d1f'],
      CANCELED: ['Cancelado', '#d70015'],
    };
    const st = STATUS[t.status] || STATUS.DRAFT;
    const fmtDate = (d) =>
      d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Fortaleza' }) : '';
    const dateLine = t.startDate
      ? fmtDate(t.startDate) + (t.endDate ? ' a ' + fmtDate(t.endDate) : '')
      : '';
    const place = [t.city, t.state].filter(Boolean).join('/');

    const catData = t.categories.map((c) => ({
      id: c.id, name: c.name, entries: c._count.entries,
    }));
    const catJson = JSON.stringify(catData).replace(/</g, '\\u003c');

    // Mural de avisos (texto, sem foto) — renderizado no servidor
    const posts = await prisma.tournamentPost.findMany({
      where: { tournamentId: t.id },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      take: 50,
    });
    const fmtDateTime = (d) =>
      new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Fortaleza' });
    const muralHtml = posts.length
      ? '<div class="sec-h">📢 Mural de avisos</div>' + posts.map((p) =>
          '<div class="post">' +
          (p.pinned ? '<span class="pin">📌 fixado</span>' : '') +
          (p.title ? '<div class="post-t">' + apexEsc(p.title) + '</div>' : '') +
          '<div class="post-b">' + apexEsc(p.body) + '</div>' +
          '<div class="post-d">' + apexEsc(fmtDateTime(p.createdAt)) + '</div>' +
          '</div>'
        ).join('')
      : '';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${apexEsc(t.name)} — Sports & Tennis</title>
<meta property="og:title" content="${apexEsc(t.name)}">
<meta property="og:description" content="${apexEsc((APEX_SPORT_LABEL[t.sport] || t.sport) + ' · ' + t._count.entries + ' inscritos · ' + st[0])}">
<meta property="og:type" content="website">
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;color:#1d1d1f;line-height:1.5;padding-bottom:env(safe-area-inset-bottom)}
  .container{max-width:520px;margin:0 auto;padding:14px}
  .header{background:linear-gradient(135deg,#E5571E,#EE7240);color:#fff;padding:18px 18px;border-radius:16px;box-shadow:0 8px 24px rgba(229,87,30,.25)}
  .badge{display:inline-block;background:${st[1]};color:#fff;font-size:11px;font-weight:800;padding:4px 10px;border-radius:8px;text-transform:uppercase;letter-spacing:.5px}
  .header h1{font-size:21px;font-weight:800;margin-top:10px;line-height:1.2}
  .meta{font-size:13px;opacity:.95;margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 14px}
  .meta span{display:inline-flex;align-items:center;gap:5px}
  .prize{margin-top:12px;background:rgba(255,255,255,.18);border-radius:10px;padding:10px 12px;font-size:13px;font-weight:700}
  .cats{display:flex;gap:8px;overflow-x:auto;padding:14px 0 4px;scrollbar-width:none}
  .cats::-webkit-scrollbar{display:none}
  .cat{flex-shrink:0;border:2px solid #e5e5ea;background:#fff;color:#1d1d1f;font-size:13px;font-weight:700;padding:8px 14px;border-radius:12px;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .cat.active{border-color:#E5571E;color:#E5571E;background:#FCDAC4}
  .cat .cnt{background:#f0f0f3;color:#8e8e93;font-size:11px;padding:1px 7px;border-radius:7px;margin-left:4px}
  .cat.active .cnt{background:#E5571E;color:#fff}
  .sec-h{font-size:11px;color:#8e8e93;text-transform:uppercase;letter-spacing:1px;font-weight:800;margin:18px 4px 8px}
  .rnd{margin-bottom:14px}
  .rnd-h{font-size:13px;font-weight:800;color:#E5571E;margin:0 4px 8px}
  .mt{background:#fff;border-radius:12px;padding:6px 14px;margin-bottom:8px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
  .mt-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:15px}
  .mt-row+.mt-row{border-top:1px solid #f0f0f3}
  .mt-row .nm{font-weight:600}
  .mt-row.win .nm{font-weight:800;color:#0a843d}
  .mt-row .sc{font-weight:800;font-size:17px;min-width:26px;text-align:center}
  .liverow{display:flex;align-items:center;gap:8px;padding:6px 0 2px;border-top:1px solid #f0f0f3;margin-top:2px}
  .livebadge{display:inline-flex;align-items:center;gap:5px;background:#ffe9e0;color:#d70015;font-size:10px;font-weight:900;padding:3px 8px;border-radius:7px;text-transform:uppercase;letter-spacing:.5px}
  .livebadge .dot{width:7px;height:7px;border-radius:50%;background:#d70015;animation:lp 1.1s infinite}
  @keyframes lp{0%,100%{opacity:1}50%{opacity:.25}}
  .livesets{font-size:14px;font-weight:800;color:#1d1d1f;letter-spacing:.5px}
  .tbl{width:100%;background:#fff;border-radius:12px;overflow:hidden;border-collapse:collapse;box-shadow:0 2px 8px rgba(0,0,0,.04);font-size:13px}
  .tbl th{background:#1d1d1f;color:#fff;font-size:11px;font-weight:700;padding:9px 4px;text-align:center}
  .tbl td{padding:9px 4px;text-align:center;border-top:1px solid #f0f0f3}
  .tbl .tl{text-align:left;font-weight:700;padding-left:12px}
  .tbl th.tl{text-align:left;padding-left:12px}
  .empty{background:#fff;border-radius:12px;padding:28px 16px;text-align:center;color:#8e8e93;font-size:14px}
  .post{background:#fff;border-radius:12px;padding:12px 14px;margin-bottom:8px;box-shadow:0 2px 8px rgba(0,0,0,.04)}
  .pin{display:inline-block;background:#FFF1DC;color:#B26A00;font-size:10px;font-weight:800;padding:3px 8px;border-radius:7px;text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px}
  .post-t{font-weight:800;font-size:15px;margin-bottom:3px}
  .post-b{font-size:14px;white-space:pre-wrap;color:#1d1d1f}
  .post-d{font-size:11px;color:#8e8e93;margin-top:6px}
  .grp-h{font-size:14px;font-weight:800;color:#1d1d1f;margin:14px 4px 6px}
  .sumula{font-size:12px;color:#8e8e93;font-weight:700;padding:2px 0 6px;letter-spacing:.3px}
  .footer{text-align:center;padding:22px;color:#8e8e93;font-size:11px}
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">${apexEsc(st[0])}</span>
      <h1>${apexEsc(t.name)}</h1>
      <div class="meta">
        <span>${apexEsc(APEX_SPORT_LABEL[t.sport] || t.sport)}</span>
        ${t.isDoubles ? '<span>👥 Duplas</span>' : ''}
        ${dateLine ? '<span>📅 ' + apexEsc(dateLine) + '</span>' : ''}
        ${place ? '<span>📍 ' + apexEsc(place) + '</span>' : ''}
        <span>👤 ${t._count.entries} inscritos</span>
      </div>
      ${t.prizeDescription ? '<div class="prize">🏆 ' + apexEsc(t.prizeDescription) + '</div>' : ''}
    </div>

    ${t.description ? '<div class="sec-h">Sobre</div><div class="empty" style="text-align:left;color:#1d1d1f">' + apexEsc(t.description) + '</div>' : ''}

    ${muralHtml}

    <div class="cats" id="cats"></div>
    <div id="catbody"></div>

    <div class="footer">teniscash.com.br · Sports &amp; Tennis</div>
  </div>
<script>
(function(){
  var TID = ${JSON.stringify(t.id)};
  var CATS = ${catJson};
  var elTabs = document.getElementById('cats');
  var elBody = document.getElementById('catbody');
  var STAGE = {FINAL:'Final',SEMI:'Semifinal',QUARTER:'Quartas de final',RO16:'Oitavas de final',RO32:'16-avos',RO64:'32-avos'};
  function esc(s){s=(s==null?'':''+s);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function matchHtml(m){
    var h=m.homeEntry?m.homeEntry.name:'A definir';
    var a=m.awayEntry?m.awayEntry.name:'A definir';
    var done=(m.status==='FINISHED'||m.status==='WALKOVER');
    var live=(m.status==='LIVE');
    var hs=done&&m.homeScore!=null?m.homeScore:'';
    var as=done&&m.awayScore!=null?m.awayScore:'';
    var hw=m.winnerEntryId&&m.homeEntry&&m.winnerEntryId===m.homeEntry.id;
    var aw=m.winnerEntryId&&m.awayEntry&&m.winnerEntryId===m.awayEntry.id;
    var setsStr='';
    if(live&&m.liveState&&m.liveState.sets&&m.liveState.sets.length){
      setsStr=m.liveState.sets.map(function(s){return (s.h!=null?s.h:0)+'-'+(s.a!=null?s.a:0);}).join('  ');
    }
    var sumula=(done&&m.games&&m.games.length)?m.games.map(function(s){return s.homeGames+'-'+s.awayGames;}).join('  '):'';
    return '<div class="mt">'
      +'<div class="mt-row'+(hw?' win':'')+'"><span class="nm">'+esc(h)+'</span><span class="sc">'+esc(hs)+'</span></div>'
      +'<div class="mt-row'+(aw?' win':'')+'"><span class="nm">'+esc(a)+'</span><span class="sc">'+esc(as)+'</span></div>'
      +(sumula?'<div class="sumula">📋 '+esc(sumula)+'</div>':(m.status==='WALKOVER'?'<div class="sumula">W.O.</div>':''))
      +(live?'<div class="liverow"><span class="livebadge"><span class="dot"></span>Ao vivo</span><span class="livesets">'+esc(setsStr)+'</span></div>':'')
      +'</div>';
  }
  function renderRoundBlocks(matches){
    var groups={},order=[];
    matches.forEach(function(m){var k=(m.stage==='LEAGUE'||m.stage==='GROUP')?('R'+m.round):m.stage;if(!groups[k]){groups[k]=[];order.push(k);}groups[k].push(m);});
    var html='';
    order.forEach(function(k){
      var ms=groups[k];var label=STAGE[k]||('Rodada '+ms[0].round);
      html+='<div class="rnd"><div class="rnd-h">'+esc(label)+'</div>';
      ms.forEach(function(m){html+=matchHtml(m);});
      html+='</div>';
    });
    return html;
  }
  function renderMatches(matches){
    if(!matches.length) return '<div class="empty">Chave ainda não gerada.</div>';
    var groupM=matches.filter(function(m){return m.stage==='GROUP';});
    var rest=matches.filter(function(m){return m.stage!=='GROUP';});
    var html='';
    if(groupM.length){
      var byG={},go=[];
      groupM.forEach(function(m){var g=m.groupName||'?';if(!byG[g]){byG[g]=[];go.push(g);}byG[g].push(m);});
      go.sort();
      go.forEach(function(g){html+='<div class="grp-h">Grupo '+esc(g)+'</div>'+renderRoundBlocks(byG[g]);});
    }
    if(rest.length){
      if(groupM.length) html+='<div class="grp-h">🏆 Mata-mata</div>';
      html+=renderRoundBlocks(rest);
    }
    return html;
  }
  function stdTableHtml(rows){
    var body=rows.map(function(s,i){
      var nm=s.entry?s.entry.name:'?';
      return '<tr><td>'+(s.rank||i+1)+'</td><td class="tl">'+esc(nm)+'</td><td>'+s.played+'</td><td>'+s.won+'</td><td>'+s.drawn+'</td><td>'+s.lost+'</td><td>'+(s.scoreFor-s.scoreAgainst)+'</td><td><b>'+s.points+'</b></td></tr>';
    }).join('');
    return '<table class="tbl" style="margin-bottom:10px"><thead><tr><th>#</th><th class="tl">Atleta</th><th>J</th><th>V</th><th>E</th><th>D</th><th>SG</th><th>Pts</th></tr></thead><tbody>'+body+'</tbody></table>';
  }
  function renderStandings(stand){
    if(!stand.length) return '';
    var byG={},order=[];
    stand.forEach(function(s){var g=s.groupName||'_';if(!byG[g]){byG[g]=[];order.push(g);}byG[g].push(s);});
    order.sort();
    return order.map(function(g){
      return (g!=='_'?'<div class="grp-h">Grupo '+esc(g)+'</div>':'')+stdTableHtml(byG[g]);
    }).join('');
  }
  var POLL=null;
  function load(catId, silent){
    if(POLL){clearTimeout(POLL);POLL=null;}
    if(!silent) elBody.innerHTML='<div class="empty">Carregando…</div>';
    Promise.all([
      fetch('/api/tournaments/'+TID+'/categories/'+catId+'/matches').then(function(r){return r.json();}),
      fetch('/api/tournaments/'+TID+'/categories/'+catId+'/standings').then(function(r){return r.json();})
    ]).then(function(res){
      var matches=(res[0]&&res[0].matches)||[];
      var stand=(res[1]&&res[1].standings)||[];
      var html='';
      var stHtml=renderStandings(stand);
      if(stHtml) html+='<div class="sec-h">Classificação</div>'+stHtml;
      html+='<div class="sec-h">Jogos</div>'+renderMatches(matches);
      elBody.innerHTML=html;
      if(matches.some(function(m){return m.status==='LIVE';})){POLL=setTimeout(function(){load(catId,true);},20000);}
    }).catch(function(){if(!silent)elBody.innerHTML='<div class="empty">Erro ao carregar.</div>';});
  }
  function renderTabs(){
    elTabs.innerHTML=CATS.map(function(c,i){
      return '<button class="cat'+(i===0?' active':'')+'" data-id="'+c.id+'">'+esc(c.name)+' <span class="cnt">'+c.entries+'</span></button>';
    }).join('');
    Array.prototype.forEach.call(elTabs.querySelectorAll('.cat'),function(b){
      b.addEventListener('click',function(){
        Array.prototype.forEach.call(elTabs.querySelectorAll('.cat'),function(x){x.classList.remove('active');});
        b.classList.add('active');load(b.getAttribute('data-id'));
      });
    });
  }
  if(CATS.length){renderTabs();load(CATS[0].id);}else{elBody.innerHTML='<div class="empty">Nenhuma categoria criada ainda.</div>';}
})();
</script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('[/t/:slug] erro:', err);
    res.status(500).send('Erro ao carregar torneio');
  }
});

// Card público do atleta (estilo FIFA) — compartilhável
app.get('/atleta/:username', async (req, res) => {
  try {
    const engine = require('./services/tournamentEngine');
    const userId = await engine.resolveUserId(req.params.username);
    if (!userId) {
      return res
        .status(404)
        .send('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h1>Atleta não encontrado</h1></body></html>');
    }
    const card = await engine.buildAthleteCard(userId);
    if (!card) return res.status(404).send('Atleta não encontrado');

    const u = card.user;
    const s = card.stats;
    const overall = card.ratings.length ? card.ratings[0].rating.toFixed(1) : '—';
    const bestSport = card.ratings.length ? APEX_SPORT_LABEL[card.ratings[0].sport] || card.ratings[0].sport : '';
    const initials = (u.name || '?').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    const place = [u.city, u.state].filter(Boolean).join('/');

    const ratingChips = card.ratings
      .map(
        (r) =>
          '<div class="rt"><div class="rt-v">' + r.rating.toFixed(1) + '</div><div class="rt-s">' +
          apexEsc(APEX_SPORT_LABEL[r.sport] || r.sport) + '</div><div class="rt-w">' + r.wins + 'V · ' + r.losses + 'D</div></div>'
      )
      .join('');

    const statCell = (val, label) =>
      '<div class="sc"><div class="sc-v">' + val + '</div><div class="sc-l">' + label + '</div></div>';

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${apexEsc(u.name)} — Card do Atleta</title>
<meta property="og:title" content="${apexEsc(u.name)} — Card do Atleta">
<meta property="og:description" content="${apexEsc('Rating ' + overall + ' · ' + s.matchesPlayed + ' jogos · ' + s.wins + ' vitórias · ' + s.trainings + ' treinos · Sports & Tennis')}">
<meta property="og:type" content="profile">
<style>
  *{box-sizing:border-box;margin:0;padding:0;-webkit-font-smoothing:antialiased}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0b0d;color:#fff;line-height:1.5;min-height:100vh;padding:18px 14px env(safe-area-inset-bottom)}
  .wrap{max-width:440px;margin:0 auto}
  .card{position:relative;background:linear-gradient(155deg,#2a2118 0%,#1a1a1f 45%,#0f0f12 100%);border:1.5px solid #E5571E;border-radius:22px;padding:22px;box-shadow:0 18px 50px rgba(229,87,30,.22),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}
  .card:before{content:"";position:absolute;top:-60px;right:-60px;width:180px;height:180px;background:radial-gradient(circle,rgba(229,87,30,.35),transparent 70%);}
  .top{display:flex;gap:16px;align-items:center;position:relative}
  .ovr{text-align:center;flex-shrink:0}
  .ovr-v{font-size:46px;font-weight:900;line-height:1;color:#fff;text-shadow:0 2px 10px rgba(229,87,30,.5)}
  .ovr-l{font-size:10px;font-weight:800;letter-spacing:1.5px;color:#E5571E;margin-top:2px}
  .ovr-s{font-size:11px;color:#b9b9c0;margin-top:4px}
  .avatar{width:80px;height:80px;border-radius:50%;border:2.5px solid #E5571E;object-fit:cover;background:#E5571E;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:900;color:#fff;flex-shrink:0;margin-left:auto}
  .who{margin-top:18px;position:relative}
  .who h1{font-size:23px;font-weight:900;letter-spacing:.3px}
  .who .at{color:#E5571E;font-size:14px;font-weight:700;margin-top:1px}
  .who .loc{color:#9a9aa2;font-size:13px;margin-top:3px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:20px;position:relative}
  .sc{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:13px;padding:12px 6px;text-align:center}
  .sc-v{font-size:22px;font-weight:900;color:#fff}
  .sc-l{font-size:10px;color:#9a9aa2;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:3px}
  .rts{display:flex;gap:10px;overflow-x:auto;margin-top:18px;scrollbar-width:none;position:relative}
  .rts::-webkit-scrollbar{display:none}
  .rt{flex-shrink:0;background:linear-gradient(135deg,#E5571E,#EE7240);border-radius:13px;padding:12px 16px;text-align:center;min-width:96px}
  .rt-v{font-size:24px;font-weight:900}
  .rt-s{font-size:11px;font-weight:700;margin-top:2px}
  .rt-w{font-size:10px;opacity:.85;margin-top:2px}
  .bdg{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;position:relative}
  .bdg span{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:5px 9px;font-size:11px;font-weight:700;color:#ffd479}
  .actions{display:flex;gap:10px;margin-top:18px}
  .btn{flex:1;border:none;border-radius:13px;padding:14px;font-size:14px;font-weight:800;cursor:pointer;-webkit-tap-highlight-color:transparent}
  .btn-p{background:#E5571E;color:#fff}
  .btn-s{background:rgba(255,255,255,.1);color:#fff}
  .foot{text-align:center;color:#5a5a62;font-size:11px;margin-top:18px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        <div class="ovr">
          <div class="ovr-v">${overall}</div>
          <div class="ovr-l">RATING</div>
          ${bestSport ? '<div class="ovr-s">' + apexEsc(bestSport) + '</div>' : ''}
        </div>
        ${u.avatarUrl ? '<img class="avatar" src="' + apexEsc(u.avatarUrl) + '" alt="">' : '<div class="avatar">' + apexEsc(initials) + '</div>'}
      </div>
      <div class="who">
        <h1>${apexEsc(u.name)}</h1>
        ${u.username ? '<div class="at">@' + apexEsc(u.username) + '</div>' : ''}
        ${place ? '<div class="loc">📍 ' + apexEsc(place) + '</div>' : ''}
      </div>
      <div class="grid">
        ${statCell(s.trainings, 'Treinos')}
        ${statCell(s.matchesPlayed, 'Jogos')}
        ${statCell(s.wins, 'Vitórias')}
        ${statCell(s.winRate + '%', 'Aproveit.')}
        ${statCell(s.tournaments, 'Torneios')}
        ${statCell(s.xp, 'XP')}
      </div>
      ${ratingChips ? '<div class="rts">' + ratingChips + '</div>' : ''}
      ${card.badges.length ? '<div class="bdg">' + card.badges.map((b) => '<span>🏅 ' + apexEsc(b.key) + '</span>').join('') + '</div>' : ''}
      <div class="actions">
        <button class="btn btn-p" id="shareBtn">Compartilhar</button>
        <a class="btn btn-s" href="/" style="text-decoration:none;text-align:center">Abrir o app</a>
      </div>
    </div>
    <div class="foot">teniscash.com.br · Sports &amp; Tennis</div>
  </div>
<script>
(function(){
  var NAME=${JSON.stringify(u.name)};
  function share(){
    var url=location.href;
    var txt='Confira o card de '+NAME+' no Sports & Tennis: '+url;
    if(navigator.share){navigator.share({title:NAME,text:txt,url:url}).catch(function(){});}
    else{window.open('https://wa.me/?text='+encodeURIComponent(txt),'_blank');}
  }
  document.getElementById('shareBtn').addEventListener('click',share);
})();
</script>
</body>
</html>`;
    res.send(html);
  } catch (err) {
    console.error('[/atleta/:username] erro:', err);
    res.status(500).send('Erro ao carregar card');
  }
});

// Live commerce — vitrine ao vivo do cliente. /aovivo/LOJA01 (slug lido no front).
app.get(['/aovivo', '/aovivo/:loja'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/aovivo.html'), { cacheControl: false });
});

// Live commerce — painel do vendedor (login próprio + chat + ligar/desligar transmissão).
app.get('/atendimento', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/atendimento.html'), { cacheControl: false });
});

// ===================================================================
// INFOPRODUTOS — páginas públicas (mobile-first)
// ===================================================================
const _infoPage = (file) => (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.sendFile(path.join(__dirname, '../public/' + file), { cacheControl: false });
};
// Página de vendas do produto digital + checkout inline (/pd/:slug e /pay/:slug autocompra)
app.get(['/pd/:slug', '/pay/:slug'], _infoPage('produto.html'));
// Área de membros: player do curso (login-free via accessToken)
app.get('/curso/:token', _infoPage('curso.html'));
// Meus cursos (compras do cliente logado)
app.get('/membros', _infoPage('membros.html'));
// Painel do afiliado
app.get('/afiliado', _infoPage('afiliado.html'));
// Verificação pública de certificado
app.get('/cert/:code', _infoPage('certificado.html'));

// ===================================================================
// DESAPEGA — marketplace de usados (mobile-first)
// ===================================================================
// Vitrine pública + detalhe (detalhe é resolvido no client via /item/:id)
app.get(['/desapega', '/desapega/item/:id'], _infoPage('desapega.html'));
// Link de cadastro do vendedor (fotos + descrição) + acompanhamento por token
app.get(['/desapega/vender', '/desapega/acompanhar/:token'], _infoPage('desapega-vender.html'));
// Painel de moderação (login admin + fila aprovar/reprovar)
app.get('/desapega/admin', _infoPage('desapega-admin.html'));

// Link de afiliado rastreado: conta clique, grava cookie tc_ref, redireciona pra página de vendas
app.get('/r/:code', async (req, res) => {
  const code = String(req.params.code || '').trim();
  try {
    const { prisma } = require('./middleware');
    const link = await prisma.affiliateLink.findUnique({
      where: { code },
      include: { product: { select: { slug: true, visible: true, status: true } } },
    });
    if (!link || !link.product || !link.product.slug) {
      return res.redirect(302, '/');
    }
    // grava clique (não bloqueia o redirect se falhar)
    prisma.affiliateLink.update({ where: { code }, data: { clicks: { increment: 1 } } }).catch(() => {});
    prisma.affiliateClick.create({
      data: {
        affiliateId: link.affiliateId,
        productId: link.productId,
        linkCode: code,
        visitorToken: code,
        ip: (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
        userAgent: (req.headers['user-agent'] || '').toString(),
      },
    }).catch(() => {});
    // cookie 30 dias, legível pelo front (httpOnly:false)
    res.cookie('tc_ref', code, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
    });
    return res.redirect(302, '/pd/' + encodeURIComponent(link.product.slug) + '?ref=' + encodeURIComponent(code));
  } catch (e) {
    console.error('[/r/:code] erro:', e.message);
    return res.redirect(302, '/');
  }
});

// Fallback SPA → app cliente
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TenisCash API rodando na porta ${PORT}`);

  // Cron mensagens (expira posts de timeline 00:00 America/Fortaleza)
  if (process.env.DISABLE_MESSAGES_CRON !== '1') {
    try { startMessagesCron(); } catch (e) { console.error('[messagesCron] falha ao iniciar:', e.message); }
  }

  // Cron marketing IA (trend 05:00 + content 06:00 America/Fortaleza)
  // Só ativa se FAL_KEY estiver configurada (senão não tem como gerar)
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
    try { startDailyAgentsCron(); } catch (e) { console.error('[dailyAgentsCron] falha ao iniciar:', e.message); }
  } else {
    console.log('[dailyAgentsCron] desativado - sem OPENAI_API_KEY/ANTHROPIC_API_KEY');
  }

  if (process.env.FAL_KEY) {
    try { startMarketingCron(); } catch (e) { console.error('[marketingCron] falha ao iniciar:', e.message); }
    try { startCatalogEngineCron(); } catch (e) { console.error('[catalogEngineCron] falha ao iniciar:', e.message); }
  } else {
    console.log('[marketingCron] desativado — FAL_KEY não configurada');
  }

  // Cron serviços (barbearia/salão): cobrança do clube de assinatura + lembretes
  if (process.env.DISABLE_SERVICES_CRON !== '1') {
    try { startServicesCron(); } catch (e) { console.error('[servicesCron] falha ao iniciar:', e.message); }
  }

  // Cron jobs em background
  if (process.env.DISABLE_FISCAL_DRAFT_JOB !== '1') {
    try {
      const { startFiscalDraftJob } = require('./services/fiscalDraftJob');
      startFiscalDraftJob();
    } catch (e) {
      console.error('[boot] falha ao iniciar fiscalDraftJob:', e.message);
    }
  }
});
