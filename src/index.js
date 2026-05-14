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

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Segurança
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '1mb' }));

// Rate limiting global
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' }
});
app.use('/api/', limiter);

// Rate limiting mais restrito para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
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
app.use('/api', nuvemshopRoutes);
app.use('/api', partnersRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TenisCash API', version: '1.0.0' });
});

// Servir frontend (produção)
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`TenisCash API rodando na porta ${PORT}`);
});
