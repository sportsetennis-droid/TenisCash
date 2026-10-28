'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = function registration({ prisma, signToken }) {
  const router = express.Router();
  router.post('/auth/register', async (req, res) => {
    const { name, username, pin } = req.body || {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
        typeof username !== 'string' || !username.trim() ||
        typeof pin !== 'string' || !/^\d{4,12}$/.test(pin)) {
      return res.status(400).json({ error: 'Informe seu nome, usuário e PIN de 4 a 12 números.' });
    }
    try {
      const emp = await prisma.mfEmployee.create({ data: {
        name: name.trim(), username: username.trim(),
        pinHash: await bcrypt.hash(pin, 10), role: 'funcionario',
        active: true, canRecordProduction: false,
      } });
      res.status(201).json({ token: signToken(emp) });
    } catch (err) {
      if (err.code === 'P2002') return res.status(409).json({ error: 'Este usuário já está cadastrado. Entre com seu PIN ou escolha outro usuário.' });
      console.error('[mf/register]', err.code || 'unavailable');
      res.status(500).json({ error: 'Não foi possível cadastrar. Tente novamente.' });
    }
  });
  return router;
};
