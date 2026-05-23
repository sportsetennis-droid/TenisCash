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
const adminAIRoutes = require('./ai/orchestrator/orchestrator.routes');
const lifeRoutes = require('./routes/life');
const labelsRoutes = require('./routes/labels');
const fiscalRoutes = require('./routes/fiscal');
const curationRoutes = require('./routes/curation');
const sellerPortfolioRoutes = require('./routes/sellerPortfolio');
const weeklyInterviewRoutes = require('./routes/weeklyInterview');
const xmlImportRoutes = require('./routes/xmlImport');
const recommendationsRoutes = require('./routes/recommendations');
const nuvemshopRoutes = require('./routes/nuvemshop');
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
const adminClassificationRoutes = require('./routes/adminClassification');
const whatsappRoutes = require('./routes/whatsapp');
const stocktakeRoutes = require('./routes/stocktake');
const messagesV2Routes = require('./routes/messagesV2');
const marketingRoutes = require('./routes/marketing');
const { startMessagesCron } = require('./services/messagesCron');

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
app.use('/api/admin/anthropic-tools', anthropicToolsRoutes);
app.use('/api/admin/orchestrator', orchestratorRoutes);
app.use('/api/admin/classification', adminClassificationRoutes);
app.use('/api/activities', activitiesRoutes);
app.use('/api/coach', coachRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/stocktake', stocktakeRoutes);
app.use('/api/messages-v2', messagesV2Routes);
app.use('/api/marketing', marketingRoutes);
app.use('/api', nuvemshopRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api', partnersRoutes);

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
    }
  },
}));

// Rota amigável: teniscash.com.br/loja → portal das lojas
app.get('/loja', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/loja.html'));
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
