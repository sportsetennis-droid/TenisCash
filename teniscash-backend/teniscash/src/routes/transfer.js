const express = require('express');
const { authMiddleware, prisma } = require('../middleware');

const router = express.Router();

// TRANSFERIR TENISCASH
router.post('/send', authMiddleware, async (req, res) => {
  try {
    const { to, amount } = req.body;

    // Validações
    if (!to || !amount) {
      return res.status(400).json({ error: 'Destinatário e valor são obrigatórios' });
    }

    const transferAmount = parseFloat(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Valor deve ser maior que zero' });
    }

    // Busca remetente
    const sender = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!sender) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    if (sender.balance < transferAmount) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // Busca destinatário por telefone ou CPF
    let receiver = await prisma.user.findUnique({ where: { phone: to } });
    if (!receiver) {
      receiver = await prisma.user.findUnique({ where: { cpf: to } });
    }

    if (!receiver) {
      return res.status(404).json({ error: 'Destinatário não encontrado. Verifique o telefone ou CPF.' });
    }

    if (receiver.id === sender.id) {
      return res.status(400).json({ error: 'Não é possível transferir para você mesmo' });
    }

    if (!receiver.active) {
      return res.status(400).json({ error: 'Conta do destinatário está desativada' });
    }

    // Executa transferência em transação atômica
    const result = await prisma.$transaction(async (tx) => {
      // Debita remetente
      const updatedSender = await tx.user.update({
        where: { id: sender.id },
        data: { balance: { decrement: transferAmount } }
      });

      // Credita destinatário
      const updatedReceiver = await tx.user.update({
        where: { id: receiver.id },
        data: { balance: { increment: transferAmount } }
      });

      // Registra transação de saída
      const txOut = await tx.transaction.create({
        data: {
          type: 'transfer_out',
          amount: transferAmount,
          description: `Enviado p/ ${receiver.name}`,
          senderId: sender.id,
          receiverId: receiver.id,
          balanceAfter: updatedSender.balance,
        }
      });

      // Registra transação de entrada
      const txIn = await tx.transaction.create({
        data: {
          type: 'transfer_in',
          amount: transferAmount,
          description: `Recebido de ${sender.name}`,
          senderId: sender.id,
          receiverId: receiver.id,
          balanceAfter: updatedReceiver.balance,
        }
      });

      return { updatedSender, updatedReceiver, txOut, txIn };
    });

    res.json({
      success: true,
      message: `T$ ${transferAmount.toFixed(2)} enviado para ${receiver.name}`,
      balance: result.updatedSender.balance,
      transaction: {
        id: result.txOut.id,
        amount: transferAmount,
        to: receiver.name,
        createdAt: result.txOut.createdAt,
      }
    });
  } catch (err) {
    console.error('Erro na transferência:', err);
    res.status(500).json({ error: 'Erro ao processar transferência' });
  }
});

// BUSCAR USUÁRIO PARA TRANSFERÊNCIA (preview)
router.get('/lookup', authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Informe telefone ou CPF' });
    }

    let user = await prisma.user.findUnique({
      where: { phone: q },
      select: { name: true, phone: true, active: true }
    });

    if (!user) {
      user = await prisma.user.findUnique({
        where: { cpf: q },
        select: { name: true, phone: true, active: true }
      });
    }

    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({ name: user.name, phone: user.phone });
  } catch (err) {
    console.error('Erro ao buscar usuário:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

module.exports = router;
