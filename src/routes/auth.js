const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');

const router = express.Router();

// CADASTRO BÁSICO (sem bônus - bônus só no perfil completo)
router.post('/register', async (req, res) => {
  try {
    const { name, phone, birthDate, password, lgpdAccepted } = req.body;

    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Nome, telefone e senha são obrigatórios' });
    }

    if (!birthDate) {
      return res.status(400).json({ error: 'Data de nascimento é obrigatória' });
    }

    if (!lgpdAccepted) {
      return res.status(400).json({ error: 'Você precisa aceitar os termos de uso e política de privacidade' });
    }

    if (password.length < 4 || password.length > 20) {
      return res.status(400).json({ error: 'Senha deve ter entre 4 e 20 caracteres' });
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(400).json({ error: 'Telefone já cadastrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        phone,
        birthDate,
        pin: hashedPassword,
        balance: 0,
        lgpdAccepted: true,
        lgpdDate: new Date(),
      }
    });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        balance: user.balance,
        role: user.role,
        profileComplete: user.profileComplete,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// COMPLETAR PERFIL (ganha bônus)
router.post('/complete-profile', authMiddleware, async (req, res) => {
  try {
    const {
      cpf, email, birthDate, cep, street, number, complement, neighborhood, city, state,
      height, weight, shirtSize, shoeSize,
      sportsPractice, sportsWant, sportsWhere, favBrands
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (user.profileComplete) {
      return res.status(400).json({ error: 'Perfil já foi completado' });
    }

    if (cpf) {
      const existingCpf = await prisma.user.findFirst({ where: { cpf, NOT: { id: req.userId } } });
      if (existingCpf) {
        return res.status(400).json({ error: 'CPF já cadastrado por outro usuário' });
      }
    }

    let bonusAmount = 0;
    const bonusConfig = await prisma.config.findUnique({ where: { key: 'welcome_bonus' } });
    if (bonusConfig) {
      bonusAmount = parseFloat(bonusConfig.value);
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.userId },
        data: {
          cpf: cpf || null,
          email: email || null,
          birthDate: birthDate || null,
          cep: cep || null,
          street: street || null,
          number: number || null,
          complement: complement || null,
          neighborhood: neighborhood || null,
          city: city || null,
          state: state || null,
          height: height || null,
          weight: weight || null,
          shirtSize: shirtSize || null,
          shoeSize: shoeSize || null,
          sportsPractice: sportsPractice ? JSON.stringify(sportsPractice) : null,
          sportsWant: sportsWant ? JSON.stringify(sportsWant) : null,
          sportsWhere: sportsWhere ? JSON.stringify(sportsWhere) : null,
          favBrands: favBrands ? JSON.stringify(favBrands) : null,
          profileComplete: true,
          welcomeBonus: bonusAmount > 0,
          balance: { increment: bonusAmount },
        }
      });

      if (bonusAmount > 0) {
        await tx.transaction.create({
          data: {
            type: 'welcome',
            amount: bonusAmount,
            description: 'Bônus por completar perfil',
            receiverId: req.userId,
            balanceAfter: updated.balance,
          }
        });
      }

      return updated;
    });

    res.json({
      success: true,
      message: bonusAmount > 0 ? `Perfil completo! Você ganhou T$ ${bonusAmount.toFixed(2)}` : 'Perfil completo!',
      balance: result.balance,
      profileComplete: true,
    });
  } catch (err) {
    console.error('Erro ao completar perfil:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// LOGIN
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Telefone e senha são obrigatórios' });
    }

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      return res.status(401).json({ error: 'Telefone ou senha incorretos' });
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Conta desativada. Entre em contato com a loja.' });
    }

    const validPassword = await bcrypt.compare(password, user.pin);
    if (!validPassword) {
      return res.status(401).json({ error: 'Telefone ou senha incorretos' });
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
        profileComplete: user.profileComplete,
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
    const user = await prisma.user.findUnique({ where: { id: req.userId } });

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        cpf: user.cpf,
        balance: user.balance,
        role: user.role,
        profileComplete: user.profileComplete,
        birthDate: user.birthDate,
        cep: user.cep,
        street: user.street,
        number: user.number,
        complement: user.complement,
        neighborhood: user.neighborhood,
        city: user.city,
        state: user.state,
        height: user.height,
        weight: user.weight,
        shirtSize: user.shirtSize,
        shoeSize: user.shoeSize,
        sportsPractice: user.sportsPractice ? JSON.parse(user.sportsPractice) : [],
        sportsWant: user.sportsWant ? JSON.parse(user.sportsWant) : [],
        sportsWhere: user.sportsWhere ? JSON.parse(user.sportsWhere) : [],
        favBrands: user.favBrands ? JSON.parse(user.favBrands) : [],
        createdAt: user.createdAt,
        active: user.active,
      }
    });
  } catch (err) {
    console.error('Erro ao buscar perfil:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// EXCLUIR CONTA (LGPD)
router.delete('/me', authMiddleware, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: {
        active: false,
        name: 'Conta excluída',
        phone: `deleted_${Date.now()}`,
        email: null, cpf: null, birthDate: null,
        cep: null, street: null, number: null, complement: null,
        neighborhood: null, city: null, state: null,
        height: null, weight: null, shirtSize: null, shoeSize: null,
        sportsPractice: null, sportsWant: null, sportsWhere: null, favBrands: null,
        balance: 0,
      }
    });

    res.json({ success: true, message: 'Conta excluída com sucesso. Seus dados foram apagados conforme a LGPD.' });
  } catch (err) {
    console.error('Erro ao excluir conta:', err);
    res.status(500).json({ error: 'Erro ao excluir conta' });
  }
});

module.exports = router;
