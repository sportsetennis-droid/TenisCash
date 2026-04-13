const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;

// Armazena códigos temporários em memória (expira em 10 min)
const verificationCodes = new Map();

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
}

async function sendVerificationCode(phone) {
  const code = generateCode();
  
  // Formata telefone pro padrão internacional (55 + DDD + número)
  let formattedPhone = phone.replace(/\D/g, '');
  if (!formattedPhone.startsWith('55')) {
    formattedPhone = '55' + formattedPhone;
  }

  // Salva código com expiração de 10 minutos
  verificationCodes.set(phone, {
    code,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
  });

  // Envia via Z-API
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Token': ZAPI_CLIENT_TOKEN
      },
      body: JSON.stringify({
        phone: formattedPhone,
        message: `🏃 *TenisCash - Sports & Tennis*\n\nSeu código de verificação é:\n\n*${code}*\n\nEsse código expira em 10 minutos.\n\nSe você não solicitou este código, ignore esta mensagem.`
      })
    });

    const data = await response.json();
    
    if (data.zapiMessageId || data.messageId) {
      return { success: true, message: 'Código enviado por WhatsApp' };
    } else {
      console.error('Z-API response:', data);
      return { success: false, message: 'Erro ao enviar mensagem. Verifique se o número tem WhatsApp.' };
    }
  } catch (err) {
    console.error('Erro Z-API:', err);
    return { success: false, message: 'Erro ao enviar código de verificação' };
  }
}

// Telefones verificados temporariamente (expira em 15 min)
const verifiedPhones = new Map();

function verifyCode(phone, code) {
  const stored = verificationCodes.get(phone);
  
  if (!stored) {
    // Checa se já foi verificado
    if (verifiedPhones.has(phone)) {
      return { valid: true };
    }
    return { valid: false, message: 'Código não encontrado. Solicite um novo.' };
  }

  if (Date.now() > stored.expiresAt) {
    verificationCodes.delete(phone);
    return { valid: false, message: 'Código expirado. Solicite um novo.' };
  }

  stored.attempts++;
  if (stored.attempts > 5) {
    verificationCodes.delete(phone);
    return { valid: false, message: 'Muitas tentativas. Solicite um novo código.' };
  }

  if (stored.code !== code) {
    return { valid: false, message: 'Código incorreto. Tente novamente.' };
  }

  // Código válido - marca como verificado por 15 minutos
  verificationCodes.delete(phone);
  verifiedPhones.set(phone, { expiresAt: Date.now() + 15 * 60 * 1000 });
  return { valid: true };
}

function isPhoneVerified(phone) {
  const data = verifiedPhones.get(phone);
  if (!data) return false;
  if (Date.now() > data.expiresAt) {
    verifiedPhones.delete(phone);
    return false;
  }
  return true;
}

function clearVerified(phone) {
  verifiedPhones.delete(phone);
}

// Limpa códigos expirados a cada 5 minutos
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of verificationCodes.entries()) {
    if (now > data.expiresAt) {
      verificationCodes.delete(phone);
    }
  }
}, 5 * 60 * 1000);

module.exports = { sendVerificationCode, verifyCode, isPhoneVerified, clearVerified };
