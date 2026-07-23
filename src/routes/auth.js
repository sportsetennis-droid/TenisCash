const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authMiddleware, JWT_SECRET, prisma } = require('../middleware');
const { sendVerificationCode, verifyCode, isPhoneVerified, clearVerified } = require('../whatsapp');
const { sendEmailCode, verifyEmailCode } = require('../email');

const router = express.Router();

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

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
    console.log(`[auth/send-code] phone=${maskPhone(cleanPhone)} success=${!!result.success} provider=${result.provider || 'none'} error=${result.success ? 'none' : (result.message || 'unknown')}`);
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
      // WhatsApp fora do ar → sinaliza pra tela oferecer cadastro por e-mail
      res.status(400).json({ error: result.message, whatsappDown: true });
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

      // Só bloqueia se CPF está em conta ATIVA de outro usuário
      const existingCpf = await prisma.user.findFirst({ 
        where: { cpf, active: true, NOT: { id: req.userId } } 
      });
      if (existingCpf) return res.status(400).json({ error: 'CPF já cadastrado por outro usuário' });
    }

    let bonusAmount = 0;
    const bonusConfig = await prisma.config.findUnique({ where: { key: 'welcome_bonus' } });
    if (bonusConfig) bonusAmount = parseFloat(bonusConfig.value);

    // Bloqueia bônus se CPF já recebeu antes (mesmo em conta excluída - via deletedCpf)
    let cpfAlreadyReceivedBonus = false;
    if (cpf && bonusAmount > 0) {
      const cpfHistory = await prisma.user.findFirst({
        where: {
          OR: [
            { cpf, welcomeBonus: true },
            { deletedCpf: cpf, welcomeBonus: true }
          ]
        }
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

    const includeRich = {
      store: {
        select: { id: true, name: true, code: true, dna: true, mall: true, city: true, state: true }
      },
      partner: {
        select: { id: true, couponCode: true, discountPct: true, commissionPct: true, tier: true, status: true, type: true, totalSales: true, totalCommission: true }
      }
    };

    let user;
    if (email) {
      user = await prisma.user.findFirst({ where: { email }, include: includeRich });
    } else if (phone) {
      const cleanPhone = phone.replace(/\D/g, '');
      user = await prisma.user.findUnique({ where: { phone: cleanPhone }, include: includeRich });
    } else {
      return res.status(400).json({ error: 'Informe telefone ou e-mail' });
    }

    if (!user) return res.status(401).json({ error: 'Credenciais incorretas' });
    if (!user.active) return res.status(403).json({ error: 'Conta desativada. Entre em contato com a loja.' });

    const validPassword = await bcrypt.compare(password, user.pin);
    if (!validPassword) return res.status(401).json({ error: 'Credenciais incorretas' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

    console.log('[auth/login] userId=' + user.id + ' role=' + user.role + ' isPartner=' + !!user.partner);

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        storeId: user.storeId,
        store: user.store || null,
        balance: user.balance,
        partnerBalance: user.partnerBalance || 0,
        role: user.role,
        profileComplete: user.profileComplete,
        createdAt: user.createdAt,
        partner: user.partner || null,
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
      include: {
        store: {
          select: { id: true, name: true, code: true, dna: true, mall: true, city: true, state: true }
        },
        partner: {
          select: { id: true, couponCode: true, discountPct: true, commissionPct: true, tier: true, status: true, type: true, totalSales: true, totalCommission: true }
        }
      }
    });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    console.log('[auth/me] userId=' + user.id + ' role=' + user.role + ' isPartner=' + !!user.partner);

    res.json({
      // Renova o papel no JWT quando um cliente foi promovido a vendedor
      // enquanto ainda tinha uma sessao antiga aberta.
      token: jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' }),
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        cpf: user.cpf,
        balance: user.balance,
        partnerBalance: user.partnerBalance || 0,
        role: user.role,
        profileComplete: user.profileComplete,
        storeId: user.storeId,
        storeIds: user.storeIds || [],
        store: user.store || null,
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
        partner: user.partner || null,
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
      if (result.success) {
        return res.json({ success: true, message: 'Código enviado para seu WhatsApp' });
      }
      // WhatsApp fora do ar → cai automaticamente no e-mail do cliente, se houver
      if (user.email) {
        const emailResult = await sendEmailCode(user.email);
        if (emailResult.success) {
          const masked = user.email.replace(/^(.).*(@.*)$/, '$1***$2');
          return res.json({ success: true, via: 'email', message: `WhatsApp indisponível — enviamos o código para seu e-mail (${masked})` });
        }
      }
      return res.status(400).json({ error: result.message, whatsappDown: true, hasEmail: !!user.email });
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
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    await prisma.user.update({
      where: { id: req.userId },
      data: {
        active: false,
        name: 'Conta excluída',
        phone: `deleted_${Date.now()}`,
        email: null,
        // CPF é apagado mas welcomeBonus e deletedCpf ficam para controle de bônus
        cpf: null,
        deletedCpf: user.cpf || null, // guarda CPF para bloquear bônus futuro
        birthDate: null,
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

// =====================================================================
// AUTO-UPDATE DO FISCAL-AGENT DAS LOJAS (mount público de propósito)
// =====================================================================
// O agente da loja NÃO tem JWT — a credencial é o PRÓPRIO AGENT_TOKEN,
// validado contra Store.fiscalAgentToken. Os arquivos servidos são os de
// agents/fiscal-agent, que vêm versionados no repo (presentes no build do
// Railway). É assim que o agente v2.3+ se atualiza sozinho e que o
// instalador público /atualizar-agente.ps1 baixa a versão nova.
const _agPath = require('node:path');
const _agFs = require('node:fs');
const _agCrypto = require('node:crypto');
const { Transform: _CameraUploadTransform } = require('node:stream');
const { pipeline: _cameraUploadPipeline } = require('node:stream/promises');
const AGENT_FILES = ['index.js', 'fiscalSefazDirect.mjs', 'fiscalAcquirers.js', 'supervisor.js', 'monitor.js', 'screencap.cs', 'package.json'];
const agentDir = () => _agPath.join(__dirname, '..', '..', 'agents', 'fiscal-agent');

async function agentTokenOk(req) {
  const tok = String(req.headers['x-agent-token'] || req.query.token || '').trim();
  if (tok.length < 16) return false;
  const store = await prisma.store.findFirst({ where: { fiscalAgentToken: tok }, select: { id: true } });
  return !!store;
}

router.get('/agent-update/manifest', async (req, res) => {
  try {
    if (!(await agentTokenOk(req))) return res.status(401).json({ error: 'token de agente inválido' });
    const idx = _agFs.readFileSync(_agPath.join(agentDir(), 'index.js'), 'utf8');
    // v2.3+: const VERSION = 'x.y-z'; legado: version: 'x.y-z' direto no /health
    const version = (idx.match(/VERSION\s*=\s*'([^']+)'/) || idx.match(/version:\s*'([^']+)'/) || [])[1] || 'desconhecida';
    const files = AGENT_FILES.filter(f => _agFs.existsSync(_agPath.join(agentDir(), f))).map(f => {
      const buf = _agFs.readFileSync(_agPath.join(agentDir(), f));
      return { name: f, sha256: _agCrypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    });
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ version, files });
  } catch (err) {
    console.error('[agent-update/manifest]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/agent-update/file/:name', async (req, res) => {
  try {
    if (!(await agentTokenOk(req))) return res.status(401).json({ error: 'token de agente inválido' });
    const name = _agPath.basename(String(req.params.name)); // sem path traversal
    if (!AGENT_FILES.includes(name)) return res.status(404).json({ error: 'arquivo não publicado' });
    const full = _agPath.join(agentDir(), name);
    if (!_agFs.existsSync(full)) return res.status(404).json({ error: 'arquivo ausente no build' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(_agFs.readFileSync(full));
  } catch (err) {
    console.error('[agent-update/file]', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// CANAL DE GESTÃO REMOTA das máquinas das lojas (sem AnyDesk) — mount público.
// O Supervisor de cada máquina faz PULL: bate heartbeat e busca comandos.
// Credencial = o próprio AGENT_TOKEN (validado contra Store.fiscalAgentToken).
// =====================================================================
async function agentTokenStore(req) {
  const tok = String(req.headers['x-agent-token'] || req.query.token || '').trim();
  if (tok.length < 16) return null;
  return prisma.store.findFirst({ where: { fiscalAgentToken: tok }, select: { id: true, code: true } });
}

router.post('/agent-control/poll', async (req, res) => {
  try {
    const store = await agentTokenStore(req);
    if (!store) return res.status(401).json({ error: 'token de agente inválido' });
    const b = req.body || {};
    await prisma.machineHeartbeat.upsert({
      where: { storeCode: store.code },
      update: { hostname: b.hostname || null, agentHealthy: !!b.agentHealthy, agentVersion: b.agentVersion || null, supervisorVersion: b.supervisorVersion || null, lastSeen: new Date() },
      create: { storeCode: store.code, hostname: b.hostname || null, agentHealthy: !!b.agentHealthy, agentVersion: b.agentVersion || null, supervisorVersion: b.supervisorVersion || null },
    });
    const pending = await prisma.agentCommand.findMany({ where: { storeCode: store.code, status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 5 });
    if (pending.length) await prisma.agentCommand.updateMany({ where: { id: { in: pending.map(c => c.id) } }, data: { status: 'sent' } });
    res.json({ commands: pending.map(c => ({ id: c.id, type: c.type, args: c.args })) });
  } catch (err) {
    console.error('[agent-control/poll]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/agent-control/result', async (req, res) => {
  try {
    const store = await agentTokenStore(req);
    if (!store) return res.status(401).json({ error: 'token de agente inválido' });
    const { commandId, ok, output } = req.body || {};
    if (!commandId) return res.status(400).json({ error: 'commandId obrigatório' });
    await prisma.agentCommand.updateMany({
      where: { id: String(commandId), storeCode: store.code },
      data: { status: ok ? 'done' : 'failed', result: String(output || '').slice(0, 6000) },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[agent-control/result]', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// GRAVAÇÃO DE SEGURANÇA — recebe o print puxado da máquina (só o que o dono
// pede; o buffer de 36h fica NA loja). UPLOAD = token do agente. VER = token
// do dono (CAPTURE_VIEW_TOKEN). Capturas centrais rolam em 48h (são temporárias).
// =====================================================================
const _capDir = _agPath.join(process.cwd(), 'captures');
function _viewOk(req) { const k = String(req.query.key || req.headers['x-view-token'] || ''); const exp = process.env.CAPTURE_VIEW_TOKEN || ''; return !!exp && k === exp; }

router.post('/agent-capture', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  try {
    const store = await agentTokenStore(req);
    if (!store) return res.status(401).json({ error: 'token de agente inválido' });
    const name = _agPath.basename(String(req.headers['x-capture-name'] || '')).replace(/[^A-Za-z0-9._-]/g, '');
    if (!name || !req.body || !req.body.length) return res.status(400).json({ error: 'name/body obrigatório' });
    const dir = _agPath.join(_capDir, store.code);
    _agFs.mkdirSync(dir, { recursive: true });
    _agFs.writeFileSync(_agPath.join(dir, name), req.body);
    try { const lim = Date.now() - 48 * 3600 * 1000; for (const f of _agFs.readdirSync(dir)) { const fp = _agPath.join(dir, f); if (_agFs.statSync(fp).mtimeMs < lim) _agFs.unlinkSync(fp); } } catch {}
    res.json({ ok: true, stored: store.code + '/' + name, bytes: req.body.length });
  } catch (err) { console.error('[agent-capture]', err); res.status(500).json({ error: err.message }); }
});

router.get('/agent-capture/list/:store', (req, res) => {
  if (!_viewOk(req)) return res.status(401).json({ error: 'view token inválido' });
  const dir = _agPath.join(_capDir, _agPath.basename(String(req.params.store)));
  res.json({ files: _agFs.existsSync(dir) ? _agFs.readdirSync(dir).sort() : [] });
});

router.get('/agent-capture/file/:store/:name', (req, res) => {
  if (!_viewOk(req)) return res.status(401).json({ error: 'view token inválido' });
  const full = _agPath.join(_capDir, _agPath.basename(String(req.params.store)), _agPath.basename(String(req.params.name)));
  if (!_agFs.existsSync(full)) return res.status(404).json({ error: 'não achado' });
  res.setHeader('Content-Type', 'image/jpeg');
  res.send(_agFs.readFileSync(full));
});

// =====================================================================
// ARQUIVO PROPRIO DAS CAMERAS — os notebooks das lojas enviam segmentos
// finalizados pelo gravador local. No Railway, os arquivos ficam no volume /data.
// O upload usa o mesmo AGENT_TOKEN individual de cada loja.
// =====================================================================
const _cameraArchiveDir = process.env.CAMERA_ARCHIVE_DIR || (process.platform === 'win32'
  ? _agPath.join(process.cwd(), 'data', 'camera-recordings')
  : '/data/camera-recordings');
const _cameraLiveDir = process.env.CAMERA_LIVE_DIR || (process.platform === 'win32'
  ? _agPath.join(process.cwd(), 'data', 'camera-live')
  : '/data/camera-live');
const _cameraUploadLimit = 90 * 1024 * 1024;
const _cameraLiveUploadLimit = 20 * 1024 * 1024;
// O volume atual tem 50 GB. Mantemos uma folga real para o HLS ao vivo,
// arquivos temporarios e operacoes do sistema, evitando ENOSPC.
const _cameraArchiveMaxBytes = Math.max(1024 * 1024 * 1024, Number(process.env.CAMERA_ARCHIVE_MAX_BYTES || 38 * 1024 * 1024 * 1024));
const _cameraRetentionMs = Math.max(3600000, Number(process.env.CAMERA_CLOUD_RETENTION_HOURS || 24) * 3600000);
let _cameraCleanupRunning = false;

async function _cameraArchiveFiles(dir) {
  const out = [];
  let entries = [];
  try { entries = await _agFs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = _agPath.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await _cameraArchiveFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.mp4')) {
      try { const stat = await _agFs.promises.stat(full); out.push({ full, size: stat.size, mtimeMs: stat.mtimeMs }); } catch {}
    }
  }
  return out;
}

async function _cleanupCameraArchive() {
  if (_cameraCleanupRunning) return;
  _cameraCleanupRunning = true;
  try {
    const files = await _cameraArchiveFiles(_cameraArchiveDir);
    let deletedCount = 0;
    let deletedBytes = 0;
    const cutoff = Date.now() - _cameraRetentionMs;
    for (const file of files.filter(item => item.mtimeMs < cutoff)) {
      try {
        await _agFs.promises.unlink(file.full);
        file.deleted = true;
        deletedCount += 1;
        deletedBytes += file.size;
      } catch {}
    }
    const active = files.filter(item => !item.deleted).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = active.reduce((sum, item) => sum + item.size, 0);
    for (const file of active) {
      if (total <= _cameraArchiveMaxBytes) break;
      try {
        await _agFs.promises.unlink(file.full);
        total -= file.size;
        deletedCount += 1;
        deletedBytes += file.size;
      } catch {}
    }
    if (deletedCount) console.log(`[camera-cleanup] removidos=${deletedCount} bytes=${deletedBytes} restante=${total}`);
  } finally { _cameraCleanupRunning = false; }
}

// A limpeza precisa ocorrer tambem no boot: se o volume lotou enquanto o
// servidor estava parado, nenhum novo upload consegue chegar ao trecho que
// dispara a manutencao normal.
setImmediate(() => _cleanupCameraArchive().catch(err => console.error('[camera-cleanup-startup]', err.message)));

router.post('/agent-camera-segment', async (req, res) => {
  let tempFile = null;
  try {
    const store = await agentTokenStore(req);
    if (!store) return res.status(401).json({ error: 'token de agente inválido' });

    const camera = String(req.headers['x-camera-name'] || '').trim().toLowerCase();
    const segmentName = _agPath.basename(String(req.headers['x-segment-name'] || '')).replace(/[^A-Za-z0-9._-]/g, '');
    const expectedCameraPrefix = String(store.code || '').toLowerCase() + '_camera';
    if (!camera.startsWith(expectedCameraPrefix) || !/^loja\d{2}_camera\d+$/.test(camera)) return res.status(400).json({ error: 'câmera inválida' });
    if (!segmentName || !segmentName.endsWith('.mp4')) return res.status(400).json({ error: 'segmento inválido' });

    const announcedLength = Number(req.headers['content-length'] || 0);
    if (announcedLength > _cameraUploadLimit) return res.status(413).json({ error: 'segmento acima de 90 MB' });

    const dir = _agPath.join(_cameraArchiveDir, String(store.code).toUpperCase(), camera);
    await _agFs.promises.mkdir(dir, { recursive: true });
    const finalFile = _agPath.join(dir, segmentName);
    if (_agFs.existsSync(finalFile)) {
      const stat = await _agFs.promises.stat(finalFile);
      return res.json({ ok: true, duplicate: true, stored: `${store.code}/${camera}/${segmentName}`, bytes: stat.size });
    }

    tempFile = finalFile + '.' + _agCrypto.randomBytes(6).toString('hex') + '.part';
    let received = 0;
    const limiter = new _CameraUploadTransform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > _cameraUploadLimit) callback(new Error('UPLOAD_LIMIT'));
        else callback(null, chunk);
      },
    });
    await _cameraUploadPipeline(req, limiter, _agFs.createWriteStream(tempFile, { flags: 'wx' }));
    await _agFs.promises.rename(tempFile, finalFile);
    tempFile = null;
    setImmediate(() => _cleanupCameraArchive().catch(err => console.error('[camera-cleanup]', err.message)));
    res.json({ ok: true, stored: `${store.code}/${camera}/${segmentName}`, bytes: received });
  } catch (err) {
    if (tempFile) { try { await _agFs.promises.unlink(tempFile); } catch {} }
    if (err && err.message === 'UPLOAD_LIMIT') return res.status(413).json({ error: 'segmento acima de 90 MB' });
    console.error('[agent-camera-segment]', err);
    res.status(500).json({ error: 'falha ao armazenar segmento' });
  }
});

// HLS ao vivo na nuvem. O notebook envia pequenos segmentos MPEG-TS e a
// playlist corrente; o painel serve tudo pelo mesmo dominio do TenisCash.
router.post('/agent-camera-live', async (req, res) => {
  let tempFile = null;
  try {
    const store = await agentTokenStore(req);
    if (!store) return res.status(401).json({ error: 'token de agente inválido' });

    const camera = String(req.headers['x-camera-name'] || '').trim().toLowerCase();
    const fileName = _agPath.basename(String(req.headers['x-live-file-name'] || '')).replace(/[^A-Za-z0-9._-]/g, '');
    const expectedCameraPrefix = String(store.code || '').toLowerCase() + '_camera';
    if (!camera.startsWith(expectedCameraPrefix) || !/^loja\d{2}_camera\d+$/.test(camera)) return res.status(400).json({ error: 'câmera inválida' });
    if (!/^(?:index\.m3u8|[A-Fa-f0-9]+_video\d+_(?:init|seg\d+)\.mp4)$/.test(fileName)) return res.status(400).json({ error: 'arquivo HLS inválido' });

    const announcedLength = Number(req.headers['content-length'] || 0);
    if (announcedLength > _cameraLiveUploadLimit) return res.status(413).json({ error: 'arquivo HLS acima de 20 MB' });

    const dir = _agPath.join(_cameraLiveDir, String(store.code).toUpperCase(), camera);
    await _agFs.promises.mkdir(dir, { recursive: true });
    const finalFile = _agPath.join(dir, fileName);
    if (fileName !== 'index.m3u8' && _agFs.existsSync(finalFile)) {
      const stat = await _agFs.promises.stat(finalFile);
      return res.json({ ok: true, duplicate: true, stored: `${store.code}/${camera}/${fileName}`, bytes: stat.size });
    }

    tempFile = finalFile + '.' + _agCrypto.randomBytes(6).toString('hex') + '.part';
    let received = 0;
    const limiter = new _CameraUploadTransform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > _cameraLiveUploadLimit) callback(new Error('LIVE_UPLOAD_LIMIT'));
        else callback(null, chunk);
      },
    });
    await _cameraUploadPipeline(req, limiter, _agFs.createWriteStream(tempFile, { flags: 'wx' }));
    await _agFs.promises.rename(tempFile, finalFile);
    tempFile = null;

    const cutoff = Date.now() - 15 * 60 * 1000;
    setImmediate(async () => {
      try {
        for (const entry of await _agFs.promises.readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name === 'index.m3u8' || entry.name.endsWith('.part')) continue;
          const full = _agPath.join(dir, entry.name);
          const stat = await _agFs.promises.stat(full);
          if (stat.mtimeMs < cutoff) await _agFs.promises.unlink(full);
        }
      } catch (err) { console.error('[camera-live-cleanup]', err.message); }
    });
    res.json({ ok: true, stored: `${store.code}/${camera}/${fileName}`, bytes: received });
  } catch (err) {
    if (tempFile) { try { await _agFs.promises.unlink(tempFile); } catch {} }
    if (err && err.message === 'LIVE_UPLOAD_LIMIT') return res.status(413).json({ error: 'arquivo HLS acima de 20 MB' });
    if (err && err.code === 'ENOSPC') {
      setImmediate(() => _cleanupCameraArchive().catch(cleanupErr => console.error('[camera-cleanup-enospc]', cleanupErr.message)));
      return res.status(507).json({ error: 'armazenamento em manutencao; tente novamente' });
    }
    console.error('[agent-camera-live]', err);
    res.status(500).json({ error: 'falha ao armazenar transmissão' });
  }
});

module.exports = router;
