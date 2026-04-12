const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');

const router = express.Router();

// CADASTRO
router.post('/register', async (req, res) => {
  try {
    const { name, phone, cpf, pin } = req.body;

    if (!name || !phone || !pin) {
      return res.status(400).json({ error: 'Nome, telefone e PIN são obrigatórios' });
    }

    if (pin.length < 4 || pin.length > 6) {
      return res.status(400).json({ error: 'PIN deve ter entre 4 e 6 dígitos' });
    }

    // Verifica se telefone já existe
    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(400).json({ error: 'Telefone já cadastrado' });
    }

    // Verifica CPF duplicado se fornecido
    if (cpf) {
      const existingCpf = await prisma.user.findUnique({ where: { cpf } });
      if (existingCpf) {
        return res.status(400).json({ error: 'CPF já cadastrado' });
      }
    }

    const hashedPin = await bcrypt.hash(pin, 10);

    // Busca valor do bônus de boas-vindas
    let welcomeAmount = 0;
    const welcomeConfig = await prisma.config.findUnique({ where: { key: 'welcome_bonus' } });
    if (welcomeConfig) {
      welcomeAmount = parseFloat(welcomeConfig.value);
    }

    // Cria usuário
    const user = await prisma.user.create({
      data: {
        name,
        phone,
        cpf: cpf || null,
        pin: hashedPin,
        balance: welcomeAmount,
        welcomeBonus: welcomeAmount > 0,
      }
    });

    // Registra transação de boas-vindas
    if (welcomeAmount > 0) {
      await prisma.transaction.create({
        data: {
          type: 'welcome',
          amount: welcomeAmount,
          description: 'Bônus de boas-vindas',
          receiverId: user.id,
          balanceAfter: welcomeAmount,
        }
      });
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        balance: user.balance,
        role: user.role,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;

    if (!phone || !pin) {
      return res.status(400).json({ error: 'Telefone e PIN são obrigatórios' });
    }

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return res.status(401).json({ error: 'Telefone ou PIN incorretos' });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com a loja.' });
    }

    const validPin = await bcrypt.compare(pin, user.pin);
    if (!validPin) {
      return res.status(401).json({ error: 'Telefone ou PIN incorretos' });
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        balance: user.balance,
        role: user.role,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// PERFIL
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true, name: true, phone: true, cpf: true,
        balance: true, role: true, createdAt: true, active: true,
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({ user });
  } catch (err) {
    console.error('Erro ao buscar perfil:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

module.exports = router;
