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
// Fallback SPA → app cliente
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TenisCash API rodando na porta ${PORT}`);
});
