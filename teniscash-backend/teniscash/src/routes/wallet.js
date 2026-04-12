const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

// SALDO
router.get('/balance', authMiddleware, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { balance: true, name: true }
    });

    res.json({ balance: user.balance, name: user.name });
  } catch (err) {
    console.error('Erro ao buscar saldo:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// EXTRATO
router.get('/transactions', authMiddleware, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await prisma.transaction.findMany({
      where: {
        OR: [
          { senderId: req.userId },
          { receiverId: req.userId }
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
      include: {
        sender: { select: { name: true, phone: true } },
        receiver: { select: { name: true, phone: true } },
      }
    });

    const total = await prisma.transaction.count({
      where: {
        OR: [
          { senderId: req.userId },
          { receiverId: req.userId }
        ]
      }
    });

    // Formata transações do ponto de vista do usuário
    const formatted = transactions.map(tx => {
      let type = tx.type;
      let desc = tx.description;
      let amount = tx.amount;

      // Se é transferência, ajusta perspectiva
      if (tx.type === 'transfer_out' && tx.senderId === req.userId) {
        type = 'transfer_out';
        desc = `Enviado p/ ${tx.receiver?.name || 'Desconhecido'}`;
      } else if (tx.type === 'transfer_in' && tx.receiverId === req.userId) {
        type = 'transfer_in';
        desc = `Recebido de ${tx.sender?.name || 'Desconhecido'}`;
      }

      return {
        id: tx.id,
        type,
        amount,
        description: desc,
        balanceAfter: tx.balanceAfter,
        createdAt: tx.createdAt,
      };
    });

    res.json({
      transactions: formatted,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      }
    });
  } catch (err) {
    console.error('Erro ao buscar extrato:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
