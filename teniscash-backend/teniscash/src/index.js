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

const app = express();
const PORT = process.env.PORT || 3000;

// Segurança
app.use(helmet());
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
