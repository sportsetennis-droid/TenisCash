const express = require('express');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');

const router = express.Router();

// GERAR QR CODE PARA USAR NA LOJA
router.get('/generate', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, name: true, balance: true, phone: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Gera token temporário pro QR (expira em 5 min)
    const qrToken = jwt.sign(
      { userId: user.id, purpose: 'checkout', balance: user.balance },
      JWT_SECRET,
      { expiresIn: '5m' }
    );

    const qrCode = `TC:${qrToken}`;

    // Gera imagem QR em base64
    const qrImage = await QRCode.toDataURL(qrCode, {
      width: 300,
      margin: 2,
      color: { dark: '#FF6D00', light: '#FFFFFF' }
    });

    res.json({
      qrCode: qrCode,
      qrImage: qrImage,
      user: { name: user.name, balance: user.balance },
      expiresIn: 300, // 5 minutos em segundos
    });
  } catch (err) {
    console.error('Erro ao gerar QR:', err);
    res.status(500).json({ error: 'Erro ao gerar QR Code' });
  }
});

// VENDEDOR: VALIDAR QR CODE DO CLIENTE
router.post('/validate', authMiddleware, async (req, res) => {
  try {
    // Só admin pode validar QR
    if (req.userRole !== 'admin' && req.userRole !== 'superadmin') {
      return res.status(403).json({ error: 'Apenas administradores podem validar QR codes' });
    }

    const { qrCode } = req.body;
    if (!qrCode || !qrCode.startsWith('TC:')) {
      return res.status(400).json({ error: 'QR Code inválido' });
    }

    const token = qrCode.replace('TC:', '');
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.purpose !== 'checkout') {
      return res.status(400).json({ error: 'QR Code não é de checkout' });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, name: true, phone: true, balance: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário do QR não encontrado' });
    }

    res.json({
      valid: true,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        balance: user.balance,
      }
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'QR Code expirado. Peça ao cliente para gerar outro.' });
    }
    console.error('Erro ao validar QR:', err);
    res.status(400).json({ error: 'QR Code inválido' });
  }
});

module.exports = router;
