const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');
const { sendVerificationCode, verifyCode, isPhoneVerified, clearVerified } = require('../whatsapp');
const { sendEmailCode, verifyEmailCode } = require('../email');

const router = express.Router();

// VALIDAÇÃO DE CPF
function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(cpf)) return false; // CPFs com todos dígitos iguais

  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[9])) return false;

  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(cpf[10])) return false;

  return true;
}

// ENVIAR CÓDIGO WHATSAPP PARA COMPLETAR PERFIL (não verifica duplicidade)
router.post('/send-code-profile', authMiddleware, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório' });
    const cleanPhone = phone.replace(/\D/g, '');
    const result = await sendVerificationCode(cleanPhone);
    if (result.success) {
      res.json({ success: true, message: 'Código enviado para seu WhatsApp' });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar código' });
  }
});

// ENVIAR CÓDIGO DE VERIFICAÇÃO POR WHATSAPP
router.post('/send-code', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório' });

    const cleanPhone = phone.replace(/\D/g, '');
    const existing = await prisma.user.findUnique({ where: { phone: cleanPhone } });
    if (existing && existing.active) return res.status(400).json({ error: 'Telefone já cadastrado' });

    const result = await sendVerificationCode(cleanPhone);
    if (result.success) {
      res.json({ success: true, message: 'Código enviado para seu WhatsApp' });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    console.error('Erro ao enviar código:', err);
    res.status(500).json({ error: 'Erro ao enviar código de verificação' });
  }
});

// ENVIAR CÓDIGO DE VERIFICAÇÃO POR EMAIL (para cadastro)
router.post('/send-email-register-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });

    const existing = await prisma.user.findFirst({ where: { email, active: true } });
    if (existing) return res.status(400).json({ error: 'E-mail já cadastrado' });

    const result = await sendEmailCode(email);
    if (result.success) {
      res.json({ success: true, message: 'Código enviado para seu e-mail' });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    console.error('Erro ao enviar código email:', err);
    res.status(500).json({ error: 'Erro ao enviar código' });
  }
});

// VERIFICAR CÓDIGO DE WHATSAPP
router.post('/verify-code', async (req, res) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) return res.status(400).json({ error: 'Telefone e código são obrigatórios' });

    const cleanPhone = phone.replace(/\D/g, '');
    const result = verifyCode(cleanPhone, code);

    if (result.valid) {
      res.json({ success: true, verified: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    console.error('Erro ao verificar código:', err);
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// VERIFICAR CÓDIGO DE EMAIL (para cadastro)
router.post('/verify-email-register-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'E-mail e código são obrigatórios' });

    const result = verifyEmailCode(email, code);
    if (result.valid) {
      res.json({ success: true, verified: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    console.error('Erro ao verificar código email:', err);
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// CADASTRO (telefone ou email)
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, birthDate, password, lgpdAccepted, registerMethod } = req.body;

    if (!name || !password) return res.status(400).json({ error: 'Nome e senha são obrigatórios' });
    if (!birthDate) return res.status(400).json({ error: 'Data de nascimento é obrigatória' });
    if (!lgpdAccepted) return res.status(400).json({ error: 'Você precisa aceitar os termos de uso e política de privacidade' });
    if (password.length < 4 || password.length > 20) return res.status(400).json({ error: 'Senha deve ter entre 4 e 20 caracteres' });

    if (registerMethod === 'email') {
      if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });
      const existing = await prisma.user.findFirst({ where: { email, active: true } });
      if (existing) return res.status(400).json({ error: 'E-mail já cadastrado' });
    } else {
      if (!phone) return res.status(400).json({ error: 'Telefone é obrigatório' });
      const cleanPhone = phone.replace(/\D/g, '');
      if (!isPhoneVerified(cleanPhone)) return res.status(400).json({ error: 'Telefone não verificado. Solicite um novo código.' });
      const existing = await prisma.user.findUnique({ where: { phone: cleanPhone } });
      if (existing && existing.active) return res.status(400).json({ error: 'Telefone já cadastrado' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const cleanPhone = phone ? phone.replace(/\D/g, '') : null;

    const user = await prisma.user.create({
      data: {
        name,
        phone: cleanPhone || `email_${Date.now()}`,
        email: email || null,
        birthDate,
        pin: hashedPassword,
        balance: 0,
        lgpdAccepted: true,
        lgpdDate: new Date(),
      }
    });

    if (registerMethod !== 'email' && cleanPhone) {
      clearVerified(cleanPhone);
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
        profileComplete: user.profileComplete,
        createdAt: user.createdAt,
      }
    });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// COMPLETAR PERFIL (ganha bônus - bloqueado por CPF mesmo após exclusão)
router.post('/complete-profile', authMiddleware, async (req, res) => {
  try {
    const {
      cpf, email, phone, birthDate, cep, street, number, complement, neighborhood, city, state,
      height, weight, shirtSize, shoeSize,
      sportsPractice, sportsWant, sportsWhere, favBrands
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.profileComplete) return res.status(400).json({ error: 'Perfil já foi completado' });

    if (cpf) {
      // Valida formato do CPF
      if (!validarCPF(cpf)) {
        return res.status(400).json({ error: 'CPF inválido. Verifique os dígitos informados.' });
      }

      const existingCpf = await prisma.user.findFirst({ where: { cpf, NOT: { id: req.userId } } });
      if (existingCpf) return res.status(400).json({ error: 'CPF já cadastrado por outro usuário' });
    }

    let bonusAmount = 0;
    const bonusConfig = await prisma.config.findUnique({ where: { key: 'welcome_bonus' } });
    if (bonusConfig) bonusAmount = parseFloat(bonusConfig.value);

    // Bloqueia bônus se CPF já recebeu antes (mesmo em conta excluída)
    let cpfAlreadyReceivedBonus = false;
    if (cpf && bonusAmount > 0) {
      const cpfHistory = await prisma.user.findFirst({
        where: { cpf, welcomeBonus: true }
      });
      if (cpfHistory) {
        cpfAlreadyReceivedBonus = true;
        bonusAmount = 0;
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: req.userId },
        data: {
          cpf: cpf || null,
          email: email || user.email || null,
          phone: phone ? phone.replace(/\D/g,'') : user.phone,
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

    let message;
    if (bonusAmount > 0) {
      message = `Perfil completo! Você ganhou T$ ${bonusAmount.toFixed(2)}`;
    } else if (cpfAlreadyReceivedBonus) {
      message = 'Perfil completo! (Bônus de boas-vindas já foi utilizado por este CPF)';
    } else {
      message = 'Perfil completo!';
    }

    res.json({ success: true, message, balance: result.balance, profileComplete: true });
  } catch (err) {
    console.error('Erro ao completar perfil:', err);
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
});

// ATUALIZAR DADOS PESSOAIS (usuário logado)
router.put('/update-profile', authMiddleware, async (req, res) => {
  try {
    const {
      name, birthDate, cep, street, number, complement, neighborhood, city, state,
      height, weight, shirtSize, shoeSize,
      sportsPractice, sportsWant, sportsWhere, favBrands
    } = req.body;

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const updated = await prisma.user.update({
      where: { id: req.userId },
      data: {
        name: name || user.name,
        birthDate: birthDate || user.birthDate,
        cep: cep !== undefined ? cep : user.cep,
        street: street !== undefined ? street : user.street,
        number: number !== undefined ? number : user.number,
        complement: complement !== undefined ? complement : user.complement,
        neighborhood: neighborhood !== undefined ? neighborhood : user.neighborhood,
        city: city !== undefined ? city : user.city,
        state: state !== undefined ? state : user.state,
        height: height !== undefined ? height : user.height,
        weight: weight !== undefined ? weight : user.weight,
        shirtSize: shirtSize !== undefined ? shirtSize : user.shirtSize,
        shoeSize: shoeSize !== undefined ? shoeSize : user.shoeSize,
        sportsPractice: sportsPractice !== undefined ? JSON.stringify(sportsPractice) : user.sportsPractice,
        sportsWant: sportsWant !== undefined ? JSON.stringify(sportsWant) : user.sportsWant,
        sportsWhere: sportsWhere !== undefined ? JSON.stringify(sportsWhere) : user.sportsWhere,
        favBrands: favBrands !== undefined ? JSON.stringify(favBrands) : user.favBrands,
      }
    });

    res.json({ success: true, message: 'Dados atualizados com sucesso' });
  } catch (err) {
    console.error('Erro ao atualizar perfil:', err);
    res.status(500).json({ error: 'Erro ao atualizar dados' });
  }
});

// LOGIN (telefone ou email)
router.post('/login', async (req, res) => {
  try {
    const { phone, email, password } = req.body;

    if (!password) return res.status(400).json({ error: 'Senha é obrigatória' });

    let user;
    if (email) {
      user = await prisma.user.findFirst({ where: { email } });
    } else if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      user = await prisma.user.findUnique({ where: { phone: cleanPhone } });
    } else {
      return res.status(400).json({ error: 'Informe telefone ou e-mail' });
    }

    if (!user) return res.status(401).json({ error: 'Credenciais incorretas' });
    if (!user.active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com a loja.' });

    const validPassword = await bcrypt.compare(password, user.pin);
    if (!validPassword) return res.status(401).json({ error: 'Credenciais incorretas' });

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
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

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

// TESTE DE EMAIL
router.get('/test-email', async (req, res) => {
  try {
    const result = await sendEmailCode('sportsetennis@gmail.com');
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ENVIAR CÓDIGO EMAIL (para completar perfil)
router.post('/send-email-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });

    const result = await sendEmailCode(email);
    if (result.success) {
      res.json({ success: true, message: 'Código enviado para seu e-mail' });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao enviar código' });
  }
});

// VERIFICAR CÓDIGO EMAIL (para completar perfil)
router.post('/verify-email-code', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'E-mail e código são obrigatórios' });

    const result = verifyEmailCode(email, code);
    if (result.valid) {
      res.json({ success: true, verified: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// ESQUECI SENHA - ENVIAR CÓDIGO
router.post('/forgot-send-code', async (req, res) => {
  try {
    const { phone, email, method } = req.body;

    let user;
    if (method === 'whatsapp' && phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      user = await prisma.user.findUnique({ where: { phone: cleanPhone } });
      if (!user) return res.status(400).json({ error: 'Telefone não cadastrado' });
      const result = await sendVerificationCode(cleanPhone);
      if (!result.success) return res.status(400).json({ error: result.message });
      res.json({ success: true, message: 'Código enviado para seu WhatsApp' });
    } else if (method === 'email' && email) {
      user = await prisma.user.findFirst({ where: { email } });
      if (!user) return res.status(400).json({ error: 'E-mail não cadastrado' });
      const result = await sendEmailCode(email);
      if (!result.success) return res.status(400).json({ error: result.message });
      res.json({ success: true, message: 'Código enviado para seu e-mail' });
    } else {
      return res.status(400).json({ error: 'Informe telefone ou e-mail' });
    }
  } catch (err) {
    console.error('Erro forgot-send-code:', err);
    res.status(500).json({ error: 'Erro ao enviar código' });
  }
});

// ESQUECI SENHA - VERIFICAR CÓDIGO
router.post('/forgot-verify', async (req, res) => {
  try {
    const { phone, email, code } = req.body;

    let result;
    if (phone) {
      result = verifyCode(phone.replace(/\D/g, ''), code);
    } else if (email) {
      const user = await prisma.user.findFirst({ where: { email } });
      if (!user) return res.status(400).json({ error: 'E-mail não cadastrado' });
      result = verifyEmailCode(email, code);
    } else {
      return res.status(400).json({ error: 'Informe telefone ou e-mail' });
    }

    if (result.valid) {
      res.json({ success: true, verified: true });
    } else {
      res.status(400).json({ error: result.message });
    }
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar código' });
  }
});

// ESQUECI SENHA - ALTERAR
router.post('/forgot-reset', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Senha deve ter no mínimo 4 caracteres' });

    let user;
    if (phone) {
      user = await prisma.user.findUnique({ where: { phone: phone.replace(/\D/g, '') } });
    } else if (email) {
      user = await prisma.user.findFirst({ where: { email } });
    }
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: user.id }, data: { pin: hashedPassword } });

    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar senha' });
  }
});

// ALTERAR SENHA (logado)
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
    if (newPassword.length < 4 || newPassword.length > 20) return res.status(400).json({ error: 'Nova senha deve ter entre 4 e 20 caracteres' });

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const validPassword = await bcrypt.compare(currentPassword, user.pin);
    if (!validPassword) return res.status(400).json({ error: 'Senha atual incorreta' });

    const hashedNew = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: req.userId }, data: { pin: hashedNew } });

    res.json({ success: true, message: 'Senha alterada com sucesso' });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar senha' });
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
        email: null, birthDate: null,
        cep: null, street: null, number: null, complement: null,
        neighborhood: null, city: null, state: null,
        height: null, weight: null, shirtSize: null, shoeSize: null,
        sportsPractice: null, sportsWant: null, sportsWhere: null, favBrands: null,
        balance: 0,
        // CPF e welcomeBonus são mantidos para bloquear novo bônus
      }
    });

    res.json({ success: true, message: 'Conta excluída com sucesso. Seus dados foram apagados conforme a LGPD.' });
  } catch (err) {
    console.error('Erro ao excluir conta:', err);
    res.status(500).json({ error: 'Erro ao excluir conta' });
  }
});

module.exports = router;
